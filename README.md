<h1 align="center">nanoeval</h1>

Evaluations for [nanocode](https://nanocode.xyz) agents with the harness outside the sandbox. The orchestrator and each agent harness run in Cloudflare Workers on [nanocode-ts](https://github.com/nanocodexyz/nanocode-ts). Task environments run in remote sandboxes, and one sandbox is split into many slots, each with its own nanocode hand.

```
CLI ─▶ Worker ─▶ Run object ─▶ sandbox provider ─▶ sandbox ─▶ slot 1 … slot N
                    │                                            │
                    └─▶ one harness session per attempt ◀── hand ┘  (WebSocket, dialed from the slot)
```

- **Harness outside.** Model credentials and the event journal stay in the Worker. A task image gets no agent CLI, runtime or CA bundle installed.
- **Many attempts per machine.** `sandbox/slot.sh` gives each attempt its own container or microVM, its own network and its own hand inside one sandbox, admitted by free slots and memory.
- **Harbor in, Harbor out.** Tasks are Harbor task directories (Terminal-Bench 2.x layout). A run exports as a Harbor job with ATIF-v1.7 trajectories.
- **Datasets in.** `nanoeval import` writes Terminal-Bench, SWE-bench Verified and two question-answering datasets as task directories, from sources pinned by digest.
- **Typed outcomes.** An attempt is `passed`, `failed` or `errored`, and an infrastructure failure is never a score of zero.

[DESIGN.md](DESIGN.md) has the architecture and the alternatives it rejects. [DECISIONS.md](DECISIONS.md) records what each change established, with its measurements.

## Status

This is a first version. The table says what was run.

| Piece | State |
| --- | --- |
| Worker orchestrator (`Run` Durable Object), nanocode-ts harness sessions, CLI and API | Implemented. Tested end to end under local workerd |
| Local sandbox provider (`nanoeval sandboxd`) | Implemented, tested |
| Slot backends `docker` and `dir` | Implemented, tested: up to 64 attempts at once in one sandbox |
| Slot backend `krun`, one libkrun microVM per slot | Implemented, tested on a Linux machine with KVM: every end-to-end lane, 32 microVMs at once, and five Terminal-Bench 2.1 tasks with their own solutions, which all pass on a private network |
| Released `nanocode hand` in a slot, including Alpine images | Implemented, tested |
| Real model run | Tested with `claude-haiku-4-5` through the Anthropic API and with `gpt-6-luna` on a ChatGPT plan login |
| Oracle run (`nanoeval run --oracle`): each task's own solution instead of a model | Implemented, tested |
| Terminal-Bench 2.1 tasks | 87 of the 89 load, and 2 need Compose. 11 ran with their own solutions and passed. 5 ran with a model. The other 76 have not run |
| Dataset importers (`nanoeval import`, `datasets`, `run --dataset`) | Implemented, tested: unit tests import from recorded fixtures with no network |
| `terminal-bench-2.1`, imported from the Harbor registry by digest | Verified: the 89 directories match the ones Harbor downloads byte for byte. 4 tasks ran with their own solutions on Docker and krun slots and passed |
| `terminal-bench-2.0` | 89 tasks imported and checked against their digests. 2 ran with their own solutions on Docker and krun slots and passed |
| `swe-bench-verified` | 500 instances imported. `psf__requests-1142` ran on Docker slots: its gold patch passes and an empty patch fails. Not run on krun slots, where the image disk did not fit the disk budget of the test machine |
| `gpqa-diamond` | 198 tasks imported. 5 ran with their reference answers on Docker and krun slots and passed. 5 ran with `gpt-6-luna`: 2 right, 3 wrong |
| `healthbench-professional` | 410 cases imported. 2 ran with their physician answers on Docker and krun slots and 3 with `gpt-6-luna` on krun slots, all judged by `gpt-6-luna` |
| A task graded on the agent's final message, and a judge answered by the orchestrator | Implemented, tested end to end on Docker and krun slots with the scripted model, and with `gpt-6-luna` |
| GraphWalks, MRCR, Arena-Hard, BrowseComp, GDPval, SWE-Atlas QnA, GeneBench Pro, ARC-AGI-3, Agents' Last Exam importers | Not ported. [Datasets](#datasets) says why |
| Harbor job export and ATIF-v1.7 trajectories | Implemented. Shapes are unit tested. Not yet opened with `harbor view` |
| Failure kinds `verifier`, `agent_timeout`, `environment` | Implemented, tested |
| Orchestrator restart during a run | Tested: the Worker is killed with attempts in flight, restarts on the same state, and the run finishes |
| E2B over MPP provider | Implemented against E2B's documented protocol and tested against a local mock. The live `402` challenge is decoded by `scripts/e2b-quote.ts`. **No sandbox has been paid for or started yet** |
| Docker installation inside an E2B sandbox (`--docker install`) | Written, not run |
| Container CPU and memory limits (`--limits enforce`) | Implemented, tested: the end-to-end test reads the limits of every slot container |
| Codex models (`provider: codex`) | Tested on a ChatGPT plan login (`nanoeval worker --codex-login`). Not run with an OpenAI API key |
| Claude plan login (`nanoeval worker --claude-login`) | Written, not run: no unexpired login was at hand |
| Services on one Linux machine (`scripts/install-linux.sh`) | Implemented, run on one machine |
| A certificate bundle and variables for slot containers (`sandboxd --ca-bundle`, `--slot-env`) | Implemented, tested |
| A private network per slot (`--network private`, the default of the local provider for `docker` and `krun` slots) | Implemented, tested on a Linux machine with KVM: a slot has its own loopback and ports, reaches the internet, and is reached neither by another slot nor by the host. 64 Docker slots and 32 microVMs at once, and four attempts at once of a Terminal-Bench task that serves on a fixed port |
| The shared host network (`--network host`) | Implemented, tested. Attempts that listen on a fixed port are not isolated from each other there |
| A hand of a private slot attached to a deployed Worker over `wss://` | Written, not run: no Worker is deployed |
| Listeners on the machine's loopback that private slots may reach (`sandboxd --slot-forward`) | Implemented, tested with a registry proxy on a machine's loopback |
| Deployment to Cloudflare | Bundles with `wrangler deploy --dry-run`. Not deployed |
| The `bwrap` slot backend | Planned |
| `allow_internet = false`, Compose tasks, separate verifier environments | Refused at submission. Planned |
| Reruns with lineage, prompt-cache cohorts, duration-ordered dispatch, R2 artifacts, MPP sessions | Planned |

## Run it locally

Requirements: Node 24, Docker, Linux, and a Rust toolchain through rustup. The first sandbox builds `nanoeval-net`, the small static binary behind a slot's private network, from `krun/` and later ones reuse it. `NANOEVAL_KRUN` names a directory with the built binary instead, and `--network host` needs neither.

```sh
npm ci

# 1. Make this machine a sandbox host.
node cli/nanoeval.ts sandboxd --token "$SANDBOX_TOKEN"

# 2. Start the Worker under local workerd. ANTHROPIC_API_KEY comes from the environment.
node cli/nanoeval.ts worker --token "$TOKEN" \
  --sandbox-url http://127.0.0.1:8788 --sandbox-token "$SANDBOX_TOKEN"

# 3. Submit a run: 2 tasks, 2 attempts each, 4 slots in one sandbox.
node cli/nanoeval.ts run --url http://127.0.0.1:8787 --token "$TOKEN" \
  --task tasks/extract-todos --task tasks/uppercase-message \
  --agent haiku=claude:claude-haiku-4-5 \
  --attempts 2 --slots 4 --model-budget-usd 1 --wait --out output/job
```

`--out` writes the Harbor job directory. If the Docker daemon cannot apply cgroup limits, pass `--limits none`. `nanoeval status`, `attempt`, `export` and `cancel` read a run later. Every slot of the local provider gets a network of its own (`--network private`): its own loopback and ports, the internet, and no way in from another slot or from the machine. A hand dials `ws://127.0.0.1`, which nanocode accepts only on loopback, so each slot relays that one address to the Worker. `--network host` puts the slots on the machine's network instead, where they share its ports. `nanoeval status` shows the network of each sandbox under its capabilities.

Without an API key, a plan login works. `nanoeval worker --codex-login ~/.codex/auth.json` runs `codex` agents such as `--agent luna=codex:gpt-6-luna` on the ChatGPT plan signed in there, and `--claude-login ~/.claude/.credentials.json` does the same for `claude` agents. The access token is read once when the Worker starts and is never refreshed: sign in again with that tool and restart the Worker when it expires.

To check task environments and verifiers without a model, `nanoeval run --oracle --task DIR... --wait` sends each task's `solution/` and runs `solution/solve.sh` in the slot in place of the agent. No other run sends a solution.

## Datasets

`nanoeval import` writes a dataset as Harbor task directories, so a benchmark needs no Harbor process and no adapter at run time. Every source is pinned in this repository by a digest and refused when it does not match. `dataset.json` beside the tasks names the pinned source and the package checksum of every task, and `run --dataset` checks each task against it before it is sent.

```sh
node cli/nanoeval.ts datasets
node cli/nanoeval.ts import terminal-bench-2.1 --out datasets/terminal-bench-2.1

# Check environments and verifiers with the tasks' own solutions.
node cli/nanoeval.ts run --url http://127.0.0.1:8787 --token "$TOKEN" \
  --dataset datasets/terminal-bench-2.1 --only fix-git --only openssl-selfsigned-cert \
  --oracle --backend krun --wait

# A dataset whose answers are graded by a model names the judge.
node cli/nanoeval.ts import healthbench-professional --out datasets/healthbench --limit 20
node cli/nanoeval.ts run --url http://127.0.0.1:8787 --token "$TOKEN" \
  --dataset datasets/healthbench --agent luna=codex:gpt-6-luna \
  --judge codex:gpt-6-luna:low --model-budget-usd 1 --wait
```

| Dataset | Pinned source | Tasks | Environment | Graded by |
| --- | --- | --- | --- | --- |
| `terminal-bench-2.1` | The Harbor registry package `terminal-bench/terminal-bench-2-1`, by the digest of its 89 task packages | 89 | The task's image | The task's tests |
| `terminal-bench-2.0` | `terminal-bench/terminal-bench-2`, the same way | 89 | The task's image | The task's tests |
| `swe-bench-verified` | `princeton-nlp/SWE-bench_Verified` on Hugging Face at `c104f84`, by the SHA-256 of its Parquet file | 500 | The official image of the instance, `swebench/sweb.eval.x86_64.<instance>` | The official harness: `swebench` 4.0.3 writes the evaluation script and reads its log in the verifier |
| `gpqa-diamond` | The authors' release, `idavidrein/gpqa` at `56686c0`, by the SHA-256 of `dataset.zip` and of the question file | 198 | `python:3.12-slim` | The answer letter in the agent's final message |
| `healthbench-professional` | `openai/healthbench-professional` on Hugging Face at `349962f`, by SHA-256 | 410 of 525 | `python:3.12-slim` | Each rubric item, judged by the model the run names |

What to know before reading a score:

- **Final messages.** GPQA and HealthBench send the dataset's prompt unchanged and grade the agent's last message. The orchestrator hands that message to the verifier. Nothing asks the agent to write a file.
- **Judges.** A judged verifier writes its prompts to a file, and the orchestrator answers them with the model of `--judge`. No model credential and no judge endpoint enters a slot. [DESIGN.md](DESIGN.md#final-messages-and-judges) has the protocol.
- **HealthBench scores are not pass or fail.** The reward is the length-adjusted rubric score, which can exceed 1. An attempt counts as passed only at exactly 1, so read `mean reward` in the summary. The 115 cases with earlier turns are left out, since a task carries one instruction.
- **GPQA and HealthBench are closed-book and slots are not.** No slot backend cuts a slot off from the network yet, so an agent could search.
- **SWE-bench needs the network in the verifier**, which installs `uv` and `swebench`, and about 4 GB of disk for each instance image. A machine whose network holds back fresh packages needs `sandboxd --slot-env` with `UV_EXCLUDE_NEWER`.
- **Instance images are named by tag**, as the official harness names them. Only the dataset is pinned by digest.

Not ported from the earlier adapters, with the reason, in the order they would come back:

| Dataset | Why not yet |
| --- | --- |
| GraphWalks | The importer and grader are small. Its 297 MB Parquet file and prompts of up to a million tokens need a streaming import and a budget to run |
| MRCR, and the other 115 HealthBench cases | The prompt is a conversation of several messages. A task carries one instruction |
| Arena-Hard | Needs the judge twice per answer against a baseline answer. The judge is here, the importer is not |
| BrowseComp | Its grader is one judge call. Its tasks need a browsing tool that was never run in the earlier stack |
| GDPval, SWE-Atlas QnA, GeneBench Pro | Their verifiers run in a separate image, which nanoeval refuses |
| ARC-AGI-3 | The earlier adapter was a stub with a three-action cap |
| Agents' Last Exam | Its 44 GB task archive is behind a Hugging Face login |
| OpenAI Evals, external manifests | They described tasks for the earlier runner. A Harbor task directory is that description now |

## Keep it running on a Linux machine

```sh
npm ci
scripts/install-linux.sh --codex-login ~/.codex/auth.json
nanoeval run --oracle --task tasks/extract-todos --wait
```

The script needs Node 24, Docker and systemd. It writes two user services, `nanoeval-sandboxd` and `nanoeval-worker`, that listen on loopback (`--sandbox-port`, `--worker-port`), generates their tokens into `~/.config/nanoeval/env` with mode 600, and installs `~/.local/bin/nanoeval`, which reads that file. A run submitted with `--wait` and no `--out` is written under `~/nanoeval-runs` (`--runs`). Run the script again to change an option, and `loginctl enable-linger` to keep the services after you log out. The Worker runs from this checkout, and wrangler reloads it when the sources change.

Three options are for a machine whose network stands between its slots and the internet. `--ca-bundle FILE` makes slots trust that bundle when the network re-signs TLS. `--slot-env FILE` starts them with the variables of that file, such as a package index or `UV_EXCLUDE_NEWER` where the registry holds back fresh releases. `--slot-forward ADDRESS:PORT`, which may repeat, lets private slots reach a listener on the machine's loopback at that same address, for a machine whose resolver sends package registries to a proxy there.

### krun slots

`--backend krun` gives every slot its own microVM instead of a container. The machine needs:

- Linux on x86_64 or aarch64 with `/dev/kvm` readable and writable by the user that runs `sandboxd`, usually through the `kvm` group.
- [libkrunfw](https://github.com/containers/libkrunfw) 5 where the dynamic loader finds `libkrunfw.so.5`.
- Docker, which still builds or pulls the task image, and `mke2fs` from e2fsprogs.
- A Rust toolchain through rustup. The first sandbox builds the launcher in `krun/` (about a minute) and later ones reuse it. `NANOEVAL_KRUN` names a directory with a built `nanoeval-krun`, `nanoeval-krun-guest` and `nanoeval-net` instead.
- [passt](https://passt.top) installed as a system package (`apt install passt`), for the private network. A copy in a user's directory cannot sandbox itself where unprivileged user namespaces are restricted. `--network host` does not need it.

```sh
node cli/nanoeval.ts run --url http://127.0.0.1:8787 --token "$TOKEN" \
  --task tasks/extract-todos --task tasks/uppercase-message \
  --agent haiku=claude:claude-haiku-4-5 \
  --backend krun --attempts 2 --slots 4 --wait
```

Image disks are kept in `~/.cache/nanoeval/krun` and are not removed by a run. A krun slot has a private network like a Docker slot, described in [DESIGN.md](DESIGN.md#slot-networks). With `--network host` it shares the host's sockets, with the limits listed [there](DESIGN.md#krun-slots).

## Run it on E2B

Not yet run against the real service. The intended flow:

```sh
node scripts/e2b-quote.ts code-interpreter-v1 3600   # the live price, nothing is paid
npx wrangler secret put TEMPO_PRIVATE_KEY            # a Tempo account holding USDC.e or OUSD
npx wrangler secret put ACCESS_TOKEN
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy

node cli/nanoeval.ts run --url https://<worker> --token "$TOKEN" \
  --provider e2b --template code-interpreter-v1 --docker install \
  --sandbox-timeout-sec 3600 --sandbox-budget-usd 1 --slots 4 \
  --task tasks/extract-todos --agent haiku=claude:claude-haiku-4-5 --wait
```

Every MPP charge is checked against `--sandbox-budget-usd` before it is signed and is listed under `payments` in the run's status.

## Checks

```sh
npm run lint          # format and lint
npm run check:types   # tsc for Node and for the Worker
npm test              # unit tests
npm run dry-run       # bundle the Worker
npm run e2e           # local workerd + sandboxd + Docker slots + the scripted model
NANOEVAL_E2E_MODEL=oracle npm run e2e      # the task solutions in place of a model
NANOEVAL_E2E_SCENARIO=judge npm run e2e    # final messages and a judge, with the scripted model
NANOEVAL_E2E_MODEL=anthropic npm run e2e   # a real model with ANTHROPIC_API_KEY
NANOEVAL_E2E_MODEL=codex-plan npm run e2e  # a real model on the ChatGPT plan of ~/.codex/auth.json
NANOEVAL_E2E_BACKEND=krun npm run e2e      # microVM slots, skipped where krun cannot run
NANOEVAL_E2E_SCENARIO=network npm run e2e  # what a private slot reaches and what reaches it
(cd krun && cargo clippy --all-targets -- -D warnings && cargo test)   # the krun launcher
```

The scripted model answers the harness with fixed tool calls, so the end-to-end test needs no API key. It still runs the real Worker, the real nanocode-ts harness, the released hand and the real verifiers.

## Layout

| Path | Holds |
| --- | --- |
| `worker/` | The Worker: routes, the `Run` object, the harness sessions |
| `src/` | Host-agnostic modules: tasks, results, admission, budget, providers |
| `sandbox/` | `slot.sh`, the slot splitter, and `Sandboxd.ts`, the local sandbox daemon |
| `krun/` | The Rust workspace: the libkrun binding, the launcher and the guest binary of the krun backend, and `nanoeval-net`, the relay and inbound rule of a private slot |
| `cli/` | The `nanoeval` command |
| `datasets/` | The dataset importers, and the graders they write into tasks |
| `scripts/` | `install-linux.sh` and the E2B price quote |
| `tasks/` | Three small Harbor tasks from gakonst/nanoeval |
| `test/` | Unit tests, the end-to-end test and its failure fixtures |

## License

[MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
