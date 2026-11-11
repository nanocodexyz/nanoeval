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
