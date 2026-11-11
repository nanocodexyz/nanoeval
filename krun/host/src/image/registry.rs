use std::{
    collections::BTreeMap,
    env,
    fs::{self, File},
    io::{self, Seek, SeekFrom},
    path::PathBuf,
    sync::{Arc, Mutex, PoisonError},
    thread,
    time::Duration,
};

use sha2::{Digest, Sha256};
use ureq::{
    Agent, Body,
    http::Response,
    tls::{PemItem, RootCerts, TlsConfig, parse_pem},
};

use super::{
    failed, hex,
    reference::{Reference, valid_digest},
};

const ACCEPT: &str = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json";
const CA_BUNDLES: [&str; 3] = [
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/cert.pem",
];
const CA_VARIABLE: &str = "SSL_CERT_FILE";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const DOCUMENT_LIMIT: u64 = 4 * 1024 * 1024;
const RATE_LIMIT_POLL: Duration = Duration::from_mins(1);
const RATE_LIMIT_WINDOW: Duration = Duration::from_hours(6);
const RETRIES: u32 = 6;
const RETRY_DELAY: Duration = Duration::from_secs(1);
const STALL_TIMEOUT: Duration = Duration::from_mins(1);

#[derive(Clone, Copy)]
enum Method {
    Get,
    Head,
}

pub(crate) struct Registry {
    agent: Agent,
    tokens: Mutex<BTreeMap<String, String>>,
}

fn header<'a>(response: &'a Response<Body>, name: &str) -> Option<&'a str> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
}

fn fields(parameters: &str) -> BTreeMap<String, String> {
    let mut fields = BTreeMap::new();
    let mut rest = parameters;
    while let Some((key, after)) = rest.split_once('=') {
        let (value, tail) = match after.strip_prefix('"') {
            Some(quoted) => quoted.split_once('"').unwrap_or((quoted, "")),
            None => after.split_once(',').unwrap_or((after, "")),
        };
        fields.insert(key.trim().to_ascii_lowercase(), value.to_owned());
        rest = tail.trim_start_matches([',', ' ']);
    }
    fields
}

fn encode(text: &str) -> String {
    text.bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-._~:/".contains(&byte) {
                char::from(byte).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}

fn window(response: &Response<Body>) -> Duration {
    header(response, "ratelimit-limit")
        .and_then(|limit| limit.split(';').find_map(|part| part.strip_prefix("w=")))
        .and_then(|seconds| seconds.parse().ok())
        .map_or(RATE_LIMIT_WINDOW, Duration::from_secs)
}

impl Registry {
    pub(crate) fn new() -> Result<Self, String> {
        let bundle = env::var_os(CA_VARIABLE)
            .map(PathBuf::from)
            .or_else(|| {
                CA_BUNDLES
                    .iter()
                    .map(PathBuf::from)
                    .find(|path| path.is_file())
            })
            .ok_or_else(|| format!("no CA bundle was found: name one in {CA_VARIABLE}"))?;
        let pem = fs::read(&bundle).map_err(|error| failed(&bundle, &error))?;
        let certificates = parse_pem(&pem)
            .filter_map(|item| match item {
                Ok(PemItem::Certificate(certificate)) => Some(certificate),
                _ => None,
            })
            .collect::<Vec<_>>();
        if certificates.is_empty() {
            return Err(format!("{} holds no certificate", bundle.display()));
        }
        let tls = TlsConfig::builder()
            .root_certs(RootCerts::Specific(Arc::new(certificates)))
            .unversioned_rustls_crypto_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .build();
        let agent = Agent::config_builder()
            .http_status_as_error(false)
            .timeout_connect(Some(CONNECT_TIMEOUT))
            .timeout_recv_response(Some(STALL_TIMEOUT))
            .timeout_per_read(Some(STALL_TIMEOUT))
            .tls_config(tls)
            .build()
            .into();
        Ok(Self {
            agent,
            tokens: Mutex::new(BTreeMap::new()),
        })
    }

    fn once(
        &self,
        method: Method,
        url: &str,
        headers: &[(&str, &str)],
        token: Option<&str>,
    ) -> Result<Response<Body>, ureq::Error> {
        let mut request = match method {
            Method::Get => self.agent.get(url),
            Method::Head => self.agent.head(url),
        };
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        if let Some(token) = token {
            request = request.header("Authorization", format!("Bearer {token}"));
        }
        request.call()
    }

    fn token(&self, reference: &Reference, challenge: &str) -> Result<String, String> {
        let registry = &reference.registry;
        let parameters = challenge
            .get(..7)
            .filter(|scheme| scheme.eq_ignore_ascii_case("bearer "))
            .map(|_| &challenge[7..])
            .ok_or_else(|| format!("{registry} asks for credentials, which are never sent"))?;
        let fields = fields(parameters);
        let realm = fields
            .get("realm")
            .ok_or_else(|| format!("{registry} names no token service"))?;
        let scope = fields
            .get("scope")
            .cloned()
            .unwrap_or_else(|| format!("repository:{}:pull", reference.repository));
        let mut url = format!("{realm}?scope={}", encode(&scope));
        if let Some(service) = fields.get("service") {
            url = format!("{url}&service={}", encode(service));
        }
        let mut response = self
            .once(Method::Get, &url, &[], None)
            .map_err(|error| format!("{realm}: {error}"))?;
        if response.status().as_u16() != 200 {
            return Err(format!(
                "{realm} refused an anonymous token for {}: status {}",
                reference.repository,
                response.status().as_u16()
            ));
        }
        let body = response
            .body_mut()
            .with_config()
            .limit(DOCUMENT_LIMIT)
            .read_to_vec()
            .map_err(|error| format!("{realm}: {error}"))?;
        let answer: BTreeMap<String, serde_json::Value> =
            serde_json::from_slice(&body).map_err(|error| format!("{realm}: {error}"))?;
        ["token", "access_token"]
            .iter()
            .find_map(|name| answer.get(*name).and_then(serde_json::Value::as_str))
            .map(str::to_owned)
            .ok_or_else(|| format!("{realm} answered without a token"))
    }

    fn send(
        &self,
        reference: &Reference,
        method: Method,
        url: &str,
        headers: &[(&str, &str)],
    ) -> Result<Response<Body>, String> {
        let scope = format!("{}/{}", reference.registry, reference.repository);
        let mut challenged = false;
        let mut failures = 0;
        let mut limited = Duration::ZERO;
        loop {
            let token = self
                .tokens
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .get(&scope)
                .cloned();
            let failure = match self.once(method, url, headers, token.as_deref()) {
                Ok(response) => match response.status().as_u16() {
                    401 if !challenged => {
                        challenged = true;
                        let challenge = header(&response, "www-authenticate").unwrap_or_default();
                        let token = self.token(reference, challenge)?;
                        self.tokens
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .insert(scope.clone(), token);
                        continue;
                    }
                    429 => {
                        let window = window(&response);
                        if limited >= window {
                            return Err(format!(
                                "{} still limits anonymous pulls after {} s",
                                reference.registry,
                                limited.as_secs()
                            ));
                        }
                        let pause = header(&response, "retry-after")
                            .and_then(|seconds| seconds.parse().ok())
                            .map_or(RATE_LIMIT_POLL, Duration::from_secs);
                        eprintln!(
                            "nanoeval-krun: {} limits anonymous pulls, waiting {} s of at most {} s",
                            reference.registry,
                            pause.as_secs(),
                            window.as_secs()
                        );
                        thread::sleep(pause);
                        limited += pause;
                        continue;
                    }
                    status @ 500..=599 => format!("status {status}"),
                    _ => return Ok(response),
                },
                Err(error) => error.to_string(),
            };
            failures += 1;
            if failures > RETRIES {
                return Err(format!("{url}: {failure}"));
            }
            let pause = RETRY_DELAY * 2_u32.pow(failures - 1);
            eprintln!(
                "nanoeval-krun: {url}: {failure}, trying again in {} s",
                pause.as_secs()
            );
            thread::sleep(pause);
        }
    }

    fn url(reference: &Reference, kind: &str, target: &str) -> String {
        format!(
            "https://{}/v2/{}/{kind}/{target}",
            reference.registry, reference.repository
        )
    }

    pub(crate) fn manifest(&self, reference: &Reference, target: &str) -> Result<Vec<u8>, String> {
        let url = Self::url(reference, "manifests", target);
        let mut response = self.send(reference, Method::Get, &url, &[("Accept", ACCEPT)])?;
        if response.status().as_u16() != 200 {
            return Err(format!("{url}: status {}", response.status().as_u16()));
        }
        response
            .body_mut()
            .with_config()
            .limit(DOCUMENT_LIMIT)
            .read_to_vec()
            .map_err(|error| format!("{url}: {error}"))
    }

    pub(crate) fn resolve(&self, reference: &Reference) -> Result<String, String> {
        if let Some(digest) = &reference.digest {
            return Ok(digest.clone());
        }
        let url = Self::url(reference, "manifests", reference.target());
        let response = self.send(reference, Method::Head, &url, &[("Accept", ACCEPT)])?;
        if response.status().as_u16() != 200 {
            return Err(format!("{url}: status {}", response.status().as_u16()));
        }
        match header(&response, "docker-content-digest") {
            Some(digest) if valid_digest(digest) => Ok(digest.to_owned()),
            _ => {
                let body = self.manifest(reference, reference.target())?;
                Ok(format!("sha256:{}", hex(&Sha256::digest(&body))))
            }
        }
    }

    pub(crate) fn blob(
        &self,
        reference: &Reference,
        digest: &str,
        size: u64,
        mut part: &File,
    ) -> Result<(), String> {
        let url = Self::url(reference, "blobs", digest);
        let local = |error: io::Error| format!("{digest}: {error}");
        let mut failures = 0;
        loop {
            let offset = part.metadata().map_err(local)?.len();
            if offset == size {
                return Ok(());
            }
            let range = format!("bytes={offset}-");
            let headers = if offset > 0 && offset < size {
                vec![("Range", range.as_str())]
            } else {
                Vec::new()
            };
            let mut response = self.send(reference, Method::Get, &url, &headers)?;
            match response.status().as_u16() {
                200 => {
                    part.set_len(0).map_err(local)?;
                    part.seek(SeekFrom::Start(0)).map_err(local)?;
                }
                206 => {
                    part.seek(SeekFrom::End(0)).map_err(local)?;
                }
                status => return Err(format!("{url}: status {status}")),
            }
            let failure = match io::copy(&mut response.body_mut().as_reader(), &mut part) {
                Ok(_) => "the download ended early".to_owned(),
                Err(error) => error.to_string(),
            };
            let length = part.metadata().map_err(local)?.len();
            if length == size {
                return Ok(());
            }
            if length > size {
                return Err(format!("{url}: the blob is longer than its {size} bytes"));
            }
            failures += 1;
            if failures > RETRIES {
                return Err(format!("{url}: {failure}"));
            }
            let pause = RETRY_DELAY * 2_u32.pow(failures - 1);
            eprintln!(
                "nanoeval-krun: {url}: {failure} at byte {length}, resuming in {} s",
                pause.as_secs()
            );
            thread::sleep(pause);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bearer_challenge_is_split_into_its_fields() {
        let fields = fields(
            r#"realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/alpine:pull,push""#,
        );
        assert_eq!(fields["realm"], "https://auth.docker.io/token");
        assert_eq!(fields["service"], "registry.docker.io");
        assert_eq!(fields["scope"], "repository:library/alpine:pull,push");
    }

    #[test]
    fn a_scope_is_encoded_for_a_query() {
        assert_eq!(
            encode("repository:library/alpine:pull,push"),
            "repository:library/alpine:pull%2Cpush"
        );
    }
}
