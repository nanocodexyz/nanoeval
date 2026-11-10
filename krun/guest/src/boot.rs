use std::{fs, io, path::Path};

use net::netlink::{self, Interface};

use nix::{
    mount::{MntFlags, MsFlags, mount, umount2},
    unistd::{chdir, pivot_root, setsid},
};

use crate::{NONE, step};

const HOSTS: &str = "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n";
const PID_MAX: &str = "/proc/sys/kernel/pid_max";
const PID_MAX_DEFAULT: &str = "32768";
const OVERLAY: &str = "lowerdir=/mnt/lower,upperdir=/mnt/upper/upper,workdir=/mnt/upper/work";
const RESOLVER: &str = "/opt/nanoeval/krun/resolv.conf";
const RUNTIME: &str = "/mnt/root/opt/nanoeval";

pub(crate) struct Options {
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
    fs::create_dir("/mnt/root")?;
    match mode {
        "disk" => disk("the disk", "/dev/vda", "/mnt/root", MsFlags::empty())?,
        "overlay" => overlay()?,
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("unknown boot mode: {mode}"),
            ));
        }
    }
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
    if mode == "overlay" {
        if options.private {
            let resolver = format!("nameserver {}\n", wire::GUEST_RESOLVER);
            seed(Path::new("/etc/resolv.conf"), resolver.as_bytes())?;
        } else if let Ok(resolver) = fs::read(RESOLVER) {
            seed(Path::new("/etc/resolv.conf"), &resolver)?;
        }
        seed(Path::new("/etc/hosts"), HOSTS.as_bytes())?;
    }
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

fn seed(path: &Path, content: &[u8]) -> io::Result<()> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.len() > 0 => return Ok(()),
        Ok(_) => {}
        Err(_) => {
            if fs::symlink_metadata(path).is_ok() {
                fs::remove_file(path)?;
            }
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
        }
    }
    fs::write(path, content)
}
