use std::{
    ffi::OsString,
    fs::{self, File, Metadata, OpenOptions, TryLockError},
    io,
    os::unix::fs::MetadataExt,
    path::Path,
    time::{Duration, SystemTime},
};

use super::{
    absolute, failed,
    reference::valid_digest,
    store::{self, PARTIAL, TEMPORARY},
};
use crate::Arguments;

const DAY: Duration = Duration::from_hours(24);
const REMOVE: &str = "--remove";
const USAGE: &str = "usage: nanoeval-krun image prune --cache DIR --days N [--remove]";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Kind {
    Blob,
    Partial,
    Temporary,
}

impl Kind {
    fn of(name: &str) -> Option<Self> {
        let blob = |name: &str| valid_digest(&format!("sha256:{name}"));
        if blob(name) {
            return Some(Self::Blob);
        }
        let (stem, extension) = name.rsplit_once('.')?;
        if extension == PARTIAL && blob(stem) {
            return Some(Self::Partial);
        }
        let (digest, process) = stem.rsplit_once('.')?;
        (extension == TEMPORARY && blob(digest) && process.parse::<u32>().is_ok())
            .then_some(Self::Temporary)
    }

    fn label(self) -> &'static str {
        match self {
            Self::Blob => "blob",
            Self::Partial => "partial",
            Self::Temporary => "temporary",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Outcome {
    Kept,
    Removed,
    Unused,
}

impl Outcome {
    fn label(self) -> &'static str {
        match self {
            Self::Kept => "kept",
            Self::Removed => "removed",
            Self::Unused => "unused",
        }
    }
}

#[derive(Debug)]
struct Entry {
    age: Duration,
    bytes: u64,
    kind: Kind,
    name: String,
    outcome: Outcome,
}

#[derive(Debug, Default, Eq, PartialEq)]
struct Tally {
    bytes: u64,
    files: u64,
}

impl Tally {
    fn add(&mut self, bytes: u64) {
        self.bytes += bytes;
        self.files += 1;
    }
}

#[derive(Debug, Default)]
struct Report {
    entries: Vec<Entry>,
    ignored: Vec<String>,
    kept: Tally,
    unused: Tally,
}

fn age(metadata: &Metadata, now: SystemTime) -> io::Result<Duration> {
    let used = metadata.accessed()?.max(metadata.modified()?);
    Ok(now.duration_since(used).unwrap_or_default())
}

fn exclusive(root: &Path) -> Result<File, String> {
    let (lock, path) = store::lock(root)?;
    match lock.try_lock() {
        Ok(()) => Ok(lock),
        Err(TryLockError::WouldBlock) => Err(format!(
            "an image build is using the layer cache {}: nothing was removed",
            root.display()
        )),
        Err(TryLockError::Error(error)) => Err(failed(&path, &error)),
    }
}

fn free(part: &File, partial: &Path) -> Result<bool, String> {
    match part.try_lock() {
        Ok(()) => Ok(true),
        Err(TryLockError::WouldBlock) => Ok(false),
        Err(TryLockError::Error(error)) => Err(failed(partial, &error)),
    }
}

fn discard(path: &Path, limit: Duration) -> Result<Outcome, String> {
    let recent = fs::symlink_metadata(path)
        .and_then(|metadata| age(&metadata, SystemTime::now()))
        .map_err(|error| failed(path, &error))?;
    if recent < limit {
        return Ok(Outcome::Kept);
    }
    fs::remove_file(path).map_err(|error| failed(path, &error))?;
    Ok(Outcome::Removed)
}

fn blob(path: &Path, limit: Duration) -> Result<Outcome, String> {
    let partial = path.with_extension(PARTIAL);
    let created = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&partial);
    let (part, ours) = match created {
        Ok(part) => (part, true),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (
            File::open(&partial).map_err(|error| failed(&partial, &error))?,
            false,
        ),
        Err(error) => return Err(failed(&partial, &error)),
    };
    if !free(&part, &partial)? {
        return Ok(Outcome::Kept);
    }
    let outcome = discard(path, limit);
    if ours {
        let held = part.metadata().map_err(|error| failed(&partial, &error))?;
        if fs::metadata(&partial).is_ok_and(|named| named.ino() == held.ino()) {
            fs::remove_file(&partial).map_err(|error| failed(&partial, &error))?;
        }
    }
    outcome
}

fn remove(path: &Path, kind: Kind, limit: Duration) -> Result<Outcome, String> {
    match kind {
        Kind::Blob => blob(path, limit),
        Kind::Partial => {
            let part = File::open(path).map_err(|error| failed(path, &error))?;
            if free(&part, path)? {
                discard(path, limit)
            } else {
                Ok(Outcome::Kept)
            }
        }
        Kind::Temporary => discard(path, limit),
    }
}

fn prune(root: &Path, days: u32, remove_unused: bool) -> Result<Report, String> {
    let limit = DAY * days;
    let blobs = store::blobs(root);
    let mut report = Report::default();
    if !blobs.is_dir() {
        return Ok(report);
    }
    let _held = remove_unused.then(|| exclusive(root)).transpose()?;
    let mut names = fs::read_dir(&blobs)
        .and_then(|entries| {
            entries
                .map(|entry| entry.map(|entry| entry.file_name()))
                .collect::<io::Result<Vec<_>>>()
        })
        .map_err(|error| failed(&blobs, &error))?;
    names.sort();
    let now = SystemTime::now();
    for name in names {
        let path = blobs.join(&name);
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(failed(&path, &error)),
        };
        let name = name.to_string_lossy().into_owned();
        let Some(kind) = Kind::of(&name).filter(|_| metadata.is_file()) else {
            report.ignored.push(name);
            continue;
        };
        let age = age(&metadata, now).map_err(|error| failed(&path, &error))?;
        if age < limit {
            report.kept.add(metadata.len());
            continue;
        }
        let outcome = if remove_unused {
            remove(&path, kind, limit)?
        } else {
            Outcome::Unused
        };
        match outcome {
            Outcome::Kept => report.kept.add(metadata.len()),
            Outcome::Removed | Outcome::Unused => report.unused.add(metadata.len()),
        }
        report.entries.push(Entry {
            age,
            bytes: metadata.len(),
            kind,
            name,
            outcome,
        });
    }
    Ok(report)
}

pub(crate) fn command(arguments: impl Iterator<Item = OsString>) -> Result<u8, String> {
    let (flags, rest): (Vec<_>, Vec<_>) = arguments.partition(|argument| argument == REMOVE);
    let arguments = Arguments::mixed(rest.into_iter(), &["cache", "days"])?;
    if !arguments.rest.is_empty() {
        return Err(USAGE.to_owned());
    }
    let root = absolute(arguments.one("cache")?)?;
    let remove_unused = !flags.is_empty();
    let report = prune(&root, arguments.number("days")?, remove_unused)?;
    for name in &report.ignored {
        println!("ignored {name}");
    }
    for entry in &report.entries {
        println!(
            "{} {} {} {} bytes {:.1} days",
            entry.outcome.label(),
            entry.kind.label(),
            entry.name,
            entry.bytes,
            entry.age.div_duration_f64(DAY)
        );
    }
    println!(
        "total: {} {}, {} bytes; {} kept, {} bytes",
        report.unused.files,
        if remove_unused {
            Outcome::Removed.label()
        } else {
            Outcome::Unused.label()
        },
        report.unused.bytes,
        report.kept.files,
        report.kept.bytes
    );
    Ok(0)
}

#[cfg(test)]
mod tests {
    use std::{env, fs::FileTimes, path::PathBuf, process};

    use super::*;
    use crate::image::{
        Scratch, oci::Descriptor, reference::Reference, registry::Registry, store::Store,
    };

    const OLD: u32 = 30;
    const WEEK: u32 = 7;

    fn lab(name: &str) -> Scratch {
        Scratch::create(
            env::temp_dir().join(format!("nanoeval-krun-prune-{name}-{}", process::id())),
        )
        .unwrap()
    }

    fn digest(seed: u8) -> String {
        format!("{seed:064x}")
    }

    fn place(root: &Path, name: &str, days: u32) -> PathBuf {
        let blobs = store::blobs(root);
        fs::create_dir_all(&blobs).unwrap();
        let path = blobs.join(name);
        fs::write(&path, name).unwrap();
        let then = SystemTime::now() - DAY * days;
        File::open(&path)
            .unwrap()
            .set_times(FileTimes::new().set_accessed(then).set_modified(then))
            .unwrap();
        path
    }

    fn names(root: &Path) -> Vec<String> {
        let mut names = fs::read_dir(store::blobs(root))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect::<Vec<_>>();
        names.sort();
        names
    }

    fn listed(report: &Report) -> Vec<(&str, Kind, Outcome)> {
        report
            .entries
            .iter()
            .map(|entry| (entry.name.as_str(), entry.kind, entry.outcome))
            .collect()
    }

    #[test]
    fn a_blob_unused_for_the_days_is_listed_and_removed_only_when_asked() {
        let lab = lab("unused");
        let old = place(&lab.0, &digest(1), OLD);
        let fresh = place(&lab.0, &digest(2), 0);
        let before = fs::metadata(&old).unwrap();

        let report = prune(&lab.0, WEEK, false).unwrap();
        assert_eq!(
            listed(&report),
            [(digest(1).as_str(), Kind::Blob, Outcome::Unused)]
        );
        assert_eq!(report.entries[0].bytes, before.len());
        assert!(report.entries[0].age >= DAY * OLD);
        assert_eq!(
            report.unused,
            Tally {
                bytes: before.len(),
                files: 1
            }
        );
        assert_eq!(
            report.kept,
            Tally {
                bytes: fs::metadata(&fresh).unwrap().len(),
                files: 1
            }
        );
        assert_eq!(names(&lab.0), [digest(1), digest(2)]);
        assert!(!lab.0.join("lock").exists());
        let after = fs::metadata(&old).unwrap();
        assert_eq!(after.accessed().unwrap(), before.accessed().unwrap());
        assert_eq!(after.modified().unwrap(), before.modified().unwrap());

        assert_eq!(prune(&lab.0, 0, false).unwrap().entries.len(), 2);
        assert!(prune(&lab.0, OLD + 1, false).unwrap().entries.is_empty());

        let report = prune(&lab.0, WEEK, true).unwrap();
        assert_eq!(
            listed(&report),
            [(digest(1).as_str(), Kind::Blob, Outcome::Removed)]
        );
        assert_eq!(names(&lab.0), [digest(2)]);
        assert!(prune(&lab.0, WEEK, true).unwrap().entries.is_empty());
    }

    #[test]
    fn a_blob_the_store_served_counts_as_used() {
        let lab = lab("served");
        let layer = place(&lab.0, &digest(1), OLD);
        let manifest = place(&lab.0, &digest(2), OLD);
        place(&lab.0, &digest(3), OLD);
        let written = fs::metadata(&layer).unwrap().modified().unwrap();
        {
            let store = Store::open(&lab.0).unwrap();
            let registry = Registry::new().unwrap();
            let reference = Reference::parse("alpine:3.21").unwrap();
            let descriptor = Descriptor {
                digest: format!("sha256:{}", digest(1)),
                media_type: String::new(),
                platform: None,
                size: 0,
            };
            assert_eq!(
                store.fetch(&registry, &reference, &descriptor).unwrap(),
                layer
            );
            assert_eq!(
                store
                    .document(&registry, &reference, &format!("sha256:{}", digest(2)))
                    .unwrap(),
                digest(2).into_bytes()
            );
        }
        assert_eq!(fs::metadata(&layer).unwrap().modified().unwrap(), written);

        let report = prune(&lab.0, WEEK, true).unwrap();
        assert_eq!(
            listed(&report),
            [(digest(3).as_str(), Kind::Blob, Outcome::Removed)]
        );
        assert_eq!(report.kept.files, 2);
        assert!(layer.is_file() && manifest.is_file());
    }

    #[test]
    fn a_build_that_holds_the_cache_refuses_a_removal() {
        let lab = lab("held");
        let old = place(&lab.0, &digest(1), OLD);
        let store = Store::open(&lab.0).unwrap();
        let refused = prune(&lab.0, WEEK, true).unwrap_err();
        assert!(refused.contains("an image build is using the layer cache"));
        assert!(old.is_file());
        assert_eq!(prune(&lab.0, WEEK, false).unwrap().entries.len(), 1);
        let second = Store::open(&lab.0).unwrap();
        drop(store);
        assert!(prune(&lab.0, WEEK, true).is_err());
        drop(second);
        assert_eq!(
            listed(&prune(&lab.0, WEEK, true).unwrap()),
            [(digest(1).as_str(), Kind::Blob, Outcome::Removed)]
        );
    }

    #[test]
    fn a_download_in_progress_is_kept_and_old_leftovers_are_removed() {
        let lab = lab("leftovers");
        let downloading = format!("{}.{PARTIAL}", digest(1));
        let abandoned = format!("{}.{PARTIAL}", digest(2));
        let recent = format!("{}.{PARTIAL}", digest(3));
        let temporary = format!("{}.4242.{TEMPORARY}", digest(4));
        let held = File::open(place(&lab.0, &downloading, OLD)).unwrap();
        held.lock().unwrap();
        place(&lab.0, &abandoned, OLD);
        place(&lab.0, &recent, 0);
        place(&lab.0, &temporary, OLD);
        place(&lab.0, "notes.txt", OLD);
        fs::create_dir(store::blobs(&lab.0).join(digest(5))).unwrap();

        let report = prune(&lab.0, WEEK, true).unwrap();
        assert_eq!(
            listed(&report),
            [
                (downloading.as_str(), Kind::Partial, Outcome::Kept),
                (abandoned.as_str(), Kind::Partial, Outcome::Removed),
                (temporary.as_str(), Kind::Temporary, Outcome::Removed),
            ]
        );
        assert_eq!(report.ignored, [digest(5), "notes.txt".to_owned()]);
        assert_eq!(report.kept.files, 2);
        assert_eq!(report.unused.files, 2);
        assert_eq!(
            names(&lab.0),
            [
                downloading.clone(),
                recent,
                digest(5),
                "notes.txt".to_owned()
            ]
        );
        drop(held);
        assert_eq!(
            listed(&prune(&lab.0, WEEK, true).unwrap()),
            [(downloading.as_str(), Kind::Partial, Outcome::Removed)]
        );
    }

    #[test]
    fn a_blob_used_after_it_was_listed_is_kept() {
        let lab = lab("recheck");
        let path = place(&lab.0, &digest(1), OLD);
        File::open(&path)
            .unwrap()
            .set_times(FileTimes::new().set_accessed(SystemTime::now()))
            .unwrap();
        assert_eq!(
            remove(&path, Kind::Blob, DAY * WEEK).unwrap(),
            Outcome::Kept
        );
        assert_eq!(names(&lab.0), [digest(1)]);
    }

    #[test]
    fn a_cache_that_was_never_written_has_nothing_to_prune() {
        let lab = lab("empty");
        let report = prune(&lab.0.join("absent"), 0, true).unwrap();
        assert!(report.entries.is_empty());
        assert!(!lab.0.join("absent").exists());
    }
}
