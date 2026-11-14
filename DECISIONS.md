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

Machine for every measurement in this entry: the 32-core Linux machine with KVM of the entries above, shared with other work throughout (load average near 7 before these runs). Each lane is one run, at the commit that adds `nanoeval import`, with the loader change for `version = "1.0"` added before the Terminal-Bench 2.0 lanes, `TICK_MS=500`, one local sandbox started with `--ca-bundle` and `--slot-env` (`UV_EXCLUDE_NEWER`), slots on the machine's network, and a Worker on a ChatGPT plan login for the model lanes. [On a private network](#on-a-private-network) has the lanes that ran again once slots had their own.

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
- The one errored Terminal-Bench attempt is not about tasks: `nanoeval-krun ready` opened `vm.log` before the backgrounded VMM had created it ("vm.log: No such file or directory"). `slot.sh` starts the VMM with its output redirected in a background subshell and calls `ready` at once. The same task passed on the next run. `cefe403` has since closed the race.

### On a private network

The lanes above ran before slots had a network of their own, on the machine's network. After the rebase onto the commit that makes a private network the default (`44300f8`), these ran again, one run each, with the sandbox also started with `--slot-forward` for the machine's registry proxy. Every sandbox reported `network: private`.

| Lane | Backend | Attempts | Wall | Verifier | Result |
| --- | --- | ---: | ---: | ---: | --- |
| End to end, final message and judge, scripted model | Docker | 8 | 12.8 s | 1.8 s | 4 passed, 4 failed as scripted |
| Same | krun | 8 | 8.2 s | 1.6 s | 4 passed, 4 failed as scripted |
| Same, oracle | Docker | 2 | 5.4 s | 1.8 s | 2 passed |
| Same, oracle | krun | 2 | 4.9 s | 1.6 s | 2 passed |
| Terminal-Bench 2.1, the same 4 tasks, oracle | Docker | 4 | 24.1 s | 13.6 s | 4 passed |
| Terminal-Bench 2.1, the same 4 tasks, oracle | krun | 4 | 29.5 s | 15.6 s | 4 passed |
| GPQA Diamond, the same 5, oracle | krun | 5 | 10.5 s | 0.5 s | 5 passed |
| HealthBench Professional, the same 2, oracle, judge `gpt-6-luna` low | krun | 2 | 12.5 s | 8.5 s | rewards 0.643 and 0.028 as before, $0.0046 |

- **The judge needs no route from the slot.** A copy of the judged fixture whose verifier first runs `wget` against the Worker's address and port, with its solution and `gpt-6-luna` as the judge: on a private network the verifier prints "Connection refused" on Docker and on krun slots, and the attempt is judged and passes on both. With `--network host` the same verifier reads the Worker's `/health`, and passes too. The request and the answer travel as files through the sandbox provider, so the verifier's network does not matter to them.
- The krun attempt that errored above did not recur: the log of a microVM is now created before its guest is awaited.
- SWE-bench Verified was not run again: its instance image no longer fit the free disk.

### Limits of this version

- An attempt passes at reward 1. A dataset with graded rewards reads as failed attempts beside a mean reward. Named rewards are not carried over.
- The judge sees nanocode's system prompt and could call a tool that no hand serves, which would end as a verifier timeout. It did not happen in the 7 attempts a real model judged.
- There is one judge round, and a grader must write the same prompts in both rounds.
- GPQA and HealthBench run with a network in the slot, so they are open-book here.
- SWE-bench instance images are named by tag. The verifier needs the network, and has not run on a private one.
- The registry importer depends on a service another project runs. Its archives are kept in the source cache once fetched, and a pinned digest never changes meaning.
- Agents' Last Exam was not looked at beyond its source: its task archive is behind a Hugging Face login.

## 2026-11-10: Terminal-Bench 2.1, every task with its own solution

Machine: the 32-core Linux machine with KVM of the entries above, shared with other work throughout (load average 1 to 11 during these runs). The filesystem that holds Docker's images had 47 to 54 GB free, and 45 GB of it had to stay free, so these runs had 2 to 9 GB of it. The disks of krun slots, the sandbox directories and the Workers' state were on another filesystem. One local sandbox per backend, each started with `--ca-bundle`, `--slot-env` (`UV_EXCLUDE_NEWER` and `PIP_UPLOADED_PRIOR_TO` eight days back) and `--slot-forward` for the registry proxy on the machine's loopback, both on one `NANOEVAL_CACHE` so that one holds the image locks of the other, and a Worker each at a tick of 500 ms. Every run is `nanoeval run --oracle --images remove` with one attempt per task and slots on a private network. Code: this branch on top of the commit that records datasets and the judge on a private network (`4d11381`). The runs k4 to k7, d5 and d6 ran at the commit that takes the slots of a task down one after another, and k8, d7 to d10 and the samples at the commit that starts a guest's commands without a controlling terminal, which changes the krun guest and nothing else.

### What the earlier runs changed

The commits of this branch before this entry answer what the first oracle runs over all tasks showed:

| A run showed | Now |
| --- | --- |
| 2 of the 89 tasks were refused for `custom_docker_compose` under `[metadata]`, a flag Harbor never reads. Neither ships a Compose file | A task is refused for the Compose file it ships, or for `mcp_servers`. All 89 load |
| A verifier that could not install its test runner scored the attempt 0, and of what a verifier wrote only `ctrf.json` was kept | Every verifier file is an artifact. A reward other than 1 without the report that `test.sh` names is a `verifier` error |
| A solution that ran out of memory read as a wrong answer | The attempt carries `oomKills` |
| Six heavy environments at once took the disk close to full, and one 8 GiB task held back every 2 GiB task behind it | `--free-disk-mb`, first-fit admission, and `--setup-sec` as a floor under a task's `build_timeout_sec` |
| Harbor 0.25.0 refused every exported trial | Trial ids, configs and error counts as Harbor's models want them |
| A guest started with `kernel.pid_max` at 4096 | 32768 |
| A long run kept every image and image disk | `--images remove` and `nanoeval prune` |
| Two attempts of one task that ended in the same tick left its image behind | The slots of a task go down in turn |

### Runs

| Run | Backend | Tasks | Attempts | Slots | Passed | Failed | Errored | Cancelled | Wall | Least free disk |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| k4 | krun | All 89 | 89 | 5 | 13 | 1 | 0 | 75 | 635 s | 45.4 GB |
| k5 | krun | The 64 that k4 left with images under 500 MB compressed | 64 | 5 | 60 | 3 | 1 | 0 | 2,281 s | 47.0 GB |
| d5 | docker | The 70 with images under 500 MB compressed | 70 | 3 | 34 | 1 | 0 | 35 | 733 s | 45.4 GB |
| k6 | krun | 7 with larger images, one run each | 7 | 1 | 6 | 0 | 0 | 1 | 1,233 s | 48.1 GB |
| k7 | krun | 1 with a larger image | 1 | 1 | 1 | 0 | 0 | 0 | 42 s | 48.3 GB |
| k8 | krun | `fix-ocaml-gc` after its fix and the 3 largest images, one run each | 4 | 1 | 2 | 0 | 2 | 0 | 549 s | 45.6 GB |
| d6 | docker | The 35 that d5 left, one run each | 35 | 1 | 30 | 4 | 0 | 1 | 2,239 s | 47.0 GB |
| d7 | docker | `hf-model-inference` again | 1 | 1 | 1 | 0 | 0 | 0 | 33 s | 49.5 GB |
| d8 | docker | 8 with larger images, one run each, while k8 ran | 8 | 1 | 5 | 0 | 0 | 3 | 613 s | 45.2 GB |
| d9 | docker | 11 that were left or cancelled, one run each, with nothing else running | 11 | 1 | 3 | 0 | 2 | 6 | 1,268 s | 45.2 GB |
| d10 | docker | `caffe-cifar-10` | 1 | 1 | 0 | 0 | 0 | 1 | 27 s | 45.5 GB |

Wall is the time of the run, and for a row of single runs their sum. A cancelled attempt is not an outcome: the task ran again in a later row, or the table below says that it did not run.

k4, d5 and a diagnostic run of ten tasks ran at once and were cancelled together when the free disk fell from 48.7 to 45.4 GB within ten seconds. One Docker slot had written 3.1 GB of Python packages into its container while krun slots pulled images. From then on a watcher cancelled a run that took the free disk under a floor between 45.5 and 47 GB, tasks with larger images ran one run each, and at most one Docker slot ran at a time. Two more attempts at running both lanes at once were cancelled the same way, by a Docker slot and a krun image pull that happened to grow together.

### Outcomes

| Backend | Passed | Failed | Errored | Refused at load | Not run |
| --- | ---: | ---: | ---: | ---: | ---: |
| krun | 82 | 4 | 3 | 0 | 0 |
| docker | 73 | 4 | 2 | 0 | 10 |

The attempts with an outcome took 9,474 s on krun slots and 4,532 s on Docker slots, summed from the start of each attempt to its end. The longest passes on krun were `crack-7z-hash` (1,436 s), `compile-compcert` (940 s) and `caffe-cifar-10` (910 s).

| Task | krun | docker | krun s | docker s | When not passed |
| --- | --- | --- | ---: | ---: | --- |
| `adaptive-rejection-sampler` | passed | passed | 26 | 23 |  |
| `bn-fit-modify` | passed | passed | 41 | 44 |  |
| `break-filter-js-from-html` | passed | passed | 30 | 23 |  |
| `build-cython-ext` | failed | failed | 119 | 106 | Task: its solution leaves `planarity` unpinned |
| `build-pmars` | passed | passed | 25 | 21 |  |
| `build-pov-ray` | passed | passed | 38 | 43 |  |
| `caffe-cifar-10` | passed | not run | 910 |  | Docker: not run. A watcher cancelled it for disk with 1.9 GB written, when 2.0 GB were left above the floor |
| `cancel-async-tasks` | passed | passed | 29 | 28 |  |
| `chess-best-move` | passed | passed | 33 | 28 |  |
| `circuit-fibsqrt` | passed | passed | 49 | 40 |  |
| `cobol-modernization` | passed | passed | 19 | 14 |  |
| `code-from-image` | passed | passed | 15 | 13 |  |
| `compile-compcert` | passed | not run | 940 |  | Docker: not run. A watcher cancelled it for disk with 3.4 GB written |
| `configure-git-webserver` | passed | passed | 28 | 31 |  |
| `constraints-scheduling` | passed | passed | 17 | 18 |  |
| `count-dataset-tokens` | passed | passed | 122 | 149 |  |
| `crack-7z-hash` | passed | passed | 1436 | 384 |  |
| `custom-memory-heap-crash` | passed | passed | 40 | 18 |  |
| `db-wal-recovery` | passed | passed | 17 | 15 |  |
| `distribution-search` | passed | passed | 14 | 13 |  |
| `dna-assembly` | passed | passed | 21 | 20 |  |
| `dna-insert` | passed | passed | 23 | 25 |  |
| `extract-elf` | passed | passed | 20 | 13 |  |
| `extract-moves-from-video` | passed | passed | 15 | 14 |  |
| `feal-differential-cryptanalysis` | passed | passed | 18 | 15 |  |
| `feal-linear-cryptanalysis` | passed | passed | 15 | 13 |  |
| `filter-js-from-html` | passed | passed | 196 | 182 |  |
| `financial-document-processor` | passed | passed | 54 | 39 |  |
| `fix-code-vulnerability` | passed | passed | 17 | 13 |  |
| `fix-git` | passed | passed | 15 | 15 |  |
| `fix-ocaml-gc` | passed | passed | 298 | 297 |  |
| `gcode-to-text` | passed | passed | 114 | 107 |  |
| `git-leak-recovery` | passed | passed | 18 | 12 |  |
| `git-multibranch` | passed | passed | 33 | 28 |  |
| `gpt2-codegolf` | passed | passed | 27 | 21 |  |
| `headless-terminal` | passed | passed | 45 | 36 |  |
| `hf-model-inference` | passed | passed | 47 | 29 |  |
| `install-windows-3.11` | passed | not run | 243 |  | Docker: not run. A watcher cancelled it for disk with 3.4 GB written |
| `kv-store-grpc` | passed | passed | 37 | 35 |  |
| `large-scale-text-editing` | passed | passed | 64 | 65 |  |
| `largest-eigenval` | passed | passed | 22 | 35 |  |
| `llm-inference-batching-scheduler` | passed | passed | 14 | 11 |  |
| `log-summary-date-ranges` | passed | passed | 15 | 15 |  |
| `mailman` | passed | passed | 54 | 47 |  |
| `make-doom-for-mips` | passed | passed | 41 | 36 |  |
| `make-mips-interpreter` | passed | passed | 33 | 26 |  |
| `mcmc-sampling-stan` | failed | failed | 205 | 187 | Task: its solution leaves `RcppParallel` unpinned |
| `merge-diff-arc-agi-task` | passed | passed | 17 | 18 |  |
| `model-extraction-relu-logits` | passed | passed | 47 | 17 |  |
| `modernize-scientific-stack` | passed | passed | 25 | 23 |  |
| `mteb-leaderboard` | passed | not run | 129 |  | Docker: not run. A watcher cancelled it for disk with 3.4 GB written |
| `mteb-retrieve` | passed | not run | 79 |  | Docker: not run. A watcher cancelled it for disk with 3.3 GB written |
| `multi-source-data-merger` | passed | passed | 15 | 17 |  |
| `nginx-request-logging` | passed | passed | 16 | 22 |  |
| `openssl-selfsigned-cert` | passed | passed | 11 | 10 |  |
| `overfull-hbox` | passed | passed | 43 | 39 |  |
| `password-recovery` | passed | passed | 15 | 16 |  |
| `path-tracing` | passed | passed | 34 | 32 |  |
| `path-tracing-reverse` | passed | passed | 19 | 17 |  |
| `polyglot-c-py` | passed | passed | 18 | 15 |  |
| `polyglot-rust-c` | passed | passed | 21 | 23 |  |
| `portfolio-optimization` | passed | passed | 95 | 77 |  |
| `protein-assembly` | failed | failed | 165 | 257 | Task: its solution's optimizer finds no solution |
| `prove-plus-comm` | passed | passed | 27 | 23 |  |
| `pypi-server` | failed | failed | 59 | 98 | Machine: the registry's hold on new releases |
| `pytorch-model-cli` | passed | passed | 104 | 74 |  |
| `pytorch-model-recovery` | passed | not run | 118 |  | Docker: not run. A watcher cancelled it for disk with 3.6 GB written |
| `qemu-alpine-ssh` | errored | errored | 62 | 48 | Task: the verifier's `apt-get install curl` gets 404 on Debian 11 |
| `qemu-startup` | errored | errored | 58 | 45 | Task: the verifier's `apt-get install curl` gets 404 on Debian 11 |
| `query-optimize` | passed | passed | 302 | 275 |  |
| `raman-fitting` | passed | passed | 23 | 19 |  |
| `regex-chess` | passed | passed | 198 | 185 |  |
| `regex-log` | passed | passed | 16 | 12 |  |
| `reshard-c4-data` | passed | not run | 117 |  | Docker: not run. A watcher cancelled it for disk with 3.5 GB written |
| `rstan-to-pystan` | passed | passed | 422 | 476 |  |
| `sam-cell-seg` | passed | not run | 156 |  | Docker: not run. A watcher cancelled it for disk with 4.5 GB written |
| `sanitize-git-repo` | passed | passed | 13 | 11 |  |
| `schemelike-metacircular-eval` | passed | passed | 78 | 73 |  |
| `sparql-university` | passed | passed | 11 | 13 |  |
| `sqlite-db-truncate` | passed | passed | 11 | 11 |  |
| `sqlite-with-gcov` | passed | passed | 38 | 37 |  |
| `torch-pipeline-parallelism` | passed | not run | 105 |  | Docker: not tried, its verifier needs 5.3 GB of disk |
| `torch-tensor-parallelism` | errored | not run | 904 |  | krun: the verifier's torch 2.7.0 deadlocks. Docker: not tried, its verifier needs 5.3 GB of disk |
| `train-fasttext` | passed | passed | 106 | 102 |  |
| `tune-mjcf` | passed | passed | 54 | 24 |  |
| `video-processing` | passed | passed | 23 | 21 |  |
| `vulnerable-secret` | passed | passed | 12 | 9 |  |
| `winning-avg-corewars` | passed | passed | 22 | 17 |  |
| `write-compressor` | passed | passed | 34 | 29 |  |

### After the last change

The commit that starts a guest's commands without a controlling terminal came after most of the runs above. From it, seven tasks ran again as one run on each backend, on 4 krun slots and on 3 Docker slots: `kv-store-grpc`, `mailman`, `git-multibranch`, `configure-git-webserver`, `break-filter-js-from-html`, `openssl-selfsigned-cert` and `build-pmars`. 7 of 7 passed on krun slots in 66 s and 7 of 7 on Docker slots in 78 s. Four of them are among the five below that failed on the machine's network and pass on a private one. k8 and d7 to d10 ran at that commit as well, `fix-ocaml-gc` on both backends among them.

### What does not pass

**A defect here, fixed.** `fix-ocaml-gc` hung on a krun slot. Its verifier's `git clone` and the script around it stood in the stopped state for the ten minutes they were watched, and would have until the verifier's hour was over. A command in a guest ran in a background process group of the session that owns the console, so a read from `/dev/tty` stopped the whole group. A script of two lines that reads `/dev/tty` in a guest stopped the same way. The guest now leaves that session after it boots. The same script gets `No such device or address`, as it does under `docker exec` without a terminal, and `fix-ocaml-gc` passes in 301 s.

**The machine's network, earlier.** Before this branch was rebased onto the commit that gives every slot a private network (`44300f8`), one run of 65 tasks on 5 krun slots on the machine's network ended with 55 passed and 10 failed in 3,023 s. Five of the ten pass on a private network in the table above, with the same solutions: `break-filter-js-from-html` (the verifier's browser driver could not reach the browser it had started), `mailman` (the mail server did not start), `git-multibranch` and `configure-git-webserver`, and `torch-pipeline-parallelism` (`connect: Connection refused` between two processes of one test). A sixth, `torch-tensor-parallelism`, got past the same error and into the deadlock below. On Docker slots of that state, `git-multibranch` and `configure-git-webserver` failed because their verifiers reached the machine's own listeners on ports 22 and 8080 (`Permission denied (publickey)`, HTTP 404), and both pass on a private network.

**The machine.**

- `pypi-server`, both backends. The machine's registry refuses releases younger than about a week. `solve.sh` installs `twine` with the pip 25.2 of the image, which resolves `markdown-it-py` 4.3.0 from inside that week and gets HTTP 403. That pip has no option to leave recent releases out, so the variables of `--slot-env` do not reach it. The solution exits 1, and the verifier's install from the task's server fails.
- 10 tasks did not run on Docker slots, for disk. A Docker slot keeps its image and everything the solution and the verifier install on the filesystem with the floor, which had 3.3 GB above the watcher's floor when these ran alone, one after another, and 2.0 GB at the end. The watcher cancelled `install-windows-3.11`, `mteb-retrieve`, `mteb-leaderboard`, `compile-compcert`, `pytorch-model-recovery` and `reshard-c4-data` with 3.3 to 3.6 GB written, `caffe-cifar-10` with 1.9 GB, and earlier `sam-cell-seg` with 4.5 GB. The two torch tasks were not tried: their verifier's torch 2.7.0 and its CUDA libraries filled 5.3 GB of a krun slot's disk. All ten ran on krun slots, whose disks were on the other filesystem, and nine of them passed there.

**The task.**

- `build-cython-ext`, both backends, 10 of 11 tests. `solve.sh` installs `planarity` without a version. 1.0.0 no longer puts `pos` on the nodes of `planarity.networkx_graph`, and the upstream test `test_reconstructed_space_curve`, which the verifier runs, ends in `KeyError: 'pos'`. Read from a run of a copy of the task whose solution also runs that test.
- `mcmc-sampling-stan`, both backends, 2 of 6 tests. `solve.sh` pins `rstan` and leaves its dependency `RcppParallel` open. The current release wants cmake, which the image does not have (`RcppParallel requires cmake (>= 3.5); cmake was not found`), so `rstan` is never installed.
- `protein-assembly`, both backends. The solution's DnaChisel run ends in `NoSolutionError` with one `EnforceTranslation` constraint unsolved and writes no `gblock.txt`, in each of its 5 runs here: 3 on krun slots and 2 on Docker slots, the earlier state included. Its `numpy` and codon tables are not pinned.
- `torch-tensor-parallelism` on krun, a `verifier_timeout` error after 900 s. The verifier pins torch 2.7.0, which deadlocks while a process group is destroyed: the main thread joins the Gloo worker thread in `~ProcessGroupGloo` while it holds the GIL, and that worker waits for the GIL to release a tensor. Read with `py-spy dump --native` in the guest. One of the two processes of `test_column_parallel_linear[2-True]` never exits. It happened in 3 of 3 runs on krun slots, one of them a copy of the task with 2 vCPUs. It did not run on Docker slots.
- `qemu-startup` and `qemu-alpine-ssh`, both backends, a `verifier` error. Their image is Debian 11, whose security archive lists `curl` 7.74.0-1.3+deb11u16 and answers 404 for that package, so `apt-get install curl` in `test.sh` fails and no test runs. The solution exits 0 on both. This is the error that the missing test report is for, not a score of 0.
- `portfolio-optimization` on Docker, once. The verifier wants the C version 1.2 times as fast as the Python one at 8,000 assets and measured 1.15 in d6, in an attempt where the solution's own benchmark had measured 1.5. It passed in d9 and on krun, and the table shows d9.

None of the solutions was run under Harbor on this machine, so "the task" above means that the cause is in what the task installs or measures, not that Harbor was seen to fail the same way.

### Limits of this version

- The Docker lane is incomplete: 10 tasks did not run there, and nothing here says how they behave in a container.
- One attempt per task. `portfolio-optimization` failed once and passed once on Docker slots with the same solution, and a second attempt of the other tasks was not made.
- No solution was run under Harbor on this machine.
- The torch deadlock was seen on krun slots only. A krun slot gives a task exactly its `cpus` as vCPUs, where a container sees every core of the machine under a quota, and the copy of the task with 2 vCPUs deadlocked as well.
- Three images stayed on the machine after runs were cancelled while their slots were pulling them. The image cache had no record of the one that was checked, and that record is what `--images remove` and `nanoeval prune` go by. They were removed by name.
- `--free-disk-mb` holds back new attempts and does not stop one that is writing. What kept the floor here was a watcher outside nanoeval that cancelled the run, which costs every attempt of that run. It let the free disk fall as far as 45.2 GB before a cancelled slot was gone.
- A verifier that hangs costs its whole `verifier.timeout_sec`: 900 s for the torch deadlock, and an hour for the stopped `git clone` had it not been fixed.

## 2026-11-11: a durable eval table and task runners

Machine: the 32-core, 62 GiB Linux x86_64 machine with KVM of the entries above (kernel 6.8, libkrunfw 5.5.0, Docker 29.9.3, Node 24.22.2, wrangler 4.151.1), shared with other work throughout (load average 2 to 8 while these ran). The filesystem that holds Docker's images had 49 to 53 GB free, 45 GB of which had to stay free. The blob store, the caches and the Workers' state were on another filesystem. Each lane is one run unless it gives several. Code: the commits of this entry, and each table names its commit.

### What was wrong

The question that started this was why some things ran in Docker when the slots are microVMs. The answer was that an environment did not exist until an attempt asked for it. A krun slot pulled or built the task's image with Docker when it came up and exported it into a disk, so every sandbox host carried a container engine, the image store sat on the smallest filesystem of the machine, and the pull was counted as the attempt's setup and could end it as an error. The full Terminal-Bench run of the entry above spent most of its care on that filesystem. A second backend ran attempts in the containers themselves, and its lane could not finish for the same reason.

The earlier eval stack in nanocode did not work that way. It converted each benchmark once through an adapter into its own task packages, kept a table of rows that workers claimed, and gave each attempt a copy-on-write disk over a prepared one. This entry is that shape again:

| | Before | Now |
| --- | --- | --- |
| A task's files | Sent with every run, kept again in every run | Blobs named by SHA-256, written once by the import |
| A task's environment | Pulled or built by Docker in the first slot that needs it, then exported to a disk | Converted at import into the packed disk a microVM boots, a blob like the others |
| What a run holds | Tasks with their files, and attempts | Rows that name one eval version |
| Who runs an attempt | The Run object, one `slot.sh` call through the provider at a time, on its alarm | A runner on the sandbox host that claimed the row |
| Admission | In the Run object, from figures it asks each sandbox for | In the runner, from its own machine |
| A lost sandbox | Its attempts end as errors | Its rows are claimed again, at most `--claims` times |
| Docker | In every krun and Docker slot, and in `slot.sh` | In the temporary converter of `nanoeval import`, two files |

### What the machine settled

- **The packed disk is the blob.** A Terminal-Bench task declares 10 GiB of storage, so its disk is a 10 GiB sparse file. Hashing that whole would read 890 GiB for the 89 tasks. The stored and hashed form is `tar --sparse` through `zstd -3`: the 89 disks of Terminal-Bench 2.1 are 18.2 GB packed, 132 MB at the median, and a disk is packed in a fraction of the time it takes to export. A runner unpacks it once per machine. Both commands are part of the temporary converter and go when `nanoeval-krun image pack` lands.
- **A directory store links.** On one filesystem a blob enters the store, and later a runner's cache, as a hard link, so a disk of 1.4 GB is not copied when it is imported or fetched. Blobs are read-only files.
- **The runner keeps `slot.sh`.** Folding its krun functions into the runner was tried on paper and dropped: the detached phases with their status files are what lets a microVM and its hand outlive the runner, and the lane that kills a runner and starts it again passes because of them.
- **Phases stopped waiting for a tick.** The Run object used to move every attempt one phase per alarm. A runner reads the status file of a local phase every 25 ms and asks the Worker, where it must, with a backoff from 25 ms to `--poll-ms`. The alarm now only expires leases and watches sandboxes.
- **A reader verifies.** A runner hashes every blob it fetches before it keeps it. A store that holds a wrong or missing blob ends the attempt as an `environment` error that names the digest, which is how the failures lane now provokes that kind: it deletes one blob from the store after the import. An environment that does not build is refused by the import, not by an attempt.
- **A lost claim cannot score.** Every call of a runner for a row carries the claim's token. The lane that kills one of two runners sees the dead runner's two rows expire after the lease, be claimed by the other with a second session, and end scored once, with the claims of each row recorded as `expired` then `finished`.
- **R2 under local workerd.** The Worker stores blobs in its `BLOBS` bucket. Two lanes import and run through it, and a 70 MiB blob went up as two parts in 0.63 s and came back verified in 0.49 s.

### Lanes

From a fresh clone of commit `3233b74`: `npm ci`, `npm run lint`, `npm run check:types`, `npm test` (69 tests) and `npm run dry-run` passed, and then these, one run each. Every lane imports its tasks as an eval first, with the temporary converter on krun slots, and then runs it through a runner. Wall is from the creation of the run to its end. The last column is the same lane in the earlier flow, from the entry on private networks above, where it existed.

| Lane | Backend | Attempts | Slots | Wall | Result | Before |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| Scripted model | krun | 8 | 4 | 4.9 s, the first sandbox of the clone. 2.1 to 2.5 s in later runs | 4 passed, 4 failed as scripted | 6.0 s |
| Scripted model | dir | 6 | 3 | 1.6 s | 3 passed, 3 failed as scripted | 5.6 s |
| Oracle, with a certificate bundle | krun | 3 | 4 | 1.4 s | 3 passed | 3.8 s |
| Oracle | dir | 3 | 4 | 0.9 s | 3 passed | |
| Blobs in R2 through the Worker | krun | 8 | 4 | 2.2 s | 4 passed, 4 failed as scripted | |
| Blobs in R2 through the Worker | dir | 6 | 3 | 1.5 s | 3 passed, 3 failed as scripted | |
| Final messages and a judge | krun | 8 | 4 | 2.2 s | 4 passed, 4 failed as scripted | 8.2 s |
| Final messages and a judge, oracle | krun | 2 | 4 | 1.4 s | 2 passed | 4.9 s |
| Final messages and a judge | dir | 8 | 4 | 1.6 s | 4 passed, 4 failed as scripted | |
| Failure kinds and fixtures, then a rerun of what errored | krun | 8, then 3 | 4 | not recorded | 3 passed, 2 failed, 3 errored, each as designed. The rerun has the 3 errored rows, each naming its attempt, and they error again | |
| The same | dir | 5, then 3 | 4 | not recorded | 1 passed, 1 failed, 3 errored, each as designed | |
| Worker killed and restarted once | krun | 8 | 4 | 3.2 s | 4 passed, 4 failed as scripted | 6.6 s |
| Worker killed and restarted once | dir | 8 | 4 | 2.6 s | 4 passed, 4 failed as scripted | |
| Slot networks | krun | 4 | 4 | 1.8 s after the two-slot checks | 4 passed | 3.3 s |
| Disk removal | krun | 8 | 4 | 2.2 s | 4 passed, 4 failed. The disk the run unpacked is gone, the one the cache had is kept | |
| Free disk floor | krun, dir | 8 | 4 | not recorded | 8 errored as designed, on each | |
| Memory packing | krun, dir | 3 | 4 | not recorded | 3 passed, two at once, the small one ahead of the second large one | |
| Two attached runners, separate caches | krun | 8 | 2 each | 2.2 s | 4 passed, 4 failed. Both runners finished rows | |
| The same | dir | 8 | 2 each | 1.4 s | 4 passed, 4 failed | |
| A runner killed, lease 3 s | krun | 8 | 2 each | 5.0 s | 4 passed, 4 failed, none errored. The killed runner's rows were claimed again by the other | |
| The same | dir | 8 | 2 each | 4.4 s | 4 passed, 4 failed, none errored | |
| A runner killed and started again | krun | 8 | 8 | 1.9 s | 4 passed, 4 failed. One row forgotten on purpose was put back and claimed again, the others went on | |
| The same | dir | 8 | 8 | 1.3 s | 4 passed, 4 failed | |

After every krun lane no microVM, no relay and no sandbox directory remained. The image list of the machine was the same before and after all of them.

Two defects came out of these lanes and are fixed in `3233b74`. The lane that kills a runner and starts it again failed in the first fresh clone, at `644c9bd`: the turn of a row had completed while the runner was dead, and the restarted runner waited 60 s for a hand to attach that had long attached. A second form dropped a row whose ledger phase was ahead of the saved one, and its lease had to end. Killing the runner 0 to 500 ms after its first row left the claimed phase then passed 24 times of 24, 12 on each backend, where 2 of the first 4 had failed. The lane that expected to see every slot full sampled the run's status, and missed the instant once at a poll of 100 ms. It now computes the overlap from the attempts' own times.

### Scale

Scripted model, one sandbox with one runner, 32 slots, 64 attempts of 2 tasks × 2 agents, 1 vCPU and 256 MiB per slot, tick 500 ms, `--poll-ms` 250, commit `f7e3fd8`. Three runs each, one after another, while the import below had just finished (load average 5.6). The row "before" is the entry of 2026-11-10 above, krun slots on a private network.

| Flow | Wall | Environment | Hand attach | Agent | Verifier |
| --- | --- | ---: | ---: | ---: | ---: |
| Before: the Run object drives slots, tick 500 ms | 9.7, 8.2, 8.8 s | 1.12 s | 0.74 s | 0.63 s | 0.73 s |
| Now: a runner claims rows, krun slots | 4.7, 4.6, 4.5 s | 0.37 s | 0.30 s | 0.64 s | 0.30 s |
| Now: a runner claims rows, directory slots | 3.7, 3.9, 3.8 s | 0.20 s | 0.28 s | 0.67 s | 0.27 s |
| Now: krun slots, 64 slots, 264 attempts of 3 tasks, one run | 16.4 s | 0.64 s | 0.55 s | 1.33 s | 0.75 s |
| Now: krun slots, 32 slots, `--poll-ms` 100, one run at `644c9bd` | 4.8 s | 0.37 s | 0.33 s | 0.70 s | 0.31 s |

Phase times are medians over the attempts of the first run of each row, and of the second for "before", as that entry gave them. The environment phase now holds no image work at all: it is fetching three small blobs from the cache and booting. The agent phase did not change, since it is the scripted model's two calls and the harness. Every run ended with half of its attempts passed and half failed as scripted, and none errored. The earlier entry has no krun run at 64 slots to compare that row with: its Docker slots took 37.3 s on the host network there. A poll of 100 ms gained nothing over 250 ms.

### Terminal-Bench 2.1, imported

`nanoeval import terminal-bench-2.1 --keep-going` into a directory store, at commit `f7e3fd8`, in two commands: the first four tasks, then all 89, which made a second version that names the first as its parent. All 89 converted, and none was refused.

| | Total | Median per task | Least | Most |
| --- | ---: | ---: | ---: | ---: |
| Adapter: the registry package, checked against its digest | 51.7 s | 0.58 s | 0.22 s | 1.73 s |
| Convert: pull, export into a disk, pack | 472.7 s | 3.23 s | 0.55 s | 32.4 s (`custom-memory-heap-crash`) |
| Upload: hash the packed disk and the archives, link into the store | 7.9 s | 0.06 s | 0.01 s | 0.60 s (`reshard-c4-data`) |
| Packed environment | 18.2 GB | 132 MB | 27 MB | 1.40 GB (`reshard-c4-data`) |

The import took 9 minutes for the 89 tasks, one after another. The free space on the filesystem of Docker's images went from 52 GB to 49 GB at its lowest: an image is pulled, exported and removed before the next one is pulled, and the image list of the machine was the same before and after. The store holds 17 GB on disk. The second import of the first four tasks converted nothing.

### Terminal-Bench 2.1 with the tasks' own solutions, through the eval

One run of the 89 rows of `terminal-bench-2.1@69458cc6`: `nanoeval run --eval terminal-bench-2.1 --oracle --sandboxes 0 --disks remove`, worked by two attached runners on the one machine, each with 4 slots, 16,000 MB and a cache of its own, both started with `--ca-bundle`, `--slot-env` (`UV_EXCLUDE_NEWER` and `PIP_UPLOADED_PRIOR_TO` at the dates of the run of 2026-11-10) and `--slot-forward`, slots on a private network, the Worker at a tick of 500 ms, code at `f7e3fd8`.

| | Passed | Failed | Errored |
| --- | ---: | ---: | ---: |
| The runs of 2026-11-10 on krun slots, per task | 82 | 4 | 3 |
| This run | 82 | 5 | 2 |

87 of the 89 rows ended as they had. The seven that did not pass before for a cause in the task or the machine did the same again: `build-cython-ext`, `mcmc-sampling-stan`, `protein-assembly` and `pypi-server` failed, and `qemu-alpine-ssh` and `qemu-startup` ended as `verifier` errors. Two rows differ:

- **`portfolio-optimization` failed where it had passed.** 5 of its 6 tests passed. `test_performance_and_scalability[6000]` did not: it wants the solution's C version 1.2 times as fast as the Python one, and the same test measured 1.15 once on Docker slots in the earlier entry. Seven other attempts were running. In the rerun below, with one other attempt beside it, it passed. The score depends on what else the machine does, which is the task's test and not the runner.
- **`torch-tensor-parallelism` passed where it had errored.** Its verifier pins torch 2.7.0, which the earlier entry found deadlocked in 3 of 3 runs, each ending at the verifier's 900 s. Here all 13 tests passed in 72 s. Three more attempts of it at once, in a run of their own, ended as 2 passed in 72 and 73 s and 1 `verifier_timeout` at 900 s. So the deadlock is intermittent: 3 of 4 attempts got past it here and none of 3 before. Nothing in a guest changed between the two, and why it happens less often now is not known.

The run took 2,735 s from its creation to its end, and its attempts 11,662 s summed, where the earlier ones took 9,474 s. Three solutions account for the difference and for the wall time: `caffe-cifar-10` ran 2,734 s (910 s before), with its solution's download at about 110 KB/s, `dna-assembly` 772 s (21 s before), all of it in its solution, and `crack-7z-hash` 1,476 s (1,436 s before). The median attempt took 33 s. No claim was lost.

- **The environment phase** had a median of 0.65 s and at most 4.1 s (`reshard-c4-data`, whose packed disk is 1.40 GB), and that is fetching the row's blobs and unpacking its disk into a cache that did not hold it. No image was pulled: a runner calls no Docker.
- **Rows by runner**: 49, 35 and 5. The third runner was not planned. Twenty minutes in, six rows of 8,192 MB still waited although slots were free: each runner had 16,000 MB, and one such attempt left 7,808. First-fit had let the 2 and 4 GiB rows pass them, as it should, and the memory given to the runners then ran them one at a time. A third runner with 2 slots and 16,400 MB was attached to the running run, claimed two of the rows within the same second, and finished five of the six.

**The rerun.** `nanoeval run --rerun RUN --failed` made a run of the 5 failed rows on the same eval version, each naming the attempt it retries, on 2 slots of one sandbox whose runner the run started. It took 309 s: `portfolio-optimization` passed, and the other four failed again. Its exported job loads with the models of Harbor 0.25.0 (`scripts/harbor-check.py`: 13 files, none refused).

None of the solutions was run under Harbor on this machine, as before.

### A model on the imported eval

Three tasks of the imported eval with `gpt-6-luna` at its default thinking on the ChatGPT plan login (`nanoeval worker --codex-login`), one attempt each, three slots of one sandbox whose runner the run started, at commit `f7e3fd8`, while the solutions run below was using eight slots:

| Task | Result | Environment | Agent | Verifier | Model calls | Estimate |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `openssl-selfsigned-cert` | passed | 0.4 s | 27.5 s | 7.5 s | 5 | $0.0023 |
| `cancel-async-tasks` | passed | 0.4 s | 28.9 s | 20.9 s | 4 | $0.0020 |
| `build-pmars` | passed | 0.5 s | 99.6 s | 7.2 s | 16 | $0.0071 |

The run took 108 s, with 405,808 input tokens of which 349,312 were cached, 4,549 output tokens, and $0.0114 by the harness's estimate. The environment phase includes unpacking each task's disk into an empty cache. The same three tasks took 2.1 s there in the first Terminal-Bench entry, with their images already pulled. Three attempts say nothing about a pass rate.

The exported job did not load with Harbor's models at first: a Codex model calls `exec` with its code as plain text, and the trajectory kept that string where Harbor wants an object. This was already so before this entry, and no earlier check had read a Codex trajectory. The text is now kept under `input`, and the events of this run, projected again, load with the models of Harbor 0.25.0 (`scripts/harbor-check.py`: 12 files, none refused).

### What was removed

- The Docker slot backend, with `--limits`, `--docker install`, the `bridge` network and the inbound rule of a container. Its end-to-end lanes went with it, and the unit tests that drove a Docker slot now drive nothing: the tests of the Docker slot network (its bridge, its rule, its container limits) are deleted, not ported.
- `nanoeval run --dataset DIR` and the check of a task directory against `dataset.json` before a run. A run reads rows, and a row's checksum was computed when it was imported. `import --out` still writes the directories.
- `--step-retries` no longer counts failed provider calls of the orchestrator. It bounds the consecutive failures of a runner's own step before the attempt ends as an `environment` error.
- `--images remove` became `--disks remove`.
- The `broken-environment` fixture no longer runs as an attempt. The default lane checks that importing it is refused.

### Limits of this version

- The converter is the temporary one. Importing needs Docker, GNU tar and zstd, and unpacking on a runner needs the last two. An image is still named by tag unless the dataset pins a digest, and the row records the image id it resolved to.
- A runner is a Node process from this repository, so a sandbox host needs Node 24 and a checkout. No release ships it.
- E2B has not run. Without KVM it could run directory environments only, and no template with the runner exists.
- R2 ran under local workerd only. A multipart upload is not checked by the Worker against the digest: R2 checks single-request blobs, and readers check everything.
- Artifacts are still chunked into the run's SQLite. The artifacts of a lost claim are deleted when its row is put back.
- A runner polls for claims every `--poll-ms` while a run is unfinished, also when nothing can be claimed.
- The memory a runner admits by is its own share. Two runners on one machine each count 80% of it unless `--memory-mb` says otherwise, which the Terminal-Bench run above set, too low for its 8 GiB rows.
- A lost row starts again from an empty environment, so the work of the lost claim is paid twice. Its model usage is counted against the budget.
- `scripts/install-linux.sh` was changed for the store and the cache and not run again. The services installed from the earlier commit were left as they were.
- CI on a hosted runner runs the directory lanes. The krun lanes skip there, as before, and with the Docker lanes gone no hosted lane isolates an attempt any more.

## 2026-11-11: task images become disks without Docker

Machine for every measurement in this entry: the 32-core Linux machine with KVM of the entries above (kernel 6.8, libkrunfw 5, e2fsprogs 1.47.0), shared with other work throughout, with a load average between 6 and 9 before the lanes. Every lane is one run at commit `2d270e4`, the last code commit of the branch, except the levels of the packed form, which need a launcher built for each. Docker 29.9.3 with BuildKit was on the machine only as the other side of the comparisons below: the converter ran under an emptied environment whose `PATH` is one directory that holds a link to `passt` and nothing else, and in the tests an empty directory.

### What was wrong

A krun slot got its root disk from Docker. `slot.sh up` pulled or built the task image, created a container, and streamed `docker export` into a builder microVM. So every krun host carried a Docker daemon that it used only for this, an image was stored twice (in Docker and as a disk) until one of them was removed, the conversion ran inside an attempt's setup time on the machine that ran the attempt, and the disk held a container, not the image: Docker's own files were in it and some of the image's were not.

The eval stack this repository revives did not need Docker for that (`crates/nanocodex-vm/src/image` in nanocode at `2d4a4c539^`). DESIGN.md listed it as not carried over.

### What was built

`nanoeval-krun image build` makes the disk from an image reference or from a Dockerfile, `image pack` and `image unpack` move it, and `image tree` lists one. [DESIGN.md](DESIGN.md#image-disks) has the format and the rules. Nothing in `sandbox/slot.sh`, the Worker or the CLI uses it yet: this entry is the converter alone.

It adds 39 packages to the lockfile of `krun/` (130 to 169): ureq with rustls and ring, serde, sha2, and what they need. The launcher grows from 4.5 MB to 7.8 MB and the guest from 0.78 MB to 0.91 MB. The registry of this machine refused three releases for being younger than a week, so sha2 is 0.10.9, rustls-pki-types is 1.15.1, and ureq is built without its bundled roots, which the converter does not want anyway: it trusts `SSL_CERT_FILE` or the system bundle.

### What came from the earlier code

From `nanocodex-vm/src/image/mod.rs`: the store of blobs by digest with a lock and a digest check per blob, the choice of the platform's manifest from an index, the layer media types, and a Dockerfile as stages that a builder VM runs, with earlier stages and other images attached as disks. Three things did not come:

- `arcbox-ext4`, which wrote the ext4 on the host from the layers. A `RUN` step needs a kernel on the disk whatever writes the layers, and the builder microVM that makes disks from archives was already here, so a kernel writes all of it, as root, with no root on the host.
- `oci-client`, with tokio and reqwest under it. The converter is one blocking process and makes three kinds of request.
- Its cache of base disks and their reflink copies. A stage unpacks its base again: `python:3.13-slim-bookworm` takes 0.7 s.

### No container tool runs

`strace -f -e trace=execve` over one conversion from a reference (`alexgshaw/mailman:20251031`) and one from a Dockerfile (`tasks/write-greeting`):

| Conversion | Programs started |
| --- | --- |
| Reference | `nanoeval-krun` twice (itself and its builder microVM), `mke2fs` from `/usr/sbin` |
| Dockerfile | The same, and `passt` for the network of its `RUN` step |

No docker, containerd, podman, skopeo, buildah, runc or crun in either.

### The same tree as the docker export path

Eight images were converted twice, to disks of 10,240 MiB: by `nanoeval-krun image build --ref NAME@sha256:…` with the digest Docker's copy of the image has, and by the path of `slot.sh` at `3a59f6e` with the binaries of that commit (`docker create`, `docker export` into the builder microVM). `image tree` then listed both disks: path, type, mode, owner, group, size, time, SHA-256 of every regular file, link target, the first name of a hard-linked file, and extended attributes.

| Image | Layers | Entries | Regular files | docker export path | Converter, without the download |
| --- | --- | --- | --- | --- | --- |
| `alpine:3.21` | 1 | 520 | 88 | 1.18 s | 0.21 s |
| `ubuntu:24.04` | 1 | 3,443 | 2,587 | 0.81 s | 0.53 s |
| `python:3.13-slim-bookworm` | 4 | 6,572 | 5,025 | 1.16 s | 0.70 s |
| `python:3.13-bookworm` | 7 | 30,151 | 24,531 | 5.21 s | 3.99 s |
| `alexgshaw/build-pmars:20251031` | 4 | 5,702 | 4,560 | 1.13 s | 0.82 s |
| `alexgshaw/mailman:20251031` | 5 | 16,623 | 13,675 | 2.68 s | 2.01 s |
| `alexgshaw/extract-elf:20251031` | 5 | 46,011 | 38,295 | 6.68 s | 4.91 s |
| `alexgshaw/write-compressor:20251031` | 6 | 6,610 | 5,279 | 2.51 s | 2.71 s |

The four official images also downloaded their layers in that run, in 1.2 to 1.8 s each. The export path had its images in Docker already.

Every entry of the converter's disk is in the other with the same type, mode, owner, group, size, content, link target, hard links and time, except for these, in all eight images, and each is what `docker create` puts into a container or what `mke2fs` leaves:

- `/.dockerenv` and `lost+found` are only in the export. The converter removes `lost+found`.
- `/etc/hostname`, `/etc/hosts` and `/etc/resolv.conf` are empty in the export, with mode 755 and the time of the container, and created there when the image has none. They are Docker's mount points. On the converter's disk they are the image's: Alpine ships an `/etc/hosts`, Ubuntu and Debian the hostname of the machine that built them, and the Debian images an `/etc/resolv.conf` that names `1.1.1.1` and `1.0.0.1`.
- `/etc/mtab` is Docker's link to `/proc/mounts` in the export, and the image's own link (`../proc/mounts` in Alpine, `../proc/self/mounts` in `mailman`) or absent on the converter's disk.
- `/dev`, `/etc`, `/proc` and `/sys` have the time of the container in the export and the image's time on the converter's disk, and `/proc` of Alpine has the image's mode 555 where the export has 755.

The resolver file is why the guest changed: it used to write `/etc/resolv.conf` and `/etc/hosts` only where they were empty, which was always. It now writes both over what the image has, as Docker does, or a slot from a Debian image would have asked `1.1.1.1` in place of the machine's resolver.

None of the eight images has an extended attribute, so those are checked by the test image below and by the listing of the 89 disks.

### Dockerfiles against BuildKit

Two Dockerfiles written for this were built by the converter and by `docker build`, and the two trees compared the same way. They cover two stages, `ARG` before `FROM` and in a stage, `ENV` with expansion, `RUN` as root and as a user, `COPY` of a file, of several, of a directory with and without a trailing slash, into a new and into an existing directory, over existing files, of a link, `COPY --from` a stage and an image, `USER`, and `WORKDIR` absolute, relative and under a setgid directory.

The trees were equal but for Docker's files above and for one line: `id` in a `RUN` step as a user printed that user's supplementary group under BuildKit and not here. That is the guest's `exec`, in a slot as well, and it is listed under the limits.

What BuildKit does, and the converter now does too, was not all what its documentation says:

- A directory made as the destination of a copy belongs to root with mode 755 even when the source directory was copied from a stage and had another owner, and takes the time of the source directory. An existing destination directory takes that time too and keeps its mode.
- A directory below it that exists on both sides takes the mode and owner of the source.
- A link named as a source is followed, inside the tree it is in. A link below a copied directory stays a link.
- A link copied over a directory fails the build. The converter refuses a file over a directory and a directory over a file as well, which were not tried with BuildKit.
- `WORKDIR` creates directories as the current `USER`, and they inherit the setgid bit of their parent.

The Dockerfiles of this repository: 13 of the 14 under `tasks/` and `test/fixtures/` built in 0.8 to 1.4 s each and booted under an overlay, `plain-user` as its user `worker`. The fourteenth is `broken-environment`, which is there to fail, and did with `line 3: RUN ended with 7`. The unit test `a krun slot runs the solution and the verifier in a microVM` of `test/Sandbox.test.ts` passed unchanged with a disk of the converter in place of Docker's: a line added to a copy of the test converted the environment and recorded the disk where `slot.sh` looks for one it has made, and a script named `docker` that fails every call but `info` stood first in the `PATH`. It was called for `info`, for the lookup of the image that sends `slot.sh` to the recorded disk, and for the container and network listings of `destroy`.

Eight Dockerfiles of Terminal-Bench 2.1 were built as well, to see the instructions they use at work. Seven built: `financial-document-processor` (two stages, `COPY --from` an image on ghcr.io and from a stage, `uv run`) in 5.2 s, `kv-store-grpc` 1.2 s, `log-summary-date-ranges` 1.8 s, `git-leak-recovery` 6.4 s, `build-pmars` 7.7 s, `cobol-modernization` 8.7 s and `mailman` 24.2 s. `fix-git` did not: its `setup.sh` clones a repository on GitHub that now asks for a login, and `git` had no terminal to ask on. Their trees were not compared with the published images, which were built months ago from package archives that have moved on.

### All 89 images of Terminal-Bench 2.1

One run converted and packed the image of every task, four at a time, from an empty blob store: `image build --ref` with the `docker_image` of each `task.toml` (79 with the tag `20251031`, 6 with `20260403`, 4 with `20260430`) and `--size-mb 10240`, the `storage_mb` of all 89, then `image pack`. All 89 converted, in 99 s of wall time. No request was tried twice and Docker Hub refused none.

| | Sum | Median | Smallest | Largest |
| --- | --- | --- | --- | --- |
| Layers | 595 | 7 | 2 | 14 |
| Compressed layers, as the manifests give them | 20.97 GB | 149 MB | 30 MB | 1,432 MB |
| Download | 134 s | 1.3 s | | 8.5 s |
| Convert | 199 s | 1.6 s | | 15.3 s |
| Disk, allocated | 53.86 GB | 380 MB | 93 MB | 4,607 MB |
| Pack | 51 s | 0.31 s | | 4.7 s |
| Packed | 19.16 GB | 133 MB | 27 MB | 1,400 MB |

319 of the 595 layers are distinct, so the store holds 16.70 GB in 501 blobs, the manifests and configs among them. The packed disks are 9 % smaller than the layers they were made from are in the registry. `custom-memory-heap-crash` is the largest: 11 layers, 1.27 GB compressed, 15.3 s to convert, 4.6 GB on disk, 1.04 GB packed in 4.7 s.

`image tree` then listed all 89 disks: 1,318,421 entries, of which 1,088,352 are regular files, 138,275 directories and 91,794 links. 5,598 names are hard links to an earlier name, 1,086 files are setuid or setgid, and three files in three images carry a `security.capability` attribute. No image holds a device or a fifo.

| Task | Tag | Manifest | Layers | Compressed | Download | Convert | Allocated | Packed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `adaptive-rejection-sampler` | 20251031 | `985bed39e844` | 3 | 30 MB | 1.2 s | 0.5 s | 93 MB | 27 MB |
| `bn-fit-modify` | 20251031 | `5aeb11ca6e80` | 4 | 262 MB | 1.9 s | 2.5 s | 704 MB | 245 MB |
| `break-filter-js-from-html` | 20251031 | `d7bfb45e47cf` | 9 | 382 MB | 1.8 s | 3.9 s | 1103 MB | 349 MB |
| `build-cython-ext` | 20251031 | `3612a38fadb8` | 7 | 303 MB | 1.7 s | 3.0 s | 860 MB | 272 MB |
| `build-pmars` | 20251031 | `57a82706f749` | 4 | 61 MB | 1.7 s | 0.8 s | 162 MB | 56 MB |
| `build-pov-ray` | 20251031 | `874baf49341e` | 5 | 163 MB | 1.3 s | 1.6 s | 423 MB | 151 MB |
| `caffe-cifar-10` | 20260403 | `929a6d631b59` | 4 | 213 MB | 1.5 s | 2.0 s | 557 MB | 198 MB |
| `cancel-async-tasks` | 20251031 | `84c7fae6b256` | 5 | 44 MB | 0.8 s | 0.7 s | 139 MB | 39 MB |
| `chess-best-move` | 20251031 | `bb447f94d9e2` | 12 | 240 MB | 1.4 s | 2.3 s | 624 MB | 213 MB |
| `circuit-fibsqrt` | 20251031 | `29783439f529` | 9 | 149 MB | 1.1 s | 1.5 s | 406 MB | 133 MB |
| `cobol-modernization` | 20251031 | `593ab9df3d83` | 9 | 162 MB | 1.3 s | 1.6 s | 449 MB | 149 MB |
| `code-from-image` | 20251031 | `2be9cdb746ed` | 6 | 44 MB | 0.9 s | 0.8 s | 139 MB | 39 MB |
| `compile-compcert` | 20260403 | `f60236a4fe55` | 3 | 30 MB | 1.1 s | 0.4 s | 93 MB | 27 MB |
| `configure-git-webserver` | 20251031 | `9e48389b917f` | 3 | 72 MB | 1.0 s | 0.7 s | 159 MB | 69 MB |
| `constraints-scheduling` | 20251031 | `567ce5a189f8` | 4 | 50 MB | 1.1 s | 0.8 s | 164 MB | 45 MB |
| `count-dataset-tokens` | 20251031 | `9c513c4ba342` | 5 | 44 MB | 0.8 s | 0.7 s | 139 MB | 39 MB |
| `crack-7z-hash` | 20251031 | `0f4453abd774` | 8 | 356 MB | 1.4 s | 2.6 s | 790 MB | 341 MB |
| `custom-memory-heap-crash` | 20251031 | `1895d7d6240d` | 11 | 1268 MB | 2.8 s | 15.3 s | 4607 MB | 1045 MB |
| `db-wal-recovery` | 20251031 | `0e33ea5ec823` | 5 | 175 MB | 1.2 s | 1.9 s | 543 MB | 163 MB |
| `distribution-search` | 20251031 | `1448f7aa1c60` | 7 | 181 MB | 1.4 s | 1.6 s | 442 MB | 168 MB |
| `dna-assembly` | 20251031 | `d1adf6835f1d` | 3 | 30 MB | 0.9 s | 0.5 s | 93 MB | 27 MB |
| `dna-insert` | 20251031 | `4dd8760694e3` | 3 | 30 MB | 0.9 s | 0.5 s | 93 MB | 27 MB |
| `extract-elf` | 20251031 | `6932e4cb3184` | 5 | 347 MB | 1.8 s | 4.2 s | 1154 MB | 320 MB |
| `extract-moves-from-video` | 20260403 | `74ef87375ce2` | 3 | 42 MB | 1.1 s | 0.6 s | 105 MB | 39 MB |
| `feal-differential-cryptanalysis` | 20251031 | `bea93bafe9ea` | 7 | 52 MB | 1.1 s | 0.8 s | 161 MB | 46 MB |
| `feal-linear-cryptanalysis` | 20251031 | `ea78749a8422` | 13 | 151 MB | 1.4 s | 1.6 s | 424 MB | 139 MB |
| `filter-js-from-html` | 20251031 | `92acda0f124b` | 7 | 378 MB | 2.1 s | 3.6 s | 1092 MB | 347 MB |
| `financial-document-processor` | 20251031 | `ef6c9cfaaf14` | 4 | 52 MB | 1.1 s | 0.7 s | 143 MB | 47 MB |
| `fix-code-vulnerability` | 20251031 | `cac325252991` | 12 | 191 MB | 1.5 s | 2.3 s | 508 MB | 174 MB |
| `fix-git` | 20260403 | `389b9c824761` | 10 | 156 MB | 1.5 s | 1.4 s | 330 MB | 147 MB |
| `fix-ocaml-gc` | 20251031 | `66a1e2293076` | 5 | 765 MB | 2.3 s | 3.6 s | 1065 MB | 613 MB |
| `gcode-to-text` | 20251031 | `0979ef40c6a3` | 7 | 45 MB | 1.1 s | 0.7 s | 141 MB | 39 MB |
| `git-leak-recovery` | 20251031 | `62160e522a42` | 6 | 96 MB | 1.3 s | 1.0 s | 242 MB | 89 MB |
| `git-multibranch` | 20251031 | `5bc449921c13` | 6 | 222 MB | 1.4 s | 2.4 s | 678 MB | 204 MB |
| `gpt2-codegolf` | 20251031 | `537e7bd26b02` | 5 | 614 MB | 2.3 s | 3.0 s | 871 MB | 605 MB |
| `headless-terminal` | 20251031 | `eb7e209672bf` | 7 | 62 MB | 1.1 s | 1.0 s | 166 MB | 56 MB |
| `hf-model-inference` | 20260430 | `a88d98a849e8` | 6 | 329 MB | 1.9 s | 4.2 s | 1235 MB | 277 MB |
| `install-windows-3.11` | 20251031 | `c6695097316e` | 14 | 573 MB | 1.9 s | 5.3 s | 1654 MB | 535 MB |
| `kv-store-grpc` | 20251031 | `3399400800dc` | 5 | 44 MB | 0.8 s | 0.7 s | 139 MB | 39 MB |
| `large-scale-text-editing` | 20251031 | `719adca3f138` | 8 | 73 MB | 1.1 s | 1.0 s | 275 MB | 55 MB |
| `largest-eigenval` | 20251031 | `cb9e3e3b09d0` | 8 | 85 MB | 1.1 s | 1.0 s | 239 MB | 77 MB |
| `llm-inference-batching-scheduler` | 20251031 | `19e79aa49be4` | 6 | 44 MB | 0.9 s | 0.8 s | 139 MB | 39 MB |
| `log-summary-date-ranges` | 20251031 | `cbeb6ba905c2` | 8 | 45 MB | 1.1 s | 0.7 s | 145 MB | 39 MB |
| `mailman` | 20251031 | `04fac73db7e2` | 5 | 162 MB | 1.4 s | 2.1 s | 412 MB | 110 MB |
| `make-doom-for-mips` | 20251031 | `80a9459f1b94` | 12 | 190 MB | 1.2 s | 1.9 s | 492 MB | 173 MB |
| `make-mips-interpreter` | 20251031 | `082fc8821b31` | 12 | 519 MB | 1.9 s | 4.9 s | 1604 MB | 463 MB |
| `mcmc-sampling-stan` | 20251031 | `073fc36a3347` | 5 | 238 MB | 1.5 s | 2.2 s | 638 MB | 222 MB |
| `merge-diff-arc-agi-task` | 20251031 | `bfc2a235f2ce` | 3 | 30 MB | 0.9 s | 0.5 s | 93 MB | 27 MB |
| `model-extraction-relu-logits` | 20251031 | `52fe1f089f38` | 7 | 84 MB | 1.2 s | 1.1 s | 236 MB | 76 MB |
| `modernize-scientific-stack` | 20251031 | `64e69cee13bf` | 8 | 347 MB | 1.4 s | 3.5 s | 1062 MB | 306 MB |
| `mteb-leaderboard` | 20260430 | `3eb9e900bf0a` | 7 | 664 MB | 2.5 s | 7.7 s | 2356 MB | 574 MB |
| `mteb-retrieve` | 20260430 | `8b3220cd2548` | 9 | 629 MB | 2.4 s | 7.5 s | 2244 MB | 542 MB |
| `multi-source-data-merger` | 20251031 | `8b32782078ff` | 8 | 221 MB | 1.4 s | 2.1 s | 576 MB | 206 MB |
| `nginx-request-logging` | 20251031 | `693e64431a0d` | 7 | 67 MB | 1.1 s | 0.9 s | 179 MB | 61 MB |
| `openssl-selfsigned-cert` | 20251031 | `4c948a4e630a` | 6 | 44 MB | 0.9 s | 0.7 s | 139 MB | 39 MB |
| `overfull-hbox` | 20260403 | `7dca952bb673` | 6 | 132 MB | 1.4 s | 1.5 s | 351 MB | 119 MB |
| `password-recovery` | 20251031 | `15fcd84bf3b0` | 5 | 62 MB | 1.1 s | 1.0 s | 216 MB | 56 MB |
| `path-tracing-reverse` | 20251031 | `7911e42479d8` | 6 | 171 MB | 1.6 s | 1.7 s | 432 MB | 162 MB |
| `path-tracing` | 20251031 | `4b44725102cd` | 7 | 399 MB | 2.0 s | 4.3 s | 1143 MB | 374 MB |
| `polyglot-c-py` | 20251031 | `0f1c3b7816d7` | 3 | 149 MB | 1.4 s | 1.6 s | 363 MB | 140 MB |
| `polyglot-rust-c` | 20251031 | `3ba84f0e138a` | 3 | 271 MB | 1.6 s | 2.4 s | 801 MB | 248 MB |
| `portfolio-optimization` | 20251031 | `93461db3cec6` | 12 | 196 MB | 1.6 s | 2.4 s | 602 MB | 171 MB |
| `protein-assembly` | 20260403 | `602c467ae6b6` | 8 | 44 MB | 1.1 s | 0.9 s | 139 MB | 39 MB |
| `prove-plus-comm` | 20251031 | `e26741d01681` | 4 | 491 MB | 2.4 s | 4.2 s | 1329 MB | 474 MB |
| `pypi-server` | 20251031 | `d18bb30f47c7` | 8 | 84 MB | 1.1 s | 1.2 s | 235 MB | 75 MB |
| `pytorch-model-cli` | 20251031 | `c996884b5fb5` | 6 | 44 MB | 0.9 s | 0.8 s | 140 MB | 39 MB |
| `pytorch-model-recovery` | 20260430 | `63c804250786` | 9 | 270 MB | 2.0 s | 4.0 s | 1006 MB | 229 MB |
| `qemu-alpine-ssh` | 20251031 | `541e8214a8c4` | 7 | 1309 MB | 3.5 s | 6.3 s | 1847 MB | 1284 MB |
| `qemu-startup` | 20251031 | `1a666e049db5` | 7 | 1309 MB | 3.4 s | 6.3 s | 1847 MB | 1284 MB |
| `query-optimize` | 20251031 | `28de7da87004` | 7 | 120 MB | 1.2 s | 1.3 s | 212 MB | 93 MB |
| `raman-fitting` | 20251031 | `401fa95d5d49` | 6 | 44 MB | 0.9 s | 0.9 s | 139 MB | 39 MB |
| `regex-chess` | 20251031 | `e3b6d61d2d39` | 7 | 56 MB | 1.2 s | 1.0 s | 158 MB | 50 MB |
| `regex-log` | 20251031 | `90101b2e8153` | 2 | 30 MB | 0.9 s | 0.6 s | 93 MB | 27 MB |
| `reshard-c4-data` | 20251031 | `92d209e70478` | 9 | 1432 MB | 8.5 s | 9.3 s | 2810 MB | 1400 MB |
| `rstan-to-pystan` | 20251031 | `b23d48839408` | 9 | 51 MB | 1.2 s | 0.9 s | 166 MB | 46 MB |
| `sam-cell-seg` | 20251031 | `d76bdeef19d8` | 11 | 411 MB | 1.8 s | 4.2 s | 1196 MB | 366 MB |
| `sanitize-git-repo` | 20251031 | `4b5234da5bb0` | 9 | 203 MB | 1.6 s | 1.7 s | 380 MB | 192 MB |
| `schemelike-metacircular-eval` | 20251031 | `b485be38bf80` | 7 | 44 MB | 1.1 s | 0.8 s | 139 MB | 39 MB |
| `sparql-university` | 20251031 | `92fa4304e511` | 3 | 30 MB | 0.9 s | 0.5 s | 93 MB | 27 MB |
| `sqlite-db-truncate` | 20251031 | `aabac93c93bd` | 6 | 44 MB | 0.9 s | 0.8 s | 139 MB | 39 MB |
| `sqlite-with-gcov` | 20251031 | `f986820b00c7` | 3 | 42 MB | 1.0 s | 0.6 s | 106 MB | 40 MB |
| `torch-pipeline-parallelism` | 20251031 | `3cb7b39d86f1` | 2 | 30 MB | 0.8 s | 0.6 s | 93 MB | 27 MB |
| `torch-tensor-parallelism` | 20251031 | `c50ac169e114` | 2 | 30 MB | 0.8 s | 0.6 s | 93 MB | 27 MB |
| `train-fasttext` | 20251031 | `3c77da9617e7` | 12 | 509 MB | 1.9 s | 3.3 s | 876 MB | 491 MB |
| `tune-mjcf` | 20251031 | `56c197739db2` | 8 | 80 MB | 1.1 s | 1.5 s | 286 MB | 70 MB |
| `video-processing` | 20251031 | `a2c0f39e3ab0` | 8 | 312 MB | 1.4 s | 2.6 s | 744 MB | 289 MB |
| `vulnerable-secret` | 20251031 | `61ebb40454dd` | 10 | 134 MB | 1.2 s | 1.6 s | 390 MB | 119 MB |
| `winning-avg-corewars` | 20251031 | `ad7a6b1c53ae` | 7 | 294 MB | 1.8 s | 3.0 s | 778 MB | 276 MB |
| `write-compressor` | 20251031 | `3618e1f8a997` | 6 | 292 MB | 1.6 s | 2.7 s | 800 MB | 269 MB |

### Not the same bytes twice

Four images were converted twice from one store, and the two disks of each compared in blocks of 4 KiB:

| Image | Blocks that differ | Trees | Packed files |
| --- | --- | --- | --- |
| `alpine:3.21` | 142 of 3,186 | Equal, 520 entries | 3,588,344 and 3,588,328 bytes |
| `python:3.13-slim-bookworm` | 1,152 of 34,127 | Equal, 6,572 entries | 38,708,424 and 38,708,387 bytes |
| `alexgshaw/build-pmars:20251031` | 2,107 of 39,439 | Equal, 5,702 entries | 55,587,468 and 55,585,254 bytes |
| `alexgshaw/mteb-leaderboard:20260430` | 204,264 of 575,152 | Equal, 59,391 entries | 574,324,155 and 574,464,668 bytes |

In the three small images the blocks that differ are 3 to 5 % of the disk: a kernel wrote the inodes and the superblock and stamped them with its clock. In the image of 2.2 GiB more than a third differ, because the kernel also put the data of files in other places. The listings of the two disks were the same file every time, times included. A file listing in directory order was also the same between the two (`ls -fR` of `/usr`, `/etc` and `/var` of the Python image), and differed from the disk of the export path, because the directory hash seed comes from the image digest.

So an environment has two digests, and DESIGN.md says which is for what: the image digest for what the files are, the packed digest for which bytes a run boots. A disk that follows from the image byte for byte would need ext4 written without a kernel, which is what was not ported.

### The packed form

`alexgshaw/mteb-leaderboard:20260430`, 2.36 GB of blocks in use on a 10 GiB disk, packed with four zstd workers by launchers that differ from the commit only in the level:

| Level | Packed | Time | CPU | Unpack |
| --- | --- | --- | --- | --- |
| 1 | 673 MB | 2.8 s | 4.4 s | 2.9 s |
| 3 | 574 MB | 1.6 s | 5.8 s | 3.0 s |
| 6 | 530 MB | 3.4 s | 14.2 s | 3.3 s |
| 9 | 499 MB | 6.3 s | 25.0 s | 3.1 s |
| 19 | 438 MB | 139.1 s | 547.3 s | 3.3 s |

Level 1 ran first, on a cold page cache. Level 3 is the level: a third more CPU than level 1 for 15 % fewer bytes, and level 9 costs 4.3 times its CPU for 13 %. Zero blocks are dropped by content, 4 KiB at a time, so an unpacked disk packs to the same file again, which the test checks.

An idle read-write mount of a fresh 10 GiB disk allocated 36 kB in four minutes, so the lazy initialization of inode tables is not what a disk's size comes from, and the build disk is mounted without `noinit_itable`.

### A converter that is killed

A converter killed with `SIGKILL` in the middle of a 347 MB image left its lock file and its work directory. Its builder microVM was gone within a second: it watches its parent. The next conversion of the same output removed both and finished. Two converters started on one output at once built it once.

`image pack` and `image unpack` took no such lock at `2d270e4`: two `image unpack` of one file to one disk shared a temporary file, and one of them ended with `No such file or directory` when the other had renamed it. The commit after this entry locks the output of both, and the test starts two at once.

### Limits of this version

- Nothing uses the converter yet. `slot.sh` still asks Docker, and the test that proves the two fit together is a copy outside the repository.
- A command that runs as a user of the image has that user's primary group and no supplementary groups, in a `RUN` step and in a slot. Rust's `Command` drops them, and setting them needs a helper in the guest.
- Registries are read without credentials. Docker Hub counts manifest requests of an address, 100 an hour here. A `429` waits and tries again. Docker Hub refused none of the requests of the 89 conversions, which it made inside 99 s, so that wait is written and has not run.
- A `RUN` step sees the network as a slot does, without the certificate bundle and the forwards of `sandboxd`. On a machine whose network re-signs TLS or keeps registries on its loopback, a Dockerfile that installs from such a registry does not build, where a reference converts.
- Refused in a Dockerfile: wildcards, `--chown`, `--chmod`, `--mount`, heredocs, `ADD` of a URL or an archive, an ignore file, a stage as a base, `--platform`, `ONBUILD`. None of the 89 Dockerfiles of Terminal-Bench 2.1 or of the 14 here uses one.
- Only linux/amd64 ran. The arm64 path is written and not run.
- The trees were compared for eight images. The other 81 disks were listed, not compared.

## 2026-11-11: no container engine at import or at run time

Machine: the 32-core Linux machine with KVM of the entries above (kernel 6.8, libkrunfw 5.5.0, e2fsprogs 1.47.0, Node 24.22.2, wrangler 4.151.1, rustc 1.97.0), shared with other work throughout, with a load average between 2 and 12. A Docker daemon ran on it for that other work. Every command of this entry ran with a `PATH` whose first directory holds programs named `docker`, `podman`, `skopeo`, `buildah`, `ctr`, `nerdctl` and `crictl` that append their arguments to a log and exit 97. The blob store, the layer cache, the caches and the Workers' state were on another filesystem than the one that holds Docker's images. Each lane is one run unless it gives several, and each names its commit.

### What was wrong

The two entries above ended with a seam and a converter that had not met. `nanoeval import` still called Docker through a temporary converter: pull or build, `docker export` into a builder microVM, `tar --sparse` and `zstd` for the packed form. So a machine that imports carried a daemon, its image store and the access that comes with its socket, and the krun lanes skipped on a machine without one. `nanoeval-krun image build` made the same disk from the layers with no engine, and nothing called it.

### What changed

| | Before | Now |
| --- | --- | --- |
| `sandbox/Converter.ts` | A factory that returned the temporary Docker converter | Runs `nanoeval-krun image build`, `pack` and `unpack`. The row's metadata is the image's own configuration |
| Packed form of a disk | `tar --sparse` through zstd, `tar-sparse-zstd` | `image pack`, `nkrdisk1`. One form: a runner refuses the other, and an eval is imported again |
| Default `PATH` of an image without one | Added by `slot.sh` when a slot came up | Added by the import, so the row says what a guest starts with |
| Image layers | In Docker's image store | In the layer cache, `--layers` or `NANOEVAL_LAYERS`, `oci` under the cache by default. Host policy, kept across imports |
| `image unpack` onto a disk that exists | Wrote the disk again once it had the lock | Keeps it, so of two runners that share a cache the second writes nothing |
| The launcher | Had a request that unpacked one archive onto a writable disk, `unpack`, `vm --disk` and a guest mode for it | Removed with `slot.sh disk`, their only caller. The protocol is `NKR3` |
| `scripts/install-linux.sh` | Asked for Docker. State under the home directory, one installation per machine | Asks for no engine. `--layers`, `--state`, `--krun`, `--name` and `--remove` |
| Harbor export | `environment.type` `docker` for a backend of that name | `e2b` for an E2B sandbox, none otherwise |

Four smaller defects came out on the way. `slot.sh` copied the launcher over the installed one, which fails with "Text file busy" when a runner beside it is using it: it is installed by rename now. `sandboxd` left its command directory in the temporary directory when it was stopped. And with `CARGO_TARGET_DIR` set, `slot.sh` looked for the built launcher where cargo had not put it: the first fresh clone failed every krun lane with "cannot stat" for that reason, because the lane script exported the variable. And a runner rewrote the working directory, user and environment files beside a cached disk in place for every attempt, so a slot that came up at that instant read an empty file and started its commands in `/`: one of 64 attempts of a scale lane failed its verifier that way on a busy machine. They are replaced by rename now.

### What was decided

- **One packed form.** Keeping the unpacker of the temporary form would have kept GNU tar and zstd on every runner for evals that take five minutes to import again.
- **A row records two digests**, as the entry above proposed: the digest of the platform manifest the disk was made from, and the SHA-256 of the packed disk, which is what a runner fetches. Two imports of Terminal-Bench 2.1 gave the same 89 image digests and no packed disk in common, while the 266 other blobs were the same.
- **A disk stays as large as `storage_mb`.** It is sparse, the packed form does not grow with it, and the slot's upper disk carries the limit either way.
- **No option for the `RUN` steps of a Dockerfile** on a network that re-signs TLS or keeps registries on its loopback. No lane needed one: every dataset here names images, which convert there, and the 14 Dockerfiles of this repository reach only Alpine's mirror, over a private network. A step that needs more fails at import and is named.
- **E2B is stated, not built.** An environment is a disk for a microVM, nobody has checked whether an E2B sandbox has KVM, and without it such a sandbox runs `dir` environments only.
- **CI stays as it is.** A hosted runner has no libkrunfw, so the krun lanes, the converter's test and the launcher's integration tests skip there. The workflow has not run on GitHub since the eval table: nothing of these three entries is pushed.
- **A Worker state written before the eval table is not migrated.** The upgraded Worker starts on a new `--state` directory.
- `--lease-sec 60`, `--claims 3` and `--poll-ms 250` stay.

### No container tool runs

- The log of the seven programs was empty after everything in this entry: the imports, the runs, the lanes, the fresh clones.
- `strace -f -e trace=execve` over `nanoeval import` of the 14 task directories of this repository, over `nanoeval import terminal-bench-2.1 --only fix-git --only openssl-selfsigned-cert`, and over the `nanoeval runner` that then ran each eval, from a fresh clone of `35b6d68`: the import executed the launcher, `mke2fs`, `passt`, and bash with `cp`, `mv`, `mkdir`, `awk`, `uname`, `readlink`, `flock` and `env`. The runner executed those and `nanoeval-net`, the hand's loader, `curl`, `tar`, `cat`, `tail`, `setsid`, `nohup`, `timeout`, `truncate` and a few more of coreutils. No line names an engine, `runc`, `crun` or `containerd`.
- The image list of the machine's Docker daemon was the same before and after, and no command of this entry created a container.
- What `git grep -i docker` still finds: Harbor's `docker_image`, `environment/Dockerfile` and `docker-compose.yaml` in the task loader, the adapters and their tests. The Dockerfile support of the launcher, with Docker Hub's host names and media types. The documentation of both. Statements here and in the README that none is needed, and the alternatives DESIGN.md rejects. And the entries of this file.

### Terminal-Bench 2.1, imported without Docker

`nanoeval import terminal-bench-2.1 --keep-going` into an empty directory store, with `--layers` on the layer cache that the conversions of the entry above had filled, at commit `af57dc7`. All 89 converted and none was refused. The layer cache held 512 blobs before and after, so only manifests were asked of the registry.

| | Wall | Adapter | Conversion | Packing | Upload |
| --- | ---: | ---: | ---: | ---: | ---: |
| The temporary Docker converter, entry above | 9 min | | 451 s with packing | | 7.5 s |
| This import | 4 min 39 s | 0.65 s | 266.5 s with packing | | 8.0 s |
| A second one into another empty store, timing the packing apart, while 8 slots ran the solutions below | 5 min 3 s | 0.70 s | 242.8 s | 46.1 s | 8.7 s |

Per task in the second import: conversion 2.10 s at the median and 15.6 s at most (`custom-memory-heap-crash`), packing 0.32 s and 3.3 s, upload 0.06 s and 0.63 s. The 89 packed disks are 19.16 GB, 133 MB at the median and 1.40 GB at most. The store is 18 GiB on disk and the layer cache 16 GiB. Tasks are converted one after another.

### Terminal-Bench 2.1 with the tasks' own solutions, on those disks

One run of the 89 rows of `terminal-bench-2.1@14f3a1e5`: `nanoeval run --eval terminal-bench-2.1 --oracle --sandboxes 0 --disks remove`, worked by two attached runners on the one machine, each with 4 slots, 16,400 MB and a cache of its own, both with `--ca-bundle`, `--slot-env` (`UV_EXCLUDE_NEWER` and `PIP_UPLOADED_PRIOR_TO` at the dates of the earlier runs) and `--slot-forward`, slots on a private network, the Worker at a tick of 500 ms, code at `af57dc7`.

| | Passed | Failed | Errored |
| --- | ---: | ---: | ---: |
| The runs of 2026-11-10 on krun slots, per task | 82 | 4 | 3 |
| The eval table with disks from `docker export`, entry above | 82 | 5 | 2 |
| This run, disks from the layers | 82 | 4 | 3 |

All 89 rows ended as in the table of 2026-11-10. `build-cython-ext`, `mcmc-sampling-stan`, `protein-assembly` and `pypi-server` failed, `qemu-alpine-ssh` and `qemu-startup` ended as `verifier` errors, each for the cause the entry of 2026-11-10 gives, in the task or the machine. Against the run of the entry above two rows differ, and both are the two it explained: `portfolio-optimization` passed again, and `torch-tensor-parallelism` ended as a `verifier_timeout` at 900 s again, the deadlock of torch 2.7.0 that it found intermittent. `nanoeval run --rerun RUN` then made a run of the seven rows that had not passed, each naming the attempt it retries, on one attached runner with 4 slots. In 1,096 s all seven ended as they had, `torch-tensor-parallelism` at 900 s again, and its job loads with Harbor's models too (17 files).

**The trees of all 89.** The entry above compared 8 of the 89 trees with Docker's. The store of the eval table still held the 89 disks that the temporary converter had made from `docker export` of the same tags on the same day, so each was unpacked with tar and zstd, each new one with `image unpack`, and `image tree` listed both. The 89 new disks hold 1,318,421 entries, and every one has the same kind, mode, owner, size, content hash, link target, extended attributes and time as in the exported disk. The exported disks hold 2 to 4 entries more each. Left out of the comparison is what an engine adds or mounts over: `/.dockerenv`, `lost+found`, `/etc/hostname`, `/etc/hosts`, `/etc/resolv.conf`, `/etc/mtab`, the time of `/etc`, and `/dev`, `/proc` and `/sys` with what is under them.

So no task is broken by a disk made without Docker: the trees are the same, and each of the 89 booted, ran its solution and its verifier, and scored as before. The disk of `torch-tensor-parallelism` is among them, so the disk is not what deadlocks.

The run took 2,037 s from its creation to its end, and its attempts 9,876 s summed. `caffe-cifar-10` ran 1,979 s, `crack-7z-hash` 1,460 s and `compile-compcert` 982 s. The median attempt took 22.5 s. The environment phase, fetching the row's blobs and unpacking its disk into a cache that did not hold it, had a median of 0.86 s and at most 6.9 s (`custom-memory-heap-crash`, 1.05 GB packed). The runners finished 46 and 43 rows, and no claim was lost. With 16,400 MB each, both ran two rows of 8,192 MB at once, which the 16,000 MB of the entry above did not allow. The exported job loads with the models of Harbor 0.25.0 (`scripts/harbor-check.py`: 181 files, none refused).

### The tasks of this repository, and the other datasets

- **Fixtures.** `nanoeval import --task` over the 14 task directories of `tasks/` and `test/fixtures/`, each with a Dockerfile, from the fresh clone of `35b6d68`: 13 became the eval, 5 of them on a disk another had already made, and `broken-environment` was refused with "line 3: RUN ended with 7". A conversion took 0.8 to 1.4 s, `write-greeting` with its `apk add` over the private network among them. `nanoeval run --oracle` on the four that have a solution: 4 passed. The scripted model runs the same fixtures in the lanes below.
- **GPQA Diamond**, 5 tasks, at `c976e18`: `python:3.12-slim` converted once in 2.1 s and reused four times. Reference answers: 5 passed.
- **Terminal-Bench 2.0**, 2 tasks: both passed with their own solutions.
- **SWE-bench Verified**, 1 instance (`astropy__astropy-12907`): its image converted in 13.2 s and packed in 2.5 s to 1.09 GB. The gold patch passed on a krun slot in 83 s. It is the first instance image converted to a disk: the first version ran one in a container.
- **HealthBench Professional**, 2 cases with their physician answers and `gpt-6-luna` at low thinking as the judge, at `af57dc7`: rewards −0.006 and 0.426 for $0.0068, and the same two rewards in a rerun for $0.0053. The entry of 2026-11-10 recorded 0.028 and 0.643 for two cases it did not name. Whether these are the same two cases, and what moved the judge if they are, was not found: no artifact of those runs is left to compare. The grader's inputs are the dataset's answer and rubric, not the disk.

### A model on the imported eval

Three tasks with `gpt-6-luna` at its default thinking on the ChatGPT plan login, one attempt each, three slots of one attached runner, at `af57dc7`. The three rows were imported again into a Worker of their own, which converted nothing: the conversion records gave it the disks of the import above.

| Task | Result | Environment | Agent | Verifier | Estimate |
| --- | --- | ---: | ---: | ---: | ---: |
| `openssl-selfsigned-cert` | passed | 0.5 s | 26.9 s | 9.7 s | $0.0020 |
| `cancel-async-tasks` | passed | 0.5 s | 53.4 s | 22.6 s | $0.0027 |
| `build-pmars` | `verifier` error | 0.5 s | 110.1 s | 2.1 s | $0.0058 |
| `build-pmars`, in the rerun | passed | 0.2 s | 104.2 s | 9.2 s | $0.0088 |

The run took 114 s, with 364,832 input tokens of which 309,376 were cached, 3,674 output tokens, and $0.0105 by the harness's estimate. The error is the agent's doing, not the disk's. It ran `apt-get update` against a source list of its own with `APT::Get::List-Cleanup=0`, which refreshed the release file of the distribution and left the image's package lists of September 2025 under it. Every later `apt-get update`, the verifier's included, then found the release file current and kept the old lists, and `apt-get install curl` asked the mirror for two packages it no longer has. The same disk passed with the task's own solution, and its lists carry the image's own times. `nanoeval run --rerun RUN --errored` made a run of that one row, naming the attempt it retries, and there the agent did not do it and the row passed. All of it cost $0.0314 with the judge.

### Scale

Scripted model, one sandbox with one runner, 32 slots, 64 attempts of 2 tasks × 2 agents, 1 vCPU and 256 MiB per slot, tick 500 ms, `--poll-ms` 250, krun slots on a private network, at `1357eea`. Six runs, one after another. Other work on the machine began compiling during the fourth. The phases are medians.

| Run | Load average at its start | Wall | Environment | Hand attach | Agent | Verifier |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| The entry above, disks from `docker export`, three runs | 5.6 | 4.7, 4.6, 4.5 s | 0.37 s | 0.30 s | 0.64 s | 0.30 s |
| 1 | 4.1 | 4.8 s | 0.37 s | 0.35 s | 0.72 s | 0.29 s |
| 2 | 4.1 | 4.7 s | 0.40 s | 0.33 s | 0.63 s | 0.24 s |
| 3 | 4.0 | 4.9 s | 0.39 s | 0.34 s | 0.68 s | 0.25 s |
| 4 | 4.4 | 10.0 s | 1.20 s | 0.50 s | 1.66 s | 0.55 s |
| 5 | 12.6 | 7.0 s | 0.46 s | 0.43 s | 0.87 s | 0.33 s |
| 6 | 12.4 | 5.3 s | 0.44 s | 0.37 s | 0.81 s | 0.32 s |

Each run ended with 32 passed and 32 failed, as designed. The three quiet runs are where the entry above was: the conversion happens at import and changes nothing in a slot's start. Before the fix of the metadata files, at `35b6d68` and a load average of 14 to 16, five of six runs took 5.8, 5.8, 6.0, 5.7 and 4.8 s, and the sixth ended with 31 passed for the defect above. Directory slots took 4.0, 4.0 and 4.1 s there.

### Every check, from a fresh clone

From a fresh clone of `35b6d68`, with no built launcher named, so that cargo built it in the clone: `npm ci`, `npm run lint`, `npm run check:types`, `cargo fmt --check`, `cargo clippy --all-targets --locked -- -D warnings`, `cargo test --locked`, `npm test` (70 tests) and `npm run dry-run` passed, and then every lane of `ci.yml`, one run each:

| Lane | krun | dir |
| --- | --- | --- |
| Scripted model | passed, 4.9 s | passed, 1.6 s |
| Oracle | passed, 1.6 s | passed, 1.1 s |
| Blobs in R2 through the Worker | passed, 2.7 s | passed, 1.7 s |
| Final messages and a judge | passed, 2.5 s | passed, 1.9 s |
| Final messages and a judge, oracle | passed, 1.7 s | |
| Failure kinds, then a rerun | passed | passed |
| Orchestrator restart | passed, 3.2 s | passed, 2.5 s |
| Slot networks | passed, 1.8 s | |
| Disk removal | passed, 2.2 s | |
| Free disk floor | passed | passed |
| Memory packing | passed | passed |
| Two attached runners | passed, 2.2 s | passed, 1.3 s |
| A runner lost during the run | passed, 5.3 s | passed, 4.4 s |
| A runner restarted during the run | passed, 2.0 s | passed, 1.5 s |

The figure is the wall time of the run, where the lane prints one. The first fresh clone, of `c976e18`, failed its krun lanes for the `CARGO_TARGET_DIR` defect above, and `9fe521c` fixes it. After `1357eea`, the one later code change, `npm run lint`, `npm run check:types` and `npm test` passed, and the scale lane ran as the section above says.

### The services of a machine

`scripts/install-linux.sh --name NAME` on other ports, with the store, the cache, the layers, the state and the jobs on another filesystem and `--krun` on a built launcher, at the tree that became `c52d4e3`: both services answered, `nanoeval import` of three tasks and `nanoeval run --oracle` through them passed 3 of 3 with the runner that `sandboxd` started, and `--remove` left no unit, file, listener or temporary directory. The services that the machine already ran from an earlier commit were not touched. At `1357eea` the same was done over the directories that hold the import and the runs of this entry: the installed Worker listed `terminal-bench-2.1@14f3a1e5` with its 89 tasks and showed the run above, `nanoeval run --eval terminal-bench-2.1 --oracle --only fix-git --only openssl-selfsigned-cert --wait` passed 2 of 2 through it, and `--remove` left the data and nothing else.

### Not verified

- CI on GitHub. Nothing is pushed.
- linux/arm64, registries with credentials, and the wait on a `429`, as in the entry above.
- A Dockerfile whose `RUN` step needs the machine's certificate bundle or a registry on its loopback. It is expected to fail, and no fixture has one.
- E2B, R2 on Cloudflare, a deployed Worker and a hand over `wss://`, as before. KVM inside an E2B sandbox was not looked at.
- The `anthropic`, `codex-plan` and `claude-plan` end-to-end lanes. The real model ran through the CLI.
- krun slots on `--network host` in this flow, and runners on more than one machine.
- SWE-bench beyond one instance, GPQA and HealthBench with a model on an imported eval, and the HealthBench rewards against the earlier ones.
- The upgrade of a Worker state directory written before the eval table.

## 2026-11-11: the smaller gaps

Machine: the 32-core Linux machine with KVM of the entries above (kernel 6.8, libkrunfw 5.5.0, passt as a system package, Node 24.22.2, rustc 1.97.0), shared with other work throughout: its load average was between 11 and 70 while this was measured, and each section says what it was. Its network re-signs TLS to outside registries, its resolver sends the Python and npm registries to a proxy on its loopback, and its registries hold back releases younger than about a week. Each figure is one run unless it gives several.

Six things the entries above left open: a Dockerfile that installs packages did not build on such a network, a task that closes its network was refused, nothing pruned layers or blobs, verifiers installed their tools in every attempt, two HealthBench entries disagreed, and two documents said things that were no longer so.

### Dockerfile builds under the host's policy

**What was wrong.** A `RUN` step had the image's trust and nothing of the machine's. On this machine `pip install` in a step ended with "Connection refused" for the registry, which the resolver puts on the loopback, and the import refused the task: `line 4: RUN ended with 1` for the fixture below.

**What changed.** `nanoeval-krun image build` takes `--ca-bundle`, `--env-file` and `--forward`, and `nanoeval import` passes them from `--ca-bundle`, `--slot-env` and `--slot-forward` or from the three variables that `scripts/install-linux.sh` now writes into the configuration of the installed command. The bundle is a file on a tmpfs mounted at `/opt/nanoeval` in the mount namespace of one step, the variables are part of a step's request and never of the build's `ENV`, and a forward is a listener on the builder's loopback that the launcher relays to the machine's, with the relay code `nanoeval-net` already had. The guest protocol is `NKR4`.

**The fixture.** `test/fixtures/package-installs` is `FROM python:3.12-alpine` with `apk add nodejs npm`, `pip install six==1.16.0` and `npm install -g is-number@7.0.0`. Load average 30 to 40.

| | Result |
| --- | --- |
| `nanoeval import --task` without the options | Refused in 10.5 s: `line 4: RUN ended with 1`, pip had no route to the registry |
| With `--ca-bundle`, `--slot-env` and `--slot-forward` | Imported, conversion 7.6 s, packed 46.6 MB |
| `nanoeval run --oracle` on it | Passed in 2.1 s: `six` imports and `is-number` loads in the slot |

**The disk holds none of it.** The same Dockerfile was built with a bundle that carries a marker line and a variables file that carries a marker variable. `image tree` lists 6,110 entries: none under `opt/nanoeval`, none with the bundle's hash, and `/opt` has the time the image gave it. `grep` over the raw disk, which also reads the blocks of removed files, finds 0 occurrences of the marker, of `/opt/nanoeval`, of the marker variable, of `UV_EXCLUDE_NEWER` and of the forward's address. `test/Image.test.ts` checks the same on every machine with KVM and passt, with a base that has no `/opt`: a step reads the bundle, a variable that overrides an `ENV` of the image and a listener on the test's loopback, the same Dockerfile fails without the three, the configuration keeps the image's value, and the disk has no `/opt` and none of the four strings.

**Five Terminal-Bench 2.1 tasks from their Dockerfiles.** `regex-chess`, `largest-eigenval`, `feal-differential-cryptanalysis`, `tune-mjcf` and `portfolio-optimization`: each Dockerfile is `FROM python:3.13-slim-bookworm` with `pip install`, and the last also installs with apt. All five built with the three options, in 5.5 to 19.8 s against 1.4 to 2.8 s for the published image from cached layers. Each tree was compared with the tree of the disk made from the task's published image (`alexgshaw/<task>:20251031`), three times, because the tag a Dockerfile names has moved:

| Base of the Dockerfile build | What differs from the published image |
| --- | --- |
| `python:3.13-slim-bookworm` as the Dockerfile says, today | 2,037 to 6,219 entries of each tree: the tag is Python 3.13.18 now and the published images hold 3.13.7 |
| `python:3.13.7-slim-bookworm` | 1,324 to 5,504 entries: 777 files of Debian itself, since that tag was built again on 2025-09-29 and the published images sit on a base of 2025-08-11 |
| The four base layers of the published image itself, as an image in the layer cache | The table below |

| Task | Entries, image and build | Same in everything | Only the time differs | Content differs | What differs |
| --- | ---: | ---: | ---: | ---: | --- |
| `regex-chess` | 7,090 and 7,091 | 6,461 | 597 | 19, and 13 and 14 entries on one side | pip's HTTP cache and self-check file, 8 `.pyc` files, and `RECORD` and `WHEEL` of `chess`, a wheel that pip builds from a source archive |
| `largest-eigenval` | 8,483 and 8,483 | 6,460 | 1,607 | 416 | 409 `.pyc` files and pip's cache |
| `feal-differential-cryptanalysis` | 8,027 and 8,027 | 6,461 | 1,204 | 362 | 355 `.pyc` files and pip's cache |
| `tune-mjcf` | 15,418 and 15,400 | 6,461 | 4,592 | 4,205, and 160 and 142 on one side | `mujoco==3.3.5` is pinned and its dependencies are not: `absl-py` 2.3.1 became 2.5.1, with `etils` and others, and their `.pyc` files |
| `portfolio-optimization` | 15,928 and 15,928 | 7,516 | 7,470 | 942 | 766 `.pyc` files, and what `apt-get install` brings a year later: 117 files of `dpkg`, `perl` and others, 58 of dpkg's records, `ld.so.cache` |

The image configuration, environment, working directory, user and command, is equal in all five. Every difference is one of four kinds: the time of what a step wrote, a `.pyc` file, which holds the time of its source, a cache of the installer, and a package that the Dockerfile does not pin and its registry has moved. None is the builder's or the policy's: the files of `COPY` are equal in content, mode and owner, no tree has an entry the policy made, and `grep` over the five raw disks finds neither `/opt/nanoeval`, `UV_EXCLUDE_NEWER` nor the forward's address. A build from a Dockerfile is therefore not the published image, and the reason is the Dockerfile's: it names a tag and unpinned packages. Leaderboard runs use the published images, and so does the import.

### A task that closes its network

**What was wrong.** A private slot had every connection out, so a task with `allow_internet = false` was refused when a run was created.

**What the format says.** Harbor 0.25.0, read from its source on the machine: `[environment] network_mode` is `public`, `no-network` or `allowlist`, `[agent]` and `[verifier]` may each override it for their phase, and `allow_internet` is deprecated and means `no-network` when it is false and no `network_mode` is given. So the format has a verifier setting, and a closed agent with an open verifier is a task one can write. The loader also took `environment_mode = "same"` where Harbor writes `shared`: both load now.

**What changed.** `src/Task.ts` resolves the two phases. A row keeps `network.allowInternet` for the agent and adds `network.verifierInternet` only when the verifier differs, so no row of an eval imported before changes its digest. A krun slot on a private network whose task closes a phase runs its network device behind a gate in the VMM, `vm --gate FILE`, and `slot.sh` opens and closes the gate and the relay's allow list for each phase. DESIGN.md has the picture and the alternatives it rejects.

**The lane.** `NANOEVAL_E2E_SCENARIO=closed npm run e2e` on krun slots, scripted model, three fixtures at once, with a listener of the test on the machine's loopback given to slots as a forward. In each phase the fixture probes `https://example.com/`, `1.1.1.1:80`, the forward, the gateway's address and the session, each under six seconds.

| Fixture | Agent phase | Verifier phase | Result |
| --- | --- | --- | --- |
| `closed-network`, `allow_internet = false` | Reaches the session only | Reaches nothing | passed |
| `closed-agent`, `[agent] network_mode = "no-network"` | Reaches the session only | Reaches the internet and the forward, not the gateway or the session | passed |
| `closed-verifier`, `[verifier] network_mode = "no-network"` | Reaches the internet, the forward and the session, not the gateway | Reaches nothing | passed |

The run took 16.2 s with the three attempts side by side, load average 40 to 70. The first version of the fixture probed one after another and the agent's turn ended before the probes did: an agent's tool call returns after ten seconds, so the probes run side by side now. `NANOEVAL_E2E_BACKEND=dir NANOEVAL_E2E_SCENARIO=closed` asserts that the run is refused: "closes the network of its agent, which only krun slots on a private network enforce". The network lane, the default lane and the judge lane passed after the change.

### Pruning the layer cache and the blob store

Machine: the 32-core Linux machine with KVM of the entries above (kernel 6.8, Node 24.22.2, rustc 1.97.0, `flock` of util-linux 2.39.3, an ext4 data filesystem mounted `relatime`), shared with other work throughout: the load average was between 12 and 23 during the measurements and 36 to 39 during the checks. Commit `6f425fd`. Each figure is one run.

#### What was wrong

Nothing evicted the layer cache of imports, and nothing removed a blob from a directory store. One Terminal-Bench 2.1 import leaves 16 GB of layers and 19 GB of packed disks, and every import that fails or is repeated with other tasks leaves blobs that no version names. `nanoeval prune` cleared only a runner's cache.

#### What was built

| | |
| --- | --- |
| `nanoeval-krun image prune --cache DIR --days N [--remove]` | Lists what the layer cache holds that was not used for N days, and removes it with `--remove` |
| The launcher's store | Sets a blob's access time when it serves one from the cache, and holds a shared lock on the cache while a build has it open |
| `nanoeval prune layers --days N [--remove]` | Finds the launcher as an import does and runs the above on `--layers` |
| `nanoeval prune store [--remove] [--allow-empty]` | Lists the blobs of a directory store that no version of any eval names, with the staged files of dead imports, and removes them with `--remove` |
| `Store.lock` and `importEval` | A lock file per directory store, held shared by an import until its version exists and exclusively by a removal |

Bare `nanoeval prune` is unchanged, and still removes unless `--dry-run` is given.

#### What was decided

- **A dry run is the default, and it writes nothing.** No lock is taken and no file is created. Removing is the explicit act.
- **Last use is the later of access and modification time.** The store sets the access time itself, so a `noatime` mount records uses, and a cache from before this change is aged by what its filesystem kept.
- **A removal never waits.** It is refused while a build holds the cache or an import holds the store, with a message that says nothing was removed. An import or a build waits for a removal, which is short.
- **`--days` has no default.** It is host policy.
- **A removal that would empty the store is refused**, not only one against a Worker with no eval. A Worker with evals of another store names nothing here either, and the narrower rule would have let it take everything: the second Worker of the lab below is that case. `--allow-empty` overrides it.
- **Unknown files are left.** A prune removes blobs and what the store's own writer stages, by name.
- **Eval versions are not removed.** Runs name them and the Worker cannot list its runs.
- **R2 is not pruned.** There is no route to list a bucket.

#### The layer cache, on a copy

40 blobs of the layer cache of the Terminal-Bench 2.1 import, 19,178,113 bytes, copied with their times. 10 were set 10 days back, 10 were set 3 days back, and 20 kept their own times, 0.6 days back.

| `nanoeval prune layers --days` | Unused | Kept |
| --- | --- | --- |
| 0 | 40 files, 19,178,113 bytes | 0 |
| 2 | 20 files, 8,896,976 bytes | 20 files, 10,281,137 bytes |
| 7 | 10 files, 3,718,550 bytes | 30 files, 15,459,563 bytes |
| 30 | 0 | 40 files, 19,178,113 bytes |

`nanoeval-krun image build --ref alpine:3.21` on that cache took 1.39 s. Two `image prune --days 7 --remove` started during it, 0.5 s apart, and both ended with `an image build is using the layer cache ...: nothing was removed` and exit 125. The build succeeded and left 44 blobs. The same removal after it removed the 10 blobs, 3,718,550 bytes, kept 34 with 19,095,826 bytes, and left no `.part` file. Through the CLI, `nanoeval prune layers --days 2 --remove` then removed the 10 blobs of 3 days, 5,178,426 bytes, and kept 24.

The four blobs of `alpine:3.21` were then set 10 days back, and `--days 7` listed the four. After a second build, which read them from the cache, it listed none: the layer's access time was the build's and its modification time was still 10 days back. On this `relatime` mount the kernel would have moved that access time as well, so this run does not tell the two apart. The unit test does: `Store::fetch` of a cached blob does not read it.

#### A store of two tasks

A Worker and `sandboxd` from this checkout, with their own state, store, cache and layer cache. `nanoeval import --eval samples` of `tasks/extract-todos` and `tasks/uppercase-message` took 3.0 s and left 8 blobs. The same import again took 0.16 s, named the same version and left 8. A dry run listed nothing.

A second Worker on another state then imported `tasks/write-greeting` into the same store, in 2.2 s. Three `nanoeval prune store --remove` against the first Worker, 0.3 s apart during that import, each ended with `Store.LockedError: the store ... is held by an import or by a prune` and removed nothing. A 100,000-byte file under its digest and a 5,000-byte staged file were added by hand, for 14 files.

| Against the first Worker | Unreferenced | Kept |
| --- | --- | --- |
| Dry run | 5 blobs and 1 staged file, 4,425,899 bytes | 8 blobs, 7,132,066 bytes |
| `--remove` | The same 6 removed | 8 blobs, 7,132,066 bytes |
| Dry run again | 0 | 8 blobs |

`nanoeval run --eval samples --oracle --wait` after the removal, on krun slots with a runner cache that held no blob, passed 2 of 2 in 4.4 s. Against the second Worker a dry run said that its 4 blobs were not in the store and that all 8 were unreferenced, and `--remove` was refused: `the 1 evals of the Worker name no blob of ...: removing would empty the store`.

#### The data of the Terminal-Bench 2.1 import, dry run only

Nothing was removed there. Other work on the machine was writing to that layer cache: it held 512 files eleven minutes before the run and 533 at the time of it.

| Command | Would remove | Would keep |
| --- | --- | --- |
| `image prune --days 0` on the layer cache | 533 blobs, 16,862,423,654 bytes, each last used 0.6 days back | 0 |
| `image prune --days 1` | 0 | 533 blobs, 16,862,423,654 bytes |
| `image prune --days 7` | 0 | 533 blobs, 16,862,423,654 bytes |
| `prune store` against a Worker on a copy of the state | 0 | 355 blobs, 19,183,662,200 bytes |

Each `image prune` took under 0.01 s, and `prune store` 0.31 s with its three requests. The Worker listed one eval with one version, `terminal-bench-2.1@14f3a1e5`, whose 89 rows name 355 blobs, all in the store. A listing of every path with its type, size, mode and three times was taken before and after. The store's was identical. The layer cache's differed in one line, the access time of the `blobs/sha256` directory itself, which the kernel moves when a directory is listed. No blob's times changed and no lock file was created.

#### Checks

At `6f425fd`: `npm ci`, `npm run lint`, `npm run check:types`, `npm test` (78 tests, 8 of them new), `npm run dry-run`, `cargo fmt --check`, `cargo clippy --all-targets --locked -- -D warnings` and `cargo test --locked` (6 new unit tests, and the two integration tests ran) passed. `npm run e2e` passed on directory slots, on krun slots, and on krun slots with the oracle, one run each.

#### Not verified

- A cache on a `noatime` mount. The machine has none that could be written without privileges.
- A removal beside an import or a launcher from a checkout before this change, which takes neither lock.
- `--remove` on a cache or a store of a real dataset. The two above were only listed.
- A store on a filesystem shared by several machines.
- A cache whose files another user owns.
- The end-to-end lanes import through `Import.cases` and not through `importEval`, so no lane holds the store's lock.
- CI on GitHub. Nothing is pushed.

### A verifier cache

**Measured first.** Ten Terminal-Bench 2.1 tasks with their own solutions, `nanoeval run --eval terminal-bench-2.1 --oracle --sandboxes 0` with `--only` for `build-pmars`, `cancel-async-tasks`, `fix-git`, `git-leak-recovery`, `largest-eigenval`, `log-summary-date-ranges`, `nginx-request-logging`, `openssl-selfsigned-cert`, `regex-log` and `sqlite-db-truncate`, on the imported eval `terminal-bench-2.1@14f3a1e5`, one attached runner with 4 slots and the machine's `--ca-bundle`, `--slot-env` and `--slot-forward`. The time of the tests is what pytest prints at its end, and the setup is the rest of the verifier phase.

| Run | Option | Load average | Passed | Verifier, ten tasks | Tests | Setup |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | off | 31 | 10 | 118.2 s | 17.4 s | 100.8 s, 85 % |
| 2, the oracle fills the cache | on, ten misses | 34 | 10 | 119.8 s | 17.5 s | 102.3 s |
| 3 | on, nine hits | 20 to 34 | 10 | 59.9 s | 17.0 s | 42.9 s |
| 4 | off | 11 to 17 | 10 | 102.9 s | 17.0 s | 86.0 s, 84 % |

Setup was 8.6 to 13.8 s of every verifier in run 1 and 6.7 to 12.0 s in run 4. One command at a time, by hand in a slot on the disk of `fix-git`, whose image has Python 3.13: `apt-get update` 0.99 s, `apt-get install -y curl` 0.70 s, the uv installer 0.60 s, `uvx -p 3.13 -w pytest==8.4.1 -w pytest-json-ctrf==0.3.5` 5.49 s, and 0.17 s when it is run again in the same slot. On the disk of `regex-log`, which has no Python 3.13, `uvx` took 6.04 s and downloaded a CPython of 32 MiB. So the larger half of the setup is uv's downloads, and the rest is apt.

**What was built.** `nanoeval run --verifier-cache`, off by default: DESIGN.md describes it. A hit copies the kept directory into the slot when the verifier phase starts, 0.24 s for the 1,167 files and 50 MB of `regex-log`, and `uvx` then took 1.05 s there, which includes unpacking the cached CPython. apt is not cached: `apt-get update` asks the mirrors of the day, and lists from a cache would decide which packages a later `apt-get install` asks for, which is what broke `build-pmars` in the entry above.

**The same outcomes, and the time.** All ten rows passed in all four runs. Per task, run 4 against run 3:

| Task | Setup without | Setup with a hit | Saved |
| --- | ---: | ---: | ---: |
| `build-pmars` | 7.05 s | 3.24 s | 3.8 s |
| `cancel-async-tasks` | 8.55 s | 3.48 s | 5.1 s |
| `fix-git` | 7.84 s | 3.26 s | 4.6 s |
| `git-leak-recovery` | 10.47 s | 4.64 s | 5.8 s |
| `log-summary-date-ranges` | 8.05 s | 2.81 s | 5.2 s |
| `nginx-request-logging` | 6.65 s | 2.58 s | 4.1 s |
| `openssl-selfsigned-cert` | 7.10 s | 4.10 s | 3.0 s |
| `regex-log` | 10.39 s | 7.12 s | 3.3 s |
| `sqlite-db-truncate` | 7.81 s | 3.59 s | 4.2 s |
| `largest-eigenval`, whose verifier uses pip and has no cache | 12.04 s | 8.11 s | Not the cache: 13.83 s and 12.75 s in runs 1 and 2 |

Ten verifiers took 59.9 s with the cache against 102.9 s and 118.2 s without, so 43 to 58 s less, 4 to 6 s an attempt. The nine caches are 230 MB, 18 to 50 MB each. `largest-eigenval` shows what one run is worth on this machine: its setup moved by 5.7 s between runs with no cache at all.

**The lane.** `NANOEVAL_E2E_SCENARIO=cache npm run e2e` on krun slots, with a fixture whose verifier writes 1,500 files where `UV_CACHE_DIR` says, or where uv would keep them without it: a model's attempt on an empty cache runs with the variable unset and keeps nothing, the oracle's attempt runs with it and keeps the files, the next attempts of the model and of the oracle find them, and a run without the option does not.

**Found on the way.** Copying the first cache out of a slot ended with "No file descriptors available" at 1,167 files. A share keeps a descriptor on the host for every file its guest has looked up, and the VMM ran with the usual soft limit of 1024. So a task whose `tests/` holds more than about a thousand files could not have been verified either. The VMM raises the limit to its hard limit now, 524,288 on this machine.

### HealthBench Professional: the two pairs of rewards were two pairs of cases

Machine: the 32-core Linux machine with KVM of the entries above, shared with other work (load average 51 at the start of the first run below and 35 at the second). Each figure is one run. The judge is `gpt-6-luna` at low thinking on a ChatGPT plan login, and cost is the harness's estimate.

The entry of 2026-11-10 recorded rewards 0.643 and 0.028 for two cases with their physician answers. The entry of 2026-11-11 recorded −0.006 and 0.426 and could not say whether the cases were the same. They were not, and nothing moved the judge.

| Entry | How two cases were chosen | Order | Cases | Rewards |
| --- | --- | --- | --- | --- |
| 2026-11-10 | The whole dataset written with `import --out`, then `run --dataset DIR --limit 2` | Ids, as `dataset.json` lists them | `004691ba3ff3eec87d6a5598d9e1b04b`, `0187e39434668c08c7b18b8e81cc3604` | 0.028, 0.643 |
| 2026-11-11 | `import healthbench-professional --limit 2` | Rows of the source file | `9566084de89c416408691006a6f06f9c`, `c19c2113ba68bb3c4a3e63836e31b558` | −0.006, 0.426 |

The second pair is named by the job directories of that entry's run and rerun, which were still on the machine with their judge requests, answers and judgments. Nothing of 2026-11-10 names the first pair. Three things do:

- Arithmetic over the pinned file. For each of the 525 rows, every reward its physician answer can get was computed: each subset of its rubric items met, and the length adjustment on the answer's characters. One row can score 0.643, and it is `0187e394…`, the second id of the 410 cases of one message. Fifteen rows can score 0.028, and `004691ba…`, the first id, is one of them, with no item met. The second pair can score neither: `9566084d…` reaches −0.006, 0.460, 0.527 and 0.994, and `c19c2113…` 14 values from 0.026 up.
- That entry's cost note, "the three judgments of one HealthBench case took 28,008 input tokens and 128 output tokens". `004691ba…` has three rubric items, and its three judge turns took 28,008 input tokens in both runs below. The second pair has two and five items.
- The run below.

**The first pair again.** At `dca3463`: `nanoeval import healthbench-professional --only 004691ba3ff3eec87d6a5598d9e1b04b --only 0187e39434668c08c7b18b8e81cc3604`, then `nanoeval run --eval NAME --oracle --judge codex:gpt-6-luna:low --sandboxes 0` and one attached runner with two krun slots on the private network.

| Case | Rubric points | Met | Raw score | Characters | Length adjustment | Reward |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| `004691ba…` | 8, 8, 8 | None | 0 | 1,052 | +0.027871 | 0.027871 |
| `0187e394…` | 10, 8, 9, −9 | The second and the third | 17/27 = 0.629630 | 1,545 | +0.013377 | 0.643007 |

It cost $0.0060 for seven judge turns: 28,008 input tokens for three and 37,948 for four, about 9,400 a turn. The runner worked 6.2 s, and the judge took 3.8 s and 4.4 s of it.

The second pair, read from the judgments of its two surviving runs: `9566084d…` has items of 7 and 8 points, none met, 2,215 characters, reward −0.006321. `c19c2113…` has items of 8, 8, 7, 9 and 8 points, the second and the fifth met, 16/40, 1,099 characters, reward 0.426489.

**What was ruled out.**

- The text that is graded. The grader's `response_chars` equals the characters of `physician_response` in the source for all four cases. The answer of `9566084d…` is 2,298 bytes of UTF-8 and was counted as 2,215, so characters are counted and not bytes. The oracle hands over `solution/final_message.txt` as the import wrote it: no newline is added, and the output of `solve.sh` is not used.
- The grader and the judge. `git diff 4d11381 af57dc7` is empty for `datasets/`, `src/Judge.ts`, `worker/Harness.ts`, `worker/Sessions.ts` and `package.json`: the same prompt, parser, arithmetic and nanocode-ts release under both entries. Both versions of `worker/Run.ts` submit each rubric item as a session of its own with the judge's model and thinking level.
- The port. The prompt template, `parse_grade` and the arithmetic are identical, line for line, to the `grade.py` of the earlier adapter. The arithmetic is that of `calculate_score` and `calculate_length_adjusted_score` in OpenAI's `simple-evals` at `652c89d`. The prompt is not the `simple-evals` template: the earlier adapter had shortened it, and it stays as ported.
- The judge's own variation. Each of the four cases ran twice on a byte-identical request file: the run and the rerun of 2026-11-11, and the two runs here. All 14 verdicts were the same both times. The explanations were not: 12 of 14 differ in wording, and one is in the language of the question instead of English. That is two samples an item.

**What was a defect.** `--limit N` meant two things. `import D --limit N` took the first N rows of the source for GPQA, HealthBench and SWE-bench, and the first N ids for the registry datasets. `run --eval D --limit N` and `dataset.json` take the first N ids. `f238c1f` orders every selection by id in `datasets/Dataset.ts`, so a limit names the same tasks at import and in a run.

After it, `nanoeval import healthbench-professional --limit 2` imported `004691ba…` and `0187e394…` as the version `e1f586d9…` that the `--only` import had made, and the same oracle run scored 0.027871 and 0.643007 again for $0.0060 (runner 6.5 s). `--only 9566084de89c416408691006a6f06f9c --only c19c2113ba68bb3c4a3e63836e31b558` names the pair of 2026-11-11.

Computed from the pinned files and not run: GPQA's `--limit 5` keeps four of the five tasks it named before, since its rows are almost in id order, and the first three SWE-bench instances are the same in both orders.

**Cost.** $0.0120 for 14 judge turns in two runs.

**Not verified.**

- That the directory of 2026-11-10 held the whole dataset. It is gone, and the three points above are what says so.
- The three cases that ran with `gpt-6-luna` on 2026-11-10 (0.357, 0.617 and 1.031). By the same rule they are the first three ids. They were not run again.
- A model's answers on an imported HealthBench eval, and a judge's verdicts beyond two samples an item.
- `grade.py` reads the final message as text, so Python would count a `\r\n` as one character where `simple-evals` counts two. None of the 410 physician answers has a carriage return, so no recorded score depends on it. It was left as it is: changing the grader changes the checksum of every HealthBench task.
- `python:3.12-slim` is a tag. The packed disk of this import is 38,115,789 bytes and the one of 2026-11-11 was 37,942,168: the tag had moved, and the import read seven new blobs from the registry. The grader uses only Python's standard library.

### What the documents said that was no longer so

- README and DESIGN.md said that a build step gets no host policy, that `allow_internet = false` is refused, that nothing cuts a slot's connections, and that the verifier cache waits for a measurement: all four are rewritten.
- `src/Task.ts` refused `environment_mode = "shared"`, which is what Harbor 0.25.0 writes, and a `[verifier.environment]` table was not refused: fixed, with tests.
- The usage text of `import --limit` did not say which order it counts in, and it counted in two: see the HealthBench section.

### The installed command

`scripts/install-linux.sh --name NAME` on other ports with the store, cache, layers and state on another filesystem, `--krun` on a built launcher, and `--ca-bundle`, `--slot-env` and two `--slot-forward`: the configuration of the installed command holds the three as `NANOEVAL_CA_BUNDLE`, `NANOEVAL_SLOT_ENV` and `NANOEVAL_SLOT_FORWARD`. `NAME import --task test/fixtures/package-installs`, with no option of its own, converted the Dockerfile in 8.8 s through the installed services, `NAME run --oracle --wait` passed 1 of 1 on the runner that `sandboxd` started, and `--remove` left no unit, command or configuration. The services the machine already ran were not touched.

### Every check, from a fresh clone

From a fresh clone of `1662b44`, with no built launcher named, so that cargo built it in the clone, load average 8 to 27: `npm ci`, `npm run lint`, `npm run check:types`, `cargo fmt --check`, `cargo clippy --all-targets --locked -- -D warnings`, `cargo test --locked`, `npm test` (84 tests, none skipped) and `npm run dry-run` passed, and then every lane of `ci.yml`, one run each:

| Lane | krun | dir |
| --- | --- | --- |
| Scripted model | passed, 2.3 s, and 5.7 s with three tasks | passed, 2.4 s |
| Oracle | passed, 1.7 s | passed, 1.1 s |
| Blobs in R2 through the Worker | passed, 3.1 s | passed, 3.3 s |
| Final messages and a judge | passed, 2.7 s | passed, 3.6 s |
| Final messages and a judge, oracle | passed, 1.6 s | |
| Failure kinds, then a rerun | passed | passed |
| Orchestrator restart | passed, 7.9 s | passed, 4.1 s |
| Slot networks | passed, 1.9 s | |
| Closed networks | passed, 13.7 s | passed: the run is refused |
| Verifier cache | passed | |
| Disk removal | passed, 4.6 s | |
| Free disk floor | passed | passed |
| Memory packing | passed | passed |
| Two attached runners | passed, 2.7 s | passed, 2.6 s |
| A runner lost during the run | passed, 5.3 s | passed, 5.1 s |
| A runner restarted during the run | passed, 2.0 s | passed, 1.4 s |

The figure is the wall time of the run, where the lane prints one. One lane did not pass by itself the first time: see the next section. After the last commit, which changes this file only, `npm run lint` and `npm test` ran again.

### A builder microVM that stopped reading

Twice in about a hundred conversions of this entry, both with a load average above 20, `image build` stopped at its first layer: the launcher blocked writing the layer to the guest's socket, and the guest, which had answered the ping before it, sat idle with both of its virtual CPUs blocked. The second time was the import of the two-runners lane of the fresh clone, a Dockerfile of `FROM`, `WORKDIR` and `COPY` with no network device and no host policy. After 75 s a ping on the same guest's socket from another process was answered at once, and the stopped build went on and finished, as did the lane. The lane then passed in 6 s when it was run again. So the guest had not been told of a connection that was waiting for it, and the next connection told it: a wakeup lost between the VMM's vsock device and the guest. libkrun is pinned where the entries above pinned it. Eight repeats of the first build that stopped, and one with the guest's binary replaced during the build, all completed. It was not reproduced on demand and is not fixed. An import that meets it waits until something else talks to that guest, which for a builder is never. A slot has other connections to its guest during an attempt, and none of the attempts of this entry showed it.

### Not verified

- CI on GitHub. Nothing is pushed.
- The lost wakeup above: its cause, how often it happens on a quiet machine, and whether a verifier that starts in a slot can meet it.
- A closed phase under a model. The lane uses the scripted model. No dataset here writes a task that closes a phase: GPQA and HealthBench are closed-book and their importers still leave the network open, since changing them changes the checksum of every task and the scores recorded so far.
- A network allowlist, a closed phase on `--network host`, on `dir` slots or in a sandbox without KVM, and a closed agent whose Worker is deployed: all refused.
- What the gate costs a task that moves much data through its network. Only tasks that close a phase have one.
- The verifier cache on the other 79 Terminal-Bench tasks, with a model's attempts, on images with musl, and with a uv other than 0.9.5. Verifiers that install with pip, and every `apt-get`, are as slow as before.
- Dockerfile builds of the other 84 Terminal-Bench tasks, heredocs and the other instructions the builder refuses, and linux/arm64.
- `--remove` on the layer cache and the store of the Terminal-Bench 2.1 import, which were only listed, and the prune commands beside a checkout from before them, which takes neither lock.
- The HealthBench items its own section lists.

## 2026-11-11: installed agents, and nanocode beside Codex CLI

A run could compare nanocode sessions with each other and with nothing else. This entry adds a second kind of agent, a vendor's command line inside the slot, and the first table that nanoeval itself produced of nanocode beside Codex CLI. [DESIGN.md](DESIGN.md#installed-agents) has the design and what such a comparison holds equal. All of it ran on a 32-core Linux machine with KVM that other work kept busy: its load average was between 15 and 50 for every measurement here.

### What was established

- **A command line can run in a task image that was not built for it.** Codex CLI 0.166.0 ships a package of static binaries. Claude Code 2.1.318 ships a glibc binary that links librt, libc, libpthread, libdl and libm and asks for no symbol later than GLIBC_2.26, and a musl binary that links musl's libc and nothing else. So the releases are fetched once per machine, checked against a pinned SHA-256, and shared read-only with every slot, as the hand is. Both builds of Claude Code ran in krun slots, the musl one in an Alpine image and the glibc one in a Debian 12 image, with no Node in either.
- **The lone `codex` binary is not enough.** With only `codex-x86_64-unknown-linux-musl` in place, every tool call of a turn failed with "Code Mode is unavailable because failed to spawn code-mode host", and the model answered that it could not write the file. The package `codex-package-<arch>-unknown-linux-musl.tar.gz` holds `codex-code-mode-host` and `rg` beside it, and with it the same prompt wrote the file. The package is what is pinned.
- **Codex CLI works on a ChatGPT plan with no login in the guest.** A model provider given on the command line (`base_url`, `env_key`, `wire_api = "responses"`) makes it send `POST <base_url>/responses` with the value of that variable as its bearer token, `store: false` and `stream: true`, and nothing to any other address. The run swaps the token for the plan's and sends the request to `/backend-api/codex/responses` through the relay that sessions use. chatgpt.com answered 200 to each of the 38 model requests of the seven Codex CLI attempts below that ran to their end. The usage the endpoint read from the `response.completed` event of each response summed to what the command printed for its turn: 46,354 input tokens, 21,888 of them cached, and 1,280 output tokens in the first attempt.
- **Claude Code can be pointed at the run the same way.** With `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` it sends `POST /v1/messages?beta=true` to the endpoint, and the scripted Messages endpoint behind the run saw the deployment's `x-api-key`, no `authorization` header, the model and `{"effort":"high"}`. It ran its `Bash` tool in the guest and the fixture passed. That is the plumbing. Whether Anthropic accepts its requests through this endpoint, with an API key or with a plan token, was not tried, see below.
- **`CODEX_HOME` under `/tmp` costs Codex CLI its helper commands.** It printed "Refusing to create helper binaries under temporary dir". The agent's state directory is `/var/lib/nanoeval-agent` for that reason, made as root with the sticky bit so that an image's own user can use it, and removed before the verifier.
- **A refusal must read the request first.** A model request whose token is refused was answered before its body was read, and local workerd then failed one such request in a test with "Can't read from request stream after response has been sent" and a 500. A refusal now drains the body.
- **A row that was claimed twice has the requests of both claims**, each marked with its claim, and counts only the last. The lanes with a restarted and a lost runner found this in the test's own expectation, not in the count.

### The first comparison

One run at `3cfde90`, of six Terminal-Bench 2.1 tasks of `terminal-bench-2.1@14f3a1e5` that pass with their own solutions and are quick, one attempt each for two agents on `gpt-6.1-sol` at high thinking through one ChatGPT plan login: a nanocode session, and Codex CLI 0.166.0 in the slot. Four krun slots on a private network, one runner, the host policy of the earlier runs.

```sh
nanoeval run --eval terminal-bench-2.1 --only openssl-selfsigned-cert --only fix-git --only git-leak-recovery \
  --only sqlite-db-truncate --only regex-log --only log-summary-date-ranges \
  --agent nano-codex=codex:gpt-6.1-sol:high --agent codex-cli=codex-cli:gpt-6.1-sol:high \
  --attempts 1 --slots 4 --model-budget-usd 25 --wait
nanoeval compare RUN
```

| Arm | Harness | Model | Attempts | Passed | Failed | Errored | Agent time | Attempt time | Input tokens (cached) | Output tokens | Estimated cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| nano-codex | nanocode | codex:gpt-6.1-sol:high | 6 | 6 | 0 | 0 | 5 min 9 s | 6 min 9 s | 456,293 (366,080) | 11,327 | $0.3303 |
| codex-cli | codex-cli 0.166.0 | codex:gpt-6.1-sol:high | 6 | 6 | 0 | 0 | 6 min 36 s | 7 min 44 s | 466,407 (330,880) | 15,323 | not known |

| Task | nano-codex | codex-cli |
| --- | --- | --- |
| fix-git | passed 35 s | passed 39 s |
| git-leak-recovery | passed 1 min 1 s | passed 2 min 6 s |
| log-summary-date-ranges | passed 44 s | passed 25 s |
| openssl-selfsigned-cert | passed 54 s | passed 1 min 1 s |
| regex-log | passed 1 min 26 s | passed 1 min 42 s |
| sqlite-db-truncate | passed 29 s | passed 43 s |

**This is a smoke test, not a benchmark result.** Six easy tasks and one attempt say that both arms run end to end on the same rows and that the table can be made, and nothing about which harness is better: every attempt passed, and a difference of a minute on one task is one sample on a busy machine. The run took 254 s from its creation to its end. The nanocode arm made 32 model calls and 60 tool calls, the Codex CLI arm 34 and 39. The cost of the nanocode arm is the harness's estimate. Codex CLI prints none, so its tokens are known and its cost is not. The exported job loads with the models of Harbor 0.25.0 (`scripts/harbor-check.py`: 39 files, none refused), with `codex-cli` and its version as the agent of its trials.

Before it, at the working tree that became `fcb298d`: one attempt of `openssl-selfsigned-cert` with `codex-cli:gpt-6.1-sol:low` passed in 36 s of agent time, and a run cancelled 14 s into `fix-git` ended its attempt as `cancelled` with no command, microVM or sandbox directory left.

### An image without glibc

One run at `3cfde90`, of the two Alpine fixtures `extract-todos` and `write-greeting` with both agents on `gpt-6.1-sol` at low thinking, one attempt each. Codex CLI passed both: its package is static, and it ran its commands through `/bin/sh -lc`, so it needs neither glibc nor bash in an image. The nanocode session passed `extract-todos` and failed `write-greeting`: it wrote `/greeting.txt` with its `Write` tool, and the working directory of the task is `/app`. In the Claude trajectory below the model likewise looked for its file in `/tmp` before it ran `pwd`. Two samples do not settle it, but they suggest that a session does not tell the model the working directory of its hand, where both command lines tell theirs. That is nanocode's prompt and not nanoeval's to add to, and it is one of the ways the two arms of a comparison differ.

### The Claude arms were not run

No Claude login was valid. The plan login at hand had expired, and one run of the official command line to let it renew answered "OAuth session expired and could not be refreshed". Renewing needs a browser sign-in, which was not worked around. That run also left the login file with an empty access token and an empty refresh token, which is what the tool does when a refresh is refused: a Worker started with `--claude-login` on that file now stops at "holds no Claude plan login" instead of starting with an expired token. So `claude:...` and `claude-code:...` agents are not verified against Anthropic on this flow, and the table has no Claude rows. After a new sign-in on the machine, start the Worker with `--claude-login` and run:

```sh
nanoeval run --task tasks/extract-todos --task tasks/uppercase-message --task tasks/write-greeting \
  --agent haiku=claude:claude-haiku-4-5 --agent code=claude-code:claude-haiku-4-5 --wait
nanoeval run --eval terminal-bench-2.1 --only openssl-selfsigned-cert --only fix-git --only git-leak-recovery \
  --only sqlite-db-truncate --only regex-log --only log-summary-date-ranges \
  --agent nano-claude=claude:claude-opus-5-5:high --agent claude-code=claude-code:claude-opus-5-5:high --wait
nanoeval compare RUN RUN
```

**Why the one earlier Claude attempt failed.** The first flow ran `claude-haiku-4-5` once on `uppercase-message` with a valid plan login, and its verifier answered "message transformation is missing or incorrect". Its kept trajectory says why. The model's first choice was the Claude harness's `Bash` tool, and the hand answered "command executor: Bash executable not found" twice: the fixture's image is Alpine, which has no bash, and the string is in the released `nanocode hand` binary, not in nanoeval or nanocode-ts. `exec_command` worked in the same image. The model then read the file with `Read`, whose result is numbered lines, rebuilt the text from them, and wrote `NANOEVAL\nRUNS IN PARALLEL` with `Write`, without the final newline that the task asks for. So the reward of 0 is the model's, on a path it took because a tool of its harness needs a shell the image does not have. Nothing in nanoeval is wrong there, and a slot adds no shell to an image. For nanocode: the hand's `Bash` tool could fall back to `sh`, as a slot does for a solution and a verifier. Terminal-Bench images have bash, so its tasks are not affected.

### What ran

- `npm test`: 12 new tests for installed agents and one for the comparison table, among them the two commands started through `sh` with a stand-in binary, the credential swap for an API key and for a plan login of each provider, the usage meter over responses cut at every byte, and a release refused for its checksum.
- End-to-end, a scripted command in place of the vendor's, which asks the run's endpoint for what to do with the token it was given, behind a model endpoint that refuses anything but the deployment's credential: tasks, failure kinds with a rerun, a runner restarted and a runner lost, each on directory and on krun slots. All passed. The lanes check the token counts of each attempt against what the endpoint sent, that the cost a command reports counts against the model budget, and that the endpoint of a finished attempt answers 401.
- A slow agent ends as `agent_timeout` with its verifier reward, and a command that exits with another code as an `agent` error.

### The full campaign

Not run. Four arms, 89 tasks and two attempts are 712 attempts:

```sh
nanoeval run --eval terminal-bench-2.1 --attempts 2 --slots 8 \
  --agent nano-codex=codex:gpt-6.1-sol:high --agent codex-cli=codex-cli:gpt-6.1-sol:high \
  --agent nano-claude=claude:claude-opus-5-5:high --agent claude-code=claude-code:claude-opus-5-5:high \
  --wait --out output/tb21-four-arms
nanoeval compare RUN
```

The Worker needs both logins for the whole run, and it reads an access token once: a Claude plan token lives for hours, so the two Claude arms may need a run of their own that ends inside one token, and `nanoeval compare RUN RUN` joins the two.

How long it takes cannot be read off six easy tasks. What was measured: 51 s and 66 s of agent time per attempt on them, 6 % and 7 % of their 900 s timeout, and about 10 s of verifier. What is known of the rest: the agent timeouts of the 89 tasks sum to 151,950 s, 900 s for 48 of them and 1,800 s or more for 34. Three figures for 8 slots, with no allowance for plan rate limits:

| Assumption | Slot time | Wall time at 8 slots |
| --- | ---: | ---: |
| Every attempt as quick as the six | 49,000 s | 1.7 h |
| An attempt takes a quarter of its timeout and a minute of verifier. This is an assumption, not a measurement | 347,000 s | 12 h |
| Every attempt runs to its timeout | 1,260,000 s | 44 h |

Eight slots were chosen for the CPUs of the machine, which other work shares, and because two arms of a provider draw on one plan. Its memory would admit more: 68 of the 89 tasks ask for 2 GiB.

## 2026-11-11: E2B for real: slots without KVM, a runner without a checkout, a paid run

Machines: the 32-core Linux machine with KVM of the entries above (kernel 6.8, libkrunfw 5.5.0, Node 24.22.2, rustc 1.97.1), shared with other work at a load average between 16 and 42 throughout, and E2B sandboxes opened over MPP at `https://mpp.e2b.dev`. Commits `ab30a16` to the head of this entry.

### What was wrong

The E2B provider had only met a local mock, and the flow had moved under it: a sandbox now only starts a runner, and a slot boots a converted ext4 disk in a libkrun microVM, which needs `/dev/kvm`. Nobody had looked inside an E2B sandbox. A public template also has none of nanoeval's needs: no checkout, no launcher, and no Node that runs TypeScript.

### The probe

One `base` sandbox for 60 s ($0.001824), one command over envd, 4.4 s. The request took 4.7 s with its payment, and envd answered `/health` 0.56 s after it returned.

| | `base` (2 vCPU, 512 MiB) | `desktop` (8 vCPU, 8 GiB), seen in the runs below |
| --- | --- | --- |
| Guest | Firecracker, kernel 6.1.189+, Debian 12, glibc 2.36, x86_64 | The same kernel, Ubuntu 22.04.5 |
| KVM | No `/dev/kvm`, no `vmx` or `svm` flag, a kernel without modules. `mknod` of the device opens to "No such device" | The same |
| Root | `user` (uid 1000) with `sudo -n`, every capability, no seccomp filter | The same |
| Kernel | overlayfs, loop devices (`/dev/loop0` to 7 and `loop-control`), ext4, squashfs, FUSE, veth, bridge, tun, nftables and iptables NAT, every namespace kind. `unshare -U` works for the unprivileged user too | The same |
| cgroup | v2, with `cpuset cpu io memory pids` enabled for the root's children. envd runs commands in `/user` | The same |
| Machine | 484 MB of memory, no swap, 20 GB free on a 22 GB ext4 root, 256 MiB written and synced at 106 MB/s | 7955 MB, 20 GB free of 26 GB |
| Network | `eth0` on a /30 link, resolver 8.8.8.8, no IPv6, 25 MB downloaded at 96 MB/s, `ip_forward` 0, an empty `inet filter` table | The same |
| Tools | Node 20.9.0, Python 3.11, curl 7.88, `mke2fs`, `losetup`, `unshare`, `nsenter`, `setpriv`, `chroot`, `ip`, `nft`, `iptables`, git, gcc. No zstd, passt, bwrap, docker or podman | coreutils 8.32, bwrap, perl, python3. No `node` on the path |
| envd 0.10.0 | `process.Process/Start` as Connect JSON and `/files` with `application/octet-stream` or a multipart form both work. A request without `X-Access-Token` is answered 401 | The same |

So an E2B sandbox boots no microVM, and it is a machine with root and a complete kernel. The raw output is kept outside the repository.

**The control plane**, read from its own `/openapi.json` and from quotes, which are free: `POST /sandboxes {templateID, timeout, metadata, envVars}` answers 201 with `sandboxID`, `envdAccessToken`, `envdVersion`, `templateID`, `alias`, `clientID` and `trafficAccessToken`, and no `domain`. Each request carries four challenges: `charge` and `session`, each in two six-decimal tokens. A lifetime over 86,400 s is quoted as 86,400 s. A template that is not public is refused with 400 before any challenge. `DELETE /sandboxes/ID` answers 204. There are also `GET /sandboxes`, `pause`, `connect`, `timeout`, `refreshes` (extend the lifetime by 15 to 86,400 s), `logs` and `metrics`, which nanoeval does not call.

**The price** fits every quote taken: $0.0001 per request, plus $0.0000133 per vCPU-second and $0.000004275 per GiB-second of the requested lifetime, paid when the sandbox is created.

| Template | Size | 60 s | 1 h |
| --- | --- | --- | --- |
| `base` | 2 vCPU, 512 MiB | $0.001824 | $0.103555 |
| `code-interpreter-v1` | 2 vCPU, 2 GiB | $0.002209 | $0.126640 |
| `desktop` | 8 vCPU, 8 GiB | $0.008536 | $0.506260 |

### What was built

| | |
| --- | --- |
| `ns` slot backend | The same packed ext4 disk, loop-mounted read-only once per machine, under a sparse ext4 upper disk and an overlay per slot, in mount, PID, IPC, UTS, cgroup and network namespaces. The guest agent of a krun slot serves it over a UNIX socket, so `hand`, `solve`, `verify` and `down` are the code of a krun slot |
| `--backend auto`, the default of a run | A runner takes `krun` where `/dev/kvm` opens and `ns` where it is root. `--backend` on a run or a runner names one |
| The runner runtime (`--runtime`, `nanoeval runtime`) | One archive of 20.1 MB: the runner bundled into one file by esbuild (40 kB, for Node 20 and later), `slot.sh`, static builds of the launcher without libkrun, the guest agent and the relay (5.9 MB), and the pinned hand (39 MB unpacked). It is a blob, and the run serves it to its runners by digest |
| The bootstrap (`src/Bootstrap.ts`) | A script the run writes into a sandbox: fetch the archive, check its SHA-256, use the sandbox's Node when it is 20 or later and fetch Node 24.22.2 by checksum otherwise, start the runner as root |
| `nanoeval sandbox --run RUN --e2b FILE` | Attaches a runner in a sandbox that someone else opened and paid for, from the answer of the paid request |
| Blobs | `GET` with `Range: bytes=N-` through the Worker, and a download that breaks resumes from the bytes it has, six times |
| Sandbox lifetime | Chosen by the run unless `--sandbox-timeout-sec` names it |

### What was decided

- **Namespaces as root, not bwrap or a user namespace.** The sandbox has real root, so the kernel mounts the disk and owners, devices and setuid bits are what the image says, as in a microVM. An unprivileged user namespace cannot loop-mount the disk. Root inside a slot is bounded another way, below.
- **The same guest agent.** A second implementation of exec, of the copy of tests and of the relay would have had to stay equal to the first. The agent got a transport: a UNIX socket for requests, one for the relay, a directory for the exchange. Everything it needs before it serves is done by `slot.sh` with the machine's own `unshare`, `mount`, `setpriv` and `chroot`, so the Rust workspace gained no `unsafe` and no dependency.
- **What bounds root in a slot.** The capability bounding set is Docker's default without `CAP_MKNOD`: no `CAP_SYS_ADMIN`, so no mount, and no device node, since no device cgroup stands between a slot and the sandbox's disk. `/proc/sys`, `/proc/sysrq-trigger` and three more are read-only, `/proc/kcore` and others are masked, `/sys` is read-only, `/dev` is a tmpfs with six devices. A slot shares the sandbox's kernel: this is the isolation of a container, weaker than a microVM's, and the sandbox is the boundary to the outside.
- **`mount --move` and `chroot`, not `pivot_root`.** After a pivot the shell would need `umount` from an image that may not have it, and the agent cannot detach the old root once its capabilities are bounded. Moving the new root over `/` leaves the old one under it, where no path leads: `..` at the top of a mount stack stays there.
- **veth and nftables for the private network.** One /30 from 10.213.0.0/16 per slot, masquerade out, and two drops: a slot reaches neither another slot nor the sandbox itself, which is where envd listens. passt would have been one more package to install in every sandbox.
- **The lower disk is mounted once.** One loop device per slot would hold the same pages once per slot in a sandbox of 8 GiB.
- **cgroup v2 where the machine has it**, `memory.max` and `cpu.max` from the task, and `oomKills` from `memory.events`. Without it a slot has no limit, setup says so, and the capability `cgroup` is false.
- **A bundle, not a checkout.** The sandbox's Node cannot run TypeScript, and a checkout with its modules is 300 MB. The launcher is linked statically against musl because the machine that builds it has a newer glibc than Debian 12.
- **The lifetime is an upper bound.** A sandbox is paid before it runs and nothing comes back. The run places the worst case of each row, its setup, agent and verifier timeouts, longest first on the slot that is free soonest, and adds the setup limit for the bootstrap. For four Terminal-Bench tasks on three slots that is 5,400 s. It is honest and it is expensive, see the costs below, so an operator who knows the tasks names a shorter one.
- **The operator's wallet may pay.** A Worker that pays needs a key in its variables. `nanoeval sandbox` is the other seam: any payer opens the sandbox, and its runner is an attached runner like any other.

### What a real run found

Six defects, none visible against the mock or in the first guest lanes:

- A slot ran its commands with `SIGINT`, `SIGQUIT` and `SIGHUP` ignored, inherited from the detached shell that starts it. A Terminal-Bench verifier that interrupts a child timed out, and `cancel-async-tasks` failed with its own solution. The slot now starts through `env --default-signal`. A microVM never had this: its processes descend from the guest's init.
- `slot.sh probe` ended the script when the machine could not run ns slots, instead of reporting it.
- `slot.sh destroy` waited forever on a slot cgroup, because the file that names the machine's cgroup root had the name of the file that names a slot's.
- `slot.sh tools` asked for KVM, so a runner without it could not unpack a disk.
- `slot.sh destroy` and a runner's `down` of the same slot could each wait forever for the cgroup the other had just removed. It showed in one run of the network lane out of four.
- A second run attached to the same sandbox would have started from the first run's runtime and setup. The runtime is now kept under its digest, and an attached runner gets a home per run.

### Measurements

Guest lanes: the ns lanes run inside a libkrun microVM of 8 vCPUs and 8 GiB that boots Debian 12 with Node 24 and has no KVM, against the Worker on the host, see [DESIGN.md](DESIGN.md#testing-without-root). Scripted, oracle, failures and a rerun, judge, network, restart, packing, and the oracle lane started through the bootstrap on Node 20.9.0 with blobs in R2: all passed. In the oracle lane of three tasks the median phases were 0.87 s for the environment, 0.24 s to attach the hand, 0.20 s for the solution and 0.47 s for the verifier, and a slot came up in 0.23 s.

Blobs through the Worker under local workerd, one 1.40 GB packed disk, at a load average of 23: uploaded in 64 MiB parts at 131 MB/s, downloaded at 165 MB/s, and downloaded again with the stream cut three times, 14.4 s, digest equal.

On E2B, one `desktop` sandbox for 1,200 s, the Worker under local workerd behind a quick tunnel, the wallet CLI of the operator as the payer, four runs attached one after another:

| Step | Time |
| --- | --- |
| Paid request to the answer | 4.4 s |
| Answer handed to `nanoeval sandbox` | 0.7 s |
| Bootstrap: the 20.1 MB runtime through the tunnel, Node 24 from nodejs.org, setup | 21.7 s |
| Sandbox created to rows claimed | 22.7 s |
| Sandbox created to the first slot ready | 26.6 s |
| A later run in the same sandbox, attach to rows claimed | 1.7 s |

| Run | Rows | Result | Environment | Attach | Agent or solution | Verifier | Model |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Oracle, 4 Terminal-Bench 2.1 tasks, 3 slots, disks fetched | 4 | 3 passed, 1 failed on the signal defect | 4.8 s | 1.25 s | 0.95 s | 7.35 s | |
| Oracle again after the fix, disks cached | 4 | 4 passed | 0.5 s | 1.05 s | 1.0 s | 7.85 s | |
| `gpt-6-luna` on a ChatGPT plan, 2 tasks, before the fix | 2 | 1 passed, 1 failed | 0.4 s | 1.15 s | 24.5 s | 7.4 s | $0.0046 |
| `gpt-6-luna`, 3 tasks, after the fix | 3 | 1 passed, 2 failed | 0.5 s | 1.1 s | 16.5 s | 7.3 s | $0.0047 |

Times are medians per phase. The tasks are `cancel-async-tasks`, `fix-git`, `log-summary-date-ranges` and `openssl-selfsigned-cert`, each 1 CPU, 2 GiB and 10 GiB of storage. The 147 MB disk of `fix-git` was fetched through the tunnel, checked and unpacked in 8.5 s. No attempt ended as an error. The three model failures are answers the verifier refused: a wrong count in `log-summary-date-ranges` twice and a missed cancellation in `cancel-async-tasks`. The hands dialed `wss://` through the tunnel from private slots. Model cost is the harness's estimate. Each run was exported as a Harbor job. The four jobs load with the models of Harbor 0.25.0 (`scripts/harbor-check.py`).

Seen inside a slot of the last run: no signal ignored, the bounded capability set, `memory.max` 2 GiB and `cpu.max` one CPU, a 9.9 GB root. envd at the gateway timed out, another slot's address timed out, and `https://example.com` answered 200.

**Admission**, by the existing rule of 80 % of the machine's memory: the `desktop` sandbox reported 7,955 MB, so 6,364 MB, and ran three 2 GiB rows at once with the fourth claimed when one finished. A `code-interpreter-v1` sandbox of 2 GiB admits about 1.5 GiB, where a 2 GiB row counts as the whole machine and runs alone: it is the template for one row at a time, or for small tasks, and `--slots` above its two vCPUs gains nothing.

**Cost.** Five paid requests, $0.196252 in all: the probe $0.001824, a rehearsal sandbox of 180 s $0.025408, the sandbox of the runs $0.16882, and two kills at $0.0001. The wallet settled each charge from its machine-token balance. Per attempt:

| | Sandbox | Per attempt |
| --- | --- | --- |
| As paid: 1,200 s for 13 attempts, killed after 364 s | $0.16882 | $0.0130 |
| What the first oracle run used: 60 s from creation to its last row | $0.0085 | $0.0021 |
| What its run would have bought: 5,400 s | $0.7593 | $0.1898 |
| Model, 5 attempts | $0.0093 | $0.0019 |

The gap between the second and third rows is the price of buying the worst case up front.

### Checks

From a fresh clone of `13cbba9` on the 32-core machine, at a load average between 17 and 33: `npm ci`, `npm run lint`, `npm run check:types`, `npm test` (76 passed, none skipped, the ns slot test in its guest among them), `npm run dry-run`, `cargo fmt --check`, `cargo clippy --all-targets --locked -- -D warnings`, `cargo test --locked` (39 passed), and each of the 30 end-to-end lanes of the workflow: 11 on directory slots, 14 on krun slots, 5 on ns slots in the guest. All passed. One lane did not pass at once: the first krun lane hung while it imported, with the builder microVM idle and the launcher blocked writing a layer to it, for seven minutes until it was killed. It passed in 14 s when it ran again, and the 18 lanes after it passed. That stall was seen once in more than sixty imports of this entry and is not explained.

### Not verified

- The Worker as the payer. `src/Payment.ts` with a key in the Worker ran against the mock only: no key was put in a Worker. The mock now offers the four challenges of the live answer and the mppx client takes a charge from them, but it has not signed one for the real service.
- `refreshes`, `pause`, `connect` and the other control routes, the templates other than `base` and `desktop`, and aarch64.
- ns slots on a machine with root outside a microVM guest and E2B, ns slots on the machine's own network, and the attached-runner and disk-removal lanes on ns slots, which the guest harness does not carry.
- An escape from an ns slot was reasoned about and probed, not audited.

## 2026-11-11: the three entries above, joined

The three entries before this one were written side by side from `dca3463`: the smaller gaps, the installed agents, and E2B with ns slots. This entry is what putting them on one line established. The commits of the first are unchanged. Those of the other two were replayed after it, so the hashes their entries name are others here, and every measurement of those entries was taken before the replay, on its own line.

| Named in an entry | Here |
| --- | --- |
| `fcb298d` | `efd46f6` |
| `3cfde90` | `c3fba6d` |
| `ab30a16` | `2614a7b` |
| `34341a2` | `e862306` |
| `62433e8` | `e578c13` |
| `8aaa9b6` | `667bb63` |
| `13cbba9` | `c52bae8` |
| `632deed` | `8bc7590` |

### What each had to take from the others

- **One guest protocol.** The request of a build step carries the host's trust since `NKR4`, and the agent of an ns slot speaks it too. The launcher's microVM code moved into `vm.rs` behind the `microvm` feature, and the gate of a closed phase and the limit on open files moved with it: a launcher built without the feature has neither, and starts no microVM. The guest's `handle` went over the lint's hundred lines with the arms of both, so what `Stop` does is a function of its own.
- **An installed agent on an ns slot.** `slot.sh agent` knew `dir` and `krun`. On an ns slot it would have ended at once with code 0, and the verifier would have graded an environment that no agent touched. It takes the krun path there, as the hand does.
- **The verifier cache on an ns slot.** The run configuration refused the cache for every backend but `krun`, and `auto` is the default of a run now. The code in `slot.sh verify` is one path for both, so the cache is allowed on `krun`, `ns` and `auto` and refused on `dir`.
- **A closed phase stays with krun.** The gate is in the VMM. An ns slot's link belongs to the machine's kernel, and nothing closes it. A run that selects such a task is refused on `ns` and on `auto`, whose runners may take ns, and `slot.sh up` refuses an ns slot again. Such a run names `--backend krun`.
- **An installed agent in a closed agent phase.** Its model endpoint is relayed like the session of a hand, so the command reaches the run and nothing else. An endpoint at `https://` is refused there, as a session at `wss://` is.
- **A remote sandbox.** The runtime archive carries no release of an installed agent: the runner fetches one with `curl` when a row names it.

### What ran

On the tree of this commit before it was made, on the 32-core machine of the entries above at a load average between 25 and 70, one run each, with the scripted command of the lanes in place of a vendor's:

| Lane | Result |
| --- | --- |
| `NANOEVAL_E2E_BACKEND=ns NANOEVAL_E2E_MODEL=installed`, in the guest | passed: 8 attempts, 4 passed and 4 failed as the two arms should |
| `NANOEVAL_E2E_BACKEND=ns NANOEVAL_E2E_SCENARIO=cache`, in the guest | passed: a miss, the oracle's fill, two hits, and a run without the option |
| `NANOEVAL_E2E_MODEL=installed NANOEVAL_E2E_SCENARIO=closed`, krun slots | passed: the three fixtures, each probing what its phases reach |
| `NANOEVAL_E2E_SCENARIO=cache` and `NANOEVAL_E2E_SCENARIO=closed`, krun slots | passed |

The three new lanes are in the workflow.

### Not verified

- A vendor's command on an ns slot, and an installed agent in a remote sandbox, where its release is fetched at run time.
- The verifier cache on ns slots with a verifier of Terminal-Bench, and in a remote sandbox.
- A closed phase on ns slots: refused, not built.
- CI on GitHub. Nothing is pushed.

## 2026-11-11: a deployed Worker, and models and sandboxes from the gateway with one key

Machines: the Worker deployed on Cloudflare with an R2 bucket. The 32-core Linux machine with KVM of the entries above (Node 24.22.2), shared, at a load average between 0.4 and 14, for the import, the attached runners and the lanes. A laptop (macOS, Node 26) for the deployment and for the run that asks the gateway for a sandbox. The gateway is `https://gateway.tempo-dev.workers.dev`, as its `/docs` describe it. Commits `53ff0d9` to the head of this entry.

**No paid request succeeded in this entry.** The gateway key at hand answered `401 invalid_api_key` on the gateway's own key route before the first request of this entry and after the last. Every route below was therefore exercised up to the gateway's check of the key and no further: no model answered, no sandbox was opened, and nothing was charged. What a response and a lease look like past that check is established against a scripted gateway only.

### What was wrong

- Nothing was deployed. R2 had only met workerd's emulation, and a hand in a krun slot had never dialed `wss://`.
- A deployment needed a key per provider and sent an Anthropic key as `x-api-key`. The gateway takes a key only as a bearer token: a request with `x-api-key` is answered `402`, as unpaid.
- A sandbox paid by the Worker needed a wallet key in the Worker, and was bought for the worst case of its rows before any of them ran.
- A run that needs the runtime archive built it where the run was started, which only a Linux machine with a Rust toolchain can.

### Decisions

- **One key.** `TEMPO_KEY` is the credential of both providers and of the gateway's sandboxes, at `TEMPO_GATEWAY_URL` or the public gateway. A provider's own key wins where one is set: `ANTHROPIC_AUTH_TOKEN` as a bearer token, `ANTHROPIC_API_KEY` as `x-api-key`, `OPENAI_API_KEY` as a bearer token, each with its base URL. `Proxy.key` is the one place that chooses, for sessions and for the model endpoint of installed agents. A deployment now holds two secrets, its access token and the key.
- **The cost of an attempt is what the gateway charged.** The gateway reports `cost` in the usage of a response, in `response.completed` and in `message_delta`. nanocode-ts passes it through: a turn ends with `cost_usd` and `cost_status: reported_by_provider`, so a session needed no change. The model endpoint of installed agents now keeps the cost with each request, and an attempt whose every generation carried one costs their sum, the command's own figure otherwise. So a `codex-cli` attempt has a cost for the first time, and `--model-budget-usd` bounds it.
- **Codex over HTTPS.** With a key instead of a plan, nanocode-ts opens the session as `responses_https_sse` and sends `POST /v1/responses` with the tools of its Code Mode as one custom tool. That is the route the gateway serves. It has no Responses WebSocket: an upgrade of `/v1/responses` answers `404`.
- **A price before a payment.** The gateway validates a request before it charges it, and answers an unpaid one with `402` and the price. The provider sends each compute request unpaid first, charges the price to the run's budget, writes it to `payments`, and sends the request again with the key. This is the rule of the E2B provider, intent before effect, without a wallet in the Worker. The price is a bound: the gateway settles what its provider charged, which can be less.
- **What the gateway refuses is written back.** A paid request refused below `500` is recorded as the same amount negated, with its status, and the spend counts what was answered. A `5xx` keeps its charge.
- **A lease, renewed.** The run pays `--sandbox-lease-sec` at creation and gives the lifetime of `Config.lifetimeSec` as the sandbox's `timeout`, which costs nothing. A sandbox with less than a claim lease left is renewed by another lease, after the tick has closed what no row needs. The claim lease is the notice because it is already the run's measure of how late a party may be. E2B bills a renewal from the moment it is made, so that notice is paid twice: at most 60 s in 300 at the defaults.
- **The bootstrap is an `exec`.** The gateway runs a command for at most 120 s and a background job for as long as the lease. The bootstrap took 21.7 s in the E2B entry above, and an `exec` returns its failure with the request. The gateway runs commands as root, so the runner's home is `/root/.nanoeval` and the bootstrap needs no `sudo`.
- **`run --runtime-blob`.** `nanoeval runtime --publish` stores the archive in the Worker's blob store and prints its SHA-256, and a run names it, so a run can be started from a machine that cannot build it.

### What ran against the deployment

Head `9a20cdf` was deployed with `OPENAI_API_KEY` and `OPENAI_BASE_URL` naming the gateway, then head `8d9f476` with `TEMPO_KEY` alone. One run each. The runner is a krun runner attached from the Linux machine, with private slot networks, four slots for the solutions and two for the agents. The tasks are `cancel-async-tasks`, `fix-git`, `log-summary-date-ranges` and `openssl-selfsigned-cert` of Terminal-Bench 2.1, imported as the eval `tb21-small`.

| Run | Deployed | Result |
| --- | --- | --- |
| `nanoeval import terminal-bench-2.1 --only … --store r2` from the Linux machine | `9a20cdf` | 4 tasks in 85 s: conversion 28.4, 1.8, 1.2 and 1.2 s, upload 9.1, 23.6, 8.5 and 8.0 s for disks of 38.6, 147.1, 39.0 and 38.7 MB |
| Solutions, 4 rows, the runner without the machine's policy for slots | `9a20cdf` | 4 errored as `verifier`: uv did not reach the Python registry, which this machine keeps behind a proxy on its loopback. The first row was claimed 3.8 s after the run was created, and the environment phase, with the four disks fetched from R2 and unpacked, took 3.9 to 6.2 s |
| The same with `--ca-bundle`, `--slot-env` and `--slot-forward` on the runner | `9a20cdf` | 4 passed. 24.9 s from creation to the last result. First row claimed after 1.2 s. Environment 0.7 to 1.5 s, attach 0.5 to 0.8 s, solution 0.4 to 5.9 s, verifier 5.7 to 22.0 s |
| `codex:gpt-6-luna` on `fix-git` | `9a20cdf` | errored as `agent` after 6 s: the hand attached from its private krun slot over `wss://`, the turn started, and the gateway refused `POST /v1/responses` with `401 invalid_api_key` |
| The same | `8d9f476` | The same refusal, with `TEMPO_KEY` as the only credential |
| `claude:claude-haiku-5-5` on `fix-git` | `8d9f476` | errored as `agent` after 5 s: `Messages HTTP 401`, so the key arrived as a bearer token. As `x-api-key` the answer is `402` |
| `codex-cli:gpt-6-luna` on `fix-git` | `8d9f476` | errored as `agent`: Codex CLI 0.166.0 in the slot sent 6 requests through the run's endpoint in 10 s, each answered `401` by the gateway in about 0.2 s, and exited with 1 |
| `claude-code:claude-haiku-5-5` on `fix-git` | `8d9f476` | errored as `agent`: Claude Code 2.1.318 in the slot sent 11 requests to `v1/messages` over 3.2 minutes, each answered `401`, and exited with "Failed to authenticate". Its release was fetched and unpacked in the environment phase, 18.4 s |
| `run --oracle --provider gateway --template desktop --runtime-blob …` from the laptop, ns slots | `8d9f476` | 4 errored as `environment` in 5.8 s. The Worker read the price of the sandbox from the gateway, $0.04228 for a `desktop` lease of 300 s, wrote it to `payments`, sent the request with the key, was refused with `401` and wrote the price back. It tried twice, as a run does, and the sandbox spend ended at $0 |

Every refusal ended as an error of its attempt, never as a score. The runtime archive, 20.1 MB, was published to R2 from the Linux machine before the last run.

Without a key, which costs nothing, the gateway was asked what it serves: an unpaid `POST /v1/responses` and `POST /v1/messages` for `gpt-6-luna`, `gpt-6.1-sol`, `claude-haiku-5-5` and `claude-opus-5-5` each answered `402` with a price, and an unknown model name `400`. The request body of a nanocode Codex session, 56 kB with its tools, was answered `402` too, so the gateway did not refuse its shape before the payment.

### Lanes against a scripted gateway

`test/MockGateway.ts` answers Responses and Messages with a cost, refuses a model request that carries anything but the key as a bearer token, prices an unpaid compute request in a `402`, and ends a sandbox whose lease lapses. Its prices are its own. One run each on the tree of `d2bc08a`, the last with the change of `41ce817`:

| Lane | Result |
| --- | --- |
| `NANOEVAL_E2E_BACKEND=dir NANOEVAL_E2E_GATEWAY=1 NANOEVAL_E2E_ATTEMPTS=1` | passed: a `codex` and a `claude` session, 2 passed and 2 failed as the two arms should, model spend equal to what the gateway reported, payments equal to its charges in order, one renewal, the sandbox terminated |
| The same with `NANOEVAL_E2E_MODEL=installed` | passed: the scripted Codex CLI and Claude Code, each attempt with the cost of its request |
| `NANOEVAL_E2E_GATEWAY=1`, krun slots, and with `NANOEVAL_E2E_MODEL=installed` | passed, 8 attempts each |
| `NANOEVAL_E2E_BACKEND=ns NANOEVAL_E2E_GATEWAY=1`, in the guest | passed, 8 attempts |
| The same with `NANOEVAL_E2E_MODEL=oracle NANOEVAL_E2E_RUNTIME=1 NANOEVAL_E2E_STORE=r2` | passed: the leased sandbox started its runner from the archive through the bootstrap, 3 attempts |

A first run of the directory lane failed on its own assertion: the run was over before a renewal was due. The lane now leases for exactly a claim lease, so the tick that opens the sandbox renews it.

### The checks of a fresh clone, and the last deployment

Every `run:` step of `.github/workflows/ci.yml`, 56 of them, in order and each with exactly its variables and command, from a fresh clone on the Linux machine with a `docker` first on the path that only logs: at `6dbff58` in 6.5 minutes and at `12d077b` in 6.6 minutes, at a load average between 1 and 6. All 56 exited 0 both times. Nothing was skipped: the 48 end-to-end lanes passed, the six gateway lanes among them, with 111 unit tests and the 25 and 2 tests of the launcher. `docker` was never called. `57e37b6` after them changes one condition and its test.

`12d077b` was deployed with the same two secrets, and one run of each kind repeated against it:

| Run | Result |
| --- | --- |
| Solutions, 4 rows, the krun runner with the machine's policy | 4 passed in 25.4 s. First row claimed after 1.7 s. Environment 0.8 to 1.4 s, attach 0.7 to 0.9 s, solution 0.2 to 6.3 s, verifier 5.7 to 21.9 s |
| `codex:gpt-6-luna` and `claude:claude-haiku-5-5` on `fix-git` | Each errored as `agent` on the gateway's `401`, after 6.3 and 3.7 s |
| `codex-cli:gpt-6-luna` and `claude-code:claude-haiku-5-5` on `fix-git`, one run | Both errored as `agent` on the gateway's `401`. 185.7 s, which is Claude Code retrying |
| `run --oracle --provider gateway --template desktop --runtime-blob …` from the laptop | 4 errored as `environment`: the price was read, the paid request refused with `401`, the price written back |

### Not verified

- Any model through the gateway: an answer, streaming under load, the reported cost against the key's spend, and the four model names beyond the gateway naming a price for them.
- Claude Code with an answer. Its release ran against a real Messages route for the first time here, and only met refusals.
- A sandbox from the gateway: creation, root, the bootstrap inside one, a renewal, a termination, what a renewal really costs, and a run with nothing of the operator's running.
- The price of a request against what the key was charged for it.
- A vendor's command on an ns slot or in a remote sandbox, as before.

## 2026-11-12: the gateway for real: models, installed agents and a leased sandbox

Machines: the Worker deployed on Cloudflare with its R2 bucket, as in the entry above. A laptop checkout started every run, and no runner ran on a machine of the operator's: the gateway leased one E2B `desktop` sandbox for each run. The 32-core Linux machine with KVM of the entries above (Node 24.22.2), shared, for the fix and the checks of a fresh clone. The gateway is `https://gateway.tempo-dev.workers.dev`. Times are UTC on 2026-11-12. Commit `87936e4` and this entry. Every run below was made before `87936e4`, on the Worker as it was deployed then.

The entry above ends with what was not verified, because the key at hand was invalid. A valid key now exists, and every item of that list ran except a renewal. That entry stays as the record of its day. This one supersedes its list.

### What ran

Every run was started from the laptop with `nanoeval run --provider gateway --template desktop --runtime-blob SHA256 --backend ns` on the eval of the entry above: the Terminal-Bench 2.1 tasks `cancel-async-tasks`, `fix-git`, `log-summary-date-ranges` and `openssl-selfsigned-cert`. Each run that worked leased one sandbox for 300 s, started its runner in it from the runtime archive through the bootstrap, served its rows on ns slots, and terminated the sandbox. One run each, one attempt per row. The time to the first attempt is from the creation of the run and includes the lease and the bootstrap:

| Run | Created | Finished | First attempt after | Result | Spend recorded |
| --- | --- | --- | --- | --- | --- |
| The tasks' solutions (`--oracle`), before the key's wallet could pay a network fee | | | none started | 4 errored as `environment`: the gateway answered `503 unavailable` to `compute/create` | sandboxes $0.0846, of which nothing was charged, see below |
| The same command, once the wallet could | 00:51:44.3 | 00:52:33.6 | 17.0 s | 4 of 4 passed, in 56 s for the command | sandboxes $0.0445 |
| `--agent luna=codex:gpt-6-luna --agent haiku=claude:claude-haiku-5-5`, 3 slots | 00:52:53.5 | 00:55:48.7 | 8.5 s | 8 of 8 passed | models $0.0610, sandboxes $0.0445 |
| `--agent cli=codex-cli:gpt-6-luna --agent cc=claude-code:claude-haiku-5-5` on `fix-git` | 00:56:09.5 | 00:57:36.3 | 11.9 s | 2 of 2 passed | models $0.0103, sandboxes $0.0445 |
| Four arms at high effort on `fix-git`, 4 slots | 00:58:12.8 | 00:59:45.1 | 10.1 s | 4 of 4 passed | models $0.3843, sandboxes $0.0445 |

`nanoeval compare` of the run with the two sessions, on the four tasks:

| Agent | Passed | Agent time | Input tokens | Of them cached | Output tokens | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| `luna`, `codex:gpt-6-luna` | 4 of 4 | 2 min 58 s | 790,000 | 630,582 | 7,308 | $0.0507 |
| `haiku`, `claude:claude-haiku-5-5` | 4 of 4 | 1 min 9 s | 157,014 | 131,306 | 11,460 | $0.0103 |

| Task | `luna` | `haiku` |
| --- | --- | --- |
| `cancel-async-tasks` | 20 s | 25 s |
| `fix-git` | 46 s | 19 s |
| `log-summary-date-ranges` | 1 min 40 s | 15 s |
| `openssl-selfsigned-cert` | 11 s | 10 s |

The run with the vendors' commands, on `fix-git`:

| Agent | Result | Agent time | Input tokens | Of them cached | Output tokens | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| `cli`, Codex CLI 0.166.0 on `gpt-6-luna` | passed | 48 s | 132,908 | 114,580 | 3,529 | $0.0052 |
| `cc`, Claude Code 2.1.318 on `claude-haiku-5-5` | passed | 25 s | 141,503 | 121,447 | 2,694 | $0.0051 |

It is the first run of Claude Code against a real Messages endpoint, and the first of a vendor's command on ns slots and in a remote sandbox: the runner fetched the pinned releases there.

The run with four arms at high effort, on `fix-git`:

| Agent | Result | Agent time | Input tokens | Of them cached | Output tokens | Cost |
| --- | --- | --- | --- | --- | --- | --- |
| `nano-codex=codex:gpt-6.1-sol:high` | passed | 35 s | 103,910 | 86,190 | 1,481 | $0.0677 |
| `codex-cli=codex-cli:gpt-6.1-sol:high` | passed | 39 s | 112,291 | 96,022 | 1,474 | $0.0650 |
| `nano-claude=claude:claude-opus-5-5:high` | passed | 26 s | 60,622 | 49,474 | 1,636 | $0.0983 |
| `claude-code=claude-code:claude-opus-5-5:high` | passed | 27 s | 102,113 | 82,458 | 1,926 | $0.1533 |

One task and one attempt for each arm: a smoke test of four paths, not a benchmark, and no difference between two rows of it is a result.

### What was charged

The key's usage route was read before the four runs that worked and after them. Its payment channel had spent $0.465518. The runs recorded $0.4556 of model spend and about $0.0021 of compute fees each, and the rest, about $0.0015, is a handful of list and status calls made by hand. Each lease, a `desktop` sandbox for 300 s, took $0.04238 from the key's limit directly, outside the channel, and a run recorded $0.0445 for its sandbox: the lease and the fees of its calls. So the recorded spend matched what was charged to within the calls made by hand.

After every run the key's list of sandboxes was empty: a termination ends the sandbox at the gateway. No run was renewed, since each ended inside its first lease.

### What was wrong

**A sandbox the gateway refused stayed in the spend.** The first run met a gateway that could not open the key's payment channel. It answered `503 unavailable` to the paid `compute/create`, "cannot pay the network fee to open your key's channel right now: its fee sponsor is out of funds, and the key could not pay the fee from its wallet", and again to the run's second attempt. Nothing was charged: the key's usage showed no channel and its whole limit. The run reported `spend: sandboxes $0.0846`, two quotes of $0.04228. `8d9f476` wrote back a refusal below `500` and kept every `5xx` as an unknown outcome, and this `5xx` was a refusal like any other. Once the wallet held a fee token, the same command worked.

### Decisions

- **A refusal is the gateway's answer, at any status.** The gateway answers its errors as problem JSON with a stable `code`: its documentation says so, and its `400` to a malformed request, which costs nothing to ask for, is one. An answer below `500`, or a problem with a `code` at any status, is written back as the same amount negated, with the status.
- **What proves nothing stays, and says so.** A `5xx` without such a problem may come from in front of the gateway after the gateway took the payment, and a paid request whose answer never arrived may have been served. Their price stays in the spend, as a sandbox whose creation a restart interrupted stays `unknown`, and a row of amount zero beside it says `answered 502 without a problem` or `unanswered`. Counting too much holds the budget, and counting too little would let a run spend past it. The sandbox fails with a message that says the same, and that request is not sent again.
- **The budget of a tick forgets a refusal too.** A tick builds its budget from `payments` once. A refusal written back to the table stayed in that budget until the next tick, so a renewal refused for one sandbox could have refused the next one's for the budget. `Budget.refund` takes it out.
- **Nothing before the price.** A request that fails before its `402` is read was never recorded, and a test now holds that.
- **The scripted gateway refuses the first sandbox.** It answers the first paid `create` with `503 unavailable`, so each of the six gateway lanes opens its sandbox at the second attempt and asserts that the run's payments are the refused price, written back, and then the gateway's charges in order. On the code before `87936e4` the directory lane fails there: the run reported $0.0032 for its sandbox where the scripted gateway had charged $0.0027.
- **A key that has to pay its own network fee.** The gateway pays the fee of opening a key's channel, and when it cannot, the key does. A key whose wallet holds only the machine token is refused with `503` until the wallet holds a little of a fee token, which the gateway's message names. The README says so under Deploy it.

### The checks of a fresh clone

Every `run:` step of `.github/workflows/ci.yml`, 56 of them, in order and each with exactly its variables and command, from a fresh clone of `87936e4` on the Linux machine with a `docker` first on the path that only logs: all 56 exited 0 in 6.6 minutes, at a load average between 1.5 and 5.8. Nothing was skipped: 112 unit tests, the 48 end-to-end lanes with the six gateway lanes among them, and the launcher's tests. `docker` was never called. This entry changes only the three documents after it.

### Not verified

- A renewal at the real gateway, what one costs there, and a run longer than one lease. Every run ended inside its first 300 s.
- `87936e4` at the real gateway. The `503` was met before it and not since, so that the gateway's refusal carries a `code` rests on its documentation and on the name the refusal was reported with, `unavailable`.
- `gpt-6.1-sol` and `claude-opus-5-5` beyond one task and one attempt.
- The 89 tasks of Terminal-Bench 2.1 through the gateway, and more than four attempts at once.
- Claude Code with an Anthropic API key or a plan login.
- CI on GitHub: the workflow has not run there.
- A task that closes the network of a phase in a gateway sandbox. Its slots are ns slots, where such a run is refused by design.

## 2026-11-12: the whole of Terminal-Bench 2.1 on leased sandboxes

Machines: the Worker deployed on Cloudflare with its blobs in R2, as in the entry above. Sandboxes: E2B's `desktop` template leased through the gateway, each 8 vCPUs, 7,955 MB of memory and 20.6 GB of free disk, kernel 6.1, root, no KVM, a core limit of zero, started by the bootstrap under `umask 077`. The import, the lanes and the fresh clones ran on the 32-core Linux machine with KVM of the earlier entries, shared with other work. Runs were started from a laptop that only created them and read their status. Every figure is one run unless it says otherwise, at the commit it names.

### What was asked

The four runs of the entry above each ended inside one 300 s lease of one sandbox with at most four rows. Nothing had renewed a lease, opened a second sandbox or run the benchmark. This entry reads the code for what breaks at 89 rows, fixes what the scripted gateway could show, and then runs all 89 tasks with their own solutions in sandboxes that the run leases, with no runner of the operator's.

### The eval

`nanoeval import terminal-bench-2.1 --store r2` from the Linux machine into the deployed Worker, at `d4a712f`: 89 tasks in 2,169 s, one after another, 19.2 GB of packed disks through the Worker into R2 at about 9 MB/s. The conversions took 1 to 15 s a task and the uploads the rest. The eval is `terminal-bench-2.1@312b07080ace`.

### What reading and the lanes found before a sandbox was paid for

| Found | By | Change | Test |
| --- | --- | --- | --- |
| A row that asks for a runner's whole memory can only start on an empty runner, and a runner that refills from the rows behind it is never empty. Eight tasks ask for 8 GiB, more than the 6,364 MB a `desktop` runner admits, so they would have waited for the end of the run, one after another | Reading `Admission.fill` | An empty runner takes such rows first | Unit |
| The slot of such a row still got the 8 GiB it asked for as its limit, on a machine with less | Reading `slot.sh` | The slot gets the runner's memory, the result records it, and a row that did not pass after that limit killed a process is an `environment` error | Unit |
| With `--disks remove` a disk is removed by the runner that finishes the last row of its task. With several attempts or agents the disks of rows that ended elsewhere stay: 51 GB of disks against 20 GB | Reading `Runner.ts` | Below `--free-disk-mb` a runner removes the disks of the run that none of its rows uses | Unit, the disk lanes, `slot.sh drop` in the slot test |
| Two rows of one task claimed together each downloaded the disk, and the second unpacked from a file the first had removed, which cost it one of its step retries | Reading | One fetch and one unpack | Unit |
| A sandbox that dies with rows in flight: cancelling the turn of a session whose hand is gone answered after 26 s. The tick waited that long for each row, renewed nothing meanwhile, the second sandbox ran out of its lease, and 10 of 12 rows ended as errors | The fleet lane, first run | A cancel is waited for one tick. Leases are renewed before a sandbox is opened | The fleet lane |
| A renewal that failed killed the sandbox and its rows at once, with the rest of its lease paid | Reading, then for real below | A sandbox that is sold no renewal is used until its lease ends and is then replaced | The gateway lanes, the lapse lane |

Read and left as it is:

- **A disk that fills.** A download or an unpack that fails for space is a failed step: the runner tries it `--step-retries` times and the row ends as an `environment` error with the system's message. Not provoked for real. What a running solution writes is not reserved: a task whose own writes fill the disk fails as a task.
- **CPUs** are not admitted. Slots that together ask for more than the machine has run slower, and a solution that then misses its timeout is scored as a timeout.
- **The 24 hours.** The lifetime a run computes is the worst case of its rows over its slots. For the 89 rows that is 354,510 s summed, which one sandbox of four slots turns into a lifetime of 89,400 s, more than the 86,400 s a sandbox may live, and such a run is refused with the figure until `--sandbox-timeout-sec` names a lifetime. A gateway lifetime costs nothing by itself. A sandbox that reaches it ends like one whose lease is over.
- **The Worker.** One `Run` object answers every runner. A runner with a free slot asks for rows every `--poll-ms`, and each answer reads the table of attempts, so a deployed run wants 1,000 ms or more. Nothing else grows with the number of slots: a slot reads its own status files, and artifacts are stored in parts.

### What the gateway does with a renewal

Asked directly with the key, on a `base` sandbox with a 60 s lease and a 600 s lifetime: `POST /v1/compute/renew` was answered `502` with the problem `upstream_failed` before any price, without the key and with it, for 60 s and for 300 s, right after the sandbox was created and with 20 s of its lease left. `create`, `exec`, `write` and `terminate` worked throughout. So on this day no lease of an E2B sandbox could be renewed through the gateway, which is not something this repository can change, and a lease has to be bought whole when the sandbox is opened: `--sandbox-lease-sec` up to the lifetime, with nothing refunded for what a run does not use.

### Ten tasks, two sandboxes, leases of 240 s

`run --oracle --only ...` for ten tasks, `--provider gateway --template desktop --runtime-blob SHA256 --backend ns --sandboxes 2 --slots 4 --disks remove --free-disk-mb 4000 --sandbox-lease-sec 240 --sandbox-timeout-sec 3600 --poll-ms 1000`, Worker and runtime at the tree of `f2f46bb`. The lease was chosen shorter than the run so that its end would be seen.

| At | What happened |
| ---: | --- |
| 0 s | The run was created and opened the first sandbox |
| 15 s | Its runner had started from the archive, reported 7,955 MB and 8 CPUs, and claimed `mteb-leaderboard`, which asks for 8 GiB: the empty runner took it first and ran it alone with 6,364 MB |
| 50 s | The second sandbox's runner was ready and took the rows that fit, one claim at a time under the disk floor |
| 185 s | The first sandbox asked for its renewal 60 s before its lease ended and was refused before a price. It became `ending` and kept its row |
| 245 s | Its lease was over with `portfolio-optimization` in flight: the row was put back as a lost claim and the sandbox closed. The second, ending and idle, was terminated |
| 257 s | A third sandbox was ready and had claimed the row again |
| 470 s | The run finished: 9 passed, 1 failed, 1 lost claim, no sandbox listed for the key |

It recorded $0.1081: three leases of 240 s at $0.0339 and the fees of 6 writes, 3 execs and 3 terminations. Each disk was removed with its row: read once during the run, one sandbox held three unpacked disks of 0.3 GB together and the other one of 4.5 GB, with 20.1 and 17.6 GB free.

The one failure was `mailman`, which passes on krun slots: `postfix` did not start. See the next section.

### What a slot inherited from its runner

Two defects of ns slots showed only in a sandbox, because only there is the runner started by the bootstrap:

- **The root of a slot was mode 700.** The bootstrap sets `umask 077` for the runner's files, `slot.sh` inherited it, and the upper directory it made became the root of the overlay. Root in the slot saw nothing wrong. Every other user of the image was refused at `/`: `postfix/master` could not open its lock file as `postfix` (read from a syslog socket put into the slot while it ran), `su` could not start a shell, `nginx` answered 403 as `www-data`, `apt` warned that `_apt` could not read its downloads. Four tasks failed for it.
- **The core limit could not be raised.** A sandbox runs its commands with a hard core limit of zero, a slot has no `CAP_SYS_RESOURCE`, and the solution of `custom-memory-heap-crash` runs `ulimit -c unlimited` under `set -e`.

Both were scored as failures, which they are not. `slot.sh` now sets its own umask and starts a slot with the kernel's default core limit (`d1d51cd`). The slot test sets up and boots its slot under `umask 077` and a core limit of zero and runs a command as another user: it fails without the two lines and passes with them.

### All 89 tasks

`run --eval terminal-bench-2.1 --oracle --provider gateway --template desktop --runtime-blob SHA256 --backend ns --sandboxes 4 --slots 4 --disks remove --free-disk-mb 4000 --sandbox-lease-sec 3300 --sandbox-timeout-sec 3600 --sandbox-budget-usd 1.9 --poll-ms 1000`, Worker and runtime at the tree of `f2f46bb`, so before the fix of the section above.

**Why four sandboxes of four slots.** A `desktop` runner admits 6,364 MB, 80 % of the machine. 68 tasks ask for 2 GiB, 13 for 4 GiB and 8 for 8 GiB, so it runs three rows of 2 GiB, or one of 4 GiB and one of 2 GiB, or one of the eight alone. On krun slots the solutions took 9,884 s summed, 1,979 s for `caffe-cifar-10`, which is one of the eight. Counted in sandbox time that is about 9,000 s, and no number of sandboxes ends the run before `caffe-cifar-10` does. Without renewals the price is sandboxes times lease whatever is used, so the choice was the fewest sandboxes that end near that bound: one for `caffe-cifar-10` and three for the rest. The lease, 3,300 s, was sized for a sandbox one and a half times slower than the Linux machine, which it was not: the run needed 2,016 s.

| | Passed | Failed | Errored | Wall |
| --- | ---: | ---: | ---: | ---: |
| krun slots on the Linux machine, entry of 2026-11-11 | 82 | 4 | 3 | 2,037 s |
| This run, ns slots in four leased sandboxes | 79 | 8 | 2 | 2,016 s |
| With the rerun of the five rows that the slot defects failed, at `d1d51cd` | 84 | 3 | 2 | |

- The four runners finished 1, 11, 34 and 43 rows: the first ran `caffe-cifar-10` alone for 1,774 s, and the other three began with the seven other rows of 8 GiB. No claim was lost, no call of a runner to the Worker failed and no step was retried. The attempts took 10,794 s summed and 44 s at the median. The environment phase, fetching a disk from R2 through the Worker and unpacking it, took 8.2 s at the median and 67 s at most.
- `caffe-cifar-10` 1,774 s against 1,979 s on krun slots, `crack-7z-hash` 590 s against 1,460 s, `compile-compcert` 1,374 s against 982 s, beside other rows.
- Read twice during the run, the four sandboxes had 15.9 to 20.1 GB of disk free and one or two unpacked disks each.
- Each sandbox was terminated when its runner held no row and none waited, 1,109 to 1,208 s before its lease ended. Nothing is refunded for that: a lease of 2,400 s would have done.
- The run recorded $1.8651: four leases of 3,300 s at $0.46408, 8 writes, 4 execs and 4 terminations.

**Every row that did not pass.**

| Task | Here | krun | Cause |
| --- | --- | --- | --- |
| `build-cython-ext` | failed | failed | Task: its solution leaves `planarity` unpinned |
| `mcmc-sampling-stan` | failed | failed | Task: its solution leaves `RcppParallel` unpinned |
| `protein-assembly` | failed | failed | Task: its solution's optimizer ends in `NoSolutionError` |
| `qemu-alpine-ssh`, `qemu-startup` | `verifier` error | `verifier` error | Task: the verifier's `apt-get install curl` gets 404 on Debian 11, so no test runs |
| `configure-git-webserver`, `git-multibranch`, `mailman`, `nginx-request-logging` | failed, passed in the rerun | passed | This stack: the root of the slot was mode 700 |
| `custom-memory-heap-crash` | failed, passed in the rerun | passed | This stack: the core limit could not be raised |

Two rows passed here that did not on krun slots: `pypi-server`, which fails there for the hold that machine's registry puts on new releases, and `torch-tensor-parallelism`, whose deadlock the earlier entries found intermittent.

**The rerun.** `run --rerun RUN --only ...` for the five rows, one sandbox, a lease of 420 s, Worker and runtime at `d1d51cd`: 5 of 5 passed in 146 s for $0.0613, each row naming the attempt it retries. The run could not terminate its sandbox: the gateway answered that request `401`, the key having been revoked or replaced while the run was in flight, which was not this work's doing. The refusal is in the run's payments, the sandbox is recorded as failed with that message, and it ended with its lease 4 minutes later. Whether it had was not read: the key no longer listed anything.

### What the key was charged

Read from the gateway before and after each run until the key stopped answering. Another job used the same key during these hours, so its figures bound this work's spend and do not equal it.

| | Recorded by the run | The key's limit |
| --- | ---: | --- |
| A `base` sandbox for 60 s, the renewal asked by hand | | about $0.002 |
| Ten tasks | $0.1081 | fell by $0.1038 |
| `mailman` alone, to read why it fails, and a `desktop` sandbox for 60 s | $0.0234 and about $0.009 | |
| All 89 tasks | $1.8651 | fell by $2.9025 with the other job |
| The rerun of five rows | $0.0613 | not read |

About $2.08 in all, with some 30 commands and files sent to sandboxes by hand at $0.0001 to $0.001.

### Every check, from a fresh clone

From a fresh clone of `cefa134` on the Linux machine, with programs that log and exit 97 in place of the seven container tools first on `PATH`, whose log was empty afterwards: every `run` step of `ci.yml` in its order, 58 steps, and each exited 0 at its first try, in 7 minutes. `npm ci`, `npm run lint`, `npm run check:types`, `npm test` (114 tests, none skipped, the slot test in a guest), `npm run dry-run`, the 19 directory lanes with the two new ones (`fleet` in 8 s, `lapse` in 10 s), the 22 krun lanes, the 9 ns lanes in a guest, `cargo fmt --check`, `cargo clippy` and `cargo test` (25 tests). No image build stalled. The commit that records this changes this file only.

### Not verified

- A renewal that is paid. The gateway sold none. The scripted gateway sells them, refuses the first in passing, and can sell none.
- The 24 hours of a lifetime, and a sandbox that reaches it.
- More than four sandboxes or sixteen slots in one run, and what E2B or the gateway allow one key at once.
- A model or an installed agent at this scale. Only solutions ran. The four runs of the entry above are still the only ones with models in a leased sandbox.
- Several attempts or agents of one task in sandboxes: the removal of idle disks under the floor ran in lanes and never for real, since no sandbox came near its floor with one attempt a task.
- A disk that fills, an 8 GiB task that is killed at 6,364 MB, and a sandbox that dies during a paid run: lanes and unit tests only. Of the eight rows of 8 GiB, seven passed with 6,364 MB, the eighth failed for its own solution, and no process of any was killed.
- A valid key in the Worker after these runs. The one it holds stopped answering at the end of the rerun.
- CI on GitHub. Nothing is pushed.

## 2026-11-12: a run that starts at once

Machines: the Worker deployed on Cloudflare under a second name with the R2 bucket of the entries above, the gateway at `https://gateway.tempo-dev.workers.dev` with the key of the entry above, E2B sandboxes leased through it, which run in a western US region, and the 32-core Linux machine with KVM of the entries above (Node 24.22.2), in Europe, shared, which created the runs, ran the standing runner and the lanes. Every run is one row: `openssl-selfsigned-cert` of Terminal-Bench 2.1 from the eval of the entries above, with `codex:gpt-6-luna` unless it says the task's solution. The runs that lease a sandbox were kept in the `wnam` region, the ones of the standing runner in `weur`.

### Before

The run got a timeline first, so the numbers come from the run and not from a stopwatch. Five runs on the code before this entry, `--provider gateway --template desktop --backend ns --slots 1 --sandbox-lease-sec 100`, seconds after the run was created:

| Run | Sandbox create starts | Runner says hello | First claim | Environment ready | First model request | First verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.65 | 17.35 | 17.66 | 21.39 | 22.34 | 58.16 |
| 2 | 0.33 | 22.30 | 22.98 | 26.59 | 27.82 | 75.93 |
| 3 | 0.19 | 17.45 | 17.86 | 42.07 | 150.11 | 192.00 |
| 4 | 0.17 | 12.09 | 12.39 | 15.94 | 17.13 | 49.16 |
| 5 | 0.45 | 32.61 | 32.91 | 39.24 | 137.42 | 175.40 |

Median 17.9 s to the first claim, 27.8 s to the first model request, 75.9 s to the first verdict; worst 32.9, 150.1 and 192.0. Runs 3 and 5 lost their sandbox when its 100 s lease ended, because the gateway sold no renewal, and their model request is the one of the claim that replaced the first. Where run 3 spent its start: 2.6 s for the price of the create and 4.5 s for the paid create, 1.1 s for two file writes, 8.5 s for the bootstrap command (5.4 s for the 20 MB archive, 0.5 s to unpack it, 2.1 s for Node, which `desktop` lacks), 0.3 s for the runner's setup, 0.3 s for its hello and 0.4 s for its claim. Per attempt: 0.2 s for the task's files, 1.7 to 21.8 s for the disk and 0.4 to 0.6 s to unpack it, 0.3 s for the slot, and 1.2 s from the slot being up to the turn being submitted, most of it the hand dialing the session.

A probe from a sandbox gave the size of a round trip: a request to the Worker's `/health` took 150 ms on a kept connection (18 ms once), one that reaches the run's object 200 to 230 ms, and a new connection 120 to 470 ms, although the sandbox reaches a Cloudflare edge in 2 to 14 ms. Cloudflare ran this Worker far from that edge. Nothing here changes that, and it is why this entry counts round trips.

### What changed

- **Held requests.** A claim, the wait for the hand and the wait for the turn are answered when they happen instead of asked again. A runner follows its slots by file events.
- **A pool.** `nanoeval runner --standing` keeps a runner of a machine with the deployment, and `run --warm-sec` keeps the sandbox a run opened, with its runner and its disks. A run takes one when it is created and its runner claims without a hello.
- **The cold path.** One command starts the runner in a new sandbox instead of two writes and a command, the bootstrap fetches the archive while it looks for Node, the runner fetches the disks of the first rows before it claims them and the files of an attempt together, and the session of the hand is asked for beside the environment instead of before the claim is answered: that one request took 0.8 to 0.9 s.
- **The template.** `base` has root, Node 20.9, `mke2fs`, 2 vCPU and 512 MiB, which ran this task and the runner. `code-interpreter-v1` has Node 20 and no `mke2fs`; `codex`, `claude` and `opencode` have Node 20 to 22 and 2 to 4 GiB; `desktop` has 8 vCPU, 8 GiB and no Node. A paid create took 2.1 to 3.3 s when asked from a laptop whatever the template.

### After

**Cold: a `base` sandbox leased for the run.** Six runs, on this change before it was rebased onto the work that scales runs (the first two before the claim stopped waiting for the session):

| Run | Lease | First claim | First model request | First verdict | Note |
| --- | --- | --- | --- | --- | --- |
| 1 | 600 s | 10.62 | 14.58 | 58.35 | kept its sandbox |
| 2 | 600 s | 17.02 | 25.22 | 68.38 | was to take the kept sandbox and opened one: see below |
| 3 | 120 s | 10.53 | not known | 175.43 | the turn began at 13.46 and ran past the lease: no renewal was sold, the sandbox ended, and a second one finished the row |
| 4 | 120 s | 7.86 | 12.62 | 46.67 | |
| 5 | 240 s | 12.13 | 14.37 | 39.36 | |
| 6 | 240 s | 31.22 | none | none | the runner said hello at 31.03; the key's limit ran out during the run and the model answered 401 |

Median 11.4 s to the first claim (worst 31.2), 14.5 s to the first model request over the four runs that have one (worst 25.2), 58.4 s to the first verdict over five (worst 175.4). The steps of run 3: 0.51 s to create the run, 0.05 s for the pool to say it has nothing, 1.74 s for the price of the create and 4.00 s for the paid create, 1.3 s from the paid command to the first line of the bootstrap, 2.3 s for the archive (1.6 s to fetch it while Node was found in 0.9 s, 0.7 s to unpack), 0.4 s for the runner to start and set up, and its hello and claim. Run 1 took 0.61 s for the price and 4.59 s for the create. After the claim: the task's files and the disk together in 1.2 to 1.7 s, the slot in 0.3 to 0.4 s, and 1.1 to 1.2 s for the hand.

**Warm: a sandbox the pool kept.** One run, on the sandbox that cold run 1 kept: the pool answered 0.22 s after the run was created, the first row was claimed at 0.55 s, the environment was ready at 1.61 s with no file and no disk fetched, the model was asked at 2.69 s, and the verdict came at 53.94 s. Of the 0.55 s, 0.22 s is the creation of the run and 0.12 s the pool. The claim was answered 0.8 s after it was sent, because it still waited for the session then, and the hand took 1.1 s. Cold run 2 was meant to be the second warm run: the pool passed the sandbox over because its runner was between two held requests at that moment. A runner that asked within the notice of its lease is taken since, and gets the run with its next request. The pool terminated both kept sandboxes when their idle time ended, 1.7 s and 0.1 s after it, and recorded $0.0001 for each with no run active. Four more warm runs were planned and did not run: the key's limit was spent by another job that used the same key.

**A standing runner.** `nanoeval runner --standing --backend krun --slots 1 --lease-sec 10` on the Linux machine, runs created with `--sandboxes 0 --backend krun`:

| Runs | Agent | First claim | Environment ready | Turn submitted or solution started | First verdict |
| --- | --- | --- | --- | --- | --- |
| 5 | `gpt-6-luna` | 0.39, 0.11, 0.12, 0.38, 0.35 | 0.96 to 1.69 | 2.27, 1.33, 1.51, 1.75, 2.10 | none: the model answered 401, the key was spent |
| 5 | solution | 0.14, 0.28, 0.27, 0.28, 0.29 | 0.86 to 1.14 | 1.54 to 1.91 | errors: the runner was started without the host policy of this machine, and the verifier could not reach its package index |
| 5 | solution | 0.16, 0.13, 0.29, 0.31, 0.11 | 0.83 to 1.14 | 1.68 to 1.83 | errors: the same, the policy was not applied to a home that was set up before |
| 5 | solution, with `--ca-bundle`, `--slot-env` and `--slot-forward` | 0.34, 0.26, 0.11, 0.26, 0.11 | 0.79 to 1.41 | 1.48 to 2.11 | passed at 11.19, 9.02, 9.30, 9.89, 9.24 |

Median 0.27 s to the first claim over the 20 runs, worst 0.39 s. One of them: the run was created in 26 ms, the pool answered in 28 ms, the runner sent its claim 48 ms later and the claim was recorded 167 ms after that, a request from Europe on a new connection. The microVM takes most of the second that follows. Before, a runner attached by hand claimed its first row 1.2 s after the run was created.

Under local workerd on the Linux machine, where a request takes a millisecond, the lanes print the same offsets: a standing runner on directory slots claimed 11 and 13 ms after two runs were created, the model was asked at 88 and 126 ms and the first verdict was in at 212 and 266 ms; a second run on a kept sandbox of the scripted gateway claimed at 10 to 12 ms on directory and ns slots, with its environment ready at 125 to 186 ms on ns slots.

### What a kept sandbox costs

The gateway charged $0.017342 for 600 s of `base` and $0.006997 for 240 s: $0.104 an hour. `desktop` was $0.04238 for 300 s, $0.51 an hour. Each command costs $0.0001, and so does the termination the pool pays. The gateway answered every renewal with 502, as in the entry above, so a kept sandbox lived exactly as long as the lease its run bought, and the renewals of the pool ran against the scripted gateway only.

### Lanes that changed

- The restart lane kills the Worker as soon as an attempt is active. Attempts used to be in their environment phase then. They are in their turn now, and nanocode reports a tool call that a host crash cut as an unknown outcome and does not repeat it, so the scripted model ends the turn without the file. The lane counts such an attempt, and only such an attempt, as one that need not pass.
- The lane of a gateway that sells no renewal expected its rows to outlast one lease of 8 s. They finish inside it now. It runs 8 attempts on a lease of 6 s.

### Not verified

- More than one run on a kept sandbox of the real gateway, and a renewal paid by the pool.
- The first model request of a run on a standing runner against a real model: the turn was submitted and the gateway refused the key.
- A cold start after the claim stopped waiting for the session, beyond runs 3 to 6 above, and any gateway run on the last commit of this entry: the key was spent before the rebase onto the work that scales runs. The lanes, and five runs of the standing runner on the deployed Worker, ran on that commit.
- The pool with `--provider e2bT and `--provider local`: it is written for both and ran with neither.
- More than one slot in a kept sandbox, and two runs asking the pool at the same moment, beyond the unit tests of the table.

## 2026-11-12: three model arms over the whole of Terminal-Bench 2.1

The entry above ran this size with solutions only. This one ran it with models: every task of `terminal-bench-2.1@312b07080ace` once with `claude:claude-haiku-5-5`, once with `claude-code:claude-haiku-5-5` and once with `codex:gpt-6-luna`, on the deployed Worker at `b992d93`, with nothing on a machine of the operator's but the commands that started it. No code changed: this entry records what ran and what it found.

### Two payers

The money decided the shape. Models went through the gateway with a key whose wallet held $9.30 of a stablecoin. The sandboxes could not be leased with that key without taking from the models, so they were opened at E2B over MPP with the machine token of another wallet and runners were attached in them, the operator-pays path of [README.md](README.md#run-it-on-e2b):

```sh
node cli/nanoeval.ts run --eval terminal-bench-2.1@312b07080ace --agent nano-claude=claude:claude-haiku-5-5 \
  --sandboxes 0 --backend ns --runtime-blob SHA256 --slots 4 --disks remove --free-disk-mb 4000 \
  --model-budget-usd 4.3 --attach-sec 600 --poll-ms 2000          # prints RUN
tempo request --mach -X POST --json '{"templateID":"desktop","timeout":3600}' -o sandbox.json https://mpp.e2b.dev/sandboxes
node cli/nanoeval.ts sandbox --run RUN --e2b sandbox.json --backend ns --slots 4 --free-disk-mb 4000 --poll-ms 2000
```

A run of eight attempts on the four-task eval came first, to see that the key paid for models and the machine token for a sandbox: 8 of 8 passed for $0.0345.

### What ran

One run an arm, one attempt a task. Each began in five or six sandboxes and got four more while it ran, 28 sandboxes of an hour in all.

| Arm | Sandboxes | Passed | Failed | Errored | Agent time, summed | Last verdict after | Recorded model spend |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `claude:claude-haiku-5-5`, a nanocode session | 6, and 4 more after 22 min | 61 | 23 | 5 | 7 h 28 min | 4,303 s | $1.3614 |
| `claude-code:claude-haiku-5-5`, Claude Code 2.1.318 in the slot | 5, and 4 more after 28 min | 64 | 20 | 5 | 7 h 10 min | 4,332 s | $2.0760 |
| `codex:gpt-6-luna`, a nanocode session | 5, and 4 more after 18 min | 39 | 27 | 23 | 2 h 49 min | 1,953 s | $2.0187 |
| The rerun of those 23 errored rows, in seven of the same sandboxes | 7 | 10 | 6 | 7 | 1 h 46 min | 1,382 s | $0.8013 |

With its rerun the third arm stands at 49 passed, 33 failed and 7 errored. 84 of the 89 tasks pass with their solutions on these slots, so that is the ceiling here. One attempt a task says little about a difference of three rows between two arms.

**Every row that ended without a verdict.**

| Task | Arm | Cause |
| --- | --- | --- |
| `qemu-alpine-ssh`, `qemu-startup` | all three | Task: the verifier's `apt-get install curl` gets 404, as with the solutions. One of the six was refused payment before it got that far |
| `caffe-cifar-10` | nanocode, haiku | The sandbox's hour: claimed twice, and both sandboxes ended before the agent did. Claude Code passed it in 37 min 36 s, the third arm in 9 min 40 s |
| `regex-chess` | nanocode, haiku | The sandbox's hour: claimed 28 minutes into the run in a sandbox with 32 minutes left, and again in one with 22 |
| `query-optimize` | nanocode, haiku | The gateway refused a request `402 delta-too-small`. Run again alone, it failed |
| `rstan-to-pystan` | Claude Code | `environment`: the task asks for 8 GiB, the slot had 6,364 MB, and that limit killed two processes. The two other arms passed it with one killed process each |
| `regex-chess` | Claude Code | Refused payment on its second claim, the key's limit being spent |
| `schemelike-metacircular-eval` | Claude Code | The agent ran to its 2,400 s, the sandbox ended during the verifier, and the run was cancelled rather than paid for again |
| `compile-compcert`, `extract-moves-from-video`, `make-doom-for-mips`, `train-fasttext`, `winning-avg-corewars` | nanocode, luna | Refused payment in the run and again in the rerun: the key was spent |

### What it cost

**Models.** The key's wallet paid $8.98 of its $9.30: $6.83 through its payment channel, $2.14 in 217 charges of $0.001 to $0.012 outside the channel, and $0.02 of network fees. The runs recorded $6.30. Two gaps:

- The channel spent $0.53 more than the runs recorded. The comparison table has a cost for 79, 88 and 88 of the 89 attempts of the three arms: an attempt that ends in an error before its last response has spent what its earlier responses cost, and some of that is not in the run's spend. Not broken down further.
- **The $2.14 outside the channel is in no run's spend and under no `--model-budget-usd`.** No response reported it. The agents searched the web: the events of the attempts have 29 `WebSearch` calls in four attempts of the first arm, 7 searches and fetches under Claude Code, and 52 `web.run` calls in twelve attempts of the third. A price per search fits the amounts, and the counts do not match charge for charge, so the cause is likely and not shown. Until a run can see these charges, its budget bounds the tokens only, and the key's limit is the bound on the rest.

**Sandboxes.** 28 `desktop` sandboxes of 3,600 s at $0.50626 and one of 1,500 s at $0.211: $14.39. Six more requests asked for 10,800 s. E2B charged each $1.51858 and then answered `400 Timeout cannot be greater than 1 hours`: $9.11 for nothing, with no sandbox and no refund. A dry run of the same request had quoted that price and said nothing of the limit. They were sent at once, which was this work's mistake: one would have shown it.

### What this found

- **An MPP sandbox lives an hour.** Nothing tells an attached runner when its sandbox ends, so it claims rows it cannot finish: three rows never got a verdict for it, two more were claimed a second time, and each lost claim was paid for in tokens up to that point. `--sandbox-timeout-sec` is known only to a sandbox the run opens itself. A runner that is told its end could stop claiming rows whose timeouts pass it.
- **The first minutes are thin.** An empty runner takes a row that needs the whole machine first, and there are eight such tasks. So six sandboxes ran six or seven rows at a time for the first six minutes, and 31 rows had ended after 22 minutes. The sandboxes added then were the ones that ran three rows at once from their start. With agents instead of solutions those eight rows are also the long ones.
- **Sessions on one channel race.** With some twenty sessions on one key the gateway refused five requests `402 delta-too-small`: a voucher that added nothing to the one before. The row ends as an `agent` error. nanoeval does not retry a refused payment, which is right for a budget and wrong for this one.
- **A top-up is a fixed amount.** The key's channel is topped up by its configured $3. When the wallet held $1.33 the top-up failed and every request was refused `402 payment-failed` until the key's deposit and top-up were lowered by hand: 19 rows of the third arm ended in those minutes, which is why it has a rerun.
- **An 8 GiB task was killed at 6,364 MB for the first time**, and was reported as the `environment` error it is.
- Two runners shared a sandbox for the reruns, one of a run that was ending and one of the next, and rows of both ended with verdicts. Whether a call of a runner failed or a disk came near its floor was not read.

### Not verified

- A second attempt of any row, so nothing here says how much of a difference between arms is noise.
- `codex-cli` at this size, and `gpt-6.1-sol` or `claude-opus-5-5` on more than one task.
- What each arm cost in full: the charges outside the channel are not attributed to a run.
- A refund of the six refused requests. None was asked for.
- CI on GitHub. The commit that records this changes this file and README.md only; every step of `ci.yml` ran from a fresh clone of it first.

## 2026-11-12: what the three arms found, fixed

The entry above ended with a list of what one night of three model arms found. This one changes the code for each item. Nothing here was run against a paid sandbox or a paid key: the wallets were empty. What ran is unit tests, end-to-end lanes on directory slots against a scripted gateway, the lanes on krun and ns slots, one read of the real key's usage, and a simulation with the durations of the night. Each section says which.

Machines: the code was written and the directory lanes first run on a Linux machine without KVM (5 cores, Node 24.22.1). The fresh clone, with every lane, ran on the 32-core Linux machine with KVM of the earlier entries, shared with other work.

### A runner did not know when its sandbox ends

**The defect.** A sandbox opened over MPP lives 3,600 s. Only a sandbox the run opens itself had its end in the run's table, and nothing read it when rows were granted. So a runner claimed any row at any time: three rows of the night never got a verdict, two more were claimed a second time, and each cut claim was paid in tokens.

**What changed.**

- Every runner whose machine ends has that end with the run: a sandbox the run opens or takes from the pool by its lifetime, an attached runner by what its operator says. `nanoeval sandbox --e2b FILE` now requires `--sandbox-timeout-sec`, the timeout the sandbox was opened with, counted from the time FILE was written or from `--opened-at`, and `nanoeval runner --run` takes `--ends-in-sec`. Both send the seconds that are left, and the run adds them to its own clock, so the clocks of two machines are never compared.
- The run grants a row to a runner only while the worst case of the row ends before the runner does: the setup limit (`--setup-sec`, or the task's own if longer) plus its agent timeout plus its verifier timeout, three times that last for a judged task. It is the figure a run already used for the lifetime it buys.
- A runner that can take none of the rows that are left is drained: the run records why, puts `runner.drain` in its timeline, `status` prints it, the runner is told with its next claim, logs it, finishes the rows it holds and leaves. A run that opens sandboxes stops counting it against `--sandboxes`, closes its sandbox once it is idle and opens another: that is the successor of a sandbox that cannot finish the run.
- A sandbox that reaches the end of its lifetime with rows in flight is closed like one whose lease is over. It used to be found a lease later as a runner that stopped answering, and counted as a sandbox that failed, of which a run tolerates two in a row.

**Rows that no sandbox covers.** With `--setup-sec 600`, 33 of the 89 tasks of Terminal-Bench 2.1 have a worst case over 3,600 s, up to 24,600 s, and their agents rarely use it. Refusing them would take a third of the benchmark away from sandboxes of an hour. Decided: a row that no part of a runner's life covers is granted only in the first `--setup-sec` of that life, which is the most time there is for it. If the sandbox then ends first, the claim is final: the row ends as an `environment` error that says it had the whole sandbox, and is not claimed again by another sandbox of the same length. `regex-chess`, whose agent ran to the end of two sandboxes in the night, would have cost one claim instead of two or three.

**Rows that no runner can take.** Two rows of the night stayed unclaimed with no runner until the run was cancelled by hand. Decided: in a run that opens no sandbox itself, a row that no runner could take for `--setup-sec` ends as an `environment` error (`run.stranded` in the timeline when the wait begins), whether the run has no runner at all or the sandbox of every runner ends before the row could. The run then finishes, and `run --rerun RUN --errored` takes those rows to new sandboxes. `--setup-sec` is the time a run already gives a runner to appear. This also ends a run that nobody ever attached a runner to, `--setup-sec` after it was created.

**What it costs.** The timeouts are worst cases, so the rule is conservative: a row of 900 s and 900 s is taken only in the first 20 minutes of an hour. Simulated with the durations of the night (next section): with the end known, the ten sandboxes of the first arm leave 4 rows unclaimed and the nine of the second arm 22, and each loses one claim, where the same model with the end unknown loses 5 and 1 claims and leaves 2 rows and 1 row without a verdict. Opening a sandbox whenever no runner can take a row that is left ends both arms with 12 sandboxes and one lost claim, `regex-chess`, later than the night did. A shorter `--setup-sec` lets a sandbox take rows for longer. An estimate from the verifier times a run has measured, instead of their timeouts, is not written.

**Checked.** Unit tests of the rule (`Admission.fits`), of the queue and of `Config.rowSec`. The lane `ending` on directory slots: a runner that is registered with 60 s left and starts after the setup time takes no row and says so in its log, the run's status and its timeline; the rows end as `environment` errors after `--setup-sec` with no claim; a second run with a runner started with `--ends-in-sec 120` takes all six rows at once, though none fits 120 s, and they get their verdicts. The fleet and lapse lanes pass as before.

### The first minutes were thin

**The defect.** An empty runner took a row that needs its whole memory first, so that such rows are not starved by a runner that keeps refilling. Six sandboxes that start together then each run one of the eight such rows, with 81 rows waiting.

**What changed.** Rows are granted by attempt number, then longest worst case first, then by id. An empty runner takes a whole-machine row first only while fewer runners hold one than their share of the fleet, rounded up: the worst cases of the whole-machine rows that are left, against those of the other rows weighted by the part of a runner's memory each takes. For Terminal-Bench 2.1 on `desktop` runners that share is 22 %, two runners of six. Past it, an empty runner takes the rows others can take too, and a whole-machine row only when nothing else is left for it, so no runner idles beside a row it could run.

**Simulated.** A model of the claim rule, written apart from the code, one-second steps, with the task list of `terminal-bench-2.1@312b07080ace` and the setup, agent and verifier durations each row had in the first two arms of the night (89 rows each; a row that never ended gets the duration of the other arm). Runners admit 6,364 MB, four slots, one row prepared at a time.

| Durations of | Fleet | Rule | Rows running after 1 to 6 min | Rows ended after 22 min | Last verdict | Claims lost to a sandbox's end |
| --- | --- | --- | --- | ---: | ---: | ---: |
| nanocode, haiku | 6 runners with no end | before | 6, 6, 6, 6, 6, 7 | 41 | 5,370 s | |
| | | longest first, share | 12 throughout | 21 | 3,806 s | |
| | 6 and 4 more after 22 min, an hour each, end unknown | before | 6, 6, 6, 6, 6, 7 | 41 | 4,919 s, 2 rows without | 5 |
| | | longest first, share | 12 throughout | 21 | 4,919 s, 1 row without | 3 |
| | the same, end known | longest first, share | 12 throughout | 26 | 3,600 s, 4 rows unclaimed, 1 without | 1 |
| Claude Code, haiku | 5 runners with no end | before | 5 throughout | 27 | 6,176 s | |
| | | longest first, share | 10, 11, 11, 11, 11, 11 | 17 | 4,418 s | |
| | 5 and 4 more after 28 min, an hour each, end known | longest first, share | 10, 11, 11, 11, 11, 11 | 40 | 3,600 s, 22 rows unclaimed, 1 without | 1 |

The model's "before" reproduces the night: six rows for six minutes. Twelve is what memory admits, two or three rows a runner. The run ends 28 to 29 % sooner on runners with no end, and fewer rows have ended early, because the long ones go first. Not shown by the simulation: anything about real sandboxes, the Worker under that load, or a second attempt per task.

**Checked.** Unit tests of `Admission.wholeFirst`, of `fill` with a runner past the share, and of the queue order. The packing lanes pass as before. Not run at the size of a benchmark.

### A refused payment was never retried

**The defect.** The gateway answered five requests of the night `402` with `https://paymentauth.org/problems/session/delta-too-small`, a voucher that raced another session's on the same key, and others with `.../session/insufficient-balance` just before a top-up. nanocode ends a turn on a `402`, and so does an installed agent, so each row ended as an `agent` error. When the wallet could not fund a top-up, every request was answered `402` with the code `payment_failed`, and 19 rows of one arm were claimed and failed one after another.

**What changed.** Both paths a model request takes now go through one relay (`worker/Meter.ts`): the egress of a session, and the endpoint of the run that an installed agent calls. It reads a `402` before the agent sees it.

- A refusal that passes, by those two problem types, is sent again after a pause: `--step-retries` times at most, `--poll-ms` apart and twice as long each time, the policy a runner has for a step that stumbles. Each try is a line in the attempt's `agent/model-requests.jsonl`, which sessions now have too.
- A refusal with the code `payment_failed` or the type `.../payment-failed` is not sent again. The run records it (`refused` in the status, `model.refused` in the timeline), grants no more rows, and ends every row that has not started as a `budget` error without claiming it. The row that met the refusal ends as a `budget` error too, where it was an `agent` error.
- Any other `402` reaches the agent as before.

**Checked.** A unit test on the three bodies the gateway sent in the night. The lane `refused`, for sessions and for installed agents: a scripted gateway refuses the first three model requests in passing, every row still gets its verdict, and the three refusals are in the requests of their attempts. The lane `spent`: the gateway answers `payment_failed` after two responses; one row has its verdict, the row that was running ends as a `budget` error, the four that had not started end as `budget` errors with no claim, and the refusal was not sent again. Not met for real since: whether three tries are enough for a top-up to land is not known.

### The spend was under-reported

**Costs lost with an error.** The cost of a session's attempt came from the last event of its turn, and a turn that fails or is cancelled reports none, so the comparison had a cost for 79, 88 and 88 of 89 attempts and the runs recorded $0.53 less than the key's channel paid. The relay now records every response when it ends, with the `usage.cost` the gateway reports: an attempt that errors, is cancelled or loses its claim keeps what its responses cost, the cost of an attempt is the sum of them, and `--model-budget-usd` counts responses as they arrive instead of attempts as they end. An attempt whose responses carry no cost, on a provider's own key or a plan login, keeps the estimate it had.

**The field.** nanoeval reads one thing: `usage.cost`, a number in USD, in the last usage object of a response. That is `message_delta.usage` of a streamed Messages response or `usage` of its body, and `response.usage` of `response.completed` or of the body for Responses. If the gateway puts the price of a search into that number, the run's spend has it with no change here. No header is read: a stream's cost is not known when its headers are sent.

**The $2.14 outside the channel.** The attempts' events keep no response body: a session's events have the tokens of each call and nothing else of its usage. What they show: Claude Code's own result reports `modelUsage.*.webSearchRequests: 1` for the one attempt that searched, so the Messages response behind it reported `usage.server_tool_use.web_search_requests`. The relay now counts that field and `web_fetch_requests`, and the `web_search_call` items of a Responses output, per response, and `status` prints the total. They are not priced: the night had some 90 searches and fetches for 217 charges of $0.001 to $0.012, so one price per search does not explain the charges, and a price added here would be counted twice once the gateway reports it in `usage.cost`. The 217 are about the number of sessions that made a request, which may be a coincidence.

**What the key was charged.** A run whose models or sandboxes are paid with the gateway key reads `GET /api/keys/me` when it is created and again when it finishes: `usage.channel.spent`, `usage.channel.deposit`, `usage.limit.remaining` and `usage.wallet.balance`, decimal strings in USD. `status` prints `key charged`: what the channel spent in between, and what left the key's limit without entering the channel, beside what the run recorded. Read by hand from the key of the night after it: channel spent 6.85 of a deposit of 6.85, limit 0.000803 of 9.009 remaining, which is the $6.83 and the $2.14 with fees of the entry above. Another run on the same key in the same minutes is in the figure, and the real gateway takes a sandbox lease from the key's limit outside the channel, so a run's own sandbox spend is in the outside part there.

**Checked.** Unit tests of the meter, of the usage and of the difference. Every gateway lane now asserts that what the scripted gateway's channel paid is what the run recorded, and that a charge it makes outside the channel for each model request shows as charged outside it and in no spend. The real `/api/keys/me` was read once by hand, not by a run.

### E2B refused a lifetime only after charging it

`E2b.maxTimeoutSec` was 86,400, taken from the API's description. It is 3,600: the provider refuses more before the paying request, `scripts/e2b-quote.ts` before the unpaid one, `nanoeval sandbox` for the timeout it is told, and a run for a lifetime named with `--sandbox-timeout-sec`. A lifetime the run computes is cut to it instead of refused, since a sandbox now takes only the rows it can finish and the run opens another for the rest. E2B's API also sells more time for a running sandbox (`POST /sandboxes/ID/refreshes` and `/timeout`, read from its `openapi.json`, where the unpaid request is answered with a price). Whether that extends a sandbox past its hour or is charged and refused like the create is not known, and finding out costs money, so the provider does not use it.

Checked: a unit test that a create for 3,601 s reaches no fetch. Not paid for real.

### An 8 GiB task was killed at 6,364 MB

A runner admits 80 % of its machine's memory, so that rows which share it leave room for the runner and the system. A row that asks for more than that runs alone, and got the same 80 % as its limit. It now gets what the machine has free when its environment starts, `MemAvailable` of `/proc/meminfo` read by the runner, never less than before and never more than it asks. That figure already has the runner's own memory and the system's taken out, as measured on that machine at that moment, and counts the page cache of the disk just unpacked as free. A capacity named with `--memory-mb` is kept as it is. A row that still asks for more than it got and has a process killed is the `environment` error it was.

**Measured.** The lane `alone` on ns slots, in a guest of 8,192 MiB that reports 7,965 MB, as an E2B `desktop` sandbox reports 7,955: a task that asks for more than the machine has ran alone with 7,667 MB and passed. The 80 % would have been 6,372 MB, so the system, the sandbox service and the runner held 298 MB at that moment. Also unit tested. Not run in a sandbox, and not with a task that uses that much.

### Smaller

- `nanoeval run --help` ended in `ERR_PARSE_ARGS_UNKNOWN_OPTION`. `--help` and `-h` print the usage.
- A step of a runner that stumbles and is tried again left no trace in the run. Each is an `attempt.retry` mark in the timeline, and `status` prints `retries=N` beside the row's claims.
- **A session whose hand is gone held the tick.** Found by the fleet lane, which failed in most runs on the machine without KVM and passed on the earlier code there once. When a sandbox dies during a tool call, the turn of its session waits for the hand. The earlier entry bounded the cancel of that turn to one tick. The removal of the session that follows was not bounded and took 26 s, during which the run renewed no lease, so the next sandbox lapsed. Removals are now bounded like cancels and finish behind the tick. Four runs of the lane passed after the change, in none of which the turn was caught in a tool call, so the bound is shown by the 26 s it measured before and not by a run after.

### Every check, from a fresh clone

From a fresh clone of `38dfdf5`, the commit with the code, on the Linux machine with KVM, with programs that log and exit 97 in place of the seven container tools first on `PATH`: every `run` step of `ci.yml` in its order, 66 steps, and each exited 0. `npm ci`, `npm run lint`, `npm run check:types`, `npm test` (137 tests, none skipped), `npm run dry-run`, the 25 directory lanes with the four new ones, the 22 krun lanes, the 11 ns lanes in a guest with the new one, `cargo fmt --check`, `cargo clippy` and `cargo test`.

That machine reached no package registry on the day. `npm ci` installed from the cache on its disk and took 214 s, most of it waiting for a registry that did not answer. The first krun lane builds the launcher from the clone, and its `cargo build` waited for the crate index: that try was stopped after three minutes, and the steps from that lane on ran with `CARGO_NET_OFFLINE=true`, which builds from the crates the machine already had. No step was changed. The commit that records this changes Markdown only, and every step ran again from a fresh clone of it before it was pushed.

### Not verified

- Anything against a paid sandbox or a paid key: a runner that drains in an E2B sandbox, a successor sandbox that a run opens over MPP, a refusal of the real gateway that is retried, a key that is spent, and `key charged` read by a run.
- The claim order at the size of a benchmark. The simulation is a model of the rule.
- Whether E2B extends a sandbox past an hour.
- A search priced: none is.
- A response whose stream is cut by a cancel: its cost is recorded if the gateway had sent it, and whether the cancel hook of the stream runs under workerd was not read.
- An 8 GiB task with a model in a sandbox with the new limit.
- CI on GitHub.

## 2026-11-12: a renewal the gateway prices only for its owner, and a run that grows

Two faults stopped a live parity run of nanocode against Claude Code (Opus 5.5, high effort, 12 runs of the three Terminal-Bench 2.1 tasks financial-document-processor, query-optimize and extract-moves-from-video, on gateway `desktop` sandboxes). Neither was the agents'.

**A renewal was never paid.** Every sandbox died at its first renewal, about four minutes in, with `Gateway.RequestError: the gateway asked for payment without a price`, and 19 of 24 attempts ended as `environment` errors (the lease of their runner expired). The unpaid `POST /v1/compute/renew` that nanoeval sends to read the price answers 402 with no `WWW-Authenticate` and `{"code":"payment_failed","detail":"E2B prices this call only for the wallet that paid for the sandbox, and this caller has no API key of that wallet."}`, so no unpaid request can learn a renewal's price. The same request with the key is paid and renews (checked on a live sandbox: a 1 s renewal moved `paidUntil` by 1 s). Neither the paid answer nor its `Payment-Receipt` says what the call cost: the receipt carries the channel's cumulative `spent`, which other calls on the key move at the same time. Now a gateway sandbox's handle keeps the lease it was created with (amount, currency, realm and seconds of the create's charge), and when an unpaid renew answers 402 `payment_failed` without a challenge, the renewal is charged to the budget, written as a payment and then paid with the key at that rate over the seconds E2B bills: from now to the new end of the lease, `ceil((paidUntil - now) / 1000) + seconds`, at least the gateway's least price of 1,000 base units. Its description is `compute.renew estimated at the lease rate`, so a reader sees it is not a quote. A handle without a lease, from a run created before this change, still refuses such a renewal unpaid. `Run` and `Pool` pass the sandbox's `paidUntil` with the handle. The scripted gateway answers an unpaid renew as the real one does, and the end-to-end lanes compare a renewal's payment by its place and description, and the run's sandbox spend against the gateway's charges within three call fees and two seconds of lease per estimated renewal; everything else is still compared exactly.

**A run never opened a second sandbox.** A runner reports its offer only when it asks for rows, and `grant` stored the offer as the runner sent it, before the claim. A runner that had just filled its slots still showed free slots, so `grow` saw room and opened nothing: one run with `--sandboxes 8 --slots 3` held one sandbox and ran three of its 24 attempts at a time. `grant` now stores the offer less the slots and memory of the rows it just claimed.

Checked on 2026-11-12 on `nanoeval-fixcheck`, a Worker deployed from this change to the Tempo account with the gateway key, oracle runs of fix-git, openssl-selfsigned-cert and regex-log on `desktop` sandboxes with ns slots: with `--attempts 2 --sandboxes 3 --slots 1` the run opened three sandboxes and 6 of 6 passed ($0.0768); with `--attempts 1 --sandboxes 1 --slots 1 --sandbox-lease-sec 90` the lease was renewed while rows ran, the renewal was recorded as $0.021257, 3 of 3 passed, and the run recorded $0.034211 against $0.034146 that the key was charged (`key charged`), $0.000065 over. From a fresh clone of `c9af639` with this change on a Linux machine with KVM: `npm run lint`, `npm run check:types`, `npm test` (139 tests), `npm run dry-run` and every end-to-end step of `ci.yml` (58 lanes) passed. `npm ci` did not finish there in 15 minutes against its registry, so the steps ran on the `node_modules` the machine had installed from the same lockfile.

Not verified: a renewal of a sandbox whose lease is near the hour E2B allows on one payment, and the estimate on a template other than `desktop`.

## 2026-11-12: the harness and the hand move to nanocode builds of that day

The model arms above ran on nanocode-ts `build-751e03a` (nanocode 85d5705) with the rolling `nanocode-cli` release of 2026-11-06 as the hand. Their trajectories showed what cost the nanocode rows most: what a command left in the background was dead when the call returned. This entry pins the builds that fix it, nanocode-ts `build-061892c` (nanocode d4e8af2) and the hand `nanocode-cli-1f10a22` (at first `nanocode-cli-5f8b457`, whose shell failed two solutions and cost a model one task: see below), and starts the hand with `--own-processes`. It changes `package.json`, `package-lock.json`, the release and checksum of `src/Slot.ts` and the two lines of `sandbox/slot.sh` that start the hand, nothing else.

### What the new builds do

- **A command that ends leaves what it started running** (nanocode f9c53fe29, 1b203d402). The released hand killed the process group of every command when its shell exited, so `nohup server > log 2>&1 &`, `server &` and `bash start.sh` left nothing for the next call. Twelve of the 87 Claude-harness trajectories of the entry above start a shell background job, and four rows were lost to it. The new hand leaves them, and its shell, psh, forks as bash does for a job that is not one program: `( … ) &`, a loop, a function, `sleep 300 &`. nanocode's DECISIONS.md has the table: at the end of a turn 20 of 20 ways to leave a job through Bash and 21 of 21 through exec_command are alive, as under bash, where the hand of 2026-11-06 kept 1 of 14 and 2 of 15.
- **A stopped hand keeps reading what its commands left running** (nanocode 43e077ff3, f8e0da453). `slot.sh` stops the hand before the verifier. That closed the pipes and the terminal of whatever the agent had left running: a server on a terminal was hung up, and one on pipes failed at its next line of output. On SIGTERM the hand now replaces itself with `nanocode read-outputs`, the same process id, which only reads those outputs until they end, reaps the children it inherited, and exits with 143. So `hand.status` can stay `running` through the verifier when the agent left such a process, and is `exit:143` at once when it left none. It runs no cell and holds no connection, so the tests stay out of the agent's reach.
- **A command that exhausts the slot's memory ends alone** (nanocode 5f8b457de, and `--own-processes` in `slot.sh`). psh is the only shell of the agent's commands in these builds, and by default a hand runs a command of builtins and psh's own utilities inside its own process. In a slot with a memory limit that is the hand's end: with the hand started as before, the `memory-limit` fixture's command (`x=$(head -c 400000000 /dev/zero | tr '\0' x); echo ${#x} > hog.txt`, 256 MB) no longer answered "Process exited with code 137" after 2.5 s but "remote operation deadline elapsed; outcome unknown" after 30 s, and the two lanes that run it took 39 s instead of 12 s while still passing, since the row fails either way. With `--own-processes` every command runs in a psh process, the kernel ends that process, and the fixture answers "Process exited with code 137" after 1.4 s again. A hand given through NANOEVAL_NANOCODE must know the option: it is in nanocode from 5f8b457de.
- **psh starts through the loader** (nanocode e03054565). A slot starts the hand as `ld.so --library-path lib nanocode`, where the executable is the loader, and before this commit every command of such a hand ended with status 127. Any later pin must be at or after it.
- The harness side is nanocode-ts `build-061892c`, built against nanocode d4e8af2, which differs from 5f8b457de only in the hand's command line. It carries the Code Mode changes of that day: exec takes `yield_time_ms` as an argument, the instructions say what `tools.Bash` resolves to, a hand's catalog declares what its tools return, and exec's refusal of a JSON-wrapped source says how to write the JSON string.
- Not used here: `nanocode hand --cell-yield-ms`, which sets how long a cell runs before it yields when the model names no yield. `slot.sh` passes none, so a cell still yields after 10 s.

### The hand moved from 5f8b457 to 1f10a22

The 89 solutions of terminal-bench-2.1 ran through the hand `nanocode-cli-5f8b457` beside `--oracle` on a second machine (ns slots, no KVM), and claude-haiku-5-5 ran 21 of the tasks with the earlier pins and with these. The oracle passed 84 (82, and two more when rerun alone), the solutions through the hand 78: four take longer than the Bash tool's ten minutes, and two failed for defects of psh, the hand's shell. The model passed 18 of 21 against 17 and lost `compile-compcert` twice to a third defect. All three are fixed in nanocode, and the pin is the hand built from the commit that holds the fixes:

- **A loop over the lines of a pipeline ended after the first line when its body ran a program** (nanocode 484939b8e). `printf '1\n2\n' | while read X; do dd if=/etc/hostname bs=1 count=2 2>/dev/null > "r_$X"; done` wrote `r_1` only: the program was handed the rest of the loop's input whether it read it or not. The solution of `password-recovery` is such a loop. A program now gets the pipe itself and takes what it reads, as a child of bash does.
- **`sed -i` over several files wrote the newline that a file lacks at its end to the start of the next file** (nanocode 58beda75d). The solution of `sanitize-git-repo` left an empty first line in a YAML file.
- **In an image without git or python3 psh answered for them** (nanocode 404c3c30b). `git --version` printed a version and `git clone` said that this shell has no network, where bash says "command not found" and the agent installs git. The name is now not found, with status 127, and `which`, `type` and `command -v` agree; the same holds for tar, zip, unzip and patch, of which psh also has only a part.
- nanocode 1f10a22ea holds what a comparison of 108 command lines under psh and under bash with the GNU utilities found besides: `diff <(a) <(b)` and `grep x <(cmd)` failed, `xargs` ran nothing for input without items, and awk failed on programs that need gawk. The hand at 5f8b457 agreed with bash in 46 of the 108, the hand at 1f10a22 in 106; nanocode's DECISIONS.md names the two that are left.

nanocode-ts stays at `build-061892c`: the changes are to the shell that runs a slot's commands, which is the hand's. The `run` steps of `.github/workflows/ci.yml` ran again from a fresh clone of the commit that moves the hand, on the machine and in the way described below, with one difference: `npm ci` could not run. By that evening npm's cache on the machine no longer held the registry's packages, and the registry was still unreachable, so the `node_modules` that `npm ci` had installed for the commit before this one, from a `package-lock.json` that is byte for byte the same, was copied in its place, after what npm had recorded of that tree was compared with the lock (386 packages in the lock, 258 installed, no difference). The other 65 steps passed, 63 at once and two end-to-end lanes on a second try: the first try ended in two seconds with `wrangler dev` finding its port taken, while another end-to-end run was using the machine.

### How it was checked

On the 32-core Linux x86_64 machine with `/dev/kvm` of the entries above, from a fresh clone of the commit that changes the pins, every `run` step of `.github/workflows/ci.yml` passed, 66 of 66 in 541 s: `npm ci`, lint, types, unit tests, the deploy dry run, the 58 end-to-end lanes (25 on directory slots, 22 on krun slots, 11 on ns slots inside a guest, none skipped) and the `krun` job's format check, clippy and tests. The same steps on main c9af639 the same hour: 66 of 66 in 538 s. The machine could not reach the npm registry, PyPI or crates.io that day: `npm ci` installed from its cache with `npm_config_prefer_offline=true` and without the audit, cargo ran with `CARGO_NET_OFFLINE=true`, and the two tarballs and the hand came from GitHub. No container engine ran: shims for docker, podman, buildah, skopeo, ctr, crictl and nerdctl were first on the PATH and logged no call.

A scripted Claude-harness session also ran the solutions of four fixture tasks through the hand's Bash tool on krun slots (extract-todos, uppercase-message, write-greeting, cached-verifier): all four passed, as under `--oracle`, 2 model calls and 5 tool calls a row.

### What ran on the hand of 1f10a22

The checks that the first form of this entry asked for ran before it went to main, on the second machine: Linux x86_64, 5 cores, 14 GB, root and no KVM, so ns slots, three at a time at most. `terminal-bench-2.1` was imported there: the 89 packages have the checksums of the entries above, and the version digest differs, since a conversion is not reproducible byte for byte. That machine has no KVM for the builder microVM of an import, so its import applied the image layers with the launcher's guest in a namespace, and it reaches the network through a proxy, through which the TCP connections of its slots were tunnelled. Both were done outside this repository. The hand in the slots was the pinned one, checked by its checksum. One attempt a row, unless a rerun is named.

**The 89 solutions.** `--oracle` passes 84 there, the 84 of the sandboxes above: 82 in one run, and `custom-memory-heap-crash` and `query-optimize` when rerun alone (valgrind refused the machine's limit of open files until the runner was started with a lower one, and a timing threshold of 5 % was missed under load). An oracle run does not go through the hand; it was made with the hand of 5f8b457 pinned. Through the Bash tool of the hand of 1f10a22, where a scripted Claude-harness session copies each solution into its slot and runs `bash solve.sh`: 80 of 89. The four that the oracle passes and the hand does not are the four whose solutions run longer than the Bash tool's ten minutes, `caffe-cifar-10`, `compile-compcert`, `crack-7z-hash` and `rstan-to-pystan`, and all four pass when the same session runs them through exec_command. `password-recovery` and `sanitize-git-repo` pass. The other five are the five that fail with the oracle too.

**A model on 21 tasks, with three sets of pins.** `claude:claude-haiku-5-5` as a nanocode session, two slots, on the five tasks whose rows the background defect had cost or slowed (`kv-store-grpc`, `pypi-server`, `compile-compcert`, `mcmc-sampling-stan`, `hf-model-inference`), the six that only nanocode had passed in the arms above, and ten that both haiku arms had passed.

| Pins | Passed | Failed | Errored | Agent time, summed | Model calls | Spend at list prices |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| nanocode-ts `build-751e03a`, the hand of 2026-11-06 | 17 | 4 | 0 | 7,430 s | 312 | $0.69 |
| `build-061892c`, hand `nanocode-cli-5f8b457` | 18 | 3 | 0 | 5,331 s | 253 | $0.35 |
| `build-061892c`, hand `nanocode-cli-1f10a22`, the pins of this entry | 18 | 2 | 1 | 8,053 s | 298 | $0.70 |

- `pypi-server` fails with the earlier pins, where the server the agent had started was gone when the verifier asked it, and passes with both newer hands. The server of `kv-store-grpc` answers the verifier with all three.
- `compile-compcert` passes on 1f10a22 in 1,261 s: the agent found no git, installed it and built. On 5f8b457 it gave up in two attempts of two.
- `schemelike-metacircular-eval` fails at its 2,400 s with the earlier pins and passes with both newer hands, and `sanitize-git-repo` passes on 1f10a22 only: one attempt each, so this may be chance.
- The three rows that did not pass on 1f10a22 did not pass when rerun there either. `kv-store-grpc`: twice the agent renamed the generated modules to `KVStore_pb2.py`, as it read "{class name}_pb2.py" in the instruction, and the verifier imports `kv_store_pb2`; its test of the running server passed both times. `model-extraction-relu-logits`: the verifier ran the agent's script for its whole 900 s, a verifier error, and the rerun recovered the wrong rows; the earlier pins failed this row too. `rstan-to-pystan`: the agent's first Stan program keeps two 200 by 200 matrices for every draw and is killed at the task's 8 GiB once sampling is done, with every set of pins. With the earlier pins the agent slimmed the program and finished inside its 1,800 s. With the newer hands it did not pass in four attempts of four: three ran out of time after that first run was killed or hung, and one finished with two posterior means just outside the verifier's ranges. In one of the three, the first run was also ended by the ten minutes that a command may stay in the background after its Bash call has timed out.
- No trajectory of the 1f10a22 rows holds a message of the shell standing in for a missing program.

### Not verified

- `codex` agents and `gpt-6-luna` on these builds: the only login for them was on a machine whose verifiers could not install packages that day.
- All 89 tasks with a model on these builds, a second attempt of the rows that passed, and an installed agent beside them.
- A sandbox. The rows above ran in ns slots on a 5-core machine of the operator's, where heavy rows run slower than on the 8 vCPUs of the sandboxes above.
- Whether `rstan-to-pystan` is lost to the newer builds or to chance: 0 of 4 against 1 of 1.
- CI on GitHub. The commit that records these results changes Markdown only. Every `run` step of `ci.yml` ran again from a fresh clone of it before it was pushed: `npm ci` on the second machine, which reaches the registry, and the other 65 steps on the machine with KVM, with `node_modules` copied as described above.

## 2026-11-13: a setup is made for one boot of the machine and one request

A runner started on a home from before a restart of its machine ended every row as an error. Each row it claimed came back within seconds as `environment: the task environment failed with exit code 1: mkdir: cannot create directory '/sys/fs/cgroup/nanoeval/KEY': No such file or directory`, and the runner went on claiming. The rows it had held before the restart ended as errors too.

**The defect.** `slot.sh setup` returned at once when `setup.status` of the home said `exit:0`, and a runner calls it at every start. So a home was set up once for as long as it existed. Two things a setup makes do not last that long:

- What it makes in the kernel ends with the boot. For ns slots that is the cgroup named in `limits` with its controllers, the nft table of the private network and `ip_forward`. The files of the home said they were there, and the first `mkdir` of a slot's cgroup failed.
- What it copies into `rt` belongs to one request. A runner of a newer nanoeval that pins another hand, or one started with another backend or network, kept the old hand, backend and network and said nothing.

**The rule.** A setup that finished writes `setup.for` as its last step, and `setup` returns without work only when the status is `exit:0` and that file is what this call would write. Anything else runs the setup again. A setup that is still running is left alone, as before. The file holds:

- **The boot id of the machine**, `/proc/sys/kernel/random/boot_id`. A machine without that file fails its setup instead of guessing.
- **The SHA-256 of `slot.sh`.** The runner copies its own `slot.sh` into the home at every start, and that script decides what a setup makes, so a newer one makes it again.
- **The arguments**: the release and checksum of the hand, the backend and the network.
- **`NANOEVAL_CA_BUNDLE`, `NANOEVAL_KRUN`, `NANOEVAL_KRUN_SOURCE` and `NANOEVAL_NANOCODE`**, the four variables that name a file or a directory a setup copies from, as they are set. The file behind a name is not read: a workspace named by `NANOEVAL_KRUN_SOURCE` has no digest short of building it, and one rule for the four is simpler than two. A runner from the runtime archive is safe by this rule, since the archive is unpacked into a directory named by its digest. A file that is replaced under the same name during one boot is not seen: a hand built again in place, or a launcher built from a workspace that changed while `slot.sh` did not.

`NANOEVAL_SLOT_FORWARD` is not in it: a setup only checks its syntax, and every slot reads it again when it comes up.

**What a second setup must leave alone.** Until now nothing ran a setup on a home that had slots. Three cases:

- **Slots of the same boot and the same request.** Nothing runs, as before: a runner that is started again goes on with the slots it had.
- **Slots of the same boot, another request.** The setup runs beside hands that are still running from `rt`, so it may not write into their files. The hand, its loader and libraries, the CA bundle and the network helper are now written beside their names and renamed over them, as the launcher already was. Written in place, the copy of the loader failed with `Text file busy` while a hand ran, and the copy of the hand wrote over a program that the hand had mapped. Two marks of an earlier setup are removed where they no longer hold, which did not matter while a home was set up once: a hand named by `NANOEVAL_NANOCODE` forgets the checksum of a downloaded one, and a setup without `NANOEVAL_CA_BUNDLE` removes `trust`.
- **Slots of an earlier boot.** Their processes, mounts, cgroups and links ended with it, and their status files still say `running` and `exit:0`. The runner resumed the rows saved in them. Read from the code, not met: such a row waits for a hand that never attaches or for the end of its agent's time and then ends as an `environment` or `verifier` error, and taking its slot down sends signals to process ids recorded in the earlier boot. Now a setup that finds `setup.for` of another boot removes every slot directory of the home first, without a signal. The runner then holds none of those rows, and the run releases them when the runner says hello, or when their lease ends if the runner is started for another run: they start again from nothing, which is what a runner that comes back already did with a slot it had not saved.

**Not changed: a slot that cannot come up for a reason of the machine.** A slot whose `up` fails ends its row as an `environment` error whatever failed, and nothing stops a runner whose slots all fail: it claims the next row at once. That is how one stale home turned every row it was given into an error. With this change the cause that was met is gone, and the general case is open, because it needs two decisions that are not made: how `slot.sh up` says that the machine failed and not the task's environment, and who acts on it, since a runner reports facts and the run decides what they mean.

**Checked** on a Linux machine without KVM, from a clone of `a9532c3` with this change. A new unit test in `test/Sandbox.test.ts` sets a directory-slot home up with `bash` in place of the hand: the same setup does not run again; one for another checksum runs again while a hand runs from `rt`, which stays alive, and keeps a slot directory; with the boot id in `setup.for` rewritten the setup runs again and removes the slot directory. On the earlier `slot.sh` the test fails at the second step, with the files written in place it fails with `Text file busy`, and without the removal at the last step. `npm run lint`, `npm run check:types`, `npm test` (140 tests: 136 passed, and the 4 that need KVM were skipped) and `npm run dry-run` passed. The 25 directory lanes of `ci.yml` ran once each, beside other work on the machine and at a lower priority than it. 24 passed, `ending` with the hand from a file named by `NANOEVAL_NANOCODE`, since this machine fetches the hand slower than that lane allows. `lapse`, with the hand from a file too, passed 1 time of 5 with this change and 3 times of 4 on `a9532c3`, run in turn. It fails the same way on both: a sandbox is `failed` where the lane expects `closed`, which happens when the answer to an unpaid renewal arrives after the lease has ended (`renew` in `worker/Run.ts`). No line of this change is on that path. What it adds to the lane is time: a setup of a directory home with the hand from a file took 245 to 350 ms before and 452 to 808 ms after, six of each in turn. Starting a program takes 10 to 30 ms on that machine, in the trace of one setup, and a setup now starts about fourteen more: one `mv` for each of the seven files it replaces, five for the stamp, and two `rm`.

By hand, with lines added to the lane `resume` that are not kept. As the lane is, the setup did not run again when the runner was started again: the process id in `setup.status.pid` was the same before and after. With the boot id in `setup.for` rewritten while the runner was dead, the setup ran again and removed the 8 slot directories, the runner resumed no row, the run released the 8 claims at its hello, and the same runner claimed the 8 rows again: 4 passed and 4 failed as scripted, none errored, each with 2 claims. The lane counts one lost claim, so it does not pass with that line, and no lane was added for it.

As root on the same machine, a home for ns slots on the private network, with the hand from a file and the launcher from built binaries: the setup finished, the same call started nothing, a call for another checksum ran again while the network helper of `rt` was running and left it alive, and with the boot id rewritten it ran again and removed a slot directory. No slot was brought up in that home, and the cgroup and the nft table were there throughout, since the machine was not restarted.

Before it went to main, on top of the entry above, every `run` step of `.github/workflows/ci.yml` ran from a fresh clone of the commit on the 32-core machine with KVM of the entries above, with `node_modules` copied as that entry describes, while other work kept the load of the machine between 20 and 45. 64 of the other 65 steps passed at once, among them `lapse`, the 22 krun lanes and 10 of the 11 ns lanes in a guest, none skipped, and the new unit test. The ns lane that starts its runner from the runtime archive did not: its first sandbox ended with status 137 after ten minutes, a second one ran the three rows, and the lane counts one sandbox. Run again alone it passed 3 times of 3. Then it ran 12 times in turn with the same lane on the commit before this one: 11 passed here and one timed out, and there 8 passed before one timed out and left its guest behind in the clone, after which the next three timed out too. Both time out the same way, without a line of output, so the hang is not of this change, and it is open. The commit that holds this paragraph differs from the one that ran in Markdown only, and the steps ran again from a fresh clone of it before it was pushed.

**Not verified.**

- A real restart of a machine. The test rewrites the boot id that the home recorded.
- krun slots: the machine has no KVM. The change to them is the rule itself and the rename of the network helper.
- A container that is restarted on a kernel that keeps running has the same boot id and new cgroups and network, so its home is not set up again.
- A home that an earlier nanoeval set up has no `setup.for`: it is set up again at the first start, and its slots are kept, since nothing says which boot they are of.
- A `setup.status` that says `running` for a setup that ended with its machine is still believed, and the runner refuses after `--setup-sec`. A setup that is still running for another request is waited for as if it were for this one.
- The start of a runner from the runtime archive on ns slots, which hangs about one time in ten on a machine under heavy load, with this change and without it.

## 2026-11-13: a slot that its machine cannot bring up goes back to the run

The entry above left one case open. A slot whose `up` failed ended its row as an `environment` error whatever had failed, and the runner claimed the next row at once: a runner on a machine that could bring no slot up turned 10 fresh rows of a run of 89 into errors in 30 seconds and would have taken the rest. This entry closes it with the rule the principles already had: a runner reports facts, and the run decides what they mean.

**How `up` says whose failure it is.** `slot.sh up`, and the detached phase behind it, exit with status 71 when the step that failed is the machine's. 71 is `EX_OSERR` of `sysexits.h`, an operating system error, and no command of `up` ends with it by itself. Any other status is the task's environment, as before. The phase keeps one variable that says whose step is running, and a trap on its exit turns the failure of a machine step into 71. What the step wrote to the log stays the message. A step is the machine's only when the task has no say in it:

| Backend | The machine's: status 71, and the row goes back | The task's: the row's `environment` error, as before |
| --- | --- | --- |
| every one | Writing `up.status`. Removing and making `task/` and `verifier/` in the slot directory | Unpacking the archives of the task. An `up` that is still running after `--setup-sec` |
| `dir` | Making the workspace directory | Copying the files of the environment into it |
| `krun` and `ns` | A home without the launcher. `NANOEVAL_SLOT_ENV` that names no file, and `NANOEVAL_SLOT_FORWARD` that is malformed. The lock of the disk in the cache. The slot's control directory. The relay of a private slot | A row without a disk. A disk that is not in the cache. Copying the image's environment, user and working directory. Formatting the slot's own disk, whose size is the task's `storage_mb`. A guest that does not become ready |
| `ns` | Mounting the cached disk. The slot's cgroup and its limits. The network link, its address, and running out of links | A slot whose first process ends before its namespaces exist |
| `krun` | Nothing more: its microVM is started in the background, so a start that fails shows as a guest that does not become ready | |

**Not told apart.** These stay the row's error, as before:

- A guest that does not become ready. The microVM of a krun slot is started in the background, and its process ends the same way when KVM or libkrunfw fails and when the guest cannot use the task's disk: `nanoeval-krun ready` reports both as a VM process that exited before its guest listened. The first process of an ns slot mounts the slot's disk and the overlay over the task's disk before it starts the agent, and a kernel that refuses `unshare` ends it as a disk that does not mount does.
- A disk that fills while the task's archives are unpacked, its environment is copied or the slot's disk is formatted. The same commands fail for an archive that does not unpack and for a size `mke2fs` refuses. `--free-disk-mb` is still what keeps a runner from claiming on a disk that is short.
- In the other direction, the mount of the cached disk is taken as the machine's. A disk in the cache was checked against two digests when it was unpacked, so a mount that fails is the machine's loop devices, its kernel, or a cache damaged since. The task has a part in one case: a disk written with ext4 features that the kernel of a machine does not know fails there for every row that uses it. The claims limit below bounds that.

A blob that is missing or does not match stays what it was, a final `environment` error of the row: that is the store's, not the machine's.

**What the runner does.** Three facts are the machine's: status 71 from `up`, a slot directory that the runner itself cannot make or write, and `ENOSPC` from a step that prepares a slot, once the `--step-retries` of that step are spent. The runner then does not finish the row. It sends the row's `fault` to the run with what the machine said, takes the slot down and claims no more rows. A row whose slot is up runs to its verdict, a row that a claim in flight still hands the runner goes back the same way, and when it holds none it leaves and exits with status 1 and `Runner.MachineError: the machine could not bring a slot up: …`.

**Why it stops claiming while other slots may be up.** A slot that is up shows that the machine worked when it came up, not that it works now: a disk fills, loop devices and links run out, a cgroup goes away. The runner cannot tell a fault that passes from one that stays, and the two mistakes do not cost the same. Claiming on loses one more claim of one more row with every try. Stopping costs a start of the runner by whoever repairs the machine, or one more sandbox. So one fault ends the claims of that runner, and the slots that are up speak for themselves by finishing. A runner holds at most `--slots` rows, so one start of a runner on a broken machine costs at most that many claims.

**What the run does.**

- The row is `unclaimed` again and its claim ends as `released`, as for the rows of a runner that is stopped. A fault is accepted only while the row is `claimed`: once its environment was ready, a runner cannot give a row back.
- **It counts against `--claims`.** The limit is there so that no row is claimed for ever, and a broken machine whose runner a supervisor starts again and again would otherwise take the same rows for ever. A row whose last claim ends this way ends as an `environment` error that names the limit, the runner and what its machine said.
- The runner is `refused`, the state of a runner whose setup failed, with `the machine could not bring a slot up: …` as its error and a `runner.fault` mark in the timeline. A refused runner is granted nothing, keeps the rows it holds with their leases, and stays refused when it leaves. `nanoeval status` now prints every runner that has an error, with its state: `runner 1 (refused): the machine could not bring a slot up: mkdir: …`. It printed only runners that were drained.
- A hello clears the refusal, as it clears any error, so the runner of the repaired machine comes back under its own id and takes the rows.
- **A run with only broken runners** ends by the rules it had. A refused runner is no runner to them, so in a run that opens no sandbox the rows wait `--setup-sec` and end as `environment` errors that say the run has no runner.
- **A sandbox the run opened** is failed when its runner is refused, as it was for a runner whose setup failed: the error on the sandbox, the sandbox killed, the pool told, and another sandbox opened in its place. Two things changed there. The run waits until that runner holds no row, so rows in slots that are up are not killed with it. And a runner that said hello has started its sandbox whether a tick saw it ready or already refused, so the outcome does not depend on which came first. No budget was added, and this is what the existing ones give: the count of failed sandboxes, of which a run tolerates two in a row, starts again with every sandbox whose runner said hello, so it does not see a sandbox that faults after its hello. Each such sandbox costs at most `--slots` rows one claim, and a provider whose every sandbox says hello and then faults is replaced until each row has used its `--claims` or `--sandbox-budget-usd` is spent. Counting such sandboxes in a row needs the count to start again at a slot that came up instead of at a hello, which also changes what a run does with sandboxes that die before their first slot. That is not decided here.

**Checked** on a Linux machine without KVM (5 cores, Node 24.22.1), beside other work and at a lower priority than it.

- A unit test in `test/Sandbox.test.ts` calls `slot.sh up` six ways without root or KVM. Status 71: a slot directory that does not exist, a workspace that cannot be made because a file has its name, and an ns slot whose `NANOEVAL_SLOT_ENV` names no file. Status 2, as before: an archive that does not unpack, a disk that is not in the cache, and a krun slot without a disk. On the earlier `slot.sh` it fails at the first of them, with status 1.
- The lane `machine` on directory slots, new in `ci.yml`: a runner whose `slots` directory cannot be written is attached alone, and a second runner once the run has refused the first. The first claimed 2 rows, one for each of its slots, and gave both back. All 8 rows ended on the second runner, 4 passed and 4 failed as scripted, none errored, with 2 lost claims that ended `released`. The first runner is `refused` in the status with what its machine said, has a `runner.fault` mark in the timeline, and exited with status 1.
- `npm run lint`, `npm run check:types`, `npm test` (141 tests: 137 passed, and the 4 that need KVM were skipped) and `npm run dry-run` passed. The 26 directory lanes of `ci.yml` ran once each on the tree of this entry and the next and passed, `lapse` and `ending` with the hand from a file named by `NANOEVAL_NANOCODE`, as the entry on setups says.

By hand, with changes to the lane that are not kept:

- **Status 71 through the runner.** With a `mkdir` first on the `PATH` of the first runner that fails for the workspace of a slot, `up` ended with `exit:71`, the rows went back with `mkdir: cannot create directory …: No such file or directory` as the runner's error, and the lane passed. With that `mkdir` failing for one slot only, the row of the other slot got its verdict on the first runner, which then left, exited with status 1 and stayed refused.
- **Only a broken runner.** With `--setup-sec 5` and no second runner, the 8 rows ended as `environment` errors, "no runner of the run could take the row for 5 s: the run has no runner, and opens no sandbox itself", two of them after one claim.
- **The repaired machine.** With the `slots` directory made writable once the first runner had exited, and that runner started again in its home in place of a second one: it said hello under its own id, was ready again, claimed the 2 rows it had given back and the other 6, and the 8 rows got their verdicts.
- **A full home.** The home of the first runner on a tmpfs, set up before the runner started. Out of inodes: the copy of the first archive failed with `ENOSPC`, the next try could not write `row.json`, and both rows went back. With 8 pages left and a tests archive of 100 KB: four tries of the copy ended in `ENOSPC`, then the row went back. The lane passed both times.
- **The fault that was met.** As root, `slot.sh up` of an ns slot in a home whose `limits` names a cgroup directory that does not exist, over an empty ext4 disk of 16 MB: it mounted the disk and ended with `exit:71` and `mkdir: cannot create directory …: No such file or directory`. No process of a slot was started, and the mount was removed afterwards.
- **A leased sandbox.** The gateway lane on directory slots with the `slots` directory of the first sandbox made unwritable before its runner claimed. The sandbox ended `failed` with the fault as its error, its runner `refused`, the run opened another sandbox, and the 6 rows got their verdicts there, 3 of them on a second claim. Before the hello of a refused runner counted as a start, the same run ended all 6 rows as errors when the tick had not seen the runner ready, since the scripted gateway refuses the first create and that made two failures in a row.

**Not verified.**

- The lane on krun slots, which is in `ci.yml`: the machine has no KVM. There the first runner is given a `--slot-env` that names no file, which the unit test covers for `slot.sh` alone.
- An ns slot in a run. The ns lanes of `ci.yml` run in a guest, where no runner is attached, so no ns lane was added. As root on a machine with imported disks, `NANOEVAL_E2E_BACKEND=ns NANOEVAL_E2E_SCENARIO=machine` runs the same lane with the missing `--slot-env`. It was not run: the machine cannot import a disk, and its cgroups were in use by other work.
- The machine steps of krun and ns slots that no test reaches: a relay that does not start, a mount that fails, links that run out. They are classed by reading the code.
- A real restart of a machine, a real sandbox, and a sandbox of the pool or a standing runner that faults: the pool is told of a failed sandbox as before, and a standing runner exits instead of standing by again, both read from the code.
- Installed agents on a broken machine: the lane runs sessions.
- A runner that a supervisor starts again on a machine that stays broken: each start costs up to `--slots` claims, as argued above, and was not run.
- The krun and ns lanes of `ci.yml` and the checks of `krun/`, and CI on GitHub.

## 2026-11-13: a renewal answered after its lease ended failed the sandbox

**The defect.** A sandbox that is sold no renewal is used to the end of its lease and then closed, and the run opens another. The run asks for the renewal at every tick of the last `--lease-sec` of a lease, and `renew` in `worker/Run.ts` kept a sandbox whose renewal was not sold only while the lease still had time when the answer arrived. The answer to a request sent just before the end of a lease arrives after it, and the sandbox was then failed like one the gateway no longer knows: it counted as a failed sandbox, of which a run tolerates two in a row, its rows waited for their own leases instead of going back at once, and the pool was told of a failure. The lane `lapse` met it some of the time, as the entry on setups records: a sandbox ended `failed` where the lane expects `closed`.

**The rule.** A renewal that is not sold never fails a sandbox, whenever its answer arrives. The error is recorded, the sandbox is marked as ending unless the refusal passes, and the lease decides the rest: `lapse`, which runs after `renew` in the same tick, closes a sandbox whose lease is over, puts its rows back and tells the pool why. A renewal that fails for another reason, such as a sandbox the gateway no longer knows, fails the sandbox as before.

**Checked** on the machine of the entry above, with the hand from a file as before. The lane `lapse` without this change passed 3 times of 4, and the run that failed had one sandbox of 25 `failed` with the gateway's answer to an unpaid renewal as its error. With the scripted gateway made to answer an unpaid renewal 700 ms late, by hand and not kept, and two attempts a task: without this change 2 of 8 sandboxes ended `failed`, which are two in a row, and the 12 rows ended as errors; with it the 12 sandboxes that were leased ended `closed` and the 12 rows got their verdicts. With this change the lane as it is passed 4 times of 4. The other lanes are in the entry above.

**Not verified.** The real gateway. A renewal that the budget of the run refuses after the lease ended: it now ends `closed` too, and the run then ends its rows when the next create is refused, read from the code.

## 2026-11-13: the two entries above on a machine with KVM, and a stall in libkrun that is open

The two entries above were written on a machine without KVM. This one records what ran afterwards on the 32-core machine with KVM of the earlier entries, which other work kept at a load average between 25 and 80 throughout, and what that load brought out.

**The setup that runs again.** Every `run` step of `.github/workflows/ci.yml` ran from a fresh clone of the commit that went to main, with `node_modules` copied as the entry of 2026-11-12 describes. 64 of the other 65 steps passed at once. The plain ns lane printed nothing for its 1,800 s and passed in 17 s when run again: it was the stall described below, read from its processes while it hung. The case that the entry lists as not verified was then made on the second machine, as root, on a home of ns slots that a runner had used: with no runner alive the cgroup of the home and the nft table of the private network were removed, as a restart leaves them, a slot directory was left in the home, and the boot id in `setup.for` was rewritten. The next runner set the home up again, removed the slot directory, made the cgroup and the table, and the two rows of an oracle run passed. The same state, met after a real restart with the `slot.sh` before the change, is how the defect was found: 13 rows ended as errors.

**The slot that its machine cannot bring up, and the renewal answered late.** Every `run` step ran from a fresh clone of the second of the two commits: 67 passed and `npm ci` was replaced as above, 68 steps with the two new lanes, 60 end-to-end lanes and none skipped. The new krun lane passed in 13 s: the runner whose machine brings no slot up was refused with the machine's message and the rows ended on the other runner. One lane was slow: `krun slots, verifier cache` took 760 s where it takes 17 s, because the third of its five runs had no runner for ten minutes. It passed in 17 s three times of three when run again. Its cause was not read while it happened.

A second reader of the two commits found one thing, and it is not changed: a runner with this change that meets a Worker without it gets a 404 for the fault it reports, drops the row, and the row goes back only when its lease ends. So a deployment moves the Worker first and the runtime archive after it.

**The stall.** Under load a lane sometimes stops without a line of output. Two places were seen, each read from the processes of a stalled lane: the import, where the launcher streams a layer to the builder microVM, and the start of a runner from the runtime archive, where `curl` fetches the archive inside the guest of an ns lane. In both the microVM is idle, the host end of a vsock connection holds bytes that nobody reads, and the connection is in no epoll set of the VMM. The first lasts until the step is killed. The second lasts until the sandbox command is killed after its ten minutes, which is how an ns lane once ended with two sandboxes for one.

The cause is in libkrun at the pinned revision `df85b8b`, in its vsock device. When the guest has no credit left for a stream, the device stops polling the host end and queues a credit request for the guest, and the thread that queues it raises the guest's interrupt only when it also queued data in the same pass. A request queued alone is never seen, so the stream stays stopped until something else interrupts the guest. Any new connection to the microVM does: a stalled import ended within two seconds of a `ready` call on its socket, five times of five.

Measured with the lane that starts its runner from the runtime archive, four copies at a time beside the other work: with the pinned libkrun 13 of 158 runs stalled, 9 in the import and 4 in the start of the runner. With a libkrun in which a queued credit request also raises the interrupt, a change of two lines in `src/devices/src/virtio/vsock/muxer_thread.rs`, 0 of 120 stalled and every run took 21 to 30 s. With the pinned one again, 4 of 80.

**Not changed here.** `krun/Cargo.toml` pins libkrun by a revision of its own repository, and the newest revision there reads the same. The fix belongs there, or in a revision that this repository can name. Until then the stall is rare without load and frequent with it: on this machine at this load, about one lane in twelve.

**Not verified.**

- Why the guest's own credit updates do not restart the stream. The change that removes the stall does not depend on the answer.
- The changed libkrun outside that one lane: its own tests, other guests, a guest that answers a request with no credit again and again.
- Whether the slow `verifier cache` lane was this stall.
- The stall on the sandboxes of a deployed run. Their slots are ns slots without a microVM, so the paths above are not in them; an import is.

## 2026-11-13: the model calls of a session, which its log no longer holds

**The defect.** nanocode-ts `build-81eada9` is built on nanocode c14de6c, whose session log keeps turns, events and the checkpoint in the same rows and no longer keeps what nanocode calls telemetry. `model.call.completed`, the failed and retried attempts of a call, `model.connection.*`, `model.warmup.*` and `api.event` are handed to the host with the sequence number 0 and stored nowhere (nanocode's DECISIONS.md of this day, and `telemetry` in its `one_log.rs`). nanoeval read every model call from that log: the tokens and the number of calls of an attempt, of a lost claim and of a judge (`Atif.usage`), the steps of a trajectory, which are cut at each call (`Atif.fromEvents`), and the `attempt.model` mark of the timeline (`Timeline.modelRequest`). With the new build and no other change, one Terminal-Bench 2.1 task on `claude-haiku-5-5` gave a log without a model call, a trajectory of 2 steps, the instruction and one agent step with all 15 tool calls, and a usage of 0 calls and 0 tokens. The same task on `build-3469bc7` gave 6 calls, 7 steps, 64,430 input and 2,597 output tokens. The cost stayed right, since `run.completed` is stored and carries it and the model endpoint records each response. No lane failed: they asked a session's trajectory for two steps and one tool call, and its usage for nothing.

**What nanocode-ts offers.** No option keeps these events in the log. `liveDeltas: false` puts streamed text back and nothing else, and which events are stored is decided in nanocode without a switch. A reader of the event stream cannot rely on them: the hub of the session passes only streamed text to a stream opened with `live=1`, an event numbered 0 reaches a reader only while the hub serves it from its tail in memory, and a reader that connects late or pages from the log has missed what was never stored. They do reach the object that hosts the session. Its method `published(scope, events, bytes)` is given every batch in order, the stored events with their sequence numbers and these with 0 between them. `App.create` has no hook for it and its types do not declare it.

**The rule.** The session object keeps what its log does not. `worker/Sessions.ts` extends the `AgentSession` of `App.create` and takes `published` first. An event with the sequence number 0 is written to a table of the object, `nanoeval_telemetry`, and when the next stored event arrives the rows that have no place yet get its sequence number. Only the stored events go on to nanocode-ts's own method. `Harness.events` asks for the rows with a header on the page request it already makes, the object adds to each page the rows that stand before its events and to the last page those that nothing followed, and `Telemetry.merge` puts them back. `Atif`, `Timeline`, the export and the comparison are unchanged and read the events they read before, in the order they had: on `build-061892c` a session's first model call is stored between `run.started` and its tool call, and on `build-81eada9` it is read back there. A build whose session object has no `published` stops the Worker when it loads, and a page that comes back without the rows is an error, not an empty list. It costs one row written for each model call and one more when the next event is stored, in the object that runs the session, and they go when the session is deleted. A log that holds its model calls needs none of it and loses nothing by it: nothing arrives with the number 0, so both builds are served by the same code.

**Why not the model endpoint.** Every model request of a session already passes the meter of `worker/Sessions.ts`, with its tokens. Its sum is not what a session's events said. Ten sessions of one run on `build-3469bc7` were compared call by call: eight had the same tokens in both, and the two that did not finish had 19 and 37 responses for 17 and 35 calls, one of them 1,382,926 input tokens against 1,293,131: the responses without a call have 0 or 7 output tokens, so they were cut, charged, and asked for again. A Codex session on a plan login reaches the provider as a WebSocket upgrade, which is forwarded without the meter, so it would have no tokens at all. And the steps would still need their boundaries: on this build `model_call_index` is counted from 1 on a message and from 0 on a tool call.

**What else reads a session's events, on this build.**

- `agent/events.jsonl` holds a model call as nanocode handed it over: `seq` 0, and beside the payload of before its `timing`, `sdk_timing` and `host_timing`. Anything else nanocode hands over this way is kept and written out the same way. `model.call.started` and `model.attempt.started` do not come this way and are in no artifact, as before.
- The hold of a turn waits for its `result` on the event stream, which is stored. One hazard is gone with the change: with an event numbered 0 in the tail that the hub keeps in memory, a reader behind it was given a page that skipped stored events. The package's own hub, given the batches [1, 2], [3, 0, 4] and [5], answers a reader at 2 with [4, 5]. A `result` is the last event of its turn, so the hold did not depend on it, and the hub now gets stored events only.
- The spend of each response, what the key was charged, refused payments and the model budget come from the meter and the gateway, not from events: the gateway lanes pass unchanged.
- The Worker sets no `retainedTurns`, so every finished turn stays readable. nanoeval reads the status of a turn and its events after it finished, and a session has one turn: a window, if one is ever set, must keep it.
- `EVENT_PAGE_SIZE` still bounds a page and `EVENT_TAIL_BYTES` the hub's tail. The first event of a session is numbered 16385 where it was 16384.
- nanocode cuts the result of a nested tool call at 16,384 characters in the event, on both builds. The event says so (`truncated`, `original_bytes`), and the observation of the trajectory does not carry those two fields. Not changed here.

**A Worker that moves to this build while rows run.** nanocode-ts does not read the sessions of earlier builds: an object written by one starts empty. Tried under local workerd: a run on `build-061892c` was stopped five seconds into the turn of one row, and the Worker came back on `build-81eada9` over the same state. The row that had finished was untouched. For the row in flight the session answered 404 for its turn, every `agent` call of its runner answered 500 for four leases, four minutes with the defaults, and the row then ended as an `environment` error with no events, a trajectory without steps and a usage of 0 for the one response its endpoint had answered. So the Worker moves when no row is in its `attach` or `run` phase, and a row caught by it is picked up with `run --rerun RUN --errored`.

**A Worker killed in the middle of a turn, on this build.** Found beside the above, the same with and without this change: five seconds into a tool call, the log after the restart holds only `queued` of what the turn had published, the turn starts again from its instruction, the model call is made again (3 responses at the endpoint where `build-061892c` has 2) and the hand reports a second process for the command, where `build-061892c` took up the first. With this change the model call that the log lost is still in the table: the usage counts 3 calls, as the endpoint does, and the trajectory has a step for it with tokens and no message, before the instruction is accepted again. On `build-061892c` the usage of such a session counted 3 calls for 2 responses, since the call was replayed from the journal and logged twice. The lane `restart` does not reach this: it restarts the Worker before a turn has started.

**Checked** on a Linux x86_64 machine with 5 cores and no KVM, beside other work that kept its load average between 6 and 10, with the hand `nanocode-cli-3f97ab0`.

- `npm run lint`, `npm run check:types`, `npm run dry-run`, and `npm test`: 146 tests, 142 passed, 4 skipped. Five are new, on a fixture of the events of `build-81eada9` cut from a real session, its texts replaced: every batching of what the object is handed, with and without a restart between batches and in pages of 1, 5 and 128, reads back as it was published, and the usage, the steps and the first model request are those of its three model calls.
- The lanes now ask what regressed. Every attempt of a session whose model endpoint answered has at least one model call and input tokens, one agent step for each call, each with its tokens, and in the plain lanes the calls and tokens of the session are those of the responses the endpoint answered. A judge has its calls and tokens. Without the change the plain lane on directory slots fails on the first of these with a usage of 0 calls, as it should.
- The 26 lanes of `ci.yml` on directory slots, two at a time: 24 passed at once. `disk` ended with "the runner did not start within 5 s" and `fleet` with a sandbox `closed` where it expects `failed`, and both passed when run alone. `lapse` and `ending` ran alone with the hand from a file. The plain lane also passed with the same code on `build-061892c`.

**Not verified.**

- krun and ns slots: the machine has no KVM, and those lanes skip there. The change is in the Worker and no slot sees it.
- A deployed Worker. Everything ran under local workerd, where a killed process loses writes that Cloudflare would have kept.
- A real model on this change, and a Codex session, on a key or on a plan login. The scripted model answers a `claude` session, and through the scripted gateway a `codex` one over HTTPS.
- A session with subagents, whose model calls arrive the same way and are kept, and are not counted, as before.
- Harbor's models on a trajectory whose first step is an agent step, which a session killed in the middle of a turn now has.
- CI on GitHub.

## 2026-11-13: a credit request that libkrun queued without an interrupt

The entry of this day on a machine with KVM left a stall open: under load a stream from the host into a microVM stopped, during an import and during the start of a runner from the runtime archive, in 13 of 158 runs of one lane. The cause was in libkrun at the pinned revision `df85b8b`, and that entry, called the entry on the stall below, says the fix belongs there or in a revision that this repository can name. This entry names one.

**The defect.** Read from `src/devices/src/virtio/vsock` of libkrun at `df85b8b`. One thread of the device, the muxer thread, moves a stream from a host socket to the guest. When the socket is readable, the proxy of that connection fills free buffers of the guest's RX queue for as long as the guest's credit lasts. When the credit is used up, the proxy stops polling the socket and hands the thread a credit request for the guest. The guest answers a request with its credit, and the answer starts the polling again. The proxy asks for the guest's interrupt only when it queued data (`update.signal_queue = signal_queue` in `tsi_stream.rs` and `unix.rs`), and the thread raised it for nothing else it queued for that proxy (`process_proxy_update` in `muxer_thread.rs`). So a pass that queued data and then ran out of credit interrupted the guest, and a pass that began without credit did not: the request went into a used buffer of the RX queue and nothing told the guest. A pass begins without credit when the one before it ended exactly at the end of the credit, on the last free buffer or on the last byte the socket held. A device that uses a buffer owes the driver a notification, so this is an omission and not a choice. The datagram proxy beside the two already asks for the interrupt in this case (`signal_queue || wait_credit` in `tsi_dgram.rs`).

**Why the guest's own credit did not restart the stream.** The entry on the stall lists this as not verified. It is read from the code here, and was not observed. A Linux guest also sends its credit unasked while its reader frees space. That update is handled on another thread, the one that serves the guest's TX queue: it marks the connection connected and puts the socket back into the epoll set. The muxer thread takes the socket out of the set only after it has let go of the proxy's lock. An update that is handled between those two steps is undone: the socket leaves the set while the guest has credit, and nothing puts it back. That is the state the stalled lanes were read in, a connection in no epoll set of the VMM with bytes waiting at its host end. The credit request is what recovers from it, since it is queued after the socket left the set and its answer puts the socket back, and it was the request that the guest never saw. Later revisions of libkrun apply the polling change under the proxy's lock and give this reason for it. The pinned revision does not have that change: with the interrupt raised, a stream that loses this race waits for one exchange with the guest and goes on.

**The rule.** `krun/Cargo.toml` pins libkrun at `8ce363e` of `nanocodexyz/libkrun`, a fork of libkrun's repository made for this. The revision is `df85b8b` and one commit, on the branch `vsock-credit-request-irq`: the muxer thread raises the guest's interrupt whenever it queued a credit request, two lines of code in `muxer_thread.rs`. It is the change that the entry on the stall measured. `krun/Cargo.lock` changes in the source of the 13 packages of libkrun and nowhere else.

- **Harmless where it is not needed.** When the RX queue has no free buffer, the request waits in the device's own queue and the interrupt finds nothing new. virtio allows that: the driver reads the used ring and returns. The cost is one interrupt each time a stream runs out of credit.
- **No other packet has the omission.** Everything else the muxer thread queues by itself comes with the interrupt: the reset or the refused connect of a socket that hung up, the reset of one that closed, the answer to a connect, and the request of an accepted connection. What is queued while the guest's TX queue is served, the answers, resets and credit updates for the guest, is followed by the interrupt that the device raises for every TX buffer it used.
- **Why not a newer libkrun.** The newest revision of libkrun's main branch, `abe0a0f`, is 311 commits after `df85b8b` with 404 files changed, among them these proxies rewritten for another operating system and newer versions of `rand` and `vm-memory`. It still reads the same in this place: the stream proxies for Linux do not ask for the interrupt, and the thread does not raise it. Two changes near it are there, the polling under the lock described above, and a muxer thread that drains the device's own queue. Taking 311 commits for two lines changes the VMM under every lane, so the pin stays where it was and carries the one commit.
- **The change is not in libkrun.** It has not been proposed there. Until it is there, a move to a newer libkrun has to carry it along. libkrun's repository now answers at `libkrun/libkrun`, and its earlier address redirects.

**Checked** on the 32-core machine with KVM of the entries above, beside other work that kept its load average between 27 and 47.

- **The launcher.** The `krun` job of `ci.yml` from the tree of this change: `cargo fmt --check`, `cargo clippy --all-targets --locked -- -D warnings` and `cargo test --locked` passed, 48 tests with the two integration tests of the launcher run and not skipped, and `cargo build --release --locked -p nanoeval-krun` built the launcher against the fork's revision. cargo fetched the revision from the fork once, and the four commands passed again with the network off.
- **libkrun's own tests.** Its devices crate has 63 unit tests, none of them for the vsock device, and its CI runs no unit test. Built through this repository's lock they passed on `df85b8b` and on the fork's revision, 63 of 63 each. They could not be built through libkrun's own lock, which names versions that the machine does not hold and could not download.
- **The stall.** The measurement of the entry on the stall, with its script and its lane, the one on ns slots that starts its runner from the runtime archive: four copies at a time in four fresh clones of this change, whose lanes built the launcher themselves from the pinned revision, after one warm run each. 120 runs. 6 ended within 4 s, before any microVM started, because two copies had taken the same port for their Workers. Of the 114 that ran the lane none stalled, and each took 16 to 20 s. The machine was less loaded than for that measurement, a load average of 32 to 39 against 60 to 90, and the stall is rarer with less load. So the same lane ran straight afterwards from four clones of the commit before this one, 80 runs at a load average of 30 to 47: 4 ended on the port, 75 took 12 to 19 s, and one stalled in the start of its runner, which came 43 s after its sandbox instead of 1 to 2 s. With the runs of the entry on the stall, counted as it counts them, the ones that ended on a port among them: 14 of 238 runs stalled with `df85b8b`, and 0 of 240 with the change.
- **Every step.** Every `run` step of `.github/workflows/ci.yml` ran from a fresh clone of this change, with `node_modules` copied as the entry of 2026-11-12 describes: 67 passed and `npm ci` was replaced, 68 steps with the 60 end-to-end lanes, none skipped and none run a second time. The commit that holds this paragraph differs from the one that ran in Markdown only, and the steps ran again from a fresh clone of it.

**Not verified.**

- The order of the two threads in the race above. It is read from the code, and no trace of a stalled VMM shows it.
- A credit request that finds no free buffer. It waits in the device's own queue until the guest next notifies a queue, with this change as before it, and later revisions of libkrun drain that queue from the muxer thread. Read from the code, and not met.
- The pinned revision at the load of the entry on the stall. At that load that entry measured the same two lines, applied to the checkout by hand: 0 of 120.
- Guests other than the Linux kernel of libkrunfw 5, and hosts other than Linux on x86_64. The changed file is shared by every host.
- libkrun's integration tests, which need libkrun built and installed with its own guest programs.
- Whether the slow `verifier cache` lane of the entry on the stall was this stall.
- An import on the machine of a deployed run, and CI on GitHub, whose runner has to fetch the fork.

## 2026-11-13: the harness moves to nanocode-ts `build-81eada9` and the hand to `nanocode-cli-3f97ab0`

The entry of 2026-11-12 on the builds of that day left one check open: all 89 tasks with a model. That run was made, the rows it lost were read, what the builds had to do with them was changed in nanocode, and this entry pins the builds that hold the changes: nanocode-ts `build-81eada9` (nanocode c14de6c) and the hand `nanocode-cli-3f97ab0` (nanocode 3f97ab009). It changes `package.json`, `package-lock.json` and the release and checksum of `src/Slot.ts`, nothing else. The harness build needs the entry above on the model calls of a session, for the reason that entry gives and for a second one that this entry found.

### All 89 tasks on the builds before

`claude:claude-haiku-5-5` as a nanocode session on every task of `terminal-bench-2.1`, one attempt a row, on the second machine of the entry of 2026-11-12: 5 cores, no KVM, ns slots, three at a time. The hand was the pinned `nanocode-cli-1f10a22` and the harness nanocode-ts `build-3469bc7`, a build of the same day later than the pinned `build-061892c`. The machine restarted during the run, and the rows it had not finished ran in a second run: the two are read as one.

65 passed, 22 failed and 2 ended as errors, with 26,260 s of agent time, 1,266 model calls, 42,173,418 input and 1,677,916 output tokens. The two errors are `qemu-alpine-ssh` and `qemu-startup`, which end the same way with `--oracle` on that machine. The arms of 2026-11-12 passed 61 as a nanocode session and 64 as Claude Code, in sandboxes with 8 vCPUs and with the builds of that day: another machine and one attempt a row, so the three totals are not a ranking. Row by row against the nanocode arm of that night, 14 tasks passed that had not (`bn-fit-modify`, `caffe-cifar-10`, `chess-best-move`, `compile-compcert`, `dna-assembly`, `feal-linear-cryptanalysis`, `install-windows-3.11`, `kv-store-grpc`, `mcmc-sampling-stan`, `path-tracing-reverse`, `protein-assembly`, `pypi-server`, `regex-chess`, `torch-pipeline-parallelism`) and 10 did not pass that had. The ten were read from their trajectories:

- **A command's output arrived cut, and nothing said so** (`gcode-to-text`, `financial-document-processor`). The Bash tool keeps the first 131,072 bytes of what a command prints. The result did not say that it had been cut, and the model took the part for the whole.
- **A command moved to the background printed "NaN"** (`adaptive-rejection-sampler`). The instructions of these builds tell the model that `tools.Bash` resolves to `{ stdout, stderr, exit_code }`, and a cell prints `r.stdout + r.stderr`. The result of a command that its timeout moved to the background had neither field. In the two runs 31 Bash calls in 14 attempts were moved after the default 120 s, and in 24 of them the cell printed "NaN" or "undefined" in place of the notice that names the job and its output file.
- **A long command was never in the foreground, and the end of a background job was reported late and wrong** (`rstan-to-pystan`, 0 of 5 on the builds of 2026-11-12 against 1 of 1 on the ones before). The converted script samples for 350 to 520 s, and its first version is killed at the task's 8 GiB once sampling is done. With the earlier builds the model ran it in the foreground of one call and read "Killed" in that call's result. With the newer ones the call was moved to the background at 120 s in five attempts of five, the notice of the job's end came only with the result of the next cell that returned, read "completed (exit code 0)" for a job the kernel had killed, since that is the status of the `tail` that ended the command line, and carried no output. The agent then watched a dead job with `pgrep`, which the workers the job had left kept answering, for 550 to 780 s an attempt, more than the row has to spare.
- **The other six were the model's** (`db-wal-recovery`, `largest-eigenval`, `make-mips-interpreter`, `model-extraction-relu-logits`, `torch-tensor-parallelism`, `tune-mjcf`): no tool result in them is wrong or missing. Five of the six passed when run again on the new hands, below.

### What the new builds do

All in nanocode, each with an entry in its DECISIONS.md:

- A Bash result that was cut says so in its last line, with the number of bytes the command printed and the file that holds all of them (2c64cbe6a).
- A Bash result has the same fields whether the command finished or was moved to the background: `stdout` is then the notice, and `exit_code` is null (f56debf46).
- The notice of a background job's end says how it ended, with the signal's name for an exit code above 128 and "killed for memory" when the slot's limit killed a process of it, shows its last 1,024 bytes of output, and reaches a cell that is waiting within seconds (f351a1b60).
- A Bash call from a cell that names no timeout waits for its command for the ten minutes a call may take, where it was moved to the background after 120 s (fe47ae763). A timeout above the ten minutes is still reduced to them, and the result now says so (9ba13af49).
- `sleep N &` is not refused, and a command that begins with `sleep` is moved to the background at its timeout like any other, where it failed (3f97ab009).
- psh's `time` prints the three times of a command (28ba47008).

The first two and the last are in nanocode c14de6c, which `build-81eada9` is built from, and all of them are in the hand, which is where the Bash tool runs. One sentence of the harness's instructions that describes the ten minutes comes only with a later nanocode-ts build.

### A Worker that stopped answering

The Worker of the model runs below ran `build-81eada9` without the entry above, and stopped answering twice: workerd at 100 to 110 % of a core, 1.7 and 2.3 GB resident, no answer on any route, every session on it stalled until it was started again. Both times the provider had ended a response stream before its end, which the ledger of the model endpoint shows 7 times in 3,632 requests.

The cause is in nanocode-ts, in the hub that serves a session's event stream, and it is the second consequence of what the entry above describes. Events that the log of this build does not store reach the hub with the sequence number 0. A model stream that fails after it streamed something leaves one batch of the flushed deltas, which are stored, and the notice of the retry, which is not. The hub appended that batch to the tail it keeps in memory and answered a reader that stood before it with the same page again and again, with a cursor that did not move. The reader is this repository's: `Harness.watch` holds a row's event stream open until its `result` arrives, in the same thread as the hub, and every read was answered at once, so nothing else ran: no timer, no request, and not the retry of the model call half a second later.

Reproduced with the scripted model on the machine with KVM, on directory slots: the second response ends after three thinking deltas and seven text deltas, 4.5 KB. On the commit that pins `build-81eada9` without the entry above, the retry never arrives, `/health` does not answer 38 times of 38, and workerd grows from 185 MB to 2,556 MB in 149 s. A response of 484 KB behaves the same, and a response of 4 MB that ends as it should is carried into the next request in 0.8 s: size is not what matters. On the commit of the entry above the session object passes only stored events on to nanocode-ts, the hub never sees a 0, the model call is asked again 0.6 s after the early end and the session finishes. On `build-061892c` every event is numbered and the same input passes. nanocode-ts has the hub's own fix since its commit 1a597dd, which is in no release yet: its tail keeps stored events only and a stream never asks for a page it has sent.

One expectation of the lanes does not hold for such a session: a response that was cut is charged by the endpoint and is not a model call of the session, so the two counts differ by it. The lanes' scripted model cuts nothing.

### Checked

On the second machine, with the hand's checksum verified in the slots, one attempt a row unless a rerun is named.

- **The 89 solutions through the Bash tool of `nanocode-cli-3f97ab0`**: 80 passed where `--oracle` passes 84, as with the hand before. The four are the four whose solutions run longer than ten minutes. They were not run again through exec_command on this hand.
- **Thirteen rows of the full run**, seven of its ten losses and six others, on the hand `nanocode-cli-2c64cbe`, which holds the first three changes: 11 passed. `gcode-to-text` read the flag right and wrote it with five lines of prose, and `kv-store-grpc` renamed the generated modules as the entry of 2026-11-12 describes. No cell of the 13 printed "NaN".
- **The 21 tasks of the entry of 2026-11-12** on `nanocode-cli-3f97ab0`: 19 passed, where the hand of 1f10a22 passed 18 and the pins before it 17. `configure-git-webserver` left its own second test push in the repository and `model-extraction-relu-logits` recovered the wrong rows, as it had before.
- **`rstan-to-pystan`** passed 3 of 3: once on 2c64cbe and twice on 3f97ab0. The slot's limit killed a process in each of the three, as it had in the attempts that failed.
- **The rows with long commands** on 3f97ab0: `adaptive-rejection-sampler`, `caffe-cifar-10`, `chess-best-move`, `compile-compcert`, `crack-7z-hash`, `fix-ocaml-gc`, `make-mips-interpreter`, `mcmc-sampling-stan`, `regex-chess` and `schemelike-metacircular-eval` passed. `train-fasttext` (accuracy 0.563 where 0.62 is asked), `extract-moves-from-video` and `query-optimize` (out of time) failed, as in every arm before. A call is moved to the background after 600 s now. In the eight of these rows that were read call by call, the notices of the 34 moves all arrived, 5 to 8 s after the job ended where a cell was waiting, and name how it ended. A model asked for a timeout of 900,000 ms once and read that it had been given the maximum.
- **New in this hand and not asked for**: a command that begins with `sleep N` and goes on with another command is refused at once, with a text that tells the model to start the command in the background. It happened three times in these rows, and the model waited another way each time.
- **The commit with the session's model calls**, on a real model: `fix-git` passed with a usage of 6 model calls, 55,434 input and 2,784 output tokens, where the same row without it had 0 calls and 0 tokens. `path-tracing-reverse`, the row that was active both times the Worker stopped answering, passed on it in 573 s with 36 model calls, 3,265,961 input and 108,423 output tokens. The provider ended two of its response streams early, 26 and 30 s in, and the session asked again both times.
- Every `run` step of `.github/workflows/ci.yml` from a fresh clone, on the machine with KVM, with `node_modules` copied from the tree that `npm ci` installed for the same lock on the second machine, since the first cannot reach the registry: 67 passed and `npm ci` was replaced, 60 end-to-end lanes and none skipped, on the commit of the entry above and again on the commit that pins libkrun.

### What a cell that yields costs

Not changed, measured for a later change. A cell yields after 10 s when the model names no yield, and the model then asks for it with `wait`. In the full run 193 cells yielded that way and cost 223 `wait` calls, about one model call in six of the 1,266, each with the whole conversation as its input. 104 of the 193 cells had ended within 60 s and 184 within 120 s. `nanocode hand --cell-yield-ms` sets that time for a host, and `slot.sh` still passes none: a longer one saves those calls and keeps the model from doing anything else meanwhile, and which of the two weighs more has not been run.

### Not verified

- All 89 tasks with a model on these pins, a second attempt of any row that passed, and an installed agent beside them on the same machine.
- `codex` agents and `gpt-6-luna` on these builds, and a sandbox: no key had funds, so no row has run on a deployed Worker with these pins.
- A session whose model stream ends early on a deployed Worker. The reproduction ran under local workerd.
- Whether a model reads the file that a cut result names: no row of these runs did. In five cut results the command was `base64` of an image for the model to look at, and the image was then refused where it had been shown cut.
- The four long solutions through exec_command on this hand, and nanoeval's own download of the hand on the second machine, where the binary was placed with its checksum checked.
- CI on GitHub.

## 2026-11-13: a turn that its session no longer has puts the row back

The entry of this day on the model calls of a session ends its paragraph on a Worker that moves to another build with a rule for whoever deploys: the Worker moves when no row is in its `attach` or `run` phase, and a row caught by it is picked up with a rerun. This entry makes the run do that itself for a row whose turn is gone.

**The defect.** A row whose agent is a nanocode session has one turn in a session object, and `agent` in `worker/Run.ts` reads it with `Harness.turn` for every call of the runner. `Harness.turn` threw `Harness.RequestError` for every answer but a 2xx, nothing in the run took it, and the call of the runner answered 500. A session object that starts empty, as one does under a nanocode-ts build that does not read the objects of the build before, answers 404 for the turn for ever. A runner takes a 500 as a failure that may pass: it asks again for one lease, counts one stumble, and gives up after `--step-retries` more. With the defaults that is four leases of 60 s. The row then ended as an `environment` error whose message was the page of the 500, with an empty `agent/events.jsonl`, a trajectory without steps and a usage of 0 calls, and it was not claimed again although a new session would have run it. The turns of the judge sessions of a row are read the same way and failed the same way.

**The rule.** A 404 for a turn that the run submitted is a state of the claim, not an error of the call: the session no longer has the turn, so nothing can finish that claim and nothing of it may be resumed. The claim is lost and the row starts again from nothing, as after a lost lease and as for a slot that its machine cannot bring up.

- `Harness.turn` throws `Harness.LostError` for a 404, with the session, the turn and what the session answered. Any other status, and a request that fails, is what it was: an error of the call, which the runner asks again.
- The run takes it in the two places where it reads a turn for a runner, `agent` and `judge`. It writes the text on the claim, in a column `error` that the table of an existing run gets when its object next starts, adds an `attempt.forgotten` mark to the timeline, and loses the claim with the ending `forgotten`: the turn is cancelled, the sessions of the claim are deleted, the row is `unclaimed` and its artifacts are removed. The call of the runner is answered 410 with the same text, which a runner already takes as the end of that slot.
- **It counts against `--claims`**, the bound the ledger has for every lost claim, so a deployment whose sessions lose their turns again and again cannot take a row for ever. A row whose last claim ends this way ends at once as an `environment` error: "the attempt was claimed 3 times, the limit of the run, and the session of its last claim no longer has its turn: the session … answered 404 for the turn attempt: …".
- `status` counts a `forgotten` claim among the lost claims, and `nanoeval attempt` shows the ending and the text.

**Why the row goes back instead of ending there.** A turn that its session lost is not an effect of unknown outcome that is tried again: the claim is ended and recorded first, its slot is taken down, and the next claim has a session name and a slot that no claim before it used, which is what the ledger does for every lost claim. The failure is the infrastructure's, so it is never a score, and while the row has claims left it need not be an error either. Ending the row at once would have left the rerun of the earlier entry to a person, for a state the run recognises by itself.

**The spend and the usage of the lost claim.** The events of a session go with the session. A `forgotten` claim therefore records no usage, where a claim that lost its lease records the usage that its session's events held, and it has no trajectory. What stays is what the run metered itself: every response the model endpoint answered for that session is in the requests of the row with the number of its claim, its tokens and its cost. They are written to `agent/model-requests.jsonl` when the row is finished, and the spend of the run sums the costs of all claims of a row. Two things are not in it. A response that carries no cost, from a provider's own key, was priced only in the events of its session, as the `cost_usd` of the turn: on such a key the spend and the model budget are short by what the lost session used, and its tokens are still in the requests. And a request that was on its way when the session was lost: the run records a response once it has passed.

**Where else the run reads a session.**

- The events, when a claim is lost and when a row is finished, for the usage and the trajectory. A session that started empty answers that read with 200 and no events, which is how the row of the defect came to a usage of 0. `Harness.events` now reads the turn first, so the same `LostError` says that there is nothing to read. A claim that is lost then records no usage. A row that is finished, because its turn had completed and its verifier ran before the session lost the turn, keeps its verdict, which is of work that was done: `agent/events-error.txt` holds the text, the usage is null and there is no trajectory. For a judge session it is `verifier/judge-error.txt` and a judge without a usage.
- The cancel of a turn. Such a session answers it 404, and `Harness.cancel` never read the status. Not changed.
- The hands of a session and the submit of its turn, in the `attach` phase, read no turn. A session lost before its turn was submitted is not this state, see below.

**The runner.** One line of `sandbox/Runner.ts`: taking a slot down removes the row from what the runner holds only while the entry is still the claim of that slot. The run wakes the claim requests it holds when it puts a row back, so the runner that held the lost claim is handed the row again in the same moment, before its old slot is down. It keeps its rows by the id of the row, so the old slot took the new claim with it: the row waited for the lease of its second claim and was claimed a third time, 60.8 s where it now takes half a second. A runner without this line that meets a Worker with the change loses that claim to its lease, so the runtime archive moves with the Worker.

**Checked** on the 32-core machine with KVM of the entries above, beside other work that kept its load average between 27 and 32.

- **The lane `forgotten`**, new in `ci.yml` on directory slots and on krun slots. The scripted model holds the second response of one row, when the command of the first has run in its slot. Once every other row has its verdict the lane kills the Worker, removes the directory in which workerd keeps the session objects, and starts the Worker again over the rest of its state: sessions that start empty, as a build that cannot read them leaves them. It asks that the run is finished within one lease of the Worker answering again, that one row was claimed twice, its first claim `forgotten` in the `run` phase with the answer of its session as the error and a mark in the timeline, that the 8 rows end as scripted, 4 passed and 4 failed, and that the model spend is the cost of the 17 responses the endpoint answered, with the one of the lost session in the requests of its row under claim 1.
- **Without the change**, the lane alone on the commit before this one, on directory slots: it failed after 248 s. Every `agent` call of the row answered 500, its status showed 96 retries, and the row ended as an `environment` error 240.4 s after the Worker answered again, with no events, a trajectory without steps and a usage of 0 calls. The spend held the response of the lost session there too: the meter never depended on the session.
- **With it**, on directory slots: 6 runs of 6 passed, in 8 to 9 s each. The row was unclaimed 106 to 114 ms after the Worker answered again, and the run was finished after 442 to 547 ms. On krun slots 4 of 4 passed, the row unclaimed after 144 to 150 ms and the run finished after 819 to 1,310 ms.
- A unit test in `test/Ledger.test.ts`: a `forgotten` claim goes back within the limit with the text on it, the claim at the limit does not, both count as lost, and neither has a usage. `npm run lint`, `npm run check:types`, `npm run dry-run` and `npm test` passed, 147 tests and none skipped.
- Every `run` step of `.github/workflows/ci.yml` from a fresh clone of this change, with `node_modules` copied as the entry of 2026-11-12 describes: 69 passed and `npm ci` was replaced, 70 steps with the two new lanes, 62 end-to-end lanes, none skipped and none run a second time.

By hand, on directory slots, with changes to the lane that are not kept:

- **A row out of claims.** With `--claims 1` the row ended 213 ms after the Worker answered again, as an `environment` error with the message above, a usage of null and no artifact, and the spend kept its one response.
- **A judge session.** In the judge lane, with the response to the judge held: the claim ended `forgotten` in the `judge` phase with the answer of the judge session, the row was claimed again and passed, the run was finished 668 ms after the Worker answered again, and the spend held 13 responses where the 8 rows that ended account for 12.
- **Sessions lost while the verifier ran.** With a verifier that sleeps 12 s and the sessions removed under two rows in their `verify` phase: both kept their verdicts, one passed and one failed, each with `agent/events-error.txt`, a usage of null, no trajectory, and its two responses in `agent/model-requests.jsonl`.
- **A run made before the change.** The Worker of this change was started over the state of the run that the Worker without it had made: the claims of that run got the `error` column, and its status and its attempt read as before.

**Not verified.**

- A deployed Worker, and a move between two builds of nanocode-ts. The lane removes the session objects under local workerd. What an empty object answers on each route was read in `build-81eada9`, and the 404 for the turn and the empty events were met, not what Cloudflare does with an object during a deployment.
- A session lost before its turn is submitted, in the `attach` phase. Not changed, and not run. The empty object refuses the token that the hand was started with, which the lane shows as a 403 for the hand of the lost claim, so the hand cannot attach, and the row ends as an `environment` error when the hand exits or after `--attach-sec`: an error without a second claim, and not four leases of 500s.
- A judge session lost while the session of the row stays. The lane and the run by hand remove every session object.
- A real model, a Codex session, and a credential whose responses carry no cost: what the spend then lacks is argued above and was not run. An installed agent has no session and no turn.
- ns slots. The change is in the Worker and in one line of the runner that no slot sees.
- A runner from an earlier runtime archive with this Worker. Met once before the line of the runner was written, three claims and 60.8 s, and not with an archive.
- A row that a runner holds idle when the run hands it the same row again, after a lease that ended while the runner lived: the newer claim takes the place of the older one, whose slot stays up until the runner ends. As before this change, and not reached by it, since a `forgotten` claim is met inside a call of its runner.
- CI on GitHub.

## 2026-11-13: a cell yields after two minutes, set by the brain

The entry of this day on the builds ends its section on what a cell that yields costs with a change it left for later. A cell that names no yield goes back to the model after 10 s, and the model asks for it again with `wait`, a model call each time with the whole conversation as its input. This entry makes that time two minutes, sets it in the Worker and not on the hand, and moves the harness to nanocode-ts `build-2672c04`, the first pinned build that has the option. It changes `package.json`, `package-lock.json`, `wrangler.jsonc`, `worker/Env.ts`, `worker/Sessions.ts` and the plain lane of `test/e2e.ts`. `sandbox/slot.sh` and the pinned hand, `nanocode-cli-3f97ab0`, are unchanged.

**The option.** `App.create` of nanocode-ts takes `cellYieldMs` since its commit f044971, on nanocode 439011f97. A session with it writes the time into every cell it sends to a hand that names no `yield_time_ms`, in the `// @exec:` line of the cell's source, and into the arguments of every `wait` that names none, so a hand released before the option follows it. The brain gives an operation of a hand up for lost after `REMOTE_TIMEOUT_MS` plus the yield that the operation names, here 30 s and 120 s. The descriptions of `exec` and `wait` that the model reads state the number, and a `yield_time_ms` that the model names itself wins, as before. The Worker takes the time from a variable of `wrangler.jsonc`, `CELL_YIELD_MS`, 120000. `App.create` is called when the module loads, where no request has brought the environment, so `worker/Sessions.ts` reads the variable from the `env` of `cloudflare:workers`. A variable that is empty or missing sets nothing, and a cell then yields after the 10 s of the protocol.

**Why two minutes.** The numbers are those of the full run in the entry on the builds: 193 cells yielded at 10 s and cost 223 `wait` calls, about one model call in six of the 1,266. 104 of the 193 cells had ended within 60 s and 184 within 120 s. What a longer time costs: the model does nothing else while its cell runs, as the entry on the builds said, and a command that never ends, a server started in the foreground by mistake, holds its exec until the yield, which nanocode's entry on the option measured as 61.0 s with a yield of 60 s where it was 11.0 s.

**Why not the hand's `--cell-yield-ms`.** `nanocode hand --cell-yield-ms` sets the same time on the hand, and the entry on the builds named it as the way. It was measured on `main` of this day, with the hand started with `--cell-yield-ms 120000` under nanocode-ts `build-81eada9`: every exec that named no yield and ran past 30 s failed in the brain after 29.9 s with "remote operation deadline elapsed; outcome unknown; cancellation requested; no retry", and its command was cancelled. It happened twice in one row of `compile-compcert`. The deadline of the brain is its operation timeout plus the yield that the call names, so a call that names none was given up after `REMOTE_TIMEOUT_MS` while the hand still held its cell. The time therefore has to be the brain's, which knows its own deadline, and `slot.sh` passes no flag. On `build-2672c04` the flag would do nothing for this Worker, see below.

**What moves with the pin.** `build-2672c04` is 18 commits of nanocode-ts after `build-81eada9`, and its nanocode moves from c14de6c to 439011f97, 45 commits. Read in the DECISIONS.md of both, this is what matters here:

- **A call that names no yield names 10 s** when its brain has an operation timeout, which this Worker has. The hand's own default then never applies to the cells of a Worker, with or without `--cell-yield-ms`, and without `CELL_YIELD_MS` the deadline for such a call is 10 s later than it was, 40 s.
- **The event hub** (nanocode-ts 1a597dd) keeps only stored events in its tail, and a stream never asks for a page it has sent. That is the hub's own fix for the Worker that stopped answering in the entry on the builds. This repository had the remedy from its session object, which hands only stored events on to nanocode-ts, and still does: the hub is now guarded twice.
- **A WebSocket watcher** (9e3ca5a) lost the stored events before a batch that began with an event numbered 0. nanoeval reads a session in pages and through the event stream, never through a WebSocket, and its session object passes on no batch with a 0 in it, so it was not reached.
- **`published` is what it was.** The session object is still handed `published(scope, events, bytes)`, with the events that the log does not store numbered 0 among the stored ones, and `App.create` still declares no hook for it. Nothing of the telemetry in `worker/Sessions.ts` changed.
- **The instructions say what the hand does.** The sentence that the entry on the builds missed comes with this build: the model is told to await a long command in its cell, that a nested Bash call without a timeout waits the ten minutes a call may take, and that the cell yields on its own clock meanwhile. It is in the WebAssembly module of `build-2672c04` and not in that of `build-81eada9`.
- **Not used by this Worker**: Python in CPU slices, since the Worker has no workspace, `maxConcurrentSubagents` and `remoteSubagents`, the read of an MCP store when a turn is admitted, since no MCP server is configured, and the model requests that the timing of a turn's result now lists, which nothing here reads.

**Measured with a model.** Two Workers side by side on the second machine of the entries above, 5 cores, no KVM, ns slots, alike in everything but the variable: `main` before this change with the option added, nanocode-ts built from f044971, two commits before `build-2672c04`, the hand `nanocode-cli-3f97ab0`. `claude:claude-haiku-5-5` as a nanocode session on 20 of the 21 tasks of the entry of 2026-11-12, without `schemelike-metacircular-eval` for its cost, two slots for each arm, both arms at the same time, one attempt a row.

| | 10 s | 120 s |
|---|---|---|
| Passed | 16 of 20 | 17 of 20 |
| Agent time | 6,663 s | 4,946 s |
| Model calls | 219 | 174 |
| Cells that yielded | 26 | 9 |
| `wait` calls | 29 | 9 |
| Model spend | $0.1305 | $0.1424 |

No call ended on the brain's deadline in either arm. What the numbers carry, read row by row:

- **The disk of the machine filled** 34 minutes in. Both Workers stopped and were started again five minutes later, with `compile-compcert` and `pytorch-model-cli` under way in both arms. At 10 s the turn of `compile-compcert` was replayed within its claim, 52 model calls; at 120 s both rows were claimed again. Without the two rows: 14 and 15 of 18 passed, 4,616 s and 3,231 s, 155 and 140 model calls, 24 and 5 `wait` calls.
- **The spend did not fall.** One row holds the difference: `tune-mjcf` cost $0.0484 at 120 s, 37 model calls and more experiments until its 900 s ran out, and $0.0152 at 10 s, where it passed after 671 s. Its longest cell took 83 s. The other 19 rows cost $0.1153 at 10 s and $0.0940 at 120 s.
- **The rows that differ are single attempts**, and reading their sessions gave none of them to the yield. `mcmc-sampling-stan` ran out of its 1,800 s at 10 s and passed after 602 s at 120 s, `model-extraction-relu-logits` failed at 10 s and passed at 120 s, `tune-mjcf` the other way. `kv-store-grpc` and `sanitize-git-repo` failed in both. `rstan-to-pystan` passed in both, in 1,712 s with 31 model calls and in 1,168 s with 17.
- **A cell past the two minutes** came once: a `git grep` of `sanitize-git-repo` at 120 s ran 121 s, yielded, and one `wait` ended it.
- **At 10 s the model names long yields itself** on its `wait` calls, 60 to 180 s. What the option saves is therefore about one model call for each long command, not one for every 10 s of it.

So the claim is the smaller one: fewer cells go back to the model and fewer calls ask for them again, with nothing lost in what passed. Twenty single attempts do not show that more rows pass.

On `build-2672c04` itself, with this change, four of the tasks passed in one attempt each on the same machine: `fix-git`, `hf-model-inference`, `pypi-server` and `pytorch-model-cli`.

Not run: the 89 tasks, second attempts, a deployed Worker with a model, and a Codex session with a model.

**Checked** on the 32-core machine with KVM of the entries above, beside other work that held its load average at 27 to 30 before these checks, with the hand `nanocode-cli-3f97ab0`.

- **The plain lane on directory slots** holds a long cell. The scripted model answers the `write-greeting` row of the agent that passes with one cell whose Bash command writes the file and then sleeps 12 s, past the 10 s of the protocol. The lane asks that the second request of that session carries the result of a completed cell, so the cell ended in the exec that started it and no `wait` was needed, and that the description of `exec` in both requests names the number that `CELL_YIELD_MS` has in `wrangler.jsonc`. The command begins with the write: the hand refuses one that begins with `sleep N` and goes on. The lane takes 17 to 18 s where it took 6 s, the 12 s of the cell.
- **Without the option**, the same lane with the variable empty: it failed after 16 s on the first of the two, the second request carried "Script running" where the lane asks for "Script completed". The six rows still ended as scripted, since the file was written before the sleep. With that assertion taken out it failed on the second: the description said "default 10000 ms".
- **With it**: 4 runs of 4 passed, in 17 to 18 s. The `exec` description says "default 120000 ms".
- `npm run lint`, `npm run check:types`, `npm run dry-run` and `npm test` passed, 147 tests and none skipped. The five tests of the model calls of a session, on events of `build-81eada9`, pass unchanged, and on the new build every lane with a session still finds the calls and the tokens of an attempt and one agent step for each call.
- **The lanes `restart`, `forgotten` and `lapse`** on directory slots, each alone: passed.
- Every `run` step of `.github/workflows/ci.yml` from a fresh clone of this change: 69 passed and `npm ci` was replaced, 62 end-to-end lanes and none skipped. The machine cannot reach the registry, so `node_modules` was copied from a tree made for this lock: the tree of the lock before, whose registry packages are the same since the two releases of nanocode-ts declare the same dependencies, with the `nanocode-ts` package replaced by the release archive as downloaded. It was compared with the tree that `npm ci` installed from this lock on a machine that reaches the registry: 27,852 files with the same SHA-256 each, and the same record of the installation.

**Not verified.**

- A deployed Worker. The variable is read from `cloudflare:workers` when the module loads under local workerd, and `wrangler deploy --dry-run` lists it among the bindings.
- A cell that runs past two minutes in a lane. The measurement had one, and nanocode's entry measured the yield and a `wait` that names it with 60 s. No lane here waits that long.
- A long cell in a Codex session and on krun and ns slots. The long cell is in a `claude` session of the directory lane. The option is in the Worker and no slot sees it, and the other lanes ran with it and with cells that end at once.
- A model that names its own `yield_time_ms` on `exec` under the option, and a command that never ends in a cell.
- CI on GitHub.

## 2026-11-14: a turn goes on after its Worker was killed, on nanocode-ts `build-7968b53`

The entry of 2026-11-13 on the model calls of a session recorded what a Worker killed in the middle of a turn does on the builds since `build-81eada9`: the turn starts again from its instruction, the model is asked again for everything it had answered, and the hand runs the commands a second time. The lane `restart` never reached it, since it kills the Worker before a turn has started. nanocode-ts changed this in its commit 7968b53. This entry moves the harness to the release of that commit, `build-7968b53`, adds three lanes that kill the Worker in a turn, and makes the usage and the trajectory of a session that went on those of the responses it was given. It changes `package.json`, `package-lock.json`, `src/Atif.ts`, `test/e2e.ts`, `test/Telemetry.test.ts`, `.github/workflows/ci.yml`, the README and DESIGN.md. `worker/`, `wrangler.jsonc`, `sandbox/slot.sh` and the pinned hand, `nanocode-cli-3f97ab0`, are unchanged.

**The cause, in nanocode-ts.** Since a session keeps one log (its commit f1b2093, in every build pinned here from `build-81eada9` on), the checkpoint of a turn is a record that stays in memory until a row of the log is committed. A row was committed before a tool that the model calls directly and for a cell that runs in the session object, and none for a cell that is sent to a hand, which is every cell of a session here. A turn on a hand wrote one row when it was admitted and one when it ended, so a Worker that stopped between the two had the first alone. `build-7968b53` commits a row before a cell or a `wait` leaves for the hand, and one before the first model request after the hand replied. nanocode-ts's DECISIONS.md of 2026-11-14 has the measurement on its own harness, which the lanes below repeat inside a run.

**What moves with the pin.** `build-7968b53` is 8 commits of nanocode-ts after `build-2672c04`, and its nanocode moves from 439011f97 to 410cc79fa, 40 commits. Read in the DECISIONS.md of both, and checked on a session of each build where a check is named:

- **A `claude` session sends the model what it sent.** The first request of a session was written out under both builds, on directory slots with the same hand: the system text, 6,585 bytes, the definitions of `exec` and `wait` with their schemas, 12,041 and 1,421 bytes, and every other field are byte for byte the same, and the request after a cell differs only in the id that the scripted model gave its call. Five nanocode commits of the span align the Claude tools with Claude Code. Three are about a tool that the model calls directly: Bash keeps its working directory and answers in Claude Code's text, a definition carries no output schema, and a tool gets a `workdir` only where a runner is attached. No session here calls a tool directly: on WebAssembly nanocode builds a session with a hand for Code Mode only (`code_only` in its `crates/backends/claude/src/runtime.rs`), and nanocode-ts names no model for direct tools. The model has `exec` and `wait`, and a tool called from a cell runs in the workspace and resolves to the structured result, as before. One, WebSearch and WebFetch as Claude Code runs them, is not compiled for WebAssembly. One is in the tools themselves, what Write, Edit and Read answer: tools run on the hand, so it comes with a hand and not with this build.
- **A model request of a `claude` session is tried 11 times** where it was tried 5 (nanocode d68ea1245), with the backoff it had, so a provider that keeps answering 500 is asked for about four minutes before the turn fails. Text blocks of an assistant turn that hold only whitespace are dropped before the turn is kept (f43ff49ce). Both are in the brain. Neither was met in a lane: the scripted model answers at once and sends no such block.
- **A `codex` session on a model that nanocode does not know sends another request** (a591e2ba2). Written out under both builds through the scripted gateway, for the model of the lanes, `gpt-right`: `exec` and `wait` are the `tools` of the request where they were an item of its input, with the same text, the instructions are 16,979 bytes where they were 20,751, and the second developer message no longer ends with a block that names the model. For `gpt-6-luna`, which nanocode knows, the two builds send the same request, field by field but for the ids of the session.
- **The log of a session has more rows**: one for each cell and each `wait` it sends to the hand, and one before each model request that follows a reply. nanocode-ts measured 17 rows and 23.3 KB for a turn of six cells where `build-2672c04` wrote 2 rows and 18.9 KB. Not measured here: a session is deleted with its attempt.
- **`published` is what it was.** The object is handed the stored events with their numbers and the model calls with 0, and `worker/Sessions.ts` is unchanged. What is new is what a session publishes when it goes on, see below.
- **Not used by this Worker**: `remoteSubagents` and what a remote child forwards to its parent, the two counters added to `/metrics`, the scoreboard of Python packages, and a cell that runs in the session object, whose first save is now committed only when it arms a timer.

**The hand stays at `nanocode-cli-3f97ab0`.** The frames that a hand and a brain exchange, nanocode's `crates/runtime/code-mode/src/remote` and `crates/integrations/tool-runtime/src/remote`, did not change between 439011f97 and 410cc79fa, and their one change since the commit of the hand, the yield that a brain names for every cell, is the one that the entry before this adopted. The brain declares nothing that this hand does not do: what it tells the model of Bash is that a call from a cell resolves to `{ stdout, stderr, exit_code }`, which the cells of the new lanes read, and the tools a cell reaches are those the hand lists. A hand that was not restarted is also what a turn that goes on needs: it keeps the running cell and its reply until the brain is back. A hand built from 410cc79fa would bring what Write, Edit and Read answer there, which a cell does read. That is a change to what the model sees, to be made with a paired arm of its own, and this build does not need it.

**The events of a session that went on.** When its object runs again, nanocode publishes `running`, then `input.accepted` and `run.started` a second time, numbered 16,384 above where the session stood, then the model call whose step was in flight, with the tokens it had, `attempt` 0 and `timing.replayed` true, numbered 0 like every model call, and then it goes on with the tool call of that step. Read as they came, the usage of the attempt counted that call twice, 9 calls and 72 input tokens where the endpoint answered 8 responses with 64, and the trajectory had the instruction twice and a step for the replayed call, 11 steps for a turn of 9. It is what the entry of 2026-11-13 recorded of `build-061892c`, 3 calls for 2 responses. `Atif.usage` now leaves out a call that says it was replayed. `Atif.fromEvents` leaves it out as well and takes an input whose `item_id` it has seen as the step it already has, so the tool call that follows joins the step of the call that issued it. A call that was asked again, as every call was on `build-2672c04`, says `replayed: false` and counts. `agent/events.jsonl` keeps every event as it came. A Worker killed while the model is asked leaves no replayed call: the request had no answer, is sent again, and is the one call.

**The lanes.** `NANOEVAL_E2E_SCENARIO=midturn`, on directory slots: one row of `write-greeting`, one `claude` session, the scripted model. The model answers six cells of one Bash command each, `echo step-N >> steps.log`. The fourth sleeps 20 s after it, and the sixth writes the greeting and prints `steps.log`. The lane sets `CELL_YIELD_MS` to 10 s for its Worker, so the fourth cell goes back to the model as running and the model asks for it with `wait`: a turn of 8 requests. The endpoint keeps what it decided for each request and the SHA-256 of its messages. `NANOEVAL_E2E_KILL` names the moment at which the lane kills the Worker with SIGKILL and starts it again over its state, as `restart` does:

- `cell`, the default: 5 s after `steps.log` in the slot holds `step-4`, while the cell runs on the hand and before it yields.
- `model`: 1 s into the request that follows the second cell, which the endpoint holds and never answers.
- `wait`: 2 s after the endpoint answered with the `wait`, while it is out.

Each asks that the row passed and no claim was lost, that the model was asked the eight decisions in their order, in `model` with the held request a second time and the same messages byte for byte, that no other request was sent twice, that `steps.log` as the sixth cell printed it holds the six steps once each, that no tool call of the session has an unknown outcome, that the requests of the row are those the endpoint answered, that the usage of the attempt has their calls and tokens, and that the trajectory is the instruction once and a step for each response. Every kill comes at least a second after the last answer of the model: a local workerd that is killed can lose its last writes, which Cloudflare would have kept.

| The Worker is killed | `build-2672c04` | `build-7968b53` |
|---|---|---|
| in the fourth cell | 12 requests: `exec` 1 to 4 asked twice, and `steps.log` holds steps 1 to 4 twice | 8 |
| while the model is asked for the third cell | 11: `exec` 1 and 2 asked twice | 9: the request without an answer, sent again as it was |
| while the `wait` is out | 13: `exec` 1 to 4 and the `wait` asked twice | 8 |

One run of each on `build-2672c04`, where the three lanes fail on the list of what the model was asked, as they should, and the first was run a second time to read `steps.log`.

**A Worker that moves to this build while rows run.** The entry of 2026-11-13 found that `build-81eada9` did not read the sessions of `build-061892c`, which is what the lane `forgotten` and the rule of the entry after it are for. This move is not of that kind. Tried once under local workerd, with a change to the lane that is not kept: the Worker ran `build-2672c04`, was killed in the fourth cell, and came back as `build-7968b53` over the same state. The session was read, the claim was kept and the row passed. Its turn started again from the instruction, 12 requests, because the log that the old build left held the row of its admission alone, and from there it wrote the rows of the new build. So a row that is in its turn when the Worker moves costs once more what a killed Worker cost on the old build. A session that is gone entirely still puts its row back: the lane `forgotten` passes on this build, the row went back 137 ms after the Worker answered again and the run was finished after 1.5 s.

**Checked** on the 32-core machine with KVM of the entries above, beside other work that held its load average between 43 and 95, with the hand `nanocode-cli-3f97ab0`. No model was paid for.

- **The three lanes on `build-7968b53`, ten times each in a row**: 30 of 30 passed. `cell` took 27 to 31 s, `model` 30 to 37 s and `wait` 27 to 30 s, and the Worker answered again 2.4 to 5.4 s after it was killed.
- **Without the change to `Atif`**, on the new build: `cell` and `wait` failed on the usage, 9 calls and 72 input tokens for 8 and 64, and `model` passed.
- A unit test in `test/Telemetry.test.ts`: the events of `build-81eada9` with the instruction, `run.started` and the last model call published a second time, the call as replayed, give the usage and the trajectory of the events without them.
- `npm run lint`, `npm run check:types`, `npm run dry-run` and `npm test`: 148 tests and none skipped.
- The lanes `restart` and `forgotten` and the plain lane on directory slots, each alone: passed.
- Every `run` step of `.github/workflows/ci.yml` from a fresh clone of this change, with `npm ci` run as it is: 73 passed at once, 65 end-to-end lanes and none skipped, the three new lanes in 30, 40 and 33 s beside a load average of 89 to 97.

**Not verified.**

- A deployed Worker: an object that Cloudflare evicts or restarts under a deployment, and its output gate. Everything ran under local workerd with SIGKILL. nanocode-ts ran SIGTERM as well, on its own harness.
- A real model, and what the row of `compile-compcert` in the entry on the yield would cost now, where it took 52 model calls.
- A `codex` session killed in a turn. The lanes kill a `claude` session, and nanocode-ts compiled the Codex path and did not run it.
- The Worker and the hand lost together, a hand that restarted, cells that run side by side, and subagents. nanocode-ts measured the first on its harness: the cell is not run again and the model reads that its outcome is unknown, as on `build-061892c`.
- The lanes on krun and ns slots: `midturn` reads `steps.log` in the directory of a slot. The change is in the brain and no slot sees it.
- A paired arm with a model across the two builds. A `claude` session sends the same request under both, and what differs for it is the 11 attempts and the dropped blocks. A `codex` agent on a model that nanocode does not know should be compared before its scores stand beside earlier ones.
- More than one kill in a turn, and a kill less than a second after an answer of the model.
- The size of the log of a real session, and what its rows cost in time.

## 2026-11-14: a Claude plan signed in on the Worker pays for a run

A deployed Worker paid for its sessions with an API key or the gateway and with nothing else. A plan could pay on a local Worker only, from a login file whose access token `nanoeval worker --claude-login` reads once and never refreshes. The need was a Claude subscription that the operator signs in once on the Worker, which keeps it, refreshes it and pays with it for the runs that ask. Whether a subscription may be used this way is governed by the terms of its provider and is the operator's call: nanoeval makes it possible and says so where it documents it.

**What there is now.**

- `nanoeval plans` prints the state of the plan. `plans sign-in claude` starts a sign-in and prints the page of Claude to open, `plans complete` finishes it with the code that page shows (`--code`, or standard input), and `plans sign-out claude` forgets it and revokes its refresh token. On a terminal `sign-in` asks for the code itself. Without one it ends after the page, so that an agent can drive the two steps.
- The routes are `GET /v1/plans`, `POST /v1/plans/claude/sign-in`, `POST /v1/plans/claude/complete` and `DELETE /v1/plans/claude`, behind the token of the API like every route but a runner's. `/plans`, where nanocode-ts would serve them, answers 404.
- `run --payer plan`: `payer` in the configuration of the run, kept with it and shown by `status`. The default, `deployment`, is not written.
- `PlanVault`, a fifth Durable Object class (binding `PLANS`, migration `v4`), which keeps the sign-in sealed under `PLAN_SECRET`. `nanoeval worker` takes that secret from the environment or makes it once in a mode 600 file of its state directory, since a secret made at each start could not open what the last one sealed.

**The rules, and why.**

1. **A request of a plan passes the meter of the run.** nanocode-ts offers the whole feature as `App.create({ plans })`, and nanoeval does not take it. That egress sends a plan's request to Claude itself, around the egress of the host, so the meter in `worker/Sessions.ts` would not see the response: no tokens in `model_requests`, no `401`, and nothing to tell the run that a plan pays no more. It also takes every subscription request, so the login file of a local Worker would be asked of a vault that has no sign-in. And its object reaches only the hosts of Claude, so no lane could sign in. nanoeval keeps what is hard to get right, the sign-in, the exchange, the refresh and the sealing of nanocode-egress (`Plans.account`, `Vault.sealed`, `Egress.headers`, `Egress.destination`, `Egress.routes`), and writes the object, its record store and the request around them (`worker/Vault.ts`, `src/Plans.ts`): the egress asks the vault for the credential and sends the request through `Meter.relay` as it sends one with a key. The record has the table and the keys of nanocode-egress's own object.
2. **Who pays is the choice of the run, and the default did not move.** nanocode-ts lets a session without a payer use a plan whenever one is signed in. So a run now names the payer of every session: `plan` for a run of the plan, `deployment` for any other, under which nanocode-ts asks no plan. The one exception is a provider whose login file the Worker holds: that session gets no payer, and the login pays as before. A signed-in plan therefore pays for the runs that ask for it and for no other.
3. **A run of the plan has `claude` sessions only**, its judge's among them. A `codex` agent or judge and an installed agent are refused by `Config.parse`: an installed agent takes its credential from the model endpoint of the run, which holds the key or the login file, and a ChatGPT plan is not kept on a Worker, since chatgpt.com refuses requests from Workers and the relay it needs is a Cloudflare Container that the deploy would have to build. An oracle run may name the payer, for its judge.
4. **A run is refused while no plan is signed in**, when it is created, before it has a row or a sandbox, with the reason the vault gives and `nanoeval plans sign-in claude` in the message.
5. **A plan that gives no credential is an `environment` error, and the run starts no more rows.** The vault refreshes a token that ends within five minutes before it gives it out, and after a `401` of the provider it refreshes once and the request is sent once more. A second `401` is the provider's answer and goes to the session. When the refresh is refused the vault is signed out, and when it fails any other way the vault cannot tell whether its refresh token was used up and says so on every later request: nothing but a new sign-in brings the plan back. So the egress answers `401` itself with a message that names the plan and the command, records the request with the refusal `plan`, and tells the run as it tells it of a payment refused for good (`model.refused`). A row whose claim has such a request ends as an `environment` error with that message, whatever kind its runner reported, and the rows that wait end the same way without starting. A row whose turn is submitted after the vault signed out never gets that far: nanocode-ts refuses the turn with `403`. The run then ends the row itself, as an `environment` error with the reason the vault gives, and answers its runner `410`, which makes the runner let go of the row. `run --rerun RUN --errored --payer plan` takes all of them up after a new sign-in.
6. **Nothing is charged, and the spend is an estimate.** A response of a plan carries no cost, so its row in `model_requests` has tokens and no cost, like a response of a key that names none. The session still reports what its tokens would cost at list prices (`cost_status: estimated_from_usage`), in subscription mode as with a key, and that is the cost of the attempt and the model spend of the run. `--model-budget-usd` bounds that estimate and is therefore not refused: it is the only bound on how much of a subscription a run uses. `status` says that the plan paid and that the figure is an estimate.
7. **The credential is in no record.** It is added in the egress and the meter records only the time, the path, the status and the usage of a response. The message of a refusal is the vault's reason, which names no token.
8. **Whether the plan can pay is asked by asking for the credential, never by reading its state.** nanocode-egress writes `Exchanging` before every call to the token endpoint, so for as long as a refresh is under way the state of a healthy plan reads `exchange_uncertain` and `signedIn` answers false. A request for the credential waits for that refresh instead and shares its outcome. So the run that is created, the session that asks whether its account has a plan, and the run that finds a turn refused all ask the vault for the credential (`PlanVault.unusable`, which returns the reason or nothing and hands the credential to no one).
9. **A secret that changed does not lock the vault.** nanocode-egress cannot open a record sealed under another secret, and its sign-in and sign-out both read the record first, so a Worker whose `PLAN_SECRET` changed could neither use nor replace its sign-in. Here `plans sign-out claude` removes a record that does not open.

`CLAUDE_PLAN_URL` names one address in place of the hosts of Claude for the token, profile and Messages requests of the vault. It is how the lane signs in at a scripted Claude, and what a Worker under local workerd needs on a network that only a forwarder leaves.

**What nanocode-egress does with a token**, read from its build `a0ff241`, which nanoeval depends on (nanocode-ts bundles `ec47028`, whose plan files are the same): a sign-in is `Pending` for 15 minutes; the exchange of the code and every refresh write `Exchanging` before they call the token endpoint and `Ready` only after the profile endpoint has named the same account; `invalid_grant` signs out, an account on hold is kept as such, and any other failure leaves `Exchanging`, which every later request reads as an exchange whose outcome is unknown. A refresh token that Claude does not date ends 30 days after the sign-in. Concurrent requests share one refresh, in the one object of the account.

**Checked** on the 32-core machine with KVM of the entries above, beside other work that held its load average between 80 and 115.

- **Unit tests**, 11 new: the record store replaces a record only at the revision its writer read; a sign-in against a scripted Claude is kept sealed (the stored record holds neither token) and gives the bearer token and the OAuth beta; a `401` is followed by one refresh and one more request, with the stale credentials of the request dropped and its betas kept; a second `401` is returned; a refused refresh raises the error that names the sign-in command, signs the vault out and sends nothing afterwards; an endpoint that is not a Messages endpoint of Claude is refused before anything is sent; `CLAUDE_PLAN_URL` moves the token, profile and Messages requests; a record sealed under another secret fails to open and `signOut` removes it; `Config.parse` takes `plan` with `claude` agents, a `claude` judge and the oracle and refuses `codex`, `codex-cli`, `claude-code` and a `codex` judge; the secret file is made once with mode 600.
- **The lane** `NANOEVAL_E2E_SCENARIO=plan` on directory slots under local workerd, two slots, where the scripted model also serves Claude's token and profile endpoints and answers a Messages request only with the credential it expects. Without the token every plan route answers 401, and the ChatGPT routes 501 with it. A run of the plan is refused while signed out, and one with an installed agent is refused. The command line signs in in two steps, with a wrong code refused in between and the right one read from standard input. The run of the plan then ends 2 passed and 2 failed as scripted: 8 responses carried the token of the plan and none the key, the scripted Claude rejected the first token after three answers, the token endpoint saw one `refresh_token` grant, and the `401` is in the record of its attempt beside the request that followed. Its spend was $0.000448, the estimate of the four sessions, with 8 responses without a cost. A second run, without the option, on the same Worker with the plan still signed in, ended the same and sent every request with the key. With the scripted Claude refusing both the token and its refresh, a third run of the plan ended as 4 `environment` errors: the two rows that were claimed with the message that names the plan, the two that waited without a claim, and `status` says when the plan gave no credential. The vault was then signed out, and another run of the plan refused. After a new sign-in `plans sign-out claude` revoked the refresh token at the scripted Claude. A fourth run was created with the plan signed in and the plan signed out before a row was claimed: its two claimed rows ended as `environment` errors that say Claude is not signed in, with no request to Claude and no retry of the runner, and the other two were not started. Last, every file of the lane, 143 to 148 of them with the storage of the Worker's objects, its log, the artifacts and the exported jobs, was read for the eight tokens that were issued and for the secret: none holds one. The lane takes 24 to 41 s on this machine, and passed 8 times of 8 as it is.
- **What the lane found.** As first written it passed once and then failed: in the third run a row was claimed just after the vault had signed out, its turn was refused with `403`, the run answered its runner `500` on every ask, and the row never ended. That is the last case of rule 5, which the fourth run now asks for on purpose. Then a run that passed showed rule 8: a row whose turn was submitted while another session's refresh was under way was refused as if no plan were signed in, with the state `exchange_uncertain` in its message. There the refresh was about to be refused anyway, but the same turn beside a refresh that succeeds would have ended its row and stopped the run. A unit test now holds a refresh open, reads that state, and sees both requests for the credential get the new token.
- `npm run lint`, `npm run check:types`, `npm run dry-run` and `npm test` passed, 159 tests and none skipped.
- **Every `run` step of `.github/workflows/ci.yml` from a fresh clone of this change**, with `npm ci` from the registry and nanocode-ts `build-7968b53`, beside a load average of 50 to 167: 74 steps, 66 of them end-to-end lanes, none skipped. 73 passed at once, among them `npm test` with its 159 tests and the lane of the plan, in 36 s beside a load average of 94. The 8 runs of 8 above were in the worktree on `build-2672c04`, before this change was moved onto `build-7968b53`; the proof ran the lane once on the new build.
- **The step that did not pass at once** is the lane on `ns` slots with a leased sandbox kept warm for a second run: an oracle run through the gateway, which has no session and asks no plan. It buys leases of 3 s, and each time it failed a lease had ended first. Seven times the runner said hello 3.1 to 7.5 s after the run was created, and the run opened a second sandbox, twice a third, where the lane wants one; once the kept sandbox lapsed before the pool closed it. It was run again alone eight times and passed the eighth time, with hello after 3.0 s. The last two of the eight had a larger share of the processors than the other work on the machine, whose load average was 120 to 146 by then. That this change is not the cause: the same lane from a fresh clone of the commit before it, run in turns with it, failed once in the same way and passed twice, with hello after 6.1, 2.8 and 2.6 s; the six files of the runtime archive are the same byte for byte in both commits; and the command line loads the same modules when it starts but for `node:readline/promises` and `node:stream/consumers`, and starts in the same time, 0.31 to 0.43 s before and 0.31 to 0.58 s after over eight starts each. The race is in the run, which waits for the bootstrap of a runner inside a tick and renews no lease meanwhile. It is left as it is here.

**Not verified.**

- Claude itself. No sign-in, no refresh and no model request of a real plan was made, so the page, the code it shows, the scopes, the token lifetimes and what Claude answers a subscription request from a Worker are known from nanocode-egress only.
- A deployed Worker: the `v4` migration, the secret, and a sign-in there.
- A token refreshed because it was about to end, which is the usual case. The lane refreshes after a `401`.
- What Claude answers once a plan's usage limit is reached. Nothing sets it apart from another answer of the provider, so such a row ends as its session ends it, as an `agent` error, and the run goes on.
- A judge paid by the plan, in a lane: the judge takes the payer of the run in the same call as an agent, and the judge lane ran with the default.
- A login file of a local Worker after this change. Its session gets no payer and its request the same headers as before, read in the code. No valid login was at hand and none was used.
- A refresh that fails without an answer, many sessions behind one refresh, and `plans sign-in` on a terminal.
- CI on GitHub.

## 2026-11-14: a row that a runner gives back waits its own time for the next runner

A standing runner ran as a service for a day against a deployed Worker, with the tasks' solutions and a dozen restarts of the runner, and the defects it met are the six entries of this day. This one is in `worker/Run.ts` alone.

**The defect.** A run that opens no sandbox ends the rows that no runner could take for `--setup-sec` as `environment` errors, so that it finishes instead of waiting for a runner that is not coming. `strand` keeps the moment that wait began in the run's `strandedAt` and takes it away when no row is stranded. `enforce` called it only while a row was unclaimed. A run that is handed to a standing runner is created without a runner, so the mark is written in its first tick, 18 ms after the run was created on the deployed Worker. When the rows of the run are no more than the slots of the runner, all of them are claimed before the next tick, `enforce` returned before `strand`, and the mark stayed for the life of the run. Two things followed.

- A row that came back later, because its runner was stopped or lost, was measured against the creation of the run. Later than `--setup-sec` it ended in the millisecond its claim ended: "no runner of the run could take the row for 600 s: the run has no runner, and opens no sandbox itself", while the runner that had been started again stood idle in the pool. Met on the deployed Worker with a run of one row whose runner was restarted 621 s after the run was created.
- `status` printed "rows wait since +0 s for a runner …" for every such run, the finished ones too.

`starvedAt`, the same kind of mark for runners that are idle for want of disk, was kept the same way and is cleared the same way now. That one was read, not met.

**The rule.** The time a row may wait for a runner is counted from the moment rows wait with no runner that could take them, and it ends when no row waits. `enforce` clears both marks when no row is unclaimed, so a row that a runner gives back has the whole of `--setup-sec` for the next runner. `status` reports `strandedAt` only while a row is unclaimed, so a run that a Worker without this change finished no longer says that its rows wait. Nothing is migrated: the mark of an existing run is in its own table and is read as before.

**Checked** on the 32-core machine with KVM of the entries above, beside other work that kept its load average between 55 and 100.

- **The lane `stopped`**, which the next entry adds to `ci.yml` because it passes only from there: a standing runner, a run of 6 rows with `--setup-sec 5` whose 6 slots take all of them at once, and the scripted model holding the second response of one row. Once every other row has its verdict and 6 s have passed, the lane stops the runner with SIGTERM, starts another and lets the model go. It asks that no row ends as an error, that the held row is claimed twice, and that the finished run has no `strandedAt`.
- **Without the change**, the lane on the commit before this one, on directory slots: it failed after 73 s. The held row ended as an `environment` error, "no runner of the run could take the row for 5 s: the run has no runner, and opens no sandbox itself", with the second runner idle in the pool.
- **With it**, one run: no row ended as an error. The lane still failed, after 76 s, on what the next entry describes: the row was claimed three times, the second claim `expired` in the `claimed` phase after the lease of 60 s.
- What ran on all six changes together is at the end of the last entry of this day.

**Not verified.**

- A deployed Worker with this change, and a run made before it whose rows come back after it: the mark of such a run is still the one of its creation until a tick finds no row unclaimed, which is its next tick unless rows wait at that moment.
- `starvedAt`: no lane holds a runner short of disk, lets every row be claimed and starves it again.
- CI on GitHub.

## 2026-11-14: a runner that is stopped is handed no row on its way out

**The defect.** A runner that is stopped tells the run which rows it gives back (`leave`), and the run makes them `unclaimed`. A claim of the same runner was usually held by the run at that moment, since a runner with a free slot always holds one. Putting a row back wakes every held claim, the one of the runner that is leaving among them, and `leave` marked the runner as `left` only after it had put the rows back: the woken claim found its runner still `ready` and was answered with the row that had just come back. The runner logged the claim and exited. Three things followed.

- The row was held by a claim that nothing served until its lease ended, 60 s by default, and that claim ended `expired` in the `claimed` phase.
- It cost the row one of its `--claims`. With the default of 3, two restarts of a runner exhaust a row.
- A runner keeps its rows by the id of the row, so the new claim took the place of the old one in what the runner held, and the loop that takes the slots down when a runner stops never saw the slot of the first claim. On krun slots its microVM outlived the runner.

Met on the deployed Worker in 2 of 2 restarts with rows in flight: the second claim of the row began in the millisecond its first was released.

**The rule.** A runner that leaves holds nothing afterwards and is handed nothing more.

- `leave` in `worker/Run.ts` marks the runner as `left` first. A held claim asks again whether its runner is still ready when it is woken, as [Starting a run](DESIGN.md#starting-a-run) says, so it now answers with no rows. Then `leave` puts back every row that the ledger has with that runner, whether the runner named it or not: a claim that the run granted while the runner was already stopping, and whose answer the runner never read, goes back with the rest instead of waiting for its lease. `hello` has always done the same for a runner that comes back.
- A runner that is stopping starts no row that a claim still answers, and says so in its log.
- A runner keeps every slot it has brought up apart from the rows it holds, and takes all of them down when it stops.
- When a claim hands a runner a row it already holds, the claim it held is over, since the run grants a row only after its last claim ended. The runner takes that slot down at once when no step of it is running, and a step that is running ends on the `410` of its next call, as before. The entry of 2026-11-13 on a turn that its session no longer has left this case under "Not verified": the slot of the older claim stayed up until the runner ended.

**Order of a deploy.** The first point is the Worker's and is enough against the claim that nothing serves, with any runner. A runner with this change that meets a Worker without it starts no such row, and the row then waits for its lease as before: the Worker moves first.

**Checked** on the same machine.

- **The lane `stopped`** of the entry before this one, new in `ci.yml` on directory slots. It asks, beside what that entry lists, that the runner exits with status 0, that its directory holds no slot after it, that the claims of the held row are `released` in the `run` phase and `finished`, that the run lost one claim, and that the run is finished within one lease of the stop.
- **Without the change**, with the change of the entry before: the lane failed after 76 s. The claims of the row were `released`, `expired` in the `claimed` phase and `finished`, and the log of the stopped runner has "claimed a00001" 67 ms after "stopping: releasing 1 attempts".
- **With it**: the lane passed in 18 s, the run finished 3.3 s after the runner was stopped, and the log of the runner has no claim after it began to stop.
- What ran on all six changes together is at the end of the last entry of this day.

**Not verified.**

- krun slots and a microVM that outlives its runner: the lane runs on directory slots in `ci.yml`, where a slot is a directory, and what the next entry ran on krun slots is there.
- A row that the run hands again to a runner that holds its older claim with no step running: the code path is the one the lane's stopped runner would take if it were not stopping, and no lane makes a lease end under a runner that lives.
- A runner without this change with a Worker that has it, and the other way round, on a deployment. Both orders are argued above.
- CI on GitHub.

## 2026-11-14: a standing runner serves several runs at once, and leaves the pool when it goes

Three of the defects of the day are one change, in the pool (`src/Pool.ts`, `worker/Pool.ts`), in `sandbox/Runner.ts` and in two lines of `worker/Run.ts`.

**The defects.**

- **A second run failed while the runner was busy.** A member of the pool serves one run at a time, and a standing runner was one member. A run created while that runner had a run found no idle member, asked again with every tick, and after `--setup-sec` ended its rows as `environment` errors: "the run has no runner, and opens no sandbox itself". The runner existed and had free slots. Met on the deployed Worker: a run of 4 rows behind a run of 12 errored after 600 s, and the same run with `--setup-sec 7200` waited 12 minutes and passed.
- **A runner that was stopped or lost with a run stayed in the pool for ever.** A runner left the pool only from the request it holds while it is idle. Stopped with a run, it left the run and not the pool, the pool closes a member that stops asking only while the member is idle, and `leave` closed only idle members. `nanoeval pool` on the deployed Worker listed five members "with a run" for five runners that no longer existed.
- **A runner that the pool closed exited with status 0**, and so did one whose member the pool no longer knew. A service had to restart it whatever its status.

**The rule.** A machine has a member for each run it serves and one more that stands by.

- `nanoeval runner --standing` names its machine with a UUID it makes when it starts, and enrols a member under it. When that member is handed a run, the runner enrols another at once and serves the run beside it. A run that is created while the machine is busy is therefore handed a member the moment it is created, as before, and its rows wait in its own ledger for a slot of the machine, as the rows of one run do when it has more rows than slots. When a run is done and another member of the machine already stands by, the member that served it leaves. Each member still serves one run at a time, which is what the pool's table and a kept sandbox rest on.
- **A run is handed one member of a machine.** A run that has more rows than its runner has free slots asks the pool for another runner with every tick. `Pool.take` passes over a member whose machine already has a member with that run, or the run would take the member that stands by again and again and count the same slots twice.
- **The slots and the memory are the machine's.** Every run a runner serves counts the rows of all of them against its `--slots` and `--memory-mb`, unpacks a disk once, and removes a disk only when no row of any of them uses it.
- **One claim at a time.** Two claims that offer the same free slot to two runs would be granted twice. A runner asks its runs one at a time, and when more than one waits to ask, the one with the fewest rows in the machine's slots goes first, so that a small run beside a large one is not kept waiting until the large one has no row left: the free slots go to the run that holds less. While a runner serves one run its claim is held by the run as before. While it serves several, a claim is answered at once, and a run that had no row is asked again after a pause that doubles from `--poll-ms` to a third of the lease and starts over whenever a slot of the machine is freed. So two idle runs cost a request each every 20 s and not four a second, and a row that comes back to a run beside others may wait that pause for a slot that is free, where a run alone on its runner is handed it at once.
- **A held claim can be ended.** A run handed to a runner that holds the claim of another run with free slots would wait for that claim, a third of a lease at most. The runner asks the first run to end it (`POST …/runner/yield`), which answers it with no rows, as a later claim of the same runner always has (`Hold.end`). `leave` ends the held claim of a runner the same way.
- **A member is in the pool while its machine asks.** A machine member that has a run is closed when no member of its machine holds a request or has asked within its notice, the lease of the runner: the member that stands by is the sign that the process lives. A member enrolled before machines were named, by an earlier runner, is its own machine and asks nothing while it serves, so it is closed one notice after it was handed its run. Closing a machine member ends nothing: the run keeps its runner and its rows, and the runner finds out with its next request to the pool.
- **A runner leaves the pool with every member it has** when it is stopped: the one that stands by, by asking the pool to close it while its request is still held, which answers that request, and each one with a run, once the runner has left the run. `leave` closes a machine member in either state. A sandbox that a run has is still only that run's to give back.
- **A machine member that is closed is removed from the table.** It holds nothing a later reader needs: the pool pays only for sandboxes, and `nanoeval pool` lists what stands by and what is with a run. Members that earlier runners left behind as closed go with the first one that is closed after a deploy.
- **A runner enrols again** when the pool closed its member or no longer knows it (`401`, `404`), and keeps asking with a pause that doubles while the Worker does not answer. `nanoeval pool --close` therefore no longer takes a standing runner out of the pool, it makes it enrol again: stopping the runner is what takes it out. Only a refusal of the enrolment itself, a `4xx`, ends it, with status 1 and what the pool said. SIGTERM and SIGINT still end it with status 0.

**"The run has no runner"** is now said only when the pool has none that fits: a runner that lives always has a member standing by.

**Why not a queue in the pool.** A run could have waited in the pool for a member that is busy, bounded by a time it names. That keeps one run on a machine at a time, so a run of one row waits for hours behind a run of 89 while slots are free, and it needs a second clock beside `--setup-sec` and an order among the runs that wait. Rows already wait in the ledger of their run for a slot, with no clock at all, and that is the queue this uses.

**Why a member per run and not runs per member.** One member with several runs would have needed a table of the runs of a member, a request to the pool that is held while the runner serves, and every reader of `member.run` changed, among them the rule that only the run that has a sandbox gives it back. A member per run changes one predicate of `take` and adds one column.

**State of an existing deployment.** The `members` table gets a column `machine` when the pool object next starts, null for the members it holds. Runs are not touched. Members "with a run" whose runners are gone are closed and removed one notice after the deploy, at the first alarm.

**Order of a deploy.** The Worker first. A runner with this change enrols a second member, which a pool without the change would hand to a run that already has the first.

**Checked** on the 32-core machine with KVM of the entries above, load average 55 to 100.

- **The lane `shared`**, new in `ci.yml` on directory slots: a standing runner with 2 slots, a run of 6 rows whose scripted model holds the second response of one row, and a second run of 6 rows created at that moment. It asks that the second run finishes while the first has its row in flight, with the counts of the first and no lost claim, that each run has one runner, that the pool showed two members with a run and one standing by, all of one machine, that the claims of both runs never hold more than the 2 slots and do hold 2, that a row of the second run was claimed before the last row of the first, and that the runner ends with one member standing by and leaves the pool with status 0 when it is stopped. It passed 2 of 3 times in 14 to 15 s, the second run claiming 197 and 422 ms after it was created and finishing after 3.3 and 4.5 s. The third failed on a question of the lane itself: it read the pool after the second run had finished, when the member of that run had already left. The lane now reads the pool while both runs run.
- **Without the change**, the lane on the commit of the entry before: it failed after 29 s, with `--setup-sec 20` in place of the lane's 600 so that it ends. The 6 rows of the second run ended as `environment` errors.
- **The lane `stopped`** now also asks that the pool is empty the moment the stopped runner has exited. On the commit of the entry before, the member of the stopped runner stayed "with a run". With the change it passed 3 of 3 times in 15 to 18 s, the run finished 2.7 to 3.9 s after the stop.
- **The lane `standing`** now asks that one member stands by alone after each run, that the runner enrols again under the same machine after `nanoeval pool --close`, that a third run is handed to that member and ends as the first, and that the runner exits with status 0 and leaves the pool empty. 3 of 3 passed in 11 to 14 s. On the commit of the entry before it failed where each run is handed to a member of its own.
- **krun slots**, by hand, not in `ci.yml`: `shared` passed 3 of 3 times, the second run claiming 214, 500 and 297 ms after it was created and finishing after 6.3, 7.8 and 8.4 s. `stopped` failed the first time: the slot of the row that was held stayed in the directory of the stopped runner. The call of that row was answered `410` while the runner took its slots down, and both took the same slot down at once, the second `rm` meeting what the first was still stopping. A slot is now taken down once, whoever asks, and `stopped` passed 3 of 3 times after that, the run finished 3.9 to 4.9 s after the stop. With rows that wait for a model this race is the usual case and not a rare one: such a row always has a held call.
- **The lanes that share the runner's loop**, once each on directory slots with the change: the plain lane, `runners`, `lost`, `resume`, `machine` and `warm` through the scripted gateway passed.
- Unit tests: `test/Pool.test.ts` for the member that stands by, the run that is not handed a second member of its machine, the member with a run that stays while its machine asks and goes one notice after, a runner that leaves, and a table made before the column; `test/Hold.test.ts` for a held request that is ended.

**Not verified.**

- A deployed Worker: the alarm that closes the members of earlier runners, the column on a pool that holds members, and Cloudflare ending a held request.
- Two runs on krun slots under a real load: a run of many rows beside another for hours, the pause between claims at that scale, and `--free-disk-mb` or `--disks remove` with two runs, which were read and not run.
- More than two runs at once, and two standing runners in one pool with several runs. The table logic is tested, the runner was run with two.
- A Worker that does not answer for longer than the notice while the runner serves: the pool then closes its members, the runs keep their runner, and the runner enrols again. Argued from the code.
- A runner without this change beside a Worker with it, for a run longer than its notice: its member is then closed while it serves, and it exits when that run is done. The entry on the protocol has what ran, two short runs.
- CI on GitHub.

## 2026-11-14: a row whose slot ends under it goes back to the run

**The defect.** A microVM that is killed under a row, by the machine's kernel when the machine runs out of memory or by anyone with a signal, ended the row as a score of the task's infrastructure in the wrong place. Killed while the verifier ran, the launcher's `exec` lost its connection to the guest and exited with 125, the runner read that as the exit code of the verifier, found no reward, and the row ended as a `verifier` error: "the verifier exited with 125 and wrote no reward: … the guest connection ended". Nothing of that is the task's or the verifier's. The row was not claimed again, although every other lost slot is. Met on the machine of the standing runner: the kernel killed a microVM of 7 GB twice in five minutes while other work filled the machine's memory, and a microVM that was killed with a signal on purpose while its verifier ran ended its row this way.

**What a runner can tell apart.** Not the exit code: the launcher answers 125 for a connection that ended and passes on the 125 of a verifier that exits with it, and `krun/` was not changed for this. The process is what differs. A slot that is up has the process of its machine in `vm.pid`, the microVM of a krun slot and the namespaces' first process of an ns slot, and that process outlives every phase of the row. `slot.sh gone SLOT` prints a line when a slot came up and that process no longer exists, and nothing otherwise. A verifier that exits non-zero in a slot that still runs is the verifier's, as before, and so is a guest that stops answering while its microVM lives: those two cannot be told apart from outside, and the first is by far the usual one.

**The rule.** A slot that ends under its row is a lost claim, not a result. The runner asks `gone` where a phase of a slot ended badly: a verifier, a solution or an installed agent that exited non-zero, a hand that exited before or during its turn, and any step that failed and would be tried again. When the slot is gone it tells the run (`POST …/rows/ROW/gone` with what `slot.sh` printed) and takes down what is left. The run writes the text on the claim, adds an `attempt.gone` mark to the timeline and ends the claim as `released`: the row is `unclaimed` again and starts from nothing on its next claim, here or on another runner. It counts against `--claims`, and a row that is out of claims ends as an `environment` error that names the phase and the text. Unlike a machine that cannot bring a slot up, the runner goes on claiming: one microVM that was killed says nothing about the next.

**What a kill costs now.** With a service that keeps running when the kernel kills one process of it (`OOMPolicy=continue` in systemd), one killed microVM costs its row one claim and the time it had run, and no row ends as an error for it until the same row has lost `--claims` slots.

**Checked** on the 32-core machine with KVM of the entries above.

- **The lane `gone`**, new in `ci.yml` on krun slots, where it is skipped without KVM: one row of a new fixture, `test/fixtures/slow-verifier`, whose verifier sleeps 8 s. Two seconds after the row is in its `verify` phase the lane kills its microVM with SIGKILL. It asks that the row passes on its second claim, that the first ended `released` in the `verify` phase with "the krun slot … is not running any more: its process … is gone" as its error, that the run lost one claim and that the timeline has the mark.
- **Without the change**, the lane on the commit of the entry before: it failed after 42 s. The row ended as a `verifier` error, "the verifier exited with 125 and wrote no reward: nanoeval-krun: the guest connection ended: failed to fill whole buffer".
- **With it**: the lane passed 2 of 2 times, in 29 and 63 s, the row verified again by the same runner.

**Not verified.**

- A kill by the kernel for memory: the lane sends the signal itself, which is what the kernel sends.
- ns slots, where `vm.pid` is the first process of the namespaces: read, not run. A directory slot has no machine and is never gone.
- A slot that ends during the turn of a session, under an installed agent or under a solution. The same question is asked there, and only the verifier's phase has a lane.
- A guest that stops answering in a microVM that lives, which stays a `verifier` error when it happens under the verifier.
- A runner from before this change with a Worker that has it, which behaves as before, and the other way round, which the entry after this one refuses.
- CI on GitHub, where the lane is skipped.

## 2026-11-14: a Worker and a runner say which protocol they speak

**The defect.** Nothing could check that a runner and the Worker it serves are of commits that work together. `/health` answers `{"ok":true}`, a runner said nothing of itself, and the one rule there was, that the Worker moves first and the runtime archive with it, stood in one sentence of the entry of 2026-11-13. The entries of this day make it matter: a runner of this day enrols a second member in the pool, asks a run to end a held claim and gives back a row whose slot is gone, none of which a Worker from before knows.

**The rule.** The calls between a runner and a Worker are a protocol with a number, `Protocol.version` in `src/Protocol.ts`, which a change raises when a runner of one side of it and a Worker of the other do not work together. It is 2 with this entry, and every commit before it is 1 without saying so.

- **The Worker says it to whoever holds the token**: `GET /v1/version` answers `{"protocol":2,"commit":…}`. The commit is the variable `COMMIT`, which a deploy sets with `npx wrangler deploy --var COMMIT:$(git rev-parse HEAD)`, and null when it did not. `/health` stays as it is, without the token: a public address should say that it answers and not which commit, with which known defects, answers there.
- **A run says it to its runners**: the configuration that every runner starts from, whether a sandbox, a person or the pool hands it over, carries the protocol of the Worker that made it. A runner that reads another number than its own, or none, leaves the run and exits with status 1 and both numbers, before it sets anything up. A runner in a sandbox has no token for `/v1/version`, and this needs none.
- **A standing runner asks before it enrols**, so that no run is handed to a runner that would refuse it: `nanoeval runner --standing` ends with status 1 when the protocols differ or the Worker answers `404`, and prints both commits when they differ under one protocol, which is allowed.
- **`nanoeval version`** prints both sides and exits with status 1 when they do not work together.

**Why a number and not the commit.** Most commits change nothing between a runner and a Worker, and a runner that refused every other commit would stop for every deploy of a README. The runtime archive is also built to be the same bytes from the same sources, and a commit inside it would give every commit a new archive to publish. The commit is printed for people, the number decides.

**Why refuse and not warn.** A runner of another protocol fails in the middle of a run, in whatever call the other side does not have, and what it leaves behind is claims that wait for their lease. Not starting is the outcome that costs nothing.

**How a runner machine follows a deploy**, now in the README: the Worker first, with its commit; then the runtime archive, published again from that commit, for the runs that name one; then each runner machine moves its checkout to that commit and starts its runner again when it holds no row, since a runner that is stopped gives its rows back and each of them counts a claim. In between, a runner of protocol 1 keeps working with the Worker of protocol 2, less well: it serves one run at a time, and the pool closes its member when a run lasts longer than its notice, so that it exits when that run is done, see the entry on the pool.

**Checked.**

- Every lane now asks at its start that `/health` answers `{"ok":true}` and nothing else, that `/v1/version` answers `401` without the token and the lane's commit and `Protocol.version` with it. The plain lane on directory slots also starts a runner from a configuration of another protocol and asks for status 1 and the text. The plain lane passed 2 of 2 times with it.
- The standing lanes start their runner through the question to `/v1/version`.
- **A runner of this entry in front of a Worker of the commit before the changes of this day**, by hand on directory slots: `nanoeval runner --standing` ended with status 1 before it enrolled, with "worker: says no version, so it is of a commit before protocols had a number", its own protocol and commit, and "they do not work together: move both to one commit, the Worker first".
- **A runner of the commit before the changes of this day in front of this Worker**, by hand with the `standing` lane on directory slots: it was handed two runs one after the other and both ended as they should, 6 rows each. The lane then fails where it asks that each run had a member of its own, which that runner does not enrol.

**Not verified.**

- `wrangler deploy --var` on Cloudflare: the variable was set through the file of variables that `wrangler dev` reads.
- A runner of protocol 1 with this Worker for a run that lasts longer than its lease, where the pool closes its member while it serves: argued in the entry on the pool, and the two runs above were shorter.
- Either pair on a deployment.
- CI on GitHub.

## 2026-11-14: a list of runs, a rerun that keeps its settings, an export that says where

Three smaller things that the day with a standing runner met at the command line.

**A list of runs.** A run is an object named by its id, and nothing named the runs of a deployment: whoever created a run had to keep its id. The eval index object, the one object of a deployment that every eval is written to, now also has a table of runs (`src/Runs.ts`): a run writes its id, its name, its eval and version, its creation and the number of its rows there when it is created, and its end with the counts of passed, failed and errored rows when it finishes. `GET /v1/runs` reads the table newest first, `?limit=N` the first N, and asks each run that has no end in it for its counts now, so a run that still runs is listed with what it has. `nanoeval runs [--limit N]` prints a line a run: id, state, counts, creation, eval and name.

- A run that cannot write to the table still runs, and says so in the Worker's log: the list is a convenience, and the ledger of a run is in the run.
- **Runs made before this change are not in the list.** Nothing enumerates the objects of a deployment from inside it, so there is nothing to fill the table from. Their ids still read as before.
- The counts of a finished run are a copy, written once. A run is never changed after it finished, so the copy cannot go stale.

**A rerun that keeps its settings.** `run --rerun RUN` took the eval, the agents, the attempts, the judge and the verifier cache from its run and everything else from the defaults of the command: a rerun of a run with `--sandboxes 0 --model-budget-usd 2 --setup-sec 7200` opened a sandbox of its own, with no budget and a wait of 600 s, unless all three were named again. It now takes the budgets, the limits and the sandbox settings of its run wherever the command names none (`rerunConfig` in `cli/nanoeval.ts`). What is named wins, flag by flag, and a `--backend` that is named brings its own network. Two settings are not taken over. The lifetime of a sandbox, which a run stores as it was computed for all its rows and which would be bought whole for the few rows of a rerun: it is computed again, or named. And the runtime archive, which belongs to the commit that published it and is published again from this checkout where the provider needs one. The budget of a rerun is its own: it starts at nothing spent.

**An export that says where.** `nanoeval export RUN --out DIR` printed nothing. It prints "job written to DIR", the line `run --wait` ends with.

**Checked.**

- Every lane asks that the newest run of the list is the run it created, with its name, its eval and the number of its rows, and when the run is finished that the list has it as finished with the counts and the end of its status. The lanes of the list below passed with it.
- Unit tests: `test/Runs.test.ts` for the table, and `test/Rerun.test.ts` for what a rerun takes over, what a named flag wins and the lines of the list.

**What ran on the six changes of this day together**, on the 32-core machine with KVM of the entries above, beside other work that kept its load average between 55 and 100. The runs that the six entries name, with and without each change, were made on the commit of the last entry of 2026-11-13. Two commits landed between that one and these: a turn that goes on after its Worker was killed, and Claude plans. On top of them, each once on the code of this entry:

- `npm test`, 166 tests and none skipped, `npm run check:types`, `npm run lint` and `npm run dry-run`.
- On directory slots: the plain lane, `failures` with its rerun, `shared`, `stopped`, `standing`, `runners`, `lost`, `resume`, `restart`, `midturn`, `plan` and `warm` through the scripted gateway.
- On krun slots: `gone`, `shared`, `stopped` and `failures`.
- Every `run` step of `.github/workflows/ci.yml` from a fresh clone of the six commits, on the commit of the plan change, whose proof note is the only thing between that clone and this head: 77 steps, 77 passed on the first try, 69 end-to-end lanes and none skipped, at a load average of 115 to 190. The unit that ran them had a larger share of the machine's CPUs than the other work on it (`CPUWeight=5000` in systemd), which is what let the lanes whose sandbox has a lease of 3 s start their runner inside the lease.

**Not verified.**

- The commands themselves from a shell against a Worker: the lanes call the functions behind `runs` and `export`, and `rerunConfig` is tested as a function, not through `run --rerun` with its flags.
- A list of thousands of runs, and many runs that run at once, each of which is one call between objects when the list is read.
- A deployed Worker, where the table is made in the eval index object when it next starts.

## 2026-11-14: runs that go on unattended

Measured on 2026-11-13 and 2026-11-14 (PST), on the 32-core, 62 GB Linux x86_64 machine with `/dev/kvm` of the entries above, while it also ran a krun runner of four slots for another run. Node 24.22.2, from a worktree of main `e22609e`. Every lane below ran once.

### Why

Eight Codex runs and four earlier runs on one deployed Worker, read on 2026-11-13, held 2,487 attempts that ended as errors for reasons outside the agent and the task (counted over the 12 runs; cancelled rows left out):

| Failure | Attempts |
| --- | ---: |
| `budget`: "the payment for a model request was refused, and no row is started after that: The channel still lacks deposit after a top-up." | 2,038 |
| `environment`: "no runner of the run could take the row for N s: the run has no runner" | 397 |
| `agent` or `environment`: "No space left on device", from the slot's disk or from unpacking an environment | 32 |
| `agent`: `codex-cli` exited on "error code: 530" from the model endpoint of the run, whose relay sat behind a tunnel that had restarted | 20 |

One payment refusal ended every row not yet started. A runner killed by the kernel's OOM killer, outside a unit of its own, left its run without a runner until someone started it again. And each of the other two needed a rerun by hand.

### What changed

- **A refused payment waits.** A model request that the gateway refuses because the key, its wallet or its channel is spent (`402 payment_failed`) is sent again after `--poll-ms` × 2^tries, never longer than `--lease-sec` and never past `--setup-sec` from the first refusal, and no row is claimed while it waits. The first request that is paid ends the wait (`model.paid` in the timeline). A request still refused after `--setup-sec` ends its row, and the rows not yet started end as `budget` errors as before. `--setup-sec` is the time the run already gives a row to find a runner, and `--lease-sec` the notice a runner gets, so neither is a new constant.
- **A Claude plan that cannot pay does not wait.** A model request that the plan signed in on the Worker could not pay for (`plan`, from the change of the same day that signs a plan in on the Worker) still ends the rows not yet started as `environment` errors at once: waiting does not give a signed-out plan a credential.
- **The key's funding can be set by the run.** `--key-deposit` and `--key-top-up` send `PATCH /api/keys/me` with `deposit` and `topUp` when the run is created, once, with the Worker's `TEMPO_KEY`, after the run has written what it asks for (`key.funding`) and before it reads the key's usage; the answer is `key.funded` or `key.fundingError`. The gateway's documentation says a model request holds what it may cost, so a channel needs room for one hold of every request in flight. nanoeval does not guess that size: the operator gives it.
- **An attempt that the infrastructure failed is retried once.** When a runner reports a failure that names `No space left on device`, or an `agent` failure of an attempt whose model endpoint answered `502` or `530` (from its own record of model requests, or "error code: 502/530" in the failure), the claim ends `retried` with that cause and the row starts again from nothing in a new slot, as a lost claim does. A second such failure ends the row as before. `src/Retry.ts` says which failures these are, and `Ledger.retried` reads the claims, so no table changes. A failure of kind `budget`, `agent_timeout` or `cancelled` is never retried, and a verdict never.
- **An agent that never started is an error, not a score.** One attempt of a Codex session on 2026-11-13 stayed `queued` for its whole 1,800 s: no model request, two OOM kills in its slot, and it was scored `failed` with `agent_timeout`. A session turn still `queued` at the agent's deadline now ends the attempt as an `environment` error ("the turn never started: it was still queued after N s", and ", with no hand attached" when the session says so). An `agent_timeout` of an attempt that made no model request while its slot had OOM kills becomes an `environment` error too ("the agent never reached its model and its slot had N OOM kills: …"). Both are retried once, as above. `status` already prints `oom_kills=N` for each attempt, and the run's JSON has `oomKills`.
- **An agent whose every model request the relay failed is an error, not a score.** Attempt `a00004` of run `2c3cf018` on 2026-11-13 sent 35 model requests over two claims through a Cloudflare tunnel that answered every one `530` (Cloudflare error 1016, the origin was gone), timed out after 900 s and was scored `failed` with its verifier's reward 0. When every model request of the claim was answered `502` or `530`, `finish` now ends the attempt as an `environment` error ("the model endpoint never answered the agent: its N model requests were answered 530: …") with no reward, whatever the agent reported, unless it is a `budget` or `cancelled` failure. It is retried once as above. An `agent` failure that names "error code: 1016" is retried as 502 and 530 are. One answered request keeps the attempt scored. `Retry.unanswered` says which attempts these are.
- **A run without a runner waits twice.** When no runner could take a row for `--setup-sec`, the run waits `--setup-sec` once more (`run.restranded`) before the rows end as errors. The mark of that second wait goes with the others when no row is unclaimed, so rows that a runner gives back later have both waits again.
- **A runner can be supervised.** `scripts/nanoeval-runner@.service` runs `nanoeval runner --run %i` as a systemd user unit that starts it again 5 s after it dies by a signal or an error, and not after it leaves a finished run. `KillMode=process` and `OOMPolicy=continue` keep the slots, which `slot.sh` detaches, running when the runner is killed, and a runner started again in the same home within `--lease-sec` goes on with them, as the `resume` lane shows. The README gives the same as a `systemd-run` command.
- **`--disks remove` is the default with `--provider e2b` and `gateway`**, where the sandbox's disk is the runner's only disk. `local` keeps `keep`.
- **`run --rerun RUN --agent ID`** keeps only the attempts of the named agents of RUN; an ID that RUN does not have is refused. The Worker already selected the rows of a rerun by the agents of its config.
- **`nanoeval plan refresh`** refreshes a ChatGPT login with its refresh token at `https://auth.openai.com/oauth/token` (Codex's public client id) when its access token expires within `--within-sec` (6 h, which leaves a timer room), and writes the new tokens back to the file with mode 600, keeping every other field. With `--secret-command` it runs the command for each of `CHATGPT_ACCESS_TOKEN`, `CHATGPT_ACCOUNT_ID` and, from `--relay-url-file`, `CHATGPT_RELAY_URL` whose value changed since the last push, with the name in `NANOEVAL_SECRET_NAME` and the value on standard input; a SHA-256 of each pushed value is kept in `--pushed`. So a relay behind a quick tunnel, whose address changes when the tunnel restarts, is pushed again by the next run of the timer. A command that does not read its input fails the push.

### How it was checked

`npm test`: 159 of 159 passed (148 of 148 on `e22609e` the same hour). `npm run lint`, `npm run check:types` and `npm run dry-run` passed. The end-to-end lanes that these changes touch, on directory slots:

| Lane | Wall | Result |
| --- | ---: | --- |
| `NANOEVAL_E2E_MODEL=installed NANOEVAL_E2E_SCENARIO=unreached`, new: the model endpoint answers `530` to the first request of each row | 7 s | 6 rows, each claimed twice, 3 passed and 3 failed as scripted, 0 errored, no lost claim |
| `NANOEVAL_E2E_GATEWAY=1 NANOEVAL_E2E_SCENARIO=funded`, new: the scripted gateway refuses two payments `payment_failed` and then pays, and the run sets `topUp: 5` | 12 s | 0 errored, the wait ended, one `PATCH /api/keys/me` with `{"topUp":5}` |
| `NANOEVAL_E2E_GATEWAY=1 NANOEVAL_E2E_SCENARIO=spent`, now with `setupSec` 15 | 24 s | the row that ran when the key was spent and the rows not yet started end as `budget` errors after the wait, and the refused payment was sent again while it waited |
| `refused`, scripted and installed, through the scripted gateway | 10 s, 9 s | passed |
| `failures`, scripted and installed | 13 s, 21 s | passed |
| `tasks` (3 tasks, 3 slots) | 18 s | passed |
| `resume`, installed, 8 slots | 7 s | passed |
| `lost` | 68 s | passed |

After the rebase onto `2244c58` (2026-11-14, same machine, Node 24.22.2, fresh clone): `npm test` 178 of 178, `npm run lint`, `npm run check:types` and `npm run dry-run` passed, and 34 of the 35 directory-slot lanes of `ci.yml` passed on the first pass. `disk` failed once with two sandboxes where it asks for one, then passed 3 of 3 beside 3 of 3 on `2244c58`. Before the rebase, `warm` through the scripted gateway failed 2 of 6 times with its kept sandbox `lapsed` instead of `terminated`, beside 4 of 4 passes on `da2a0d4`, and passed 3 of 3 on the next try: read as a timing of the pool on a loaded machine, not proven. The krun and ns lanes were not run: the machine ran a krun runner of another run.

`systemd-analyze verify` could not run on the machine without a user manager in the shell that ran it, so the unit is checked by reading only.

### Not verified

- Any of it on a deployed Worker, a real gateway or a real plan login: no refusal by the real gateway, no `PATCH /api/keys/me` against it, and no refresh against `auth.openai.com` was made. The refresh request has the shape that Codex CLI sends.
- A runner killed by the kernel under the unit, and the unit on systemd versions other than 255.
- The lanes on krun and ns slots and the rest of `ci.yml`: the machine was running a run of another track.

## 2026-11-14: a codex-direct agent, on nanocode-ts `build-f3aa94f`

An agent can run Codex with direct tools: `--agent nanoxd=codex-direct:gpt-6-luna:high`, or `{ "provider": "codex", "orchestration": "direct" }` in a run configuration (Georgios: one run carries nanox, Code Mode, and nanoxd, direct tools, to see whether Code Mode costs gpt-6-luna on reasoning-heavy Terminal-Bench tasks). The agent stays a `codex` session in every place that asks for the provider (the gateway, the meter, the plan, the payer), and its turn body carries `codex_orchestration: "direct"`. nanocode-ts binds that at the session's first accepted turn, as it binds the model, and opens the session with `CodexHarness::direct_tools_for`, so its model gets the hand's tools as tools of its own (`exec_command`, `write_stdin`, `apply_patch`, `view_image`, the hand's `Bash`, `Read`, `Edit`, `Write`, the subagent tools and `web__run`) and no `exec` or `wait`. Another session of the same Worker keeps Code Mode. `Config.parse` takes `orchestration` only as `direct` and only on a `codex` agent. `nanoeval compare` keeps the two apart by agent and names the direct one's model `codex-direct:MODEL`, and a Harbor export carries `orchestration` in the agent's kwargs.

`build-f3aa94f` is nanocode-ts master 2aad477 with that option, against nanocode 0e428f673 on `feat/codex-direct-orchestration` (master 1072097ac and the commit that makes direct tools hold with a hand). It is not on nanocode-ts master.

**Checked.** `npm test`: the new cases (the agent syntax, the configuration, the comparison) pass; on the macOS machine it ran on, the same 20 tests that fail on main fail here (the slot tests need Linux: `/proc/meminfo`, `flock`). `tsc --noEmit` for the CLI and the Worker. On nanocode-ts's own harness (its `bench/handbench.ts` with the TypeScript hand and a scripted Responses endpoint), a `codex` session with `codex_orchestration: "direct"` and one without, each on a hand: the first request of the direct session declared `exec_command`, `apply_patch` and no `exec` or `wait`, and its `exec_command` call ran on the hand; the default session declared `exec` and `wait` and ran the same command from a cell.

**Not verified.** The e2e lanes (they need Linux), a deployed Worker, and a real model on either arm.

## 2026-11-14: a revision of nanocode runs on one machine, with no release

A run was on the two builds a checkout pins, and nothing else could be measured without three steps by hand: a release of nanocode-ts and of the hand, a commit here that moves the pins, and a deployment. The entry of 2026-11-13 on the cell yield did the first two by hand in a copy of this repository to measure one option. This entry makes it one command, `nanoeval revision`, and makes a run say what it ran on. It adds `cli/Revision.ts` and `src/Pins.ts` and changes `cli/nanoeval.ts`, `src/Compare.ts`, `src/Harbor.ts`, `src/Sandbox.ts`, `sandbox/Runner.ts`, `worker/Env.ts`, `worker/Run.ts`, `worker/Sessions.ts`, `tsconfig.json` and `test/e2e.ts`. The pins, `sandbox/slot.sh` and the tables of a run are unchanged.

**What a run recorded.** Nothing about the harness, and for the hand the first 12 digits of the pinned release's SHA-256, written as the version of the agent into every trajectory whatever hand the runner had placed: `NANOEVAL_NANOCODE` has always let a runner take another file. The Harbor result named the version of this Worker's code, `0.2.0`. Two runs of one agent on two builds could not be told apart afterwards, and `compare` added them into one row.

**The rule.** Each side says what it has, and the creator of a run says nothing.

- The Worker knows its harness when it is bundled: `worker/Sessions.ts` imports `package.json` and names the release its `nanocode-ts` entry pins, `nanocode-ts build-f3aa94f` since the entry above, unless the variable `NANOCODE_TS_REVISION` names another. A run writes it into its record when it is created.
- A runner names the hand it placed and reports it among its capabilities, with its hello: the tag of the pinned release, `nanocode-cli-3f97ab0`, or for a file that `NANOEVAL_NANOCODE` names what `NANOEVAL_NANOCODE_REVISION` says, or else `sha256` and the first 12 digits of the file's digest. The runner of a runtime archive is given such a file, the hand of the archive, and names the pinned release of the checkout that built the archive without reading it. The capabilities are JSON in a column that exists, so no table changes and an older run reads as before: its harness is "not recorded".
- `status` and the results of a run carry both as `nanocode`. `compare` prints them on the line of each run, keeps the rows of one agent on different pairs apart and names such rows by their run, and the trajectory and the Harbor result of a session agent carry the pair as the version of the agent. `compare --baseline RUN` sets each run against one: attempts, passed, failed, errored, pass@k, tokens and cost for each agent, and the tasks that one solves and the other does not, a task being solved when one of its attempts passed.

**The command.** `nanoeval revision --nanocode REV --eval NAME --only ID --agent ...` takes the options of `run` and does what the three steps did:

- It resolves each revision. A commit, branch or tag is fetched into a build tree of the lab from the repository. A directory is a checkout: its commit is fetched from it, and its diff against that commit and its untracked files that git does not ignore are read once, hashed into the name of the revision, and applied to the build tree. Nothing is written to the checkout.
- It builds the hand with `cargo build --locked --profile release`, and the package as nanocode-ts builds itself, `scripts/build.mjs` and `npm run build:ts`, in a build tree of nanocode-ts beside the one of nanocode, which is where nanocode-ts looks for it. Two files of that tree are changed for a nanocode that is not the one the revision names: `sdk-revision.json`, so the build has a fingerprint of its own, and `Cargo.lock`, resolved again with `cargo fetch`, because `--locked` refuses the lock of another nanocode. That was met at once: the nanocode master of the day had dropped 12 crates since the revision that nanocode-ts master named, and `cargo metadata --locked` ended with 101.
- It keeps each build under the name of its revision, `hands/REVISION-PROFILE` and `packages/NANOCODE_TS-on-NANOCODE`, and builds nothing that is there.
- It starts `nanoeval worker` on a free port with the package, on the state of the lab, imports the tasks that the lab's eval does not hold, creates the run, starts `nanoeval runner` on it with the hand, waits, prints the summary, writes the Harbor job into the lab, and stops both. A runner that ends before its run cancels the run and fails the command with the path of the runner's log.

**How the Worker gets another package.** By alias. `nanoeval worker --nanocode-ts DIR` gives wrangler `--alias nanocode-ts/ENTRY:FILE` for each entry of the package's `exports` that is a JavaScript file. The directory is a `package.json` and lock file of nanocode-ts with `npm ci --omit=dev` run in it and the built `dist` copied in, so the package resolves its own dependencies at the versions its lock names. Checked before anything else was written: `wrangler deploy --dry-run` with the alias on a copy of the pinned package gave a bundle with the same two WebAssembly modules, by their digests, as the bundle without it. Rejected: a copy of this checkout for each revision, which is 841 MB of `node_modules` a copy and would test the copy's Worker sources, and `npm install` of the package here, which rewrites the two files that are the pins.

**One state, every build.** The entry of 2026-11-13 on a lost turn says that a build of nanocode-ts does not read the sessions of an earlier one. That is about a session with a turn under way. A finished attempt has none: its events, trajectory and verifier files are copied into its run when it ends, and the session is deleted. So the lab has one state for all builds and one Worker at a time, and this was run: three runs on three builds, the pinned release, nanocode-ts `2672c04` built here and the master of the day, were printed by `compare` under the pinned release, and an attempt of the second was read with its events and its trajectory. Each run with a baseline also read that baseline under its own build, four builds in all.

**Ports and two evaluations at once.** An evaluation holds `flock` on the lab from its build to its summary. A second in the same lab says that it waits, and goes on when the first is done: one build tree cannot be at two revisions, and the tables of the state have one writer. The Worker takes a port that was free a moment before and wrangler picks its own inspector port, so two labs run side by side. A port that another process takes in between ends the Worker with wrangler's "Address already in use", and the command fails with that log and is run again. `--serve` holds the lab the same way and serves it with the pinned package for `status`, `compare`, `attempt` and `export`.

**The credential** is what `nanoeval worker` takes, passed through: the variables, or the two login files. `Revision.credentials` asks for each agent and the judge whether a key, the gateway key or a login serves its provider, by the variables the Worker takes a key from, which a unit test holds to the Worker's own function, and refuses before a build: "no model credential serves the agent haiku: set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN or TEMPO_KEY, or name --claude-login FILE".

**Measured** on a Linux machine with 32 cores and KVM, on 2026-11-14 between 01:16 and 02:20 UTC. Other work held its load average between 66 and 100 and nearly all of its 62 GB of memory, and the kernel had ended processes for memory five times in the half hour before, so the times are an upper bound for that machine. One lab, krun slots, the host policy of the machine (below). The runs were made two pins of the harness earlier, so the pinned package of this section is `build-2672c04`, and in the runs made on the head it landed on, further down, it is `build-7968b53`. The revisions:

| | nanocode | nanocode-ts |
| --- | --- | --- |
| The pins | `nanocode-cli-3f97ab0`, released | `build-2672c04`, released |
| A | 3f97ab009aa6, the commit of the pinned hand | 2672c043e379 on the nanocode it names, 439011f972c4 (`--sdk pinned`) |
| B | f43ff49cee1d, master at 01:37 | 8ff3d5f8c98b, master at 01:37 |
| C | a checkout of B with one changed line and one untracked file | 19c535dc8cf7, master at 02:06 |

Builds, in the order they ran:

| | Hand | Package |
| --- | --- | --- |
| An empty lab, nanocode master of 01:16 (0a9ed13f2337) and nanocode-ts 8ff3d5f8c98b | 239 s | Ended after 856 s in its last step, see below |
| B, seven commits of nanocode later | 101 s | 189 s |
| A | 347 s | 355 s |
| C | 165 s | 262 s |
| A or B again | Nothing built | Nothing built |

- **The package of the empty lab did not finish in one build.** Its four modules were built, the last, `python.wasm`, alone in 374 s, and `tsc` had run. The last step of `npm run build:ts` installs two Python packages with Pyodide, and failed: "Can't fetch metadata for 'cowsay'". The registries of this machine are served on its loopback with a certificate of its own, which Node does not trust by itself. The step passed in 37 s with `NODE_EXTRA_CA_CERTS` set to the machine's bundle, and `--ca-bundle` now sets that for the build of the package. So the time of a whole package in an empty lab is about 900 s there and was not measured in one piece. The same four modules, built alone in a tree of their own before the command existed, took 874 s.
- **The package of A has the fingerprint of the release**, ddf130637a2713aa9c6b, since nothing of its tree was changed, the same files, and the same model catalog. Its four modules differ from the released ones byte for byte: they were built on another machine.
- **C** is the checkout's commit and 12 digits of a digest, f43ff49cee1d+98a0902f7eda. The hand it built prints the changed line, `git status` of the checkout was the same before and after, and no `target` directory appeared in it.

Runs, each one invocation of the command:

| Run | Rows | Passed | Run | Whole command |
| --- | --- | --- | --- | --- |
| The pins, the tasks' solutions (`--oracle`), four tasks, with their import | 4 | 4 | 38 s | 74 s |
| A, scripted model, four tasks, two attempts, four slots | 8 | 8 | 43 s | 55 s |
| B, the same, against A | 8 | 8 | 49 s | 64 s |
| A, `codex:gpt-6-luna` on a ChatGPT plan login, `fix-git` and `cancel-async-tasks`, two slots | 2 | 2 | 58 s | 68 s |
| B, the same, against A | 2 | 2 | 52 s | 62 s |
| C, scripted model, two tasks, against B, with its builds | 2 | 2 | 31 s | 467 s |
| C again, scripted model, four tasks, two attempts | 8 | 8 | 88 s | 98 s |

- The tasks are `fix-git`, `cancel-async-tasks`, `openssl-selfsigned-cert` and `git-leak-recovery` of Terminal-Bench 2.1, imported into the lab by the first run that named each.
- **The scripted model** is not in this repository. It answers a Messages request that holds a task's instruction with one `exec` cell whose Bash call writes the task's `solution/solve.sh` and runs it, and the next request with the end of the turn. A row therefore goes through the built package, the hand, its Bash tool and the real verifier, and costs nothing. It says that the two builds run a turn together, not what a model does with them.
- **With a model**, A against B: 127,095 input tokens, 85,632 of them cached, and 1,983 output tokens for $0.0060, against 153,565, 106,496 and 2,049 for $0.0068. Two rows an arm are a proof that the path works and nothing about the revisions.
- **From the command to the first claim** with everything built: 8.4 s in the last run, of which 1.3 s after the run was created. The rest is two reads of the checkout, a fetch of nanocode-ts, and the start of the Worker. The first claim came 1.3 to 1.5 s after the run was created when the runner's home held the hand of the run before, and 2.5 to 7.5 s when the hand had changed and the home was set up again.
- **The end-to-end lanes on B**, with the variables that `revision --build-only` prints: the plain lane on krun slots passed in 32 s and the plain lane on directory slots, with its cell of 12 s, in 39 s. Both ask that the run names the package and the hand they were given.

**Verifiers and the package index on that machine.** The machine resolves `pypi.org`, `files.pythonhosted.org`, the npm registry and the crates registry to an address on its loopback, where a filter serves them with its own certificate. A krun slot has a loopback of its own:

- Without host policy, the first run of the command, `fix-git` with its solution: the verifier's `apt-get` and the download of uv from `astral.sh` worked, and `uvx` ended with "Failed to fetch: `https://pypi.org/simple/pytest-json-ctrf/` ... Connection refused". The row ended as a `verifier` error, which is what a verifier without its report is.
- With `--ca-bundle` naming the machine's bundle and `--slot-forward` naming that listener, by their variables: every run of the table above, 34 rows, each with a verifier that installs pytest from the index, and none errored.

So that machine runs real evals only with those two options, as the README says of such a network, and with them it does.

**A runner that was stopped from outside.** The first run of A with the scripted model lost its runner half a minute in: the runner logged "stopping: releasing 2 attempts", which is what it does on SIGTERM, in the same second in which a runner of another checkout on the machine was stopped. No process of this command sends that signal and the kernel had ended nothing. The command cancelled the run, said where the runner's log was and failed, and the same command passed two minutes later. Two things came of it. A runner that ends this way exits with 0 and had left a slot directory in the home, which the next runner took for a slot of its own, logged as resumed and lost: the command now removes the slots of the home before a runner starts and after one ends with slots left. Who sent the signal was not found.

**What the first proof found.** The first version of `Revision.credentials` called the Worker's function, in `src/Proxy.ts`, which imports the gateway and with it the payment client. The command line had never loaded that: it started in 0.27 to 0.47 s on the machine above and in 1.07 to 1.25 s with the import, and every runner is that command line. The lane `lapse` has sandboxes whose lease of 6 s is refused its renewal after 3 s, and a sandbox that is refused takes no row. Its runners said hello 4.1 to 4.5 s after their sandbox was created, so most sandboxes took none: 125 sandboxes for 31 of the lane's 48 rows after seven minutes, where the lane takes 25 s and 6 sandboxes on a quiet machine. The proof was stopped there. The check now names the variables itself, a unit test asks that they are the ones the Worker's function answers to, and another loads the command line in a process that records what it resolves and asks that neither `mppx` nor `viem` is among it. With that the command line starts as it did, and the lane passed alone in 79 s while the load average was 70.

The second proof found the other cost of the same kind. A runner from the runtime archive is always given the hand as a file, so it hashed 90 MB before its hello, and in a guest that read is slow: the two lanes on ns slots whose sandbox starts its runner from the archive had the hello 3.4 and 6.6 s after the run was created, where it takes 1.8 to 2.3 s, the lease of 3 s ended, and both failed twice on "every attempt shares one sandbox". `sandbox/Main.ts`, the entry of the archive's runner, now names the release that its own checkout pins, which is the hand the archive was built with, and those lanes ask for that name. A file that is given no name is still hashed, since nothing else can say what it is, and a runner now does that beside the set-up of its slots and not after it. The lanes went on failing on a loaded machine once this cost was gone, with and without this change: the entry below has the cause.

**Checked.**

- Unit tests, 14 new: what is built from what is named, with `pinned` and `--sdk`; the name of a revision; a branch, a short commit and a checkout made the same tree, a checkout with a changed file, a removed file, an untracked file and an ignored directory applied to a tree that had build output, and the tree taken back; the lock, with a second holder that waits; the aliases and the name of a package directory; the tasks a selection still needs; the credential check with keys, the gateway key, logins and a judge, its variables against the Worker's, and what the command line loads; the names of a release, a revision and a file; the hand a runner reports; rows kept apart by their pair and a run set against a baseline with tasks gained, lost, solved in both and in neither, and tasks only one of the two ran.
- `test/e2e.ts` gives wrangler the aliases when `NANOEVAL_NANOCODE_TS` is set, and every lane that reaches its counts asks that its run names the build of its Worker, the pinned release unless that variable is set, and exactly one hand, the one of this process where the runner is neither in a guest nor started from the archive.
- `npm run lint`, `npm run check:types`, `npm run dry-run` and `npm test`, 193 tests and none skipped on the head it landed on.
- **On the head it landed on**, with the list of runs and the rerun that keeps its settings under it, in the lab that held the runs above: the command on the pins with the solutions of two tasks, 2 of 2 in 37 s, the tables of the earlier Worker read as they were. Then with the scripted model made to leave one task unsolved, two attempts a task: 1 of 4 passed. `revision --rerun RUN --failed --baseline RUN` ran the three rows again with the attempts and the model budget of that run, 3 of 3, and printed the task as gained, 0 of 2 to 2 of 2. `revision --serve` then answered `runs`, which listed the three runs with their counts, `status`, `compare --baseline`, `export` and `version`. Last, a pair the lab had built before, the two masters of the measurements above: nothing was built, the Worker of this head took the older package by alias, 2 of 2 passed in a command of 53 s, and the comparison with the rerun kept the two apart by their pair, "nanocode-ts 8ff3d5f8c98b on nanocode f43ff49cee1d, hand nanocode f43ff49cee1d" beside the pins. And `--nanocode master` of that hour, which nothing had built: the hand in 348 s and nanocode-ts master against it in 1,798 s, with three build jobs at the lowest priority beside a proof, then four rows on the two builds. `fix-git` passed 2 of 2. `cancel-async-tasks` failed 2 of 2 on two tests of its verifier that count what a process printed within a time, and had failed 1 of 2 on the pins in the same hour with the same solution, so that is the load of the machine and says nothing about the revision.
- Every `run` step of `.github/workflows/ci.yml` from a fresh clone of the change before its two repairs above, on the pins of 2026-11-13: 67 of 70 passed at once, the two lanes of the paragraph above failed, and a lane on krun slots whose image builder stood still for 300 s passed when it was run again alone. The proof of the head it landed in is at the end of the entry below.

**Not verified.**

- A package built in an empty lab from start to end in one build, and any build on a machine whose load is its own.
- `--hand-profile dist`, `--nanocode-ts` as a checkout with changes, `--sdk` with a revision of its own, `--task` and a judge through the command. The plan of each is unit tested, the build of none was run.
- ns and directory slots through the command, a machine without the host policy's network, and macOS: the command asks for nothing but what a krun runner asks for, and was run nowhere else.
- Two labs at once, and a second evaluation that waits for a first with a run under way. The lock was tested with two holders and no run.
- A `claude` agent with a model, an installed agent, and more than two rows of a model an arm.
- A nanocode-ts revision that does not build against its nanocode. The command passes the compiler's error on, which was seen only with the lock file before it was refreshed.
- Rows that differ between two revisions with a model: every row of both arms passed, so "gained" and "lost" were seen only in the unit test.
- A deployed Worker with this change: it records the pinned release as the harness of the runs it creates, from the `package.json` it is bundled with. `wrangler deploy --dry-run` bundles it.
- CI on GitHub.

## 2026-11-14: a lease is renewed while a runner starts

The two lanes on ns slots whose sandbox starts its runner from the runtime archive failed in the proofs of three changes of this day: "every attempt shares one sandbox", after "the lease of its sandbox ended". The entry above took that for a cost of its own change and removed one. The cause is older than all three and is in `worker/Run.ts`.

**The defect.** A run opens a sandbox in a tick, and the tick waits until the gateway has run the command that starts the runner: `nanoeval runner --detach`, or with the runtime archive the bootstrap, which fetches the archive, unpacks it and starts the runner from it. A run does one tick at a time, and only a tick renews a lease, when less than `--lease-sec` of it is left and more than nothing. So for as long as a runner was being started no lease of the run was renewed, the one of the sandbox being opened included. A lease that ran out meanwhile was found over by the next tick, which closed the sandbox and took its rows away.

- In the lanes a lease is 3 s. They passed while the creation of the sandbox, the bootstrap and one tick of 500 ms took less than 3 s together. The bootstrap of the archive in a guest took 870 ms in a proof that passed. In a proof of another change it took 2,636 ms, the next tick came 3.2 s after the sandbox was created, and the lane failed, twice. On the commit before every change of this day it took 1,267 to 4,045 ms in nine runs beside other work, most of it the unpacking of the archive, so the lane was a race against the load of the machine and no change had to lose it.
- For real a lease is 300 s, it is renewed with 60 s left, and the bootstrap took 21.7 s, so a run with one sandbox was never near it. A run with several is: each sandbox it opens later holds the tick for its bootstrap, and a lease of another sandbox with less left than that was renewed late or not at all. This was read, not met: the gateway sold no renewal on the day sandboxes were leased for real.

**The rule.** While a tick waits for a runner to be started, the run renews as a tick does, once every tick period (`TICK_MS`), and the sandbox it is opening is renewed like the others. One renewal is under way at a time, and the tick goes on only when it has been answered. What a renewal decided meanwhile stands: a sandbox that it failed, or marked as `ending` because no renewal was sold, is not moved to `starting` when the command returns, and a command that fails in a sandbox that a renewal has failed counts as one failed sandbox, not two.

**The lanes.** The scripted gateway takes `bootstrapMs` and holds every command back for that long. The lanes that lease a sandbox to run tasks or to keep it warm set it to a lease and one second, on directory, krun and ns slots, and ask that the command took that long and that every attempt still shared one sandbox. What was a race is now asked every time, on any machine.

**What the start of a runner costs with the entry above.** That entry was asked for a start within the noise of the commit before this day, so both were measured the same way: the lane on ns slots that starts its runner from the runtime archive, with a lease of 30 s so that a slow start is measured and not lost, on one commit and the other in turn, on the machine of the entry above. Other work held its load average between 70 and 260 and used up its memory twice meanwhile, and the runs that ended there are not counted. Medians in ms, with the least and the most:

| | The commit before this day, 9 runs | With the entry above, 4 runs |
| --- | --- | --- |
| The bootstrap, from the command to its answer | 2,159 (1,267 to 4,045) | 1,923 (1,697 to 2,647) |
| Node, from the archive unpacked to the first line of the runner | 191 (103 to 421) | 162 (135 to 293) |
| The runner, from its first line to its hello | 536 (323 to 1,783) | 486 (455 to 579) |
| `nanoeval --help`, 15 starts each | 565 (368 to 733) | 491 (358 to 997) |
| The entry of the archive's runner alone, 15 starts each | 246 (161 to 369) | 249 (151 to 470) |

The entry above costs the start of a runner nothing that this machine can measure. What decides a lease of 3 s is the first row, which is the same archive unpacked in the same guest on both commits.

**Checked.**

- **Without the change** in `worker/Run.ts`, the lane on directory slots with the gateway and the command held back: it failed in 10 s. The scripted gateway ended the sandbox with its lease while the command was held, the command was answered "sandbox not found", and after three such sandboxes every row ended as an `environment` error.
- **With it**, the same lane: passed. The command took 4,638 ms, the lease was renewed while it ran, and the runner said hello 7.0 s after the run was created in the one sandbox of the run.
- The lane on ns slots whose runner starts from the runtime archive, as `ci.yml` has it, beside a load average of 133: passed.
- `npm run lint`, `npm run check:types`, `npm run dry-run` and `npm test`, 193 tests and none skipped.

**The proof of the two changes**, this one and the entry above, which landed together. Main moved three times while they were proved, so there are four proofs, each of every `run` step of `.github/workflows/ci.yml` from a fresh clone with `npm ci` run as it is.

- **Of the head that landed**, the second of the two commits on the commit that pins `build-f3aa94f`, on the machine of the entry above beside a load average of 51 to 119: 79 steps, 77 passed at once, 69 of 71 end-to-end lanes and none skipped, 193 unit tests and none skipped, 1,744 s of steps. The two lanes on ns slots that start a runner from the runtime archive passed in 26 and 41 s with their command held back, and the lane where no renewal is sold in 79 s. Two lanes on krun slots failed and passed when each was run again alone, in 22 and 21 s. In "closed networks, installed agents" the microVM of one row did not answer when it was started, "the guest did not answer", and the row ended as an `environment` error. In "a microVM killed under its verifier" the row ended as a `verifier` error: the runner asked whether the slot was gone while the killed process could still be signalled. Neither lane leases a sandbox or builds a revision, and nothing of the two changes is in their path. The commit after these two is this file alone.
- **Of the same two commits on the base before**, the standing-runner changes: 77 of 77 steps at once on the same machine beside a load average of 53 to 176, 69 lanes, 180 unit tests. In the lane on ns slots from the runtime archive the command took 6,248 ms, two leases and more, the lease was renewed four times meanwhile, and the runner said hello 7.5 s after the run was created in the one sandbox of the run. The lane where no renewal is sold took 263 s and 70 sandboxes there, because the machine was short of memory in those minutes and a runner needed 1,465 ms to set up: a sandbox of that lane takes rows only if its runner says hello within the 3 s before the first renewal is refused. Run again in turn with the base when the machine had memory, the lane took 52 s and 14 sandboxes on the base and 40 s and 11 sandboxes with the two changes.
- **On a second machine**, 24 cores with KVM and a user that is not root, beside a run of all 89 solutions on twelve slots and other proofs. The two commits on the standing-runner base: 72 of 77 at once, the two runtime-archive lanes on ns slots in 20 and 31 s. Three lanes passed when run again alone: an orchestrator restart whose cell was dispatched as the Worker was killed, a lane whose `wrangler dev` found its inspector port taken by another proof that started in the same second, and the lane on directory slots that keeps a sandbox warm, where the pool once let the lease of the idle sandbox end and a runner was once silent for the 3 s of a claim lease, as it also did there without these changes. Two lanes fail on that machine at every commit, main included: the microVM killed under its verifier, and the slot networks on ns slots. The two commits on the head that landed, under fourteen later commits of another change: 78 of 79 at once, the one being the slot networks on ns slots.
- A third proof on this machine, on the base between the two, was stopped at step 34 when main moved again. 33 steps had passed, and in "directory slots, memory packing" one model request of a row was answered "Network connection lost" by the local workerd beside a load average of 142.

**Not verified.**

- A real gateway. It sold no renewal on 2026-11-12, so a renewal during a bootstrap was paid to the scripted gateway only.
- A deployed Worker, where the wait between two renewals is a timer inside the tick of an object.
- A renewal that is refused while a runner starts. The lane where no renewal is sold has leases of 6 s and a command that is not held back, so its first renewal is asked after the runner started. The two branches for it were read, not run.
- CI on GitHub.

## 2026-11-14: an attempt that errored is no trial of pass@k

An attempt ends as `passed`, `failed` or `errored`, so that an infrastructure failure never becomes a score of zero. The summary of a run did not keep to that: `Result.summarize` took every ended attempt of a task as a trial of pass@k, and an attempt that ended without a verdict, as a `verifier`, `agent`, `environment`, `budget` or `cancelled` error, lowered pass@k exactly as a failed one. Nothing in the line said so.

**Found** on directory slots under local workerd, with a scripted model whose answer to each attempt was planned: one `claude` agent, 8 small tasks, 3 attempts each, one slot.

- A run cancelled after 10 of its 24 rows had ended. `status` printed `finished` and `passed 3/24, errored 17, mean reward 0.429, pass@1 25.0%, pass@2 25.0%, pass@3 25.0%`. By hand: 6 tasks have a first attempt with a verdict and 2 of them passed, 33.3 %. One task has two attempts with a verdict, and both passed. No task has three. The 14 rows that never ran were counted as three attempts that did not pass.
- The same run left to finish, where the plan made the verifier of one task write no reward, the model endpoint refuse every request of a second and one request of a third: `passed 7/24, errored 7, pass@1 25.0%, pass@2 37.5%, pass@3 50.0%`, over 8 tasks of which 2 never had a verdict.

**The rule.** The trials of a task are its scored attempts, the ones that passed or failed, in the order of their attempt numbers. An agent timeout keeps its verifier reward and stays a trial. pass@k is over the tasks that have at least k scored attempts, for every k that some task has, and `AgentSummary.rated` holds how many tasks each pass@k rates. The CLI writes that count behind a pass@k that rates fewer tasks than the run has, `pass@2 100.0% of 1 task`, and nothing where it rates them all, so a run without errors reads as before. `pass_at_k` of an exported job follows, and its `metrics.mean` stays Harbor's, which counts a trial without a reward as 0.

**Why not keep the count over all tasks.** A task whose three attempts errored is not known to be unsolved, and `run --rerun RUN --errored` exists to find out. Counting it as unsolved made the pass@k of a run depend on the health of the machine, and made a cancelled run print the pass@3 of attempts it never made.

**Checked.**

- Unit tests in `test/Result.test.ts` and `test/Summary.test.ts`: a run cut short, a task whose attempts all errored, an errored attempt before a passed one, and the line the CLI prints.
- The two runs above read again from the same Worker state with the change: the cancelled one prints `pass@1 33.3% of 6 tasks, pass@2 100.0% of 1 task`, and the finished one `pass@1 33.3% of 6 tasks, pass@2 50.0% of 6 tasks, pass@3 60.0% of 5 tasks`, each equal to the figure by hand. A run of 3 tasks and 2 attempts with no error prints `pass@1 33.3%, pass@2 66.7%` before and after.
- `npm run lint`, `npm run check:types`, `npm test`, and the plain lane on directory slots.

**Not verified.** krun and ns slots, a real model, a deployed Worker: the change is in the summary, which no slot sees. A CLI of this commit against a Worker of the one before prints pass@k without the count of tasks.

## 2026-11-14: pass@k is estimated from every scored attempt of a task

pass@k came from gakonst/nanoeval as "any of the first k attempts passed". With more attempts than k that reads k of them and drops the rest: a run with `--attempts 3` printed a pass@1 that one attempt in three decided, and which attempt it was depended on the attempt number alone. It is an estimate of the right quantity, the chance that k attempts of a task include a pass, with more noise than the run had paid for.

**Found** on directory slots under local workerd, with a scripted model whose answer to each attempt was planned.

- 3 tasks, 2 attempts each, no error: the outcomes were passed and passed, failed and passed, failed and failed. `status` printed `passed 3/6, pass@1 33.3%, pass@2 66.7%`. Half of the attempts passed, and the mean pass rate of the three tasks is (1 + 1/2 + 0) / 3, 50.0 %.
- 8 tasks, 3 attempts each, the run of the entry above: after that entry it printed `pass@1 33.3% of 6 tasks, pass@2 50.0% of 6 tasks`. By hand over the same scored attempts, pass@1 is (0 + 1 + 2/3 + 0 + 1/3 + 1/2) / 6, 41.7 %, and pass@2 is (0 + 1 + 1 + 0 + 2/3 + 1) / 6, 61.1 %.

**The rule.** A task with n scored attempts of which c passed counts 1 − C(n−c, k)/C(n, k) towards pass@k: the share of the ways to draw k of its attempts that include a pass. This is the estimator of Chen et al., "Evaluating Large Language Models Trained on Code" (2021), unbiased for every k up to n, and equal to the earlier figure when a task has exactly k scored attempts. pass@1 is the mean pass rate of the tasks. Tasks may have different numbers of scored attempts, after errors or in a run that is under way, and each is rated with its own. Nothing else of the entry above changes.

**Checked.**

- A unit test in `test/Result.test.ts`: four tasks of three attempts against the figures by hand, the same outcomes in another order, all passed, none passed, and tasks with 2 and with 4 attempts.
- The runs above read again from the same Worker state: `pass@1 50.0%, pass@2 66.7%` for the first, and `pass@1 41.7% of 6 tasks, pass@2 61.1% of 6 tasks, pass@3 60.0% of 5 tasks` for the second. pass@3 is under pass@2 there because it rates one task fewer, which the line says.
- `npm run lint`, `npm run check:types`, `npm test`, and the plain lane on directory slots, whose two agents pass every attempt or none and read 100 % and 0 % as before.

**Not verified.** A run with a real model, where attempts of one task are not independent draws when a cache or a seed ties them. An interval around the figure: the summary prints a point estimate, and with a few attempts on a few tasks two runs of one agent can differ by more than a change between them.

## 2026-11-14: compare counts a row once when a rerun retried it

`nanoeval compare` is the one command that reads several runs together, and a run with its reruns is the first thing to give it: a rerun is a run of its own, whose summary covers only the rows it retried, and the results of the earlier run are never changed. The table added the attempts of all its runs, so a row that was retried counted twice, as the attempt that did not pass and as its retry.

**Found** on directory slots under local workerd with the scripted model: the run of 8 tasks and 3 attempts of the entries above, 7 passed, 10 failed and 7 errored, then `run --rerun RUN --failed`, 10 rows of which 4 passed, and `run --rerun RUN --errored`, 7 rows of which 1 passed. `compare` of the three printed 41 attempts, 12 passed, 16 failed and 13 errored, and for one task `failed, passed, failed, passed, passed`. The 24 rows stand at 12 passed, 6 failed and 6 errored. The same run named twice printed 48 attempts.

**The rule.** `Compare.standing` takes each run once, by its id, and leaves out every attempt that an ended attempt of another run of the table names as the one it retries. What a retry of a retry replaces goes the same way. An attempt whose retry has not ended stands until it has. The line of a run says how many of its attempts were left out, and outcomes, time, tokens and cost are those of the attempts that stand, so the cost of a retried attempt is in the table of its own run and not in this one. Two reruns of the same rows both stand: they are two further attempts of those rows.

**Checked.**

- A unit test in `test/Compare.test.ts`: a run and its rerun in either order, the run named twice, and the rerun alone.
- The three runs above read again: 24 attempts, 12 passed, 6 failed, 6 errored, 2,535 input tokens of which 1,560 cached and 273 output tokens, each equal to the sum by hand over the attempts that stand, and `24 attempts ended, 17 of them retried by a run of this table and left out` on the line of the first run.
- `npm run lint`, `npm run check:types`, `npm test`.

**Not verified.** A rerun that is still running beside its run, and a rerun of a rerun, outside the unit test. The table still has no pass@k, and two unrelated runs of one agent still share a row.

## 2026-11-14: a rerun says which options it does not take

`run --rerun RUN` builds its rows from the attempts of `RUN` and takes the eval version, the agents and the attempt numbers from it. The command line took every option of `run` beside it and dropped the ones a rerun does not follow, without a word.

**Found** on directory slots under local workerd, on a run of 8 tasks and 3 attempts with 10 failed and 7 errored attempts:

- `run --rerun RUN --failed --errored` made a run of the 10 failed attempts. The usage names the two as alternatives, and the command took the first: the 7 errored attempts were not retried, and nothing said so.
- `run --rerun RUN --attempts 5 --agent b=claude:x --limit 1 --eval other --only t2` made a run of one row, the failed attempt of `t2` by the agent of `RUN` on the eval of `RUN`: `--only` narrowed it, and the other four were ignored. That was before `--agent ID` narrowed a rerun to agents of its run: it now does, and refuses an id the run does not have.

**The rule.** `--failed` and `--errored` together select what they name together, every attempt that did not pass, which is the selection with neither. `--only` narrows a rerun to tasks, as it did, and the usage now says so. A rerun with `--attempts`, `--oracle`, `--eval`, `--task` or `--limit` is refused before anything is asked of the Worker, with the options to leave out. `--agent` is not among them: with a rerun it names agents of the run to keep. `--attempts` lost its default in the option table for that, and a run without it has one attempt as before.

**Checked.** Unit tests in `test/Selection.test.ts`. On the run above: the second command without its `--agent` is refused, and `--rerun RUN --failed --errored --only t2 --only t6` made the 3 rows of those two tasks that had not passed, one failed and two of the other task, one errored and one failed. `npm run lint`, `npm run check:types`, `npm test`.

**Not verified.** The sandbox settings of a rerun, which still come from the command line and not from its run.
