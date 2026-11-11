use std::{
    fs::{self, File},
    io,
    os::{
        fd::OwnedFd,
        unix::net::{UnixListener, UnixStream},
    },
    process::Command,
    sync::atomic::{AtomicBool, Ordering},
    thread,
};

use nix::{
    errno::Errno,
    sys::wait::{WaitStatus, waitpid},
    unistd::{Pid, setsid},
};

use crate::{boot, handle, step};

static ACTIVE: AtomicBool = AtomicBool::new(false);

pub(crate) fn active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

pub(crate) fn enter() {
    ACTIVE.store(true, Ordering::Relaxed);
}

pub(crate) fn init(forwards: &[String]) -> io::Result<i32> {
    match setsid() {
        Ok(_) | Err(Errno::EPERM) => {}
        Err(error) => return step("leave the session of the runner", Err(error)),
    }
    boot::names(false)?;
    let agent = step(
        "start the agent of this slot",
        Command::new("/proc/self/exe")
            .arg(wire::NAMESPACE_SERVE)
            .args(forwards)
            .spawn(),
    )?;
    let agent = Pid::from_raw(
        i32::try_from(agent.id()).map_err(|_| io::Error::other("the agent id overflows"))?,
    );
    loop {
        match waitpid(None, None) {
            Ok(WaitStatus::Exited(process, code)) if process == agent => return Ok(code),
            Ok(WaitStatus::Signaled(process, signal, _)) if process == agent => {
                return Ok(128 + signal as i32);
            }
            Ok(_) | Err(Errno::EINTR) => {}
            Err(error) => return step("wait for a process of this slot", Err(error)),
        }
    }
}

pub(crate) fn relay() -> io::Result<File> {
    step(
        "reach the relay of this slot",
        UnixStream::connect(wire::NAMESPACE_RELAY),
    )
    .map(|stream| File::from(OwnedFd::from(stream)))
}

pub(crate) fn serve() -> io::Result<()> {
    match fs::remove_file(wire::NAMESPACE_SOCKET) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let listener = step(
        "listen on the socket of this slot",
        UnixListener::bind(wire::NAMESPACE_SOCKET),
    )?;
    println!("{}", wire::READY);
    loop {
        let (connection, _) = step("accept a connection", listener.accept())?;
        let connection = File::from(OwnedFd::from(connection));
        thread::spawn(move || handle(connection));
    }
}
