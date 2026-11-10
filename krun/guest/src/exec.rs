use std::{
    ffi::OsStr,
    fs::{self, File},
    io::{self, Read, Write},
    os::{
        fd::{AsFd, OwnedFd},
        unix::{
            ffi::OsStrExt,
            process::{CommandExt, ExitStatusExt},
        },
    },
    process::{ChildStdin, Command, Stdio},
    sync::{Arc, Mutex, PoisonError},
    thread,
};

use nix::{
    fcntl::{FcntlArg, OFlag, fcntl},
    poll::{PollFd, PollFlags, PollTimeout, poll},
    sys::{
        signal::{Signal, kill},
        wait::{Id, WaitPidFlag, waitid},
    },
    unistd::Pid,
};
use wire::Frame;

pub(crate) struct Spec {
    pub(crate) arguments: Vec<Vec<u8>>,
    pub(crate) directory: Vec<u8>,
    pub(crate) environment: Vec<Vec<u8>>,
    pub(crate) user: Vec<u8>,
}

struct Account {
    gid: u32,
    home: Vec<u8>,
    uid: u32,
}

fn invalid(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn number(text: &str, what: &str) -> io::Result<u32> {
    text.parse()
        .map_err(|_| invalid(format!("unknown {what}: {text}")))
}

fn account(spec: &[u8]) -> io::Result<Account> {
    let spec = str::from_utf8(spec).map_err(|_| invalid("the user is not UTF-8".to_owned()))?;
    let (user, group) = spec
        .split_once(':')
        .map_or((spec, None), |(user, group)| (user, Some(group)));
    let user = if user.is_empty() { "0" } else { user };
    let passwd = fs::read_to_string("/etc/passwd").unwrap_or_default();
    let entry = passwd
        .lines()
        .map(|line| line.split(':').collect::<Vec<_>>())
        .find(|fields| fields.len() >= 6 && (fields[0] == user || fields[2] == user));
    let mut account = match entry {
        Some(fields) => Account {
            gid: number(fields[3], "group")?,
            home: fields[5].as_bytes().to_vec(),
            uid: number(fields[2], "user")?,
        },
        None => Account {
            gid: 0,
            home: b"/".to_vec(),
            uid: number(user, "user")?,
        },
    };
    if let Some(group) = group {
        let groups = fs::read_to_string("/etc/group").unwrap_or_default();
        let named = groups
            .lines()
            .map(|line| line.split(':').collect::<Vec<_>>())
            .find(|fields| fields.len() >= 3 && fields[0] == group);
        account.gid = match named {
            Some(fields) => number(fields[2], "group")?,
            None => number(group, "group")?,
        };
    }
    Ok(account)
}

fn command(spec: &Spec) -> io::Result<Command> {
    let (program, rest) = spec
        .arguments
        .split_first()
        .ok_or_else(|| invalid("exec needs a command".to_owned()))?;
    let account = account(&spec.user)?;
    let mut command = Command::new(OsStr::from_bytes(program));
    command
        .args(rest.iter().map(|argument| OsStr::from_bytes(argument)))
        .env_clear()
        .env("HOME", OsStr::from_bytes(&account.home))
        .current_dir(OsStr::from_bytes(&spec.directory))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    for entry in &spec.environment {
        let split = entry
            .iter()
            .position(|byte| *byte == b'=')
            .ok_or_else(|| invalid("an environment entry has no =".to_owned()))?;
        command.env(
            OsStr::from_bytes(&entry[..split]),
            OsStr::from_bytes(&entry[split + 1..]),
        );
    }
    if account.uid != 0 || account.gid != 0 {
        command.uid(account.uid).gid(account.gid);
    }
    Ok(command)
}

pub(crate) fn run(connection: &File, spec: &Spec) -> io::Result<i32> {
    let mut writer = connection;
    let mut child = match command(spec)?.spawn() {
        Ok(child) => child,
        Err(error) => {
            let program = String::from_utf8_lossy(&spec.arguments[0]);
            Frame::Failure(format!("{program}: {error}").into_bytes()).write(&mut writer)?;
            return Ok(if error.kind() == io::ErrorKind::NotFound {
                127
            } else {
                126
            });
        }
    };
    let process = Pid::from_raw(
        i32::try_from(child.id()).map_err(|_| invalid("the child id overflows".to_owned()))?,
    );
    let input = child.stdin.take();
    let mut sources = [
        child
            .stdout
            .take()
            .map(|pipe| File::from(OwnedFd::from(pipe))),
        child
            .stderr
            .take()
            .map(|pipe| File::from(OwnedFd::from(pipe))),
    ];
    let exited = Arc::new(Mutex::new(false));
    let end = {
        let exited = Arc::clone(&exited);
        move || {
            let exited = exited.lock().unwrap_or_else(PoisonError::into_inner);
            if !*exited {
                let _ = kill(process, Signal::SIGTERM);
            }
        }
    };

    let reader = connection.try_clone()?;
    let hang_up = end.clone();
    thread::spawn(move || feed(reader, input, hang_up));

    let (done, finished) = io::pipe()?;
    let waiter = thread::spawn(move || {
        let _ = waitid(
            Id::Pid(process),
            WaitPidFlag::WEXITED | WaitPidFlag::WNOWAIT,
        );
        let mut exited = exited.lock().unwrap_or_else(PoisonError::into_inner);
        *exited = true;
        let status = child.wait();
        drop(finished);
        status
    });

    let forwarded = forward(&mut sources, &done, &mut writer);
    if forwarded.is_err() {
        end();
    }
    let status = waiter
        .join()
        .map_err(|_| io::Error::other("the waiter thread panicked"))??;
    forwarded?;
    Ok(status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(0)))
}

fn feed(mut reader: File, mut input: Option<ChildStdin>, hang_up: impl Fn()) {
    loop {
        match Frame::read(&mut reader) {
            Ok(Frame::Stdin(data)) => {
                if let Some(pipe) = input.as_mut()
                    && pipe.write_all(&data).is_err()
                {
                    input = None;
                }
            }
            Ok(Frame::StdinEnd) => input = None,
            Ok(_) => {}
            Err(_) => {
                hang_up();
                break;
            }
        }
    }
}

fn frame(index: usize, data: &[u8]) -> Frame {
    if index == 0 {
        Frame::Stdout(data.to_vec())
    } else {
        Frame::Stderr(data.to_vec())
    }
}

fn forward(
    sources: &mut [Option<File>; 2],
    done: &io::PipeReader,
    writer: &mut &File,
) -> io::Result<()> {
    let mut buffer = vec![0; wire::CHUNK];
    loop {
        let (ready, finished) = {
            let mut descriptors = vec![PollFd::new(done.as_fd(), PollFlags::POLLIN)];
            let mut indices = Vec::new();
            for (index, source) in sources.iter().enumerate() {
                if let Some(source) = source {
                    descriptors.push(PollFd::new(source.as_fd(), PollFlags::POLLIN));
                    indices.push(index);
                }
            }
            poll(&mut descriptors, PollTimeout::NONE)?;
            let fired = |descriptor: &PollFd| {
                descriptor
                    .revents()
                    .is_some_and(|events| !events.is_empty())
            };
            let ready = indices
                .iter()
                .zip(&descriptors[1..])
                .filter(|(_, descriptor)| fired(descriptor))
                .map(|(index, _)| *index)
                .collect::<Vec<_>>();
            (ready, fired(&descriptors[0]))
        };
        for index in ready {
            let Some(source) = sources[index].as_mut() else {
                continue;
            };
            match source.read(&mut buffer)? {
                0 => sources[index] = None,
                length => frame(index, &buffer[..length]).write(writer)?,
            }
        }
        if finished {
            break;
        }
    }
    for (index, source) in sources.iter_mut().enumerate() {
        let Some(source) = source.as_mut() else {
            continue;
        };
        fcntl(source.as_fd(), FcntlArg::F_SETFL(OFlag::O_NONBLOCK))?;
        loop {
            match source.read(&mut buffer) {
                Ok(0) => break,
                Ok(length) => frame(index, &buffer[..length]).write(writer)?,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) => return Err(error),
            }
        }
    }
    Ok(())
}
