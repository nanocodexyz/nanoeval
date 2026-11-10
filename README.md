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
| Slot backends `docker` and `dir` | Implemented, tested: up to 64 attempts at once in one sandbox |
| Released `nanocode hand` in a slot, including Alpine images | Implemented, tested |
| Real model run | Tested with `claude-haiku-4-5` through the Anthropic API and with `gpt-6-luna` on a ChatGPT plan login |
| Oracle run (`nanoeval run --oracle`): each task's own solution instead of a model | Implemented, tested |
| Terminal-Bench 2.1 tasks | 87 of the 89 load, and 2 need Compose. 11 ran with their own solutions and passed. 5 ran with a model. The other 76 have not run |
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
| Network isolation between local Docker slots | Missing. They share the host network, so two tasks that listen on one port interfere |
| Deployment to Cloudflare | Bundles with `wrangler deploy --dry-run`. Not deployed |
| `krun` (libkrun microVM) and `bwrap` slot backends | Planned |
| `allow_internet = false`, Compose tasks, separate verifier environments | Refused at submission. Planned |
| Reruns with lineage, prompt-cache cohorts, duration-ordered dispatch, R2 artifacts, MPP sessions | Planned |

## Run it locally

Requirements: Node 24, Docker, Linux.

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

`--out` writes the Harbor job directory. If the Docker daemon cannot apply cgroup limits, pass `--limits none`. `nanoeval status`, `attempt`, `export` and `cancel` read a run later. A local hand dials `ws://127.0.0.1`, which nanocode accepts only on loopback, so local Docker slots use the host network (`--network host`, the default for the local provider). Slots on one machine therefore share its ports.

Without an API key, a plan login works. `nanoeval worker --codex-login ~/.codex/auth.json` runs `codex` agents such as `--agent luna=codex:gpt-6-luna` on the ChatGPT plan signed in there, and `--claude-login ~/.claude/.credentials.json` does the same for `claude` agents. The access token is read once when the Worker starts and is never refreshed: sign in again with that tool and restart the Worker when it expires.

To check task environments and verifiers without a model, `nanoeval run --oracle --task DIR... --wait` sends each task's `solution/` and runs `solution/solve.sh` in the slot in place of the agent. No other run sends a solution.

## Keep it running on a Linux machine

```sh
npm ci
scripts/install-linux.sh --codex-login ~/.codex/auth.json
nanoeval run --oracle --task tasks/extract-todos --wait
```

The script needs Node 24, Docker and systemd. It writes two user services, `nanoeval-sandboxd` and `nanoeval-worker`, that listen on loopback (`--sandbox-port`, `--worker-port`), generates their tokens into `~/.config/nanoeval/env` with mode 600, and installs `~/.local/bin/nanoeval`, which reads that file. A run submitted with `--wait` and no `--out` is written under `~/nanoeval-runs` (`--runs`). Run the script again to change an option, and `loginctl enable-linger` to keep the services after you log out. The Worker runs from this checkout, and wrangler reloads it when the sources change.

Two options are for a machine whose network stands between its containers and the internet. `--ca-bundle FILE` makes slot containers trust that bundle when the network re-signs TLS. `--slot-env FILE` starts them with the variables of that file, such as a package index or `UV_EXCLUDE_NEWER` where the registry holds back fresh releases.

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
NANOEVAL_E2E_MODEL=anthropic npm run e2e   # a real model with ANTHROPIC_API_KEY
NANOEVAL_E2E_MODEL=codex-plan npm run e2e  # a real model on the ChatGPT plan of ~/.codex/auth.json
```

The scripted model answers the harness with fixed tool calls, so the end-to-end test needs no API key. It still runs the real Worker, the real nanocode-ts harness, the released hand and the real verifiers.

## Layout

| Path | Holds |
| --- | --- |
| `worker/` | The Worker: routes, the `Run` object, the harness sessions |
| `src/` | Host-agnostic modules: tasks, results, admission, budget, providers |
| `sandbox/` | `slot.sh`, the slot splitter, and `Sandboxd.ts`, the local sandbox daemon |
| `cli/` | The `nanoeval` command |
| `scripts/` | `install-linux.sh` and the E2B price quote |
| `tasks/` | Three small Harbor tasks from gakonst/nanoeval |
| `test/` | Unit tests, the end-to-end test and its failure fixtures |

## License

[MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
