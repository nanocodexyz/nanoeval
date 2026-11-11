use std::{
    fs::{self, File, FileTimes, OpenOptions, Permissions},
    io::{self, Read},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process,
    time::SystemTime,
};

use sha2::{Digest, Sha256};

use super::{failed, hex, oci::Descriptor, reference::Reference, registry::Registry, sha256};

const BLOB_MODE: u32 = 0o444;
const LOCK: &str = "lock";
pub(super) const PARTIAL: &str = "part";
pub(super) const TEMPORARY: &str = "tmp";

pub(crate) struct Store {
    blobs: PathBuf,
    _lock: File,
}

pub(super) fn blobs(root: &Path) -> PathBuf {
    root.join("blobs").join("sha256")
}

pub(super) fn lock(root: &Path) -> Result<(File, PathBuf), String> {
    let path = root.join(LOCK);
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
        .map_err(|error| failed(&path, &error))?;
    Ok((file, path))
}

fn used(file: &File) -> io::Result<()> {
    file.set_times(FileTimes::new().set_accessed(SystemTime::now()))
}

impl Store {
    pub(crate) fn open(root: &Path) -> Result<Self, String> {
        let blobs = blobs(root);
        fs::create_dir_all(&blobs).map_err(|error| failed(&blobs, &error))?;
        let (lock, path) = lock(root)?;
        lock.lock_shared().map_err(|error| failed(&path, &error))?;
        Ok(Self { blobs, _lock: lock })
    }

    fn path(&self, digest: &str) -> PathBuf {
        self.blobs
            .join(digest.strip_prefix("sha256:").unwrap_or(digest))
    }

    pub(crate) fn document(
        &self,
        registry: &Registry,
        reference: &Reference,
        digest: &str,
    ) -> Result<Vec<u8>, String> {
        let path = self.path(digest);
        match File::open(&path) {
            Ok(mut file) => {
                let mut body = Vec::new();
                file.read_to_end(&mut body)
                    .and_then(|_| used(&file))
                    .map_err(|error| failed(&path, &error))?;
                return Ok(body);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(failed(&path, &error)),
        }
        let body = registry.manifest(reference, digest)?;
        let actual = format!("sha256:{}", hex(&Sha256::digest(&body)));
        if actual != digest {
            return Err(format!(
                "the manifest {digest} of {} hashes to {actual}",
                reference.repository
            ));
        }
        let temporary = path.with_extension(format!("{}.{TEMPORARY}", process::id()));
        fs::write(&temporary, &body)
            .and_then(|()| fs::set_permissions(&temporary, Permissions::from_mode(BLOB_MODE)))
            .and_then(|()| fs::rename(&temporary, &path))
            .map_err(|error| failed(&path, &error))?;
        Ok(body)
    }

    pub(crate) fn fetch(
        &self,
        registry: &Registry,
        reference: &Reference,
        descriptor: &Descriptor,
    ) -> Result<PathBuf, String> {
        let path = self.path(&descriptor.digest);
        if path.is_file() {
            File::open(&path)
                .and_then(|file| used(&file))
                .map_err(|error| failed(&path, &error))?;
            return Ok(path);
        }
        let partial = path.with_extension(PARTIAL);
        let part = OpenOptions::new()
            .create(true)
            .read(true)
            .truncate(false)
            .write(true)
            .open(&partial)
            .map_err(|error| failed(&partial, &error))?;
        part.lock().map_err(|error| failed(&partial, &error))?;
        if path.is_file() {
            let ours = part.metadata().map_err(|error| failed(&partial, &error))?;
            if fs::metadata(&partial).is_ok_and(|named| named.ino() == ours.ino()) {
                fs::remove_file(&partial).map_err(|error| failed(&partial, &error))?;
            }
            return Ok(path);
        }
        registry.blob(reference, &descriptor.digest, descriptor.size, &part)?;
        let actual = format!("sha256:{}", sha256(&partial)?);
        if actual != descriptor.digest {
            fs::remove_file(&partial).map_err(|error| failed(&partial, &error))?;
            return Err(format!(
                "the blob {} of {} hashes to {actual}",
                descriptor.digest, reference.repository
            ));
        }
        fs::set_permissions(&partial, Permissions::from_mode(BLOB_MODE))
            .and_then(|()| fs::rename(&partial, &path))
            .map_err(|error| failed(&path, &error))?;
        Ok(path)
    }
}
