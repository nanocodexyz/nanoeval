#![expect(
    unsafe_code,
    reason = "the libkrun binding requires a small audited FFI boundary"
)]

mod capabilities;
mod command;
mod config;
mod krun;

pub use capabilities::Capabilities;
pub use command::GuestCommand;
pub use config::{BlockDevice, Network, RootFilesystem, SharedDirectory, VmConfig, VsockPort};
pub use krun::{KrunVm, VmError};
