use std::{
    env,
    ffi::OsString,
    fs::{self, File},
    io::{self, BufWriter, Read, Write},
    net::Shutdown,
    os::{fd::AsRawFd, unix::net::UnixStream},
    path::{Path, PathBuf},
    process::{self, Child, Command, Stdio},
    thread,
    time::Duration,
};

use wire::{Frame, Request};

use super::{Scratch, absolute, failed};
use crate::Arguments;

const BOOT: &str = "boot";
const LOG: &str = "vm.log";
const LOG_TAIL: usize = 2048;
const READY_POLL: Duration = Duration::from_millis(20);
const SOCKET: &str = "vm.sock";

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
        let child = command
            .current_dir(home)
            .stdin(Stdio::null())
            .stdout(log)
            .stderr(errors)
            .spawn()
            .map_err(|error| format!("the builder VM did not start: {error}"))?;
        let mut machine = Self {
            child,
            directory: File::open(home).map_err(|error| failed(home, &error))?,
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

    pub(crate) fn request(
        &self,
        request: &Request,
        input: Option<&mut (dyn Read + Send)>,
        output: &mut (dyn Write + Send),
    ) -> Result<i32, String> {
        let socket = format!("/proc/self/fd/{}/{SOCKET}", self.directory.as_raw_fd());
        let stream = UnixStream::connect(&socket)
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
            let sent = input.is_none_or(|input| {
                let mut buffer = vec![0; wire::CHUNK];
                loop {
                    let frame = match input.read(&mut buffer) {
                        Ok(0) => break Frame::StdinEnd.write(&mut &stream).is_ok(),
                        Ok(length) => Frame::Stdin(buffer[..length].to_vec()),
                        Err(_) => break false,
                    };
                    if frame.write(&mut &stream).is_err() {
                        break false;
                    }
                }
            });
            let code = answer
                .join()
                .map_err(|_| "the reader of the guest connection panicked".to_owned())??;
            if code == 0 && !sent {
                return Err("the input was not read to its end".to_owned());
            }
            Ok(code)
        })
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
