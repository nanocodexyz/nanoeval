use std::{
    ffi::OsString,
    fs::{self, File, Permissions},
    io::{self, BufReader, BufWriter, Read, Write},
    os::{
        fd::AsFd,
        unix::fs::{FileExt, PermissionsExt},
    },
    path::Path,
    thread,
    time::Instant,
};

use nix::{
    errno::Errno,
    unistd::{Whence, lseek},
};
use sha2::Digest;
use zstd::stream::{read::Decoder, write::Encoder};

use super::{Hashing, Lock, absolute, allocated, beside, failed, hex, sha256};
use crate::Arguments;

const BLOCK: usize = 4096;
const DIGEST: usize = 32;
const DISK_MODE: u32 = 0o444;
const LEVEL: i32 = 3;
const LOCK: &str = ".lock";
const MAGIC: [u8; 8] = *b"NKRDISK1";
const RUN: usize = 1024 * 1024;
const TEMPORARY: &str = ".tmp";
const WORKERS: u32 = 4;

fn number(bytes: u64) -> Result<usize, String> {
    usize::try_from(bytes).map_err(|_| "a length does not fit this machine".to_owned())
}

fn offset(position: u64) -> Result<i64, String> {
    i64::try_from(position).map_err(|_| "the disk is too large".to_owned())
}

fn seek(disk: &File, from: u64, whence: Whence, size: u64) -> Result<u64, String> {
    match lseek(disk.as_fd(), offset(from)?, whence) {
        Ok(found) => u64::try_from(found).map_err(|_| "a negative offset".to_owned()),
        Err(Errno::ENXIO) => Ok(size),
        Err(error) => Err(format!("the disk could not be scanned: {error}")),
    }
}

struct Records<W: Write> {
    data: u64,
    pending: Vec<u8>,
    start: u64,
    writer: W,
}

impl<W: Write> Records<W> {
    fn flush(&mut self) -> io::Result<()> {
        if self.pending.is_empty() {
            return Ok(());
        }
        self.writer.write_all(&self.start.to_le_bytes())?;
        self.writer
            .write_all(&(self.pending.len() as u64).to_le_bytes())?;
        self.writer.write_all(&self.pending)?;
        self.data += self.pending.len() as u64;
        self.pending.clear();
        Ok(())
    }

    fn block(&mut self, position: u64, block: &[u8]) -> io::Result<()> {
        if block.iter().all(|byte| *byte == 0) {
            return self.flush();
        }
        if self.pending.is_empty() {
            self.start = position;
        }
        self.pending.extend_from_slice(block);
        if self.pending.len() >= RUN {
            self.flush()?;
        }
        Ok(())
    }
}

fn scan(disk: &File, size: u64, records: &mut Records<impl Write>) -> Result<(), String> {
    let block = BLOCK as u64;
    let written = |error: io::Error| format!("the packed disk could not be written: {error}");
    let mut buffer = vec![0; RUN];
    let mut position = 0;
    while position < size {
        let data = seek(disk, position, Whence::SeekData, size)?;
        if data >= size {
            break;
        }
        let start = data / block * block;
        let end = seek(disk, data, Whence::SeekHole, size)?.div_ceil(block) * block;
        if start > position {
            records.flush().map_err(written)?;
        }
        position = start;
        while position < end {
            let length = number((end - position).min(RUN as u64))?;
            disk.read_exact_at(&mut buffer[..length], position)
                .map_err(|error| format!("the disk could not be read: {error}"))?;
            for (index, chunk) in buffer[..length].chunks(BLOCK).enumerate() {
                records
                    .block(position + (index * BLOCK) as u64, chunk)
                    .map_err(written)?;
            }
            position += length as u64;
        }
    }
    records.flush().map_err(written)
}

pub(crate) fn pack(arguments: impl Iterator<Item = OsString>) -> Result<u8, String> {
    let started = Instant::now();
    let arguments = Arguments::mixed(arguments, &["out"])?;
    let [disk] = arguments.rest.as_slice() else {
        return Err("usage: nanoeval-krun image pack DISK.ext4 --out FILE".to_owned());
    };
    let disk = absolute(disk)?;
    let out = absolute(arguments.one("out")?)?;
    let _lock = Lock::take(beside(&out, LOCK))?;
    let source = File::open(&disk).map_err(|error| failed(&disk, &error))?;
    let size = source
        .metadata()
        .map_err(|error| failed(&disk, &error))?
        .len();
    if size % BLOCK as u64 != 0 {
        return Err(format!(
            "{} is not a whole number of {BLOCK}-byte blocks",
            disk.display()
        ));
    }
    let temporary = beside(&out, TEMPORARY);
    let written = |error: io::Error| failed(&temporary, &error);
    let file = File::create(&temporary).map_err(written)?;
    let mut packed = Hashing::new(BufWriter::new(file));
    let mut encoder = Encoder::new(&mut packed, LEVEL).map_err(written)?;
    let workers = thread::available_parallelism().map_or(1, |cores| {
        u32::try_from(cores.get()).unwrap_or(WORKERS).min(WORKERS)
    });
    encoder.multithread(workers).map_err(written)?;
    let mut records = Records {
        data: 0,
        pending: Vec::with_capacity(RUN + BLOCK),
        start: 0,
        writer: Hashing::new(&mut encoder),
    };
    records.writer.write_all(&MAGIC).map_err(written)?;
    records
        .writer
        .write_all(&size.to_le_bytes())
        .map_err(written)?;
    scan(&source, size, &mut records)?;
    records
        .writer
        .write_all(&size.to_le_bytes())
        .and_then(|()| records.writer.write_all(&0_u64.to_le_bytes()))
        .map_err(written)?;
    let payload = records.writer.hasher.clone();
    let data = records.data;
    drop(records);
    encoder.write_all(&payload.finalize()).map_err(written)?;
    encoder.finish().map_err(written)?;
    packed.flush().map_err(written)?;
    let digest = packed.digest();
    drop(packed);
    fs::rename(&temporary, &out).map_err(|error| failed(&out, &error))?;
    let bytes = fs::metadata(&out)
        .map_err(|error| failed(&out, &error))?
        .len();
    println!(
        "{}",
        serde_json::json!({
            "bytes": bytes,
            "data_bytes": data,
            "disk_bytes": size,
            "file": out,
            "seconds": started.elapsed().as_secs_f64(),
            "sha256": digest,
        })
    );
    Ok(0)
}

fn field(reader: &mut impl Read) -> io::Result<u64> {
    let mut bytes = [0; 8];
    reader.read_exact(&mut bytes)?;
    Ok(u64::from_le_bytes(bytes))
}

fn restore(file: &Path, disk: &File) -> Result<(String, u64), String> {
    let damaged = |error: io::Error| format!("{} is damaged: {error}", file.display());
    let invalid = |message: &str| format!("{} is damaged: {message}", file.display());
    let source = File::open(file).map_err(|error| failed(file, &error))?;
    let mut packed = Hashing::new(BufReader::new(source));
    let mut payload = Hashing::new(Decoder::new(&mut packed).map_err(damaged)?);
    let mut magic = [0; 8];
    payload.read_exact(&mut magic).map_err(damaged)?;
    if magic != MAGIC {
        return Err(invalid("it does not start with the disk magic"));
    }
    let size = field(&mut payload).map_err(damaged)?;
    disk.set_len(size)
        .map_err(|error| format!("the disk could not be sized: {error}"))?;
    let mut buffer = vec![0; RUN];
    let mut end = 0;
    loop {
        let start = field(&mut payload).map_err(damaged)?;
        let length = field(&mut payload).map_err(damaged)?;
        if length == 0 {
            if start != size {
                return Err(invalid("its last record does not end the disk"));
            }
            break;
        }
        if start < end || length > RUN as u64 || start + length > size {
            return Err(invalid("a record lies outside the disk"));
        }
        let length = number(length)?;
        payload.read_exact(&mut buffer[..length]).map_err(damaged)?;
        disk.write_all_at(&buffer[..length], start)
            .map_err(|error| format!("the disk could not be written: {error}"))?;
        end = start + length as u64;
    }
    let expected = payload.digest();
    let mut recorded = [0; DIGEST];
    payload.read_exact(&mut recorded).map_err(damaged)?;
    if hex(&recorded) != expected {
        return Err(invalid("its content does not match its digest"));
    }
    if io::copy(&mut payload, &mut io::sink()).map_err(damaged)? != 0 {
        return Err(invalid("data follows its digest"));
    }
    drop(payload);
    Ok((packed.digest(), size))
}

pub(crate) fn unpack(arguments: impl Iterator<Item = OsString>) -> Result<u8, String> {
    let started = Instant::now();
    let arguments = Arguments::mixed(arguments, &["out", "sha256"])?;
    let [file] = arguments.rest.as_slice() else {
        return Err(
            "usage: nanoeval-krun image unpack FILE --out DISK.ext4 [--sha256 DIGEST]".to_owned(),
        );
    };
    let file = absolute(file)?;
    let out = absolute(arguments.one("out")?)?;
    let _lock = Lock::take(beside(&out, LOCK))?;
    let wanted = |digest: &str| match arguments
        .maybe("sha256")
        .map(|wanted| wanted.to_string_lossy())
    {
        Some(wanted) if wanted.trim_start_matches("sha256:") != digest => Err(format!(
            "{} hashes to {digest}, not {wanted}",
            file.display()
        )),
        _ => Ok(()),
    };
    let (digest, size) = if out.is_file() {
        let digest = sha256(&file)?;
        wanted(&digest)?;
        let size = fs::metadata(&out)
            .map_err(|error| failed(&out, &error))?
            .len();
        eprintln!("nanoeval-krun: {} is already unpacked", out.display());
        (digest, size)
    } else {
        let temporary = beside(&out, TEMPORARY);
        let disk = File::create(&temporary).map_err(|error| failed(&temporary, &error))?;
        let restored = restore(&file, &disk).and_then(|(digest, size)| {
            wanted(&digest)?;
            disk.set_permissions(Permissions::from_mode(DISK_MODE))
                .and_then(|()| disk.sync_all())
                .and_then(|()| fs::rename(&temporary, &out))
                .map(|()| (digest, size))
                .map_err(|error| failed(&out, &error))
        });
        match restored {
            Ok(restored) => restored,
            Err(message) => {
                let _ = fs::remove_file(&temporary);
                return Err(message);
            }
        }
    };
    println!(
        "{}",
        serde_json::json!({
            "bytes_allocated": allocated(&out)?,
            "disk": out,
            "disk_bytes": size,
            "seconds": started.elapsed().as_secs_f64(),
            "sha256": digest,
        })
    );
    Ok(0)
}
