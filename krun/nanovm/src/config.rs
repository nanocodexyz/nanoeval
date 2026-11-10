use std::{
    os::fd::RawFd,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RootFilesystem {
    Directory { path: PathBuf, read_only: bool },
    Ext4(PathBuf),
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Network {
    Disabled,
    #[default]
    Internet,
    Proxy(RawFd),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BlockDevice {
    id: String,
    path: PathBuf,
    read_only: bool,
}

impl BlockDevice {
    pub fn read_write(id: impl Into<String>, path: impl Into<PathBuf>) -> Self {
        Self {
            id: id.into(),
            path: path.into(),
            read_only: false,
        }
    }

    pub fn read_only(id: impl Into<String>, path: impl Into<PathBuf>) -> Self {
        Self {
            id: id.into(),
            path: path.into(),
            read_only: true,
        }
    }

    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    #[must_use]
    pub const fn is_read_only(&self) -> bool {
        self.read_only
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SharedDirectory {
    path: PathBuf,
    read_only: bool,
    tag: String,
}

impl SharedDirectory {
    pub fn read_only(tag: impl Into<String>, path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            read_only: true,
            tag: tag.into(),
        }
    }

    pub fn read_write(tag: impl Into<String>, path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            read_only: false,
            tag: tag.into(),
        }
    }

    #[must_use]
    pub fn tag(&self) -> &str {
        &self.tag
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    #[must_use]
    pub const fn is_read_only(&self) -> bool {
        self.read_only
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VsockPort {
    listens: bool,
    path: PathBuf,
    port: u32,
}

impl VsockPort {
    pub fn guest_connects(port: u32, path: impl Into<PathBuf>) -> Self {
        Self {
            listens: false,
            path: path.into(),
            port,
        }
    }

    pub fn guest_listens(port: u32, path: impl Into<PathBuf>) -> Self {
        Self {
            listens: true,
            path: path.into(),
            port,
        }
    }

    #[must_use]
    pub const fn guest_listens_value(&self) -> bool {
        self.listens
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    #[must_use]
    pub const fn port(&self) -> u32 {
        self.port
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VmConfig {
    block_devices: Vec<BlockDevice>,
    cpus: u8,
    memory_mib: u32,
    network: Network,
    root: RootFilesystem,
    shared_directories: Vec<SharedDirectory>,
    vsock_ports: Vec<VsockPort>,
}

impl VmConfig {
    #[must_use]
    pub fn new(root: RootFilesystem) -> Self {
        Self {
            block_devices: Vec::new(),
            cpus: 2,
            memory_mib: 1_024,
            network: Network::Internet,
            root,
            shared_directories: Vec::new(),
            vsock_ports: Vec::new(),
        }
    }

    #[must_use]
    pub fn cpus(mut self, cpus: u8) -> Self {
        self.cpus = cpus;
        self
    }

    #[must_use]
    pub fn memory_mib(mut self, memory_mib: u32) -> Self {
        self.memory_mib = memory_mib;
        self
    }

    #[must_use]
    pub fn network(mut self, network: Network) -> Self {
        self.network = network;
        self
    }

    #[must_use]
    pub fn shared_directory(mut self, directory: SharedDirectory) -> Self {
        self.shared_directories.push(directory);
        self
    }

    #[must_use]
    pub fn block_device(mut self, device: BlockDevice) -> Self {
        self.block_devices.push(device);
        self
    }

    #[must_use]
    pub fn vsock_port(mut self, port: VsockPort) -> Self {
        self.vsock_ports.push(port);
        self
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        match &self.root {
            RootFilesystem::Directory { path, .. } | RootFilesystem::Ext4(path) => path,
        }
    }

    #[must_use]
    pub const fn root_filesystem(&self) -> &RootFilesystem {
        &self.root
    }

    #[must_use]
    pub const fn cpus_value(&self) -> u8 {
        self.cpus
    }

    #[must_use]
    pub const fn memory_mib_value(&self) -> u32 {
        self.memory_mib
    }

    #[must_use]
    pub const fn network_value(&self) -> Network {
        self.network
    }

    #[must_use]
    pub fn shared_directories(&self) -> &[SharedDirectory] {
        &self.shared_directories
    }

    #[must_use]
    pub fn block_devices(&self) -> &[BlockDevice] {
        &self.block_devices
    }

    #[must_use]
    pub fn vsock_ports(&self) -> &[VsockPort] {
        &self.vsock_ports
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory(path: &str) -> RootFilesystem {
        RootFilesystem::Directory {
            path: PathBuf::from(path),
            read_only: false,
        }
    }

    #[test]
    fn defaults_are_suitable_for_a_small_worker() {
        let config = VmConfig::new(directory("rootfs"));

        assert_eq!(config.root(), Path::new("rootfs"));
        assert_eq!(config.cpus_value(), 2);
        assert_eq!(config.memory_mib_value(), 1_024);
        assert_eq!(config.network_value(), Network::Internet);
    }

    #[test]
    fn policy_is_explicitly_overridable() {
        let config = VmConfig::new(directory("rootfs"))
            .cpus(8)
            .memory_mib(4_096)
            .network(Network::Disabled);

        assert_eq!(config.cpus_value(), 8);
        assert_eq!(config.memory_mib_value(), 4_096);
        assert_eq!(config.network_value(), Network::Disabled);
    }

    #[test]
    fn raw_ext4_is_an_explicit_root_kind() {
        let config = VmConfig::new(RootFilesystem::Ext4(PathBuf::from("rootfs.ext4")));

        assert_eq!(config.root(), Path::new("rootfs.ext4"));
        assert_eq!(
            config.root_filesystem(),
            &RootFilesystem::Ext4(PathBuf::from("rootfs.ext4"))
        );
    }

    #[test]
    fn share_and_block_device_mutability_is_explicit() {
        let config = VmConfig::new(directory("boot"))
            .shared_directory(SharedDirectory::read_only("rt", "runtime"))
            .shared_directory(SharedDirectory::read_write("io", "exchange"))
            .block_device(BlockDevice::read_only("lower", "lower.ext4"))
            .block_device(BlockDevice::read_write("upper", "upper.ext4"));

        assert!(config.shared_directories()[0].is_read_only());
        assert!(!config.shared_directories()[1].is_read_only());
        assert_eq!(config.shared_directories()[1].tag(), "io");
        assert!(config.block_devices()[0].is_read_only());
        assert!(!config.block_devices()[1].is_read_only());
        assert_eq!(config.block_devices()[1].id(), "upper");
    }

    #[test]
    fn a_vsock_port_names_its_host_socket() {
        let config =
            VmConfig::new(directory("boot")).vsock_port(VsockPort::guest_listens(1_024, "vm.sock"));

        assert_eq!(config.vsock_ports()[0].port(), 1_024);
        assert_eq!(config.vsock_ports()[0].path(), Path::new("vm.sock"));
        assert!(config.vsock_ports()[0].guest_listens_value());
    }

    #[test]
    fn a_vsock_port_the_guest_connects_to_is_explicit() {
        let config = VmConfig::new(directory("boot"))
            .network(Network::Proxy(3))
            .vsock_port(VsockPort::guest_connects(1_025, "relay.sock"));

        assert_eq!(config.network_value(), Network::Proxy(3));
        assert!(!config.vsock_ports()[0].guest_listens_value());
    }
}
