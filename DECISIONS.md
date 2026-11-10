# Decisions

The record below describes what each change established and why, with the commands, dates and measurements behind it. Where it conflicts with AGENTS.md, AGENTS.md applies to new and changed code.

## 2026-11-10: first version

Machine for every measurement in this entry: a 5-core, 14 GiB Linux x86_64 container host, kernel 6.18, Docker 29.1.3 (legacy builder, no cgroup limits, no `/dev/kvm`), Node 24.22.1, wrangler 4.151.1 (workerd 1.20261012.1), nanocode-ts `build-751e03a`, nanocode CLI 0.7.0 from the `nanocode-cli` release (`nanocode-x86_64-unknown-linux-gnu.gz`, SHA-256 `a5305c5a…bd7754`). Each lane below is one run.

### What the earlier work was

gakonst/nanoeval (23 commits, 2026-07-21 to 2026-07-26, `10aed6b`) was a Rust evaluator that linked the Nanocodex harness in process. It packed attempts onto one machine with one libkrun microVM per attempt (Hypervisor.framework on macOS, KVM on Linux), admitted by free slots and memory, with the harness on the host and `exec_command`, `write_stdin`, `apply_patch` and `view_image` served by a static guest binary over a virtio console. It had no namespace or container isolation: that existed only as a plan. Its README records a full Terminal-Bench 2.1 pass (89 tasks, one trial) in 3,310 s at concurrency 8 on an Apple Silicon host.

nanocode's history holds the rest: a Python Harbor installed-agent adapter (from the repository's first commits on 2026-07-15, removed in `cc06b56f3`), then a Rust eval stack with a SQLite ledger, coordinator and pull workers, and `nanocodex-vm` with a VM host that published each microVM as a separate hand (`bin/nanocodex/hand/src/vm_host.rs`). All of it left the tree in `2d4a4c539` (2026-10-13). The lessons written down there shape this design: verifier dependencies must not leak into the task, image preparation is not scoring, infrastructure failures are not scores, no artificial model-call caps, and no benchmark-specific tuning.

### The harness is a nanocode-ts session, the sandbox holds a hand

`App.create` from `nanocode-ts/cloudflare` serves one Durable Object per session with `hands: 'always'` and `workspace: false`. The orchestrator mints a hand token (`POST /sessions/<name>/hands`), starts `nanocode hand <ws url>/sessions/<name>/hands --name slot` in the slot with the token in `NANOCODE_RUNNER_TOKEN`, waits until `GET /sessions/<name>/hands` lists it, and submits the task instruction as one turn with `hand: 'slot'`. Model requests leave through `Forward.create`, which adds the deployment's API key. `ANTHROPIC_BASE_URL` and `OPENAI_BASE_URL` redirect them, which the end-to-end test uses for its scripted model.

Observed while building this:

- The released CLI 0.7.0 hand attaches to a nanocode-ts `build-751e03a` session and completes turns.
- A hand refuses a plaintext `ws://` URL unless the host is literal loopback ("plaintext attachment targets require a literal loopback host"). Local Docker slots therefore use the host network. A deployed Worker is `wss://`, so bridge networking applies there.
- A turn submitted before its hand attached stays `queued` with `kind: "detached"` and retries. The orchestrator waits for the hand first and treats `detached` with a dead hand as an environment failure.
- The glibc hand runs in Alpine through its bundled loader: `ld.so --library-path lib nanocode hand …` printed `nanocode 0.7.0` in `alpine:3.21`.
- The Claude harness's `Bash` tool needs a `bash` executable in the task environment ("command executor: Bash executable not found" in `alpine:3.21`). `exec_command`, `Read` and `Write` work without it. nanoeval does not add a shell to a task image.

### Slots

`sandbox/slot.sh` runs long phases detached (`setsid nohup`) and writes `running` or `exit:<code>` to a status file. `status` prints one JSON object for the whole sandbox, so the orchestrator makes one call per sandbox per tick. A slot is used once.

`down` and `destroy` end work that a slot still runs. Each detached phase is a session leader whose id is kept beside its status, and a phase that still reports `running` has its whole session killed. A process group is not enough: GNU `timeout` moves the verifier into a group of its own. Image builds pass `--force-rm`, since the legacy builder otherwise leaves the container of a failed `RUN` behind.

Docker on the measurement host could not apply cgroup limits ("cannot enter cgroupv2 … it is in threaded mode"), so the runs below pass `limits: none`. `limits: enforce` (`--cpus`, `--memory` from `task.toml`) is the default and is not yet exercised. The host's Docker builds also had no network for `RUN` steps, so the Docker lanes use the two fixture tasks whose Dockerfiles have none.

### Measurements

```sh
NANOEVAL_E2E_LIMITS=none node test/e2e.ts
NANOEVAL_E2E_LIMITS=none NANOEVAL_E2E_BACKEND=dir NANOEVAL_E2E_TASKS=extract-todos,uppercase-message,write-greeting NANOEVAL_E2E_SLOTS=3 NANOEVAL_E2E_ATTEMPTS=1 node test/e2e.ts
NANOEVAL_E2E_LIMITS=none NANOEVAL_E2E_SCENARIO=failures node test/e2e.ts
NANOEVAL_E2E_LIMITS=none NANOEVAL_E2E_SCENARIO=restart node test/e2e.ts
NANOEVAL_E2E_LIMITS=none NANOEVAL_E2E_MODEL=anthropic node test/e2e.ts
```

Every lane ran one local sandbox under `wrangler dev` with `TICK_MS=500`. Wall time is from submission to the finished run and includes sandbox setup. Phase times are medians over the lane's attempts.

| Lane | Attempts | Slots | Peak at once | Wall | Environment | Hand attach | Agent | Verifier | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Scripted model, Docker slots, 2 tasks × 2 agents × 2 | 8 | 4 | 4 | 8.7 s | 0.87 s | 0.69 s | 0.67 s | 0.82 s | 4 passed, 4 failed as scripted |
| Same, hand downloaded from the release | 8 | 4 | 4 | 12.3 s | 0.97 s | 0.68 s | 0.80 s | 0.83 s | 4 passed, 4 failed as scripted |
| Scripted model, directory slots, 3 tasks × 2 agents | 6 | 3 | 3 | 7.7 s | 0.88 s | 0.68 s | 0.66 s | 0.85 s | 3 passed, 3 failed as scripted |
| Scripted model, Docker slots, Worker killed and restarted once with attempts in flight | 8 | 4 | 4 | 12.9 s | 1.00 s | 0.83 s | 0.90 s | 1.16 s | 4 passed, 4 failed as scripted |
| `claude-haiku-4-5`, Docker slots, 2 tasks × 2 attempts | 4 | 4 | 4 | 26.1 s | 0.97 s | 0.69 s | 20.9 s | 0.99 s | 2 passed, 2 failed, 0 errored |
| Same lane, second run | 4 | 4 | 4 | 29.7 s | 0.93 s | 0.69 s | 21.2 s | 0.76 s | 4 passed, 0 errored |
| Same lane, third run | 4 | 4 | 4 | 28.6 s | 1.02 s | 0.69 s | 20.8 s | 1.09 s | 3 passed, 1 failed, 0 errored |

The phase times are dominated by the 500 ms tick: each phase waits for the next alarm. The real-model lanes cost $0.089, $0.098 and $0.089 by the harness's estimate from token usage. The two failures of the first run are both `uppercase-message`: the model wrote the file without the final newline after working around the missing `bash`, and the verifier scored 0. The second run passed all four, and the third failed one `uppercase-message` attempt. Two attempts per task say nothing about a pass rate: these lanes show that the path works with a real model and a real verifier.

The failures lane ended as designed: a verifier that writes no reward is `errored` with kind `verifier`, an agent past its 3 s deadline is cancelled and verified and ends `failed` with kind `agent_timeout` and reward 0, and a Dockerfile whose build fails is `errored` with kind `environment`. After every lane no slot container and no sandbox directory remained.

The restart lane sends SIGKILL to wrangler and workerd once an attempt is active, then starts them again on the same persisted state. The run's alarm fires again, the hands redial the same sessions, and the run finishes with the same eight scores and no errored attempt.

A second run of that lane found a hole: the kill landed between the ledger write that moves an attempt to `up` and the `slot.sh up` call, and the attempt then waited out `setupSec`. Two rules close it. A slot whose `up` status is still `none` never started, so the orchestrator starts it again, which replays nothing. An attempt's result is written to the ledger before its slot and session are removed, so a kill during teardown cannot turn a scored attempt into an error. Every other step was already safe to repeat: the hand token is stored in the session, `slot.sh hand` and `verify` return at once for a phase that runs or ended, and the turn's request id is fixed. With both rules, nine runs with the kill 0, 0, 200, 500, 900, 1,400, 2,000, 3,000 and 4,500 ms after the first active attempt (`NANOEVAL_E2E_RESTART_AFTER_MS`) all finished with the eight expected scores in 10.7 to 13.9 s. A restart while a sandbox is being created is the one case that is not continued: that sandbox is marked `unknown`.

The commands in the README were run as written, with `--limits none`: `nanoeval sandboxd`, `wrangler dev`, then `nanoeval run --task tasks/extract-todos --agent haiku=claude:claude-haiku-4-5 --attempts 1 --slots 2 --wait --out`. The attempt passed with seven model calls at an estimated $0.0165, `status` and `attempt` read it back, and `--out` held the job's `result.json` and the trial's `result.json`, `agent/trajectory.json`, `agent/events.jsonl` and `verifier/test-stdout.txt`.

### E2B over MPP

Read from E2B's documentation, the proxy's `/openapi.json`, a live unpaid `402`, and the sources of `e2b` 2.63.0 and `mppx` 0.16.0. Nothing was paid, so the provider has not run against the real service.

- Control plane `https://mpp.e2b.dev`. The `402` carries four `Payment` challenges: `tempo` `charge` and `session`, each in OUSD and USDC.e on Tempo (chain 4217). Charges are pull-mode and sponsored.
- `node scripts/e2b-quote.ts` on 2026-11-10: `code-interpreter-v1` for 3,600 s is $0.12664 (2 vCPU, 2,048 MiB), `base` for 300 s is $0.008721 (2 vCPU, 512 MiB). The documented formula is `(vCPU × $0.000014 + GiB × $0.0000045) × seconds × 0.95 + $0.0001`, billed up front without refund, at most 86,400 s.
- Only public templates are served (`base`, `code-interpreter-v1`, `desktop`, `claude`, `codex`, `amp`, `opencode`, `openclaw`). The largest is `desktop` at 8 vCPU and 8,192 MiB. Custom templates, snapshots and volumes are not available, so Docker and the hand are installed in each sandbox at run time.
- Data plane: envd on port 49983 with `X-Access-Token`. Commands are `POST /process.Process/Start`, a Connect server stream in JSON with five-byte envelopes. A zero exit code is omitted from the `end` event. Files are `POST /files?path=&username=`.
- A sandbox is a Firecracker microVM. KVM inside it is not expected. `slot.sh probe` reports `kvm`, `docker`, `userns` and `bwrap` and will settle it on the first real sandbox.
- The payer uses `tempo.charge` only. `onChallenge` charges the run's budget before `createCredential`, so a refused charge signs nothing: the unit test checks that no `Authorization` header is sent.

### Limits of this version

- The run's ledger and artifacts live in the Run object's SQLite, in 524,288-character parts. A Durable Object's storage limits bound a run's artifacts until R2 is added.
- The Worker bundle is 17.5 MiB (5.1 MiB gzip) with the nanocode WebAssembly module, which needs a paid Workers plan.
- The hand token is in the hand's environment, so task processes can read it. It grants attaching a hand to that attempt's session only.
- An orchestrator restart during a sandbox creation marks that sandbox `unknown` and does not retry it.

## 2026-11-10: a Linux machine with KVM, Terminal-Bench 2.1 tasks and plan logins

Machine for every measurement in this entry: a 32-core, 62 GiB Linux x86_64 machine with `/dev/kvm`, kernel 6.8, Docker 29.9.3 (systemd cgroup driver, cgroup v2), shared with other work (about 130 other containers ran throughout), Node 24.22.2, wrangler 4.151.1 (workerd 1.20261012.1), nanocode-ts `build-751e03a` and the same nanocode CLI release for the hand. Its network re-signs TLS to the Python and npm package registries and refuses packages published in the last few days. Each lane is one run, at commit `696b964` unless it names another, with `TICK_MS=500` unless it names another.

### What the first version had not run

- **A clean install.** `npm ci` failed with HTTP 403 for `vite` 8.3.7, `rolldown` 1.2.18 and `jose` 6.2.17, all published on 2026-11-09, the day the lockfile was written: the registry policy holds back fresh releases. The lockfile is resolved again with `min-release-age=7` (`vite` 8.3.5, `rolldown` 1.2.16, `jose` 6.2.15), and `.npmrc` keeps that for later resolutions.
- **Limits.** Every lane now runs with `limits: enforce`. The end-to-end test reads `HostConfig.NanoCpus` and `HostConfig.Memory` of each slot container it sees and compares them with the task (1 CPU, 256 MiB for the sample tasks).
- **A Dockerfile that needs the network.** `write-greeting` runs `apk add`, and it built in the scale lanes below.
- **More than four slots.** The table below.

The end-to-end test also counted every container with the `nanoeval` label on the machine, so a second run on the same machine failed it. It now counts the containers of its own sandboxes.

The lanes of CI on this machine, with limits enforced:

| Lane | Attempts | Slots | Wall | Result |
| --- | ---: | ---: | ---: | --- |
| Scripted model, Docker slots | 8 | 4 | 5.3 s | 4 passed, 4 failed as scripted |
| Scripted model, directory slots | 6 | 3 | 5.1 s | 3 passed, 3 failed as scripted |
| Oracle, Docker slots, with a certificate bundle | 3 | 4 | 3.2 s | 3 passed |
| Failure kinds and fixtures, Docker slots | 5 | 4 | not recorded | 2 passed, 1 failed, 2 errored, each as designed |
| Scripted model, Docker slots, Worker killed and restarted once | 8 | 4 | 5.8 s | 4 passed, 4 failed as scripted |

### Scale on one machine

```sh
NANOEVAL_E2E_TASKS=extract-todos,uppercase-message,write-greeting NANOEVAL_E2E_SLOTS=32 NANOEVAL_E2E_ATTEMPTS=22 NANOEVAL_E2E_TICK_MS=500 node test/e2e.ts
```

Scripted model, Docker slots, limits enforced, 3 tasks × 2 agents, one sandbox, commit `d8a4c93` (the last two rows with `NANOEVAL_E2E_TICK_MS` added to the test). Every run ended with half of its attempts passed and half failed as scripted, none errored, and no container left.

| Slots | Attempts | Tick | Wall | Environment | Hand attach | Agent | Verifier |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 16 | 66 | 500 ms | 14.8 s | 0.71 s | 0.58 s | 0.55 s | 0.63 s |
| 32 | 132 | 500 ms | 18.6 s | 0.98 s | 0.67 s | 0.60 s | 0.76 s |
| 64 | 264 | 500 ms | 31.0 s | 1.53 s | 0.90 s | 1.03 s | 1.40 s |
| 32 | 132 | 200 ms | 14.0 s | 0.64 s | 0.38 s | 0.51 s | 0.44 s |
| 32 | 132 | 2,000 ms | 51.0 s | 2.45 s | 2.16 s | 2.09 s | 2.21 s |

Nothing broke up to 64 slots. The tick is the cost: each of the four phases waits for one, so the deployment's 2,000 ms spends about 9 s per attempt on waiting. `nanoeval worker` therefore defaults to 500 ms for local workerd, and `wrangler.jsonc` keeps 2,000 ms for a deployment, where each tick is a request to a remote sandbox. At 64 slots the phases take about twice as long as at 16 and the machine's load average passed 15, so 64 slots finished 264 attempts only 1.2 times as fast per attempt as 32 slots did 132.

### Oracle runs

`nanoeval run --oracle` sends each task with its `solution/`, attaches the hand as in any run, runs `solution/solve.sh` in the slot under the agent timeout, and then the verifier. It exists because the first Terminal-Bench run below scored 0 on every task without one infrastructure error: a task's `tests/test.sh` writes reward 0 when it cannot install its own dependencies, and nanoeval cannot tell that from a wrong answer. An oracle run that does not pass says the environment or the verifier is broken before a model is paid for. A run with a model agent refuses a task that carries its solution, and an oracle run has the oracle as its only agent.

### Terminal-Bench 2.1

The 89 task packages of Terminal-Bench 2.1 all name a `docker_image`, allow the internet and ask for no GPU. 87 load. `mcmc-sampling-stan` and `rstan-to-pystan` set `custom_docker_compose` and are refused. With their solutions the 87 send 27.8 MB in base64, 15.3 MB of it for `train-fasttext`.

The sample is 11 tasks whose images were already on the machine (117 to 531 MB): `build-pmars`, `cancel-async-tasks`, `feal-differential-cryptanalysis`, `kv-store-grpc`, `largest-eigenval`, `log-summary-date-ranges`, `openssl-selfsigned-cert`, `pytorch-model-cli`, `schemelike-metacircular-eval`, `sparql-university` and `vulnerable-secret`. Oracle runs, 6 slots, one attempt each:

| Sandbox | Passed | Wall | What failed |
| --- | ---: | ---: | --- |
| As the first version started it | 0 of 11 | 62 s | Every verifier: `uvx` could not fetch from pypi.org, `invalid peer certificate: UnknownIssuer`. The network re-signs TLS and the containers do not trust its signer |
| `sandboxd --ca-bundle` with the machine's bundle | 10 of 11 | 163 s | `pytorch-model-cli`'s verifier: the registry refused `filelock` 4.2.10, published the day before, which the verifier's unpinned dependencies resolve to |
| The same with `--slot-env` setting `UV_EXCLUDE_NEWER` to eight days earlier | 11 of 11 | 118 s | Nothing |

The third run went through the installed services at their tick of 2,000 ms then: environment 2.1 s, hand attach 2.1 s, solution 2.9 s (51.7 s at most), verifier 17.2 s (67.5 s at most), as medians. The other 76 tasks have not run, so nothing here says how many of the 87 work.

What these tasks needed that the sample tasks did not:

- **Files.** A task that names a `docker_image` now sends only `tests/`: the image is its environment, and four tasks carry 4 to 13 MB of `environment/` that the image already holds. A run kept each task and its files in one row and parsed it for every admission step. It now stores files in 524,288-character parts beside a small record that is parsed once per object, and the request body reaches the run without being parsed and written out again. Local workerd accepted a 4.2 MB row in the old layout, so the 2 MB row limit of Durable Object storage was not met here: the failures lane sends a 3 MiB test file through a slot either way.
- **Trust and registry policy.** Both are properties of the machine's network, so `sandboxd` takes them and `slot.sh` applies them to every slot container: `--ca-bundle` mounts the bundle and names it in `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, `PIP_CERT`, `NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO` and `CARGO_HTTP_CAINFO`, and `--slot-env` passes a file of variables. The agent sees them too, and a run on such a machine is not the same environment as one on an open network. The sandbox's capabilities record `ca_bundle` and `slot_env`.
- **Build timeout.** `environment.build_timeout_sec` (600 s in these tasks) bounds the environment phase when a task sets it, and `--setup-sec` otherwise. One lock no longer serializes every image pull in a sandbox: the lock is per image.
- **What the verifier finds.** The hand is stopped before the verifier runs (`hand.status` was `exit:143` and the container held no hand process while a verifier ran). The released hand also ends the process group of a command when the command's shell exits, so a process started with a plain `&` is dead once the command returns, in every backend: after `sleep 300.5 & echo $! > background.pid` the verifier found a zombie in a Docker slot, whose first process never reaps, and no process in a directory slot. A process started in its own session survives the command and the hand's stop. A fixture in the failures lane checks that in a Docker slot, and its verifier reads `/proc/<pid>/stat` and refuses a zombie. The first version of the fixture used the plain `&` and `kill -0`, which succeeds on a zombie, so it passed without showing anything.
- **Not enforced.** `storage_mb` is read and ignored. The images of the sample have `bash`, so the limit recorded in the first entry did not come up.

### Slots on one machine share its network

Local Docker slots use the host network, so every slot sees the machine's loopback and its ports. Checked with three containers on the host network: one served HTTP on a loopback port, the second read from it, and the third could not bind the port (`Address already in use`). Attempts that listen on a fixed port are therefore not isolated from each other or from the machine's own services, and a verifier can reach another attempt's server. No result in this entry was traced to that: two oracle attempts of `kv-store-grpc` at once both passed. A slot with its own network stack is the fix, and it is not built.

### Plan logins

The machine had no API key. It had a ChatGPT plan login of the Codex CLI and an expired Claude Code login.

nanocode-ts opens a session in its subscription mode when `App.create`'s `subscription` answers true for the provider, and then expects the egress to add the plan's credential. `worker/Sessions.ts` answers true when the plan's variables are set and adds `Authorization: Bearer` for Claude, and that with `chatgpt-account-id` for Codex. Codex plan requests are WebSocket upgrades to chatgpt.com, which according to nanocode-egress refuses workerd, so they go to that package's relay on a loopback port. A direct connection was not tried here. `nanoeval worker` reads the access token from the login file at start, never the refresh token, and never writes the login file. It hands the variables to wrangler in a mode 600 file in a private temporary directory instead of `--var`, which put them on a command line.

```sh
NANOEVAL_E2E_MODEL=codex-plan NANOEVAL_E2E_THINKING=low node test/e2e.ts
```

| Lane | Attempts | Slots | Wall | Agent | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| `gpt-6-luna`, thinking low, ChatGPT plan, Docker slots, 2 tasks × 2 attempts, commit `a55f5aa` | 4 | 4 | 65.8 s | 23.4 s | 4 passed, 0 errored, $0.0103 by the harness's estimate |
| Same lane, second run, from a fresh clone of commit `666bfbc` | 4 | 4 | 28.6 s | 23.9 s | 4 passed, 0 errored, $0.0091 |

`NANOEVAL_E2E_MODEL=claude-plan` stopped before its run because the login had expired, so the Claude plan path has not carried a request. `NANOEVAL_E2E_MODEL=anthropic` was not run on this machine: it has no key.

Five Terminal-Bench tasks with `gpt-6-luna` at its default thinking, one attempt each, five slots at once, through the installed services (tick 2,000 ms):

| Task | Result | Agent | Model calls | Estimate |
| --- | --- | ---: | ---: | ---: |
| `openssl-selfsigned-cert` | passed | 26.4 s | 5 | $0.0024 |
| `cancel-async-tasks` | passed | 35.7 s | 4 | $0.0020 |
| `build-pmars` | passed | 118.5 s | 14 | $0.0084 |
| `log-summary-date-ranges` | failed: one count was 414 where the verifier expects 370 | 24.3 s | 4 | $0.0034 |
| `kv-store-grpc` | failed: `Connection refused` on its port at verification. The model had started the server with `python3 /app/server.py ... &`, which the hand most likely ended when the command returned, as above. That was not traced further. In a second run of the task alone the model left the server in an open exec session and passed, in 105 s | 52.2 s | 8 | $0.0040 |

The run took 134 s, with a median of 35.7 s in the agent and 9.3 s in the verifier, 551,832 input tokens of which 422,144 were cached, 6,118 output tokens, and $0.0202 by the harness's estimate. No attempt errored. The exported Harbor job is 824 KB, and its largest file is a 278 KB `events.jsonl`. Five attempts say nothing about a pass rate.

The harbor route used to return every artifact of a run in one response. It now returns the result files and the artifact names, and the CLI reads each artifact from its own route, so an export does not grow into one response with the run.

### Services on one machine

`scripts/install-linux.sh` writes two systemd user services on loopback, `nanoeval-sandboxd` and `nanoeval-worker`, generates their tokens into a mode 600 file, and installs a `nanoeval` command that reads it. `sandboxd` runs with `KillMode=process`, so restarting it leaves the phases that slots are running. Deleting a sandbox did not run `slot.sh destroy` before: the delete route called bash with an empty script path and ignored the failure, so a verifier still running in a deleted sandbox kept running. With the route fixed it was gone after the delete. From a login shell, `nanoeval run --oracle --task tasks/extract-todos --task tasks/write-greeting --slots 2 --wait` passed both attempts and wrote the job under the runs directory, and so did `--agent luna=codex:gpt-6-luna:low` on `extract-todos` and `uppercase-message` ($0.0067). The README's commands were also run as written: `nanoeval sandboxd`, `nanoeval worker`, then `nanoeval run` with `--oracle` (4 of 4 passed) and with `--agent haiku=claude:claude-haiku-4-5`, which ended as an `agent` error that says `ANTHROPIC_API_KEY is not set`.

### Limits of this version

- Slots on one machine share its network.
- The hand ends a command's process group when the command returns, so an agent that must leave a server running has to detach it or keep its session open.
- A plan login is read once. When it expires, its attempts end as `agent` errors until someone signs in again and restarts the Worker.
- The installed Worker runs from the checkout under `wrangler dev`, which reloads it when a source file changes.
- A verifier that cannot install its dependencies writes reward 0, and the attempt is scored as failed. Only an oracle run shows it.
- `storage_mb` is not enforced, and nothing removes the environment images that slots build.

## 2026-11-10: krun slots

Machine: the one of the entry above, with libkrunfw 5.5.0 (guest kernel 6.12.91), libkrun at `df85b8b` built from source with Rust 1.97.1, an ext4 filesystem 93% full, and other work running throughout (load average 2 to 6 before each run). The lanes ran once each from a fresh clone of commit `0c246f6`, with the scripted model unless a row says oracle. The slot and image timings further down were taken by calling `slot.sh` directly, on the same code before its last rebase.

### What was kept from the earlier microVM code

gakonst/nanoeval and nanocode's `crates/nanocodex-vm` both pinned libkrun `df85b8b` with features `blk` and `net` and loaded `libkrunfw.so.5` through the dynamic loader. The machine still had that firmware, so the pin is unchanged, without `net`. `crates/nanovm` is ported as `krun/nanovm`. The guest overlay of `nanocodex-vm` (a read-only image disk under a sparse upper disk per attempt) is kept, written again in `krun/guest`. The guest tool proxy and its JSON protocol over the virtio console are not: the hand runs in the guest and dials out, and what remains is an exec port over vsock for the hand, the solution and the verifier. Their recorded numbers were 89.8 ms to a ready guest on x86_64 KVM and 250 to 316 ms on another Linux host. Here a guest answers 84 ms after its VMM starts (12 boots in a row, 2 vCPUs, 1 GiB, including the copy of its upper disk).

Cargo could not resolve a new lockfile on this machine, whose registry holds back crates published in the last days. `krun/Cargo.lock` therefore starts from the lockfile of gakonst/nanoeval, which pins the same libkrun.

### Decisions the box settled

- **The image disk is written in a microVM.** `docker export` of a 1.04 GB archive (30,152 entries) became an ext4 disk in 4.4 to 4.9 s in the builder microVM, and in 4.3 s with `mke2fs -d` under fakeroot. Both listed the same paths, types, modes, owners, link targets and file sizes when booted. The builder needs nothing installed and no faked ownership, so it stays.
- **Copy-on-write is an overlay in the guest.** For that 1 GB image: a copied tree took 0.70 s on an idle disk and 0.99 s under load, a sparse copy of the ext4 disk 0.27 s and 0.42 s, each with 1 GB allocated per slot. An empty 10 GiB upper disk took 15 ms and 4 MB (0.33 s when the disk was busy). A host overlayfs was not possible without root: `unshare -Urm` fails writing `uid_map` on this machine. A device-mapper snapshot needs root and a module that was not loaded, and qemu-img did not run from a user's directory, so neither was measured.
- **A guest is ready when it says so.** libkrun binds the host socket of a vsock port before the guest listens, and a connection made in that window hung for 5 s before it was refused: every first boot took 5.08 s. The guest now prints a line on its console once it listens, and `ready` waits for that line before it connects.
- **Guests use the host's resolver.** The first version gave guests the nameservers behind the host's stub resolver, which skipped what the stub enforces: package registries resolved to their real addresses and three Terminal-Bench verifiers passed that fail in a Docker slot without the host's certificate bundle. Guests now get `/etc/resolv.conf` as it is. glibc reaches a resolver on the host's loopback only over TCP (`options use-vc`), because a connected UDP socket to a loopback address stays in the guest. musl sends unconnected datagrams and needs nothing.
- **Stopping a hand sends SIGTERM to the hand alone**, as a Docker slot does, so a hand ends the same way in both backends. The first version sent SIGKILL to its process group.
- **`down` waits for the VMM to exit.** `tail --pid` polls once a second by default, which made every slot take a second to go down. At 10 ms, one slot goes down in 39 ms and 32 together in 0.11 s. The check that the pid still is the slot's VMM compared its working directory with an unresolved path and missed under a symlinked sandbox root, which left the microVM running until `destroy`. The path is resolved now.

### Lanes

| Lane | Backend | Attempts | Slots | Wall | Result |
| --- | --- | ---: | ---: | ---: | --- |
| Scripted model | krun | 8 | 4 | 6.4 s | 4 passed, 4 failed as scripted |
| Scripted model | docker | 8 | 4 | 5.8 s | 4 passed, 4 failed as scripted |
| Oracle, with a certificate bundle | krun | 3 | 4 | 3.7 s | 3 passed |
| Oracle, with a certificate bundle | docker | 3 | 4 | 3.7 s | 3 passed |
| Failure kinds and fixtures | krun | 5 | 4 | not recorded | 2 passed, 1 failed, 2 errored, each as designed |
| Failure kinds and fixtures | docker | 5 | 4 | not recorded | 2 passed, 1 failed, 2 errored, each as designed |
| Worker killed and restarted once | krun | 8 | 4 | 6.3 s | 4 passed, 4 failed as scripted |
| Worker killed and restarted once | docker | 8 | 4 | 6.4 s | 4 passed, 4 failed as scripted |
| Scripted model | dir | 6 | 3 | 5.1 s | 3 passed, 3 failed as scripted |

After every krun lane no VMM process, no export container and no sandbox directory remained. The krun lanes also read each microVM's vCPUs and memory from its VMM and compare them with the task. With `ldconfig` replaced by one that lists no libkrunfw, the krun lane printed `e2e skipped` and exited 0 and the krun unit test was skipped. In an `ubuntu:24.04` container without `/dev/kvm` the lane was skipped the same way.

### Scale

2 tasks × 2 agents, one sandbox, 1 vCPU and 256 MiB per slot. Every run ended with half of its attempts passed and half failed as scripted, and none errored. Memory is the peak of the summed resident memory of the VMM processes for krun and of the containers' cgroups for docker, sampled twice a second.

| Backend | Slots | Attempts | Tick | Wall | Environment | Hand attach | Agent | Verifier | Memory |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| krun | 16 | 64 | 500 ms | 11.9 s | 0.70 s | 0.57 s | 0.55 s | 0.61 s | 1,185 MB |
| docker | 16 | 64 | 500 ms | 13.0 s | 0.74 s | 0.59 s | 0.57 s | 0.63 s | 50 MB |
| krun | 32 | 64 | 500 ms | 7.8 s | 0.95 s | 0.67 s | 0.61 s | 0.75 s | 2,368 MB |
| docker | 32 | 64 | 500 ms | 9.1 s | 1.01 s | 0.70 s | 0.63 s | 0.79 s | 97 MB |
| krun | 16 | 64 | 100 ms | 6.6 s | 0.32 s | 0.26 s | 0.30 s | 0.24 s | 1,182 MB |
| docker | 16 | 64 | 100 ms | 7.9 s | 0.38 s | 0.23 s | 0.29 s | 0.26 s | 49 MB |
| krun | 32 | 128 | 100 ms | 9.6 s | 0.54 s | 0.31 s | 0.58 s | 0.34 s | 2,369 MB |
| docker | 32 | 128 | 100 ms | 11.9 s | 0.58 s | 0.34 s | 0.62 s | 0.44 s | 80 MB |

A microVM slot is as fast as a container slot through every phase, and the tick still dominates both. It costs memory instead: about 74 MB of VMM per running 256 MiB guest against about 3 MB for a container of these tasks. An idle guest of that size held 52 MB, and an idle 2 GiB guest 84 MB.

Called directly, with the image disk cached, `slot.sh up` took 0.13 s for one krun slot and 0.12 to 0.15 s for one Docker slot. Started together, 16 krun slots were up in a median of 0.24 s (slowest 0.37 s) and 32 in 0.42 s (0.71 s). Docker: 0.26 s (0.38 s) and 0.46 s (0.77 s).

The first slot of an image also prepares its disk:

| Image | Disk | `up`, first slot | `up` after that |
| --- | ---: | ---: | ---: |
| The sample task's Alpine image | 11 MB | 1.14 s | 0.13 s |
| `alexgshaw/build-pmars:20251031` | 155 MB | 1.35 s | 0.13 s |
| `python:3.13-bookworm` | 1,047 MB | 6.69 s | 0.14 s |

### Terminal-Bench 2.1 with the tasks' own solutions

Four tasks, one oracle attempt each, four slots, 1 vCPU and 2 GiB each, the host's certificate bundle given to the sandbox.

| Task | krun | docker |
| --- | --- | --- |
| `build-pmars` | passed | passed |
| `openssl-selfsigned-cert` | passed | passed |
| `log-summary-date-ranges` | passed | passed |
| `kv-store-grpc` | failed | passed |

From the start of the harness to its end the run took 33.5 s on krun with at most 1,458 MB of VMM, and 31.0 s on docker with at most 941 MB in the containers. `kv-store-grpc` fails in the guest's network, not in the task: its verifier's gRPC client reports `Failed to set SO_REUSEADDR` on a TSI socket. The test harness itself exits nonzero on these runs, because its oracle lane expects exactly two artifacts and these verifiers also write `ctrf.json`.

### What TSI costs

Checked with two guests and a server on the host's loopback:

- A guest reads a server on the host's `127.0.0.1`, which is how the hand reaches a local Worker.
- Two guests each served on `127.0.0.1:8000` and each read its own server. Both listeners were also bound on the host by their VMMs.
- A guest with no listener on a port read the server another guest ran on that port of its loopback, and so did the host.
- A server on port 80 in a guest did not come up.

So a krun slot isolates the filesystem, the processes, the CPUs and the memory of an attempt, and not its network. The private network needs virtio-net. passt 2024-02 from the distribution's archive, run from a user's directory, exits with `Failed to sandbox process` where unprivileged user namespaces are restricted, and libkrun at this pin then panics with `BadActivate`. The system package or gvproxy, which gakonst/nanoeval used, is the way, with a relay in the guest so that the hand still finds a Worker on loopback.

### Limits of this version

- krun slots share the host's network through TSI, with the gaps above.
- Image disks in `~/.cache/nanoeval/krun` are never removed, and each is as large as its image.
- Admission counts a slot's declared memory. The VMM's own memory, 50 to 85 MB per guest here, is not counted.
- The launcher is built on the sandbox host with cargo, or handed over prebuilt. No release ships it.
- CI on a hosted runner skips the krun lane and has not run the krun job yet.

## 2026-11-10: a private network for every slot

Machine: the one of the two entries above, with passt `0.0~git20240220` from the distribution's package and other work running throughout (load average 8 to 30 while these ran, which is why some shared-network numbers are slower than the ones above). Every pair of rows below ran back to back on the same code, so the comparison is between the two networks on one afternoon and not with the earlier entries. Each lane is one run unless it gives several.

### What was wrong

Slots shared the machine's network, as `--network host` in Docker and through TSI in a microVM. Run again here with four attempts of Terminal-Bench's `kv-store-grpc` at once, which serves on port 5328:

| Backend | Network | Result | What happened |
| --- | --- | --- | --- |
| docker | host | 4 of 4 passed | Four servers listened on `*:5328` of the machine at once, which gRPC allows by binding with `SO_REUSEPORT`, so a verifier reaches whichever server the kernel picks. The four scores are not four measurements |
| krun | host | 0 of 4 passed | The verifier's client fails on a TSI socket with "Failed to set SO_REUSEADDR" |
| docker | private | 4 of 4 passed | Each slot has the port to itself |
| krun | private | 4 of 4 passed | The same, on a real guest socket |

### What the machine settled

- **Its package registries are on its loopback.** The machine's resolver answers the registry names with an address on the machine's own loopback, where a proxy re-signs TLS. That is why verifiers worked on the host network and on TSI, and why a slot with its own loopback got "Connection refused" from `pypi.org` in the first private container. No design that isolates the loopback can hide this, so it is host policy: `sandboxd --slot-forward ADDRESS:PORT` names the listener, every private slot listens on the same address of its own loopback, and the relay carries it. With it, `pip download` worked in a container and an 18.9 MB archive came through a guest's forward in 3.5 s.
- **Docker's embedded resolver asks the machine's resolver.** On a user-defined network a container's `resolv.conf` names `127.0.0.11` and records `ExtServers: [host(127.0.0.53)]`, and a registry name resolved to the same loopback address as on the host. The default bridge would have skipped the stub.
- **A bridge alone does not keep the host out.** On a plain user-defined network a process on the host and a second container both read a listener at the first container's address. With `enable_icc=false` the second container timed out and the host still read it. With the rule that `nanoeval-net firewall` writes into the container's namespace, both timed out, while the container still read itself on its loopback and on its own address, resolved names and reached HTTPS. The rule is `iifname "lo" accept`, `ct state established,related accept` under a policy of drop, written over netlink in one batch, and `docker exec --privileged` took 25 ms to apply it.
- **One Docker network per sandbox.** The daemon has no custom address pools and three bridge networks existed. A network took 44 ms to create and gave a /16. Per-slot networks were not built: 64 of them do not fit a default daemon's pools, and they would not have kept the host out either.
- **passt works as the distribution ships it.** The VMM makes a socket pair and starts `/usr/bin/passt --fd 0` on one end, and passt exits when the VMM is killed. The guest sets a fixed address itself, since libkrun's DHCP client waits only 100 ms. With `--no-map-gw` passt says "Couldn't get any nameserver address" at start, because it will not hand a guest the host's loopback resolver, and `--dns-forward` still reached that resolver: a registry name resolved in the guest as it does on the host.
- **What a private guest can and cannot do**, checked with two guests: a guest served on ports 80 and 5328 and read itself on its loopback and on its own address, and a bind with `SO_REUSEADDR` succeeded. The other guest got "Connection refused" on its loopback and a timeout at the gateway. The host had nothing bound on those ports, got "Connection refused" on its loopback and a timeout at the guest's address. A listener on the host's loopback was refused from the guest, and the gateway address did not lead to it.
- **gvproxy was read, not run in a guest.** v0.8.9, the release gakonst/nanoeval pinned: `cmd/gvproxy/config.go` maps `192.168.127.254` to the host's `127.0.0.1` when no NAT table is configured, and `main.go` serves `/services/forwarder/expose` on the gateway's port 80 inside the guest's network. Its binary is 12.9 MB. Both would have to be configured away for an untrusted guest, so passt was chosen.
- **A microVM's log could be missing.** `slot.sh` started the VMM in the background and then read its log, which the background shell had not always created: one attempt of a 64-attempt krun lane ended as an environment error with "vm.log: No such file or directory". The log is created first now, and six such lanes then ran without an error.

### Lanes

From a fresh clone of commit `cefe403`, one run per lane, on the private network that is now the default. The last column is the same lane with `NANOEVAL_E2E_NETWORK=host` from the working copy at `11f6727`.

| Lane | Backend | Attempts | Slots | Wall, private | Wall, host | Result |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Scripted model | docker | 8 | 4 | 12.3 s with the first build of `nanoeval-net`, 6.9 s in a second run | 6.6 s | 4 passed, 4 failed as scripted |
| Scripted model | krun | 8 | 4 | 6.0 s | 5.4 s | 4 passed, 4 failed as scripted |
| Oracle, with a certificate bundle | docker | 3 | 4 | 4.3 s | 5.0 s | 3 passed |
| Oracle, with a certificate bundle | krun | 3 | 4 | 3.8 s | 3.3 s | 3 passed |
| Failure kinds and fixtures | docker | 5 | 4 | not recorded | not run | 2 passed, 1 failed, 2 errored, each as designed |
| Failure kinds and fixtures | krun | 5 | 4 | not recorded | not run | 2 passed, 1 failed, 2 errored, each as designed |
| Worker killed and restarted once | docker | 8 | 4 | 7.7 s | 7.0 s | 4 passed, 4 failed as scripted |
| Worker killed and restarted once | krun | 8 | 4 | 6.6 s | 7.6 s | 4 passed, 4 failed as scripted |
| Slot networks | docker | 4 | 4 | 3.8 s after the two-slot checks | fails, as below | 4 passed |
| Slot networks | krun | 4 | 4 | 3.3 s after the two-slot checks | fails, as below | 4 passed |
| Scripted model | dir | 6 | 3 | not applicable | 5.6 s | 3 passed, 3 failed as scripted |

At four slots the two networks are within a tick of each other.

The network lane is new. It starts two slots through `slot.sh`, serves a token on port 5329 in one, and checks that the other slot and the host do not read that token on their loopbacks, at the gateway or at the container's address, that a listener on the host's loopback is refused, and that a name resolves and HTTPS answers. Then it runs one attempt per slot of a fixture whose agent serves on that port: the verifier reads its own slot's token, the agent and the verifier both reach HTTPS, the agent reaches its session, and the verifier reaches neither the session nor the host's loopback. With `NANOEVAL_E2E_NETWORK=host` the lane fails on docker with "a slot reached the listener of another slot on its loopback" and on krun with "the listener of a slot is bound on the loopback of the host".

Every lane now also counts the networks and relays of its sandboxes, and found none after any run, including the restart lanes.

### Scale

Scripted model, one sandbox, 1 CPU and 256 MiB per slot, tick 500 ms, 2 tasks × 2 agents for 32 slots and 3 tasks × 2 agents for 64. Every run ended with half of its attempts passed and half failed as scripted and none errored. Wall times are of three runs each, alternating between the networks, and the phase medians are of the second run.

| Backend | Network | Slots | Attempts | Wall | Environment | Hand attach | Agent | Verifier |
| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| docker | host | 32 | 64 | 10.0, 10.4, 10.1 s | 1.07 s | 0.75 s | 0.66 s | 0.83 s |
| docker | private | 32 | 64 | 16.9, 15.1, 15.2 s | 1.33 s | 0.72 s | 0.72 s | 1.00 s |
| krun | host | 32 | 64 | 9.0, 8.6, 8.2 s | 1.07 s | 0.80 s | 0.65 s | 0.75 s |
| krun | private | 32 | 64 | 9.7, 8.2, 8.8 s | 1.12 s | 0.74 s | 0.63 s | 0.73 s |
| docker | host | 64 | 264 | 37.3 s, one run | 1.91 s | 1.26 s | 1.49 s | 1.50 s |
| docker | private | 64 | 264 | 52.9 s, one run | 2.03 s | 1.18 s | 1.45 s | 1.51 s |

A private microVM costs nothing that these lanes can see. A private container costs Docker's bridge: the phases are close, and the run is half as long again, because the daemon attaches and detaches bridge endpoints one after another and a wave of slots waits for it at both ends. Removing a slot's container in the background instead was tried and changed nothing (16.2 and 16.1 s), so it was not kept. An attempt that runs for minutes will not notice. A lane of attempts that take a second does.

### What one slot costs

`slot.sh` called directly on the sample task with its image cached, one slot alone and then 32 or 64 started together:

| Backend | Network | One up | 32 up, median (slowest) | 64 up, median (slowest) | One down | 32 down together | 64 down together |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| docker | host | 0.12 to 0.16 s | 0.46 s (0.78 s) | 0.83 s (1.49 s) | 0.08 to 0.13 s | 0.40 s | 0.60 s |
| docker | private | 0.21 to 0.23 s | 0.66 s (1.07 s) | 1.21 s (2.11 s) | 0.17 s | 2.41 s | 4.31 s |
| docker | private, one forward | 0.25 s | 0.83 s (1.28 s) | not run | 0.27 s | 2.45 s | not run |
| krun | host | 0.13 s | 0.41 s (0.70 s) | not run | 0.04 s | 0.10 s | not run |
| krun | private | 0.14 s | 0.46 s (0.77 s) | not run | 0.05 s | 0.11 s | not run |
| krun | private, one forward | 0.14 s | 0.50 s (0.78 s) | not run | 0.05 s | 0.11 s | not run |

`docker rm -f` alone took 37 to 40 ms for a container on the host network and 146 to 171 ms for one on a bridge. In memory a private slot adds its relay, 0.5 MB of resident memory, and a Docker slot with a forward a second 0.5 MB process inside the container. A private guest adds its passt, 29.8 MB, and its VMM held 53.0 MB against 52.0 MB with TSI.

### Terminal-Bench 2.1 with the tasks' own solutions

Through `nanoeval sandboxd` with `--ca-bundle`, `--slot-env` setting `UV_EXCLUDE_NEWER` and `--slot-forward` for the registry proxy, a Worker at a tick of 500 ms, four slots, and the image disks of the earlier entry:

| Tasks | Backend | Network | Result | Wall |
| --- | --- | --- | --- | ---: |
| `kv-store-grpc`, 4 attempts at once | docker | private | 4 of 4 passed | 66 s |
| `kv-store-grpc`, 4 attempts at once | krun | private | 4 of 4 passed | 59 s |
| `build-pmars`, `openssl-selfsigned-cert`, `log-summary-date-ranges`, `cancel-async-tasks` | docker | private | 4 of 4 passed | 31 s |
| The same four | krun | private | 4 of 4 passed | 33 s |
| `kv-store-grpc`, 4 attempts at once | docker | host | 4 of 4 passed, sharing one port | 65 s |
| `kv-store-grpc`, 4 attempts at once | krun | host | 0 of 4 passed | 68 s |

After each run no container, network, relay, VMM, passt process or sandbox directory of that `sandboxd` remained.

### A killed sandboxd

`sandboxd` got SIGKILL eight seconds into four attempts of `kv-store-grpc`, with the hands attached, and was started again 0.2 s later, as its service does. The relays, the containers or microVMs with their passt processes, and the hands outlived it. Both runs finished with 4 of 4 passed, and nothing was left, on docker and on krun.

When it stayed down, the four attempts ended as environment errors ("Network connection lost") and the run finished without its sandbox: four containers, one network, four relays and the sandbox directory stayed. A `DELETE` of that sandbox on the restarted `sandboxd` removed all of them in 1.7 s. Nothing deletes such a sandbox on its own, with or without a private network.

### Limits of this version

- A hand of a private slot attached to a deployed Worker over `wss://` has not run. The slot's path for it is the plain outbound one that the HTTPS checks use.
- Docker's bridge makes a lane of very short attempts about half as long again at 32 and 64 slots.
- A private guest's passt, about 30 MB, is not counted by admission, like the VMM's own memory.
- A private slot reaches what the machine serves on its other addresses, and has IPv4 only.
- The private network needs cargo or a built `nanoeval-net` on a Docker host, and passt from the system's packages on a krun host. `--network host` needs neither.
- A sandbox whose `sandboxd` stays down past a run's retries is left until someone deletes it.
- CI on a hosted runner has not run the new lanes.

## 2026-11-10: dataset importers, final messages and a judge

Machine for every measurement in this entry: the 32-core Linux machine with KVM of the entries above, shared with other work throughout (load average near 7 before these runs). Each lane is one run, at the commit that adds `nanoeval import`, with the loader change for `version = "1.0"` added before the Terminal-Bench 2.0 lanes, `TICK_MS=500`, one local sandbox started with `--ca-bundle` and `--slot-env` (`UV_EXCLUDE_NEWER`), and a Worker on a ChatGPT plan login for the model lanes.

### What the earlier adapters were

nanocode's `crates/experimental/nanocodex-eval-adapters` at `2d4a4c539^` held fifteen adapters. Its history (the plan at `ef324d31b`, one commit per adapter on 2026-08-10) records what ran:

| Adapter | Recorded evidence |
| --- | --- |
| Harbor packages (Terminal-Bench 2.1, DeepSWE) | Run at scale: 890 of 890 Terminal-Bench 2.1 attempts |
| GPQA Diamond | All 198 rows imported, one case run and passed |
| GraphWalks | 1,150 rows imported, four cases run |
| HealthBench Professional | One case run with one rubric judgment |
| GDPval | One case run with a judge |
| SWE-bench Verified, Arena-Hard, GeneBench Pro, external manifests | One case each in a smoke gate, no score recorded. SWE-bench downloaded only the first row and graded with plain `pytest` |
| MRCR | Imported, no run recorded |
| SWE-Atlas QnA | Its only run failed before a model call |
| BrowseComp, Agents' Last Exam, OpenAI Evals | Tested against fixtures only |
| ARC-AGI-3 | A stub with a three-action cap |

So one adapter was proven and the rest were single cases. The ports here are the three that were small and real (Harbor packages, GPQA, HealthBench), and SWE-bench with a new grader.

### TypeScript in the CLI, not a Rust crate

The earlier adapters are about 6,200 lines of Rust against `nanocodex-eval`'s `import` module and task type (3,300 lines, gone). Reusing them as they are would mean reviving that module beside a TypeScript loader that already defines the task, its checksum and the CLI. `krun/` is Rust because it links libkrun. An importer links nothing: it downloads, hashes and writes files, and Node 24 does that with `fetch`, `node:crypto` and `node:zlib`. Two things needed code: a ZIP reader with the traditional PKWARE cipher (81 lines, `datasets/Zip.ts`) and CPython's Mersenne Twister shuffle (66 lines, `datasets/PythonRandom.ts`). The importers are 1,014 lines in all. Parquet is read by `hyparquet` 1.32.0, the one dependency added, with no dependencies of its own. On a machine that cannot resolve a fresh Cargo lockfile, the `csv`, `zip` and `parquet` crates would also have been the harder way.

### Terminal-Bench comes from the registry, by digest

- Harbor downloads task packages from its registry, a Supabase project that its client reads without a login ("public reads still work"). `GET /rest/v1/dataset_version` and `dataset_version_task` list a dataset version and its task packages, and `GET /storage/v1/object/packages/<archive_path>` is a `dist.tar.gz`. The publishable key of Harbor's client is the only credential.
- The package content hash is the checksum `src/Task.ts` already computes. A dataset is pinned by the SHA-256 over its sorted task digests joined with commas, which is Harbor's own dataset digest when a dataset has no extra files: for `terminal-bench/terminal-bench-2` the two are the same value, `c6fc2e23…`.
- `nanoeval import terminal-bench-2.1` wrote 89 directories. Against the 89 that Harbor had downloaded on this machine, every task has the same checksum and `diff -r` reports only the added `dataset.json`.
- The Git repository at the commit the earlier adapter pinned (`5c8eadf`) gives the same checksum for 88 tasks. `sanitize-git-repo` differs: its `tests/test_outputs.py` builds five fake credentials from two string literals each. The repository's `tasks/dataset.toml` lists the digest of that variant, the registry the other.
- Terminal-Bench 2.0 packages say `version = "1.0"` and have no `schema_version`, so the loader refused all 89. The fields nanoeval reads are the same, and the loader now takes that form.

### SWE-bench Verified is graded by the official package, in the verifier

`tests/test.sh` installs `uv`, then `swebench` 4.0.3 with the pins of Harbor's adapter, asks `make_test_spec` for the instance's evaluation script, runs it in the task's own shell, and lets `get_logs_eval`, `get_eval_tests_report` and `get_resolution_status` decide. The reward is 1 only for a full resolution.

- All 500 rows import in a second or two from a 2.1 MB Parquet file. The instance image of `psf__requests-1142` is 3.81 GB in Docker.
- With the gold patch the attempt passed: verifier 45.8 s, of which the run of the tests is a few seconds and the rest installs the grader. With `solution/solve.sh` replaced by `true` in a copy of the task, the attempt failed with reward 0, so the grader tells the two apart.
- Not run on krun slots: a second copy of the image as a disk would have taken the machine below the free space its other work was promised. One instance on one backend is what was shown.

### GPQA Diamond and HealthBench Professional

- `dataset.zip` of `idavidrein/gpqa` opens with the published password and the question file hashes to the pin of the earlier adapter. The shuffle matches CPython: six shuffles of `[0, 1, 2, 3]` after seed zero give the same orders in both.
- HealthBench Professional has 525 cases, 410 of them one user message. Their rubrics have 1 to 5 items, 2.2 on average.
- GPQA with `gpt-6-luna` at low thinking: 2 of 5 right, and the 3 failures are wrong letters in the asked format, read from the session events. HealthBench with the physician's answer as the oracle scores 0.03 and 0.64 on two cases, the same on both backends: the reward is a rubric score, and a reference answer is not a perfect one.

### Final messages and a judge

A turn's report already carries its last message, so handing it to the verifier is one file written into the slot's copy of `tests/`. A session accepts a turn without a hand under `hands: 'always'`, which is what makes a judge a session: the end-to-end lane passed on its first run with the scripted model.

| Lane | Backend | Attempts | Wall | Agent | Verifier | Result |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| End to end, final message and judge, scripted model | Docker | 8 | 8.5 s | 0.65 s | 1.6 s, judge 0.73 s | 4 passed, 4 failed as scripted |
| Same, oracle | krun | 2 | 5.1 s | 0.57 s | 1.8 s, judge 0.59 s | 2 passed |
| Terminal-Bench 2.1, 4 tasks, oracle | Docker | 4 | 26.2 s | 0.5 s | 14.5 s | 4 passed |
| Terminal-Bench 2.1, same 4, oracle | krun | 4 | 28.3 s | 0.5 s | 13.9 s | 3 passed, 1 errored: `environment` |
| Terminal-Bench 2.1, the errored task again | krun | 1 | 18.1 s | 5.7 s | 8.4 s | 1 passed |
| Terminal-Bench 2.0, 2 tasks, oracle | Docker | 2 | 27.5 s | 0.5 s | 23.8 s | 2 passed |
| Terminal-Bench 2.0, same 2, oracle | krun | 2 | 26.2 s | 0.5 s | 23.8 s | 2 passed |
| SWE-bench Verified, 1 instance, gold patch | Docker | 1 | 49.1 s | 0.5 s | 45.8 s | 1 passed |
| SWE-bench Verified, same instance, empty patch | Docker | 1 | 38.2 s | 0.5 s | 33.6 s | 1 failed, reward 0 |
| GPQA Diamond, 5 tasks, oracle | Docker | 5 | 11.6 s | 0.5 s | 0.5 s | 5 passed |
| GPQA Diamond, same 5, oracle | krun | 5 | 7.2 s | 0.5 s | 0.5 s | 5 passed |
| GPQA Diamond, same 5, `gpt-6-luna` low | Docker | 5 | 25.1 s | 13.3 s | 0.6 s | 2 passed, 3 failed, $0.0075 |
| HealthBench Professional, 2 cases, oracle, judge `gpt-6-luna` low | Docker | 2 | 17.5 s | 0.6 s | 7.3 s | rewards 0.643 and 0.028, $0.0060 |
| HealthBench Professional, same 2, oracle, same judge | krun | 2 | 10.4 s | 0.5 s | 8.0 s | rewards 0.643 and 0.028, $0.0053 |
| HealthBench Professional, 3 cases, `gpt-6-luna` low, same judge | krun | 3 | 33.7 s | 23.4 s | 4.8 s | rewards 0.357, 0.617 and 1.031, $0.0114 |

Phase times are medians over the lane's attempts, and the verifier column includes the judge. Cost is the harness's estimate. The model lanes together cost $0.030.

- A judge call is a nanocode session turn: the three judgments of one HealthBench case took 28,008 input tokens and 128 output tokens, about 9,300 input tokens a call for prompts of a few hundred words, and $0.0029. A judge that is a bare model request would cost a fraction of that. It needs a second client per provider beside the session protocol, and waits for a reason.
- The one errored Terminal-Bench attempt is not about tasks: `nanoeval-krun ready` opened `vm.log` before the backgrounded VMM had created it ("vm.log: No such file or directory"). `slot.sh` starts the VMM with its output redirected in a background subshell and calls `ready` at once. The same task passed on the next run. The race is left to the krun slot code.

### Limits of this version

- An attempt passes at reward 1. A dataset with graded rewards reads as failed attempts beside a mean reward. Named rewards are not carried over.
- The judge sees nanocode's system prompt and could call a tool that no hand serves, which would end as a verifier timeout. It did not happen in the 7 attempts a real model judged.
- There is one judge round, and a grader must write the same prompts in both rounds.
- GPQA and HealthBench run with a network in the slot, so they are open-book here.
- SWE-bench instance images are named by tag. The verifier needs the network.
- The registry importer depends on a service another project runs. Its archives are kept in the source cache once fetched, and a pinned digest never changes meaning.
- Agents' Last Exam was not looked at beyond its source: its task archive is behind a Hugging Face login.
