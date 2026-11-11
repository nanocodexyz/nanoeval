use std::{
    fs::File,
    io::{self, Read, Write},
    net::{SocketAddrV4, TcpListener, TcpStream},
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::net::{UnixListener, UnixStream},
    },
    str::FromStr,
    thread,
};

use nix::sys::socket::{Shutdown, shutdown};

const CHUNK: usize = 64 * 1024;
const TARGET_LIMIT: usize = "255.255.255.255:65535\n".len();

pub struct Forward(TcpListener);

impl Drop for Forward {
    fn drop(&mut self) {
        let _ = shutdown(self.0.as_raw_fd(), Shutdown::Both);
    }
}

fn invalid(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

pub fn target(text: &[u8]) -> io::Result<SocketAddrV4> {
    let text = String::from_utf8_lossy(text);
    let target = SocketAddrV4::from_str(&text)
        .map_err(|_| invalid(format!("a forward is ADDRESS:PORT: {text}")))?;
    if !target.ip().is_loopback() {
        return Err(invalid(format!(
            "a forward names a loopback address: {text}"
        )));
    }
    Ok(target)
}

pub fn announce(stream: &mut File, target: SocketAddrV4) -> io::Result<()> {
    stream.write_all(format!("{target}\n").as_bytes())
}

pub fn requested(stream: &mut File) -> io::Result<SocketAddrV4> {
    let mut line = Vec::new();
    let mut byte = [0; 1];
    loop {
        stream.read_exact(&mut byte)?;
        if byte[0] == b'\n' {
            return target(&line);
        }
        line.push(byte[0]);
        if line.len() >= TARGET_LIMIT {
            return Err(invalid(
                "the connection did not start with a forward".to_owned(),
            ));
        }
    }
}

fn copy(mut from: &File, mut to: &File) {
    let mut buffer = vec![0; CHUNK];
    loop {
        match from.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(length) => {
                if to.write_all(&buffer[..length]).is_err() {
                    break;
                }
            }
        }
    }
    let _ = shutdown(to.as_raw_fd(), Shutdown::Write);
    let _ = shutdown(from.as_raw_fd(), Shutdown::Read);
}

pub fn splice(left: &File, right: &File) -> io::Result<()> {
    let (from, to) = (right.try_clone()?, left.try_clone()?);
    let back = thread::spawn(move || copy(&from, &to));
    copy(left, right);
    back.join()
        .map_err(|_| io::Error::other("a relay thread panicked"))
}

fn admit<A>(connection: UnixStream, allowed: &A) -> io::Result<()>
where
    A: Fn(SocketAddrV4) -> io::Result<bool>,
{
    let mut connection = File::from(OwnedFd::from(connection));
    let target = requested(&mut connection)?;
    if !allowed(target)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{target} is not a forward of this slot"),
        ));
    }
    let upstream = TcpStream::connect(target)
        .map_err(|error| io::Error::new(error.kind(), format!("{target}: {error}")))?;
    splice(&connection, &File::from(OwnedFd::from(upstream)))
}

pub fn serve<A>(listener: &UnixListener, allowed: A) -> io::Result<()>
where
    A: Fn(SocketAddrV4) -> io::Result<bool> + Clone + Send + 'static,
{
    for connection in listener.incoming() {
        let connection = connection?;
        let allowed = allowed.clone();
        thread::spawn(move || {
            if let Err(error) = admit(connection, &allowed) {
                eprintln!("nanoeval-net: {error}");
            }
        });
    }
    Ok(())
}

pub fn listen<C>(target: SocketAddrV4, connect: C) -> io::Result<Forward>
where
    C: Fn() -> io::Result<File> + Clone + Send + 'static,
{
    let listener = TcpListener::bind(target)
        .map_err(|error| io::Error::new(error.kind(), format!("listen on {target}: {error}")))?;
    let forward = Forward(listener.try_clone()?);
    thread::spawn(move || {
        while let Ok((connection, _)) = listener.accept() {
            let connect = connect.clone();
            thread::spawn(move || {
                let relayed = connect().and_then(|mut upstream| {
                    announce(&mut upstream, target)?;
                    splice(&File::from(OwnedFd::from(connection)), &upstream)
                });
                if let Err(error) = relayed {
                    eprintln!("nanoeval-net: {target}: {error}");
                }
            });
        }
    });
    Ok(forward)
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Read, Write},
        net::{Ipv4Addr, Shutdown, SocketAddr, TcpListener, TcpStream},
        os::unix::net::UnixStream,
    };

    use super::*;

    fn loopback(listener: &TcpListener) -> SocketAddrV4 {
        match listener.local_addr().unwrap() {
            SocketAddr::V4(address) => address,
            SocketAddr::V6(_) => unreachable!(),
        }
    }

    #[test]
    fn a_forward_is_a_loopback_address_and_port() {
        assert_eq!(
            target(b"127.0.0.2:443").unwrap(),
            SocketAddrV4::new(Ipv4Addr::new(127, 0, 0, 2), 443)
        );
        assert!(target(b"10.0.0.1:443").is_err());
        assert!(target(b"localhost:443").is_err());
        assert!(target(b"127.0.0.1").is_err());
    }

    #[test]
    fn a_connection_names_its_forward_first() {
        let (near, far) = UnixStream::pair().unwrap();
        let mut near = File::from(OwnedFd::from(near));
        let mut far = File::from(OwnedFd::from(far));
        let wanted = SocketAddrV4::new(Ipv4Addr::LOCALHOST, 8787);
        announce(&mut near, wanted).unwrap();
        near.write_all(b"payload").unwrap();
        assert_eq!(requested(&mut far).unwrap(), wanted);
        let mut payload = [0; 7];
        far.read_exact(&mut payload).unwrap();
        assert_eq!(&payload, b"payload");
    }

    #[test]
    fn a_connection_that_names_no_forward_is_refused() {
        let (near, far) = UnixStream::pair().unwrap();
        let mut near = File::from(OwnedFd::from(near));
        let mut far = File::from(OwnedFd::from(far));
        near.write_all(&[b'x'; 64]).unwrap();
        assert!(requested(&mut far).is_err());
    }

    #[test]
    fn a_listener_relays_both_directions_and_ends_with_its_forward() {
        let upstream = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let upstream_address = loopback(&upstream);
        let free = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let wanted = loopback(&free);
        drop(free);
        let forward = listen(wanted, move || {
            TcpStream::connect(upstream_address).map(|stream| File::from(OwnedFd::from(stream)))
        })
        .unwrap();

        let mut client = TcpStream::connect(wanted).unwrap();
        client.write_all(b"ping").unwrap();
        client.shutdown(Shutdown::Write).unwrap();
        let (served, _) = upstream.accept().unwrap();
        let mut served = File::from(OwnedFd::from(served));
        assert_eq!(requested(&mut served).unwrap(), wanted);
        let mut request = String::new();
        served.read_to_string(&mut request).unwrap();
        assert_eq!(request, "ping");
        served.write_all(b"pong").unwrap();
        drop(served);
        let mut answer = String::new();
        client.read_to_string(&mut answer).unwrap();
        assert_eq!(answer, "pong");

        drop(forward);
        let mut refused = false;
        for _ in 0..200 {
            if TcpStream::connect(wanted).is_err() {
                refused = true;
                break;
            }
            thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(refused);
    }
}
