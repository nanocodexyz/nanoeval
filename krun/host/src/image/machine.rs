use std::{
    env,
    ffi::OsString,
    fs::{self, File},
    io::{self, BufWriter, Read, Write},
    net::{Shutdown, SocketAddrV4},
    os::{
        fd::AsRawFd,
        unix::net::{UnixListener, UnixStream},
    },
    path::{Path, PathBuf},
    process::{self, Child, Command, Stdio},
    thread,
    time::Duration,
};

use net::forward;
use wire::{Frame, Request};

use super::{Scratch, absolute, failed};
use crate::Arguments;

const BOOT: &str = "boot";
const KNOCK_AFTER: Duration = Duration::from_secs(10);
const KNOCKS: u32 = 30;
const LOG: &str = "vm.log";
const LOG_TAIL: usize = 2048;
const READY_POLL: Duration = Duration::from_millis(20);
const RELAY: &str = "relay.sock";
const SOCKET: &str = "vm.sock";
pub(crate) const STALLED: &str = "the builder guest read nothing of its input";
pub(crate) const STALLED_CODE: u8 = 75;

pub(crate) struct Layout {
    pub(crate) boot: PathBuf,
    pub(crate) cpus: u8,
    pub(crate) memory_mib: u32,
}

impl Layout {
    pub(crate) const CPUS: u8 = 2;
    pub(crate) const MEMORY_MIB: u32 = 2048;
    pub(crate) const OPTIONS: [&str; 3] = ["boot", "cpus", "memory-mib"];

    pub(crate) fn parse(arguments: &Arguments) -> Result<Self, String> {
        let boot = match arguments.maybe("boot") {
            Some(boot) => absolute(boot)?,
            None => env::current_exe()
                .map_err(|error| format!("the launcher's own path: {error}"))?
                .with_file_name(BOOT),
        };
        Ok(Self {
            boot,
            cpus: arguments
                .maybe("cpus")
                .map_or(Ok(Self::CPUS), |_| arguments.number("cpus"))?,
            memory_mib: arguments
                .maybe("memory-mib")
                .map_or(Ok(Self::MEMORY_MIB), |_| arguments.number("memory-mib"))?,
        })
    }
}

#[derive(Default)]
pub(crate) struct Disks<'a> {
    pub(crate) build: Option<&'a Path>,
    pub(crate) context: Option<&'a Path>,
    pub(crate) forwards: &'a [SocketAddrV4],
    pub(crate) passt: Option<&'a Path>,
    pub(crate) sources: &'a [PathBuf],
}

pub(crate) struct Machine {
    child: Child,
    directory: File,
    home: PathBuf,
}

impl Machine {
    pub(crate) fn start(layout: &Layout, home: &Path, disks: &Disks<'_>) -> Result<Self, String> {
        fs::create_dir_all(home).map_err(|error| failed(home, &error))?;
        let log = File::create(home.join(LOG)).map_err(|error| failed(home, &error))?;
        let errors = log.try_clone().map_err(|error| failed(home, &error))?;
        let program =
            env::current_exe().map_err(|error| format!("the launcher's own path: {error}"))?;
        let mut command = Command::new(program);
        command
            .arg("vm")
            .arg("--boot")
            .arg(&layout.boot)
            .args(["--socket", SOCKET])
            .args(["--cpus", &layout.cpus.to_string()])
            .args(["--memory-mib", &layout.memory_mib.to_string()])
            .args(["--leash", &process::id().to_string()]);
        if let Some(build) = disks.build {
            command.arg("--build").arg(build);
        }
        for source in disks.sources {
            command.arg("--source").arg(source);
        }
        if let Some(context) = disks.context {
            command.arg("--context").arg(context);
        }
        if let Some(passt) = disks.passt {
            command.arg("--passt").arg(passt);
        }
        let directory = File::open(home).map_err(|error| failed(home, &error))?;
        if !disks.forwards.is_empty() {
            let socket = format!("/proc/self/fd/{}/{RELAY}", directory.as_raw_fd());
            let listener = UnixListener::bind(&socket)
                .map_err(|error| format!("the relay of the builder VM: {error}"))?;
            let allowed = disks.forwards.to_vec();
            thread::spawn(move || {
                let served = forward::serve(&listener, move |target| Ok(allowed.contains(&target)));
                if let Err(error) = served {
                    eprintln!("nanoeval-krun: the relay of the builder VM: {error}");
                }
            });
            command.args(["--relay", RELAY]);
            for forward in disks.forwards {
                command.args(["--forward", &forward.to_string()]);
            }
        }
        let child = command
            .current_dir(home)
            .stdin(Stdio::null())
            .stdout(log)
            .stderr(errors)
            .spawn()
            .map_err(|error| format!("the builder VM did not start: {error}"))?;
        let mut machine = Self {
            child,
            directory,
            home: home.to_path_buf(),
        };
        machine.ready()?;
        Ok(machine)
    }

    fn log(&self) -> String {
        let log = fs::read(self.home.join(LOG)).unwrap_or_default();
        String::from_utf8_lossy(&log[log.len().saturating_sub(LOG_TAIL)..])
            .trim()
            .to_owned()
    }

    fn ready(&mut self) -> Result<(), String> {
        loop {
            let listening = fs::read(self.home.join(LOG))
                .map_err(|error| failed(&self.home, &error))?
                .split(|byte| *byte == b'\n')
                .any(|line| line == wire::READY.as_bytes());
            if listening {
                break;
            }
            let exited = self
                .child
                .try_wait()
                .map_err(|error| format!("the builder VM: {error}"))?;
            if exited.is_some() {
                return Err(format!(
                    "the builder VM exited before its guest listened: {}",
                    self.log()
                ));
            }
            thread::sleep(READY_POLL);
        }
        match self.request(&Request::Ping, None, &mut io::sink())? {
            0 => Ok(()),
            code => Err(format!("the builder guest answered a ping with {code}")),
        }
    }

    fn socket(&self) -> String {
        format!("/proc/self/fd/{}/{SOCKET}", self.directory.as_raw_fd())
    }

    pub(crate) fn request(
        &self,
        request: &Request,
        input: Option<&mut (dyn Read + Send)>,
        output: &mut (dyn Write + Send),
    ) -> Result<i32, String> {
        let stream = UnixStream::connect(self.socket())
            .map_err(|error| format!("the builder guest refused a connection: {error}"))?;
        request
            .write(&mut &stream)
            .map_err(|error| format!("the request was not sent: {error}"))?;
        thread::scope(|scope| {
            let answer = scope.spawn(|| {
                let mut failure = None;
                let outcome = loop {
                    let written = match Frame::read(&mut &stream) {
                        Ok(Frame::Exit(code)) => break Ok(code),
                        Ok(Frame::Failure(message)) => {
                            failure = Some(String::from_utf8_lossy(&message).into_owned());
                            Ok(())
                        }
                        Ok(Frame::Stderr(data)) => io::stderr().write_all(&data),
                        Ok(Frame::Stdout(data)) => output.write_all(&data),
                        Ok(Frame::Stdin(_) | Frame::StdinEnd) => {
                            break Err("the guest sent an input frame".to_owned());
                        }
                        Err(error) => break Err(format!("the guest connection ended: {error}")),
                    };
                    if let Err(error) = written {
                        break Err(format!("output was not written: {error}"));
                    }
                };
                let _ = stream.shutdown(Shutdown::Both);
                match failure {
                    Some(failure) if outcome != Ok(0) => Err(failure),
                    _ => outcome,
                }
            });
            let sent = input.map_or(Ok(true), |input| {
                let mut writer = Knocking {
                    after: KNOCK_AFTER,
                    knock: || self.knock(),
                    knocks: 0,
                    limit: KNOCKS,
                    stream: &stream,
                };
                send(input, &mut writer)
            });
            if sent.is_err() {
                let _ = stream.shutdown(Shutdown::Both);
            }
            let code = answer
                .join()
                .map_err(|_| "the reader of the guest connection panicked".to_owned())?;
            let sent = sent?;
            let code = code?;
            if code == 0 && !sent {
                return Err("the input was not read to its end".to_owned());
            }
            Ok(code)
        })
    }

    fn knock(&self) -> io::Result<()> {
        let stream = UnixStream::connect(self.socket())?;
        stream.set_read_timeout(Some(KNOCK_AFTER))?;
        stream.set_write_timeout(Some(KNOCK_AFTER))?;
        Request::Ping.write(&mut &stream)?;
        loop {
            match Frame::read(&mut &stream)? {
                Frame::Exit(0) => return Ok(()),
                Frame::Exit(code) => {
                    return Err(io::Error::other(format!("the ping ended with {code}")));
                }
                _ => {}
            }
        }
    }

    pub(crate) fn stop(mut self) -> Result<(), String> {
        let code = self.request(&Request::Stop, None, &mut io::sink())?;
        if code != 0 {
            return Err(format!("the builder guest stopped with {code}"));
        }
        let status = self
            .child
            .wait()
            .map_err(|error| format!("the builder VM: {error}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!(
                "the builder VM ended with {status}: {}",
                self.log()
            ))
        }
    }
}

fn send(input: &mut (dyn Read + Send), writer: &mut impl Write) -> Result<bool, String> {
    let mut buffer = vec![0; wire::CHUNK];
    loop {
        let frame = match input.read(&mut buffer) {
            Ok(0) => Frame::StdinEnd,
            Ok(length) => Frame::Stdin(buffer[..length].to_vec()),
            Err(_) => return Ok(false),
        };
        match frame.write(writer) {
            Ok(()) if frame == Frame::StdinEnd => return Ok(true),
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::TimedOut => return Err(error.to_string()),
            Err(_) => return Ok(false),
        }
    }
}

struct Knocking<'a, K> {
    after: Duration,
    knock: K,
    knocks: u32,
    limit: u32,
    stream: &'a UnixStream,
}

impl<K: FnMut() -> io::Result<()>> Write for Knocking<'_, K> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.stream.set_write_timeout(Some(self.after))?;
        loop {
            match (&mut &*self.stream).write(buffer) {
                Ok(length) => {
                    self.knocks = 0;
                    return Ok(length);
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    let quiet = self.after * (self.knocks + 1);
                    if self.knocks == self.limit {
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            format!(
                                "{STALLED} for {} s, though it answered a ping",
                                quiet.as_secs()
                            ),
                        ));
                    }
                    self.knocks += 1;
                    (self.knock)().map_err(|error| {
                        io::Error::new(
                            io::ErrorKind::TimedOut,
                            format!(
                                "{STALLED} for {} s and did not answer a ping: {error}",
                                quiet.as_secs()
                            ),
                        )
                    })?;
                    eprintln!(
                        "nanoeval-krun: {STALLED} for {} s, so it was pinged",
                        quiet.as_secs()
                    );
                }
                Err(error) => return Err(error),
            }
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for Machine {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub(crate) fn tree(arguments: impl Iterator<Item = OsString>) -> Result<u8, String> {
    let arguments = Arguments::mixed(arguments, &Layout::OPTIONS)?;
    let [disk] = arguments.rest.as_slice() else {
        return Err("usage: nanoeval-krun image tree DISK.ext4 [--boot DIR]".to_owned());
    };
    let layout = Layout::parse(&arguments)?;
    let scratch =
        Scratch::create(env::temp_dir().join(format!("nanoeval-krun-tree-{}", process::id())))?;
    let machine = Machine::start(
        &layout,
        &scratch.0,
        &Disks {
            sources: &[absolute(disk)?],
            ..Disks::default()
        },
    )?;
    let mut output = BufWriter::new(io::stdout());
    let code = machine.request(
        &Request::Tree {
            root: format!("{}/0", wire::BUILD_SOURCE).into_bytes(),
        },
        None,
        &mut output,
    )?;
    output
        .flush()
        .map_err(|error| format!("output was not written: {error}"))?;
    machine.stop()?;
    Ok(u8::try_from(code & 0xff).unwrap_or(u8::MAX))
}

#[cfg(test)]
mod tests {
    use std::{
        cell::Cell,
        io::{self, Read, Write},
        net::Shutdown,
        os::unix::net::UnixStream,
        sync::mpsc,
        thread,
        time::Duration,
    };

    use super::{Knocking, STALLED};

    const AFTER: Duration = Duration::from_millis(50);
    const LIMIT: u32 = 3;
    const SENT: usize = 8 * 1024 * 1024;

    #[test]
    fn a_guest_that_reads_only_once_knocked_gets_all_of_its_input() {
        let (stream, guest) = UnixStream::pair().unwrap();
        let (knocked, heard) = mpsc::channel();
        let reader = thread::spawn(move || {
            heard.recv().unwrap();
            let mut received = Vec::new();
            (&guest).read_to_end(&mut received).unwrap();
            received
        });
        let knocks = Cell::new(0);
        let mut writer = Knocking {
            after: AFTER,
            knock: || {
                knocks.set(knocks.get() + 1);
                let _ = knocked.send(());
                Ok(())
            },
            knocks: 0,
            limit: LIMIT,
            stream: &stream,
        };
        let input = (0..SENT)
            .map(|index| u8::try_from(index % 251).unwrap())
            .collect::<Vec<_>>();
        writer.write_all(&input).unwrap();
        stream.shutdown(Shutdown::Write).unwrap();
        assert_eq!(reader.join().unwrap(), input);
        assert_eq!(knocks.get(), 1);
    }

    #[test]
    fn a_guest_that_never_reads_is_a_stall() {
        let (stream, _guest) = UnixStream::pair().unwrap();
        let knocks = Cell::new(0);
        let mut writer = Knocking {
            after: AFTER,
            knock: || {
                knocks.set(knocks.get() + 1);
                Ok(())
            },
            knocks: 0,
            limit: LIMIT,
            stream: &stream,
        };
        let error = writer.write_all(&vec![0; SENT]).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(error.to_string().starts_with(STALLED));
        assert_eq!(knocks.get(), LIMIT);
    }

    #[test]
    fn a_guest_that_does_not_answer_a_knock_is_a_stall() {
        let (stream, _guest) = UnixStream::pair().unwrap();
        let mut writer = Knocking {
            after: AFTER,
            knock: || Err(io::Error::from(io::ErrorKind::WouldBlock)),
            knocks: 0,
            limit: LIMIT,
            stream: &stream,
        };
        let error = writer.write_all(&vec![0; SENT]).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(error.to_string().starts_with(STALLED));
        assert!(error.to_string().contains("did not answer a ping"));
    }
}
