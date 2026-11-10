use std::{
    fs::OpenOptions,
    io::{self, Read},
    os::unix::fs::OpenOptionsExt,
};

const KILLED: &str = "Out of memory: Killed process";
const LOG: &str = "/dev/kmsg";

pub(crate) fn oom_kills() -> io::Result<usize> {
    let mut log = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NONBLOCK)
        .open(LOG)?;
    let mut record = [0_u8; 8192];
    let mut kills = 0;
    loop {
        match log.read(&mut record) {
            Ok(0) => return Ok(kills),
            Ok(length) => kills += usize::from(killed(&record[..length])),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(kills),
            Err(error) if error.raw_os_error() == Some(nix::libc::EPIPE) => {}
            Err(error) => return Err(error),
        }
    }
}

fn killed(record: &[u8]) -> bool {
    String::from_utf8_lossy(record)
        .split_once(';')
        .is_some_and(|(_, message)| message.starts_with(KILLED))
}

#[cfg(test)]
mod tests {
    use super::killed;

    #[test]
    fn only_the_record_of_a_kill_counts() {
        assert!(killed(
            b"3,412,23395736,-;Out of memory: Killed process 459 (sh) total-vm:267884kB\n"
        ));
        assert!(!killed(
            b"4,411,23395724,-;oom-kill:constraint=CONSTRAINT_NONE,task=sh,pid=459,uid=0\n"
        ));
        assert!(!killed(b"6,1,0,-;Linux version 6.12.91\n"));
        assert!(!killed(b"Out of memory: Killed process 1"));
    }
}
