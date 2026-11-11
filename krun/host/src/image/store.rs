use std::{
    fs::{self, OpenOptions, Permissions},
    io,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    process,
};

use sha2::{Digest, Sha256};

use super::{failed, hex, oci::Descriptor, reference::Reference, registry::Registry, sha256};

const BLOB_MODE: u32 = 0o444;

pub(crate) struct Store {
    blobs: PathBuf,
}

impl Store {
    pub(crate) fn open(root: &Path) -> Result<Self, String> {
        let blobs = root.join("blobs").join("sha256");
        fs::create_dir_all(&blobs).map_err(|error| failed(&blobs, &error))?;
        Ok(Self { blobs })
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
        match fs::read(&path) {
            Ok(body) => return Ok(body),
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
        let temporary = path.with_extension(format!("{}.tmp", process::id()));
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
            return Ok(path);
        }
        let partial = path.with_extension("part");
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
