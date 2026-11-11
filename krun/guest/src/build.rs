use std::{
    collections::{HashMap, HashSet},
    ffi::{OsStr, OsString},
    fs::{self, File, Metadata, Permissions},
    io::{self, Read, Write},
    os::unix::{
        ffi::{OsStrExt, OsStringExt},
        fs::{FileTypeExt, MetadataExt, PermissionsExt, chown, lchown, symlink},
    },
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, AtomicU32, Ordering},
    thread,
    time::Duration,
};

use nix::{
    errno::Errno,
    mount::{MntFlags, MsFlags, mount, umount2},
    sched::{CloneFlags, unshare},
    sys::{
        signal::{Signal, kill},
        stat::{Mode, SFlag, mknod},
    },
    unistd::{Pid, chdir, chroot, sync},
};
use sha2::{Digest, Sha256};
use tar::{Archive, Entry, EntryType};
use wire::Frame;

use crate::{
    NONE, exec, step,
    unpack::{self, stamp},
};

const HEX: &[u8; 16] = b"0123456789abcdef";
const HOSTS: &str = "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n";
const OPAQUE: &[u8] = b".wh..opq";
const SCRATCH: &str = "/mnt/run";
const SYMLINK_HOPS: u32 = 40;
const UNMOUNT_POLL: Duration = Duration::from_millis(10);
const UNMOUNT_TRIES: u32 = 500;
const WHITEOUT: &[u8] = b".wh.";
const XATTR: &str = "SCHILY.xattr.";

static ACTIVE: AtomicBool = AtomicBool::new(false);
static RUNS: AtomicU32 = AtomicU32::new(0);

pub(crate) fn activate() {
    ACTIVE.store(true, Ordering::Relaxed);
}

pub(crate) fn active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

fn path(bytes: &[u8]) -> &Path {
    Path::new(OsStr::from_bytes(bytes))
}

fn invalid(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn enter(root: &[u8], flags: CloneFlags) -> io::Result<()> {
    step(
        "leave the shared filesystem state",
        unshare(flags | CloneFlags::CLONE_FS),
    )?;
    step("enter the root", chroot(path(root)))?;
    step("enter /", chdir("/"))
}

fn remove(target: &Path) -> io::Result<()> {
    match fs::symlink_metadata(target) {
        Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(target),
        Ok(_) => fs::remove_file(target),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn rooted(entry: &Path) -> io::Result<Option<PathBuf>> {
    let mut target = PathBuf::from("/");
    for component in entry.components() {
        match component {
            Component::CurDir | Component::RootDir => {}
            Component::Normal(name) => target.push(name),
            Component::ParentDir | Component::Prefix(_) => {
                return Err(invalid(format!(
                    "a layer entry leaves the root: {}",
                    entry.display()
                )));
            }
        }
    }
    Ok((target.parent().is_some()).then_some(target))
}

fn clear(directory: &Path, written: &HashSet<PathBuf>) -> io::Result<()> {
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = entry?;
        let child = entry.path();
        if !written.contains(&child) {
            remove(&child)?;
        } else if entry.file_type()?.is_dir() {
            clear(&child, written)?;
        }
    }
    Ok(())
}

fn attributes<R: Read>(entry: &mut Entry<'_, R>, target: &Path) -> io::Result<()> {
    let Some(extensions) = entry.pax_extensions()? else {
        return Ok(());
    };
    for extension in extensions {
        let extension = extension?;
        if let Some(name) = extension.key().ok().and_then(|key| key.strip_prefix(XATTR)) {
            xattr::set(target, name, extension.value_bytes())?;
        }
    }
    Ok(())
}

pub(crate) fn apply(connection: &File, root: &[u8]) -> io::Result<()> {
    enter(root, CloneFlags::empty())?;
    let mut archive = Archive::new(unpack::Input::new(connection));
    archive.set_overwrite(true);
    archive.set_preserve_mtime(true);
    archive.set_preserve_ownerships(true);
    archive.set_preserve_permissions(true);
    archive.set_unpack_xattrs(true);
    let mut directories = Vec::new();
    let mut written = HashSet::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        let Some(target) = rooted(&entry.path()?)? else {
            continue;
        };
        let name = target.file_name().map(OsStr::as_bytes).unwrap_or_default();
        if let Some(hidden) = name.strip_prefix(WHITEOUT) {
            let parent = target.parent().unwrap_or(Path::new("/"));
            if hidden == OPAQUE {
                clear(parent, &written)?;
            } else if !hidden.starts_with(WHITEOUT) {
                remove(&parent.join(OsStr::from_bytes(hidden)))?;
            }
            continue;
        }
        let kind = entry.header().entry_type();
        if kind == EntryType::XGlobalHeader {
            continue;
        }
        match fs::symlink_metadata(&target) {
            Ok(existing) if existing.is_dir() && kind == EntryType::Directory => {}
            Ok(_) => remove(&target)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        match kind {
            EntryType::Block | EntryType::Char | EntryType::Fifo => {
                unpack::node(&entry, &target)?;
            }
            EntryType::Directory => {
                entry.unpack_in("/")?;
                attributes(&mut entry, &target)?;
                directories.push((target.clone(), entry.header().mtime()?));
            }
            _ => {
                entry.unpack_in("/")?;
            }
        }
        written.insert(target);
    }
    io::copy(&mut archive.into_inner(), &mut io::sink())?;
    for (directory, seconds) in directories.into_iter().rev() {
        if fs::symlink_metadata(&directory).is_ok_and(|metadata| metadata.is_dir()) {
            stamp(
                &directory,
                i64::try_from(seconds).map_err(io::Error::other)?,
            )?;
        }
    }
    Ok(())
}

pub(crate) struct Install<'a> {
    pub(crate) from: &'a [u8],
    pub(crate) into: bool,
    pub(crate) keep_owner: bool,
    pub(crate) root: &'a [u8],
    pub(crate) sources: &'a [Vec<u8>],
    pub(crate) to: &'a [u8],
}

fn relative(source: &[u8]) -> io::Result<PathBuf> {
    let mut target = PathBuf::from(".");
    for component in path(source).components() {
        match component {
            Component::CurDir | Component::RootDir => {}
            Component::Normal(name) => target.push(name),
            Component::ParentDir | Component::Prefix(_) => {
                return Err(invalid(format!(
                    "a source leaves its root: {}",
                    path(source).display()
                )));
            }
        }
    }
    Ok(target)
}

fn resolve(source: &Path) -> io::Result<PathBuf> {
    let mut pending = source
        .components()
        .rev()
        .map(|component| component.as_os_str().to_owned())
        .collect::<Vec<_>>();
    let mut resolved = PathBuf::from(".");
    let mut hops = 0;
    while let Some(name) = pending.pop() {
        if name == ".." {
            if resolved != Path::new(".") {
                resolved.pop();
            }
            continue;
        }
        let candidate = resolved.join(&name);
        match fs::symlink_metadata(&candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                hops += 1;
                if hops > SYMLINK_HOPS {
                    return Err(invalid(format!(
                        "too many links lead from {}",
                        source.display()
                    )));
                }
                let target = fs::read_link(&candidate)?;
                if target.is_absolute() {
                    resolved = PathBuf::from(".");
                }
                pending.extend(
                    target
                        .components()
                        .rev()
                        .filter_map(|component| match component {
                            Component::Normal(_) | Component::ParentDir => {
                                Some(component.as_os_str().to_owned())
                            }
                            _ => None,
                        }),
                );
            }
            _ => resolved = candidate,
        }
    }
    Ok(resolved)
}

fn parents(directory: &Path) -> io::Result<()> {
    let mut current = PathBuf::new();
    for component in directory.components() {
        current.push(component);
        match fs::create_dir(&current) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn describe(metadata: &Metadata, target: &Path, keep_owner: bool) -> io::Result<()> {
    let (uid, gid) = if keep_owner {
        (metadata.uid(), metadata.gid())
    } else {
        (0, 0)
    };
    lchown(target, Some(uid), Some(gid))?;
    if !metadata.file_type().is_symlink() {
        fs::set_permissions(target, Permissions::from_mode(metadata.mode() & 0o7777))?;
    }
    stamp(target, metadata.mtime())
}

fn copy(from: &Path, to: &Path, keep_owner: bool) -> io::Result<()> {
    let metadata = step(&from.display().to_string(), fs::symlink_metadata(from))?;
    let kind = metadata.file_type();
    let existing = match fs::symlink_metadata(to) {
        Ok(existing) => Some(existing),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    if let Some(existing) = &existing
        && existing.is_dir() != kind.is_dir()
    {
        return Err(invalid(format!(
            "{} is a directory on one side of the copy and not on the other",
            to.display()
        )));
    }
    if kind.is_dir() {
        if existing.is_none() {
            fs::create_dir(to)?;
        }
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            copy(&entry.path(), &to.join(entry.file_name()), keep_owner)?;
        }
    } else {
        remove(to)?;
        if kind.is_symlink() {
            symlink(fs::read_link(from)?, to)?;
        } else if kind.is_file() {
            io::copy(&mut File::open(from)?, &mut File::create(to)?)?;
        } else {
            let node = if kind.is_block_device() {
                SFlag::S_IFBLK
            } else if kind.is_char_device() {
                SFlag::S_IFCHR
            } else if kind.is_fifo() {
                SFlag::S_IFIFO
            } else {
                return Err(invalid(format!("{} is a socket", from.display())));
            };
            mknod(to, node, Mode::empty(), metadata.rdev())?;
        }
    }
    if keep_owner && !kind.is_symlink() {
        for name in xattr::list(from)? {
            if let Some(value) = xattr::get(from, &name)? {
                xattr::set(to, &name, &value)?;
            }
        }
    }
    describe(&metadata, to, keep_owner)
}

pub(crate) fn install(spec: &Install<'_>) -> io::Result<()> {
    step(
        "leave the shared filesystem state",
        unshare(CloneFlags::CLONE_FS),
    )?;
    step("enter the source", chdir(path(spec.from)))?;
    step("enter the root", chroot(path(spec.root)))?;
    let to = path(spec.to);
    for source in spec.sources {
        let named = relative(source)?;
        let from = step(&path(source).display().to_string(), resolve(&named))?;
        let metadata = step(
            &path(source).display().to_string(),
            fs::symlink_metadata(&from),
        )?;
        if metadata.is_dir() {
            parents(to)?;
            for entry in fs::read_dir(&from)? {
                let entry = entry?;
                copy(&entry.path(), &to.join(entry.file_name()), spec.keep_owner)?;
            }
            stamp(to, metadata.mtime())?;
        } else {
            let target = match named.file_name() {
                Some(name) if spec.into || to.is_dir() => to.join(name),
                _ => to.to_path_buf(),
            };
            if let Some(parent) = target.parent() {
                parents(parent)?;
            }
            copy(&from, &target, spec.keep_owner)?;
        }
    }
    Ok(())
}

pub(crate) fn mkdir(root: &[u8], directory: &[u8], user: &[u8]) -> io::Result<()> {
    enter(root, CloneFlags::empty())?;
    let account = exec::account(user)?;
    let mut current = PathBuf::new();
    for component in path(directory).components() {
        current.push(component);
        match fs::create_dir(&current) {
            Ok(()) => chown(&current, Some(account.uid), Some(account.gid))?,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    }
    if current.is_dir() {
        Ok(())
    } else {
        Err(invalid(format!("{} is not a directory", current.display())))
    }
}

pub(crate) fn run(
    connection: &File,
    root: &[u8],
    resolver: &[u8],
    spec: &exec::Spec,
) -> io::Result<i32> {
    step(
        "leave the shared mounts",
        unshare(CloneFlags::CLONE_NEWNS | CloneFlags::CLONE_FS),
    )?;
    let root = path(root);
    for name in ["dev", "proc", "sys"] {
        let target = root.join(name);
        fs::create_dir_all(&target)?;
        step(
            &format!("bind /{name}"),
            mount(
                Some(Path::new("/").join(name).as_path()),
                &target,
                NONE,
                MsFlags::MS_BIND | MsFlags::MS_REC,
                NONE,
            ),
        )?;
    }
    let scratch = PathBuf::from(format!(
        "{SCRATCH}.{}",
        RUNS.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&scratch)?;
    let mut created = Vec::new();
    if root.join("etc").is_dir() {
        for (name, content) in [("hosts", HOSTS.as_bytes()), ("resolv.conf", resolver)] {
            let source = scratch.join(name);
            fs::write(&source, content)?;
            let target = root.join("etc").join(name);
            match fs::symlink_metadata(&target) {
                Ok(metadata) if metadata.is_file() => {}
                Ok(_) => continue,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    File::create(&target)?;
                    created.push(Path::new("/etc").join(name));
                }
                Err(error) => return Err(error),
            }
            step(
                &format!("bind /etc/{name}"),
                mount(Some(&source), &target, NONE, MsFlags::MS_BIND, NONE),
            )?;
        }
    }
    step("enter the root", chroot(root))?;
    step("enter /", chdir("/"))?;
    let code = exec::run(connection, spec);
    for target in created {
        step(
            &format!("unbind {}", target.display()),
            umount2(&target, MntFlags::MNT_DETACH),
        )?;
        if fs::symlink_metadata(&target).is_ok_and(|metadata| metadata.len() == 0) {
            fs::remove_file(&target)?;
        }
    }
    code
}

pub(crate) fn finish() -> io::Result<()> {
    if !Path::new(wire::BUILD_ROOT).is_dir() {
        return Ok(());
    }
    match kill(Pid::from_raw(-1), Signal::SIGKILL) {
        Ok(()) | Err(Errno::ESRCH) => {}
        Err(error) => return step("end the build's processes", Err(error)),
    }
    sync();
    let mut tries = 0;
    loop {
        match umount2(wire::BUILD_ROOT, MntFlags::empty()) {
            Ok(()) => return Ok(()),
            Err(Errno::EBUSY) if tries < UNMOUNT_TRIES => {
                tries += 1;
                thread::sleep(UNMOUNT_POLL);
            }
            Err(error) => return step("unmount the build disk", Err(error)),
        }
    }
}

struct Listing<'a> {
    buffer: Vec<u8>,
    connection: &'a File,
    device: u64,
    links: HashMap<u64, Vec<u8>>,
}

fn escape(bytes: &[u8], line: &mut Vec<u8>) {
    for byte in bytes {
        match byte {
            b'\\' => line.extend_from_slice(b"\\\\"),
            0x21..=0x7e | b' ' => line.push(*byte),
            _ => {
                line.extend_from_slice(b"\\x");
                line.extend_from_slice(hex(&[*byte]).as_bytes());
            }
        }
    }
}

fn digest(file: &Path) -> io::Result<String> {
    let mut hasher = Sha256::new();
    let mut source = File::open(file)?;
    let mut buffer = vec![0; wire::CHUNK];
    loop {
        match source.read(&mut buffer)? {
            0 => break,
            length => hasher.update(&buffer[..length]),
        }
    }
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .flat_map(|byte| [byte >> 4, byte & 0xf])
        .map(|nibble| char::from(HEX[usize::from(nibble)]))
        .collect()
}

impl Listing<'_> {
    fn flush(&mut self) -> io::Result<()> {
        let mut writer = self.connection;
        for chunk in self.buffer.chunks(wire::CHUNK) {
            Frame::Stdout(chunk.to_vec()).write(&mut writer)?;
        }
        self.buffer.clear();
        Ok(())
    }

    fn line(&mut self, name: &[u8], target: &Path, metadata: &Metadata) -> io::Result<()> {
        let kind = metadata.file_type();
        let (letter, size) = if kind.is_dir() {
            ('d', "0".to_owned())
        } else if kind.is_symlink() {
            ('l', metadata.len().to_string())
        } else if kind.is_file() {
            ('f', metadata.len().to_string())
        } else {
            let letter = if kind.is_block_device() {
                'b'
            } else if kind.is_char_device() {
                'c'
            } else if kind.is_fifo() {
                'p'
            } else {
                's'
            };
            let device = metadata.rdev();
            (
                letter,
                format!(
                    "{}:{}",
                    nix::sys::stat::major(device),
                    nix::sys::stat::minor(device)
                ),
            )
        };
        let mut line = Vec::new();
        escape(name, &mut line);
        write!(
            line,
            "\t{letter}\t{:04o}\t{}\t{}\t{size}\t{}\t",
            metadata.mode() & 0o7777,
            metadata.uid(),
            metadata.gid(),
            metadata.mtime()
        )?;
        if kind.is_file() {
            line.extend_from_slice(digest(target)?.as_bytes());
        } else {
            line.push(b'-');
        }
        line.push(b'\t');
        if kind.is_symlink() {
            escape(fs::read_link(target)?.as_os_str().as_bytes(), &mut line);
        } else if kind.is_file() && metadata.nlink() > 1 {
            if let Some(first) = self.links.get(&metadata.ino()) {
                line.extend_from_slice(first);
            } else {
                let mut first = Vec::new();
                escape(name, &mut first);
                self.links.insert(metadata.ino(), first);
                line.push(b'-');
            }
        } else {
            line.push(b'-');
        }
        line.push(b'\t');
        let mut names = if kind.is_symlink() {
            Vec::new()
        } else {
            xattr::list(target)?.collect::<Vec<OsString>>()
        };
        names.sort();
        if names.is_empty() {
            line.push(b'-');
        }
        for (index, attribute) in names.iter().enumerate() {
            if index > 0 {
                line.push(b';');
            }
            escape(attribute.as_bytes(), &mut line);
            line.push(b'=');
            let value = xattr::get(target, attribute)?.unwrap_or_default();
            line.extend_from_slice(hex(&value).as_bytes());
        }
        line.push(b'\n');
        self.buffer.extend_from_slice(&line);
        if self.buffer.len() >= wire::CHUNK {
            self.flush()?;
        }
        Ok(())
    }

    fn walk(&mut self, root: &Path, directory: &[u8]) -> io::Result<()> {
        let mut names = fs::read_dir(root.join(OsStr::from_bytes(directory)))?
            .map(|entry| entry.map(|entry| entry.file_name().into_vec()))
            .collect::<io::Result<Vec<_>>>()?;
        names.sort();
        for name in names {
            let mut child = directory.to_vec();
            if !child.is_empty() {
                child.push(b'/');
            }
            child.extend_from_slice(&name);
            let target = root.join(OsStr::from_bytes(&child));
            let metadata = fs::symlink_metadata(&target)?;
            self.line(&child, &target, &metadata)?;
            if metadata.is_dir() && metadata.dev() == self.device {
                self.walk(root, &child)?;
            }
        }
        Ok(())
    }
}

pub(crate) fn tree(connection: &File, root: &[u8]) -> io::Result<()> {
    let root = path(root);
    let mut listing = Listing {
        buffer: Vec::with_capacity(2 * wire::CHUNK),
        connection,
        device: fs::symlink_metadata(root)?.dev(),
        links: HashMap::new(),
    };
    listing.walk(root, b"")?;
    listing.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_layer_entry_is_placed_under_the_root() {
        assert_eq!(
            rooted(Path::new("./usr/bin/env")).unwrap(),
            Some(PathBuf::from("/usr/bin/env"))
        );
        assert_eq!(
            rooted(Path::new("/etc/")).unwrap(),
            Some(PathBuf::from("/etc"))
        );
        assert_eq!(rooted(Path::new("./")).unwrap(), None);
        assert!(rooted(Path::new("usr/../../etc/passwd")).is_err());
    }

    #[test]
    fn a_source_stays_inside_its_root() {
        assert_eq!(relative(b"/uv").unwrap(), PathBuf::from("./uv"));
        assert_eq!(
            relative(b"task-deps/.").unwrap(),
            PathBuf::from("./task-deps")
        );
        assert_eq!(relative(b".").unwrap(), PathBuf::from("."));
        assert!(relative(b"../secret").is_err());
    }

    #[test]
    fn a_listed_name_keeps_one_line() {
        let mut line = Vec::new();
        escape(b"a b\tc\\d\n\xff", &mut line);
        assert_eq!(line, b"a b\\x09c\\\\d\\x0a\\xff");
        assert_eq!(hex(&[0, 0x0f, 0xa0]), "000fa0");
    }
}
