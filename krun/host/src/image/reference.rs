const DOCKER_HUB: &str = "registry-1.docker.io";
const DOCKER_NAMES: [&str; 2] = ["docker.io", "index.docker.io"];
const LATEST: &str = "latest";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Reference {
    pub(crate) digest: Option<String>,
    pub(crate) registry: String,
    pub(crate) repository: String,
    pub(crate) tag: Option<String>,
}

pub(crate) fn valid_digest(digest: &str) -> bool {
    digest.strip_prefix("sha256:").is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

impl Reference {
    pub(crate) fn parse(text: &str) -> Result<Self, String> {
        let invalid = || format!("invalid image reference: {text}");
        let (name, digest) = match text.split_once('@') {
            Some((name, digest)) => (name, Some(digest)),
            None => (text, None),
        };
        if digest.is_some_and(|digest| !valid_digest(digest)) {
            return Err(invalid());
        }
        let (name, tag) = match name.rsplit_once(':') {
            Some((name, tag)) if !tag.contains('/') => (name, Some(tag)),
            _ => (name, None),
        };
        let (registry, repository) = match name.split_once('/') {
            Some((host, rest))
                if host.contains('.') || host.contains(':') || host == "localhost" =>
            {
                (host, rest.to_owned())
            }
            _ => (DOCKER_NAMES[0], name.to_owned()),
        };
        let hub = DOCKER_NAMES.contains(&registry);
        let repository = if hub && !repository.contains('/') {
            format!("library/{repository}")
        } else {
            repository
        };
        let named = repository.split('/').all(|part| {
            !part.is_empty()
                && part.bytes().all(|byte| {
                    byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte)
                })
        });
        let tagged = tag.is_none_or(|tag| {
            !tag.is_empty()
                && tag
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        });
        if !named || !tagged {
            return Err(invalid());
        }
        Ok(Self {
            digest: digest.map(str::to_owned),
            registry: if hub { DOCKER_HUB } else { registry }.to_owned(),
            repository,
            tag: tag.map(str::to_owned),
        })
    }

    pub(crate) fn target(&self) -> &str {
        self.digest
            .as_deref()
            .or(self.tag.as_deref())
            .unwrap_or(LATEST)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(text: &str) -> (String, String, String) {
        let reference = Reference::parse(text).unwrap();
        (
            reference.registry.clone(),
            reference.repository.clone(),
            reference.target().to_owned(),
        )
    }

    #[test]
    fn docker_hub_names_gain_their_registry_and_library() {
        assert_eq!(
            parsed("alpine:3.21"),
            (
                "registry-1.docker.io".into(),
                "library/alpine".into(),
                "3.21".into()
            )
        );
        assert_eq!(
            parsed("docker.io/alexgshaw/build-pmars"),
            (
                "registry-1.docker.io".into(),
                "alexgshaw/build-pmars".into(),
                "latest".into()
            )
        );
    }

    #[test]
    fn other_registries_keep_their_host_and_port() {
        assert_eq!(
            parsed("ghcr.io/astral-sh/uv:0.8.14"),
            ("ghcr.io".into(), "astral-sh/uv".into(), "0.8.14".into())
        );
        assert_eq!(
            parsed("localhost:5000/tasks/a"),
            ("localhost:5000".into(), "tasks/a".into(), "latest".into())
        );
    }

    #[test]
    fn a_digest_wins_over_a_tag() {
        let digest = format!("sha256:{}", "ab".repeat(32));
        let reference = Reference::parse(&format!("python:3.13@{digest}")).unwrap();
        assert_eq!(reference.tag.as_deref(), Some("3.13"));
        assert_eq!(reference.target(), digest);
    }

    #[test]
    fn malformed_references_are_refused() {
        for text in ["", "Alpine", "alpine:", "alpine@sha256:12", "a//b", "a b"] {
            assert!(Reference::parse(text).is_err(), "{text}");
        }
    }
}
