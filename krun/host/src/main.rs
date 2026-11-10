use std::{
    env,
    ffi::{OsStr, OsString},
    fs,
    io::{self, Read, Write},
    os::unix::{ffi::OsStrExt, net::UnixStream},
    path::Path,
    process::ExitCode,
    thread,
    time::Duration,
};

use nanovm::{
    BlockDevice, Capabilities, GuestCommand, KrunVm, RootFilesystem, SharedDirectory, VmConfig,
    VsockPort,
};
use wire::{Frame, Request};

const GUEST: &str = "/nanoeval-krun-guest";
const READY_POLL: Duration = Duration::from_millis(20);
const USAGE: &str = "usage: nanoeval-krun <check|copy-in|copy-out|exec|ready|stop|unpack|vm> ...";

struct Arguments {
    options: Vec<(String, OsString)>,
    rest: Vec<OsString>,
}

impl Arguments {
    fn parse(
        mut arguments: impl Iterator<Item = OsString>,
        allowed: &[&str],
    ) -> Result<Self, String> {
        let mut options = Vec::new();
        let mut rest = Vec::new();
        while let Some(argument) = arguments.next() {
            if argument == "--" {
                rest.extend(arguments);
                break;
            }
            let Some(name) = argument.to_str().and_then(|text| text.strip_prefix("--")) else {
                rest.push(argument);
                rest.extend(arguments);
                break;
            };
            if !allowed.contains(&name) {
                return Err(format!("unknown option --{name}"));
            }
            let value = arguments
                .next()
                .ok_or_else(|| format!("--{name} needs a value"))?;
            options.push((name.to_owned(), value));
        }
        Ok(Self { options, rest })
    }

    fn all(&self, name: &str) -> Vec<&OsString> {
        self.options
            .iter()
            .filter(|(option, _)| option == name)
            .map(|(_, value)| value)
            .collect()
    }

    fn maybe(&self, name: &str) -> Option<&OsString> {
        self.all(name).pop()
    }

    fn one(&self, name: &str) -> Result<&OsString, String> {
        self.maybe(name)
            .ok_or_else(|| format!("--{name} is required"))
    }

    fn number<T: std::str::FromStr>(&self, name: &str) -> Result<T, String> {
        self.one(name)?
            .to_str()
            .and_then(|text| text.parse().ok())
            .ok_or_else(|| format!("--{name} is not a valid number"))
    }
}

fn main() -> ExitCode {
    let mut arguments = env::args_os().skip(1);
    let command = arguments.next().unwrap_or_default();
    let result = match command.to_str() {
        Some("check") => check(),
        Some("copy-in") => copy(arguments, true),
        Some("copy-out") => copy(arguments, false),
        Some("exec") => exec(arguments),
        Some("ready") => ready(arguments),
        Some("stop") => stop(arguments),
        Some("unpack") => unpack(arguments),
        Some("vm") => vm(arguments),
        _ => Err(USAGE.to_owned()),
    };
    match result {
        Ok(code) => ExitCode::from(code),
        Err(message) => {
            eprintln!("nanoeval-krun: {message}");
            ExitCode::from(125)
        }
    }
}

fn check() -> Result<u8, String> {
    let capabilities = Capabilities::detect().map_err(|error| error.to_string())?;
    println!("{}", capabilities.max_vcpus());
    Ok(0)
}

fn vm(arguments: impl Iterator<Item = OsString>) -> Result<u8, String> {
    let arguments = Arguments::parse(
        arguments,
        &[
            "boot",
            "cpus",
            "disk",
            "io",
            "lower",
            "memory-mib",
            "rt",
            "socket",
            "upper",
        ],
    )?;
    let mut config = VmConfig::new(RootFilesystem::Directory {
        path: arguments.one("boot")?.into(),
        read_only: true,
    })
    .cpus(arguments.number("cpus")?)
    .memory_mib(arguments.number("memory-mib")?)
    .vsock_port(VsockPort::guest_listens(
        wire::PORT,
        arguments.one("socket")?,
    ));
    let mut command = GuestCommand::new(GUEST);
    match (
        arguments.maybe("disk"),
        arguments.maybe("lower"),
        arguments.maybe("upper"),
    ) {
        (Some(disk), None, None) => {
            config = config.block_device(BlockDevice::read_write("disk", disk));
            command = command.arg("disk");
        }
        (None, Some(lower), Some(upper)) => {
            config = config
                .block_device(BlockDevice::read_only("lower", lower))
                .block_device(BlockDevice::read_write("upper", upper));
            command = command.arg("overlay");
        }
        _ => return Err("vm takes either --disk or --lower with --upper".to_owned()),
    }
    if let Some(runtime) = arguments.maybe("rt") {
        config = config.shared_directory(SharedDirectory::read_only(wire::RUNTIME_TAG, runtime));
        command = command.arg(wire::RUNTIME_TAG);
    }
    if let Some(exchange) = arguments.maybe("io") {
        config = config.shared_directory(SharedDirectory::read_write(wire::IO_TAG, exchange));
    }
    KrunVm::new(&config)
        .and_then(|vm| vm.run(&command))
        .map_err(|error| error.to_string())?;
    Ok(0)
}

fn exec(arguments: impl Iterator<Item = OsString>) -> Result<u8, String> {
    let arguments = Arguments::parse(arguments, &["cwd", "env", "env-file", "socket", "user"])?;
    if arguments.rest.is_empty() {
        return Err("exec needs a command".to_owned());
    }
    let mut environment = Vec::new();
    for file in arguments.all("env-file") {
        let content =
            fs::read(file).map_err(|error| format!("{}: {error}", Path::new(file).display()))?;
        environment.extend(
            content
                .split(|byte| *byte == b'\n')
                .filter(|line| !line.is_empty() && line[0] != b'#')
                .map(<[u8]>::to_vec),
        );
    }
    for entry in arguments.all("env") {
        if entry.as_bytes().contains(&b'=') {
            environment.push(entry.as_bytes().to_vec());
        } else if let Some(value) = env::var_os(entry) {
            let mut pair = entry.as_bytes().to_vec();
            pair.push(b'=');
            pair.extend_from_slice(value.as_bytes());
            environment.push(pair);
        }
    }
    let request = Request::Exec {
        arguments: arguments
            .rest
            .iter()
            .map(|argument| argument.as_bytes().to_vec())
            .collect(),
        directory: arguments
            .maybe("cwd")
            .map_or_else(|| b"/".to_vec(), |directory| directory.as_bytes().to_vec()),
        environment,
        user: arguments
            .maybe("user")
            .map(|user| user.as_bytes().to_vec())
            .unwrap_or_default(),
    };
    converse(arguments.one("socket")?, &request, true)
}

fn copy(arguments: impl Iterator<Item = OsString>, into_guest: bool) -> Result<u8, String> {
    let arguments = Arguments::parse(arguments, &["socket"])?;
    let [from, to] = arguments.rest.as_slice() else {
        return Err("copy takes a source and a destination".to_owned());
    };
    let (from, to) = (from.as_bytes().to_vec(), to.as_bytes().to_vec());
    let request = if into_guest {
        Request::CopyIn { from, to }
    } else {
        Request::CopyOut { from, to }
    };
    converse(arguments.one("socket")?, &request, false)
}

fn stop(arguments: impl Iterator<Item = OsString>) -> Result<u8, String> {
    let arguments = Arguments::parse(arguments, &["socket"])?;
    converse(arguments.one("socket")?, &Request::Stop, false)
}

fn unpack(arguments: impl Iterator<Item = OsString>) -> Result<u8, String> {
    let arguments = Arguments::parse(arguments, &["socket", "to"])?;
    let request = Request::Unpack {
        to: arguments
            .maybe("to")
            .map_or_else(|| b"/".to_vec(), |to| to.as_bytes().to_vec()),
    };
    converse(arguments.one("socket")?, &request, true)
}

fn ready(arguments: impl Iterator<Item = OsString>) -> Result<u8, String> {
    let arguments = Arguments::parse(arguments, &["log", "pid", "socket"])?;
    let log = arguments.one("log")?;
    let process = Path::new("/proc").join(arguments.one("pid")?);
    loop {
        let listening = fs::read(log)
            .map_err(|error| format!("{}: {error}", Path::new(log).display()))?
            .split(|byte| *byte == b'\n')
            .any(|line| line == wire::READY.as_bytes());
        if listening {
            break;
        }
        if !process.exists() {
            return Err("the VM process exited before its guest listened".to_owned());
        }
        thread::sleep(READY_POLL);
    }
    ping(arguments.one("socket")?)
        .map(|()| 0)
        .map_err(|error| format!("the guest did not answer: {error}"))
}

fn ping(socket: &OsStr) -> io::Result<()> {
    let mut stream = UnixStream::connect(socket)?;
    Request::Ping.write(&mut stream)?;
    match Frame::read(&mut stream)? {
        Frame::Exit(0) => Ok(()),
        _ => Err(io::Error::other("the guest did not answer the ping")),
    }
}

fn converse(socket: &OsStr, request: &Request, input: bool) -> Result<u8, String> {
    let mut stream = UnixStream::connect(socket)
        .map_err(|error| format!("{}: {error}", Path::new(socket).display()))?;
    request
        .write(&mut stream)
        .map_err(|error| format!("the request was not sent: {error}"))?;
    if input {
        let mut writer = stream
            .try_clone()
            .map_err(|error| format!("the guest connection was not cloned: {error}"))?;
        thread::spawn(move || {
            let mut stdin = io::stdin().lock();
            let mut buffer = vec![0; wire::CHUNK];
            loop {
                match stdin.read(&mut buffer) {
                    Ok(0) | Err(_) => {
                        let _ = Frame::StdinEnd.write(&mut writer);
                        break;
                    }
                    Ok(length) => {
                        if Frame::Stdin(buffer[..length].to_vec())
                            .write(&mut writer)
                            .is_err()
                        {
                            break;
                        }
                    }
                }
            }
        });
    }
    let mut stdout = io::stdout().lock();
    let mut stderr = io::stderr().lock();
    loop {
        let frame = Frame::read(&mut stream)
            .map_err(|error| format!("the guest connection ended: {error}"))?;
        let written = match frame {
            Frame::Exit(code) => return Ok(u8::try_from(code & 0xff).unwrap_or(u8::MAX)),
            Frame::Failure(message) => {
                writeln!(
                    stderr,
                    "nanoeval-krun: {}",
                    String::from_utf8_lossy(&message)
                )
            }
            Frame::Stderr(data) => stderr.write_all(&data),
            Frame::Stdout(data) => stdout.write_all(&data).and_then(|()| stdout.flush()),
            Frame::Stdin(_) | Frame::StdinEnd => {
                return Err("the guest sent an input frame".to_owned());
            }
        };
        written.map_err(|error| format!("output was not written: {error}"))?;
    }
}
