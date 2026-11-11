mod image;

use std::{
    env,
    ffi::{OsStr, OsString},
    fs,
    io::{self, Read, Write},
    net::Ipv4Addr,
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::{ffi::OsStrExt, net::UnixStream},
    },
    path::Path,
    process::{self, Command, ExitCode, Stdio},
    thread,
    time::Duration,
};

use nanovm::{
    BlockDevice, Capabilities, GuestCommand, KrunVm, Network, RootFilesystem, SharedDirectory,
    VmConfig, VsockPort,
};
use wire::{Frame, Request};

const GUEST: &str = "/nanoeval-krun-guest";
const LEASH_EXIT: i32 = 125;
const LEASH_POLL: Duration = Duration::from_millis(200);
const READY_POLL: Duration = Duration::from_millis(20);
const USAGE: &str = "usage: nanoeval-krun <check|copy-in|copy-out|exec|image|ready|stop|vm> ...";

pub(crate) struct Arguments {
    options: Vec<(String, OsString)>,
    pub(crate) rest: Vec<OsString>,
}

impl Arguments {
    fn parse(arguments: impl Iterator<Item = OsString>, allowed: &[&str]) -> Result<Self, String> {
        Self::read(arguments, allowed, false)
    }

    pub(crate) fn mixed(
        arguments: impl Iterator<Item = OsString>,
        allowed: &[&str],
    ) -> Result<Self, String> {
        Self::read(arguments, allowed, true)
    }

    fn read(
        mut arguments: impl Iterator<Item = OsString>,
        allowed: &[&str],
        mixed: bool,
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
                if mixed {
                    continue;
                }
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

    pub(crate) fn maybe(&self, name: &str) -> Option<&OsString> {
        self.all(name).pop()
    }

    pub(crate) fn one(&self, name: &str) -> Result<&OsString, String> {
        self.maybe(name)
            .ok_or_else(|| format!("--{name} is required"))
    }

    pub(crate) fn number<T: std::str::FromStr>(&self, name: &str) -> Result<T, String> {
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
        Some("image") => image::run(arguments),
        Some("ready") => ready(arguments),
        Some("stop") => stop(arguments),
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
            "build",
            "context",
            "cpus",
            "forward",
            "io",
            "leash",
            "lower",
            "memory-mib",
            "passt",
            "relay",
            "rt",
            "socket",
            "source",
            "upper",
        ],
    )?;
    let config = VmConfig::new(RootFilesystem::Directory {
        path: arguments.one("boot")?.into(),
        read_only: true,
    })
    .cpus(arguments.number("cpus")?)
    .memory_mib(arguments.number("memory-mib")?)
    .vsock_port(VsockPort::guest_listens(
        wire::PORT,
        arguments.one("socket")?,
    ));
    let (mut config, mut command) = disks(&arguments, config)?;
    if arguments.maybe("leash").is_some() {
        let parent: u32 = arguments.number("leash")?;
        thread::spawn(move || {
            while std::os::unix::process::parent_id() == parent {
                thread::sleep(LEASH_POLL);
            }
            process::exit(LEASH_EXIT);
        });
    }
    if let Some(runtime) = arguments.maybe("rt") {
        config = config.shared_directory(SharedDirectory::read_only(wire::RUNTIME_TAG, runtime));
        command = command.arg(wire::RUNTIME_TAG);
    }
    if let Some(exchange) = arguments.maybe("io") {
        config = config.shared_directory(SharedDirectory::read_write(wire::IO_TAG, exchange));
    }
    let proxy = arguments
        .maybe("passt")
        .map(|program| passt(program))
        .transpose()?;
    if let Some(proxy) = &proxy {
        config = config.network(Network::Proxy(proxy.as_raw_fd()));
        command = command.arg(wire::PRIVATE);
    }
    if let Some(relay) = arguments.maybe("relay") {
        config = config.vsock_port(VsockPort::guest_connects(wire::RELAY_PORT, relay));
    }
    for forward in arguments.all("forward") {
        let mut argument = OsString::from(wire::FORWARD);
        argument.push(forward);
        command = command.arg(argument);
    }
    KrunVm::new(&config)
        .and_then(|vm| vm.run(&command))
        .map_err(|error| error.to_string())?;
    Ok(0)
}

fn disks(arguments: &Arguments, mut config: VmConfig) -> Result<(VmConfig, GuestCommand), String> {
    let mut command = GuestCommand::new(GUEST);
    let sources = arguments.all("source");
    let builds = arguments.maybe("build").is_some() || !sources.is_empty();
    match (arguments.maybe("lower"), arguments.maybe("upper")) {
        (Some(lower), Some(upper)) if !builds => {
            config = config
                .block_device(BlockDevice::read_only("lower", lower))
                .block_device(BlockDevice::read_write("upper", upper));
            command = command.arg("overlay");
        }
        (None, None) if builds => {
            command = command.arg(wire::BUILD);
            if let Some(build) = arguments.maybe("build") {
                config = config.block_device(BlockDevice::read_write("build", build));
                command = command.arg(wire::ROOT);
            }
            for (index, source) in sources.iter().enumerate() {
                config =
                    config.block_device(BlockDevice::read_only(format!("source{index}"), source));
            }
            if !sources.is_empty() {
                command = command.arg(format!("{}{}", wire::SOURCES, sources.len()));
            }
            if let Some(context) = arguments.maybe("context") {
                config =
                    config.shared_directory(SharedDirectory::read_only(wire::CONTEXT_TAG, context));
                command = command.arg(wire::CONTEXT_TAG);
            }
        }
        _ => {
            return Err("vm takes --lower with --upper, or --build with --source".to_owned());
        }
    }
    Ok((config, command))
}

fn passt(program: &OsStr) -> Result<UnixStream, String> {
    let (guest, proxy) =
        UnixStream::pair().map_err(|error| format!("the network socket pair: {error}"))?;
    let mask = Ipv4Addr::from(u32::MAX << (u32::BITS - u32::from(wire::GUEST_PREFIX)));
    Command::new(program)
        .args(["--foreground", "--ipv4-only", "--no-dhcp", "--no-map-gw"])
        .args(["--fd", "0"])
        .args(["--address", &wire::GUEST_ADDRESS.to_string()])
        .args(["--netmask", &mask.to_string()])
        .args(["--gateway", &wire::GUEST_GATEWAY.to_string()])
        .args(["--dns-forward", &wire::GUEST_RESOLVER.to_string()])
        .stdin(Stdio::from(OwnedFd::from(proxy)))
        .spawn()
        .map_err(|error| format!("{}: {error}", Path::new(program).display()))?;
    Ok(guest)
}

fn exec(arguments: impl Iterator<Item = OsString>) -> Result<u8, String> {
    let arguments = Arguments::parse(
        arguments,
        &["cwd", "env", "env-file", "forward", "socket", "user"],
    )?;
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
        forwards: arguments
            .all("forward")
            .into_iter()
            .map(|forward| forward.as_bytes().to_vec())
            .collect(),
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
