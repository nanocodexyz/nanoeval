use std::{
    ffi::OsStr,
    fs, io,
    os::unix::{ffi::OsStrExt, fs::symlink},
    path::Path,
    sync::{Mutex, PoisonError},
};

use nix::mount::{MntFlags, MsFlags, mount, umount2};

use crate::{NONE, namespace, step};

const EXCHANGE: &str = "/.nanoeval-io";

static SHARE: Mutex<()> = Mutex::new(());

pub(crate) fn into_guest(from: &[u8], to: &[u8]) -> io::Result<()> {
    with_share(|share| {
        tree(
            &share.join(OsStr::from_bytes(from)),
            Path::new(OsStr::from_bytes(to)),
        )
    })
}

pub(crate) fn out_of_guest(from: &[u8], to: &[u8]) -> io::Result<()> {
    with_share(|share| {
        tree(
            Path::new(OsStr::from_bytes(from)),
            &share.join(OsStr::from_bytes(to)),
        )
    })
}

fn with_share(work: impl FnOnce(&Path) -> io::Result<()>) -> io::Result<()> {
    let _guard = SHARE.lock().unwrap_or_else(PoisonError::into_inner);
    if namespace::active() {
        return work(Path::new(wire::NAMESPACE_EXCHANGE));
    }
    fs::create_dir(EXCHANGE)?;
    let result = step(
        "mount the exchange share",
        mount(
            Some(wire::IO_TAG),
            EXCHANGE,
            Some("virtiofs"),
            MsFlags::empty(),
            NONE,
        ),
    )
    .and_then(|()| {
        let result = work(Path::new(EXCHANGE));
        step(
            "unmount the exchange share",
            umount2(EXCHANGE, MntFlags::MNT_DETACH),
        )
        .and(result)
    });
    fs::remove_dir(EXCHANGE)?;
    result
}

fn tree(from: &Path, to: &Path) -> io::Result<()> {
    let metadata = step(&from.display().to_string(), fs::symlink_metadata(from))?;
    if metadata.file_type().is_symlink() {
        symlink(fs::read_link(from)?, to)
    } else if metadata.is_dir() {
        fs::create_dir_all(to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            tree(&entry.path(), &to.join(entry.file_name()))?;
        }
        fs::set_permissions(to, metadata.permissions())
    } else {
        fs::copy(from, to).map(|_| ())
    }
}
