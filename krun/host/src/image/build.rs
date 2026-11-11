use std::{
    collections::BTreeMap,
    env,
    ffi::OsString,
    fs::{self, File, Permissions},
    io::{self, BufReader, Read},
    net::SocketAddrV4,
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, PermissionsExt},
    },
    path::{Component, Path, PathBuf},
    process::Command,
    sync::{
        Mutex, PoisonError,
        atomic::{AtomicUsize, Ordering},
    },
    thread,
    time::Instant,
};

use flate2::read::MultiGzDecoder;
use net::forward;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use wire::Request;

use super::{
    Hashing, Lock, Scratch, absolute, allocated, beside,
    dockerfile::{self, Instruction, Step},
    failed, hex,
    machine::{Disks, Layout, Machine},
    oci::{self, Compression, Container, Descriptor, Document, ImageConfig, Platform},
    reference::Reference,
    registry::Registry,
    sha256,
    store::Store,
};
use crate::Arguments;

const ARCHIVE_MAGICS: [&[u8]; 4] = [b"\x1f\x8b", b"BZh", b"\xfd7zXZ\0", b"\x28\xb5\x2f\xfd"];
const CACHE: &str = "nanoeval";
const DEFAULT_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DISK_MODE: u32 = 0o444;
const DOCKERFILE: &str = "Dockerfile";
const DOWNLOADS: usize = 4;
const FORMATTER: &str = "mke2fs";
const FORMATTER_PATH: &str = "/usr/sbin:/sbin";
const IGNORE_FILES: [&str; 2] = [".dockerignore", "Dockerfile.dockerignore"];
const MEBIBYTE: u64 = 1024 * 1024;
const RESOLVER: &str = "/etc/resolv.conf";
const SCHEMA: &str = "nanoeval-environment-v1";
const SCRATCH: &str = "scratch";
const SHELL: [&str; 2] = ["/bin/sh", "-c"];
const TAR_MAGIC: &[u8] = b"ustar";
const TAR_MAGIC_OFFSET: usize = 257;
const TRUST_VARIABLES: [&str; 7] = [
    "CARGO_HTTP_CAINFO",
    "CURL_CA_BUNDLE",
    "GIT_SSL_CAINFO",
    "NODE_EXTRA_CA_CERTS",
    "PIP_CERT",
    "REQUESTS_CA_BUNDLE",
    "SSL_CERT_FILE",
];
const USAGE: &str = "usage: nanoeval-krun image build (--ref REF | --dockerfile DIR) --size-mb N --out DISK.ext4 --meta META.json [--cache DIR] [--platform OS/ARCH] [--network private|host] [--ca-bundle FILE] [--env-file FILE]... [--forward ADDRESS:PORT]... [--boot DIR] [--cpus N] [--memory-mib N]";

#[derive(Clone, Copy, Eq, PartialEq)]
enum Network {
    Host,
    Private,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Source {
    Dockerfile(String),
    Reference(String),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Layer {
    digest: String,
    media_type: String,
    size: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Pulled {
    config_digest: String,
    index_digest: Option<String>,
    layers: Vec<Layer>,
    manifest_digest: String,
    reference: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Config {
    architecture: String,
    cmd: Option<Vec<String>>,
    entrypoint: Option<Vec<String>>,
    env: Vec<String>,
    os: String,
    user: String,
    working_dir: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Applied {
    ca_bundle: bool,
    environment: Vec<String>,
    forwards: Vec<String>,
}

#[derive(Default)]
struct Policy {
    environment: Vec<Vec<u8>>,
    forwards: Vec<SocketAddrV4>,
    trust: Vec<u8>,
}

impl Policy {
    fn parse(arguments: &Arguments) -> Result<Self, String> {
        let read =
            |file: &OsString| fs::read(file).map_err(|error| failed(Path::new(file), &error));
        let trust = arguments.maybe("ca-bundle").map(read).transpose()?;
        if trust.as_ref().is_some_and(Vec::is_empty) {
            return Err("--ca-bundle names an empty file".to_owned());
        }
        let mut environment = Vec::new();
        for file in arguments.all("env-file") {
            environment.extend(variables(&read(file)?)?);
        }
        let forwards = arguments
            .all("forward")
            .into_iter()
            .map(|target| forward::target(target.as_bytes()).map_err(|error| error.to_string()))
            .collect::<Result<_, _>>()?;
        Ok(Self {
            environment,
            forwards,
            trust: trust.unwrap_or_default(),
        })
    }

    fn applied(&self, network: Network) -> Option<Applied> {
        let applied = Applied {
            ca_bundle: !self.trust.is_empty(),
            environment: self
                .environment
                .iter()
                .map(|entry| {
                    let name = entry.split(|byte| *byte == b'=').next().unwrap_or_default();
                    String::from_utf8_lossy(name).into_owned()
                })
                .collect(),
            forwards: self
                .reached(network)
                .iter()
                .map(SocketAddrV4::to_string)
                .collect(),
        };
        (applied.ca_bundle || !applied.environment.is_empty() || !applied.forwards.is_empty())
            .then_some(applied)
    }

    fn reached(&self, network: Network) -> &[SocketAddrV4] {
        match network {
            Network::Host => &[],
            Network::Private => &self.forwards,
        }
    }
}

fn variables(file: &[u8]) -> Result<Vec<Vec<u8>>, String> {
    file.split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty() && line[0] != b'#')
        .map(|line| {
            if line
                .iter()
                .position(|byte| *byte == b'=')
                .is_some_and(|at| at > 0)
            {
                Ok(line.to_vec())
            } else {
                Err(format!(
                    "a line of an environment file is NAME=VALUE: {}",
                    String::from_utf8_lossy(line)
                ))
            }
        })
        .collect()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Seconds {
    convert: f64,
    download: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Meta {
    bytes_allocated: u64,
    config: Config,
    image_digest: String,
    images: Vec<Pulled>,
    platform: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    policy: Option<Applied>,
    schema: String,
    seconds: Seconds,
    size_mb: u64,
    source: Source,
}

struct Job {
    layout: Layout,
    network: Network,
    platform: Platform,
    policy: Policy,
    registry: Registry,
    resolver: Vec<u8>,
    size_mb: u64,
    store: Store,
    work: PathBuf,
}

struct Image {
    config: ImageConfig,
    files: Vec<PathBuf>,
    layers: Vec<Descriptor>,
    record: Pulled,
    seconds: f64,
}

struct Built {
    config: Config,
    disk: PathBuf,
    image_digest: String,
    images: Vec<Pulled>,
    seconds: f64,
}

fn download(
    job: &Job,
    reference: &Reference,
    layers: &[Descriptor],
) -> Result<Vec<PathBuf>, String> {
    let next = AtomicUsize::new(0);
    let fetched = Mutex::new(BTreeMap::new());
    thread::scope(|scope| {
        for _ in 0..DOWNLOADS.min(layers.len()) {
            scope.spawn(|| {
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(layer) = layers.get(index) else {
                        break;
                    };
                    let file = job.store.fetch(&job.registry, reference, layer);
                    fetched
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .insert(index, file);
                }
            });
        }
    });
    fetched
        .into_inner()
        .unwrap_or_else(PoisonError::into_inner)
        .into_values()
        .collect()
}

fn pull(job: &Job, text: &str) -> Result<Image, String> {
    let started = Instant::now();
    let reference = Reference::parse(text)?;
    let top = job.registry.resolve(&reference)?;
    let fetch = |digest: &str| {
        job.store
            .document(&job.registry, &reference, digest)
            .and_then(|body| oci::document(&body))
    };
    let (index_digest, manifest_digest, manifest) = match fetch(&top)? {
        Document::Index(index) => {
            let entry = index
                .manifests
                .iter()
                .find(|entry| {
                    entry
                        .platform
                        .as_ref()
                        .is_some_and(|platform| platform.runs(&job.platform))
                })
                .ok_or_else(|| format!("{text} has no manifest for {}", job.platform))?;
            match fetch(&entry.digest)? {
                Document::Manifest(manifest) => (Some(top), entry.digest.clone(), manifest),
                Document::Index(_) => return Err(format!("{text} nests an index in its index")),
            }
        }
        Document::Manifest(manifest) => (None, top, manifest),
    };
    for layer in &manifest.layers {
        oci::compression(&layer.media_type)?;
    }
    let file = job
        .store
        .fetch(&job.registry, &reference, &manifest.config)?;
    let config: ImageConfig = fs::read(&file)
        .map_err(|error| failed(&file, &error))
        .and_then(|body| {
            serde_json::from_slice(&body)
                .map_err(|error| format!("the image config of {text} is not valid: {error}"))
        })?;
    let built = Platform {
        architecture: config.architecture.clone(),
        os: config.os.clone(),
        variant: config.variant.clone(),
    };
    if !built.runs(&job.platform) {
        return Err(format!("{text} is built for {built}, not {}", job.platform));
    }
    if config.rootfs.diff_ids.len() != manifest.layers.len() {
        return Err(format!(
            "{text} lists {} layers and {} layer contents",
            manifest.layers.len(),
            config.rootfs.diff_ids.len()
        ));
    }
    eprintln!(
        "nanoeval-krun: {text} is {manifest_digest}, {} layers, {} bytes",
        manifest.layers.len(),
        manifest.layers.iter().map(|layer| layer.size).sum::<u64>()
    );
    let files = download(job, &reference, &manifest.layers)?;
    Ok(Image {
        config,
        files,
        record: Pulled {
            config_digest: manifest.config.digest.clone(),
            index_digest,
            layers: manifest
                .layers
                .iter()
                .map(|layer| Layer {
                    digest: layer.digest.clone(),
                    media_type: layer.media_type.clone(),
                    size: layer.size,
                })
                .collect(),
            manifest_digest,
            reference: text.to_owned(),
        },
        layers: manifest.layers,
        seconds: started.elapsed().as_secs_f64(),
    })
}

fn format(disk: &Path, size_mb: u64, seed: &str) -> Result<(), String> {
    File::create(disk)
        .and_then(|file| file.set_len(size_mb * MEBIBYTE))
        .map_err(|error| failed(disk, &error))?;
    let seed = hex(&Sha256::digest(seed)[..16]);
    let uuid = format!(
        "{}-{}-{}-{}-{}",
        &seed[..8],
        &seed[8..12],
        &seed[12..16],
        &seed[16..20],
        &seed[20..]
    );
    let path = env::var("PATH").map_or_else(
        |_| FORMATTER_PATH.to_owned(),
        |path| format!("{path}:{FORMATTER_PATH}"),
    );
    let output = Command::new(FORMATTER)
        .env("PATH", path)
        .args(["-q", "-t", "ext4", "-O", "^has_journal", "-U", &uuid])
        .args(["-E", &format!("root_owner=0:0,hash_seed={uuid}")])
        .arg(disk)
        .output()
        .map_err(|error| format!("{FORMATTER}: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "{FORMATTER} ended with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn expect(machine: &Machine, request: &Request, what: &str) -> Result<(), String> {
    match machine.request(request, None, &mut io::sink())? {
        0 => Ok(()),
        code => Err(format!("{what} ended with {code}")),
    }
}

fn root() -> Vec<u8> {
    wire::BUILD_ROOT.as_bytes().to_vec()
}

fn apply(machine: &Machine, image: &Image) -> Result<(), String> {
    let count = image.layers.len();
    for (index, (layer, file)) in image.layers.iter().zip(&image.files).enumerate() {
        eprintln!(
            "nanoeval-krun: layer {}/{count} {} {} bytes",
            index + 1,
            layer.digest,
            layer.size
        );
        let source = BufReader::new(File::open(file).map_err(|error| failed(file, &error))?);
        let content: Box<dyn Read + Send> = match oci::compression(&layer.media_type)? {
            Compression::Gzip => Box::new(MultiGzDecoder::new(source)),
            Compression::None => Box::new(source),
            Compression::Zstd => Box::new(
                zstd::stream::read::Decoder::with_buffer(source)
                    .map_err(|error| failed(file, &error))?,
            ),
        };
        let mut content = Hashing::new(content);
        let code = machine
            .request(
                &Request::Apply { root: root() },
                Some(&mut content),
                &mut io::sink(),
            )
            .map_err(|message| format!("layer {}: {message}", layer.digest))?;
        if code != 0 {
            return Err(format!("layer {} ended with {code}", layer.digest));
        }
        let unpacked = format!("sha256:{}", content.digest());
        if unpacked != image.config.rootfs.diff_ids[index] {
            return Err(format!(
                "layer {} unpacks to {unpacked}, not to {}",
                layer.digest, image.config.rootfs.diff_ids[index]
            ));
        }
    }
    Ok(())
}

fn convert(job: &Job, image: &Image, disk: &Path, name: &str) -> Result<(), String> {
    format(disk, job.size_mb, &image.record.manifest_digest)?;
    let machine = Machine::start(
        &job.layout,
        &job.work.join(name),
        &Disks {
            build: Some(disk),
            ..Disks::default()
        },
    )?;
    apply(&machine, image)?;
    machine.stop()
}

fn reference(job: &Job, text: &str) -> Result<Built, String> {
    let image = pull(job, text)?;
    let disk = job.work.join("disk.ext4");
    convert(job, &image, &disk, "vm")?;
    let container = image.config.config.clone().unwrap_or_default();
    Ok(Built {
        config: Config {
            architecture: image.config.architecture.clone(),
            cmd: container.cmd,
            entrypoint: container.entrypoint,
            env: container.env.unwrap_or_default(),
            os: image.config.os.clone(),
            user: container.user.unwrap_or_default(),
            working_dir: container.working_dir.unwrap_or_default(),
        },
        disk,
        image_digest: image.record.manifest_digest.clone(),
        images: vec![image.record],
        seconds: image.seconds,
    })
}

struct Stage<'a> {
    first: usize,
    image: &'a str,
    last: usize,
    line: usize,
    name: Option<&'a str>,
}

struct Recipe<'a> {
    digest: &'a str,
    directory: &'a Path,
    globals: BTreeMap<String, String>,
    stages: Vec<Stage<'a>>,
    steps: &'a [Step],
}

struct Progress {
    disks: Vec<Option<PathBuf>>,
    images: Vec<Pulled>,
    seconds: f64,
}

struct State {
    arguments: BTreeMap<String, String>,
    cmd: Option<Vec<String>>,
    cmd_set: bool,
    entrypoint: Option<Vec<String>>,
    environment: Vec<(String, String)>,
    shell: Vec<String>,
    user: String,
    workdir: String,
}

impl State {
    fn new(container: Container) -> Self {
        Self {
            arguments: BTreeMap::new(),
            cmd: container.cmd,
            cmd_set: false,
            entrypoint: container.entrypoint,
            environment: container
                .env
                .unwrap_or_default()
                .iter()
                .map(|entry| {
                    let (name, value) = entry.split_once('=').unwrap_or((entry, ""));
                    (name.to_owned(), value.to_owned())
                })
                .collect(),
            shell: SHELL.map(str::to_owned).to_vec(),
            user: container.user.unwrap_or_default(),
            workdir: container.working_dir.unwrap_or_default(),
        }
    }

    fn directory(&self) -> &str {
        if self.workdir.is_empty() {
            "/"
        } else {
            &self.workdir
        }
    }

    fn words(&self, text: &str) -> Result<Vec<String>, String> {
        dockerfile::words(text, &|name| {
            self.environment
                .iter()
                .find(|(known, _)| known == name)
                .map(|(_, value)| value.clone())
                .or_else(|| self.arguments.get(name).cloned())
        })
    }

    fn word(&self, text: &str) -> Result<String, String> {
        match self.words(text)?.as_slice() {
            [word] => Ok(word.clone()),
            _ => Err(format!("one word was expected: {text}")),
        }
    }
}

fn locate(earlier: &[Stage<'_>], name: &str) -> Option<usize> {
    earlier
        .iter()
        .position(|stage| {
            stage
                .name
                .is_some_and(|known| known.eq_ignore_ascii_case(name))
        })
        .or_else(|| name.parse().ok().filter(|index| *index < earlier.len()))
}

fn join(base: &str, path: &str) -> String {
    let combined = if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("{base}/{path}")
    };
    let mut parts = Vec::new();
    for part in combined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            name => parts.push(name),
        }
    }
    format!("/{}", parts.join("/"))
}

fn declare(
    arguments: &mut BTreeMap<String, String>,
    words: Vec<String>,
    globals: &BTreeMap<String, String>,
) {
    for word in words {
        let (name, value) = match word.split_once('=') {
            Some((name, value)) => (name.to_owned(), Some(value.to_owned())),
            None => (word.clone(), globals.get(&word).cloned()),
        };
        if let Some(value) = value {
            arguments.insert(name, value);
        }
    }
}

fn archive(file: &Path) -> Result<bool, String> {
    let mut start = Vec::new();
    File::open(file)
        .and_then(|source| {
            source
                .take((TAR_MAGIC_OFFSET + TAR_MAGIC.len()) as u64)
                .read_to_end(&mut start)
        })
        .map_err(|error| failed(file, &error))?;
    Ok(ARCHIVE_MAGICS.iter().any(|magic| start.starts_with(magic))
        || start.get(TAR_MAGIC_OFFSET..) == Some(TAR_MAGIC))
}

fn local(directory: &Path, source: &str, add: bool) -> Result<(), String> {
    if add && (source.contains("://") || source.starts_with("git@")) {
        return Err(format!(
            "ADD of the remote source {source} is not supported"
        ));
    }
    let relative = Path::new(source.trim_start_matches('/'));
    if relative
        .components()
        .any(|component| component == Component::ParentDir)
    {
        return Err(format!("the source {source} leaves the build context"));
    }
    let path = directory.join(relative);
    let metadata = fs::metadata(&path).map_err(|error| format!("the source {source}: {error}"))?;
    if add && metadata.is_file() && archive(&path)? {
        return Err(format!(
            "ADD of the archive {source}, which Docker would unpack, is not supported"
        ));
    }
    Ok(())
}

fn copy(
    recipe: &Recipe<'_>,
    machine: &Machine,
    state: &State,
    step: &Step,
    sources: &[&str],
) -> Result<(), String> {
    let Instruction::Copy { add, from, paths } = &step.instruction else {
        return Ok(());
    };
    let mut words = state.words(paths)?;
    let destination = words
        .pop()
        .filter(|_| !words.is_empty())
        .ok_or("a copy takes sources and a destination")?;
    if let Some(source) = words.iter().find(|source| source.contains(['*', '?', '['])) {
        return Err(format!("the wildcard source {source} is not supported"));
    }
    let (origin, keep_owner) = match from {
        None => {
            for source in &words {
                local(recipe.directory, source, *add)?;
            }
            (wire::BUILD_CONTEXT.to_owned(), false)
        }
        Some(name) => {
            let index = sources
                .iter()
                .position(|source| source == name)
                .ok_or_else(|| format!("the source {name} was not prepared"))?;
            (format!("{}/{index}", wire::BUILD_SOURCE), true)
        }
    };
    let into = words.len() > 1
        || destination == "."
        || destination.ends_with('/')
        || destination.ends_with("/.");
    expect(
        machine,
        &Request::Install {
            from: origin.into_bytes(),
            into,
            keep_owner,
            root: root(),
            sources: words.into_iter().map(String::into_bytes).collect(),
            to: join(state.directory(), &destination).into_bytes(),
        },
        "the copy",
    )
}

fn environment(state: &State, policy: &Policy) -> Vec<Vec<u8>> {
    let mut environment = state.environment.clone();
    let known = |environment: &[(String, String)], name: &str| {
        environment.iter().any(|(known, _)| known == name)
    };
    for (name, value) in &state.arguments {
        if !known(&environment, name) {
            environment.push((name.clone(), value.clone()));
        }
    }
    if !known(&environment, "PATH") {
        environment.push(("PATH".to_owned(), DEFAULT_PATH.to_owned()));
    }
    if !policy.trust.is_empty() {
        let bundle = format!("{}/{}", wire::POLICY, wire::TRUST);
        environment.extend(TRUST_VARIABLES.map(|name| (name.to_owned(), bundle.clone())));
    }
    environment
        .iter()
        .map(|(name, value)| format!("{name}={value}").into_bytes())
        .chain(policy.environment.iter().cloned())
        .collect()
}

fn run(
    job: &Job,
    machine: &Machine,
    state: &State,
    command: &dockerfile::Command,
) -> Result<(), String> {
    let arguments = command.arguments(&state.shell);
    eprintln!("nanoeval-krun: RUN {}", arguments.join(" "));
    let request = Request::Run {
        arguments: arguments.into_iter().map(String::into_bytes).collect(),
        directory: state.directory().as_bytes().to_vec(),
        environment: environment(state, &job.policy),
        resolver: job.resolver.clone(),
        root: root(),
        trust: job.policy.trust.clone(),
        user: state.user.clone().into_bytes(),
    };
    match machine.request(&request, Some(&mut io::empty()), &mut io::stderr())? {
        0 => Ok(()),
        code => Err(format!("RUN ended with {code}")),
    }
}

fn execute(
    job: &Job,
    recipe: &Recipe<'_>,
    machine: &Machine,
    state: &mut State,
    step: &Step,
    sources: &[&str],
) -> Result<(), String> {
    match &step.instruction {
        Instruction::Arg(text) => {
            let words = state.words(text)?;
            declare(&mut state.arguments, words, &recipe.globals);
        }
        Instruction::Cmd(command) => {
            state.cmd = Some(command.arguments(&state.shell));
            state.cmd_set = true;
        }
        Instruction::Copy { .. } => copy(recipe, machine, state, step, sources)?,
        Instruction::Entrypoint(command) => {
            state.entrypoint = Some(command.arguments(&state.shell));
            if !state.cmd_set {
                state.cmd = None;
            }
        }
        Instruction::Env(text) => {
            let words = state.words(text)?;
            let pairs = match words.split_first() {
                Some((name, rest)) if !name.contains('=') && !rest.is_empty() => {
                    vec![(name.clone(), rest.join(" "))]
                }
                _ => words
                    .iter()
                    .map(|word| {
                        word.split_once('=')
                            .map(|(name, value)| (name.to_owned(), value.to_owned()))
                            .ok_or_else(|| format!("ENV {word} has no value"))
                    })
                    .collect::<Result<_, _>>()?,
            };
            for (name, value) in pairs {
                match state
                    .environment
                    .iter_mut()
                    .find(|(known, _)| *known == name)
                {
                    Some(entry) => entry.1 = value,
                    None => state.environment.push((name, value)),
                }
            }
        }
        Instruction::From { .. } | Instruction::Ignored => {}
        Instruction::Run(command) => run(job, machine, state, command)?,
        Instruction::Shell(shell) => state.shell.clone_from(shell),
        Instruction::User(text) => state.user = state.word(text)?,
        Instruction::Workdir(text) => {
            let path = join(state.directory(), &state.word(text)?);
            expect(
                machine,
                &Request::Mkdir {
                    path: path.clone().into_bytes(),
                    root: root(),
                    user: state.user.clone().into_bytes(),
                },
                "WORKDIR",
            )?;
            state.workdir = path;
        }
    }
    Ok(())
}

fn passt() -> Result<PathBuf, String> {
    env::var_os("PATH")
        .into_iter()
        .flat_map(|path| env::split_paths(&path).collect::<Vec<_>>())
        .map(|directory| directory.join("passt"))
        .find(|program| program.is_file())
        .ok_or_else(|| {
            "the private network of a build needs passt, which is not installed".to_owned()
        })
}

fn stage(
    job: &Job,
    recipe: &Recipe<'_>,
    index: usize,
    progress: &mut Progress,
) -> Result<State, String> {
    let plan = &recipe.stages[index];
    let steps = &recipe.steps[plan.first..plan.last];
    let at = |line: usize| move |message: String| format!("line {line}: {message}");
    let base = dockerfile::words(plan.image, &|name| recipe.globals.get(name).cloned())
        .map_err(at(plan.line))?;
    let [base] = base.as_slice() else {
        return Err(at(plan.line)("FROM takes one image".to_owned()));
    };
    if locate(&recipe.stages[..index], base).is_some() {
        return Err(at(plan.line)(format!(
            "FROM the earlier stage {base} is not supported"
        )));
    }
    let image = if base == SCRATCH {
        None
    } else {
        Some(pull(job, base).map_err(at(plan.line))?)
    };
    let mut names = Vec::new();
    let mut sources = Vec::new();
    for step in steps {
        let Instruction::Copy {
            from: Some(from), ..
        } = &step.instruction
        else {
            continue;
        };
        if names.contains(&from.as_str()) {
            continue;
        }
        let disk = if let Some(earlier) = locate(&recipe.stages[..index], from) {
            progress.disks[earlier]
                .clone()
                .ok_or_else(|| at(step.line)(format!("the stage {from} was not built")))?
        } else {
            let name = format!("source-{index}-{}", sources.len());
            let disk = job.work.join(format!("{name}.ext4"));
            let source = pull(job, from).map_err(at(step.line))?;
            convert(job, &source, &disk, &name).map_err(at(step.line))?;
            progress.seconds += source.seconds;
            progress.images.push(source.record);
            disk
        };
        names.push(from.as_str());
        sources.push(disk);
    }
    let copies = |step: &Step| matches!(step.instruction, Instruction::Copy { from: None, .. });
    let runs = |step: &Step| matches!(step.instruction, Instruction::Run(_));
    let passt = if job.network == Network::Private && steps.iter().any(runs) {
        Some(passt()?)
    } else {
        None
    };
    let forwards = if steps.iter().any(runs) {
        job.policy.reached(job.network)
    } else {
        &[]
    };
    let disk = job.work.join(format!("stage-{index}.ext4"));
    format(&disk, job.size_mb, &format!("{}/{index}", recipe.digest))?;
    let machine = Machine::start(
        &job.layout,
        &job.work.join(format!("stage-{index}")),
        &Disks {
            build: Some(&disk),
            context: steps.iter().any(copies).then_some(recipe.directory),
            forwards,
            passt: passt.as_deref(),
            sources: &sources,
        },
    )?;
    let container = match image {
        Some(image) => {
            apply(&machine, &image)?;
            progress.seconds += image.seconds;
            progress.images.push(image.record);
            image.config.config.unwrap_or_default()
        }
        None => Container::default(),
    };
    let mut state = State::new(container);
    for step in steps {
        execute(job, recipe, &machine, &mut state, step, &names).map_err(at(step.line))?;
    }
    machine.stop()?;
    progress.disks[index] = Some(disk);
    Ok(state)
}

fn dockerfile(job: &Job, directory: &Path, digest: &str) -> Result<Built, String> {
    let file = directory.join(DOCKERFILE);
    let text = fs::read_to_string(&file).map_err(|error| failed(&file, &error))?;
    let steps = dockerfile::parse(&text)?;
    let mut recipe = Recipe {
        digest,
        directory,
        globals: BTreeMap::new(),
        stages: Vec::new(),
        steps: &steps,
    };
    for (index, step) in steps.iter().enumerate() {
        match (&step.instruction, recipe.stages.last_mut()) {
            (Instruction::From { image, name }, _) => recipe.stages.push(Stage {
                first: index + 1,
                image,
                last: index + 1,
                line: step.line,
                name: name.as_deref(),
            }),
            (_, Some(stage)) => stage.last = index + 1,
            (Instruction::Arg(text), None) => {
                let globals = &recipe.globals;
                let words = dockerfile::words(text, &|name| globals.get(name).cloned())
                    .map_err(|message| format!("line {}: {message}", step.line))?;
                declare(&mut recipe.globals, words, &BTreeMap::new());
            }
            (_, None) => {
                return Err(format!("line {}: only ARG may precede FROM", step.line));
            }
        }
    }
    let count = recipe.stages.len();
    let mut needed = vec![false; count];
    match needed.last_mut() {
        Some(last) => *last = true,
        None => return Err(format!("{} has no FROM", file.display())),
    }
    for index in (0..count).rev() {
        if !needed[index] {
            continue;
        }
        let stage = &recipe.stages[index];
        for step in &steps[stage.first..stage.last] {
            if let Instruction::Copy {
                from: Some(from), ..
            } = &step.instruction
                && let Some(earlier) = locate(&recipe.stages[..index], from)
            {
                needed[earlier] = true;
            }
        }
    }
    let mut progress = Progress {
        disks: vec![None; count],
        images: Vec::new(),
        seconds: 0.0,
    };
    let mut last = None;
    for index in (0..count).filter(|index| needed[*index]) {
        last = Some(stage(job, &recipe, index, &mut progress)?);
    }
    let (Some(state), Some(Some(disk))) = (last, progress.disks.pop()) else {
        return Err(format!("{} built no stage", file.display()));
    };
    let mut identity = Sha256::new();
    identity.update(digest);
    for image in &progress.images {
        identity.update(&image.manifest_digest);
    }
    Ok(Built {
        config: Config {
            architecture: job.platform.architecture.clone(),
            cmd: state.cmd,
            entrypoint: state.entrypoint,
            env: state
                .environment
                .iter()
                .map(|(name, value)| format!("{name}={value}"))
                .collect(),
            os: job.platform.os.clone(),
            user: state.user,
            working_dir: state.workdir,
        },
        disk,
        image_digest: format!("sha256:{}", hex(&identity.finalize())),
        images: progress.images,
        seconds: progress.seconds,
    })
}

fn walk(root: &Path, relative: &Path, hasher: &mut Sha256) -> Result<(), String> {
    let directory = root.join(relative);
    let mut names = fs::read_dir(&directory)
        .and_then(|entries| {
            entries
                .map(|entry| entry.map(|entry| entry.file_name()))
                .collect::<io::Result<Vec<_>>>()
        })
        .map_err(|error| failed(&directory, &error))?;
    names.sort();
    for name in names {
        let relative = relative.join(name);
        let path = root.join(&relative);
        let metadata = fs::symlink_metadata(&path).map_err(|error| failed(&path, &error))?;
        let mode = metadata.mode() & 0o7777;
        hasher.update(relative.as_os_str().as_bytes());
        hasher.update([0]);
        if metadata.is_dir() {
            hasher.update(format!("d {mode:o}\n"));
            walk(root, &relative, hasher)?;
        } else if metadata.is_symlink() {
            let target = fs::read_link(&path).map_err(|error| failed(&path, &error))?;
            hasher.update(b"l ");
            hasher.update(target.as_os_str().as_bytes());
            hasher.update(b"\n");
        } else if metadata.is_file() {
            hasher.update(format!("f {mode:o} {}\n", sha256(&path)?));
        } else {
            return Err(format!(
                "{} is neither a file, a directory nor a link",
                path.display()
            ));
        }
    }
    Ok(())
}

fn recipe(directory: &Path, platform: &Platform, size_mb: u64) -> Result<String, String> {
    if let Some(ignore) = IGNORE_FILES
        .iter()
        .find(|name| directory.join(name).exists())
    {
        return Err(format!(
            "{}: an ignore file is not supported",
            directory.join(ignore).display()
        ));
    }
    let mut hasher = Sha256::new();
    hasher.update(format!("{SCHEMA}\n{platform}\n{size_mb}\n"));
    walk(directory, Path::new(""), &mut hasher)?;
    Ok(format!("sha256:{}", hex(&hasher.finalize())))
}

fn resolver(network: Network) -> Result<Vec<u8>, String> {
    if network == Network::Private {
        return Ok(format!("nameserver {}\n", wire::GUEST_RESOLVER).into_bytes());
    }
    let file = Path::new(RESOLVER);
    let text = fs::read_to_string(file).map_err(|error| failed(file, &error))?;
    let servers = text
        .lines()
        .filter_map(|line| {
            let mut words = line.split_whitespace();
            (words.next() == Some("nameserver"))
                .then(|| words.next())
                .flatten()
        })
        .collect::<Vec<_>>();
    if servers.is_empty() {
        return Err(format!("{RESOLVER} names no nameserver"));
    }
    let mut lines = Vec::new();
    for server in &servers {
        lines.extend_from_slice(format!("nameserver {server}\n").as_bytes());
    }
    if servers
        .iter()
        .any(|server| server.starts_with("127.") || *server == "::1")
    {
        lines.extend_from_slice(b"options use-vc\n");
    }
    Ok(lines)
}

fn cache(arguments: &Arguments) -> Result<PathBuf, String> {
    if let Some(cache) = arguments.maybe("cache") {
        return absolute(cache);
    }
    env::var_os("NANOEVAL_CACHE")
        .map(PathBuf::from)
        .or_else(|| env::var_os("XDG_CACHE_HOME").map(|home| PathBuf::from(home).join(CACHE)))
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".cache").join(CACHE)))
        .map(|cache| cache.join("oci"))
        .ok_or_else(|| "no cache directory: pass --cache".to_owned())
}

fn report(out: &Path, file: &Path, meta: &Meta, started: Instant) -> Result<u8, String> {
    println!(
        "{}",
        serde_json::json!({
            "bytes_allocated": allocated(out)?,
            "disk": out,
            "image_digest": meta.image_digest,
            "meta": file,
            "seconds": started.elapsed().as_secs_f64(),
        })
    );
    Ok(0)
}

pub(crate) fn command(arguments: impl Iterator<Item = OsString>) -> Result<u8, String> {
    let started = Instant::now();
    let mut allowed = vec![
        "ca-bundle",
        "cache",
        "dockerfile",
        "env-file",
        "forward",
        "meta",
        "network",
        "out",
        "platform",
        "ref",
        "size-mb",
    ];
    allowed.extend(Layout::OPTIONS);
    let arguments = Arguments::mixed(arguments, &allowed)?;
    if !arguments.rest.is_empty() {
        return Err(USAGE.to_owned());
    }
    let out = absolute(arguments.one("out")?)?;
    let file = absolute(arguments.one("meta")?)?;
    let size_mb: u64 = arguments.number("size-mb")?;
    let platform = match arguments.maybe("platform") {
        Some(platform) => Platform::parse(&platform.to_string_lossy())?,
        None => Platform::host()?,
    };
    let network = match arguments.maybe("network").map(|network| network.to_str()) {
        None | Some(Some("private")) => Network::Private,
        Some(Some("host")) => Network::Host,
        Some(_) => return Err("--network is private or host".to_owned()),
    };
    let directory = arguments.maybe("dockerfile").map(absolute).transpose()?;
    let source = match (arguments.maybe("ref"), &directory) {
        (Some(reference), None) => Source::Reference(reference.to_string_lossy().into_owned()),
        (None, Some(directory)) => Source::Dockerfile(recipe(directory, &platform, size_mb)?),
        _ => return Err(USAGE.to_owned()),
    };
    let _lock = Lock::take(beside(&out, ".lock"))?;
    let existing = fs::read(&file)
        .ok()
        .and_then(|body| serde_json::from_slice::<Meta>(&body).ok())
        .filter(|meta| {
            meta.schema == SCHEMA
                && meta.source == source
                && meta.platform == platform.to_string()
                && meta.size_mb == size_mb
                && out.is_file()
        });
    if let Some(meta) = existing {
        eprintln!("nanoeval-krun: {} is already built", out.display());
        return report(&out, &file, &meta, started);
    }
    let scratch = Scratch::create(beside(&out, ".tmp"))?;
    let job = Job {
        layout: Layout::parse(&arguments)?,
        network,
        platform,
        policy: Policy::parse(&arguments)?,
        registry: Registry::new()?,
        resolver: resolver(network)?,
        size_mb,
        store: Store::open(&cache(&arguments)?)?,
        work: scratch.0.clone(),
    };
    let built = match (&source, &directory) {
        (Source::Dockerfile(digest), Some(directory)) => dockerfile(&job, directory, digest)?,
        (Source::Reference(text), _) => reference(&job, text)?,
        (Source::Dockerfile(_), None) => return Err(USAGE.to_owned()),
    };
    fs::set_permissions(&built.disk, Permissions::from_mode(DISK_MODE))
        .and_then(|()| fs::rename(&built.disk, &out))
        .map_err(|error| failed(&out, &error))?;
    let meta = Meta {
        bytes_allocated: allocated(&out)?,
        config: built.config,
        image_digest: built.image_digest,
        images: built.images,
        platform: job.platform.to_string(),
        policy: directory
            .as_ref()
            .and_then(|_| job.policy.applied(job.network)),
        schema: SCHEMA.to_owned(),
        seconds: Seconds {
            convert: started.elapsed().as_secs_f64() - built.seconds,
            download: built.seconds,
        },
        size_mb,
        source,
    };
    let body = serde_json::to_vec_pretty(&meta)
        .map_err(|error| format!("the metadata was not encoded: {error}"))?;
    let temporary = beside(&file, ".tmp");
    fs::write(&temporary, body)
        .and_then(|()| fs::rename(&temporary, &file))
        .map_err(|error| failed(&file, &error))?;
    report(&out, &file, &meta, started)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_destination_is_resolved_against_the_working_directory() {
        assert_eq!(join("/app", "./"), "/app");
        assert_eq!(join("/app", "src/eval.py"), "/app/src/eval.py");
        assert_eq!(join("/app", "/bin/"), "/bin");
        assert_eq!(join("/", "../x/./y"), "/x/y");
        assert_eq!(join("/app/john", ".."), "/app");
    }

    #[test]
    fn an_argument_takes_its_default_or_the_global_one() {
        let globals = BTreeMap::from([("BASE".to_owned(), "ubuntu".to_owned())]);
        let mut arguments = BTreeMap::new();
        declare(
            &mut arguments,
            vec![
                "BASE".to_owned(),
                "URL=https://a/b".to_owned(),
                "UNSET".to_owned(),
            ],
            &globals,
        );
        assert_eq!(
            arguments,
            BTreeMap::from([
                ("BASE".to_owned(), "ubuntu".to_owned()),
                ("URL".to_owned(), "https://a/b".to_owned()),
            ])
        );
    }

    #[test]
    fn an_environment_file_is_lines_of_variables() {
        assert_eq!(
            variables(b"# held back\nUV_EXCLUDE_NEWER=2026-11-01\n\nINDEX=https://a/b?c=d\n")
                .unwrap(),
            [
                b"UV_EXCLUDE_NEWER=2026-11-01".to_vec(),
                b"INDEX=https://a/b?c=d".to_vec()
            ]
        );
        assert!(variables(b"export NAME\n").is_err());
        assert!(variables(b"=value\n").is_err());
    }

    #[test]
    fn a_step_gets_the_host_policy_after_the_image_environment() {
        let mut state = State::new(Container {
            env: Some(vec!["SSL_CERT_FILE=/image.pem".to_owned()]),
            ..Container::default()
        });
        state.arguments.insert("VERSION".to_owned(), "1".to_owned());
        let text = |policy: &Policy| {
            environment(&state, policy)
                .iter()
                .map(|entry| String::from_utf8_lossy(entry).into_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(
            text(&Policy::default()),
            [
                "SSL_CERT_FILE=/image.pem".to_owned(),
                "VERSION=1".to_owned(),
                format!("PATH={DEFAULT_PATH}"),
            ]
        );
        let policy = Policy {
            environment: vec![b"VERSION=2".to_vec()],
            forwards: Vec::new(),
            trust: b"-----BEGIN CERTIFICATE-----\n".to_vec(),
        };
        let entries = text(&policy);
        assert_eq!(entries.len(), 3 + TRUST_VARIABLES.len() + 1);
        assert_eq!(entries[3], "CARGO_HTTP_CAINFO=/opt/nanoeval/ca.pem");
        assert_eq!(entries[9], "SSL_CERT_FILE=/opt/nanoeval/ca.pem");
        assert_eq!(entries[10], "VERSION=2");
        assert_eq!(
            state.environment,
            [("SSL_CERT_FILE".to_owned(), "/image.pem".to_owned())]
        );
        assert!(policy.applied(Network::Host).unwrap().forwards.is_empty());
        assert!(Policy::default().applied(Network::Private).is_none());
    }

    #[test]
    fn a_stage_is_found_by_name_or_position() {
        let stages = [
            Stage {
                first: 1,
                image: "ubuntu:24.04",
                last: 2,
                line: 1,
                name: Some("build"),
            },
            Stage {
                first: 3,
                image: "ubuntu:24.04",
                last: 4,
                line: 3,
                name: None,
            },
        ];
        assert_eq!(locate(&stages, "BUILD"), Some(0));
        assert_eq!(locate(&stages, "1"), Some(1));
        assert_eq!(locate(&stages, "2"), None);
        assert_eq!(locate(&stages, "ghcr.io/astral-sh/uv:0.8.14"), None);
    }
}
