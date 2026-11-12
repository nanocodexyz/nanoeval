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
