<h1 align="center">nanoeval</h1>

Evaluations for [nanocode](https://nanocode.xyz) agents with the harness outside the sandbox. A benchmark is imported once into a durable eval: a table of normalized tasks whose files and environment disks are stored by content. A run is a table of rows, task × agent × attempt, against one version of that eval. Task runners on sandbox hosts claim rows and run each in a microVM of its own, and the agent harness of each row runs in a Cloudflare Worker on [nanocode-ts](https://github.com/nanocodexyz/nanocode-ts).

```
 import ─ adapter ─ normalize ─ convert ─▶ blob store ─▶ Evals object: tasks, versions
 CLI ─▶ Worker ─▶ Run object: rows of one eval version, claims, results
                    ▲ claim, report                 │ one harness session per claim
                  runner ─▶ slot 1 … slot N         ▼
                            microVM: disk + copy-on-write disk ── hand ──▶ session  (WebSocket, dialed from the slot)
```

- **Harness outside.** Model credentials and the event journal stay in the Worker. A task image gets no agent CLI, runtime or CA bundle installed.
- **Converted once.** `nanoeval import` runs a dataset's adapter, keeps each task's instruction, tests and solution apart as blobs, and converts its environment into the ext4 disk a microVM boots. Nothing is pulled or built when an attempt starts.
- **No container engine.** The launcher of the microVM backend reads a task's image from its registry, or runs its Dockerfile in a builder microVM, and writes the disk itself. No machine needs Docker, at import or at run time.
- **A durable table.** An eval version is named by a digest over its tasks and never changes. A run names it as `NAME@DIGEST`, and its rows hold every attempt, claim and result.
- **Runners that claim.** A runner admits by the free slots, memory and disk of its own machine, boots each claimed row under a copy-on-write disk, and reports to the run. Several runners on several machines work one run, and a row whose runner is lost is claimed again without scoring twice.
- **Harbor in, Harbor out.** Tasks are Harbor task directories (Terminal-Bench 2.x layout). A run exports as a Harbor job with ATIF-v1.7 trajectories.
- **Typed outcomes.** An attempt is `passed`, `failed` or `errored`, and an infrastructure failure is never a score of zero.

[DESIGN.md](DESIGN.md) has the architecture and the alternatives it rejects. [DECISIONS.md](DECISIONS.md) records what each change established, with its measurements.

## Status

The table says what was run. "The first version" is the flow before the eval table, whose slots pulled images when an attempt started: [DECISIONS.md](DECISIONS.md) keeps what it measured.

| Piece | State |
| --- | --- |
| Eval table (`Evals` Durable Object): rows, immutable versions, `nanoeval import`, `evals`, `eval` | Implemented, tested: unit tests for digests and versions, and every end-to-end lane imports before it runs |
| Blob store by SHA-256: a directory on a machine | Implemented, tested. Terminal-Bench 2.1 is imported into one: 89 tasks, 19.2 GB of packed disks, in under 5 minutes |
| Blob store by SHA-256: R2 through the Worker | Implemented, tested end to end under local workerd with small evals, single-request blobs only. Multipart uploads are unit tested against a mock. Not run against Cloudflare's R2 |
| Environment conversion at import (`sandbox/Converter.ts`), with no container engine | Implemented, tested: `nanoeval-krun image build`, `pack` and `unpack`. The 89 images of Terminal-Bench 2.1, one SWE-bench instance image, `python:3.12-slim` and the 14 Dockerfiles of this repository converted. The 89 disks have the same trees as disks made from `docker export`, apart from the files an engine adds. See [DESIGN.md](DESIGN.md#environment-conversion) for what a Dockerfile may use |
| Host policy for the `RUN` steps of a Dockerfile (`import --ca-bundle`, `--slot-env`, `--slot-forward`) | Implemented, tested on a Linux machine whose network re-signs TLS and serves the Python and npm registries on its loopback: a fixture that installs with pip and npm is refused without the options and imports with them, five Terminal-Bench 2.1 tasks built from their Dockerfiles, and no disk holds the bundle, a variable or a forward. On the base layers of the published images the trees differ only in what the day of a build decides, see [DECISIONS.md](DECISIONS.md#2026-11-11-the-smaller-gaps) |
| Run table (`Run` Durable Object): rows, claims, leases, CLI and API | Implemented, tested: unit tests for claims, leases, expiry and fencing, and end to end under local workerd |
| Task runners (`nanoeval runner`), started by a run through a sandbox or attached by hand | Implemented, tested: two runners with separate caches on one machine work one run |
| A runner lost during a run: its rows are claimed again, at most `--claims` times, and nothing scores twice | Implemented, tested end to end: a killed runner's rows end scored by the other runner, with the lost claims recorded |
| A runner restarted during a run | Tested: it goes on with the slots it had and loses no claim |
| Rerun lineage (`nanoeval run --rerun RUN [--failed\|--errored]`) | Implemented, tested end to end: each row names the attempt it retries |
| nanocode-ts harness sessions | Implemented. Tested end to end under local workerd |
| Local sandbox provider (`nanoeval sandboxd`) | Implemented, tested |
| Slot backend `krun`, one libkrun microVM per slot | Implemented, tested on a Linux machine with KVM: every end-to-end lane, 32 microVMs at once, and Terminal-Bench 2.1 with the tasks' own solutions, imported once and run by two runners: 82 of the 89 pass, and all 89 rows end as they did when slots pulled images. [DECISIONS.md](DECISIONS.md#2026-11-11-no-container-engine-at-import-or-at-run-time) has the table |
| Slot backend `dir` | Implemented, tested. For development and for lanes on a machine without KVM |
| Released `nanocode hand` in a slot, including Alpine images | Implemented, tested |
| Real model run | Tested with `gpt-6-luna` on a ChatGPT plan login: 3 Terminal-Bench tasks of the imported eval, 2 passed and 1 ended as a `verifier` error that its rerun passed, and the end-to-end lane before the eval table. `claude-haiku-4-5` through the Anthropic API ran on the first version only |
| Oracle run (`nanoeval run --oracle`): each task's own solution instead of a model | Implemented, tested |
| Dataset adapters (`nanoeval import`, `datasets`) | Implemented, tested: unit tests import from recorded fixtures with no network |
| `terminal-bench-2.1`, imported from the Harbor registry by digest | Verified: the 89 packages match the ones Harbor downloads byte for byte. Imported as an eval and run with the tasks' own solutions, see above |
| `terminal-bench-2.0` | 89 tasks imported and checked against their digests with the first version. 2 imported as an eval and run with their own solutions on krun slots: both passed |
| `swe-bench-verified` | 500 instances written as task directories with the first version. 1 imported as an eval: its image became a disk of 1.1 GB packed and its gold patch passed on a krun slot. The other 499 have not been converted or run |
| `gpqa-diamond` | 198 tasks. 5 imported as an eval and run with their reference answers: all passed. 5 ran with `gpt-6-luna` on the first version only |
| `healthbench-professional` | 410 cases. 2 imported as an eval and run with their physician answers, judged by `gpt-6-luna`. 3 ran with `gpt-6-luna` on the first version only |
| A task graded on the agent's final message, and a judge answered by the orchestrator | Implemented, tested end to end on krun and dir slots with the scripted model and with the fixtures' own answers, and with a `gpt-6-luna` judge on two HealthBench cases of an imported eval |
| GraphWalks, MRCR, Arena-Hard, BrowseComp, GDPval, SWE-Atlas QnA, GeneBench Pro, ARC-AGI-3, Agents' Last Exam importers | Not ported. [Datasets](#datasets) says why |
| Harbor job export and ATIF-v1.7 trajectories | Implemented. Exported jobs load with the models of Harbor 0.25.0 (`scripts/harbor-check.py`). The shapes Harbor enforces are unit tested |
| Failure kinds `verifier`, `agent_timeout`, `environment` | Implemented, tested |
| A verifier that scores without the test report it names is an error, not a zero | Implemented, tested |
| Every file a verifier writes is kept, binary files included | Implemented, tested |
| The count of processes a task's memory limit killed (`oomKills`) | Implemented, tested on krun slots |
| Cached disks removed when no row needs them (`--disks remove`), and `nanoeval prune` | Implemented, tested |
| The layer cache pruned by days since last use (`nanoeval prune layers`) | Implemented, tested: unit tests on temporary caches, and on a Linux machine with KVM: a removal during an image build was refused, the build succeeded, and the next removal took 10 of 44 blobs. Listed only, not removed, on the 16 GB cache of the Terminal-Bench 2.1 import |
| Unreferenced blobs of a directory store pruned (`nanoeval prune store`) | Implemented, tested: unit tests on temporary stores, and on a Linux machine with KVM: a removal during an import was refused, the next removed 6 of 14 files, and an oracle run of the eval passed afterwards. Listed only on the store of the Terminal-Bench 2.1 import, where every blob is referenced. Blobs in R2 are not pruned, and eval versions are never removed |
| What uv downloads for a verifier, kept per task (`run --verifier-cache`, off by default) | Implemented for krun slots, tested end to end with a fixture, and on ten Terminal-Bench 2.1 tasks with their solutions: the same ten outcomes with and without it, and 60 s of verifier time against 103 to 120 s. Only an oracle's attempt fills it. apt and pip are not cached |
| A floor on free disk for claims (`--free-disk-mb`) | Implemented, tested. It is reactive: it does not reserve what running attempts write later |
| Orchestrator restart during a run | Tested: the Worker is killed with attempts in flight, restarts on the same state, and the run finishes |
| E2B over MPP provider | Implemented against E2B's documented protocol and tested against a local mock. **No sandbox has been paid for or started.** A runner there has not run. Nobody has checked whether an E2B sandbox has KVM: without it, it runs `dir` environments only |
| `storage_mb` | The size of a krun slot's copy-on-write disk |
| Images whose user is not root, and images without bash | Tested with a fixture: tests and solutions are put in place as root, and the agent and the verifier run as the image's user |
| Codex models (`provider: codex`) | Tested on a ChatGPT plan login (`nanoeval worker --codex-login`). Not run with an OpenAI API key |
| Claude plan login (`nanoeval worker --claude-login`) | Written, not run: no unexpired login was at hand |
| Services on one Linux machine (`scripts/install-linux.sh`) | Implemented, tested: installed under a second name on other ports with the store, cache, layers and state on chosen paths, ran an import and a run through the installed services, and removed again |
| A certificate bundle and variables for slots (`sandboxd --ca-bundle`, `--slot-env`) | Implemented, tested |
| A private network per slot (`--network private`, the default for `krun` slots) | Implemented, tested on a Linux machine with KVM: a slot has its own loopback and ports, reaches the internet, and is reached neither by another slot nor by the host |
| The shared host network (`--network host`) | Implemented. Attempts that listen on a fixed port are not isolated from each other there |
| A hand of a private slot attached to a deployed Worker over `wss://` | Written, not run: no Worker is deployed |
| Listeners on the machine's loopback that private slots may reach (`sandboxd --slot-forward`) | Implemented, tested with a registry proxy on a machine's loopback |
| Deployment to Cloudflare | Bundles with `wrangler deploy --dry-run`. Not deployed |
| The `bwrap` slot backend | Planned |
| A task that closes the network of its agent, its verifier or both (`allow_internet = false`, Harbor's `network_mode`) | Implemented for krun slots on a private network, tested end to end: a closed phase reaches neither the internet, by name or by address, nor the machine, and the attempt completes. Refused on `dir` slots and on `--network host`. A network allowlist is refused. No dataset shipped here closes a phase yet |
| Tasks with a Compose file or MCP servers, separate verifier environments, `reward.json` | Refused, except `reward.json`, which is not read: a verifier that writes only it ends as a `verifier` error. Planned |
| Prompt-cache cohorts, duration-ordered dispatch, R2 artifacts, MPP sessions | Planned |

## Run it locally

Requirements: Linux and Node 24. For `krun` evals and slots, the default: `/dev/kvm`, libkrunfw 5, `mke2fs`, passt, and a Rust toolchain through rustup or a built launcher, see [krun slots](#krun-slots). No Docker or other container engine, on any machine. The first import or runner of a machine builds the launcher and `nanoeval-net` from `krun/` (about a minute) and later ones reuse them. `NANOEVAL_KRUN` names a directory with the built binaries instead.

```sh
npm ci

# 1. Make this machine a sandbox host.
node cli/nanoeval.ts sandboxd --token "$SANDBOX_TOKEN"

# 2. Start the Worker under local workerd. ANTHROPIC_API_KEY comes from the environment.
node cli/nanoeval.ts worker --token "$TOKEN" \
  --sandbox-url http://127.0.0.1:8788 --sandbox-token "$SANDBOX_TOKEN"

export NANOEVAL_URL=http://127.0.0.1:8787 NANOEVAL_TOKEN="$TOKEN"

# 3. Import two tasks as an eval: their environments become disks, once.
node cli/nanoeval.ts import --eval samples --task tasks/extract-todos --task tasks/uppercase-message
node cli/nanoeval.ts eval samples

# 4. Run it: 2 tasks, 2 attempts each, 4 slots in one sandbox.
node cli/nanoeval.ts run --eval samples \
  --agent haiku=claude:claude-haiku-4-5 \
  --attempts 2 --slots 4 --model-budget-usd 1 --wait --out output/job

# 5. Run what did not pass again, as a run that points at those attempts.
node cli/nanoeval.ts run --rerun RUN --wait
```

`--out` writes the Harbor job directory. `nanoeval status`, `attempt`, `export` and `cancel` read a run later, and `attempt` lists the claims of a row. `nanoeval run --task DIR` does steps 3 and 4 at once, into the eval named `local`. A machine without KVM takes `--backend dir` in both steps: no isolation, for development.

Blobs go to a directory by default, `~/.local/share/nanoeval/store` (`--store DIR` or `NANOEVAL_STORE`), which the runners of the same machine read. `--store r2` uploads them through the Worker into its `BLOBS` bucket instead, and runners then fetch them through their run. A runner keeps what it fetched, verified, in `~/.cache/nanoeval` (`--cache` or `NANOEVAL_CACHE`). An import keeps the image layers it read from registries in `oci` under that cache (`--layers` or `NANOEVAL_LAYERS`), so importing a dataset again downloads none of them.

**More runners.** A run starts one runner in each sandbox it opens. Any machine that reaches the Worker can add one:

```sh
node cli/nanoeval.ts run --eval samples --oracle --sandboxes 0   # prints the run's id and waits for runners
node cli/nanoeval.ts runner --run RUN --slots 4 --cache /var/cache/nanoeval-a
node cli/nanoeval.ts runner --run RUN --slots 4 --cache /var/cache/nanoeval-b
```

Each claims rows up to its own slots and memory and leaves when the run is finished. A runner that is killed loses its rows after `--lease-sec` (60 s), and another claims them. A runner started again in the same `--home` goes on with the slots it had.

Every krun slot gets a network of its own (`--network private`): its own loopback and ports, the internet, and no way in from another slot or from the machine. A hand dials `ws://127.0.0.1`, which nanocode accepts only on loopback, so each slot relays that one address to the Worker. `--network host` puts the slots on the machine's network instead, where they share its ports.

Without an API key, a plan login works. `nanoeval worker --codex-login ~/.codex/auth.json` runs `codex` agents such as `--agent luna=codex:gpt-6-luna` on the ChatGPT plan signed in there, and `--claude-login ~/.claude/.credentials.json` does the same for `claude` agents. The access token is read once when the Worker starts and is never refreshed: sign in again with that tool and restart the Worker when it expires.

To check task environments and verifiers without a model, `nanoeval run --oracle --eval NAME --wait` runs each task's `solution/solve.sh` in the slot in place of the agent. A solution is a blob of its own, and only an oracle run is told its digest.

A long run on a machine with little disk takes two more options. `--disks remove` makes a runner delete each packed disk once it is unpacked, and each disk it unpacked once no row of the run needs it, and never a disk its cache already had. `--free-disk-mb N` makes a runner claim only while its machine has N MB free. `nanoeval prune` removes what earlier runs left in the cache: the disks that no microVM holds, the blobs and the verifier caches (`--dry-run` lists them).

Two more commands prune what imports leave, and both only list until `--remove` is given. `nanoeval prune layers --days N` lists the layers, configs and manifests of the layer cache that no import used for N days, with abandoned downloads, each with its size. `nanoeval prune store` asks the Worker for every version of every eval and lists the blobs of the directory store that none of them names, with the files an import that died left staged. A removal is refused while an import is converting from that cache or writing to that store, and `prune store --remove` is refused when the Worker names no blob of the store, unless `--allow-empty` says that emptying it is meant: a Worker started on the wrong state would otherwise take everything. Eval versions are never removed, and blobs in R2 are not pruned. [DESIGN.md](DESIGN.md#pruning) has the rules.

`--verifier-cache` makes the verifier of a task find what uv downloaded for it before: an oracle run with the option keeps it in the runner's cache, and later attempts of that task on the machine start their verifier with it. It is off by default, and [DESIGN.md](DESIGN.md#verifier-cache) says what it does and does not change.

## Datasets

`nanoeval import` turns a dataset into an eval, so a benchmark needs no Harbor process, no adapter and no image pull at run time. Every source is pinned in this repository by a digest and refused when it does not match. The eval's version records the pinned source and the package checksum of every task, and a run names the version it ran.

```sh
node cli/nanoeval.ts datasets
node cli/nanoeval.ts import terminal-bench-2.1
node cli/nanoeval.ts eval terminal-bench-2.1

# Check environments and verifiers with the tasks' own solutions.
node cli/nanoeval.ts run --eval terminal-bench-2.1 --only fix-git --only openssl-selfsigned-cert \
  --oracle --wait

# A dataset whose answers are graded by a model names the judge.
node cli/nanoeval.ts import healthbench-professional --limit 20
node cli/nanoeval.ts run --eval healthbench-professional --agent luna=codex:gpt-6-luna \
  --judge codex:gpt-6-luna:low --model-budget-usd 1 --wait

# The task directories themselves, to read or to hand to Harbor.
node cli/nanoeval.ts import terminal-bench-2.1 --out datasets/terminal-bench-2.1
```

Importing part of a dataset (`--only`, `--limit`) and importing more later each make a new version that holds the earlier tasks too. `--limit N` takes the first N tasks in the order of their ids, at import and in a run, so both name the same tasks. `--keep-going` leaves out a task whose environment does not convert and names it.

| Dataset | Pinned source | Tasks | Environment | Graded by |
| --- | --- | --- | --- | --- |
| `terminal-bench-2.1` | The Harbor registry package `terminal-bench/terminal-bench-2-1`, by the digest of its 89 task packages | 89 | The task's image | The task's tests |
| `terminal-bench-2.0` | `terminal-bench/terminal-bench-2`, the same way | 89 | The task's image | The task's tests |
| `swe-bench-verified` | `princeton-nlp/SWE-bench_Verified` on Hugging Face at `c104f84`, by the SHA-256 of its Parquet file | 500 | The official image of the instance, `swebench/sweb.eval.x86_64.<instance>` | The official harness: `swebench` 4.0.3 writes the evaluation script and reads its log in the verifier |
| `gpqa-diamond` | The authors' release, `idavidrein/gpqa` at `56686c0`, by the SHA-256 of `dataset.zip` and of the question file | 198 | `python:3.12-slim` | The answer letter in the agent's final message |
| `healthbench-professional` | `openai/healthbench-professional` on Hugging Face at `349962f`, by SHA-256 | 410 of 525 | `python:3.12-slim` | Each rubric item, judged by the model the run names |

What to know before reading a score:

- **Final messages.** GPQA and HealthBench send the dataset's prompt unchanged and grade the agent's last message. The orchestrator hands that message to the verifier. Nothing asks the agent to write a file.
- **Judges.** A judged verifier writes its prompts to a file, and the run answers them with the model of `--judge`. No model credential and no judge endpoint enters a slot. [DESIGN.md](DESIGN.md#final-messages-and-judges) has the protocol.
- **HealthBench scores are not pass or fail.** The reward is the length-adjusted rubric score, which can exceed 1. An attempt counts as passed only at exactly 1, so read `mean reward` in the summary. A physician's answer is not a perfect one: under a `gpt-6-luna` judge the first two cases by id score 0.028 and 0.643 with theirs. The 115 cases with earlier turns are left out, since a task carries one instruction.
- **GPQA and HealthBench are closed-book, and their tasks do not say so yet.** A task that sets `allow_internet = false` or Harbor's `network_mode = "no-network"` runs on a krun slot without a network, but these two importers still write tasks that leave it open, so an agent could search.
- **SWE-bench needs the network in the verifier**, which installs `uv` and `swebench`, and each instance image becomes a disk of its own in the store. A machine whose network holds back fresh packages needs `sandboxd --slot-env` with `UV_EXCLUDE_NEWER`, and one whose registries sit behind a proxy on its loopback needs `--slot-forward`.
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
nanoeval import terminal-bench-2.1
nanoeval run --eval terminal-bench-2.1 --oracle --only fix-git --wait
```

The script needs Node 24 and systemd. It writes two user services, `nanoeval-sandboxd` and `nanoeval-worker`, that listen on loopback (`--sandbox-port`, `--worker-port`), generates their tokens into `~/.config/nanoeval/env` with mode 600, and installs `~/.local/bin/nanoeval`, which reads that file. A run starts its runner through `sandboxd`, so the machine needs no runner service. The script ends by naming what the machine lacks for microVM slots, if anything.

Where things live is host policy, and each has an option:

| Option | Holds | Default |
| --- | --- | --- |
| `--store DIR` | The blob store that imports write and the machine's runners read | `~/.local/share/nanoeval/store` |
| `--cache DIR` | Verified blobs and unpacked environment disks | `~/.cache/nanoeval` |
| `--layers DIR` | Image layers read from registries by imports | `oci` under the cache |
| `--state DIR` | The Worker's tables (`worker/`) and the slots of the machine (`sandboxes/`), which hold each attempt's copy-on-write disk | `~/.local/state/nanoeval` |
| `--runs DIR` | Jobs of runs submitted with `--wait` and no `--out` | `~/nanoeval-runs` |
| `--krun DIR` | A built launcher to use instead of building `krun/` with cargo | Built on first use |
| `--name NAME` | The prefix of the two services, the configuration directory and the command, for a second installation beside the first | `nanoeval` |

Put the store, the cache, the layers and the state on a filesystem with room: one Terminal-Bench 2.1 eval is 18 GB of packed disks and 16 GB of layers, and its unpacked disks take 51 GB when all are cached. `nanoeval prune layers` and `nanoeval prune store` list what can go from the layers and the store, see [Run it locally](#run-it-locally). Run the script again to change an option, `scripts/install-linux.sh --remove` to take the services, the command and the configuration away again (the data stays), and `loginctl enable-linger` to keep the services after you log out. The Worker runs from this checkout, and wrangler reloads it when the sources change. A Worker state directory written before the eval table is not migrated: point `--state` at a new directory and keep earlier runs as their exported jobs.

Three options are for a machine whose network stands between its slots and the internet. `--ca-bundle FILE` makes slots trust that bundle when the network re-signs TLS. `--slot-env FILE` starts them with the variables of that file, such as a package index or `UV_EXCLUDE_NEWER` where the registry holds back fresh releases. `--slot-forward ADDRESS:PORT`, which may repeat, lets private slots reach a listener on the machine's loopback at that same address, for a machine whose resolver sends package registries to a proxy there. An attached runner takes the same three, and so does `nanoeval import`, for the `RUN` steps of a task's Dockerfile.

### krun slots

`--backend krun`, the default, gives every slot its own microVM. The machine of a runner needs:

- Linux on x86_64 or aarch64 with `/dev/kvm` readable and writable by the user that runs the runner, usually through the `kvm` group.
- [libkrunfw](https://github.com/containers/libkrunfw) 5 where the dynamic loader finds `libkrunfw.so.5`.
- `mke2fs` from e2fsprogs.
- A Rust toolchain through rustup. The first import or runner builds the launcher in `krun/` (about a minute) and later ones reuse it. `NANOEVAL_KRUN` names a directory with a built `nanoeval-krun`, `nanoeval-krun-guest` and `nanoeval-net` instead.
- [passt](https://passt.top) installed as a system package (`apt install passt`), for the private network of slots and of a Dockerfile's `RUN` steps. A copy in a user's directory cannot sandbox itself where unprivileged user namespaces are restricted. `--network host` does not need it.

The machine that imports needs the same things and nothing more: the launcher pulls images and builds Dockerfiles itself, see [DESIGN.md](DESIGN.md#image-disks). No Docker, containerd or podman is used or needed, and none is called if one is installed. A Dockerfile whose `RUN` steps install from a registry that the machine's network re-signs or keeps on its loopback builds when the import has the machine's policy, `--ca-bundle`, `--slot-env` and `--slot-forward`, which the installed command has from the installation. The disk keeps none of the three. Tasks that name an image need none.

Unpacked disks are kept in `~/.cache/nanoeval/disks` (`NANOEVAL_CACHE` moves the cache) until `--disks remove` or `nanoeval prune` removes them. With `--network host` a slot shares the host's sockets, with the limits listed in [DESIGN.md](DESIGN.md#krun-slots).

## Run it on E2B

Not run against the real service, and narrower than before. An environment is a disk that a microVM boots, which needs KVM in the sandbox, and nobody has checked whether an E2B sandbox has it. Until someone does, assume it has none: an E2B sandbox can then run `dir` environments only, with no isolation between its slots. What exists is the provider (create, exec, write, kill over MPP) and a run that starts `nanoeval runner` in the sandbox, which needs a template with Node 24 and this repository. Nothing was built for KVM inside E2B.

```sh
node scripts/e2b-quote.ts code-interpreter-v1 3600   # the live price, nothing is paid
```

Every MPP charge is checked against `--sandbox-budget-usd` before it is signed and is listed under `payments` in the run's status. A machine with KVM that attaches a runner to a deployed Worker is the path for microVM slots off the local machine.

## Checks

```sh
npm run lint          # format and lint
npm run check:types   # tsc for Node and for the Worker
npm test              # unit tests
npm run dry-run       # bundle the Worker
npm run e2e           # local workerd + sandboxd + a runner + krun slots + the scripted model, skipped where krun cannot run
NANOEVAL_E2E_BACKEND=dir npm run e2e       # the same on directory slots, anywhere
NANOEVAL_E2E_MODEL=oracle npm run e2e      # the task solutions in place of a model
NANOEVAL_E2E_STORE=r2 npm run e2e          # blobs in R2 through the Worker
NANOEVAL_E2E_SCENARIO=judge npm run e2e    # final messages and a judge, with the scripted model
NANOEVAL_E2E_SCENARIO=failures npm run e2e # failure kinds and fixtures, then a rerun of what errored
NANOEVAL_E2E_SCENARIO=restart npm run e2e  # the Worker killed and restarted during the run
NANOEVAL_E2E_SCENARIO=runners npm run e2e  # two attached runners with separate caches
NANOEVAL_E2E_SCENARIO=lost NANOEVAL_E2E_LEASE_SEC=3 npm run e2e  # a runner killed: its rows are claimed again
NANOEVAL_E2E_SCENARIO=resume NANOEVAL_E2E_SLOTS=8 npm run e2e  # a runner killed and started again: it goes on
NANOEVAL_E2E_SCENARIO=network npm run e2e  # what a private slot reaches and what reaches it
NANOEVAL_E2E_SCENARIO=closed npm run e2e   # tasks that close the network of the agent, the verifier or both
NANOEVAL_E2E_SCENARIO=cache npm run e2e    # a verifier that finds what an oracle run kept for it
NANOEVAL_E2E_SCENARIO=disks npm run e2e    # cached disks removed when no row needs them; also disk, packing
NANOEVAL_E2E_MODEL=anthropic npm run e2e   # a real model with ANTHROPIC_API_KEY
NANOEVAL_E2E_MODEL=codex-plan npm run e2e  # a real model on the ChatGPT plan of ~/.codex/auth.json
(cd krun && cargo clippy --all-targets -- -D warnings && cargo test)   # the launcher and its image converter
python scripts/harbor-check.py output/job  # with Harbor's Python: load an exported job with Harbor's models
```

The scripted model answers the harness with fixed tool calls, so the end-to-end test needs no API key. It still imports a real eval and runs the real Worker, the real nanocode-ts harness, a real runner, the released hand and the real verifiers.

CI runs these on a GitHub-hosted runner, which has no libkrunfw: the `krun` lanes, the converter's test and the launcher's integration tests skip there, and only the directory lanes run, so no hosted lane isolates an attempt or converts an image. The workflow has not run on GitHub since the eval table and the converter landed. Every step of it was run on a Linux machine with KVM instead, see [DECISIONS.md](DECISIONS.md).

## Layout

| Path | Holds |
| --- | --- |
| `worker/` | The Worker: routes, the `Evals` and `Run` objects, the R2 blob routes, the harness sessions |
| `src/` | Host-agnostic modules: the eval row and its versions, the run ledger, the runner protocol, tasks, results, admission, budget, providers |
| `sandbox/` | `Runner.ts`, the task runner. `slot.sh`, one attempt in one slot. `Store.ts`, the blob store and the cache. `Converter.ts`, where an environment becomes a disk through the launcher. `Prune.ts`, what can go from the layer cache and from a directory store. `Sandboxd.ts`, the local sandbox daemon |
| `krun/` | The Rust workspace: the libkrun binding, the launcher and the guest binary of the krun backend, the image converter (`nanoeval-krun image`), and `nanoeval-net`, the relay of a private slot |
| `cli/` | The `nanoeval` command and the import pipeline |
| `datasets/` | The dataset adapters, and the graders they write into tasks |
| `scripts/` | `install-linux.sh`, the E2B price quote, and `harbor-check.py`, which loads an exported job with Harbor's own models |
| `tasks/` | Three small Harbor tasks from gakonst/nanoeval |
| `test/` | Unit tests, the end-to-end test and its failure fixtures |

## License

[MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
