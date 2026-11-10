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

Machine for every measurement in this entry: a 32-core, 62 GiB Linux x86_64 machine with `/dev/kvm`, kernel 6.8, Docker 29.9.3 (systemd cgroup driver, cgroup v2), shared with other work (about 130 other containers ran throughout), Node 24.22.2, wrangler 4.151.1 (workerd 1.20261012.1), nanocode-ts `build-751e03a` and the same nanocode CLI release for the hand. Its network re-signs TLS to the Python and npm package registries and refuses packages published in the last few days. Each lane is one run, at commit `6259b05` unless it names another, with `TICK_MS=500` unless it names another.

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

Scripted model, Docker slots, limits enforced, 3 tasks × 2 agents, one sandbox, commit `34ced85` (the last two rows with `NANOEVAL_E2E_TICK_MS` added to the test). Every run ended with half of its attempts passed and half failed as scripted, none errored, and no container left.

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
- **What the verifier finds.** The hand is stopped before the verifier runs (`hand.status` was `exit:143` and the container held no hand process while a verifier ran), and a process the agent left running stays: a fixture in the failures lane checks it in a Docker slot. With directory slots the same background process was gone by verification unless it was started with `setsid`. That was not investigated, and the fixture runs with Docker only.
- **Not enforced.** `storage_mb` is read and ignored. The images of the sample have `bash`, so the limit recorded in the first entry did not come up.

### Slots on one machine share its network

Local Docker slots use the host network. Two measurements show what that costs. Two oracle attempts of `kv-store-grpc` at once both passed, although only one server can listen on port 5328: the second verifier reached the first attempt's server. And in the model run below, `kv-store-grpc` failed with `Connection refused` while an oracle run of the same task held the port and then went away, and passed when it ran alone. Attempts that listen on a fixed port are therefore not independent on one machine, and a task whose port a service of the machine already holds cannot pass. A slot with its own network stack is the fix, and it is not built.

### Plan logins

The machine had no API key. It had a ChatGPT plan login of the Codex CLI and an expired Claude Code login.

nanocode-ts opens a session in its subscription mode when `App.create`'s `subscription` answers true for the provider, and then expects the egress to add the plan's credential. `worker/Sessions.ts` answers true when the plan's variables are set and adds `Authorization: Bearer` for Claude, and that with `chatgpt-account-id` for Codex. Codex plan requests are WebSocket upgrades to chatgpt.com, which according to nanocode-egress refuses workerd, so they go to that package's relay on a loopback port. A direct connection was not tried here. `nanoeval worker` reads the access token from the login file at start, never the refresh token, and never writes the login file. It hands the variables to wrangler in a mode 600 file in a private temporary directory instead of `--var`, which put them on a command line.

```sh
NANOEVAL_E2E_MODEL=codex-plan NANOEVAL_E2E_THINKING=low node test/e2e.ts
```

| Lane | Attempts | Slots | Wall | Agent | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| `gpt-6-luna`, thinking low, ChatGPT plan, Docker slots, 2 tasks × 2 attempts, commit `987a69f` | 4 | 4 | 65.8 s | 23.4 s | 4 passed, 0 errored, $0.0103 by the harness's estimate |
| Same lane, second run, from a fresh clone of commit `0604e9f` | 4 | 4 | 28.6 s | 23.9 s | 4 passed, 0 errored, $0.0091 |

`NANOEVAL_E2E_MODEL=claude-plan` stopped before its run because the login had expired, so the Claude plan path has not carried a request. `NANOEVAL_E2E_MODEL=anthropic` was not run on this machine: it has no key.

Five Terminal-Bench tasks with `gpt-6-luna` at its default thinking, one attempt each, five slots at once, through the installed services (tick 2,000 ms):

| Task | Result | Agent | Model calls | Estimate |
| --- | --- | ---: | ---: | ---: |
| `openssl-selfsigned-cert` | passed | 26.4 s | 5 | $0.0024 |
| `cancel-async-tasks` | passed | 35.7 s | 4 | $0.0020 |
| `build-pmars` | passed | 118.5 s | 14 | $0.0084 |
| `log-summary-date-ranges` | failed: one count was 414 where the verifier expects 370 | 24.3 s | 4 | $0.0034 |
| `kv-store-grpc` | failed: the port was taken, see above. Alone it passed, in a run of 105 s | 52.2 s | 8 | $0.0040 |

The run took 134 s, with a median of 35.7 s in the agent and 9.3 s in the verifier, 551,832 input tokens of which 422,144 were cached, 6,118 output tokens, and $0.0202 by the harness's estimate. No attempt errored. The exported Harbor job is 824 KB, and its largest file is a 278 KB `events.jsonl`. Five attempts say nothing about a pass rate.

The harbor route used to return every artifact of a run in one response. It now returns the result files and the artifact names, and the CLI reads each artifact from its own route, so an export does not grow into one response with the run.

### Services on one machine

`scripts/install-linux.sh` writes two systemd user services on loopback, `nanoeval-sandboxd` and `nanoeval-worker`, generates their tokens into a mode 600 file, and installs a `nanoeval` command that reads it. `sandboxd` runs with `KillMode=process`, so restarting it leaves the phases that slots are running. From a login shell, `nanoeval run --oracle --task tasks/extract-todos --task tasks/write-greeting --slots 2 --wait` passed both attempts and wrote the job under the runs directory, and so did `--agent luna=codex:gpt-6-luna:low` on `extract-todos` and `uppercase-message` ($0.0067). The README's commands were also run as written: `nanoeval sandboxd`, `nanoeval worker`, then `nanoeval run` with `--oracle` (4 of 4 passed) and with `--agent haiku=claude:claude-haiku-4-5`, which ended as an `agent` error that says `ANTHROPIC_API_KEY is not set`.

### Limits of this version

- Slots on one machine share its network, as measured above.
- A plan login is read once. When it expires, its attempts end as `agent` errors until someone signs in again and restarts the Worker.
- The installed Worker runs from the checkout under `wrangler dev`, which reloads it when a source file changes.
- A verifier that cannot install its dependencies writes reward 0, and the attempt is scored as failed. Only an oracle run shows it.
- `storage_mb` is not enforced, and nothing removes the environment images that slots build.
