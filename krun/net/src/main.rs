use std::{
    env,
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, Write},
    os::{
        fd::OwnedFd,
        unix::{
            fs::PermissionsExt,
            net::{UnixListener, UnixStream},
            process::{CommandExt, ExitStatusExt},
        },
    },
    path::PathBuf,
    process::{Command, ExitCode, Stdio},
    thread,
};

use nanoeval_net::{forward, netlink};

const READY: &str = "ready";
const USAGE: &str = "usage: nanoeval-net <detach LOG <host|slot> ...|firewall|host SOCKET ALLOW|slot SOCKET TARGET... [-- COMMAND...]>";

fn main() -> ExitCode {
    let mut arguments = env::args_os().skip(1);
    let command = arguments.next().unwrap_or_default();
    let result = match command.to_str() {
        Some("detach") => detach(arguments),
        Some("firewall") => netlink::firewall().map(|()| 0),
        Some("host") => host(arguments),
        Some("slot") => slot(arguments),
        _ => Err(io::Error::new(io::ErrorKind::InvalidInput, USAGE)),
    };
    match result {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprintln!("nanoeval-net: {error}");
            ExitCode::from(125)
        }
    }
}

fn usage() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, USAGE)
}

fn detach(mut arguments: impl Iterator<Item = OsString>) -> io::Result<u8> {
    let log = arguments.next().ok_or_else(usage)?;
    let log = OpenOptions::new().append(true).create(true).open(log)?;
    let mut child = Command::new(env::current_exe()?)
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(log)
        .process_group(0)
        .spawn()?;
    let mut line = String::new();
    if let Some(output) = child.stdout.take() {
        BufReader::new(output).read_line(&mut line)?;
    }
    if line.trim_end() == READY {
        println!("{}", child.id());
        return Ok(0);
    }
    let status = child.wait()?;
    Err(io::Error::other(format!(
        "the detached command ended before it listened: {status}"
    )))
}

fn ready() -> io::Result<()> {
    let mut output = io::stdout().lock();
    writeln!(output, "{READY}")?;
    output.flush()
}

fn host(mut arguments: impl Iterator<Item = OsString>) -> io::Result<u8> {
    let (Some(socket), Some(allow), None) = (arguments.next(), arguments.next(), arguments.next())
    else {
        return Err(usage());
    };
    let allow = PathBuf::from(allow);
    match fs::remove_file(&socket) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let listener = UnixListener::bind(&socket)?;
    fs::set_permissions(&socket, fs::Permissions::from_mode(0o666))?;
    ready()?;
    forward::serve(&listener, move |target| {
        let wanted = target.to_string();
        Ok(fs::read_to_string(&allow)?
            .lines()
            .any(|allowed| allowed == wanted))
    })?;
    Ok(0)
}

fn slot(mut arguments: impl Iterator<Item = OsString>) -> io::Result<u8> {
    let socket = PathBuf::from(arguments.next().ok_or_else(usage)?);
    let mut forwards = Vec::new();
    let mut command = None;
    while let Some(argument) = arguments.next() {
        if argument == "--" {
            command = Some(arguments.next().ok_or_else(usage)?);
            break;
        }
        let socket = socket.clone();
        forwards.push(forward::listen(
            forward::target(argument.as_encoded_bytes())?,
            move || UnixStream::connect(&socket).map(|stream| File::from(OwnedFd::from(stream))),
        )?);
    }
    let Some(command) = command else {
        ready()?;
        loop {
            thread::park();
        }
    };
    let status = Command::new(command).args(arguments).status()?;
    drop(forwards);
    Ok(status
        .code()
        .or_else(|| status.signal().map(|signal| 128 + signal))
        .and_then(|code| u8::try_from(code).ok())
        .unwrap_or(u8::MAX))
}
