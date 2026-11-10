# Design

nanoeval runs coding-agent evaluations with the agent harness outside the task sandbox. The orchestrator and every harness live in Cloudflare Workers on [nanocode-ts](https://github.com/nanocodexyz/nanocode-ts). Task environments live in remote sandboxes. Each sandbox is split into slots, and each slot runs one attempt behind its own nanocode hand.

It revives two earlier bodies of work:

- [gakonst/nanoeval](https://github.com/gakonst/nanoeval) (Rust, July 2026, last commit `10aed6b`): a library-first evaluator that kept the Nanocodex harness on the host and ran each attempt's tools in a disposable libkrun microVM.
- The eval stack in nanocode's history (`harbor_adapter/`, then `crates/experimental/nanocodex-eval` and `crates/nanocodex-vm`), removed from the tree in `2d4a4c539` (2026-10-13).

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

`sandbox/slot.sh` packs N attempts into one sandbox. The orchestrator uploads it once per sandbox and calls it through the provider's `exec`. `probe` reports what the machine can isolate with (`docker`, `kvm`, `userns`, `bwrap`, CPUs, memory).

| Backend | Isolation | State |
| --- | --- | --- |
| `docker` | One container per slot from the task's `docker_image` or `environment/Dockerfile`, with task CPU and memory limits. The hand runs inside the container | Implemented, tested |
| `dir` | One directory per slot, no isolation. For development and tasks that need none | Implemented, tested |
| `krun` | One libkrun microVM per slot, as in gakonst/nanoeval and `crates/nanocodex-vm`. Needs `/dev/kvm` | Planned |
| `bwrap` | User namespaces and an overlay root, for sandboxes with neither Docker nor KVM | Planned |

The hand binary is a glibc build. `slot.sh setup` downloads the pinned release, checks its SHA-256, and copies the binary with its loader and libraries into one read-only directory. Each container mounts it and starts the hand through that loader, so the hand runs in musl images such as Alpine without a change to the task image.

An E2B sandbox is a Firecracker microVM, and Firecracker does not expose KVM to its guest. That is why the split is layered: `krun` slots on machines with KVM, `docker` slots inside E2B. Both are driven by the same script and the same hand.

## Sandbox providers

A provider creates a sandbox, runs a command in it, writes a file to it, and kills it (`src/Sandbox.ts`). Everything else goes through `slot.sh`, so a provider is small.

**Local.** `nanoeval sandboxd` serves a machine over HTTP with a bearer token. A sandbox is a directory. This is the single-machine mode of the earlier versions: one large machine, many slots.

A machine's network is host policy, and `sandboxd` passes it to the slots. `--ca-bundle FILE` mounts a certificate bundle into each slot container and names it in the variables that OpenSSL, curl, uv, pip, requests, Node, git and cargo read, for a network that re-signs TLS. `--slot-env FILE` starts each container with the variables of a file. Both change what the agent and the verifier see, so the sandbox's capabilities in the run's status record them as `ca_bundle` and `slot_env`. Neither is set by default.

Local Docker slots use the host network, because a hand accepts a plaintext `ws://` URL only on loopback. Slots on one machine therefore share its ports: two attempts that listen on the same port interfere, and a verifier can reach another attempt's server. A slot with its own network stack, such as the planned `krun` backend, removes this.

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

Not carried over yet: libkrun and `nanocodex-vm` (the `krun` backend), prompt-cache cohorts, duration-ordered dispatch, rerun lineage, the verifier-dependency cache, egress leases.
