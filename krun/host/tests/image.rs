use std::{
    collections::BTreeMap,
    env, fs,
    fs::{OpenOptions, Permissions},
    io::Write,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
};

use flate2::{Compression, write::GzEncoder};
use sha2::{Digest, Sha256};
use tar::{Builder, EntryType, Header};

const HEX: &[u8; 16] = b"0123456789abcdef";
const KRUN: &str = env!("CARGO_BIN_EXE_nanoeval-krun");
const SIZE_MB: &str = "64";

type Tree = BTreeMap<String, Vec<String>>;

fn missing() -> Option<String> {
    if OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/kvm")
        .is_err()
    {
        return Some("read and write access to /dev/kvm".to_owned());
    }
    let check = Command::new(KRUN).arg("check").output().unwrap();
    (!check.status.success()).then(|| {
        format!(
            "a machine libkrun starts guests on: {}",
            String::from_utf8_lossy(&check.stderr).trim()
        )
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .flat_map(|byte| [byte >> 4, byte & 0xf])
        .map(|nibble| char::from(HEX[usize::from(nibble)]))
        .collect()
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{}", hex(&Sha256::digest(bytes)))
}

fn guest() -> Vec<u8> {
    let target = format!("{}-unknown-linux-musl", env::consts::ARCH);
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let built = Command::new(env!("CARGO"))
        .current_dir(workspace)
        .args(["build", "--release", "--locked"])
        .args(["-p", "nanoeval-krun-guest", "--target", &target])
        .status()
        .unwrap();
    assert!(built.success(), "the guest binary did not build");
    let directory =
        env::var_os("CARGO_TARGET_DIR").map_or_else(|| workspace.join("target"), PathBuf::from);
    fs::read(
        directory
            .join(target)
            .join("release")
            .join("nanoeval-krun-guest"),
    )
    .unwrap()
}

struct Entry<'a> {
    content: &'a [u8],
    kind: EntryType,
    link: &'a str,
    mode: u32,
    mtime: u64,
    owner: (u64, u64),
    path: &'a str,
    xattr: Option<(&'a str, &'a [u8])>,
}

impl<'a> Entry<'a> {
    fn new(path: &'a str, kind: EntryType) -> Self {
        Self {
            content: b"",
            kind,
            link: "",
            mode: if kind == EntryType::Directory {
                0o755
            } else {
                0o644
            },
            mtime: 1_000_000_000,
            owner: (0, 0),
            path,
            xattr: None,
        }
    }

    fn directory(path: &'a str) -> Self {
        Self::new(path, EntryType::Directory)
    }

    fn file(path: &'a str, content: &'a [u8]) -> Self {
        Self {
            content,
            ..Self::new(path, EntryType::Regular)
        }
    }
}

fn layer(entries: &[Entry<'_>]) -> Vec<u8> {
    let mut builder = Builder::new(Vec::new());
    for entry in entries {
        if let Some((name, value)) = entry.xattr {
            builder
                .append_pax_extensions([(format!("SCHILY.xattr.{name}").as_str(), value)])
                .unwrap();
        }
        let mut header = Header::new_ustar();
        header.set_entry_type(entry.kind);
        header.set_mode(entry.mode);
        header.set_mtime(entry.mtime);
        header.set_uid(entry.owner.0);
        header.set_gid(entry.owner.1);
        header.set_size(entry.content.len() as u64);
        if entry.kind == EntryType::Char {
            header.set_device_major(1).unwrap();
            header.set_device_minor(3).unwrap();
        }
        if entry.link.is_empty() {
            builder
                .append_data(&mut header, entry.path, entry.content)
                .unwrap();
        } else {
            builder
                .append_link(&mut header, entry.path, entry.link)
                .unwrap();
        }
    }
    builder.into_inner().unwrap()
}

fn lower(guest: &[u8]) -> Vec<u8> {
    layer(&[
        Entry::directory("bin/"),
        Entry {
            mode: 0o755,
            ..Entry::file("bin/guest", guest)
        },
        Entry {
            mode: 0o750,
            owner: (1000, 2000),
            ..Entry::directory("data/")
        },
        Entry {
            mtime: 1_000_000_001,
            owner: (1000, 2000),
            ..Entry::file("data/keep.txt", b"keep")
        },
        Entry::file("data/gone.txt", b"gone"),
        Entry::directory("data/old/"),
        Entry::file("data/old/a.txt", b"a"),
        Entry {
            link: "data/keep.txt",
            ..Entry::new("data/hard.txt", EntryType::Link)
        },
        Entry {
            link: "keep.txt",
            mode: 0o777,
            ..Entry::new("data/link", EntryType::Symlink)
        },
        Entry {
            mode: 0o600,
            ..Entry::new("data/pipe", EntryType::Fifo)
        },
        Entry {
            mode: 0o666,
            ..Entry::new("data/null", EntryType::Char)
        },
        Entry {
            mode: 0o4755,
            owner: (1000, 0),
            ..Entry::file("data/suid", b"s")
        },
        Entry {
            xattr: Some(("user.note", b"hello")),
            ..Entry::file("data/noted", b"n")
        },
        Entry::directory("opaque/"),
        Entry::file("opaque/lower.txt", b"lower"),
        Entry::file("replaced", b"a file"),
        Entry::directory("swapped/"),
        Entry::file("swapped/inside.txt", b"inside"),
    ])
}

fn upper() -> Vec<u8> {
    layer(&[
        Entry {
            mode: 0o750,
            mtime: 1_100_000_000,
            owner: (1000, 2000),
            ..Entry::directory("data/")
        },
        Entry::file("data/.wh.gone.txt", b""),
        Entry::file("data/.wh.old", b""),
        Entry::directory("opaque/"),
        Entry::file("opaque/upper.txt", b"upper"),
        Entry::file("opaque/.wh..wh..opq", b""),
        Entry::directory("replaced/"),
        Entry::file("replaced/inside.txt", b"inside"),
        Entry::file("swapped", b"a file"),
    ])
}

struct Lab {
    cache: PathBuf,
    home: PathBuf,
}

impl Lab {
    fn new(name: &str, guest: &[u8]) -> Self {
        let home = env::temp_dir().join(format!("nanoeval-krun-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        let boot = home.join("boot");
        for directory in ["dev", "mnt", "proc", "sys"] {
            fs::create_dir_all(boot.join(directory)).unwrap();
        }
        let program = boot.join("nanoeval-krun-guest");
        fs::write(&program, guest).unwrap();
        fs::set_permissions(&program, Permissions::from_mode(0o755)).unwrap();
        let cache = home.join("cache");
        fs::create_dir_all(cache.join("blobs/sha256")).unwrap();
        Self { cache, home }
    }

    fn blob(&self, bytes: &[u8]) -> String {
        let digest = digest(bytes);
        fs::write(self.cache.join("blobs/sha256").join(&digest[7..]), bytes).unwrap();
        digest
    }

    fn image(&self, guest: &[u8]) -> String {
        let lower = lower(guest);
        let upper = upper();
        let last = layer(&[
            Entry::directory("etc/"),
            Entry::file("etc/hosts", b"stale\n"),
        ]);
        let mut gzip = GzEncoder::new(Vec::new(), Compression::default());
        gzip.write_all(&lower).unwrap();
        let gzip = gzip.finish().unwrap();
        let zstd = zstd::encode_all(upper.as_slice(), 3).unwrap();
        let architecture = match env::consts::ARCH {
            "aarch64" => "arm64",
            _ => "amd64",
        };
        let config = serde_json::json!({
            "architecture": architecture,
            "config": {
                "Cmd": ["/bin/guest", "oom-kills"],
                "Env": ["PATH=/bin", "GREETING=hello"],
                "User": "1000:2000",
                "WorkingDir": "/data",
            },
            "os": "linux",
            "rootfs": {
                "diff_ids": [digest(&lower), digest(&upper), digest(&last)],
                "type": "layers",
            },
        });
        let config = serde_json::to_vec(&config).unwrap();
        let described = |media: &str, bytes: &[u8]| {
            serde_json::json!({
                "digest": self.blob(bytes),
                "mediaType": media,
                "size": bytes.len(),
            })
        };
        let manifest = serde_json::json!({
            "config": described("application/vnd.oci.image.config.v1+json", &config),
            "layers": [
                described("application/vnd.oci.image.layer.v1.tar+gzip", &gzip),
                described("application/vnd.oci.image.layer.v1.tar+zstd", &zstd),
                described("application/vnd.oci.image.layer.v1.tar", &last),
            ],
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "schemaVersion": 2,
        });
        let manifest = self.blob(&serde_json::to_vec(&manifest).unwrap());
        format!("registry.invalid/synthetic@{manifest}")
    }

    fn krun(&self, arguments: &[&str]) -> Output {
        Command::new(KRUN)
            .current_dir(&self.home)
            .args(arguments)
            .output()
            .unwrap()
    }

    fn json(&self, arguments: &[&str]) -> serde_json::Value {
        let output = self.krun(arguments);
        assert!(
            output.status.success(),
            "{arguments:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }

    fn build(&self, source: &[&str]) -> Output {
        let mut arguments = vec!["image", "build"];
        arguments.extend(source);
        arguments.extend(["--size-mb", SIZE_MB, "--out", "disk.ext4"]);
        arguments.extend(["--meta", "meta.json", "--boot", "boot", "--cache", "cache"]);
        self.krun(&arguments)
    }

    fn built(&self, source: &[&str]) -> (serde_json::Value, serde_json::Value) {
        let output = self.build(source);
        assert!(
            output.status.success(),
            "{source:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let meta = fs::read(self.home.join("meta.json")).unwrap();
        (
            serde_json::from_slice(&output.stdout).unwrap(),
            serde_json::from_slice(&meta).unwrap(),
        )
    }

    fn tree(&self, disk: &str) -> Tree {
        let output = self.krun(&["image", "tree", disk, "--boot", "boot"]);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .unwrap()
            .lines()
            .map(|line| {
                let mut fields = line.split('\t').map(str::to_owned);
                (fields.next().unwrap(), fields.collect())
            })
            .collect()
    }

    fn start(&self, disk: &str) -> Child {
        let upper = self.home.join("upper.ext4");
        fs::File::create(&upper)
            .unwrap()
            .set_len(64 * 1024 * 1024)
            .unwrap();
        let path = format!("{}:/usr/sbin:/sbin", env::var("PATH").unwrap());
        let formatted = Command::new("mke2fs")
            .env("PATH", path)
            .args(["-q", "-t", "ext4", "-O", "^has_journal"])
            .args(["-E", "root_owner=0:0"])
            .arg(&upper)
            .status()
            .unwrap();
        assert!(formatted.success());
        let log = fs::File::create(self.home.join("vm.log")).unwrap();
        let machine = Command::new(KRUN)
            .current_dir(&self.home)
            .args(["vm", "--boot", "boot", "--lower", disk])
            .args(["--upper", "upper.ext4", "--socket", "vm.sock"])
            .args(["--cpus", "1", "--memory-mib", "256"])
            .stdin(Stdio::null())
            .stdout(log.try_clone().unwrap())
            .stderr(log)
            .spawn()
            .unwrap();
        let process = machine.id().to_string();
        let ready = self.krun(&[
            "ready", "--log", "vm.log", "--pid", &process, "--socket", "vm.sock",
        ]);
        assert!(
            ready.status.success(),
            "{}",
            String::from_utf8_lossy(&ready.stderr)
        );
        machine
    }
}

impl Drop for Lab {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.home);
    }
}

fn row(tree: &Tree, path: &str) -> Vec<String> {
    tree.get(path)
        .unwrap_or_else(|| panic!("{path} is missing"))
        .clone()
}

fn layers_are_applied(tree: &Tree) {
    for gone in [
        "data/gone.txt",
        "data/old",
        "data/old/a.txt",
        "lost+found",
        "opaque/lower.txt",
        "swapped/inside.txt",
    ] {
        assert!(!tree.contains_key(gone), "{gone} is still there");
    }
    let keep = hex(&Sha256::digest(b"keep"));
    assert_eq!(
        row(tree, "data")[..6],
        ["d", "0750", "1000", "2000", "0", "1100000000"]
    );
    assert_eq!(
        row(tree, "data/keep.txt"),
        [
            "f",
            "0644",
            "1000",
            "2000",
            "4",
            "1000000001",
            keep.as_str(),
            "data/hard.txt",
            "-"
        ]
    );
    assert_eq!(row(tree, "data/hard.txt")[6..8], [keep.as_str(), "-"]);
    assert_eq!(row(tree, "data/link")[..1], ["l"]);
    assert_eq!(row(tree, "data/link")[7], "keep.txt");
    assert_eq!(row(tree, "data/pipe")[..2], ["p", "0600"]);
    assert_eq!(row(tree, "data/null")[..5], ["c", "0666", "0", "0", "1:3"]);
    assert_eq!(row(tree, "data/suid")[..3], ["f", "4755", "1000"]);
    assert_eq!(row(tree, "data/noted")[8], "user.note=68656c6c6f");
    assert_eq!(row(tree, "opaque/upper.txt")[0], "f");
    assert_eq!(row(tree, "replaced")[0], "d");
    assert_eq!(row(tree, "replaced/inside.txt")[0], "f");
    assert_eq!(row(tree, "swapped")[0], "f");
}

fn a_packed_disk_is_restored(lab: &Lab) {
    let packed = lab.json(&["image", "pack", "disk.ext4", "--out", "disk.pack"]);
    let sha256 = packed["sha256"].as_str().unwrap();
    assert!(packed["bytes"].as_u64().unwrap() < packed["data_bytes"].as_u64().unwrap());
    let restored = lab.json(&[
        "image",
        "unpack",
        "disk.pack",
        "--out",
        "restored.ext4",
        "--sha256",
        sha256,
    ]);
    assert_eq!(restored["sha256"], packed["sha256"]);
    assert_eq!(
        fs::read(lab.home.join("disk.ext4")).unwrap(),
        fs::read(lab.home.join("restored.ext4")).unwrap()
    );
    assert_eq!(
        lab.json(&["image", "pack", "restored.ext4", "--out", "again.pack"])["sha256"],
        packed["sha256"]
    );
    let racers = [(); 2].map(|()| {
        Command::new(KRUN)
            .current_dir(&lab.home)
            .args(["image", "unpack", "disk.pack", "--out", "raced.ext4"])
            .stdout(Stdio::null())
            .spawn()
            .unwrap()
    });
    for mut racer in racers {
        assert!(racer.wait().unwrap().success());
    }
    assert_eq!(
        fs::read(lab.home.join("disk.ext4")).unwrap(),
        fs::read(lab.home.join("raced.ext4")).unwrap()
    );
    for left in ["raced.ext4.tmp", "raced.ext4.lock"] {
        assert!(!lab.home.join(left).exists(), "{left} is still there");
    }
    let zeros = "0".repeat(64);
    let refused = lab.krun(&[
        "image",
        "unpack",
        "disk.pack",
        "--out",
        "wrong.ext4",
        "--sha256",
        &zeros,
    ]);
    assert_eq!(refused.status.code(), Some(125));
    assert!(!lab.home.join("wrong.ext4").exists());
    let mut damaged = fs::read(lab.home.join("disk.pack")).unwrap();
    let middle = damaged.len() / 2;
    damaged[middle] ^= 0xff;
    fs::write(lab.home.join("damaged.pack"), damaged).unwrap();
    let refused = lab.krun(&["image", "unpack", "damaged.pack", "--out", "damaged.ext4"]);
    assert_eq!(refused.status.code(), Some(125));
    assert!(!lab.home.join("damaged.ext4").exists());
}

#[test]
fn an_image_becomes_a_disk_that_boots() {
    if let Some(reason) = missing() {
        eprintln!("skipped: it needs {reason}");
        return;
    }
    let guest = guest();
    let lab = Lab::new("image", &guest);
    let reference = lab.image(&guest);
    let (first, meta) = lab.built(&["--ref", &reference]);
    assert_eq!(
        first["image_digest"].as_str(),
        reference.split_once('@').map(|(_, digest)| digest)
    );
    assert!(first["bytes_allocated"].as_u64().unwrap() > guest.len() as u64);
    assert_eq!(
        meta["config"],
        serde_json::json!({
            "architecture": meta["config"]["architecture"],
            "cmd": ["/bin/guest", "oom-kills"],
            "entrypoint": null,
            "env": ["PATH=/bin", "GREETING=hello"],
            "os": "linux",
            "user": "1000:2000",
            "working_dir": "/data",
        })
    );
    assert_eq!(meta["images"][0]["layers"].as_array().unwrap().len(), 3);
    layers_are_applied(&lab.tree("disk.ext4"));

    let modified = || {
        fs::metadata(lab.home.join("disk.ext4"))
            .unwrap()
            .modified()
            .unwrap()
    };
    let before = modified();
    let (again, _) = lab.built(&["--ref", &reference]);
    assert_eq!(again["image_digest"], first["image_digest"]);
    assert_eq!(modified(), before);

    a_packed_disk_is_restored(&lab);

    let mut machine = lab.start("restored.ext4");
    let ran = lab.krun(&[
        "exec",
        "--socket",
        "vm.sock",
        "--cwd",
        "/data",
        "--",
        "/bin/guest",
        "oom-kills",
    ]);
    assert_eq!(String::from_utf8_lossy(&ran.stdout), "0\n");
    assert_eq!(ran.status.code(), Some(0));
    assert!(lab.krun(&["stop", "--socket", "vm.sock"]).status.success());
    assert!(machine.wait().unwrap().success());
}

fn a_broken_dockerfile_is_refused(lab: &Lab, reference: &str) {
    let source = ["--dockerfile", "context", "--network", "host"];
    let file = lab.home.join("context/Dockerfile");
    fs::write(
        &file,
        format!("FROM {reference}\n\nRUN --mount=type=cache,target=/x [\"/bin/guest\"]\n"),
    )
    .unwrap();
    let refused = lab.build(&source);
    assert_eq!(refused.status.code(), Some(125));
    assert_eq!(
        String::from_utf8_lossy(&refused.stderr).trim(),
        "nanoeval-krun: line 3: RUN --mount is not supported"
    );
    fs::write(&file, format!("FROM {reference}\nRUN [\"/bin/missing\"]\n")).unwrap();
    let failed = lab.build(&source);
    assert_eq!(failed.status.code(), Some(125));
    assert!(
        String::from_utf8_lossy(&failed.stderr).contains("line 2: /bin/missing:"),
        "{}",
        String::from_utf8_lossy(&failed.stderr)
    );
    assert!(lab.home.join("disk.ext4").exists());
    assert!(!lab.home.join("disk.ext4.tmp").exists());
    assert!(!lab.home.join("disk.ext4.lock").exists());
}

#[test]
fn a_dockerfile_builds_on_an_image_without_a_shell() {
    if let Some(reason) = missing() {
        eprintln!("skipped: it needs {reason}");
        return;
    }
    let guest = guest();
    let lab = Lab::new("dockerfile", &guest);
    let reference = lab.image(&guest);
    let context = lab.home.join("context");
    fs::create_dir_all(context.join("tree/sub")).unwrap();
    for (file, mode) in [("note.txt", 0o644), ("tree/sub/deep.txt", 0o600)] {
        fs::write(context.join(file), "a note\n").unwrap();
        fs::set_permissions(context.join(file), Permissions::from_mode(mode)).unwrap();
    }
    fs::write(
        context.join("Dockerfile"),
        format!(
            "ARG BASE={reference}\nFROM $BASE AS base\nRUN [\"/bin/guest\", \"oom-kills\"]\n\nFROM $BASE\nARG SUFFIX=sub\nENV NAME=value WORK=/work/$SUFFIX\nWORKDIR $WORK\nCOPY note.txt ./\nCOPY note.txt tree /copied/\nCOPY --from=base /data/keep.txt /from-stage/\nRUN [\"/bin/guest\", \"oom-kills\"]\nUSER 1000\nWORKDIR mine\nENTRYPOINT [\"/bin/guest\"]\nEXPOSE 8080\n"
        ),
    )
    .unwrap();
    let (first, meta) = lab.built(&["--dockerfile", "context", "--network", "host"]);
    assert_eq!(meta["image_digest"], first["image_digest"]);
    assert_eq!(
        meta["config"]["env"],
        serde_json::json!([
            "PATH=/bin",
            "GREETING=hello",
            "NAME=value",
            "WORK=/work/sub"
        ])
    );
    assert_eq!(meta["config"]["working_dir"], "/work/sub/mine");
    assert_eq!(meta["config"]["user"], "1000");
    assert_eq!(
        meta["config"]["entrypoint"],
        serde_json::json!(["/bin/guest"])
    );
    assert_eq!(meta["config"]["cmd"], serde_json::Value::Null);

    let tree = lab.tree("disk.ext4");
    assert_eq!(row(&tree, "work/sub")[..4], ["d", "0755", "1000", "2000"]);
    assert_eq!(row(&tree, "work/sub/mine")[..4], ["d", "0755", "1000", "0"]);
    assert_eq!(
        row(&tree, "work/sub/note.txt")[..5],
        ["f", "0644", "0", "0", "7"]
    );
    assert_eq!(row(&tree, "copied/note.txt")[0], "f");
    assert_eq!(
        row(&tree, "copied/sub/deep.txt")[..4],
        ["f", "0600", "0", "0"]
    );
    assert_eq!(
        row(&tree, "from-stage/keep.txt")[..5],
        ["f", "0644", "1000", "2000", "4"]
    );
    assert_eq!(row(&tree, "etc/hosts")[4], "6");
    assert!(!tree.contains_key("etc/resolv.conf"));
    assert!(!tree.contains_key("mnt"));

    a_broken_dockerfile_is_refused(&lab, &reference);
}
