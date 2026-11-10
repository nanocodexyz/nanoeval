use std::{
    ffi::OsStr,
    fs::{self, File, Permissions},
    io::{self, Read},
    os::unix::{
        ffi::OsStrExt,
        fs::{PermissionsExt, lchown},
    },
    path::Path,
    time::{Duration, UNIX_EPOCH},
};

use nix::sys::stat::{Mode, SFlag, makedev, mknod};
use tar::{Archive, EntryType};
use wire::Frame;

struct Input<'a> {
    connection: &'a File,
    ended: bool,
    offset: usize,
    pending: Vec<u8>,
}

impl Read for Input<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        while self.offset == self.pending.len() {
            if self.ended {
                return Ok(0);
            }
            match Frame::read(&mut self.connection)? {
                Frame::Stdin(data) => {
                    self.pending = data;
                    self.offset = 0;
                }
                Frame::StdinEnd => self.ended = true,
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "an archive stream carries only input frames",
                    ));
                }
            }
        }
        let length = buffer.len().min(self.pending.len() - self.offset);
        buffer[..length].copy_from_slice(&self.pending[self.offset..self.offset + length]);
        self.offset += length;
        Ok(length)
    }
}

pub(crate) fn run(connection: &File, to: &[u8]) -> io::Result<()> {
    let to = Path::new(OsStr::from_bytes(to));
    let mut archive = Archive::new(Input {
        connection,
        ended: false,
        offset: 0,
        pending: Vec::new(),
    });
    archive.set_overwrite(true);
    archive.set_preserve_mtime(true);
    archive.set_preserve_ownerships(true);
    archive.set_preserve_permissions(true);
    archive.set_unpack_xattrs(true);
    let mut directories = Vec::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        let kind = match entry.header().entry_type() {
            EntryType::Block => SFlag::S_IFBLK,
            EntryType::Char => SFlag::S_IFCHR,
            EntryType::Directory => {
                directories.push(entry);
                continue;
            }
            EntryType::Fifo => SFlag::S_IFIFO,
            _ => {
                entry.unpack_in(to)?;
                continue;
            }
        };
        let header = entry.header();
        let path = to.join(entry.path()?);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let device = makedev(
            u64::from(header.device_major()?.unwrap_or(0)),
            u64::from(header.device_minor()?.unwrap_or(0)),
        );
        mknod(
            &path,
            kind,
            Mode::from_bits_truncate(header.mode()?),
            device,
        )?;
        lchown(
            &path,
            Some(u32::try_from(header.uid()?).map_err(io::Error::other)?),
            Some(u32::try_from(header.gid()?).map_err(io::Error::other)?),
        )?;
    }
    directories.sort_by(|left, right| right.path_bytes().cmp(&left.path_bytes()));
    for directory in directories {
        let header = directory.header();
        let path = to.join(directory.path()?);
        fs::create_dir_all(&path)?;
        lchown(
            &path,
            Some(u32::try_from(header.uid()?).map_err(io::Error::other)?),
            Some(u32::try_from(header.gid()?).map_err(io::Error::other)?),
        )?;
        fs::set_permissions(&path, Permissions::from_mode(header.mode()?))?;
        File::open(&path)?.set_modified(UNIX_EPOCH + Duration::from_secs(header.mtime()?))?;
    }
    Ok(())
}
