use std::{fs, io, path::Path};

use net::netlink::{self, Interface};

use nix::{
    mount::{MntFlags, MsFlags, mount, umount2},
    sys::stat::{Mode, umask},
    unistd::{chdir, pivot_root, setsid},
};

use crate::{NONE, build, step};

const HOSTS: &str = "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n";
const LOST_AND_FOUND: &str = "lost+found";
const PID_MAX: &str = "/proc/sys/kernel/pid_max";
const PID_MAX_DEFAULT: &str = "32768";
const OVERLAY: &str = "lowerdir=/mnt/lower,upperdir=/mnt/upper/upper,workdir=/mnt/upper/work";
const RESOLVER: &str = "/opt/nanoeval/krun/resolv.conf";
const RUNTIME: &str = "/mnt/root/opt/nanoeval";
const SOURCE_OPTIONS: &str = "noload";

pub(crate) struct Build {
    pub(crate) context: bool,
    pub(crate) root: bool,
    pub(crate) sources: u8,
}

pub(crate) struct Options {
    pub(crate) build: Build,
    pub(crate) private: bool,
    pub(crate) runtime: bool,
}

pub(crate) fn run(mode: &str, options: &Options) -> io::Result<()> {
    if options.private {
        netlink::configure(&Interface {
            address: wire::GUEST_ADDRESS,
            gateway: wire::GUEST_GATEWAY,
            mtu: wire::GUEST_MTU,
            name: wire::GUEST_INTERFACE,
            prefix: wire::GUEST_PREFIX,
        })?;
    }
    step(
        "make / private",
        mount(NONE, "/", NONE, MsFlags::MS_REC | MsFlags::MS_PRIVATE, NONE),
    )?;
    step(
        "mount /mnt",
        mount(Some("tmpfs"), "/mnt", Some("tmpfs"), MsFlags::empty(), NONE),
    )?;
    if mode == wire::BUILD {
        return build(&options.build);
    }
    fs::create_dir("/mnt/root")?;
    if mode != "overlay" {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("unknown boot mode: {mode}"),
        ));
    }
    overlay()?;
    for name in ["dev", "proc", "sys"] {
        let target = format!("/mnt/root/{name}");
        fs::create_dir_all(&target)?;
        step(
            &format!("move /{name}"),
            mount(
                Some(format!("/{name}").as_str()),
                target.as_str(),
                NONE,
                MsFlags::MS_MOVE,
                NONE,
            ),
        )?;
    }
    if options.runtime {
        fs::create_dir_all(RUNTIME)?;
        step(
            "mount the runtime share",
            mount(
                Some(wire::RUNTIME_TAG),
                RUNTIME,
                Some("virtiofs"),
                MsFlags::MS_RDONLY,
                NONE,
            ),
        )?;
    }
    step("enter the root", chdir("/mnt/root"))?;
    step("pivot the root", pivot_root(".", "."))?;
    step("detach the boot root", umount2(".", MntFlags::MNT_DETACH))?;
    step("enter /", chdir("/"))?;
    step("leave the session of the console", setsid())?;
    step(
        "raise the limit on process ids",
        fs::write(PID_MAX, PID_MAX_DEFAULT),
    )?;
    if options.private {
        let resolver = format!("nameserver {}\n", wire::GUEST_RESOLVER);
        provide(Path::new("/etc/resolv.conf"), resolver.as_bytes())?;
    } else if let Ok(resolver) = fs::read(RESOLVER) {
        provide(Path::new("/etc/resolv.conf"), &resolver)?;
    }
    provide(Path::new("/etc/hosts"), HOSTS.as_bytes())
}

fn build(options: &Build) -> io::Result<()> {
    umask(Mode::from_bits_truncate(0o022));
    let mut devices = (b'a'..=b'z').map(|letter| format!("/dev/vd{}", char::from(letter)));
    let mut device = || {
        devices
            .next()
            .ok_or_else(|| io::Error::other("a build has more disks than device letters"))
    };
    if options.root {
        fs::create_dir(wire::BUILD_ROOT)?;
        step(
            "mount the build disk",
            mount(
                Some(device()?.as_str()),
                wire::BUILD_ROOT,
                Some("ext4"),
                MsFlags::empty(),
                NONE,
            ),
        )?;
        match fs::remove_dir(Path::new(wire::BUILD_ROOT).join(LOST_AND_FOUND)) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    if options.sources > 0 {
        fs::create_dir(wire::BUILD_SOURCE)?;
    }
    for index in 0..options.sources {
        let target = format!("{}/{index}", wire::BUILD_SOURCE);
        fs::create_dir(&target)?;
        step(
            &format!("mount source disk {index}"),
            mount(
                Some(device()?.as_str()),
                target.as_str(),
                Some("ext4"),
                MsFlags::MS_RDONLY,
                Some(SOURCE_OPTIONS),
            ),
        )?;
    }
    if options.context {
        fs::create_dir(wire::BUILD_CONTEXT)?;
        step(
            "mount the build context",
            mount(
                Some(wire::CONTEXT_TAG),
                wire::BUILD_CONTEXT,
                Some("virtiofs"),
                MsFlags::MS_RDONLY,
                NONE,
            ),
        )?;
    }
    step("leave the session of the console", setsid())?;
    build::activate();
    Ok(())
}

fn disk(what: &str, device: &str, target: &str, flags: MsFlags) -> io::Result<()> {
    step(
        &format!("mount {what}"),
        mount(Some(device), target, Some("ext4"), flags, NONE),
    )
}

fn overlay() -> io::Result<()> {
    fs::create_dir("/mnt/lower")?;
    fs::create_dir("/mnt/upper")?;
    disk(
        "the lower disk",
        "/dev/vda",
        "/mnt/lower",
        MsFlags::MS_RDONLY,
    )?;
    disk("the upper disk", "/dev/vdb", "/mnt/upper", MsFlags::empty())?;
    fs::create_dir_all("/mnt/upper/upper")?;
    fs::create_dir_all("/mnt/upper/work")?;
    step(
        "mount the overlay",
        mount(
            Some("overlay"),
            "/mnt/root",
            Some("overlay"),
            MsFlags::empty(),
            Some(OVERLAY),
        ),
    )
}

fn provide(path: &Path, content: &[u8]) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => fs::remove_file(path)?,
        Err(_) => {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
        }
    }
    fs::write(path, content)
}
