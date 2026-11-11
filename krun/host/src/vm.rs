use std::{
    ffi::{OsStr, OsString},
    net::Ipv4Addr,
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::net::UnixStream,
    },
    path::Path,
    process::{self, Command, Stdio},
    thread,
    time::Duration,
};

use nanovm::{
    BlockDevice, Capabilities, GuestCommand, KrunVm, Network, RootFilesystem, SharedDirectory,
    VmConfig, VsockPort,
};
use nix::sys::resource::{Resource, getrlimit, setrlimit};

use crate::{Arguments, gate};

const GUEST: &str = "/nanoeval-krun-guest";
const LEASH_EXIT: i32 = 125;
const LEASH_POLL: Duration = Duration::from_millis(200);

pub(crate) fn check() -> Result<u8, String> {
    let capabilities = Capabilities::detect().map_err(|error| error.to_string())?;
    println!("{}", capabilities.max_vcpus());
    Ok(0)
}

pub(crate) fn run(arguments: impl Iterator<Item = OsString>) -> Result<u8, String> {
    let arguments = Arguments::parse(
        arguments,
        &[
            "boot",
            "build",
            "context",
            "cpus",
            "forward",
            "gate",
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
    getrlimit(Resource::RLIMIT_NOFILE)
        .and_then(|(_, hard)| setrlimit(Resource::RLIMIT_NOFILE, hard, hard))
        .map_err(|error| format!("the limit on open files: {error}"))?;
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
    let gate = arguments.maybe("gate").map(Path::new);
    let proxy = arguments
        .maybe("passt")
        .map(|program| passt(program, gate))
        .transpose()?;
    if gate.is_some() && proxy.is_none() {
        return Err("--gate needs --passt".to_owned());
    }
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

fn passt(program: &OsStr, gate: Option<&Path>) -> Result<UnixStream, String> {
    let pair = || UnixStream::pair().map_err(|error| format!("the network socket pair: {error}"));
    let (guest, proxy) = pair()?;
    let (guest, proxy) = match gate {
        Some(open) => {
            let (far, behind) = pair()?;
            gate::spawn(proxy, far, open).map_err(|error| format!("the network gate: {error}"))?;
            (guest, behind)
        }
        None => (guest, proxy),
    };
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
