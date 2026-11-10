<h1 align="center">nanoeval</h1>

Evaluations for [nanocode](https://nanocode.xyz) agents with the harness outside the sandbox. The orchestrator and each agent harness run in Cloudflare Workers on [nanocode-ts](https://github.com/nanocodexyz/nanocode-ts). Task environments run in remote sandboxes, and one sandbox is split into many slots, each with its own nanocode hand.

```
CLI ─▶ Worker ─▶ Run object ─▶ sandbox provider ─▶ sandbox ─▶ slot 1 … slot N
                    │                                            │
                    └─▶ one harness session per attempt ◀── hand ┘  (WebSocket, dialed from the slot)
```

- **Harness outside.** Model credentials and the event journal stay in the Worker. A task image gets no agent CLI, runtime or CA bundle installed.
- **Many attempts per machine.** `sandbox/slot.sh` gives each attempt its own container and hand inside one sandbox, admitted by free slots and memory.
- **Harbor in, Harbor out.** Tasks are Harbor task directories (Terminal-Bench 2.x layout). A run exports as a Harbor job with ATIF-v1.7 trajectories.
- **Typed outcomes.** An attempt is `passed`, `failed` or `errored`, and an infrastructure failure is never a score of zero.

[DESIGN.md](DESIGN.md) has the architecture and the alternatives it rejects. [DECISIONS.md](DECISIONS.md) records what each change established, with its measurements.

## Status

This is a first version. The table says what was run.

| Piece | State |
| --- | --- |
| Worker orchestrator (`Run` Durable Object), nanocode-ts harness sessions, CLI and API | Implemented. Tested end to end under local workerd |
| Local sandbox provider (`nanoeval sandboxd`) | Implemented, tested |
| Slot backends `docker` and `dir` | Implemented, tested: several attempts at once in one sandbox |
| Released `nanocode hand` in a slot, including Alpine images | Implemented, tested |
| Real model run | Tested with `claude-haiku-4-5` through the Anthropic API |
| Harbor job export and ATIF-v1.7 trajectories | Implemented. Shapes are unit tested. Not yet opened with `harbor view` |
| Failure kinds `verifier`, `agent_timeout`, `environment` | Implemented, tested |
| Orchestrator restart during a run | Tested: the Worker is killed with attempts in flight, restarts on the same state, and the run finishes |
| E2B over MPP provider | Implemented against E2B's documented protocol and tested against a local mock. The live `402` challenge is decoded by `scripts/e2b-quote.ts`. **No sandbox has been paid for or started yet** |
| Docker installation inside an E2B sandbox (`--docker install`) | Written, not run |
| Container CPU and memory limits (`--limits enforce`) | Written, not run: the development host's Docker could not apply cgroup limits |
| Codex models (`provider: codex`) | Wired, not run |
| Deployment to Cloudflare | Bundles with `wrangler deploy --dry-run`. Not deployed |
| `krun` (libkrun microVM) and `bwrap` slot backends | Planned |
| `allow_internet = false`, Compose tasks, separate verifier environments | Refused at submission. Planned |
| Reruns with lineage, prompt-cache cohorts, duration-ordered dispatch, R2 artifacts, MPP sessions | Planned |

## Run it locally

Requirements: Node 24, Docker, Linux.

```sh
npm install

# 1. Make this machine a sandbox host.
node cli/nanoeval.ts sandboxd --token "$SANDBOX_TOKEN"

# 2. Start the Worker. ANTHROPIC_API_KEY comes from the environment.
CLOUDFLARE_INCLUDE_PROCESS_ENV=true npx wrangler dev \
  --var ACCESS_TOKEN:"$TOKEN" \
  --var LOCAL_SANDBOX_URL:http://127.0.0.1:8788 \
  --var LOCAL_SANDBOX_TOKEN:"$SANDBOX_TOKEN"

# 3. Submit a run: 2 tasks, 2 attempts each, 4 slots in one sandbox.
node cli/nanoeval.ts run --url http://127.0.0.1:8787 --token "$TOKEN" \
  --task tasks/extract-todos --task tasks/uppercase-message \
  --agent haiku=claude:claude-haiku-4-5 \
  --attempts 2 --slots 4 --model-budget-usd 1 --wait --out output/job
```

`--out` writes the Harbor job directory. If the Docker daemon cannot apply cgroup limits, pass `--limits none`. `nanoeval status`, `attempt`, `export` and `cancel` read a run later. A local hand dials `ws://127.0.0.1`, which nanocode accepts only on loopback, so local Docker slots use the host network (`--network host`, the default for the local provider).

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
NANOEVAL_E2E_MODEL=anthropic npm run e2e   # the same with a real model
```

The scripted model answers the harness with fixed tool calls, so the end-to-end test needs no API key. It still runs the real Worker, the real nanocode-ts harness, the released hand and the real verifiers.

## Layout

| Path | Holds |
| --- | --- |
| `worker/` | The Worker: routes, the `Run` object, the harness sessions |
| `src/` | Host-agnostic modules: tasks, results, admission, budget, providers |
| `sandbox/` | `slot.sh`, the slot splitter, and `Sandboxd.ts`, the local sandbox daemon |
| `cli/` | The `nanoeval` command |
| `tasks/` | Three small Harbor tasks from gakonst/nanoeval |
| `test/` | Unit tests, the end-to-end test and its failure fixtures |

## License

[MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
