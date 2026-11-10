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

The phase times are dominated by the 500 ms tick: each phase waits for the next alarm. The real-model lane cost $0.089 by the harness's estimate from token usage. Its two failures are both `uppercase-message`: the model wrote the file without the final newline after working around the missing `bash`, and the verifier scored 0. Both `extract-todos` attempts passed.

The failures lane ended as designed: a verifier that writes no reward is `errored` with kind `verifier`, an agent past its 3 s deadline is cancelled and verified and ends `failed` with kind `agent_timeout` and reward 0, and a Dockerfile whose build fails is `errored` with kind `environment`. After every lane no slot container and no sandbox directory remained.

The restart lane sends SIGKILL to wrangler and workerd once an attempt is active, then starts them again on the same persisted state. The run's alarm fires again, the hands redial the same sessions, and the run finishes with the same eight scores and no errored attempt. A restart while a sandbox is being created is the one case that is not continued: that sandbox is marked `unknown`.

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
