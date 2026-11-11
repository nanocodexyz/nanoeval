use std::{fs::File, io, os::fd::AsRawFd};

use net::forward::{self, Forward};
use nix::sys::socket::{AddressFamily, SockFlag, SockType, VsockAddr, connect, socket};

use crate::{namespace, step};

fn host() -> io::Result<File> {
    if namespace::active() {
        return namespace::relay();
    }
    let socket = step(
        "create the relay socket",
        socket(
            AddressFamily::Vsock,
            SockType::Stream,
            SockFlag::SOCK_CLOEXEC,
            None,
        ),
    )?;
    step(
        "reach the relay of this slot",
        connect(
            socket.as_raw_fd(),
            &VsockAddr::new(nix::libc::VMADDR_CID_HOST, wire::RELAY_PORT),
        ),
    )?;
    Ok(File::from(socket))
}

pub(crate) fn listen<'a>(targets: impl Iterator<Item = &'a [u8]>) -> io::Result<Vec<Forward>> {
    targets
        .map(|target| forward::listen(forward::target(target)?, host))
        .collect()
}
