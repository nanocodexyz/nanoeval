use std::fmt;

use serde::Deserialize;

const ARM64_VARIANT: &str = "v8";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub(crate) struct Platform {
    pub(crate) architecture: String,
    pub(crate) os: String,
    #[serde(default)]
    pub(crate) variant: Option<String>,
}

impl Platform {
    pub(crate) fn host() -> Result<Self, String> {
        let architecture = match std::env::consts::ARCH {
            "aarch64" => "arm64",
            "x86_64" => "amd64",
            other => return Err(format!("no image platform is known for {other}")),
        };
        Ok(Self {
            architecture: architecture.to_owned(),
            os: "linux".to_owned(),
            variant: None,
        })
    }

    pub(crate) fn parse(text: &str) -> Result<Self, String> {
        let mut parts = text.split('/');
        match (parts.next(), parts.next(), parts.next(), parts.next()) {
            (Some(os), Some(architecture), variant, None)
                if !os.is_empty() && !architecture.is_empty() =>
            {
                Ok(Self {
                    architecture: architecture.to_owned(),
                    os: os.to_owned(),
                    variant: variant.map(str::to_owned),
                })
            }
            _ => Err(format!("a platform is OS/ARCHITECTURE[/VARIANT]: {text}")),
        }
    }

    fn variant(&self) -> Option<&str> {
        match (self.architecture.as_str(), self.variant.as_deref()) {
            ("arm64", None) => Some(ARM64_VARIANT),
            (_, variant) => variant,
        }
    }

    pub(crate) fn runs(&self, other: &Self) -> bool {
        self.os == other.os
            && self.architecture == other.architecture
            && (other.variant.is_none() || self.variant() == other.variant())
    }
}

impl fmt::Display for Platform {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}/{}", self.os, self.architecture)?;
        match &self.variant {
            Some(variant) => write!(formatter, "/{variant}"),
            None => Ok(()),
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub(crate) struct Descriptor {
    pub(crate) digest: String,
    #[serde(default, rename = "mediaType")]
    pub(crate) media_type: String,
    #[serde(default)]
    pub(crate) platform: Option<Platform>,
    pub(crate) size: u64,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Index {
    pub(crate) manifests: Vec<Descriptor>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Manifest {
    pub(crate) config: Descriptor,
    pub(crate) layers: Vec<Descriptor>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub(crate) struct Container {
    #[serde(default)]
    pub(crate) cmd: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) entrypoint: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) env: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) user: Option<String>,
    #[serde(default)]
    pub(crate) working_dir: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct RootFs {
    pub(crate) diff_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ImageConfig {
    pub(crate) architecture: String,
    #[serde(default)]
    pub(crate) config: Option<Container>,
    pub(crate) os: String,
    pub(crate) rootfs: RootFs,
    #[serde(default)]
    pub(crate) variant: Option<String>,
}

pub(crate) enum Document {
    Index(Index),
    Manifest(Manifest),
}

#[derive(Deserialize)]
struct Shape {
    #[serde(default)]
    layers: Option<serde_json::Value>,
    #[serde(default)]
    manifests: Option<serde_json::Value>,
    #[serde(default, rename = "schemaVersion")]
    schema_version: u64,
}

pub(crate) fn document(body: &[u8]) -> Result<Document, String> {
    let invalid = |error: serde_json::Error| format!("the manifest is not valid: {error}");
    let shape: Shape = serde_json::from_slice(body).map_err(invalid)?;
    if shape.schema_version != 2 {
        return Err(format!(
            "image manifest schema {} is not supported",
            shape.schema_version
        ));
    }
    if shape.manifests.is_some() {
        serde_json::from_slice(body)
            .map(Document::Index)
            .map_err(invalid)
    } else if shape.layers.is_some() {
        serde_json::from_slice(body)
            .map(Document::Manifest)
            .map_err(invalid)
    } else {
        Err("the manifest lists neither manifests nor layers".to_owned())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Compression {
    Gzip,
    None,
    Zstd,
}

pub(crate) fn compression(media_type: &str) -> Result<Compression, String> {
    match media_type {
        "application/vnd.docker.image.rootfs.diff.tar.gzip"
        | "application/vnd.oci.image.layer.v1.tar+gzip" => Ok(Compression::Gzip),
        "application/vnd.docker.image.rootfs.diff.tar"
        | "application/vnd.oci.image.layer.v1.tar" => Ok(Compression::None),
        "application/vnd.docker.image.rootfs.diff.tar.zstd"
        | "application/vnd.oci.image.layer.v1.tar+zstd" => Ok(Compression::Zstd),
        other => Err(format!("layer media type {other} is not supported")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_index_and_a_manifest_are_told_apart_by_shape() {
        let index = br#"{"schemaVersion":2,"manifests":[{"digest":"sha256:a","size":1,"platform":{"architecture":"amd64","os":"linux"}}]}"#;
        let manifest = br#"{"schemaVersion":2,"mediaType":"application/vnd.docker.distribution.manifest.v2+json","config":{"digest":"sha256:c","size":2},"layers":[{"digest":"sha256:l","size":3,"mediaType":"application/vnd.oci.image.layer.v1.tar+zstd"}]}"#;
        assert!(matches!(document(index), Ok(Document::Index(_))));
        let Ok(Document::Manifest(manifest)) = document(manifest) else {
            panic!("not a manifest");
        };
        assert_eq!(
            compression(&manifest.layers[0].media_type),
            Ok(Compression::Zstd)
        );
    }

    #[test]
    fn schema_one_and_foreign_layers_are_refused_by_name() {
        assert_eq!(
            document(br#"{"schemaVersion":1,"fsLayers":[]}"#).err(),
            Some("image manifest schema 1 is not supported".to_owned())
        );
        assert!(
            compression("application/vnd.docker.image.rootfs.foreign.diff.tar.gzip")
                .unwrap_err()
                .contains("foreign")
        );
    }

    #[test]
    fn a_platform_without_a_variant_runs_any_variant_of_its_architecture() {
        let wanted = Platform::parse("linux/arm64").unwrap();
        let offered = Platform::parse("linux/arm64/v8").unwrap();
        assert!(offered.runs(&wanted));
        assert!(wanted.runs(&offered));
        assert!(!Platform::parse("linux/amd64").unwrap().runs(&wanted));
        assert!(Platform::parse("linux").is_err());
        assert_eq!(offered.to_string(), "linux/arm64/v8");
    }
}
