use std::{
    fs::{self, File, Permissions},
    io::{self, Read},
    os::unix::fs::{PermissionsExt, lchown},
    path::Path,
};

use nix::{
    fcntl::AT_FDCWD,
    sys::{
        stat::{Mode, SFlag, UtimensatFlags, makedev, mknod, utimensat},
        time::TimeSpec,
    },
};
use tar::{Entry, EntryType};
use wire::Frame;

use crate::step;

pub(crate) struct Input<'a> {
    connection: &'a File,
    ended: bool,
    offset: usize,
    pending: Vec<u8>,
}

impl<'a> Input<'a> {
    pub(crate) fn new(connection: &'a File) -> Self {
        Self {
            connection,
            ended: false,
            offset: 0,
            pending: Vec::new(),
        }
    }
}

pub(crate) fn node<R: Read>(entry: &Entry<'_, R>, path: &Path) -> io::Result<()> {
    let header = entry.header();
    let kind = match header.entry_type() {
        EntryType::Block => SFlag::S_IFBLK,
        EntryType::Char => SFlag::S_IFCHR,
        _ => SFlag::S_IFIFO,
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let device = if kind == SFlag::S_IFIFO {
        0
    } else {
        makedev(
            u64::from(header.device_major()?.unwrap_or(0)),
            u64::from(header.device_minor()?.unwrap_or(0)),
        )
    };
    mknod(path, kind, Mode::empty(), device)?;
    lchown(
        path,
        Some(u32::try_from(header.uid()?).map_err(io::Error::other)?),
        Some(u32::try_from(header.gid()?).map_err(io::Error::other)?),
    )?;
    fs::set_permissions(path, Permissions::from_mode(header.mode()?))?;
    stamp(
        path,
        i64::try_from(header.mtime()?).map_err(io::Error::other)?,
    )
}

pub(crate) fn stamp(path: &Path, seconds: i64) -> io::Result<()> {
    let time = TimeSpec::new(seconds, 0);
    step(
        &format!("set the time of {}", path.display()),
        utimensat(
            AT_FDCWD,
            path,
            &time,
            &time,
            UtimensatFlags::NoFollowSymlink,
        ),
    )
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
