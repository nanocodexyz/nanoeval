use std::{
    fs::File,
    process::{Command, Stdio},
};

#[test]
fn an_unwritable_stderr_does_not_panic() {
    let full = File::options().write(true).open("/dev/full").unwrap();
    let status = Command::new(env!("CARGO_BIN_EXE_nanoeval-net"))
        .arg("unknown")
        .stderr(Stdio::from(full))
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(125));
}
