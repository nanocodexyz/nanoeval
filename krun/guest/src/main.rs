mod boot;
mod copy;
mod exec;
mod kmsg;
mod relay;
mod unpack;

use std::{
    env,
    fs::File,
    io,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    process::{self, ExitCode},
    thread,
};

use nix::{
    mount::{MsFlags, mount},
    sys::socket::{
        AddressFamily, Backlog, SockFlag, SockType, VsockAddr, accept4, bind, listen, socket,
    },
    unistd::sync,
};
use wire::{Frame, Request};

const NONE: Option<&str> = None;

fn main() -> ExitCode {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    let Some(mode) = arguments.first() else {
        eprintln!(
            "usage: nanoeval-krun-guest <disk|overlay> [rt] [private] [forward=ADDRESS:PORT...] | oom-kills"
        );
        return ExitCode::from(125);
    };
    if mode == "oom-kills" {
        return match kmsg::oom_kills() {
            Ok(kills) => {
                println!("{kills}");
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("nanoeval-krun-guest: {error}");
                ExitCode::from(125)
            }
        };
    }
    let has = |name: &str| arguments.iter().any(|argument| argument == name);
    let options = boot::Options {
        private: has(wire::PRIVATE),
        runtime: has(wire::RUNTIME_TAG),
    };
    let forwards = arguments
        .iter()
        .filter_map(|argument| argument.strip_prefix(wire::FORWARD))
        .map(str::as_bytes);
    let booted = boot::run(mode, &options)
        .and_then(|()| relay::listen(forwards))
        .and_then(|_forwards| serve());
    if let Err(error) = booted {
        eprintln!("nanoeval-krun-guest: {error}");
        return ExitCode::from(125);
    }
    ExitCode::SUCCESS
}

fn step<T, E: Into<io::Error>>(what: &str, result: Result<T, E>) -> io::Result<T> {
    result.map_err(|error| {
        let error = error.into();
        io::Error::new(error.kind(), format!("{what}: {error}"))
    })
}

fn serve() -> io::Result<()> {
    let listener = step(
        "create the vsock listener",
        socket(
            AddressFamily::Vsock,
            SockType::Stream,
            SockFlag::SOCK_CLOEXEC,
            None,
        ),
    )?;
    step(
        "bind the vsock listener",
        bind(
            listener.as_raw_fd(),
            &VsockAddr::new(nix::libc::VMADDR_CID_ANY, wire::PORT),
        ),
    )?;
    step("listen on vsock", listen(&listener, Backlog::MAXCONN))?;
    println!("{}", wire::READY);
    loop {
        let connection = step("accept a connection", accept(&listener))?;
        thread::spawn(move || handle(connection));
    }
}

#[expect(
    unsafe_code,
    reason = "accept4 returns a raw descriptor that only this function owns"
)]
fn accept(listener: &OwnedFd) -> nix::Result<File> {
    let descriptor = accept4(listener.as_raw_fd(), SockFlag::SOCK_CLOEXEC)?;
    Ok(File::from(unsafe { OwnedFd::from_raw_fd(descriptor) }))
}

fn handle(mut connection: File) {
    let mut stopping = false;
    let outcome = Request::read(&mut connection).and_then(|request| match request {
        Request::CopyIn { from, to } => copy::into_guest(&from, &to).map(|()| 0),
        Request::CopyOut { from, to } => copy::out_of_guest(&from, &to).map(|()| 0),
        Request::Exec {
            arguments,
            directory,
            environment,
            forwards,
            user,
        } => exec::run(
            &connection,
            &exec::Spec {
                arguments,
                directory,
                environment,
                forwards,
                user,
            },
        ),
        Request::Ping => Ok(0),
        Request::Stop => {
            stopping = true;
            sync();
            step(
                "remount / read-only",
                mount(
                    NONE,
                    "/",
                    NONE,
                    MsFlags::MS_REMOUNT | MsFlags::MS_RDONLY,
                    NONE,
                ),
            )
            .map(|()| 0)
        }
        Request::Unpack { to } => unpack::run(&connection, &to).map(|()| 0),
    });
    let code = outcome.unwrap_or_else(|error| {
        let _ = Frame::Failure(error.to_string().into_bytes()).write(&mut connection);
        125
    });
    let _ = Frame::Exit(code).write(&mut connection);
    if stopping {
        process::exit(code);
    }
}
