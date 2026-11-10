use std::{
    ffi::{CStr, CString, NulError, OsStr, c_char},
    fmt, io,
    os::{fd::AsRawFd, unix::ffi::OsStrExt},
    path::PathBuf,
    ptr,
};

use crate::{
    BlockDevice, GuestCommand, Network, RootFilesystem, SharedDirectory, VmConfig, VsockPort,
};

const EXT4_FILESYSTEM: &CStr = c"ext4";
const ROOT_BLOCK_DEVICE: &CStr = c"/dev/vda";
const ROOT_BLOCK_ID: &CStr = c"vda";
const ROOT_TAG: &CStr = c"/dev/root";
const TSI_HIJACK_INET: u32 = 1;

#[derive(Debug)]
pub enum VmError {
    BlockDeviceNotFile(PathBuf),
    ContextConsumed,
    Firmware(String),
    InvalidConfig(&'static str),
    Libkrun {
        errno: i32,
        operation: &'static str,
    },
    Nul {
        field: &'static str,
        source: NulError,
    },
    Resolve {
        path: PathBuf,
        source: io::Error,
    },
    RootNotDirectory(PathBuf),
    RootNotFile(PathBuf),
    SharedDirectoryNotDirectory(PathBuf),
    UnexpectedReturn,
}

impl fmt::Display for VmError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BlockDeviceNotFile(path) => {
                write!(formatter, "block device is not a file: {}", path.display())
            }
            Self::ContextConsumed => {
                formatter.write_str("the libkrun context has already entered the VM")
            }
            Self::Firmware(message) => {
                write!(formatter, "the libkrunfw firmware did not load: {message}")
            }
            Self::InvalidConfig(message) => {
                write!(formatter, "invalid VM configuration: {message}")
            }
            Self::Libkrun { errno, operation } => {
                write!(formatter, "libkrun {operation} failed with errno {errno}")
            }
            Self::Nul { field, .. } => write!(formatter, "{field} contains a NUL byte"),
            Self::Resolve { path, source } => {
                write!(formatter, "failed to resolve {}: {source}", path.display())
            }
            Self::RootNotDirectory(path) => write!(
                formatter,
                "root filesystem is not a directory: {}",
                path.display()
            ),
            Self::RootNotFile(path) => {
                write!(formatter, "root disk is not a file: {}", path.display())
            }
            Self::SharedDirectoryNotDirectory(path) => write!(
                formatter,
                "shared directory is not a directory: {}",
                path.display()
            ),
            Self::UnexpectedReturn => formatter.write_str("libkrun returned after starting the VM"),
        }
    }
}

impl std::error::Error for VmError {}

pub struct KrunVm {
    context: Option<u32>,
}

impl KrunVm {
    pub fn new(config: &VmConfig) -> Result<Self, VmError> {
        if config.cpus_value() == 0 {
            return Err(VmError::InvalidConfig("CPU count must be nonzero"));
        }
        if config.memory_mib_value() == 0 {
            return Err(VmError::InvalidConfig("memory must be nonzero"));
        }

        let root = config
            .root()
            .canonicalize()
            .map_err(|source| VmError::Resolve {
                path: config.root().to_path_buf(),
                source,
            })?;
        match config.root_filesystem() {
            RootFilesystem::Directory { .. } if !root.is_dir() => {
                return Err(VmError::RootNotDirectory(root));
            }
            RootFilesystem::Ext4(_) if !root.is_file() => {
                return Err(VmError::RootNotFile(root));
            }
            RootFilesystem::Directory { .. } | RootFilesystem::Ext4(_) => {}
        }

        let context = positive_context(krun::krun_create_ctx(), "create context")?;
        let vm = Self {
            context: Some(context),
        };

        check(
            krun::krun_set_vm_config(context, config.cpus_value(), config.memory_mib_value()),
            "configure VM",
        )?;

        let root = c_string(root.as_os_str(), "root filesystem path")?;
        match config.root_filesystem() {
            RootFilesystem::Directory { read_only, .. } => {
                check(
                    unsafe {
                        krun::krun_add_virtiofs3(
                            context,
                            ROOT_TAG.as_ptr(),
                            root.as_ptr(),
                            0,
                            *read_only,
                        )
                    },
                    "attach root filesystem",
                )?;
            }
            RootFilesystem::Ext4(_) => {
                check(
                    unsafe {
                        krun::krun_add_disk(context, ROOT_BLOCK_ID.as_ptr(), root.as_ptr(), false)
                    },
                    "attach root disk",
                )?;
                check(
                    unsafe {
                        krun::krun_set_root_disk_remount(
                            context,
                            ROOT_BLOCK_DEVICE.as_ptr(),
                            EXT4_FILESYSTEM.as_ptr(),
                            ptr::null(),
                        )
                    },
                    "select root disk",
                )?;
            }
        }

        attach_block_devices(context, config.block_devices())?;
        attach_shared_directories(context, config.shared_directories())?;

        let stdin = io::stdin();
        let stdout = io::stdout();
        let stderr = io::stderr();
        check(
            unsafe {
                krun::krun_add_virtio_console_default(
                    context,
                    stdin.as_raw_fd(),
                    stdout.as_raw_fd(),
                    stderr.as_raw_fd(),
                )
            },
            "attach console",
        )?;

        attach_network(context, config.network_value(), config.vsock_ports())?;
        check(
            krun::krun_split_irqchip(context, false),
            "configure interrupt controller",
        )?;

        Ok(vm)
    }

    pub fn run(mut self, command: &GuestCommand) -> Result<(), VmError> {
        let executable = c_string(command.program().as_os_str(), "guest executable")?;
        let arguments = command
            .arguments()
            .iter()
            .map(|argument| c_string(argument, "guest argument"))
            .collect::<Result<Vec<_>, _>>()?;
        let mut argument_pointers = arguments
            .iter()
            .map(|argument| argument.as_ptr())
            .collect::<Vec<_>>();
        argument_pointers.push(ptr::null());
        let environment = command
            .environment()
            .iter()
            .map(|(name, value)| {
                let mut entry = name.clone();
                entry.push("=");
                entry.push(value);
                c_string(&entry, "guest environment")
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut environment_pointers = environment
            .iter()
            .map(|entry| entry.as_ptr())
            .collect::<Vec<_>>();
        environment_pointers.push(ptr::null::<c_char>());
        let context = self.context.ok_or(VmError::ContextConsumed)?;

        check(
            unsafe {
                krun::krun_set_exec(
                    context,
                    executable.as_ptr(),
                    argument_pointers.as_ptr(),
                    environment_pointers.as_ptr(),
                )
            },
            "configure guest command",
        )?;
        let current_dir = c_string(
            command.current_directory().as_os_str(),
            "guest working directory",
        )?;
        check(
            unsafe { krun::krun_set_workdir(context, current_dir.as_ptr()) },
            "configure guest working directory",
        )?;

        self.context = None;
        check(krun::krun_start_enter(context), "start VM")?;
        Err(VmError::UnexpectedReturn)
    }
}

fn attach_network(context: u32, network: Network, ports: &[VsockPort]) -> Result<(), VmError> {
    match network {
        Network::Disabled if ports.is_empty() => return Ok(()),
        Network::Disabled => check(krun::krun_add_vsock(context, 0), "attach vsock")?,
        Network::Internet => {
            check(
                krun::krun_add_vsock(context, TSI_HIJACK_INET),
                "enable TSI networking",
            )?;
            let no_ports = [ptr::null::<c_char>()];
            check(
                unsafe { krun::krun_set_port_map(context, no_ports.as_ptr()) },
                "keep guest listeners off the host",
            )?;
        }
    }
    for port in ports {
        let path = c_string(port.path().as_os_str(), "vsock socket path")?;
        check(
            unsafe { krun::krun_add_vsock_port2(context, port.port(), path.as_ptr(), true) },
            "map vsock port",
        )?;
    }
    Ok(())
}

fn attach_block_devices(context: u32, devices: &[BlockDevice]) -> Result<(), VmError> {
    for device in devices {
        let path = device
            .path()
            .canonicalize()
            .map_err(|source| VmError::Resolve {
                path: device.path().to_path_buf(),
                source,
            })?;
        if !path.is_file() {
            return Err(VmError::BlockDeviceNotFile(path));
        }
        let id = c_string(OsStr::new(device.id()), "block device ID")?;
        let path = c_string(path.as_os_str(), "block device path")?;
        check(
            unsafe {
                krun::krun_add_disk(context, id.as_ptr(), path.as_ptr(), device.is_read_only())
            },
            "attach block device",
        )?;
    }
    Ok(())
}

fn attach_shared_directories(context: u32, directories: &[SharedDirectory]) -> Result<(), VmError> {
    for directory in directories {
        let path = directory
            .path()
            .canonicalize()
            .map_err(|source| VmError::Resolve {
                path: directory.path().to_path_buf(),
                source,
            })?;
        if !path.is_dir() {
            return Err(VmError::SharedDirectoryNotDirectory(path));
        }
        let tag = c_string(OsStr::new(directory.tag()), "shared directory tag")?;
        let path = c_string(path.as_os_str(), "shared directory path")?;
        check(
            unsafe {
                krun::krun_add_virtiofs3(
                    context,
                    tag.as_ptr(),
                    path.as_ptr(),
                    0,
                    directory.is_read_only(),
                )
            },
            "attach shared directory",
        )?;
    }
    Ok(())
}

impl Drop for KrunVm {
    fn drop(&mut self) {
        if let Some(context) = self.context.take() {
            let _ = krun::krun_free_ctx(context);
        }
    }
}

fn c_string(value: &OsStr, field: &'static str) -> Result<CString, VmError> {
    CString::new(value.as_bytes()).map_err(|source| VmError::Nul { field, source })
}

fn positive_context(status: i32, operation: &'static str) -> Result<u32, VmError> {
    u32::try_from(status).map_err(|_| VmError::Libkrun {
        errno: status.saturating_neg(),
        operation,
    })
}

fn check(status: i32, operation: &'static str) -> Result<(), VmError> {
    if status < 0 {
        Err(VmError::Libkrun {
            errno: status.saturating_neg(),
            operation,
        })
    } else {
        Ok(())
    }
}
