use std::{
    io::{self, Read, Write},
    net::Shutdown,
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    thread,
};

const ETHERNET: usize = 18;
const HEADER: usize = 4;
const LIMIT: usize = wire::GUEST_MTU as usize + ETHERNET;

fn relay(mut from: &UnixStream, mut to: &UnixStream, open: &Path) -> io::Result<()> {
    let mut frame = vec![0; HEADER + LIMIT];
    loop {
        let (header, payload) = frame.split_at_mut(HEADER);
        from.read_exact(header)?;
        let length = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as usize;
        let Some(payload) = payload.get_mut(..length) else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("a network frame of {length} bytes exceeds {LIMIT}"),
            ));
        };
        from.read_exact(payload)?;
        if open.exists() {
            to.write_all(&frame[..HEADER + length])?;
        }
    }
}

pub(crate) fn spawn(guest: UnixStream, proxy: UnixStream, open: &Path) -> io::Result<()> {
    let pairs = [(guest.try_clone()?, proxy.try_clone()?), (proxy, guest)];
    for (from, to) in pairs {
        let open = PathBuf::from(open);
        thread::spawn(move || {
            if let Err(error) = relay(&from, &to, &open)
                && error.kind() != io::ErrorKind::UnexpectedEof
            {
                eprintln!("nanoeval-krun: the network gate: {error}");
            }
            let _ = from.shutdown(Shutdown::Both);
            let _ = to.shutdown(Shutdown::Both);
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{env, fs, process, time::Duration};

    use super::*;

    fn frame(payload: &[u8]) -> Vec<u8> {
        let mut frame = u32::try_from(payload.len()).unwrap().to_be_bytes().to_vec();
        frame.extend_from_slice(payload);
        frame
    }

    #[test]
    fn frames_pass_only_while_the_gate_is_open() {
        let open = env::temp_dir().join(format!("nanoeval-krun-gate-{}", process::id()));
        let _ = fs::remove_file(&open);
        let (mut guest, near) = UnixStream::pair().unwrap();
        let (far, mut proxy) = UnixStream::pair().unwrap();
        spawn(near, far, &open).unwrap();
        proxy
            .set_read_timeout(Some(Duration::from_millis(200)))
            .unwrap();
        guest
            .set_read_timeout(Some(Duration::from_millis(200)))
            .unwrap();
        let mut answer = [0; 9];

        guest.write_all(&frame(b"while closed")).unwrap();
        assert!(proxy.read_exact(&mut answer).is_err());
        proxy.write_all(&frame(b"while closed")).unwrap();
        assert!(guest.read_exact(&mut answer).is_err());

        fs::write(&open, b"").unwrap();
        guest.write_all(&frame(b"hello")).unwrap();
        proxy.read_exact(&mut answer).unwrap();
        assert_eq!(answer.to_vec(), frame(b"hello"));
        proxy.write_all(&frame(b"reply")).unwrap();
        guest.read_exact(&mut answer).unwrap();
        assert_eq!(answer.to_vec(), frame(b"reply"));

        fs::remove_file(&open).unwrap();
        guest.write_all(&frame(b"again closed")).unwrap();
        assert!(proxy.read_exact(&mut answer).is_err());

        fs::write(&open, b"").unwrap();
        let oversized = u32::try_from(LIMIT + 1).unwrap().to_be_bytes();
        guest.write_all(&oversized).unwrap();
        let mut end = Vec::new();
        proxy.set_read_timeout(None).unwrap();
        assert_eq!(proxy.read_to_end(&mut end).unwrap(), 0);
        fs::remove_file(&open).unwrap();
    }
}
