use std::{
    io::{self, Read, Write},
    net::Ipv4Addr,
};

pub const BUILD: &str = "build";
pub const BUILD_CONTEXT: &str = "/mnt/context";
pub const BUILD_ROOT: &str = "/mnt/root";
pub const BUILD_SOURCE: &str = "/mnt/source";
pub const CHUNK: usize = 64 * 1024;
pub const CONTEXT_TAG: &str = "context";
pub const FORWARD: &str = "forward=";
pub const GUEST_ADDRESS: Ipv4Addr = Ipv4Addr::new(10, 0, 2, 15);
pub const GUEST_GATEWAY: Ipv4Addr = Ipv4Addr::new(10, 0, 2, 2);
pub const GUEST_INTERFACE: &str = "eth0";
pub const GUEST_MTU: u32 = 65_520;
pub const GUEST_PREFIX: u8 = 24;
pub const GUEST_RESOLVER: Ipv4Addr = Ipv4Addr::new(10, 0, 2, 3);
pub const IO_TAG: &str = "io";
pub const MAGIC: [u8; 4] = *b"NKR2";
pub const PORT: u32 = 1024;
pub const PRIVATE: &str = "private";
pub const READY: &str = "nanoeval-krun-guest: listening";
pub const RELAY_PORT: u32 = 1025;
pub const ROOT: &str = "root";
pub const RUNTIME_TAG: &str = "rt";
pub const SOURCES: &str = "sources=";

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Request {
    Apply {
        root: Vec<u8>,
    },
    CopyIn {
        from: Vec<u8>,
        to: Vec<u8>,
    },
    CopyOut {
        from: Vec<u8>,
        to: Vec<u8>,
    },
    Exec {
        arguments: Vec<Vec<u8>>,
        directory: Vec<u8>,
        environment: Vec<Vec<u8>>,
        forwards: Vec<Vec<u8>>,
        user: Vec<u8>,
    },
    Install {
        from: Vec<u8>,
        into: bool,
        keep_owner: bool,
        root: Vec<u8>,
        sources: Vec<Vec<u8>>,
        to: Vec<u8>,
    },
    Mkdir {
        path: Vec<u8>,
        root: Vec<u8>,
        user: Vec<u8>,
    },
    Ping,
    Run {
        arguments: Vec<Vec<u8>>,
        directory: Vec<u8>,
        environment: Vec<Vec<u8>>,
        resolver: Vec<u8>,
        root: Vec<u8>,
        user: Vec<u8>,
    },
    Stop,
    Tree {
        root: Vec<u8>,
    },
    Unpack {
        to: Vec<u8>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Frame {
    Exit(i32),
    Failure(Vec<u8>),
    Stderr(Vec<u8>),
    Stdin(Vec<u8>),
    StdinEnd,
    Stdout(Vec<u8>),
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned())
}

fn write_bytes(writer: &mut impl Write, bytes: &[u8]) -> io::Result<()> {
    let length = u32::try_from(bytes.len()).map_err(|_| invalid("a field exceeds 4 GiB"))?;
    writer.write_all(&length.to_le_bytes())?;
    writer.write_all(bytes)
}

fn write_list(writer: &mut impl Write, list: &[Vec<u8>]) -> io::Result<()> {
    let count = u32::try_from(list.len()).map_err(|_| invalid("a list is too long"))?;
    writer.write_all(&count.to_le_bytes())?;
    list.iter().try_for_each(|item| write_bytes(writer, item))
}

fn read_u32(reader: &mut impl Read) -> io::Result<u32> {
    let mut bytes = [0; 4];
    reader.read_exact(&mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_bytes(reader: &mut impl Read) -> io::Result<Vec<u8>> {
    let length = read_u32(reader)? as usize;
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes)?;
    Ok(bytes)
}

fn read_flag(reader: &mut impl Read) -> io::Result<bool> {
    let mut flag = [0; 1];
    reader.read_exact(&mut flag)?;
    match flag[0] {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(invalid("a flag is neither 0 nor 1")),
    }
}

fn read_list(reader: &mut impl Read) -> io::Result<Vec<Vec<u8>>> {
    let count = read_u32(reader)?;
    (0..count).map(|_| read_bytes(reader)).collect()
}

impl Request {
    pub fn write(&self, writer: &mut impl Write) -> io::Result<()> {
        let mut buffer = MAGIC.to_vec();
        match self {
            Self::CopyIn { from, to } => {
                buffer.push(0);
                write_bytes(&mut buffer, from)?;
                write_bytes(&mut buffer, to)?;
            }
            Self::CopyOut { from, to } => {
                buffer.push(1);
                write_bytes(&mut buffer, from)?;
                write_bytes(&mut buffer, to)?;
            }
            Self::Exec {
                arguments,
                directory,
                environment,
                forwards,
                user,
            } => {
                buffer.push(2);
                write_list(&mut buffer, arguments)?;
                write_bytes(&mut buffer, directory)?;
                write_list(&mut buffer, environment)?;
                write_list(&mut buffer, forwards)?;
                write_bytes(&mut buffer, user)?;
            }
            Self::Ping => buffer.push(3),
            Self::Stop => buffer.push(4),
            Self::Unpack { to } => {
                buffer.push(5);
                write_bytes(&mut buffer, to)?;
            }
            Self::Apply { root } => {
                buffer.push(6);
                write_bytes(&mut buffer, root)?;
            }
            Self::Install {
                from,
                into,
                keep_owner,
                root,
                sources,
                to,
            } => {
                buffer.push(7);
                write_bytes(&mut buffer, from)?;
                buffer.push(u8::from(*into));
                buffer.push(u8::from(*keep_owner));
                write_bytes(&mut buffer, root)?;
                write_list(&mut buffer, sources)?;
                write_bytes(&mut buffer, to)?;
            }
            Self::Mkdir { path, root, user } => {
                buffer.push(8);
                write_bytes(&mut buffer, path)?;
                write_bytes(&mut buffer, root)?;
                write_bytes(&mut buffer, user)?;
            }
            Self::Run {
                arguments,
                directory,
                environment,
                resolver,
                root,
                user,
            } => {
                buffer.push(9);
                write_list(&mut buffer, arguments)?;
                write_bytes(&mut buffer, directory)?;
                write_list(&mut buffer, environment)?;
                write_bytes(&mut buffer, resolver)?;
                write_bytes(&mut buffer, root)?;
                write_bytes(&mut buffer, user)?;
            }
            Self::Tree { root } => {
                buffer.push(10);
                write_bytes(&mut buffer, root)?;
            }
        }
        writer.write_all(&buffer)?;
        writer.flush()
    }

    pub fn read(reader: &mut impl Read) -> io::Result<Self> {
        let mut magic = [0; 4];
        reader.read_exact(&mut magic)?;
        if magic != MAGIC {
            return Err(invalid(
                "the request does not start with the protocol magic",
            ));
        }
        let mut kind = [0; 1];
        reader.read_exact(&mut kind)?;
        match kind[0] {
            0 => Ok(Self::CopyIn {
                from: read_bytes(reader)?,
                to: read_bytes(reader)?,
            }),
            1 => Ok(Self::CopyOut {
                from: read_bytes(reader)?,
                to: read_bytes(reader)?,
            }),
            2 => Ok(Self::Exec {
                arguments: read_list(reader)?,
                directory: read_bytes(reader)?,
                environment: read_list(reader)?,
                forwards: read_list(reader)?,
                user: read_bytes(reader)?,
            }),
            3 => Ok(Self::Ping),
            4 => Ok(Self::Stop),
            5 => Ok(Self::Unpack {
                to: read_bytes(reader)?,
            }),
            6 => Ok(Self::Apply {
                root: read_bytes(reader)?,
            }),
            7 => Ok(Self::Install {
                from: read_bytes(reader)?,
                into: read_flag(reader)?,
                keep_owner: read_flag(reader)?,
                root: read_bytes(reader)?,
                sources: read_list(reader)?,
                to: read_bytes(reader)?,
            }),
            8 => Ok(Self::Mkdir {
                path: read_bytes(reader)?,
                root: read_bytes(reader)?,
                user: read_bytes(reader)?,
            }),
            9 => Ok(Self::Run {
                arguments: read_list(reader)?,
                directory: read_bytes(reader)?,
                environment: read_list(reader)?,
                resolver: read_bytes(reader)?,
                root: read_bytes(reader)?,
                user: read_bytes(reader)?,
            }),
            10 => Ok(Self::Tree {
                root: read_bytes(reader)?,
            }),
            _ => Err(invalid("unknown request kind")),
        }
    }
}

impl Frame {
    pub fn write(&self, writer: &mut impl Write) -> io::Result<()> {
        let (kind, payload): (u8, &[u8]) = match self {
            Self::Exit(code) => return write_frame(writer, 0, &code.to_le_bytes()),
            Self::Failure(message) => (1, message),
            Self::Stderr(data) => (2, data),
            Self::Stdin(data) => (3, data),
            Self::StdinEnd => (4, &[]),
            Self::Stdout(data) => (5, data),
        };
        write_frame(writer, kind, payload)
    }

    pub fn read(reader: &mut impl Read) -> io::Result<Self> {
        let mut kind = [0; 1];
        reader.read_exact(&mut kind)?;
        let length = read_u32(reader)? as usize;
        if length > CHUNK {
            return Err(invalid("a frame exceeds the protocol chunk size"));
        }
        let mut payload = vec![0; length];
        reader.read_exact(&mut payload)?;
        match kind[0] {
            0 => {
                let code: [u8; 4] = payload
                    .try_into()
                    .map_err(|_| invalid("an exit frame carries four bytes"))?;
                Ok(Self::Exit(i32::from_le_bytes(code)))
            }
            1 => Ok(Self::Failure(payload)),
            2 => Ok(Self::Stderr(payload)),
            3 => Ok(Self::Stdin(payload)),
            4 => Ok(Self::StdinEnd),
            5 => Ok(Self::Stdout(payload)),
            _ => Err(invalid("unknown frame kind")),
        }
    }
}

fn write_frame(writer: &mut impl Write, kind: u8, payload: &[u8]) -> io::Result<()> {
    if payload.len() > CHUNK {
        return Err(invalid("a frame exceeds the protocol chunk size"));
    }
    let mut buffer = Vec::with_capacity(payload.len() + 5);
    buffer.push(kind);
    write_bytes(&mut buffer, payload)?;
    writer.write_all(&buffer)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_round_trip() {
        let requests = [
            Request::Apply {
                root: b"/mnt/root".to_vec(),
            },
            Request::CopyIn {
                from: b"tests".to_vec(),
                to: b"/tests".to_vec(),
            },
            Request::CopyOut {
                from: b"/logs/verifier".to_vec(),
                to: b"verifier".to_vec(),
            },
            Request::Exec {
                arguments: vec![b"sh".to_vec(), b"-c".to_vec(), b"echo \xff".to_vec()],
                directory: b"/app".to_vec(),
                environment: vec![b"PATH=/bin".to_vec()],
                forwards: vec![b"127.0.0.1:8787".to_vec()],
                user: Vec::new(),
            },
            Request::Install {
                from: b"/mnt/context".to_vec(),
                into: true,
                keep_owner: false,
                root: b"/mnt/root".to_vec(),
                sources: vec![b"notes.md".to_vec()],
                to: b"/app".to_vec(),
            },
            Request::Mkdir {
                path: b"/app".to_vec(),
                root: b"/mnt/root".to_vec(),
                user: b"worker".to_vec(),
            },
            Request::Ping,
            Request::Run {
                arguments: vec![b"/bin/sh".to_vec(), b"-c".to_vec(), b"true".to_vec()],
                directory: b"/".to_vec(),
                environment: vec![b"PATH=/bin".to_vec()],
                resolver: b"nameserver 10.0.2.3\n".to_vec(),
                root: b"/mnt/root".to_vec(),
                user: Vec::new(),
            },
            Request::Stop,
            Request::Tree {
                root: b"/mnt/source/0".to_vec(),
            },
            Request::Unpack { to: b"/".to_vec() },
        ];
        for request in requests {
            let mut bytes = Vec::new();
            request.write(&mut bytes).unwrap();
            assert_eq!(Request::read(&mut bytes.as_slice()).unwrap(), request);
        }
    }

    #[test]
    fn frames_round_trip() {
        let frames = [
            Frame::Exit(-3),
            Frame::Failure(b"no such file".to_vec()),
            Frame::Stderr(vec![1, 2]),
            Frame::Stdin(vec![0; CHUNK]),
            Frame::StdinEnd,
            Frame::Stdout(Vec::new()),
        ];
        for frame in frames {
            let mut bytes = Vec::new();
            frame.write(&mut bytes).unwrap();
            assert_eq!(Frame::read(&mut bytes.as_slice()).unwrap(), frame);
        }
    }

    #[test]
    fn a_frame_past_the_chunk_size_is_refused() {
        let mut bytes = vec![5];
        bytes.extend_from_slice(&u32::try_from(CHUNK + 1).unwrap().to_le_bytes());
        bytes.resize(CHUNK + 6, 0);
        assert!(Frame::read(&mut bytes.as_slice()).is_err());
        assert!(
            Frame::Stdout(vec![0; CHUNK + 1])
                .write(&mut Vec::new())
                .is_err()
        );
    }

    #[test]
    fn a_request_without_the_magic_is_refused() {
        assert!(Request::read(&mut b"HTTP/1.1".as_slice()).is_err());
    }
}
