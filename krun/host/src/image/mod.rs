mod build;
mod dockerfile;
mod machine;
mod oci;
mod reference;
mod registry;
mod store;

use std::{
    ffi::OsString,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

const HEX: &[u8; 16] = b"0123456789abcdef";
const SECTOR: u64 = 512;
const USAGE: &str = "usage: nanoeval-krun image <build|tree> ...";

pub(crate) fn run(mut arguments: impl Iterator<Item = OsString>) -> Result<u8, String> {
    let command = arguments.next().unwrap_or_default();
    match command.to_str() {
        Some("build") => build::command(arguments),
        Some("tree") => machine::tree(arguments),
        _ => Err(USAGE.to_owned()),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .flat_map(|byte| [byte >> 4, byte & 0xf])
        .map(|nibble| char::from(HEX[usize::from(nibble)]))
        .collect()
}

fn failed(path: &Path, error: &io::Error) -> String {
    format!("{}: {error}", path.display())
}

fn absolute(path: &OsString) -> Result<PathBuf, String> {
    std::path::absolute(path).map_err(|error| failed(Path::new(path), &error))
}

fn beside(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

struct Lock {
    _file: File,
    path: PathBuf,
}

impl Lock {
    fn take(path: PathBuf) -> Result<Self, String> {
        loop {
            let file = OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(&path)
                .map_err(|error| failed(&path, &error))?;
            file.lock().map_err(|error| failed(&path, &error))?;
            let held = file.metadata().map_err(|error| failed(&path, &error))?;
            if fs::metadata(&path).is_ok_and(|named| named.ino() == held.ino()) {
                return Ok(Self { _file: file, path });
            }
        }
    }
}

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn allocated(path: &Path) -> Result<u64, String> {
    let metadata = fs::metadata(path).map_err(|error| failed(path, &error))?;
    Ok(metadata.blocks() * SECTOR)
}

struct Hashing<T> {
    hasher: Sha256,
    inner: T,
}

impl<T> Hashing<T> {
    fn new(inner: T) -> Self {
        Self {
            hasher: Sha256::new(),
            inner,
        }
    }

    fn digest(&self) -> String {
        hex(&self.hasher.clone().finalize())
    }
}

impl<T: Read> Read for Hashing<T> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let length = self.inner.read(buffer)?;
        self.hasher.update(&buffer[..length]);
        Ok(length)
    }
}

impl<T: Write> Write for Hashing<T> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let length = self.inner.write(buffer)?;
        self.hasher.update(&buffer[..length]);
        Ok(length)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn sha256(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|error| failed(path, &error))?;
    let mut reader = Hashing::new(file);
    io::copy(&mut reader, &mut io::sink()).map_err(|error| failed(path, &error))?;
    Ok(reader.digest())
}

struct Scratch(PathBuf);

impl Scratch {
    fn create(path: PathBuf) -> Result<Self, String> {
        match fs::remove_dir_all(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(failed(&path, &error)),
        }
        fs::create_dir_all(&path).map_err(|error| failed(&path, &error))?;
        Ok(Self(path))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
