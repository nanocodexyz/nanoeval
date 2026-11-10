# Design

nanoeval runs coding-agent evaluations with the agent harness outside the task sandbox. The orchestrator and every harness live in Cloudflare Workers on [nanocode-ts](https://github.com/nanocodexyz/nanocode-ts). Task environments live in remote sandboxes. Each sandbox is split into slots, and each slot runs one attempt behind its own nanocode hand.

It revives two earlier bodies of work:

- [gakonst/nanoeval](https://github.com/gakonst/nanoeval) (Rust, July 2026, last commit `10aed6b`): a library-first evaluator that kept the Nanocodex harness on the host and ran each attempt's tools in a disposable libkrun microVM.
- The eval stack in nanocode's history (`harbor_adapter/`, then `crates/experimental/nanocodex-eval` and `crates/nanocodex-vm`), removed from the tree in `2d4a4c539` (2026-10-13).

The microVM per attempt of both is back as the `krun` slot backend, described under [krun slots](#krun-slots).

## Shape

```
 nanoeval CLI ──HTTP──▶ Worker ──▶ Run (Durable Object, one per run)
                          │          ledger in SQLite: attempts, sandboxes, payments, artifacts
                          │          alarm-driven state machine, slot and memory admission
                          │
                          ├──▶ AgentSession (Durable Object, one per attempt)
                          │      nanocode-ts harness: model calls, Code Mode, journal
                          │                ▲
                          │                │ WebSocket, hand token (the hand dials out)
                          ▼                │
                 sandbox provider          │
            (E2B over MPP │ local) ──▶ sandbox ── slot.sh ──┬─ slot 1: task environment + nanocode hand
                 create, exec, write, kill                 ├─ slot 2: task environment + nanocode hand
                                                           └─ slot N …
```

| Piece | Where | Role |
| --- | --- | --- |
| `worker/index.ts` | Worker | Routes `/v1/runs` to a run and `/sessions` to nanocode-ts |
| `worker/Run.ts` | Durable Object | One run: ledger, admission, attempt state machine, results |
| `worker/Sessions.ts` | Durable Object | `App.create` from `nanocode-ts/cloudflare`: one harness session per attempt, model requests forwarded with the deployment's API key or plan login |
| `src/Sandbox.ts`, `src/Local.ts`, `src/E2b.ts` | Worker | The provider contract and its two providers |
| `src/Payment.ts`, `src/Budget.ts` | Worker | MPP charges through mppx, refused past the run's budget, recorded in the ledger |
| `sandbox/slot.sh` | Sandbox | The slot splitter: runtime setup, slot up, hand, verify, down, status |
| `sandbox/Sandboxd.ts` | Any machine | The local provider's daemon: makes one machine a sandbox host |
| `src/Task.ts`, `src/Atif.ts`, `src/Harbor.ts`, `src/Result.ts` | Worker and CLI | Harbor task loading, ATIF-v1.7 trajectories, Harbor job export, outcomes and pass@k |
| `cli/nanoeval.ts`, `cli/Plan.ts` | Node | Submit a run, read status and artifacts, export, serve `sandboxd`, start the Worker under local workerd with its credentials |

## Harness outside the sandbox

The harness is a nanocode-ts session in a Durable Object. The sandbox holds only the task environment and a hand. A hand is the nanocode process that runs an agent's Code Mode cells and tools on a machine, while inference, subagents and durability stay with the brain. The released `nanocode hand <url> --token <token>` binary dials the session's `/sessions/<name>/hands` WebSocket with a token that the session mints (`nch_…`), so the sandbox needs no inbound port.

This is the placement that `HARNESS_PLACEMENT.md` in gakonst/nanoeval argued for: model credentials and the authoritative event journal never enter the untrusted task environment, a lost sandbox is an environment error instead of a lost harness, and no agent CLI, Node runtime or CA bundle is installed into task images. In July 2026 this needed a custom guest (`nanocodex-vm-guest`) and a typed RPC over a virtio console. Today the hand protocol is that boundary, and nanoeval uses it unchanged.

## Attempt lifecycle

A run is `tasks × agents × attempts`. Each attempt is one row in the run's SQLite and moves through these phases. A phase advances on the run's alarm (`TICK_MS`), from one `status` call per sandbox.

| Phase | Entered when | Work |
| --- | --- | --- |
| `pending` | The run is created | Waits for a slot. Admission needs a free slot and memory at once (`src/Admission.ts`) |
| `up` | A sandbox admits it | The task archive is written to the slot. `slot.sh up` builds or pulls the environment in the background |
| `attach` | The environment is ready | The session mints a hand token. `slot.sh hand` starts the hand inside the slot |
| `run` | The hand is listed | The instruction is submitted as one turn on that hand. The agent deadline is `agent.timeout_sec` |
| `verify` | The turn completed, or its deadline passed and it was cancelled | The hand is stopped. `tests/` is copied in only now and `tests/test.sh` runs with `verifier.timeout_sec` |
| `done` | The verifier reported, or a failure ended the attempt | Events, trajectory and verifier output are stored. The slot is removed and the session deleted |

Long work (image builds, the hand, the verifier) runs detached in the sandbox and writes a status file. The orchestrator polls. No request holds a build open, and a restarted Durable Object continues from the ledger.

An oracle run has no model. Its one agent has the provider `oracle`, every task is sent with its `solution/`, and the `run` phase starts `solution/solve.sh` in the slot with `slot.sh solve` under the agent deadline, where a model run submits a turn. The hand still attaches first, so an oracle run also shows that the hand starts in each task image. The solution's output is kept as `agent/oracle.txt`.

Every attempt ends as `passed`, `failed` or `errored`, with the verifier reward kept beside it. A failure carries a kind: `agent`, `agent_timeout`, `verifier`, `verifier_timeout`, `environment`, `budget`, `cancelled` or `internal`. An agent timeout keeps its verifier reward, as Harbor does. Every other failure is an error with no reward, so an infrastructure failure never becomes a score of zero. Attempts are not retried.

## The slot splitter

`sandbox/slot.sh` packs N attempts into one sandbox. The orchestrator uploads it once per sandbox and calls it through the provider's `exec`. `probe` reports what the machine can isolate with (`docker`, `kvm`, `krun`, `userns`, `bwrap`, CPUs, memory). `kvm` says that `/dev/kvm` can be opened for reading and writing, and `krun` that the installed launcher reached KVM and loaded libkrunfw.

| Backend | Isolation | State |
| --- | --- | --- |
| `docker` | One container per slot from the task's `docker_image` or `environment/Dockerfile`, with task CPU and memory limits. The hand runs inside the container | Implemented, tested |
| `dir` | One directory per slot, no isolation. For development and tasks that need none | Implemented, tested |
| `krun` | One libkrun microVM per slot, as in gakonst/nanoeval and `crates/nanocodex-vm`. The task image is the root filesystem, the task's CPUs, memory and storage size the machine, and the hand runs inside it. Needs `/dev/kvm`, libkrunfw and Docker | Implemented, tested |
| `bwrap` | User namespaces and an overlay root, for sandboxes with neither Docker nor KVM | Planned |

The hand binary is a glibc build. `slot.sh setup` downloads the pinned release, checks its SHA-256, and copies the binary with its loader and libraries into one read-only directory. Each container or microVM mounts it and starts the hand through that loader, so the hand runs in musl images such as Alpine without a change to the task image.

An E2B sandbox is a Firecracker microVM, and Firecracker does not expose KVM to its guest. That is why the split is layered: `krun` slots on machines with KVM, `docker` slots inside E2B. Both are driven by the same script and the same hand.

## krun slots

A krun slot is one libkrun microVM. In gakonst/nanoeval the harness stayed on the host and a guest binary served four tools to it over a virtio console. Here the guest runs the released hand, which dials the attempt's session itself, so the tool proxy is gone and the guest binary only assembles the root filesystem and starts commands.

```
 host                                                    microVM, one per slot
 slot.sh ─ nanoeval-krun vm ─ libkrun ─────────────────▶ libkrun init (PID 1)
             vda  image.ext4, read-only, one per image    └ nanoeval-krun-guest
             vdb  upper.ext4, sparse, one per slot            overlay(vda, vdb) becomes /
             virtiofs rt, read-only: the hand, CA bundle      rt mounted at /opt/nanoeval
             virtiofs io: tests in, verifier logs out         vsock port 1024
 slot.sh ─ nanoeval-krun exec ─ vm.sock ─ vsock ───────▶ hand, solution, verifier
                                                           hand ─ ws://127.0.0.1 ─▶ Worker
```

| Piece | Runs | Role |
| --- | --- | --- |
| `krun/nanovm` | Host | The libkrun binding: one VM's disks, shares, vsock ports and command |
| `krun/host`, `nanoeval-krun` | Host | `vm` is the VMM process of one microVM. `exec`, `copy-in`, `copy-out`, `unpack`, `stop` and `ready` talk to a guest. `check` says whether this machine can start one |
| `krun/guest`, `nanoeval-krun-guest` | Guest | A static musl binary. Mounts the disks, pivots into the overlay, then serves requests on a vsock port |
| `krun/wire` | Both | The request and frame encoding of that port |

**Root filesystem.** `slot.sh up` builds or pulls the task image with Docker, as a Docker slot does. The image becomes a disk once: a builder microVM boots on an empty sparse ext4 of the task's `storage_mb`, `docker export` streams into it over vsock, and the guest unpacks the archive as root. Owners, modes, devices and links are therefore written by a kernel onto ext4, with no root and no fakeroot on the host. The disk is kept in `$NANOEVAL_CACHE/krun` (`~/.cache/nanoeval/krun`) under the image id and the storage size, beside the image's environment, working directory and user. Every slot attaches it read-only and adds a sparse ext4 of its own as the upper layer of an overlay that the guest mounts. Taking a slot down deletes that file.

**Commands.** libkrun's init stays PID 1 and reaps. The guest binary listens on a vsock port that libkrun maps to a UNIX socket in the slot directory. `nanoeval-krun exec` sends a command with its environment, user and working directory, streams output, and returns the exit code, which is what `docker exec` is to a Docker slot. A closed connection sends SIGTERM to that command, which is how a hand is stopped and how a timeout ends a solution or a verifier. `tests/` and `solution/` reach the guest through the `io` share only in their own phase and are copied into the root, so the agent never sees them and they are ordinary files when they run.

**Resources.** vCPUs are the task's `cpus` rounded up, memory is `memory_mb`, and the root can grow to `storage_mb`. They hold whatever `--limits` says. Admission is unchanged: a slot counts its task's declared memory. An idle guest costs the host far less, since libkrun backs guest memory on demand.

**Network.** A krun slot uses libkrun's TSI: the VMM makes the guest's sockets on the host. A connection to `127.0.0.1` that nothing in the guest listens on reaches the host's loopback, which is how the hand dials a local Worker over the plain `ws://` it only accepts for loopback. This is `--network host` for a microVM, and `bridge` is refused. Its limits are those of TSI:

- A listener in the guest is also bound on the host, with `SO_REUSEPORT`. Two guests may listen on one port, and each reaches its own listener first, but a guest or the host with no listener of its own on that port reaches another guest's.
- A guest cannot serve on a port the host keeps for root: a listener on port 80 did not come up, since the VMM is not root.
- Some socket options do not hold: a gRPC client fails with "Failed to set SO_REUSEADDR". ICMP and raw sockets do not exist.
- A connected UDP socket to a loopback address stays in the guest, so a resolver on the host's loopback is reached with `options use-vc`.

A private network per guest needs virtio-net with passt or gvproxy, and then a relay in the guest for a Worker on the host's loopback. That is planned, not built.

**What a guest gets that its image lacks.** `/opt/nanoeval`, as in a Docker slot. `/etc/resolv.conf` and `/etc/hosts` when the image leaves them empty, which `docker export` does. Nothing else: no agent, no shell, no init system.

## Sandbox providers

A provider creates a sandbox, runs a command in it, writes a file to it, and kills it (`src/Sandbox.ts`). Everything else goes through `slot.sh`, so a provider is small.

**Local.** `nanoeval sandboxd` serves a machine over HTTP with a bearer token. A sandbox is a directory. This is the single-machine mode of the earlier versions: one large machine, many slots.

A machine's network is host policy, and `sandboxd` passes it to the slots. `--ca-bundle FILE` mounts a certificate bundle into each slot container and names it in the variables that OpenSSL, curl, uv, pip, requests, Node, git and cargo read, for a network that re-signs TLS. `--slot-env FILE` starts each container with the variables of a file. Both change what the agent and the verifier see, so the sandbox's capabilities in the run's status record them as `ca_bundle` and `slot_env`. Neither is set by default.

Local Docker slots use the host network, because a hand accepts a plaintext `ws://` URL only on loopback. Slots on one machine therefore share its ports: an attempt cannot bind a port that another holds, and a verifier can reach another attempt's server. A slot with its own network stack, such as the planned `krun` backend, removes this.

**E2B over MPP.** `src/E2b.ts` talks to `https://mpp.e2b.dev`, whose bodies match E2B's REST API:

1. `POST /sandboxes {templateID, timeout, metadata}` answers `402` with `WWW-Authenticate: Payment …` challenges (`method="tempo"`, intents `charge` and `session`, amounts in base units of a six-decimal token).
2. `src/Payment.ts` builds the payer with mppx (`tempo.charge`). Its `onChallenge` hook reads the amount, charges the run's budget, signs the credential, and records the charge. A challenge over budget is refused before anything is signed.
3. The paid response carries `sandboxID` and `envdAccessToken`. Commands then go to envd at `https://49983-<id>.e2b.app/process.Process/Start` as a Connect server stream in JSON, and files to `/files`. That data plane is free.
4. `DELETE /sandboxes/<id>` is a paid request too.

E2B bills the requested lifetime up front and does not refund an early kill. Over MPP it serves only its public templates, so Docker and the hand are installed at run time (`--docker install`). CPU and memory are fixed by the template, which bounds the slots per sandbox.

The E2B JavaScript SDK is not used. It cannot pay, and it needs `nodejs_compat`. The envd protocol it wraps is two requests.

## Tasks and results

Tasks are Harbor task directories, schema 1.1, as Terminal-Bench 2.x ships them: `task.toml`, `instruction.md`, `environment/`, `tests/test.sh`. The verifier writes `/logs/verifier/reward.txt`. The CLI loads a directory and sends `tests/` with the run, and `environment/` when the task names no `docker_image`, since the image is then built from it. `solution/` leaves the machine only in an oracle run. The run stores a task's files in parts beside a small record of the task, so admission never reads the files. `environment.build_timeout_sec` bounds a task's environment setup when the task sets it. Tasks that need Compose, GPUs, a separate verifier environment or `allow_internet = false` are refused at submission.

`nanoeval export` writes a Harbor job directory: `result.json` for the job, and per trial `result.json`, `agent/trajectory.json` (ATIF-v1.7), `agent/events.jsonl` and `verifier/test-stdout.txt`. The CLI reads the result files in one request and each artifact in its own. Token counts and the harness's cost estimate come from the session's events, per attempt.

## Model credentials

The session sends a model request without a credential, and `worker/Sessions.ts` adds one in the `Forward` egress. With `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` it is the API key. With a plan login it is that plan's access token: `CLAUDE_CODE_OAUTH_TOKEN` for Claude, and `CHATGPT_ACCESS_TOKEN` with `CHATGPT_ACCOUNT_ID` for Codex, which make nanocode-ts open the session in its subscription mode for that provider. chatgpt.com refuses requests from workerd, so Codex plan requests go to the nanocode-egress relay (`CHATGPT_RELAY_URL`, `CHATGPT_RELAY_SECRET`), a Node process that forwards only the Codex Responses endpoints.

`nanoeval worker` fills these for local workerd. It reads the access token of `--claude-login` or `--codex-login` once at start, never the refresh token, starts the relay on a loopback port with a random secret, and hands every variable to wrangler in a mode 600 file in a private temporary directory that it removes on exit. It does not refresh a login: an expired one fails at the provider, and the attempt ends as an `agent` error.

## Budget and payments

A run carries `budget.sandboxUsd` and an optional `budget.modelUsd`. Every MPP charge is checked against the sandbox budget before it is signed and is written to the run's `payments` table with its challenge. Admission stops when the model spend of finished attempts reaches the model budget, and the remaining attempts end as `budget` errors. A sandbox whose creation was interrupted by an orchestrator restart is marked `unknown` and is not retried, since its payment may have happened.

## Rejected alternatives

| Alternative | Why not |
| --- | --- |
| The harness inside the task container (Harbor installed agent) | Credentials in untrusted environments. Task images need a runtime, a CA bundle and a CLI. A dead container takes the diagnostics with it |
| The Worker as a `WorkspaceHost` that calls the sandbox's exec API for each tool call | Loses the native hand's process sessions, PTYs and patch engine. One HTTP request per tool call instead of one WebSocket per attempt |
| Cloudflare Workflows or Queues for the attempt lifecycle | A run needs one writer for admission and payments. A Durable Object with an alarm is that writer, and it runs unchanged under local workerd |
| D1 and R2 for results | The ledger belongs to one run, so it lives in the run's SQLite. Artifacts are chunked there too. R2 is planned for large artifacts |
| The E2B SDK in the Worker | It cannot pay and needs `nodejs_compat` |
| MPP sessions for E2B | Charges need no channel state. Sessions are planned: one deposit, vouchers per request, the remainder refunded on close |
| One microVM per attempt everywhere | No KVM inside E2B. The backends are layered instead |
| crun or podman with the krun runtime, or krunvm | A second container engine and image store beside Docker, which here has only runc. krunvm manages images through buildah. Neither is installed where Docker is, and one more engine is one more thing every sandbox host must carry |
| Firecracker | A VMM executable with an API socket per VM, block devices only, and tap devices that need root. libkrun links into one unprivileged process and shares directories |
| The guest tool proxy of `nanocodex-vm` | It reimplemented `exec_command`, `write_stdin`, `apply_patch` and `view_image` in a guest. The released hand is that implementation now. Only a narrow exec port remains, for the hand, the solution and the verifier |
| A shared directory as the guest root, with a host overlayfs per slot | A host overlay mount needs root or a user namespace, and the machine it was tried on refuses unprivileged user namespace mappings. Files in a shared directory also belong to the unprivileged VMM user |
| A copy of the image per slot, as a tree or as a sparse ext4 copy | 0.3 to 1.0 s and 1 GB per slot for a 1 GB image, against 15 ms on an idle disk and 4 MB for an overlay upper disk |
| A qcow2 or device-mapper snapshot of the image | Device-mapper needs root and a kernel module. qcow2 needs qemu-img on every host and a second disk format in the VMM. The guest overlay needs neither |
| `mke2fs -d` under fakeroot to build the image disk | As fast as the builder microVM (4.3 s against 4.4 s for a 1 GB archive), but it adds fakeroot to every host and fakes what a kernel does for real |
| passt for a private guest network, in this change | The packaged passt sandboxes itself in a user namespace. Run from a user's directory on Ubuntu 24.04 it exits with "Failed to sandbox process", and libkrun then panics activating the device. It needs the system package or gvproxy |

## Reused

| From | What | How |
| --- | --- | --- |
| gakonst/nanoeval `tasks/` | `write-greeting`, `uppercase-message`, `extract-todos` | Copied. `docker_image` removed so the Dockerfile builds |
| gakonst/nanoeval `crates/nanoeval/src/task.rs` | Task schema 1.1 fields and refusals | Ported to `src/Task.ts` |
| gakonst/nanoeval `crates/nanoeval-harbor` | Harbor trial and job result shapes, pass@k, the package content hash | Ported to `src/Harbor.ts`, `src/Result.ts`, `src/Task.ts` |
| gakonst/nanoeval `crates/nanoeval/src/atif.rs` | ATIF-v1.7 projection of agent events | Ported to `src/Atif.ts` for nanocode-ts session events |
| gakonst/nanoeval `evaluator.rs` | Atomic slot and memory admission, 80% default memory | Ported to `src/Admission.ts` |
| gakonst/nanoeval verifier flow | Tests withheld until the agent ends, same environment, reward file | Kept in `slot.sh verify` |
| `HARNESS_PLACEMENT.md`, `NANOCODEX_VM_TOOLS.md` | Host harness, tools in the environment | Realized by the nanocode hand |
| nanocode-ts | `App.create`, `Forward`, hand tokens, the hand protocol | Used as a dependency |
| nanocode | The `nanocode hand` release binary | Downloaded and verified in each sandbox |
| gakonst/nanoeval `crates/nanovm` | The libkrun binding: `VmConfig`, `GuestCommand`, `KrunVm`, the capability probe | Ported to `krun/nanovm`. Read-only roots and vsock ports added. gvproxy, egress leases and the process config file left out |
| gakonst/nanoeval and nanocode `Cargo.lock` | libkrun `df85b8b` with libkrunfw 5 | The same pin, and the same lock entries for its dependencies |
| nanocode `crates/nanocodex-vm` `overlay.rs` and guest | A read-only image disk under a sparse upper disk per attempt, mounted and pivoted into by the guest | Reimplemented in `krun/guest/src/boot.rs` |
| nanocode `crates/nanocodex-vm` `image/` | The image disk built from `docker export` | Kept as the source. The disk is written by a builder microVM instead of a packaging container |

Not carried over yet: a private guest network (gvproxy in gakonst/nanoeval), image pulls and Dockerfile builds without Docker, warm spare microVMs, prompt-cache cohorts, duration-ordered dispatch, rerun lineage, the verifier-dependency cache, egress leases.
