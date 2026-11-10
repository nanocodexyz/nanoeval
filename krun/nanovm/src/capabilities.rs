use crate::VmError;

const FIRMWARE: &str = "libkrunfw.so.5";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Capabilities {
    max_vcpus: u32,
}

impl Capabilities {
    pub fn detect() -> Result<Self, VmError> {
        let status = krun::krun_get_max_vcpus();
        let max_vcpus = u32::try_from(status).map_err(|_| VmError::Libkrun {
            errno: status.saturating_neg(),
            operation: "query maximum vCPUs",
        })?;
        unsafe { libloading::Library::new(FIRMWARE) }
            .map_err(|source| VmError::Firmware(source.to_string()))?;
        Ok(Self { max_vcpus })
    }

    #[must_use]
    pub const fn max_vcpus(&self) -> u32 {
        self.max_vcpus
    }
}
