# A standing nanoeval runner for a Cloudflare Container (or any Linux VM without KVM).
# It runs ns slots: each row in its own mount, pid, ipc and uts namespace over an overlay
# of the task's environment disk, which needs root, loop devices and overlayfs from the
# kernel of the instance. container/probe.sh says whether an instance has them.
# Build from the repository root: docker build -f container/Dockerfile -t nanoeval-runner .

FROM rust:1.97.1-bookworm AS tools
RUN rustup target add "$(uname -m)-unknown-linux-musl" && apt-get update \
  && apt-get install -y --no-install-recommends musl-tools && rm -rf /var/lib/apt/lists/*
WORKDIR /src/krun
COPY krun/ ./
RUN target="$(uname -m)-unknown-linux-musl" \
  && cargo build --release --locked --target "$target" -p nanoeval-krun --no-default-features \
  && cargo build --release --locked --target "$target" -p nanoeval-krun-guest -p nanoeval-net \
  && mkdir /out && cp "target/$target/release/nanoeval-krun" "target/$target/release/nanoeval-krun-guest" \
     "target/$target/release/nanoeval-net" /out/

FROM node:24-bookworm-slim AS app
WORKDIR /opt/nanoeval
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY cli/ cli/
COPY sandbox/ sandbox/
COPY src/ src/
COPY datasets/ datasets/
COPY worker/ worker/
COPY tsconfig.json ./

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash ca-certificates coreutils curl e2fsprogs fuse3 iproute2 nftables procps tar \
    util-linux zstd \
  && rm -rf /var/lib/apt/lists/*
COPY --from=app /opt/nanoeval /opt/nanoeval
COPY --from=tools /out/ /opt/nanoeval/krun-bin/
COPY container/start.sh container/probe.sh /opt/nanoeval/container/
ENV NANOEVAL_KRUN=/opt/nanoeval/krun-bin NANOEVAL_HOME=/var/lib/nanoeval
WORKDIR /var/lib/nanoeval
ENTRYPOINT ["/opt/nanoeval/container/start.sh"]
