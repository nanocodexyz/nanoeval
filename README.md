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
- **Other harnesses beside it.** An agent of a run can also be Codex CLI or Claude Code: a pinned release that runs inside the slot and sends its model requests through the run, so one run compares them with nanocode on the same rows, and no model credential enters a slot either way.
- **Converted once.** `nanoeval import` runs a dataset's adapter, keeps each task's instruction, tests and solution apart as blobs, and converts its environment into the ext4 disk a microVM boots. Nothing is pulled or built when an attempt starts.
- **No container engine.** The launcher of the microVM backend reads a task's image from its registry, or runs its Dockerfile in a builder microVM, and writes the disk itself. No machine needs Docker, at import or at run time.
- **A durable table.** An eval version is named by a digest over its tasks and never changes. A run names it as `NAME@DIGEST`, and its rows hold every attempt, claim and result.
- **Runners that claim.** A runner admits by the free slots, memory and disk of its own machine, boots each claimed row under a copy-on-write disk, and reports to the run. Several runners on several machines work one run, and a row whose runner is lost is claimed again without scoring twice.
- **Harbor in, Harbor out.** Tasks are Harbor task directories (Terminal-Bench 2.x layout). A run exports as a Harbor job with ATIF-v1.7 trajectories.
- **Typed outcomes.** An attempt is `passed`, `failed` or `errored`, and an infrastructure failure is never a score of zero.

[DESIGN.md](DESIGN.md) has the architecture and the alternatives it rejects. [DECISIONS.md](DECISIONS.md) records what each change established, with its measurements.

## Quick start

From a clone to a pass@k table, on Linux with Node 24. Nothing here needs a model credential, KVM or root: the scripted model of this repository answers in place of a model, and `--backend dir` runs each attempt in a directory of this machine.

```sh
npm ci
node scripts/scripted-model.ts --task tasks/extract-todos --task tasks/uppercase-message --task tasks/write-greeting \
  --plan uppercase-message=fpf --plan write-greeting=fff &
export ANTHROPIC_API_KEY=scripted ANTHROPIC_BASE_URL=http://127.0.0.1:8790
node cli/nanoeval.ts revision --task tasks/extract-todos --task tasks/uppercase-message --task tasks/write-greeting \
  --agent scripted=claude:claude-haiku-4-5 --attempts 3 --backend dir
```

The last command starts a Worker and a runner, imports the three tasks, runs each three times, prints the summary and stops what it started: 17 to 32 s in five runs on a machine with 5 cores that other work shared, after 15 s of `npm ci`.

```
scripted: passed 4/9, errored 0, mean reward 0.444, pass@1 44.4%, pass@2 55.6%, pass@3 66.7%, input tokens 144 (0 cached), output tokens 72 (reasoning not reported), cost $0.0005
  a00001 nanoeval/extract-todos scripted #1 passed
  a00002 nanoeval/uppercase-message scripted #1 failed
  a00003 nanoeval/write-greeting scripted #1 failed
  ...
```

The plan makes the scripted model solve `extract-todos` every time, `uppercase-message` on its second attempt of three and `write-greeting` never, so the figures can be worked by hand: pass@1 is (3/3 + 1/3 + 0/3) / 3, and pass@3 is the two tasks of three that passed at least once. [Reading the summary](#run-it-locally) has the rule. The cost is what nanocode estimates from the tokens at the list price of the model that was named: nothing was charged.

- **With a model**, leave out the scripted model and the two variables, export a credential (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TEMPO_KEY`, or `--claude-login` and `--codex-login` for a plan) and name its model: `--agent haiku=claude:claude-haiku-5-5`, `--agent luna=codex:gpt-6-luna`.
- **With microVMs**, leave out `--backend dir` on a machine with KVM. `node cli/nanoeval.ts doctor` checks a machine for everything a run needs and prints, under each thing that is missing, the one command that gives it.
- **Read the run again**: `node cli/nanoeval.ts revision --serve --port 8787 &`, then `export NANOEVAL_URL=http://127.0.0.1:8787 NANOEVAL_TOKEN=$(cat ~/.local/share/nanoeval/lab/token)` and `node cli/nanoeval.ts runs`, `status RUN` or `attempt RUN a00002 verifier/test-stdout.txt`, which prints why the verifier failed that row. A run is named by its id, by the start of its id or by its `--name`.
- **Did a change break anything**: stop the scripted model, start it again with a plan that fails every attempt, `--plan extract-todos=fff --plan uppercase-message=fff --plan write-greeting=fff`, and add `--baseline previous --fail-on regression` to the last command. It prints the comparison with the run before, `verdict: regression`, and exits with 3. One task that went from 3/3 to 0/3 is `lost` and by itself no regression: the verdict asks all tasks together, and `--fail-on lost` gates on a single one.
- **Several arms against each other and a baseline, in one command**: `node cli/nanoeval.ts loop --task tasks/extract-todos --task tasks/uppercase-message --task tasks/write-greeting --agent a=claude:claude-haiku-4-5 --agent b=claude:claude-haiku-4-5 --backend dir` runs both arms on the same rows of one run, three attempts a task on one slot for each hardware thread, and prints a scorecard after the summary: a row an arm, one line for the whole loop with its wall time and its infrastructure errors, and a verdict against the run before, with exit status 3 on a regression. With a model credential, on a machine with KVM or as root, `node cli/nanoeval.ts loop` and one `--agent` for each arm is the whole command for the 30 tasks of the subset `hourly` of Terminal-Bench 2.1: [The loop](#the-loop).
- `node cli/nanoeval.ts help COMMAND` prints the usage of one command, and `node cli/nanoeval.ts` of all of them.

| To | Read |
| --- | --- |
| Keep a Worker up and make runs against it: choose tasks by pattern, subset or file, rerun what did not pass, compare two runs, gate a script | [Run it locally](#run-it-locally) |
| Set several arms against each other and a baseline in one command, with a scorecard | [The loop](#the-loop) |
| Evaluate a commit or a checkout of nanocode against a baseline | [Evaluating a nanocode commit](#evaluating-a-nanocode-commit) |
| Import a benchmark | [Datasets](#datasets) |
| Run nanoeval as services, with microVM slots, from a bare machine | [Keep it running on a Linux machine](#keep-it-running-on-a-linux-machine) |
| Evaluate every new commit of nanocode | [Following nanocode](#following-nanocode) |
| Hand runs to a runner that is already up | [How fast a run starts](#how-fast-a-run-starts) |

## Status

The table says what was run. "The first version" is the flow before the eval table, whose slots pulled images when an attempt started: [DECISIONS.md](DECISIONS.md) keeps what it measured.

| Piece | State |
| --- | --- |
| Eval table (`Evals` Durable Object): rows, immutable versions, `nanoeval import`, `evals`, `eval` | Implemented, tested: unit tests for digests and versions, and every end-to-end lane imports before it runs |
| Blob store by SHA-256: a directory on a machine | Implemented, tested. Terminal-Bench 2.1 is imported into one: 89 tasks, 19.2 GB of packed disks, in under 5 minutes |
| Blob store by SHA-256: R2 through the Worker | Implemented, tested end to end under local workerd: small evals, and one 1.40 GB disk uploaded in parts, downloaded, and downloaded again with the stream cut three times and resumed by range. Run against Cloudflare's R2 on a deployed Worker with four Terminal-Bench 2.1 disks of 38.6 to 147.1 MB: imported from a Linux machine in 85 s, and fetched there by a runner. Then all 89 disks of Terminal-Bench 2.1, 19.2 GB, imported in 2,169 s and fetched by runners in leased sandboxes |
| Environment conversion at import (`sandbox/Converter.ts`), with no container engine | Implemented, tested: `nanoeval-krun image build`, `pack` and `unpack`. The 89 images of Terminal-Bench 2.1, one SWE-bench instance image, `python:3.12-slim` and the 14 Dockerfiles of this repository converted. The 89 disks have the same trees as disks made from `docker export`, apart from the files an engine adds. See [DESIGN.md](DESIGN.md#environment-conversion) for what a Dockerfile may use |
| An import that converts several tasks at once (`import --jobs N`) | Implemented, tested: unit tests of the order of the rows, of how many convert at once, of two tasks with one image, of a failure beside others and of the room on the disk. On a Linux machine with KVM the 89 tasks of Terminal-Bench 2.1 were imported six at a time on six busy hardware threads in 205 s, with their layers already on the machine, and their rows were those of an import one at a time apart from the packed disks. Without `--jobs` an import converts one task at a time. **Not run**: side by side with no layer on the machine, the tasks' own solutions on those disks, Dockerfile builds side by side, more than twelve at once. See [DECISIONS.md](DECISIONS.md#2026-11-15-an-import-converts-several-tasks-at-once) |
| A registry dataset read ahead of its import (`terminal-bench-2.1`, `terminal-bench-2.0`): the archives of as many tasks as the import converts at once | Implemented, tested: a unit test that counts the archive requests in flight, and the import of the 89 tasks six at a time again on the same machine: 190 s, with 2 s of adapter where there were 47 s. See [DECISIONS.md](DECISIONS.md#2026-11-15-a-registry-dataset-reads-its-task-archives-ahead-of-the-import) |
| Image environments converted on a machine with root and no KVM | Implemented: the launcher without libkrun applies the layers of an image in a mount namespace instead of a builder microVM. Tested in an E2B sandbox: 3 Terminal-Bench 2.1 tasks imported in 12.7 s, and their solutions passed. Dockerfile builds still need KVM |
| Host policy for the `RUN` steps of a Dockerfile (`import --ca-bundle`, `--slot-env`, `--slot-forward`) | Implemented, tested on a Linux machine whose network re-signs TLS and serves the Python and npm registries on its loopback: a fixture that installs with pip and npm is refused without the options and imports with them, five Terminal-Bench 2.1 tasks built from their Dockerfiles, and no disk holds the bundle, a variable or a forward. On the base layers of the published images the trees differ only in what the day of a build decides, see [DECISIONS.md](DECISIONS.md#2026-11-11-the-smaller-gaps) |
| Run table (`Run` Durable Object): rows, claims, leases, CLI and API | Implemented, tested: unit tests for claims, leases, expiry and fencing, and end to end under local workerd |
| A request that the run answers before it has read its body: a run that does not exist, a runner token it refuses, an artifact of a claim that is gone | Implemented, tested end to end: the run reads what is left of the body first, so local workerd logs no `Can't read from request stream after response has been sent` and does not lose the request that follows. Every end-to-end lane ends by reading the log of its Worker and fails on a line that holds `Uncaught` |
| Task runners (`nanoeval runner`), started by a run through a sandbox or attached by hand | Implemented, tested: two runners with separate caches on one machine work one run |
| A timeline of every run: what the run, its sandbox and its runners did from its creation to the first claim, the first model request and each verdict (`nanoeval status`, `nanoeval timeline RUN`, `timeline.json` of an exported job) | Implemented, tested: unit tests, and read on a deployed Worker for every run of [How fast a run starts](#how-fast-a-run-starts) |
| No polling where a run starts: a claim, the attach of a hand and the end of a turn are requests the run holds until there is an answer, and a runner follows its slots by file events | Implemented, tested end to end: every lane runs on it |
| Standing runners (`nanoeval runner --standing`) and the pool of a deployment (`nanoeval pool`): a run is handed to a runner that is already there | Implemented, tested: unit tests for the table, and an end-to-end lane where two runs are handed to one runner and claim 10 to 13 ms after they are created. Run for real: 20 runs handed to a krun runner on a Linux machine, the first row claimed 0.11 to 0.39 s after each was created |
| A standing runner with several runs at once: their rows share its slots, a run created while it is busy is handed to it at once and waits for a free slot, and the runner enrols again when the pool closes it and leaves the pool when it is stopped | Implemented, tested: unit tests for the table, and end-to-end lanes on directory slots where a second run is created while the runner has a row in flight and finishes beside it, and where the pool is closed under an idle runner. Two runs at once also ran on krun slots under local workerd. **Not run on a deployed Worker** |
| A deploy restarts the objects of the Worker at once (`code_update_strategy` `immediate` in `wrangler.jsonc`), and the pool says which commit its object runs (`nanoeval pool`, `GET /v1/pool`) | Implemented, tested: a unit test holds the setting, and every end-to-end lane reads the commit from the pool. Under local workerd a pool started on this code removed the members of stopped runners 20 to 32 s later. **Not run on a deployed Worker**: local workerd defers no update, so what `immediate` does there is Cloudflare's word, see [DECISIONS.md](DECISIONS.md#2026-11-14-a-deploy-restarts-the-pool-at-once-and-the-pool-says-which-commit-it-runs) |
| A standing runner that a run took and handed nothing, because the run was restarted, cancelled or deleted between its two calls to the pool: its member goes back to the pool one notice later | Implemented, tested: unit tests for the table, and an end-to-end lane on directory slots whose pool loses the call that hands the runner its run. The run is cancelled, and a second run is handed the same member 10.5 to 11.1 s after the first was asked for, with a notice of 10 s, and ends as any run, 3 times of 3. Without the change the rows of the second run end as `environment` errors when `--setup-sec` is over. **Not run on a deployed Worker**, see [DECISIONS.md](DECISIONS.md#2026-11-14-a-member-that-a-run-took-and-handed-nothing-goes-back-to-the-pool) |
| A sandbox kept warm between runs (`run --warm-sec`): its runner stands by with its disks unpacked, and the pool renews and terminates it | Implemented, tested against the scripted gateway on directory and ns slots: the second run pays for no sandbox and fetches no disk, the pool renews the lease while the sandbox is idle and terminates it when the idle time ends, and every charge is recorded once. Run for real: one run on a kept sandbox claimed 0.55 s after it was created, and the pool terminated two sandboxes at the end of their idle time. **The pool has not paid a renewal for real**: the gateway sold none |
| A runner lost during a run: its rows are claimed again, at most `--claims` times, and nothing scores twice | Implemented, tested end to end: a killed runner's rows end scored by the other runner, with the lost claims recorded, and `status` counts them and says why the last one ended, which the lane on directory slots reads |
| A slot that ends under its row, such as a microVM that the kernel killed for memory: the row goes back to the run and is claimed again | Implemented, tested end to end on krun slots: a microVM killed with a signal while its verifier runs, and the row passes on its second claim. A process that was killed and is still ending counts as gone: on a 24-core machine the lane passed 0 times of 4 before that and 4 of 4 after. Not run with a kill by the kernel, and not on ns slots |
| A slot that ends under the agent of its row: the row goes back when the slot ends, not when the agent does, and the turn of its session is stopped | Implemented, tested end to end on krun slots: a microVM killed with a signal under a session whose model call is parked, under a solution and under an installed agent, and each row passes on its second claim. The row of the session went back 0.2 to 0.5 s after the kill, where it had waited for the 60 s of its agent before. Not run with a kill by the kernel, and not on ns slots |
| A runner stopped during a run: its rows go back at once, it is handed none on its way out, and it leaves no slot | Implemented, tested end to end on directory slots: a standing runner is stopped later than `--setup-sec` with a row in flight, and the runner started after it finishes the row on its second claim, within seconds and not a lease |
| A leased sandbox that dies during a run, and one whose lease ends | Implemented, tested end to end against the scripted gateway on directory and krun slots: the rows of a sandbox that died are claimed again in another, also when its provider ended it under a paid lease after creates had been refused, and a run goes on in new sandboxes when no renewal is sold. The lane ends its first sandbox under a row that waits for a model answer which the scripted gateway never gives, so it does not depend on how fast the machine is: on a 48-thread machine it had failed 6 times of 12, with every row done before the sandbox died. The second also ran for real |
| A sandbox that could not be opened: refused for now by its provider (a cap, a rate, a payment that may pass, a `5xx` problem of the gateway), or one that failed | Implemented, tested: unit tests of the rule and a lane against the scripted gateway on directory slots, which refuses creates as the deployed gateway does, after the payment and naming nothing, and as one that names what was kept and when to ask again and refuses before its price meanwhile. The run asks again after a pause that doubles from `--lease-sec` to `--setup-sec`, the sandboxes it has work on, `status` says what was refused and when it is asked for again, counting as open only a sandbox that its provider answered for, and rows end as errors only after `--setup-sec` with no sandbox left. A create that the provider was paid for before it refused stays in the spend. **Not run** against the real gateway, see [DECISIONS.md](DECISIONS.md#2026-11-14-a-sandbox-that-could-not-be-opened-is-asked-for-again) |
| A leased sandbox whose lease ends while its runner is started | Implemented, tested in the lane of a gateway that sells no renewal, on directory slots: it is closed for its lease like any sandbox whose lease ends, where the command that the end broke had made it a sandbox that failed, and the run asks for the next after the pauses of a refusal and ends the rows after `--setup-sec` with none started, see [DECISIONS.md](DECISIONS.md#2026-11-14-a-lease-that-ended-while-a-runner-started-is-asked-for-again-with-the-pauses-of-a-refusal) and [DECISIONS.md](DECISIONS.md#2026-11-14-a-sandbox-whose-lease-ended-while-its-runner-started-is-closed-not-failed) |
| A leased sandbox whose provider ends it sooner than the run knew | Implemented, tested: a renewal that the gateway refuses because it would pass the end of the sandbox, and that names that end, moves the end the run plans against. The run renews the lease up to it, asks no more, uses the sandbox to it and opens another for the rows that are left. Unit tests of the provider and a lane against the scripted gateway on directory slots. **Not run** against a gateway that answers so: none was deployed, see [DECISIONS.md](DECISIONS.md#2026-11-14-a-refused-renewal-that-names-the-end-of-a-sandbox-moves-it) |
| A leased sandbox whose runner left before the run saw it start | Implemented, tested in that lane: it is closed by the tick that sees it, where it was kept, with its lease renewed, until `--setup-sec` had passed, see [DECISIONS.md](DECISIONS.md#2026-11-14-a-sandbox-whose-runner-left-before-the-run-saw-it-start-is-closed) |
| A runner restarted during a run | Tested: it goes on with the slots it had and loses no claim. Started again after a restart of its machine, or by a nanoeval with another hand, backend or network, it sets its home up again, and the rows of the slots that ended with the machine go back to the run: a unit test of `slot.sh setup` with the boot id that the home recorded rewritten. **Not met on a machine that restarted** |
| A runner whose machine cannot bring a slot up | Implemented, tested: the row goes back to the run and counts one claim, the runner claims no more rows, finishes the ones whose slots are up and exits with what the machine said, and `status` shows it as refused. A unit test of the exit status of `slot.sh up`, and an end-to-end lane on directory slots beside a runner that works: every row ends scored there and none errors. By hand: the `up` of an ns slot as root with a cgroup that is gone, a home that is full, the same runner started again once its machine was repaired, and a leased sandbox against the scripted gateway, which is failed and replaced. **Not run**: the lane on krun slots, an ns slot in a run, a real sandbox |
| A session that no longer has the turn of its row: its object was deleted, or started empty under another nanocode-ts build | Implemented, tested: the run ends the claim as `forgotten` with what the session answered, the row goes back and counts one claim, and a row that is out of claims ends as an `environment` error that names the session. A unit test of the ledger, and an end-to-end lane on directory and krun slots that removes the session objects of a Worker under a row in its `run` phase: the row was claimed again a tenth of a second after the Worker answered, ended scored, and the spend kept the response the lost session had been answered. Without the change the same lane ends after four leases, 240 s, with the row an error. By hand: a row out of claims, a judge session, and sessions lost while the verifier ran. **Not run**: a deployed Worker, a move between two nanocode-ts builds, a session lost before its turn was submitted |
| A session deleted while it holds a socket or an event stream open: a cancelled run, a lost claim, a key spent under a turn | Implemented, tested end to end on directory slots: a lane cancels a run while a cell of a turn runs on its hand, with a second socket attached to the session and its events being read, and, as every lane, fails on a line of its Worker's log that holds `Uncaught`. The object of the session ends its event streams and waits for its sockets to close before nanocode-ts deletes it, and the run ends a claim before it deletes the sessions of the claim, so a local Worker logs no `Uncaught Error: session deleted`. The change that makes this nanocode-ts's own is in DECISIONS.md |
| The protocol between a runner and a Worker has a number: `nanoeval version`, `GET /v1/version`, and a runner that does not start against a Worker of another | Implemented, tested end to end under local workerd. Not run against a deployed Worker, where the commit comes from `wrangler deploy --var` |
| Rerun lineage (`nanoeval run --rerun RUN [--failed] [--errored] [--only ID]... [--agent ID]...`) | Implemented, tested end to end: each row names the attempt it retries. `--failed` and `--errored` together are every attempt that did not pass, and a rerun is refused with an option it would not follow (`--attempts`, `--oracle`, `--eval`, `--task`, `--limit`): unit tested, and run on directory slots. The command takes the budgets, limits and sandbox settings of its run where it names none: unit tested. `--agent ID` keeps the attempts of those agents only (unit test) |
| The trials of an exported rerun: a row that retries another is `TASK__AGENT__N__retry-RUN`, after the run it is a row of, and its `result.json` names the trial it retries | Implemented, tested: a unit test of a run, its rerun, a rerun of that and a second rerun of the run, whose five trials have five names and one arm in `compare`, and the failures lane on directory slots, which exports a run and its rerun and asks that their 8 trials have 8 names. Both jobs load with the models of Harbor 0.25.0. A row that retries nothing keeps its name. The two jobs of that lane were exported with the command and read with those models: 8 directories with 8 ids when put together, see [DECISIONS.md](DECISIONS.md#2026-11-14-the-export-changes-on-the-newer-base-read-with-harbors-models-and-two-lanes-that-failed-under-load). **Not checked**: two tasks of one eval whose names end alike would share a trial |
| `nanoeval runs`: the runs of a deployment, newest first, with their state and counts | Implemented, tested: a unit test for the table, and every end-to-end lane reads its run from the list. Runs made before the list existed are not in it |
| One automatic retry of an attempt that the machine or the way to the model failed: a slot out of disk (`No space left on device`), a model endpoint that answered `502` or `530`, a session turn still `queued` at the agent's deadline, a timeout with no model request and OOM kills in the slot, or an attempt whose every model request was answered `502` or `530`, the last three scored as `environment` errors | Implemented, tested: unit tests, and an end-to-end lane on directory slots whose model endpoint answers `530` to the first request of every row. The claim ends `retried` with the cause, and the row starts again from nothing in a new slot. **Not run** on a deployed Worker |
| A model provider that limits an installed agent: an answer of `429`, `503` or `529` to a request of `claude-code`, `codex-cli`, `fx`, `opencode` or `pi` is not passed to the agent. The run asks the provider again, after `--poll-ms` doubled with each of the first `--step-retries` answers (2 s with the defaults), and no sooner than a `Retry-After` names, for as long as the attempt has agent time left. Each wait is in `agent/model-requests.jsonl` (`wait`, ms), the row has `modelWaits` (count and seconds), `status` prints `model_waits=N (S s)` for it, and the summary of each agent sums them. An attempt of any agent that ends as an agent error or at its timeout without a pass, with the provider's last answers all limited, is an `environment` error that says so and is retried once | Implemented, tested: unit tests of the pause, of `Retry-After` in seconds and as a date, of the relay against a scripted provider, and of the error; an end-to-end lane on directory slots whose provider answers the one request of every row `429` with `Retry-After: 1`, then `429` without, then the reply. A session's requests are not waited for by the run: its client asks again itself. **Not run** on a deployed Worker |
| A pace for a model whose endpoint answers a known number of requests a minute (`run --model-requests-per-min [MODEL=]REQUESTS`): the run sends the requests for that model, of every agent and the judge on it, one interval apart in the order they came (3 s at 20 a minute), before the first ask and before each ask again, asks again after one interval where the provider still limits one, and gives a runner no row on the model while a request that came now would be held longer than two intervals or while the rows asking it, at the requests a minute its rows have made so far, leave no room under the pace. A held request is a wait of its row (`wait` in `agent/model-requests.jsonl`, `modelWaits`, `model_waits=N (S s)`), and `arms` prints `model waits N (S s)` for an arm | Implemented, tested: unit tests of the slot times, of the rows a pace feeds and of 4, 8 and 16 rows against a provider that counts a sliding minute; an end-to-end lane on directory slots for sessions and one for installed agents, two models each, whose provider answers one request of a model in 2 s and refuses the rest: it refused none in either, and the lane of sessions fails without the pace, without the rule for claims and without the hold. The rows of the lane of installed agents ask once each and none was held there: the hold of an installed agent is read from a real arm. One real arm each way on a model limited to 20 requests a minute, see [DECISIONS.md](DECISIONS.md#2026-11-15-a-run-sends-the-requests-for-a-model-at-the-pace-its-endpoint-answers). **Not run**: krun slots, a deployed Worker, sessions or a judge on a real route, two paced models on a real route |
| The summary of a run (`status`, `run --wait`, `result.json` of an exported job): outcomes, mean reward and pass@k for each agent | Implemented, unit tested. pass@k is estimated from every scored attempt of a task, whatever their order. An attempt that errored or was cancelled is no trial of pass@k, and a pass@k that rates fewer tasks than the run has says how many. Read on directory slots with the scripted model, on runs of 2 and 3 attempts a task and on one cancelled after 10 of its 24 rows, each figure against one worked by hand, see [DECISIONS.md](DECISIONS.md#2026-11-14-passk-is-estimated-from-every-scored-attempt-of-a-task). A cancelled run is named as one |
| `status`: tokens and cost for each agent, the judge on a line of its own and in `compare` and the exported totals, the reruns of a run, and one line a task where the attempts do not fit the screen | Implemented, tested: unit tests with sums by hand, the judge lane on directory slots, whose run prints the agents at $0.000112 and $0.000336, the judge at $0.000112 and a spend of $0.000560, and the run of 24 rows read in both forms. **Not run**: a real judge, a real terminal (the height is passed in the unit test), see [DECISIONS.md](DECISIONS.md#2026-11-14-the-summary-carries-tokens-cost-the-judge-and-one-line-a-task) |
| The cost of an attempt that hit its agent timeout, or whose turn failed | Implemented in nanocode, pinned since nanocode-ts `build-39696b0`: a turn that was cancelled or failed reports the cost of the model calls it completed, and the attempt, the spend of the run and `--model-budget-usd` hold it. Tested end to end for a turn that a model budget ended, in the lane of web searches at list price, which asks that no attempt is left without a cost. **Read once, in no lane**, for an attempt at its agent timeout on directory slots: its one model call cost $0.000028, where the build before left it without a cost. A turn that ended before its first response has none, and `status` still counts an attempt whose model calls have tokens and no cost, see [DECISIONS.md](DECISIONS.md#2026-11-14-a-turn-that-failed-or-was-cancelled-has-a-cost-on-nanocode-ts-build-39696b0-and-the-lane-of-web-searches-counts-it) |
| What a refused command prints | Implemented, tested: one line on standard error, `nanoeval: ` and the message, with the route and the status behind what the Worker said, and exit status 1. Unit tests, two of which run the command, one against a server that answers `404` for a run and for an artifact, and the lane `machine` on directory slots, whose runner ends with that line |
| What a refused command says to do next | Implemented, tested: a missing `--url` or `--token` names its variable, a Worker that does not answer is said to be one with the command that starts it, a run is refused before it is made when the Worker holds no credential for the provider of an agent or of the judge, a task whose environment becomes a disk, from an image or a Dockerfile, is refused on a machine where no microVM starts, before the launcher is built and before its image is pulled, and the refusals for an eval, an attempt and an environment of the other kind name the command or the option to use. Unit tests, three of which run the command, and each read from a shell on directory slots on a machine without KVM, see [DECISIONS.md](DECISIONS.md#2026-11-14-a-cold-start-from-the-readme-and-what-it-changed). **Not run**: the refusal for a credential against a deployed Worker |
| `nanoeval help COMMAND` and `COMMAND --help`: the usage of one command, and an unknown command named with the commands that exist | Implemented, tested: a unit test runs the command for every command the usage lists |
| A run named by the start of its id or by its `--name` | Implemented, tested: a unit test of the rule, and `status`, `compare --baseline` and `run --rerun` read from a shell with short ids and names on directory slots. A run that the list of runs does not hold is named by its whole id |
| `nanoeval doctor`: a machine checked for what a run needs, with the one command for each thing that is missing | Implemented, tested: unit tests of every check on described machines, and run on a 5-core machine without KVM, where it ends `ready for dir slots` and names three things missing for krun. A base URL that the shell names for a model is asked, and is missing when nothing answers. Run by a first-time operator on a bare machine with KVM, before that check: each command it printed ran as printed, and as root it found nothing missing for ns slots. **Not run**: against a deployed Worker, see [DECISIONS.md](DECISIONS.md#2026-11-14-a-cold-start-from-the-readme-and-what-it-changed) and [what the first start found](DECISIONS.md#2026-11-14-a-status-line-that-counted-a-sandbox-still-asked-for-and-checks-that-read-a-clock-where-an-order-was-meant) |
| A scripted model outside the lanes (`scripts/scripted-model.ts`): a Messages endpoint that answers each task with its own solution, run until its process has exited, or with nothing where a plan says so | Implemented, tested: unit tests of the plan, of the cell and of the endpoint, and the [Quick start](#quick-start) run on directory slots, whose pass@k is the one its plan gives by hand. Run by hand on directory slots with a solution of 14 s, which failed before, and with one of 135 s, past the time of one cell. It answers `claude` agents only, sends the solution as one command, which the hand refuses past the size of one argument, and sends no other file of `solution/` |
| A failure miner outside the lanes (`scripts/mine-failures.ts`, `src/Mine.ts`): pulls the failed attempts of chosen agents from runs, pairs each with a passing attempt on the same task, summarizes both trajectories and verifier output, puts each failure in one class (heuristic, or `codex exec` with `--classify codex`) and writes a ranked report | Implemented, tested: unit tests of the classes, the pairing and the report, and a replay of a fabricated cache with `--offline`. **Not yet run on a real run**, see [DECISIONS.md](DECISIONS.md#2026-11-14-a-failure-miner-classes-the-failed-attempts-of-runs) |
| A row read while it runs (`nanoeval attempt RUN ATTEMPT [ARTIFACT]`): the events and the trajectory its session has so far, and the model requests that were answered | Implemented, tested end to end on directory slots: the lane with the rows of two runs parks a model request and reads the events of that row with the command, which end with the result of its tool, then its trajectory and its one answered request, and asks that a file the row does not have yet and a run that does not exist are refused in one line. An installed agent gives its model requests only. **Not run** against a deployed Worker or on a session with hours of events, see [DECISIONS.md](DECISIONS.md#2026-11-14-a-row-is-read-while-it-runs) |
| nanocode-ts harness sessions | Implemented, on nanocode-ts `build-b8158fd` with the hand `nanocode-cli-0bbcb64`, two builds of one nanocode revision. The figures of this table were measured on earlier pins, and the builds since `build-f3aa94f` change what every session is sent and reads: [DECISIONS.md](DECISIONS.md#2026-11-14-what-the-builds-since-build-f3aa94f-change-for-a-session-and-the-lanes-for-a-turn-that-goes-on) lists it, and no run with a model on these pins is recorded there. Tested end to end under local workerd. A cell that names no yield runs for two minutes before it goes back to the model (`CELL_YIELD_MS`), where the protocol gives it 10 s: the plain lane on directory slots runs a cell of 12 s and asks that it ends in the exec that started it. Measured with a model on 20 tasks, one attempt each: 174 model calls where 10 s took 219, 9 `wait` calls where it took 29, 17 passed where 16 did. See [DECISIONS.md](DECISIONS.md#2026-11-13-a-cell-yields-after-two-minutes-set-by-the-brain) |
| A `codex` session with direct tools (`codex`, the default since 2026-11-15; `codex-direct` is the same), beside one in Code Mode (`codex-code-mode`) in the same run | Implemented, tested end to end on directory slots with the scripted model: the lane `direct` asks that the model of one session is given `exec_command` and neither `exec` nor `wait`, that the model of the other is given `exec` and `wait`, that each command ran on the hand and that both rows pass. On a build of nanocode-ts that does not read `codex_orchestration` both sessions are given `exec`, which the lane refuses: that case was not run. **Not run**: a real model on either arm, see [DECISIONS.md](DECISIONS.md#2026-11-14-a-lane-for-a-codex-session-with-direct-tools) |
| A `codex` session whose model nanocode asks over chat completions on Workers AI (`codex:glm-5.3` or `codex-code-mode:glm-5.3`, with `WORKERS_AI_ACCOUNT_ID`): nanocode's own chat completions transport, its request forwarded and metered like any other of a `codex` session | Implemented, tested: a unit test of the variables `nanoeval worker` hands a local Worker. Ran with a model on a route that serves chat completions only, through a forwarder outside the repository that answers on Cloudflare's path and renames the model to `@cf/zai-org/glm-5.3-flash`: 6 of 6 rows of the three fixture tasks passed on directory slots, three with direct tools and three in Code Mode, and 4 of 4 small Terminal-Bench 2.1 tasks on krun slots in Code Mode. Without the variable 3 of 3 rows ended at once as agent errors. **Not run**: `@cf/zai-org/glm-5.3` itself, Cloudflare's own address, a deployed Worker, and any other model of Workers AI, which nanocode-ts does not open that transport for, see [DECISIONS.md](DECISIONS.md#2026-11-15-a-codex-session-of-glm-53-asks-its-model-over-chat-completions) |
| Speculative branches (`:branches=N` on a `claude` or `codex` session): the slot forks after it comes up into N slots, each with its own session given the same instruction, each session then checks its own work, and only the slot of the branch whose self-check is best is verified | Implemented, tested: unit tests, a test that forks a directory slot, and the end-to-end lane `branches` on directory slots with the scripted model, which asks that the one branch whose check passed is kept, that its verifier passes and that the usage of the attempt is that of all 12 model calls of its 3 branches. **Not run**: krun and ns forks (the copy of `upper.ext4` is written but was not run on a KVM machine), and a real model, see [DECISIONS.md](DECISIONS.md#2026-11-14-speculative-branches-forked-from-one-slot) |
| Installed agents (`codex-cli`, `claude-code`): the vendor's command line inside the slot, its model requests through an endpoint of the run that adds the credential | Implemented, tested: unit tests for the agent syntax, the commands, the credential swap and the usage meter, and end-to-end lanes with a scripted command on directory and krun slots (tasks, failure kinds, a restarted and a lost runner), on ns slots in a guest (tasks), and on krun slots whose tasks close the agent's network. Codex CLI 0.166.0 ran 6 Terminal-Bench 2.1 tasks on krun slots through a ChatGPT plan login beside a nanocode session on the same model: 6 passed for each, and it passed two fixtures in an Alpine image. The Claude Code 2.1.318 binaries ran on krun slots in an Alpine and a Debian image against a scripted Messages endpoint. Through the gateway, from a deployed Worker, both commands ran on ns slots in a sandbox the run leased, where the runner fetched their releases: Codex CLI 0.166.0 and Claude Code 2.1.318 each passed `fix-git` on a small model, and again at high effort on a large one. Those are the first answers Claude Code had from a real Messages endpoint, see [Deploy it](#deploy-it). Claude Code has not run with an Anthropic API key or a plan login: no valid login was at hand. See [DESIGN.md](DESIGN.md#installed-agents) |
| Installed fx (`fx-chat`, `fx-messages`, `fx-responses`): the fx command line 0.0.17 inside the slot, named with the API its model is asked over | Implemented, tested: unit tests for the agent syntax, the settings and the command of each API, the output and its trajectory, and an end-to-end lane with a scripted command over chat completions and Messages on directory, krun and ns slots. The pinned binary itself ran in krun slots against a scripted endpoint behind a local Worker, over all three APIs, with the deployment's key on every request: 6 of 6 rows passed in a Debian image and in an Alpine image that has Bash. In plain Alpine its shell tool fails, since it starts Bash or zsh. On real models it passed 4 of 4 small Terminal-Bench 2.1 tasks with `claude-haiku-5-5` over Messages and 4 of 4 each with `@cf/zai-org/glm-5.3-flash` and DeepSeek V4.1 Flash over chat completions, see [the first rows](DECISIONS.md#2026-11-15-fx-opencode-and-pi-on-real-models-and-how-their-commits-landed). **Not run** against a ChatGPT plan, an OpenAI key or the Responses API of a provider, see [DESIGN.md](DESIGN.md#installed-agents) and [DECISIONS.md](DECISIONS.md#2026-11-15-fx-as-an-installed-agent-and-agents-that-name-their-api) |
| Installed opencode (`opencode-chat`, `opencode-messages`, `opencode-responses`): the opencode command line 1.19.5 inside the slot | Implemented, tested: unit tests for the configuration and the command of each API, the event stream and its trajectory, and an end-to-end lane with a scripted command on directory, krun and ns slots. The pinned glibc and musl builds ran in krun slots against a scripted endpoint over all three APIs, 6 of 6 rows passed, in a Debian image and in an Alpine image with `libstdc++` and `libgcc`, both with 2 GB. It needs about 550 MB for a small exchange: in a task of 256 MB the kernel killed it before its first request, and plain Alpine lacks the two libraries its musl build links. On real models it passed 4 of 4 small Terminal-Bench 2.1 tasks with `claude-haiku-5-5` over Messages and 4 of 4 each with `@cf/zai-org/glm-5.3-flash` and DeepSeek V4.1 Flash over chat completions, see [the first rows](DECISIONS.md#2026-11-15-fx-opencode-and-pi-on-real-models-and-how-their-commits-landed). **Not run** on a plan or the Responses API of a provider, see [DECISIONS.md](DECISIONS.md#2026-11-15-opencode-as-an-installed-agent) |
| Installed pi (`pi-chat`, `pi-messages`, `pi-responses`): the pi command line 1.5.2 inside the slot | Implemented, tested: unit tests for the models file and the command of each API, the event stream with an error it exits 0 on, and its trajectory, and an end-to-end lane with a scripted command on directory, krun and ns slots. The pinned build ran in krun slots against a scripted endpoint over all three APIs, 3 of 3 rows passed in a Debian image. Its release has no musl build, so in an Alpine image the row is an `agent` error that says so. On real models it passed 4 of 4 small Terminal-Bench 2.1 tasks with `claude-haiku-5-5` over Messages and 3 of 4 with `@cf/zai-org/glm-5.3-flash` and 1 of 4 with DeepSeek V4.1 Flash over chat completions, where the provider refused the requests of the other rows for its rate and pi gave up, see [the first rows](DECISIONS.md#2026-11-15-fx-opencode-and-pi-on-real-models-and-how-their-commits-landed). **Not run** on a plan or the Responses API of a provider, see [DECISIONS.md](DECISIONS.md#2026-11-15-pi-as-an-installed-agent-and-a-command-that-exits-0-on-an-error) |
| The harnesses across the task images of Terminal-Bench 2.1: Codex CLI, Claude Code, fx, opencode, pi and a nanocode session | Measured once, no code for it: against a scripted endpoint on krun slots, each of the six made its requests, ran a shell command in the slot and exited 0 in 89 of the 89 tasks. Every image has glibc and Bash and every slot 2 GB of memory or more, so none of the limits of fx, opencode and pi above is met in this eval, and no task is left out for a harness. At that command the harness itself holds from 5 MB (fx) to 614 MB (opencode, up to 30% of the memory of a 2 GB task). The 534 rows ran without the tasks' verifiers, 93 more on 16 of the tasks with them. **Not run** on ns or directory slots, on arm64, or past one tool call, see [DECISIONS.md](DECISIONS.md#2026-11-15-every-harness-runs-in-all-89-task-images-of-terminal-bench-21) |
| Installed nanocode (`nanocode-codex`, `nanocode-claude`): nanocode's own `nanocode exec` inside the slot, the runtime's binary, its model requests through the run | Implemented, tested: unit tests for the command and the output, and on ns slots in a gateway sandbox with `boundless/z-ai/glm-5.3-flash` at high effort through the gateway: `nanocode-codex` passed 8 of 9 attempts of 3 Terminal-Bench 2.1 tasks, `nanocode-claude` 6 of 6 with a build of nanocode 0.7.0 that gives `--harness claude` a Messages endpoint. The stock 0.7.0 release has none, see [DECISIONS.md](DECISIONS.md#2026-11-12-nanocodes-own-command-line-as-an-installed-agent-and-imports-without-kvm) |
| `nanoeval compare RUN...`: the agents of one or more runs in one table | Implemented, tested. A row that a rerun in the table retried counts once, as its retry, and a run named twice counts once: unit tested, and read on a run of 24 rows with its two reruns on directory slots, see [DECISIONS.md](DECISIONS.md#2026-11-14-compare-counts-a-row-once-when-a-rerun-retried-it). Two runs that hold the same rows of one agent are two rows of the table: unit tested |
| `nanoeval compare --baseline RUN... RUN...`: a run set against a baseline: the pass counts of every task that moved, pass@k over the tasks both sides rate, and a verdict that allows for noise | Implemented, unit tested against figures worked by hand, and read on directory slots with the scripted model: runs of 8 tasks and 3 attempts whose answers were planned, one against the other alone and with its two reruns, and two runs of one attempt. **Not run** with a real model, see [DECISIONS.md](DECISIONS.md#2026-11-14-a-comparison-says-what-the-numbers-support) |
| `--fail-on regression\|lost\|any-failure` on `run --wait`, `revision` and `compare`: an exit status that gates a script | Implemented, tested: a unit test of every status and its order, and each status read from a shell on directory slots with the scripted model, see [DECISIONS.md](DECISIONS.md#2026-11-14-an-exit-status-that-gates-a-script) |
| Tasks chosen by name, by pattern, from a file and as a named subset (`--only`, `--only-file`, `--subset` with `subsets.json`) | Implemented, tested: unit tests, and each form run on directory slots with the scripted model, with every refusal read from a shell. The `smoke` subset of `terminal-bench-2.1` names four tasks of that eval and was **not run** through `--subset`, see [DECISIONS.md](DECISIONS.md#2026-11-14-tasks-are-chosen-by-name-by-pattern-and-by-subset) |
| A baseline by rule (`--baseline latest`) and with its reruns (`--with-reruns`) | Implemented, tested: unit tests of what fits and of the search, and on directory slots with the scripted model the rule took the one run that fit among 16, with and without its two reruns, and refused where no run had the agent. **Not run** against a deployed Worker or in a lab, see [DECISIONS.md](DECISIONS.md#2026-11-14-a-baseline-is-found-by-rule) |
| `nanoeval revision`: a revision of nanocode and of nanocode-ts built and run on one machine with no release, see [Evaluating a nanocode commit](#evaluating-a-nanocode-commit) | Implemented, tested: unit tests for what is built from what is named, the name of a checkout with changes, a build tree moved between a branch, a commit and such a checkout, the lab's lock, the aliases of the Worker, the tasks to import and the credential check. Run for real on a Linux machine with KVM, krun slots: the commit of the pinned hand with nanocode-ts `2672c04` on its own nanocode, the nanocode and nanocode-ts masters of the day, and a checkout with an uncommitted change, each built by the command, then four Terminal-Bench 2.1 tasks with a scripted model that runs each task's solution through the hand, two attempts each, 8 of 8 passed on both revisions, and `gpt-6-luna` on two of the tasks, 2 of 2 on both. The plain lanes on krun and on directory slots passed on the builds of the masters. **Not run**: a package in an empty lab from start to end in one build, `--hand-profile dist`, `--nanocode-ts` as a checkout, ns and directory slots through the command, two labs at once, a `claude` agent with a model |
| `nanoeval revision` says what it is doing: one line a phase on standard error with the time since the command began (each step of the two builds, the Worker, the import, the runner) and the count of rows that ended while the run goes on, `--quiet` for neither | Implemented, tested: a unit test of the lines, of the counter on a terminal and in a file, and of `--quiet`, and the lane `node test/revision.ts` reads them from the command on directory slots with a scripted model, see [DECISIONS.md](DECISIONS.md#2026-11-14-nanoeval-revision-says-what-it-is-doing) |
| A lab that several commands use: evaluations take it in the order in which they were started, `--baseline previous` and `--baseline REV` name the run before and the latest run on a revision when the evaluation has the lab, and `revision --serve` answers reads beside the evaluations, from the Worker of the one that runs or from its own | Implemented, tested: unit tests for the queue with five holders and a holder that died, for the three rules of a baseline, and for the served lab against a stand-in Worker. The lane starts three evaluations behind each other, reads a run that is under way through the served lab, is refused a cancel there, and reads the lab again when no evaluation is left. **Not run**: a served lab on krun slots, an evaluation queued for hours, two served labs at once |
| A nanocode that a slot cannot start is refused when it is named, with the reason: a slot starts its hand with `--own-processes`, which nanocode knows from `5f8b457de` on | Implemented, tested: a unit test over a repository with a commit before the option, one with it and a checkout whose change adds it, and the lane is refused before anything is built. Such a hand, built before this check, was run once in a slot first: every row an error |
| A baseline of another version of an eval: `--baseline latest` takes a run of any version that holds the tasks of the run unchanged, by the digest of each task, and a comparison leaves out a task that is another task in the version of the baseline and names it | Implemented, tested: unit tests of the rule and of the comparison, and the lane changes one task of the lab's eval and adds one, then compares across the two versions both ways |
| `revision --sdk-fallback pinned`: a nanocode-ts that does not build on the nanocode it is given is built on the one it names itself, the failure is remembered, and the run names the pair it ran on; `nanoeval watch` records the builds of every evaluation and says when the two differ | Implemented, tested: the lane builds a package that fails on one nanocode and falls back, twice, the second time with nothing built, over two local repositories that stand in for nanocode and nanocode-ts; unit tests for what the watcher records and says. **Not run**: on nanocode and nanocode-ts themselves, where one pair that did not build was evaluated this way by a script outside this repository before the option existed |
| `revision --quick`: "did this change break anything" in one command, the subset `quick` of `terminal-bench-2.1` at three attempts against the latest quick run on the pinned builds, with its agents, exit status 3 on a regression | Implemented, tested: unit tests of what a lab remembers, and the lane runs it three times on directory slots with a scripted model: on the pinned builds, on a checkout with uncommitted changes whose hand is built (exit 0), and again with a model that fails every task (exit 3). **Not run** with a model, and the six tasks of `quick` were not run through `--subset`: their pass counts are those the watcher recorded, see [DECISIONS.md](DECISIONS.md#2026-11-14-revision---quick-did-this-change-break-anything) |
| Two task lists of `terminal-bench-2.1` in `subsets.json` for loops that set several arms against each other: `hourly`, 30 tasks, and `ten-minute`, 12 of them, chosen by a written rule from 914 recorded attempts | Chosen, **not run** with a model: no run was made through `--subset hourly`, and `--subset ten-minute` ran with the scripted model alone, six arms at 2 attempts on microVM slots, see [DECISIONS.md](DECISIONS.md#2026-11-15-the-loop-on-microvm-slots-on-the-tasks-of-ten-minute). In the records the oracle passed 90 of 90 attempts of the 30 tasks in each of two arms, the difference of two arms with no true difference has a standard error of 3.1 to 5.9 points at three attempts, and a slot model puts six arms at three attempts at 27 to 58 minutes on 36 slots, see [DECISIONS.md](DECISIONS.md#2026-11-15-two-task-lists-for-loops-that-compare-arms-chosen-from-recorded-attempts) |
| `nanoeval loop`: several arms on the same tasks in one run of a lab, set against a baseline, with a scorecard and a verdict, in one command, see [The loop](#the-loop) | Implemented, tested: unit tests of what it takes by itself, what it refuses, the baseline by its name and the scorecard with sums by hand, and an end-to-end lane on directory slots with a scripted model that runs it three times: two arms on three tasks as the first run of a lab (no baseline, no verdict), again with a model that fails against the run before (exit 3), and again with the model that solves against the first run by its name (exit 0). Run once with six scripted arms on 12 stand-in tasks at 2 attempts, 144 rows on 4 directory slots: 1 min 42 s to 1 min 57 s from the command to its exit, a seeded regression caught in all six arms. Run on microVM slots too, with the backend and the slot count taken from the machine: six scripted arms on the 12 tasks of `ten-minute` themselves at 2 attempts, 144 rows on 4 krun slots in 18 min 28 s from the command, and a seeded regression caught in all six arms with exit 3, see [DECISIONS.md](DECISIONS.md#2026-11-15-the-loop-on-microvm-slots-on-the-tasks-of-ten-minute). **Not run** with a model, on ns slots, or on the tasks of `hourly`, see [DECISIONS.md](DECISIONS.md#2026-11-15-the-loop-is-one-command) |
| What a run ran on: the nanocode-ts build of its Worker and the hand of each runner, in `status`, `compare`, the trajectory and the Harbor result, and `compare --baseline` | Implemented, tested: unit tests, every end-to-end lane asks that its run names the build of its Worker and one hand, and three runs on three builds of nanocode-ts in one state were compared under one of them, each baseline read under the build of the run set against it. A runner that starts from the runtime archive names the release its archive was built with, which the lanes on that archive ask |
| How the model of each agent was paid for and reached: the gateway key, a key of the provider, a plan login or the plan signed in on the Worker, the transport, the host and the effort its sessions reported, and its reasoning tokens beside its output tokens, in `status`, the results of a run, the exported job and `compare` | Implemented, tested: unit tests on the events of a session on a key, on a plan login and of Claude, every end-to-end lane asks that its run names who paid for each agent and what its sessions reported, and the lanes with a scripted Codex ask for the reasoning tokens its answers carried. A run made before this reads `not recorded`. **Not run** with a real model or on a deployed Worker: the two arms it was written for were read again from their stored events, see [DECISIONS.md](DECISIONS.md#2026-11-14-a-run-records-who-paid-for-its-models-how-they-were-reached-and-their-reasoning-tokens) |
| `compare --baseline`: an agent is set against the agent of the baseline that is the same harness and model at the same effort, whatever either was named; sides that differ in model, in a typed effort or in who paid are refused unless `--unlike` asks for the comparison, which then says how they differ, and a transport, a host or a reported effort that differs is said above a comparison that is made | Implemented, tested: unit tests, the two arms of one agent under two names read again from their stored results, and the lane of the signed-in plan, where the command line refuses to set a run the key paid for against one the plan paid for and compares them under `--unlike`. A side that records no route is compared with a warning, see [DECISIONS.md](DECISIONS.md#2026-11-14-agents-are-compared-by-what-they-are-and-sides-that-are-not-the-same-agent-are-refused) |
| `--baseline latest` takes a run only when its agents were paid for and reached as those of the run it is set against, under any name | Implemented, unit tested: the rule asks the Worker how it pays now (`GET /v1/routes`) before a run is made, and reads the route of the runs named by `compare`. **Not run** against a Worker with runs on two routes, see [DECISIONS.md](DECISIONS.md#2026-11-14-a-baseline-by-rule-was-paid-for-and-reached-as-the-run-it-is-set-against) |
| Local sandbox provider (`nanoeval sandboxd`) | Implemented, tested |
| Slot backend `krun`, one libkrun microVM per slot | Implemented, tested on a Linux machine with KVM: every end-to-end lane, 32 microVMs at once, and Terminal-Bench 2.1 with the tasks' own solutions, imported once and run by two runners: 82 of the 89 pass, and all 89 rows end as they did when slots pulled images. [DECISIONS.md](DECISIONS.md#2026-11-11-no-container-engine-at-import-or-at-run-time) has the table |
| Slot backend `ns`, one set of namespaces per slot over the same disk, for a machine with root and no KVM | Implemented, tested inside a microVM guest without KVM (the slot test and the scripted, oracle, failures, judge, network, restart and packing lanes) and in E2B sandboxes. It shares the machine's kernel: see [ns slots](#ns-slots) |
| A TCP segment from the uplink that the connection tracking of an ns machine calls invalid | Implemented, tested: the machine drops it instead of answering it with a reset in the slot's place (`meta l4proto tcp ct state invalid drop` in the `input` chain of the `nanoeval` table). On a machine whose passt sends a segment without flags after a handshake, the lane on what a private ns slot reaches failed 4 times of 4 before, the slot's HTTPS request timing out, and passed 3 times of 3 after. See [DECISIONS.md](DECISIONS.md#2026-11-14-an-invalid-segment-from-the-uplink-no-longer-resets-the-connection-of-an-ns-slot) |
| A runner that picks its backend (`--backend auto`, the default of a run) | Implemented, tested: `krun` where `/dev/kvm` opens, `ns` where the runner is root |
| Slot backend `dir` | Implemented, tested. For development and for lanes on a machine with neither KVM nor root |
| Released `nanocode hand` in a slot, including Alpine images | Implemented, tested. The pinned hand, `nanocode-cli-3f97ab0`, ran the 89 solutions of Terminal-Bench 2.1 through its Bash tool on ns slots beside `--oracle`: 80 passed against 84, and the four it does not pass run longer than that tool's ten minutes. `claude-haiku-5-5` passed 65 of the 89 tasks with the pins before, and on 21 of the tasks 19 with this hand and the harness build before this one, `build-81eada9`, 18 and 17 with the two sets before them, one attempt a row, on a 5-core machine without KVM. **Not run on these builds**: `codex` agents, `gpt-6-luna`, all 89 tasks with a model, a sandbox. See [DECISIONS.md](DECISIONS.md#2026-11-13-the-harness-moves-to-nanocode-ts-build-81eada9-and-the-hand-to-nanocode-cli-3f97ab0) |
| Real model run | Tested with `gpt-6-luna` on a ChatGPT plan login: 3 Terminal-Bench tasks of the imported eval, 2 passed and 1 ended as a `verifier` error that its rerun passed, and the end-to-end lane before the eval table. `claude-haiku-4-5` through the Anthropic API ran on the first version only. Through the gateway, from a deployed Worker: `gpt-6-luna` and `claude-haiku-5-5` each passed 4 of 4 Terminal-Bench 2.1 tasks, and `gpt-6.1-sol` and `claude-opus-5-5` one task at high effort, see [Deploy it](#deploy-it) |
| Oracle run (`nanoeval run --oracle`): each task's own solution instead of a model | Implemented, tested |
| Tasks whose own solution does not pass (`unsound.json`, `nanoeval oracle`): a list by dataset with the cause and the upstream report of each, a rate over the sound tasks beside the rate over all of them in `status`, `run --wait` and `compare`, and a check that fails when the solution of a sound task does not pass | Implemented, tested: unit tests, and an end-to-end lane on directory slots where the solution of a fixture fails, the check exits 4, and exits 0 once the fixture is listed. Terminal-Bench 2.1 lists seven of its 89 tasks: each was run with its own solution in its image under Docker, its cause read to the line, and the fix its report proposes run the same way. The check ran on an oracle run of all 89 tasks on krun slots: 82 of 82 sound tasks pass, exit 0. See [Unsound tasks](#unsound-tasks) |
| Dataset adapters (`nanoeval import`, `datasets`) | Implemented, tested: unit tests import from recorded fixtures with no network |
| `terminal-bench-2.1`, imported from the Harbor registry by digest | Verified: the 89 packages match the ones Harbor downloads byte for byte. Imported as an eval and run with the tasks' own solutions, see above |
| `deep-swe-1.1`, the Harbor registry package `datacurve/deep-swe-1-1` by digest | 113 tasks written with `--out` and checked against their digests. Not importable as an eval: task schema 1.3, a verifier in an environment of its own, collect hooks, `reward.json` and closed networks, see [DECISIONS.md](DECISIONS.md#what-deepswe-v11-needs) |
| `terminal-bench-2.0` | 89 tasks imported and checked against their digests with the first version. 2 imported as an eval and run with their own solutions on krun slots: both passed |
| `swe-bench-verified` | 500 instances written as task directories with the first version. 1 imported as an eval: its image became a disk of 1.1 GB packed and its gold patch passed on a krun slot. The other 499 have not been converted or run |
| `gpqa-diamond` | 198 tasks. 5 imported as an eval and run with their reference answers: all passed. 5 ran with `gpt-6-luna` on the first version only |
| `healthbench-professional` | 410 cases. 2 imported as an eval and run with their physician answers, judged by `gpt-6-luna`. 3 ran with `gpt-6-luna` on the first version only |
| A task graded on the agent's final message, and a judge answered by the orchestrator | Implemented, tested end to end on krun and dir slots with the scripted model and with the fixtures' own answers, and with a `gpt-6-luna` judge on two HealthBench cases of an imported eval |
| GraphWalks, MRCR, Arena-Hard, BrowseComp, GDPval, SWE-Atlas QnA, GeneBench Pro, ARC-AGI-3, Agents' Last Exam importers | Not ported. [Datasets](#datasets) says why |
| Harbor job export and ATIF-v1.7 trajectories | Implemented. Exported jobs load with the models of Harbor 0.25.0 (`scripts/harbor-check.py`). The shapes Harbor enforces are unit tested. The tokens and steps of a session come from the model calls its object keeps beside its log, see [DESIGN.md](DESIGN.md#harness-outside-the-sandbox): unit tested on the events of nanocode-ts `build-81eada9`, and every end-to-end lane with a session checks that an attempt whose model endpoint answered has its calls and tokens and one agent step for each call. A model call that a session reads back from its log when it goes on after its Worker was lost is counted once, the instruction it accepts again is one step, for a `codex` session as well, and a tool call it publishes again is one tool call. The model calls, tokens, tool calls and cost of a subagent are counted with the session that started it, and its steps are a trajectory of their own under the session's (`subagent_trajectories`), which the result of the call that started it names: unit tested on event streams recorded from sessions that started a subagent, with and without a kill of their Worker, and a lane on directory slots asks that the usage of such a session is what its model endpoint answered, see [DECISIONS.md](DECISIONS.md#2026-11-14-the-model-calls-of-a-subagent-are-counted-and-its-steps-are-a-trajectory-under-its-session). The cost of a turn that is run again is counted once, as the last cost that a run end of each request reported: unit tested, and computed on a recorded session whose turn ran five times, see [DECISIONS.md](DECISIONS.md#2026-11-14-what-a-second-reading-of-the-days-changes-found-and-its-fixes) |
| Failure kinds `verifier`, `agent_timeout`, `environment` | Implemented, tested |
| An agent timeout that kept its verifier reward, in an exported job: a scored trial with no `exception_info`, counted in no error figure, with the timeout under `agent_result.metadata.agent_timeout` | Implemented, tested: a unit test where the job counts what the summary counts, and the failures lane on directory slots, whose job has the 3 errors of `status` and whose slow agent is a trial with reward 0. The job loads with the models of Harbor 0.25.0, which read the timeout back. Harbor's own jobs count such a trial as an error, see [DECISIONS.md](DECISIONS.md#2026-11-14-an-agent-timeout-that-was-scored-is-no-error-in-an-exported-job) |
| One wording for an attempt that was scored after its agent timed out, `passed after the agent timeout`, in `status`, the line of a task, `compare` and the exported trial | Implemented, tested: unit tests of the summary, the short form, the table and the export, and the failures lane on directory slots, which asks that `status`, `status --tasks`, `compare` and the trial say it of its slow agent, and that the trial says what `status` says. An agent timeout without a reward is an error and reads as one. A row that passed after its timeout was run end to end on directory slots with the solution of the fixture turned around by hand, see [DECISIONS.md](DECISIONS.md#2026-11-14-the-export-changes-on-the-newer-base-read-with-harbors-models-and-two-lanes-that-failed-under-load) |
| A verifier that scores without the test report it names is an error, not a zero | Implemented, tested |
| A verifier that could not download or store what its test.sh installs is an `environment` error, retried once, and a package its archive withdrew a `verifier` error that says so | Implemented, unit tested, and replayed on the logs of 58 verifier errors of five Terminal-Bench 2.1 runs |
| Every file a verifier writes is kept, binary files included | Implemented, tested |
| The count of processes a task's memory limit killed (`oomKills`) | Implemented, tested on krun slots |
| Cached disks removed when no row needs them (`--disks remove`), and `nanoeval prune` | Implemented, tested, and run for real in leased sandboxes, where each disk went with its row. Below `--free-disk-mb` a runner removes, with either `--disks`, the disks of its run that none of its rows uses, then every cached disk and blob that no row it holds or will start needs, the least recently used first, until it has the floor again; a disk that a slot of any runner on the machine boots is kept. Unit tests and the disk lane, not met for real |
| The layer cache pruned by days since last use (`nanoeval prune layers`) | Implemented, tested: unit tests on temporary caches, and on a Linux machine with KVM: a removal during an image build was refused, the build succeeded, and the next removal took 10 of 44 blobs. Listed only, not removed, on the 16 GB cache of the Terminal-Bench 2.1 import |
| A registry that limits pulls (`429`) | Implemented: the conversion that asked fails at once with the registry, the request and the limit the registry names, and `import --pull-wait SEC` or `NANOEVAL_PULL_WAIT_SEC` waits that long first. Unit tests of the message and of the policy, and the launcher's tests on a Linux machine with KVM. **Not met**: no registry has answered it `429` since |
| Unreferenced blobs of a directory store pruned (`nanoeval prune store`) | Implemented, tested: unit tests on temporary stores, and on a Linux machine with KVM: a removal during an import was refused, the next removed 6 of 14 files, and an oracle run of the eval passed afterwards. Listed only on the store of the Terminal-Bench 2.1 import, where every blob is referenced. Blobs in R2 are not pruned, and eval versions are never removed |
| What uv downloads for a verifier, kept per task (`run --verifier-cache`, off by default) | Implemented for krun and ns slots, tested end to end with a fixture on both, and on krun slots on ten Terminal-Bench 2.1 tasks with their solutions: the same ten outcomes with and without it, and 60 s of verifier time against 103 to 120 s. Only an oracle's attempt fills it. apt and pip are not cached |
| A task that asks for more memory than its runner admits | Implemented, tested: it runs alone, with the memory its machine has free when it starts instead of the 80 % a runner admits to rows that share, and a row that did not pass after that limit killed a process is an `environment` error. Unit tests, and a lane on ns slots in a guest. Run for real with the earlier limit only: the eight tasks of Terminal-Bench 2.1 that ask for 8 GiB ran with 6,364 MB, and with models one row, `rstan-to-pystan` under Claude Code, had two processes killed at that limit. **Not run in a sandbox since** |
| The order rows are claimed in | Implemented, unit tested: longest timeouts first, every attempt of a longer task before any of a shorter one and attempt numbers in order among tasks with the same timeouts, and as many runners begin with a row that needs a whole machine as the share of the remaining work such rows are, so the others fill their slots at once. Simulated with the durations of two arms of Terminal-Bench 2.1, see [DECISIONS.md](DECISIONS.md#2026-11-12-what-the-three-arms-found-fixed). Run at that size once each way, an oracle arm of 89 tasks and three attempts on 28 krun slots of one machine, see [DECISIONS.md](DECISIONS.md#2026-11-15-every-attempt-of-a-longer-task-is-claimed-before-any-attempt-of-a-shorter-one). **Not run with a model at that size** |
| A runner that knows when its sandbox ends (`sandbox --sandbox-timeout-sec`, `runner --ends-in-sec`, and every sandbox a run opens or takes from the pool) | Implemented, tested: unit tests and a lane on directory slots. A runner takes a row only while the setup, agent and verifier timeouts of the row end before its sandbox does, stops claiming once no row that is left does, and the status and the timeline of the run say so. A row whose timeouts no sandbox of that length covers is taken in the first `--setup-sec` of a sandbox and ends as an error, without another claim, if the sandbox ends first. A row that no runner could take for `--setup-sec` ends as an error in a run that opens no sandbox itself. **Not run in a paid sandbox** |
| A model request whose payment is refused | Implemented, tested: unit tests on the gateway's own answers, and lanes with a scripted gateway for sessions and for installed agents. A refusal that passes (`delta-too-small`, `insufficient-balance`) is sent again up to `--step-retries` times. One that says the key or its wallet is spent (`payment_failed`) ends the row as a `budget` error and every row not yet started with it, unclaimed. The run ends the turn of that row itself when its wait for the payment is over, and the turn of a session whose requests were answered nothing but 401, 402, 403 or 404 for `--setup-sec`, so a session that asks again does not hold its slot to its agent timeout: unit tests, and the lane of the spent key on `build-b8158fd`, whose Claude session asks again. **Not met for real since** |
| Model spend by response, and what the key was charged | Implemented, tested in the gateway lanes: each response is recorded with its cost as it ends, so an attempt that errors or is cancelled keeps what it spent and `--model-budget-usd` sees it while rows run. A gateway run reads its key's usage at its start and its end and `status` prints what the key was charged, through its channel and outside it, beside what the run recorded. **Against the scripted gateway only**: the real key's usage was read once, by hand |
| A model budget that the rows which run cannot pass (`--model-budget-usd`) | Implemented, tested: every model request is admitted by its run before it is sent, none once the budget is spent and under it only while the requests in flight leave room, each taken to cost what the largest response of the run did. A row that is refused a request ends as a `budget` error. Unit tests with a simulation of 1 to 500 rows, and two lanes on directory slots with a scripted model whose responses name their cost: twelve rows at once and two at a time passed a budget of $0.12 by $0.006384 and $0.010344, less than the $0.012456 of one request, where the rule before spent $0.176832. Where responses name no cost, on a plan or a key of a provider, the tokens count when an attempt ends, as before. **Not run** with a real model, see [DECISIONS.md](DECISIONS.md#2026-11-14-the-model-budget-holds-against-the-rows-that-run-and-a-tool-the-provider-runs-has-a-price) |
| Web searches and other tools a model provider runs for a response | Implemented, tested: counted from the usage of each response and priced with what the endpoint paid, which the gateway reports and has in its cost, or else at the list price of the provider for a call, which is added to the spend, to the budget and to the cost of the attempt. A tool with neither is counted as unpriced, and `status` says how many. Unit tests, and a lane on directory slots where responses name no cost and the searches of three rows, $0.06 at list price, spend a budget of $0.05: 2 rows passed with their searches in their cost, and 4 ended as `budget` errors. **Against scripted responses only** |
| The spend of a run whose model endpoint reports no cost, a key of a provider or a plan login | An estimate that nanocode makes from the tokens of each turn that ended, at list prices: nothing says what was charged. `status` says so, and counts the attempts whose model calls have tokens and no cost: unit tested. A turn that was cancelled at the agent timeout left such an attempt until nanocode-ts `build-39696b0`, and a run of 24 rows then printed $0.0022 for $0.0024 by hand, see [DECISIONS.md](DECISIONS.md#2026-11-14-the-spend-of-a-run-says-what-it-leaves-out). Since that build the turn reports the cost of the calls it completed (the row above) |
| A list price for a model whose endpoint names no cost (`run --model-price MODEL=INPUT,CACHED,OUTPUT`) | Implemented, tested: a response that carries tokens and no cost is priced by its run when it ends, in USD for a million input, cached input and output tokens of the model of its agent or judge, so the spend holds it and `--model-budget-usd` bounds it request by request as it does a reported cost. The attempt, its request log, `status` and `arms` say that the cost is by list. No price is in this repository: a model without one stays an estimate, or `not known`. Unit tests, and a lane on directory slots where a scripted model names no cost: 13 responses at $0.004 passed a budget of $0.05 by $0.002, 2 rows passed, 1 was refused its next request and 3 never started. Run once on a real model: 2 rows of fx on an open model behind a chat completions route, whose 8 answered responses were priced at $0.0064, the amount the forwarder in front of the endpoint metered for them, see [DECISIONS.md](DECISIONS.md#2026-11-15-the-first-run-priced-by-list-on-a-real-model). **Not run** on krun or ns slots, see [DECISIONS.md](DECISIONS.md#2026-11-15-a-model-has-a-list-price-where-its-endpoint-names-no-cost-and-an-arm-is-one-line) |
| `arms`: one line for each arm of a run, a table of the arms of several runs, and the same as JSON | Implemented, unit tested with sums by hand, and read from the lane above: passes over rows, the pass rate of the scored attempts and the mean over tasks of each task's pass rate, the cost of a pass, tokens, the time from its first start to its last end, and errors by class, infrastructure apart from the agent or its model. It reads runs of a Worker, or files that hold the results of a run. The stored results of two runs of three installed agents on two open models, 24 rows, and of two oracle arms of 89 tasks and 3 attempts were read with it, see the same entry |
| A floor on free disk for claims (`--free-disk-mb`) | Implemented, tested. It is reactive: it does not reserve what running attempts write later |
| A runner's memory and its slots' limits | Implemented, tested: a runner admits 80 % of the lower of its machine's memory and the `memory.max` of its control group and the groups above it, such as a systemd unit's `MemoryMax=`. On a machine with a systemd user manager each microVM runs in a scope of its own, `nanoeval-slot-KEY.scope`, with `MemoryMax` of its guest memory and 256 MiB more and no swap, and every slot process has `oom_score_adj` 1000, so the kernel ends a slot and not the runner, and a kill there does not count against the runner's unit. Unit tests, and a krun lane run under a 2.5 GB scope on the 32-core machine |
| A runner's slot count when none is named | Implemented, tested: `run` on the local provider and `runner` name no count unless `--slots` does, and a runner then has one slot for each hardware thread it may use, the fewest of the threads that are online, the threads of its CPU affinity and the `cpu.max` of its control group and the groups above it. Rows are admitted by that count and by memory, as with a count that is named. Before, both took 4 on every machine. A run on `e2b` or `gateway` still takes 4 when it names none, since it sizes the life of such a sandbox before one exists. One slot a thread is where one sweep of oracle rows stopped gaining on a machine of 48 threads: 34.0 rows a minute at 14 slots on 28 threads, 43.3 at 28, 44.9 at 56, see [DECISIONS.md](DECISIONS.md#2026-11-15-a-runner-that-is-given-no-slot-count-takes-one-slot-for-each-hardware-thread-it-may-use). Unit tests of the arithmetic, and a lane on directory slots (`NANOEVAL_E2E_SCENARIO=threads`) that pins itself to two hardware threads: its runner, given no count, reports two and runs two of three rows at once. Admitting rows by the CPUs their tasks declare was built and is held back: a slot model has it later than the plain count on 20 threads or fewer. Run on krun slots: the oracle on four tasks of Terminal-Bench 2.1, three attempts, with a runner pinned to 4 of the 48 threads of a machine and no `--slots`: 4 slots, and the 36 s of `--slots 4`. **Not run**: a whole arm with no `--slots` |
| Orchestrator restart during a run | Tested: the Worker is killed with attempts in flight, restarts on the same state, and the run finishes. A turn that it was killed in goes on where it was, since nanocode-ts `build-7968b53`: four lanes on directory slots kill the Worker while a cell runs on the hand, while the model is asked, while a `wait` is out and, in a `codex` session on a model nanocode does not know, while one of the two cells of a reply still runs and the other has answered. They ask that every command ran once, that only the request without an answer was sent again, that no tool call has an unknown outcome and the model read the result of every cell that had answered, and that the usage, the tool calls and the trajectory are those of the responses the model endpoint answered. On `build-2672c04` the same turn started again from its instruction, and the first three lanes fail there. On `build-7968b53` and `build-f3aa94f` the cell that had answered came back with an unknown outcome and the fourth lane fails there: it passes since `build-8e141d5`, which the pinned `build-b8158fd` holds. Those builds also record a request for the hand before the row of the log that holds it, so a call that a kill cut before it left is dispatched when the turn goes on, and the restart lane asks that no attempt has a tool call with an unknown outcome. **Not run**: a deployed Worker, a real model, a Worker killed together with the hand, and in this repository a turn that spawned a subagent and a kill within milliseconds of a model answer, which nanocode-ts ran on its own harness for the commits these builds hold. **Known gap**: the call inside a cell that was in flight beside another has its result and not its call in the stored events, so that attempt shows 8 tool calls where 9 ran. See [DECISIONS.md](DECISIONS.md#2026-11-14-a-turn-goes-on-after-its-worker-was-killed-on-nanocode-ts-build-7968b53) and [the entry on the builds since](DECISIONS.md#2026-11-14-what-the-builds-since-build-f3aa94f-change-for-a-session-and-the-lanes-for-a-turn-that-goes-on) |
| E2B sandboxes paid by the operator (`nanoeval sandbox`) | Run for real: a sandbox opened with an MPP wallet CLI, a runner attached in it, 13 attempts of Terminal-Bench 2.1 tasks on ns slots, with the tasks' solutions and with `gpt-6-luna`. Then at the size of a benchmark: three model arms over all 89 tasks of Terminal-Bench 2.1 in 28 such sandboxes of an hour each. See [Run it on E2B](#run-it-on-e2b) |
| E2B sandboxes paid by the Worker (`--provider e2b`) | Implemented and tested against a local mock, with the bodies, the envd calls and the kill checked against the real service. A lifetime over the 3,600 s that E2B keeps a sandbox over MPP is refused before anything is paid, by the run, the provider and `scripts/e2b-quote.ts`. **The Worker has not paid for a sandbox**: no key was put in one |
| Sandboxes leased from the gateway (`--provider gateway`) | Implemented, tested end to end against a scripted gateway on directory, krun and ns slots: each request priced before it is paid, the lease renewed while rows run, while a runner is started, which the scripted gateway holds back for longer than a lease lasts, and while another sandbox is killed, the sandbox terminated at the end, and on ns slots the runner started from the runtime archive. Run for real: four runs started on a laptop each leased one `desktop` sandbox from the gateway, started the runner in it from the runtime archive, ran their rows on ns slots and terminated it, with no runner on a machine of the operator's. A run recorded $0.0445 for its sandbox, which agrees with what the key was charged. Then at the size of a benchmark: all 89 tasks of Terminal-Bench 2.1 with their solutions in four sandboxes of four ns slots, 79 passed in 2,016 s, and 84 with the five rows that two defects of ns slots had failed, rerun after their fix. **No renewal has been paid for real**: the gateway sold none on the day, so a lease is bought whole, and a sandbox that is sold no renewal is used to the end of its lease and then replaced, which a run of ten tasks with leases of 240 s did. See [Deploy it](#deploy-it) |
| The runner runtime (`--runtime`, `nanoeval runtime`): the runner as one archive that a sandbox without a checkout starts from | Implemented, tested: in a guest on Node 20.9, and on E2B's `desktop` template, which has no Node |
| A sandbox lifetime chosen by the run from the timeouts of its rows | Implemented, unit tested: the longest its rows can keep its slots busy, up to what the provider keeps a sandbox for, which is 3,600 s for E2B, paid directly or through the gateway. A sandbox whose end comes before the timeouts of the rows that are left takes no more of them, and the run opens another for those. Not exercised as a paid lifetime: the E2B sandboxes paid for had one named by hand, and the paid run on the gateway that named twelve hours lost a sandbox at its hour, see [DECISIONS.md](DECISIONS.md#2026-11-14-a-gateway-sandbox-lives-an-hour) |
| `storage_mb` | The size of a krun slot's copy-on-write disk |
| Images whose user is not root, and images without bash | Tested with a fixture: tests and solutions are put in place as root, and the agent and the verifier run as the image's user |
| Codex models (`provider: codex`) | Tested on a ChatGPT plan login (`nanoeval worker --codex-login`). With a key nanocode-ts takes Responses over HTTPS: tested against a scripted gateway, and run through the real one from a deployed Worker with `gpt-6-luna` and `gpt-6.1-sol`. Not run with an OpenAI API key |
| Claude plan login (`nanoeval worker --claude-login`) | Run once, on the first flow: `claude-haiku-4-5` on `uppercase-message` reached the model through the plan and ended `failed`. The hand's `Bash` tool needs bash, which that Alpine image lacks, see [DECISIONS.md](DECISIONS.md#2026-11-11-installed-agents-and-nanocode-beside-codex-cli). Not run on the eval table: the login had expired and its tool could not renew it without a browser |
| A plan login file that lasts: `nanoeval worker --codex-login` and `--claude-login` refresh the file as its tool does, and `nanoeval plan refresh` does it ahead of time | Implemented, tested against scripted token endpoints only: unit tests for both files (a token that ends later, one that ended, one the provider rejects, a refresh that is refused, a refresh token that rotates, three Workers and two commands at once, the tool writing meanwhile, the locks of both tools, a file that cannot be replaced whole), and two end-to-end lanes on directory slots where a scripted provider ends and rejects tokens under sessions and under installed agents, refuses a refresh and takes a new sign-in, and no file of the lane holds a token. Not run against `auth.openai.com` or `platform.claude.com`: no real login was refreshed by this code. A file that root refreshes stays with its owner, and new tokens whose write failed are kept and written with the next request of the command: unit tested for both files, the first as root only, see [DECISIONS.md](DECISIONS.md#2026-11-14-what-a-second-reading-of-the-days-changes-found-and-its-fixes) |
| A Claude plan signed in on the Worker (`nanoeval plans`, `run --payer plan`) | Implemented, tested against a scripted Claude only: unit tests of the sealed record, the sign-in, the refresh after a `401` and what a run refuses, and an end-to-end lane on directory slots under local workerd where the command line signs in, a run is paid by the plan with a token refreshed on the way, a run without the option leaves the plan alone, a plan whose refresh is refused ends its rows as `environment` errors, and no file of the lane holds a token or the secret. Not run against Claude: no sign-in, refresh or model request of a real plan was made, under local workerd or on a deployed Worker |
| Models through the gateway with one key (`TEMPO_KEY`), and a bearer token for an Anthropic endpoint (`ANTHROPIC_AUTH_TOKEN`) | Implemented, tested: unit tests, and end-to-end lanes where a scripted gateway serves a `codex` and a `claude` session, or a scripted Codex CLI and Claude Code, refuses anything but the key as a bearer token, and reports the cost of each response, which becomes the cost of the attempt. Run for real from a deployed Worker: `codex` and `claude` sessions, Codex CLI and Claude Code all answered and passed their rows, 14 attempts in three runs, and the $0.4556 of model spend that the runs recorded agrees with what the key's channel was charged, see [Deploy it](#deploy-it) |
| Services on one Linux machine (`scripts/install-linux.sh`) | Implemented, tested: installed under a second name on other ports with the store, cache, layers and state on chosen paths, ran an import and a run through the installed services, and removed again |
| Two local Workers started at the same moment (`nanoeval worker`, and every end-to-end lane) | Implemented, tested: each starts `wrangler dev` with `--inspector-port 0`, so its workerd takes an inspector port from the kernel. wrangler otherwise counts up from 9229, and of two that start together one ends with "Address already in use". Two oracle lanes on directory slots started together, ten times: 10 of 20 lanes failed that way before, none of 20 after. See [DECISIONS.md](DECISIONS.md#2026-11-14-two-local-workers-that-start-at-the-same-moment) |
| The workflow on GitHub (`.github/workflows/ci.yml`): six jobs, the runner prepared for KVM by `scripts/ci-machine.sh`, caches for the launcher's build and the image layers | **Never run on GitHub**: Actions is disabled for the repository. `actionlint` passes, and the `run` steps of the jobs were run on machines at hand, with and without KVM: [DECISIONS.md](DECISIONS.md#2026-11-14-the-workflow-made-ready-for-hosted-runners-with-kvm) says what the workflow needs of a runner, and [what was run for the changes of this day](DECISIONS.md#2026-11-14-what-was-run-for-the-changes-of-this-day-before-they-landed) which steps passed where |
| `nanoeval watch`: the branches of nanocode and nanocode-ts followed, the newest pair of revisions evaluated through `nanoeval revision` on a subset of an eval at K attempts against the last accepted baseline, a scoreboard, a ledger and a hook | Implemented, tested: unit tests for the rule, the plan, the search for the first losing commit and the scoreboard, and tests that run the command over two local repositories with a stand-in for `nanoeval revision`, with the watcher killed in an evaluation, a build that fails, rows that error, a credential that expired, the lab held by another evaluation, a hook that does not end and the daily cap. Run over `nanoeval revision` itself on a Linux machine, with krun slots and `codex:gpt-6-luna` on a ChatGPT plan, about 65 rows for $0.12: a baseline on the pins, two revisions of nanocode master built and evaluated on demand, the branches followed while commits arrived, the watcher stopped and killed in a run and started again, a build that does not compile, a login that expired, and a commit that breaks the shell of the hand, found as a regression, told to the hook and named as the first losing commit. [DECISIONS.md](DECISIONS.md#2026-11-14-nanoeval-watch-over-nanoeval-revision-itself-with-a-model) has each run. **Not run**: two agents in one evaluation, a `claude` agent, a ledger of months |
| A certificate bundle and variables for slots (`sandboxd --ca-bundle`, `--slot-env`) | Implemented, tested |
| A private network per slot (`--network private`, the default for `krun` and `ns` slots) | Implemented, tested on a Linux machine with KVM: a slot has its own loopback and ports, reaches the internet, and is reached neither by another slot nor by the host |
| The shared host network (`--network host`) | Implemented. Attempts that listen on a fixed port are not isolated from each other there |
| A hand of a private slot attached to a Worker over `wss://` | Run from private ns slots in an E2B sandbox, through a tunnel in front of a local Worker, and from private krun slots on a Linux machine to a deployed Worker |
| Listeners on the machine's loopback that private slots may reach (`sandboxd --slot-forward`), with the names the machine's `/etc/hosts` gives them | Implemented, tested with a registry proxy on a machine's loopback, also with the guest's resolver unreachable |
| A package that a distribution's mirror dropped, served to a verifier from the distribution's archive (`runner --package-archive`): the task and its tests are run as imported, the index stays the mirror's, and the row keeps the files that came from the archive as `verifier-archive.txt` | Implemented for krun and ns slots, off by default, for `deb.debian.org` and `security.debian.org`. Run on krun slots with the solutions of `qemu-alpine-ssh` and `qemu-startup`: 2 of 2 attempts were `verifier` errors without it, 0 of 6 with it (5 passed, 1 failed in its own test), three files from the archive in each. Not run on ns slots |
| Deployment to Cloudflare | Deployed and run: an import into R2, four Terminal-Bench 2.1 tasks with their solutions on a krun runner attached from a Linux machine, 4 of 4 passed, and the same four with their solutions, with models and with installed agents in sandboxes leased from the gateway, where nothing of the operator's ran. See [Deploy it](#deploy-it) |
| A task that closes the network of its agent, its verifier or both (`allow_internet = false`, Harbor's `network_mode`) | Implemented for krun slots on a private network, tested end to end: a closed phase reaches neither the internet, by name or by address, nor the machine, and the attempt completes. Refused on `dir` and `ns` slots, on `--network host`, and with `--backend auto`, whose runners may take ns: such a run names `--backend krun`. A network allowlist is refused. No dataset shipped here closes a phase yet |
| Tasks with a Compose file or MCP servers, separate verifier environments, `reward.json` | Refused, except `reward.json`, which is not read: a verifier that writes only it ends as a `verifier` error. Planned |
| Prompt-cache cohorts, duration-ordered dispatch, R2 artifacts, MPP sessions | Planned |

## Run it locally

Requirements: Linux and Node 24. For `krun` evals and slots, which a runner takes by itself on a machine with KVM: `/dev/kvm`, libkrunfw 5, `mke2fs`, passt, and a Rust toolchain through rustup or a built launcher, see [krun slots](#krun-slots). `nanoeval runtime` and ns slots link the launcher statically, which also takes `musl-tools`. [A bare machine](#a-bare-machine) lists every package and step from a fresh Ubuntu. No Docker or other container engine, on any machine. The first import or runner of a machine builds the launcher and `nanoeval-net` from `krun/` (about a minute) and later ones reuse them. `NANOEVAL_KRUN` names a directory with the built binaries instead.

Steps 1 and 2 are servers that stay in the foreground: give each a terminal of its own with the two tokens, or end its line with `&`. With no credential in its environment the Worker of step 2 runs `--oracle` only, and step 4 is refused with the variables that would serve its agent: [Quick start](#quick-start) has a scripted model that stands in for one.

```sh
npm ci
TOKEN=$(openssl rand -hex 32) SANDBOX_TOKEN=$(openssl rand -hex 32)

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

# 5. Run what did not pass again, as a run that points at those attempts. It is refused when every attempt passed.
node cli/nanoeval.ts run --rerun RUN --wait
```

`--out` writes the Harbor job directory. `nanoeval runs` lists the runs of the Worker with their ids, `nanoeval status`, `attempt`, `export` and `cancel` read a run later, and `attempt` lists the claims of a row. A rerun keeps the budgets, the limits and the sandbox settings of its run unless the command names others. `nanoeval run --task DIR` does steps 3 and 4 at once, into the eval named `local`. A machine without KVM that has root runs the same evals in [ns slots](#ns-slots): a runner picks them by itself, and `--backend ns` names them. It runs disks and imports none: a microVM writes the disk of an environment, of a task that names an image as of one with a Dockerfile, so the import of step 3 is refused there in one line that says so, and the eval is imported on a machine with KVM, into the store of the Worker. A machine with neither takes `--backend dir` in both steps, and so does an import on a machine without KVM: no isolation, for development. `nanoeval doctor` says which slots a machine can run and, for each thing the others lack, the one command that gives it.

**Reading the summary.** `status` and `run --wait` print one line for each agent: the attempts that passed over the ones that ended, the ones that errored, the mean reward of the attempts that have one, pass@k, and the tokens and the cost of its sessions. pass@k is the chance that k attempts of a task include one that passed, averaged over the tasks. It is estimated from the scored attempts of each task, the ones that passed or failed: with n of them, of which c passed, a task counts 1 − C(n−c, k)/C(n, k), so every attempt counts for every k, their order does not matter, and pass@1 is the mean pass rate of the tasks. An attempt that errored or was cancelled is no trial, a task with fewer than k scored attempts is left out of pass@k, and the line then says how many tasks that pass@k rates, as in `pass@2 61.1% of 6 tasks`. A run that was cancelled says so on its first line, with the number of rows it did not finish. The mean reward is over the attempts that were scored, and says how many when that is not all of them, `mean reward 0.412 of 17 scored`: an attempt that errored has no reward, here as in pass@k. `result.json` of an exported job keeps Harbor's `metrics.mean`, which is not this one: it counts a trial without a reward as 0, 0.292 for the same run of 24. Its `n_errored_trials`, `n_errors` and `exception_stats` are the attempts that errored, as in `status`: an agent timeout that kept its verifier reward is a scored trial with no `exception_info`, and `agent_result.metadata.agent_timeout` of its `result.json` says that the agent timed out. Where attempts were judged, the tokens and the cost of the judge are a line of their own, `judge: 4 attempts judged, ...`: they are in the spend of the run and in no agent's line, in `compare` they are the column `Judge cost`, and in `result.json` the entry `stats.judge` beside the totals of the agents. A run that has reruns names them. An attempt that was scored although its agent ran into its timeout reads `passed after the agent timeout (the agent did not finish within 1800 s)`, or `failed after` it, and it is no error: the line of its task says `1/1 (1 after the agent timeout)`, `compare` `passed after the agent timeout 30 min 0 s`, and its exported trial the words of `status` under `agent_result.metadata.agent_timeout`. On a terminal too short for one line an attempt, `status` prints one line a task, `suite/two haiku 1/2 +1 errored (agent)`, and `--rows` brings the attempts back; piped output always lists the attempts, and `--tasks` asks for the short form.

**Naming a run.** Wherever a command reads a run that exists, `status`, `timeline`, `attempt`, `export`, `cancel`, `compare`, `oracle`, `run --rerun` and `--baseline`, the run is named by its id, by the start of its id as `status` and `compare` print it (`774e5979`), or by the `--name` it was made with. A start or a name that fits two runs is refused with their ids. `revision --baseline` takes the first eight characters of an id or more, since any other word there names a revision of nanocode.

**Why a row did not pass.** `status RUN` ends with one line for each attempt, and an attempt that errored has the kind of failure and its message there. The rest is read with `attempt`, by the id that line begins with:

```sh
node cli/nanoeval.ts status RUN                                    # a00002 nanoeval/uppercase-message haiku #1 failed
node cli/nanoeval.ts attempt RUN a00002                            # its phase, claims, result, tokens and cost, and the files it has
node cli/nanoeval.ts attempt RUN a00002 verifier/test-stdout.txt   # what the verifier printed
node cli/nanoeval.ts attempt RUN a00002 agent/trajectory.json      # what the agent did, step by step
node cli/nanoeval.ts export RUN --out output/job                   # every attempt as a Harbor trial directory
```

What a run cost is the `spend` line of `status`, with one figure for each agent on its own line, and `usage.costUsd` of `attempt` for one row.

**A model whose endpoint names no cost.** An endpoint that reports tokens and no cost, such as an open model behind a chat completions route, leaves an installed agent's arm at `cost not known` and its budget with nothing to count. `run --model-price '@cf/zai-org/glm-5.3-flash=0.15,0.15,0.50'` gives the run the list price of that model, in USD for a million input tokens, cached input tokens and output tokens. The input tokens of a response hold its cached ones, which are priced apart, and tokens written to a cache are priced as input. Each response of an agent or a judge on that model that carries no cost is then priced when it ends, and from there it is a cost like one the endpoint reported: in the spend, against `--model-budget-usd` request by request, in `usage.costUsd` of its attempt with `usage.costBy` set to `list`, and in `agent/model-requests.jsonl`. `status` says `cost $0.0868 at list prices` and how many responses the run priced. A response that names its cost keeps it, a rerun keeps the prices of its run unless it names its own, and a model that is given no price is as before. For an installed agent that reports a cost of its own, the price of the run stands.

**A model whose endpoint answers so many requests a minute.** Some endpoints answer a fixed number of requests a minute for a model and `429` for the rest, for all callers together. A run that is told the number, `run --model-requests-per-min 20` for each model of the run or `--model-requests-per-min '@cf/zai-org/glm-5.3-flash=20'` for one, sends its requests for that model one interval apart, 3 s at 20 a minute, in the order they came: the requests of installed agents, of sessions and of the judge on it, the first ask and each ask again. A request the provider still limits, because other callers share the limit, is asked again after one interval. Rows on the model are claimed to match: the first runs alone until it has asked, and a runner is given another only while a request that came now would be held at most two intervals and the rows asking the model, at the requests a minute its rows have made between their holds so far, leave room under the pace. So an arm of rows that each ask 20 times a minute runs them one at a time and an arm of slow rows runs many, and neither spends agent time on refusals. Each held request counts in `model_waits` of its row with the seconds it was held. A model with no pace is as before, and a rerun keeps the paces of its run unless it names its own. A pace knows nothing of other callers of the same account: what they take, the provider still refuses.

**One line an arm.** `nanoeval arms RUN` prints one line for each agent of a run, for a report:

```
smoke fx (fx-chat 0.0.17, @cf/zai-org/glm-5.3-flash): passed 4/4 rows, pass micro 100.0% of 4 scored, pass macro 100.0% over 4 tasks, $0.0217 a pass ($0.0867 at list prices), input tokens 472,486 (364,288 cached), output tokens 31,753, wall time 7 min 13 s, errors: infrastructure 0, agent or model 0
```

Micro is the passes over the scored attempts, and macro the mean over the tasks of each task's pass rate, which is pass@1: an attempt that errored is a trial of neither, and the line counts it under its class instead. Infrastructure is `environment`, `internal`, `verifier` and `verifier_timeout`, with its share of the rows, and the agent or its model is `agent`, `agent_timeout` and `budget`; rows that were cancelled are counted apart. The cost of a pass is the whole cost of the arm over its passes, the rows that did not pass included. The wall time runs from the start of the arm's first attempt to the end of its last. Several runs, or `--with-reruns`, print one table with a row for each arm, where an attempt that a rerun of the table retried counts once, and `--json` prints the arms as JSON. `--results FILE` reads a run from a file that holds what the Worker answers for `/v1/runs/RUN/results`, with no Worker, and `--model-price` prices the attempts of such a run that have tokens and no cost, as the run would have.

**Exit status.** `run --wait` exits 0 when no attempt errored and 1 when one did, or was cancelled. Attempts that failed do not change it: a failed attempt is a score. Without `--wait` the command exits 0 once the run is created. `status`, `compare` and `export` exit 0 whatever the run holds. A command that is refused prints one line and exits 1. An unknown command is named in one line with the commands that exist and exits 2, `nanoeval help COMMAND` or `COMMAND --help` prints the usage of one command, and `nanoeval` alone of all of them.

**A gate for a script.** `--fail-on` makes the exit status of `run --wait`, `revision` and `compare` say more, and changes nothing where it is not given:

| Status | When |
| --- | --- |
| 0 | Nothing below |
| 1 | An attempt errored or was cancelled (`run --wait` and `revision`, with or without `--fail-on`), or the command was refused. A gate that cannot be judged is refused: no baseline, or no task that both sides scored |
| 2 | An unknown command |
| 3 | `--fail-on regression`: the verdict against the baseline is a regression. `--fail-on lost`: that, or a single task is lost |
| 4 | `--fail-on any-failure`: an attempt failed or errored. `nanoeval oracle`: the solution of a sound task did not pass |

3 goes before 4 and 4 before 1, and the option may be repeated or given as a list, `--fail-on regression,any-failure`. `run --wait --baseline RUN` prints the comparison of `compare --baseline` under the summary, so one command runs a selection and gates on it:

```sh
node cli/nanoeval.ts run --eval samples --only write-greeting --attempts 3 --agent haiku=claude:claude-haiku-4-5 \
  --baseline RUN --fail-on regression --wait
```

`regression` is wrong for an agent that did not change at most 1 time in 20, see [Reading a comparison](#evaluating-a-nanocode-commit). `lost` holds each task to that line by itself, so over many flaky tasks it fails more often.

**Choosing tasks.** `--only` names a task by its id, by its name as `status` prints it, or by a pattern with `*` and `?` that takes every task whose id or name it matches. `--only-file FILE` reads such names from a file, one a line, where `#` starts a comment. `--subset NAME` takes the tasks that `subsets.json` of this checkout lists under that name for the eval, so that a selection is written once, and `nanoeval eval NAME` prints the subsets of an eval beside its tasks:

```sh
node cli/nanoeval.ts run --eval terminal-bench-2.1 --subset smoke --attempts 3 --agent luna=codex:gpt-6-luna --wait
node cli/nanoeval.ts run --eval terminal-bench-2.1 --only 'git-*' --only terminal-bench/fix-git --only-file tasks.txt --oracle --wait
```

```json
{
  "terminal-bench-2.1": {
    "smoke": ["cancel-async-tasks", "fix-git", "git-leak-recovery", "openssl-selfsigned-cert"]
  }
}
```

The three options add up and `--limit` then takes the first N. A name or a pattern that finds no task, a name that two tasks share and a subset the file does not have are refused before a run exists. `--subsets FILE` or `NANOEVAL_SUBSETS` names another file. A rerun takes `--only` the same way.

`subsets.json` holds four lists of `terminal-bench-2.1`. `smoke` and `quick` are a few cheap tasks. `hourly`, 30 tasks, and `ten-minute`, 12 of them, are for a loop that sets several arms against each other: they leave out the tasks whose verdict is not the agent's, bound the time of a row, and keep the categories and the spread of difficulty of the benchmark. At three attempts `hourly` shows a difference of 6 to 12 points between two arms and nothing smaller, and a pass rate on it is not a pass rate on the 89 tasks, see [DECISIONS.md](DECISIONS.md#2026-11-15-two-task-lists-for-loops-that-compare-arms-chosen-from-recorded-attempts).

**A baseline by rule.** `--baseline latest` stands for the latest finished run of the same eval version that ran on the builds this checkout pins, was not cancelled, is not itself a rerun, and holds every task and every agent of the run it is set against, under any name, paid for and reached the same way: the run to make once on the pins and then leave alone. The command prints the run it took. Before a run is made the Worker says how it pays for each provider now, and a run that the gateway key paid for is no baseline of one a plan login will pay for; a run that records no payer is never taken once the Worker says its own, and is named by its id. `--with-reruns` adds to the baseline, and for `compare` to every run named, the reruns it has, so a baseline whose errored rows were retried counts as it stands after them. Together with a subset and a gate this is the whole loop in one command:

```sh
node cli/nanoeval.ts run --eval terminal-bench-2.1 --subset smoke --attempts 3 --agent luna=codex:gpt-6-luna \
  --baseline latest --with-reruns --fail-on regression --wait
```

When no run fits, the command is refused before a run is made and says what it read, as in `of the runs listed, 3 a rerun, 1 cancelled, 11 without these agents`. Runs made before the list of runs existed are not found by the rule and can be named by their id.

Blobs go to a directory by default, `~/.local/share/nanoeval/store` (`--store DIR` or `NANOEVAL_STORE`), which the runners of the same machine read. `--store r2` uploads them through the Worker into its `BLOBS` bucket instead, and runners then fetch them through their run. A runner keeps what it fetched, verified, in `~/.cache/nanoeval` (`--cache` or `NANOEVAL_CACHE`). An import keeps the image layers it read from registries in `oci` under that cache (`--layers` or `NANOEVAL_LAYERS`), so importing a dataset again downloads none of them. A registry that limits pulls fails the conversion that asked it, with what the registry said, and the layers read so far stay in the cache. `--pull-wait SEC` or `NANOEVAL_PULL_WAIT_SEC` waits that long for the registry first.

**More runners.** A run starts one runner in each sandbox it opens. Any machine that reaches the Worker can add one:

```sh
node cli/nanoeval.ts run --eval samples --oracle --sandboxes 0   # prints the run's id and waits for runners
node cli/nanoeval.ts runner --run RUN --slots 4 --cache /var/cache/nanoeval-a
node cli/nanoeval.ts runner --run RUN --slots 4 --cache /var/cache/nanoeval-b
```

Each claims rows up to its own slots and memory and leaves when the run is finished. A runner that is killed loses its rows after `--lease-sec` (60 s), and another claims them. A runner started again in the same `--home` goes on with the slots it had. After a restart of its machine it sets the home up again and has no slots left: the rows it held go back to the run.

Without `--slots`, and when the run names none either, a runner has one slot for each hardware thread it may use. Two such runners on one machine each take that count: name `--slots` for each as above, or pin each to its own threads, as `taskset` does.

So a runner that must survive the kernel's OOM killer runs under a supervisor that starts it again within the lease. `scripts/nanoeval-runner@.service` is a systemd user unit for one run: copy it to `~/.config/systemd/user/`, put `NANOEVAL_URL`, `NANOEVAL_TOKEN`, `NANOEVAL_CHECKOUT` and `NANOEVAL_RUNNER_ARGS` (such as `--backend krun --slots 4`) in `~/.config/nanoeval/runner.env`, and `systemctl --user start nanoeval-runner@RUN`. It starts the runner again 5 s after it dies by a signal or an error and not after it leaves a finished run, and `KillMode=process` with `OOMPolicy=continue` keeps the slots running while it does, so the new runner goes on with them. The same with a transient unit: `systemd-run --user --unit nanoeval-runner-RUN -p Restart=on-failure -p RestartSec=5 -p KillMode=process -p OOMPolicy=continue -p MemoryMax=34G node cli/nanoeval.ts runner --run RUN …`. A run that has had no runner for `--setup-sec` waits that long once more before its rows end as errors.

Every krun slot gets a network of its own (`--network private`): its own loopback and ports, the internet, and no way in from another slot or from the machine. A hand dials `ws://127.0.0.1`, which nanocode accepts only on loopback, so each slot relays that one address to the Worker. `--network host` puts the slots on the machine's network instead, where they share its ports.

Without an API key, a plan login works. `nanoeval worker --codex-login ~/.codex/auth.json` runs `codex` agents such as `--agent luna=codex:gpt-6-luna` on the ChatGPT plan signed in there, and `--claude-login ~/.claude/.credentials.json` does the same for `claude` agents. The login lasts as long as its refresh token. The Worker asks the command for the token of every model request, and the command reads the file each time and refreshes it the way its tool does: before a request when the token ends within five minutes, and once when the provider answers `401`, after which the request is sent once more. A Codex session on a plan holds a WebSocket through the relay, which passes no `401` on: its token is refreshed by its end alone. The new tokens go back into the same file, in the tool's format and under the tool's own locks, so Codex CLI and Claude Code go on with that file, and a token that they refreshed is the one nanoeval sends next. No token reaches a log, an error or a file of a run.

A login whose refresh is refused is signed out, and the command says so in one line: `the ChatGPT login of /home/you/.codex/auth.json is signed out: its refresh was refused with 401 (refresh_token_expired). Sign in again with codex login`. The rows that asked end as `environment` errors with that line, the run starts no further row, `nanoeval revision` ends with 1 and that line before it builds anything, and a new sign-in is used by the next request without a restart. A refresh that fails any other way, an endpoint that is down, leaves the file alone and the token in use, with a line.

**One sign-in, one file.** Both providers answer a refresh with a new refresh token and end the old one, so a copy of a login file is signed out by the first refresh of the other copy: name the file that the tool writes, never a copy of it. Claude Code holds a lock while it refreshes, and nanoeval takes the same lock. Codex CLI holds none while it asks, so two programs that both find the token within five minutes of its end in the same second can both send the refresh token, and one of them is refused. nanoeval reads the file again before it asks, writes only when the file still holds what it sent, and takes the tokens of the file when its own refresh was refused. A watcher that must never meet that second gets a sign-in of its own, a second session of the same plan that no other program refreshes: `CODEX_HOME=~/.config/nanoeval/codex codex login`, then `--codex-login ~/.config/nanoeval/codex/auth.json`.

`nanoeval plan refresh` makes the same refresh ahead of time, for a timer or for a deployed Worker, which holds a token and no file. It refreshes each login named with `--codex-login` and `--claude-login`, `~/.codex/auth.json` when none is, when its token ends within `--within-sec` (6 h), and ends with 1 and the line above when the login is signed out. With `--secret-command` it hands each value of the ChatGPT login that changed since its last push to a command, such as `wrangler secret put "$NANOEVAL_SECRET_NAME"`; `--relay-url-file` adds `CHATGPT_RELAY_URL`, so a relay behind a tunnel whose address changes when it restarts is pushed again too. Run it from a timer, every few minutes: it reads only the file until a refresh is due or a value changed. A pushed secret starts a new version of the Worker. A plan signed in on the Worker itself is refreshed by it and is chosen run by run, on a local Worker as on a deployed one: see [A Claude plan instead of a key](#a-claude-plan-instead-of-a-key).

An agent whose harness is `codex-cli` or `claude-code` runs that vendor's command line inside the slot instead of a nanocode session outside it, on the same credentials of the Worker, and `nanoeval compare` puts the agents of one or more runs in one table:

```sh
node cli/nanoeval.ts run --eval terminal-bench-2.1 --only fix-git --only regex-log \
  --agent nano=codex:gpt-6.1-sol:high --agent cli=codex-cli:gpt-6.1-sol:high --wait
node cli/nanoeval.ts compare RUN
```

Give `compare` a run together with its reruns to read where the run stands after them: an attempt that a rerun in the table retried is left out, so each row counts once, as its latest retry, and the line of its run says how many were left out. Outcomes, time, tokens and cost are those of the attempts that stand. Two runs that hold the same rows of one agent are two measurements and get a row each, named by its run; runs that hold different rows, such as an eval split over two runs, share one.

The first such run on a machine downloads the pinned release of the command into the cache and checks it against its SHA-256: an archive of 200 MB for Codex CLI, 517 MB unpacked, and 632 MB for the two builds of Claude Code. The task image is not changed, and the credential stays in the Worker: the command gets an address and a token that are good for that attempt only. Prompts and tools are each harness's own, see [DESIGN.md](DESIGN.md#installed-agents) for what such a comparison holds equal. A `codex-cli` agent has token counts and no cost estimate of its own, so `--model-budget-usd` bounds it only when the endpoint reports what it charged, as the gateway does.

`fx`, `opencode` and `pi` are installed the same way and speak three model APIs, so their harness names the one its model is asked over: `--agent fx=fx-messages:claude-haiku-5-5` (Anthropic Messages), `--agent fx=fx-responses:gpt-6-luna` (OpenAI Responses), `--agent fx=fx-chat:deepseek/deepseek-v4.1-flash` (chat completions). `-messages` takes the Worker's Claude credential and `-chat` and `-responses` its OpenAI one, each with the base URL beside it. That is how an OpenAI-compatible endpoint is named: `OPENAI_BASE_URL` is the address before `/v1/chat/completions`, such as `https://api.cloudflare.com/client/v4/accounts/ACCOUNT/ai` for Cloudflare AI Gateway, with its token in `OPENAI_API_KEY`, and the model is named as that endpoint names it. Such an agent reports no cost of its own, like `codex-cli`.

An agent whose harness is `codex` is a nanocode `codex` session whose model calls the hand's tools itself (`exec_command`, `apply_patch`, `write_stdin` and the rest), as Codex CLI does; `codex-direct` names the same agent. The turn asks nanocode-ts for it with `codex_orchestration: "direct"`, which the session keeps. An agent whose harness is `codex-code-mode` has its model call the tools from JavaScript cells through `exec` and `wait` instead, nanocode's Code Mode, which is what `codex` meant before 2026-11-15 (see [DECISIONS.md](DECISIONS.md#2026-11-15-a-codex-agent-calls-its-tools-directly-unless-it-asks-for-code-mode)). One run carries both arms and `nanoeval compare` shows them apart, the direct one as `codex-direct:MODEL` and the Code Mode one as `codex:MODEL`, as in the runs before the change. In a run configuration the direct one is `{ "provider": "codex", "orchestration": "direct" }` and the Code Mode one `{ "provider": "codex" }`, so a run made before the change, and its reruns, keep Code Mode:

```sh
node cli/nanoeval.ts run --eval terminal-bench-2.1 \
  --agent nanox=codex:gpt-6-luna:high --agent nanoxc=codex-code-mode:gpt-6-luna:high --wait
```

An agent whose harness is `codex-jobs` is a nanocode `codex` session in Code Mode whose cells also get nanocode's background job tools (`job_start`, `job_wait`, `job_kill`) on the hand: the turn sends `codex_orchestration: "jobs"`, which nanocode-ts from 1bb9797 maps to the job tools of a hand built from nanocode 16f93adbc or later; an older nanocode-ts answers 400. In a run configuration it is `{ "provider": "codex", "orchestration": "jobs" }`. **Not run** with a model.

An agent with `:branches=N` (N at least 2), such as `nanoxb3=codex:gpt-6-luna:high:branches=3`, runs N sessions per attempt. Its slot forks once it is up, before any hand attaches: `slot.sh fork` copies the slot's inputs and its writable disk (`upper.ext4`, sparse and with reflinks where the filesystem has them, after a `sync` in the guest; the workspace on directory slots) and boots the copy. Each branch gets the task's instruction unchanged; when its turn completes it is asked, in a second turn, to check its own work and end with `SELF-CHECK: PASS` or `FAIL`. The run keeps the branch whose turn completed with the best check (pass, then no verdict, then fail; the first of equals), downs the other slots and runs the verifier in the kept slot only. `agent/branches.json` records every branch's outcome and the choice, `agent/trajectory.json` is the kept branch's and `agent/branch-K/` holds the others. The usage and cost of the attempt are those of every session. A runner holds a branched row as N rows of memory and slots, and the Worker refuses a runner whose `slot.sh` cannot fork.

To check task environments and verifiers without a model, `nanoeval run --oracle --eval NAME --wait` runs each task's `solution/solve.sh` in the slot in place of the agent. A solution is a blob of its own, and only an oracle run is told its digest.

A long run on a machine with little disk takes two more options. `--disks remove`, the default with `--provider e2b` and `gateway`, makes a runner delete each packed disk once it is unpacked, and each disk it unpacked once no row of the run needs it, and never a disk its cache already had. `--free-disk-mb N` makes a runner claim only while its machine has N MB free, and below it the runner removes cached disks and blobs that no row it holds or will start needs, the least recently used first. `nanoeval prune` removes what earlier runs left in the cache: the disks that no microVM holds, the blobs and the verifier caches (`--dry-run` lists them).

Two more commands prune what imports leave, and both only list until `--remove` is given. `nanoeval prune layers --days N` lists the layers, configs and manifests of the layer cache that no import used for N days, with abandoned downloads, each with its size. `nanoeval prune store` asks the Worker for every version of every eval and lists the blobs of the directory store that none of them names, with the files an import that died left staged. A removal is refused while an import is converting from that cache or writing to that store, and `prune store --remove` is refused when the Worker names no blob of the store, unless `--allow-empty` says that emptying it is meant: a Worker started on the wrong state would otherwise take everything. Eval versions are never removed, and blobs in R2 are not pruned. [DESIGN.md](DESIGN.md#pruning) has the rules.

`--verifier-cache` makes the verifier of a task find what uv downloaded for it before: an oracle run with the option keeps it in the runner's cache, and later attempts of that task on the machine start their verifier with it. It is off by default, and [DESIGN.md](DESIGN.md#verifier-cache) says what it does and does not change.

## The loop

`nanoeval loop` sets several arms against each other and against a baseline in one command. It is `nanoeval revision` with what a loop does not have to choose taken from the machine and from a subset: one run of the lab holds every `--agent` on the same tasks and attempts, so the arms share its slots, and the command starts the Worker and a runner, imports what the lab lacks, waits, prints and stops what it started.

```sh
# Six arms on the 30 tasks of the subset hourly, 3 attempts each, a slot for each hardware thread, against the run before.
export ANTHROPIC_API_KEY=... OPENAI_API_KEY=...
node cli/nanoeval.ts loop \
  --agent haiku=claude:claude-haiku-5-5 --agent cc=claude-code:claude-haiku-5-5 --agent fx=fx-messages:claude-haiku-5-5 \
  --agent luna=codex:gpt-6-luna --agent cli=codex-cli:gpt-6-luna --agent oc=opencode-responses:gpt-6-luna

# A line to hold later loops against: name a loop once, then name it as the baseline.
node cli/nanoeval.ts loop --name main --agent haiku=claude:claude-haiku-5-5 --agent luna=codex:gpt-6-luna
node cli/nanoeval.ts loop --baseline main --agent haiku=claude:claude-haiku-5-5 --agent luna=codex:gpt-6-luna
```

**What it takes by itself**, and says in its first line. Each is replaced by naming the option:

| Option | Without it |
| --- | --- |
| `--eval`, `--subset` | `terminal-bench-2.1` and its subset `hourly`, unless `--task`, `--only`, `--only-file` or `--limit` name tasks |
| `--attempts` | 3 |
| `--slots` | One for each hardware thread the command may run on |
| `--backend` | `krun` where the machine has `/dev/kvm`, `ns` as root. A machine with neither is refused until `--backend dir` says that directories without isolation are meant |
| `--baseline` | The run before this one in the lab that holds these arms and tasks. The first such run of a lab has none: it says `baseline: none` and gets no verdict |
| `--fail-on` | `regression` |

The other options are those of `nanoeval revision` and of `run`: `--model-budget-usd`, `--model-price` for a model whose endpoint names no cost, `--lab`, `--name`, and `--nanocode` to run the arms on a revision that is built first. `--build-only`, `--rerun` and `--serve` are refused: a loop makes a new run and waits for it. `--baseline` names a run as `revision` does, and in a loop a word that is the `--name` of runs of the lab stands for the latest finished one of them.

**The scorecard** follows the summary and the comparison. Six scripted arms on 12 tasks at 2 attempts, set against a run in which the model solved more:

```
| Arm | Harness | Model | Passed | Pass micro | Pass macro | pass@2 | USD a pass | Cost | Input tokens (cached) | Output tokens | Wall time | Infrastructure errors | Agent or model errors | Cancelled | Against the baseline |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| arm1 | nanocode-ts build-8a77345, hand nanocode-cli-92f4e0d | claude-haiku-4-5 | 12/24 | 50.0% of 24 | 50.0% over 12 | 50.0% | $0.0001 | $0.0013 | 384 (0) | 192 | 1 min 39 s | 0 | 0 | 0 | regression, 6 down and 0 up of 12 |
| arm2 | nanocode-ts build-8a77345, hand nanocode-cli-92f4e0d | claude-haiku-4-5 | 8/24 | 33.3% of 24 | 33.3% over 12 | 33.3% | $0.0002 | $0.0013 | 384 (0) | 192 | 1 min 39 s | 0 | 0 | 0 | regression, 6 down and 0 up of 12 |
...
loop: 144 rows of 6 arms in 1 min 57 s from the start of the command, the run 1 min 42 s from its first start to its last end on 4 slots, infrastructure errors 0 or 0.0% of the rows, agent or model errors 0
verdict: regression against first (210fc3d5); regression: arm1, arm2, arm3, arm4, arm5, arm6
scorecard written to LAB/runs/RUN/scorecard.json
```

A row holds the passes of an arm over its rows, the pass rate of its scored attempts (micro), the mean over its tasks of each task's pass rate (macro, which is pass@1), pass@k for each further k, the cost of a pass and of the arm, its tokens, the time from its first start to its last end, its errors by class as `nanoeval arms` counts them, and its verdict against the baseline with the tasks that moved down and up. The line of the loop has the rows of all arms, the time from the start of the command, which holds the Worker's start and an import, the time of the run on its slots, and the infrastructure errors as a share of the rows. The verdict is a regression when any arm regressed, and an arm the baseline does not hold is named as such.

`scorecard.json` in the job directory of the run, `LAB/runs/RUN` or `--out`, holds the same: `arms`, each as `nanoeval arms --json` prints it with `passAtK`, `rated` and `against` (the verdict, the tasks compared, those that moved `down` and `up`, and the names `lost` and `gained`), `loop` (`rows`, `wallSec`, `runSec`, `slots`, `infrastructureErrors`, `infrastructureRate`, `agentErrors`, `cancelled`), `baseline` with the names and ids of its runs or `null`, `eval`, `name`, `run` and `verdict`.

The command exits 3 on a regression, 1 when a row errored and 0 otherwise. A verdict asks all tasks of an arm together, as [a gate for a script](#run-it-locally) says, and at 3 attempts on `hourly` it shows a difference of 6 to 12 points and nothing smaller, see [DECISIONS.md](DECISIONS.md#2026-11-15-two-task-lists-for-loops-that-compare-arms-chosen-from-recorded-attempts). Slots are shared by the arms and not divided among them, and nothing bounds the wall time of a loop but the timeouts of its tasks.

## Evaluating a nanocode commit

Every run above is on the two builds this checkout pins: the nanocode-ts release in `package.json`, which is the harness, and the hand release in `src/Slot.ts`. `nanoeval revision` runs any other revision of nanocode, and of nanocode-ts, on one Linux machine with KVM: no release, no change of the pins and no deployment. It builds what the revision needs, starts the Worker under local workerd on the built package, attaches a runner with the built hand, waits, and sets the run against a baseline.

```sh
# "Did my change break anything": once on the pinned builds, then on the checkout as it is.
export NANOEVAL_CODEX_LOGIN=$HOME/.codex/auth.json   # or OPENAI_API_KEY, or TEMPO_KEY
node cli/nanoeval.ts revision --quick --agent luna=codex:gpt-6-luna --model-budget-usd 1
node cli/nanoeval.ts revision --quick --nanocode .   # in a checkout of nanocode: exit 3 on a regression

# The baseline: nothing is built, the pinned hand and the pinned package. It prints the id of its run.
node cli/nanoeval.ts revision --eval terminal-bench-2.1 --only fix-git --only cancel-async-tasks \
  --agent luna=codex:gpt-6-luna --codex-login ~/.codex/auth.json --attempts 2 --model-budget-usd 1

# A commit, a branch or a tag of nanocode: its hand, and nanocode-ts master built against it.
node cli/nanoeval.ts revision --nanocode master --baseline RUN \
  --eval terminal-bench-2.1 --only fix-git --only cancel-async-tasks \
  --agent luna=codex:gpt-6-luna --codex-login ~/.codex/auth.json --attempts 2 --model-budget-usd 1

# "I changed nanocode here, did I break anything": the checkout as it is, uncommitted changes included.
node cli/nanoeval.ts revision --nanocode ~/src/nanocode --baseline RUN --eval terminal-bench-2.1 --limit 8 \
  --agent luna=codex:gpt-6-luna --codex-login ~/.codex/auth.json --model-budget-usd 1

# A change that only the hand runs, a tool or the shell: keep the pinned package and build the hand alone.
node cli/nanoeval.ts revision --nanocode ~/src/nanocode --nanocode-ts pinned --baseline RUN \
  --eval terminal-bench-2.1 --only fix-git --agent luna=codex:gpt-6-luna --codex-login ~/.codex/auth.json

# Before a merge, with no model: the end-to-end lanes of this repository on the two builds.
eval "$(node cli/nanoeval.ts revision --nanocode ~/src/nanocode --build-only)"
npm run e2e && NANOEVAL_E2E_BACKEND=dir npm run e2e

# Several in a row: they run in the order they were started, each against the one before, or against a revision.
node cli/nanoeval.ts revision --nanocode 0a9ed13f2337 --eval terminal-bench-2.1 --subset quick --attempts 3 \
  --agent luna=codex:gpt-6-luna --model-budget-usd 1 &
node cli/nanoeval.ts revision --nanocode f43ff49cee1d --baseline previous --eval terminal-bench-2.1 --subset quick \
  --attempts 3 --agent luna=codex:gpt-6-luna --model-budget-usd 1 &
node cli/nanoeval.ts revision --nanocode master --baseline 0a9ed13f2337 --eval terminal-bench-2.1 --subset quick \
  --attempts 3 --agent luna=codex:gpt-6-luna --model-budget-usd 1 &

# Read the runs of the lab, while evaluations run in it and afterwards, until the command is interrupted.
node cli/nanoeval.ts revision --serve --port 8787 &
export NANOEVAL_URL=http://127.0.0.1:8787 NANOEVAL_TOKEN=$(cat ~/.local/share/nanoeval/lab/token)
node cli/nanoeval.ts runs
node cli/nanoeval.ts compare --baseline RUN RUN RUN
```

**What is built.** `--nanocode` names a commit, a branch or a tag of the nanocode repository (`--nanocode-repository`, GitHub unless named), or a directory: a checkout, taken as it is, with its uncommitted changes and the untracked files that git does not ignore. The checkout is only read. The hand is built from it with `cargo build --locked --profile release -p nanocode-cli`. `--hand-profile dist` is the profile of a release and slower to build. `--nanocode-ts` names a revision or a checkout of nanocode-ts in the same way, `master` unless named, and the package is built against that nanocode as nanocode-ts builds itself: `scripts/build.mjs` for the four WebAssembly modules, then `npm run build:ts`, with `sdk-revision.json` naming the revision and the lock file of its Rust crates refreshed for it. `--sdk` names another nanocode for the package than the one of the hand, and `--sdk pinned` the one that the nanocode-ts revision names itself. `pinned` in place of a revision is what this checkout pins, and builds nothing. The shell and the Python of the package stay at the revisions that nanocode-ts pins for them.

The machine needs git, Rust through rustup with the `wasm32-unknown-unknown` target, Node 24 and npm, beside what [krun slots](#krun-slots) need. The host policy of a runner applies as it does to `nanoeval runner`: `--ca-bundle`, `--slot-env` and `--slot-forward`, or their variables. With `--ca-bundle` the Node of the package's build trusts the bundle too, since its last step installs two Python packages.

**The lab.** Everything is kept in one directory, `~/.local/share/nanoeval/lab` (`--lab`, `NANOEVAL_LAB`):

| In the lab | Holds |
| --- | --- |
| `source/` | One build tree of nanocode and one of nanocode-ts, moved to each revision in turn, so a later revision compiles only what changed |
| `hands/`, `packages/` | The builds, by revision: a revision is built once. A checkout with changes is named by its commit and a digest of the changes |
| `worker/` | The tables of the Worker: the evals and every run of the lab, whatever it ran on |
| `runner/`, `logs/` | The home of the runner, and the logs of each build, of the Worker and of the runner of each run |
| `runs/RUN/`, `runs.jsonl` | The Harbor job of each run, and one line a run with its id, its revisions and its counts |
| `token` | The access token of the lab's Worker |
| `queue/`, `lock` | One ticket for each evaluation that waits or runs, and the lock of the one that runs |
| `worker.wanted`, `worker.lock`, `worker.json` | The evaluation that needs the tables for its Worker, the lock of the Worker that has them, and its address, for a served lab |

The blob store, the cache and the layers are the machine's, as for `import` and `runner`. The tasks a run names are imported into the lab's eval the first time and found there afterwards, and `--limit` counts in the tasks the lab holds.

**The Worker under test** is `nanoeval worker --nanocode-ts DIR`: wrangler bundles the Worker with every entry of the `nanocode-ts` package aliased to the built one, whose dependencies were installed beside it from its own lock file. `package.json` and `node_modules` of this checkout are not touched. One state serves every build: a finished attempt is in the tables of its run, with its events, its trajectory and the files of its verifier, and no session of another build is read for it.

**One evaluation at a time, in the order they were started.** An evaluation holds the lab from its build to its summary. Each one takes a ticket in `queue/` when it starts, and waits for the tickets before its own, so three commands started one after another run in that order whatever the kernel does with the lock, and a command that was killed while it waited is passed over. Each evaluation starts its Worker on a free port and stops it and its runner at the end, so nothing is left running. Two evaluations at once take two labs, each with its own builds and its own runs.

**A baseline that does not exist yet.** `--baseline` takes the id of a run, and four names that are looked up when the evaluation has the lab, so an evaluation that waits can name the result of one that has not run:

| `--baseline` | Is |
| --- | --- |
| `RUN` | That run |
| `latest` | The latest finished run on the pinned builds that holds every task of this one, unchanged, with these agents |
| `previous` | The run before this one: the latest finished run of the eval, on any builds, that holds at least one of these tasks with these agents |
| `REV`, `DIR` or `pinned` | The latest such run whose hand is that revision of nanocode, named as `--nanocode` names it. A branch is read again, so name the commit when the branch may have moved |

A rerun and a cancelled run are never a baseline by name. The line `baseline: RUN, ...` on standard error says which run was taken and on what builds.

**What it prints while it works.** Standard error gets one line for each phase, with the time since the command began: the fetch of each revision, each step of the two builds with its log, the start of the Worker, the import, the start of the runner, and then the rows, a line each time their counts change, or one line rewritten in place on a terminal. `--quiet` leaves all of it out, and standard output is what it was: the line of the run, the summary, the comparison and where the job was written.

```
[0:00] hand: reading nanocode . from https://github.com/nanocodexyz/nanocode
[0:02] hand: building nanocode 0a9ed13f2337+98a0902f7eda with the release profile, log in LAB/logs/hand-0a9ed13f2337+98a0902f7eda-release.log
[2:47] hand: built in 165 s
[2:47] worker: starting under local workerd on the state in LAB/worker
[2:55] worker: http://127.0.0.1:41873, log in LAB/logs/worker.log
[2:56] runner: started on the rows of the run, log in LAB/logs/runner-RUN.log
[2:58] rows: 0 of 18 ended, 4 running, 14 waiting
[4:10] rows: 3 of 18 ended (3 passed, 0 failed, 0 errored), 4 running, 11 waiting
```

**Reading the lab while it works.** `revision --serve` answers `runs`, `status`, `compare`, `attempt` and `export` at one address for as long as it runs, and holds no evaluation up. A read goes to the Worker of the evaluation that runs at that moment. While none runs, or one is still building, the command keeps a Worker of its own on the pinned package and stops it when an evaluation needs the tables. A Worker that it could not finish starting, for whatever reason, is stopped and its lock given up before the reason is logged, so an evaluation never waits for a Worker that nobody serves. It forwards reads only: anything but `GET` and `HEAD` is answered 405, and the moment between two Workers 503, to be asked again.

**Did my change break anything.** `revision --quick` is the shortest form. On the pinned builds, with `--agent`, it makes the run that later ones are set against: the subset `quick` of `terminal-bench-2.1` in `subsets.json`, three attempts a task. With `--nanocode` it builds that revision or checkout, takes the agents, the judge, the model budget and the slots of the latest quick run on the pinned builds that the lab recorded, runs the same tasks three times, sets the run against that one and exits with 3 on a regression, as `--fail-on regression` does. `--eval`, `--subset`, `--only`, `--attempts`, `--agent`, `--baseline` and `--fail-on` each replace their part. A lab without such a run refuses a revision before it builds anything, with the command that makes one. The six tasks of `quick` are ones `gpt-6-luna` solved 10 to 12 times of 12 in the runs of the watcher, so three attempts that all fail are evidence: a task that passes half the time cannot be called at three attempts.

What the command itself takes was measured with a scripted model on directory slots, three sample tasks in place of the six, on a machine with 5 cores: 25 s for the quick run on the pinned builds, and 26 s from the command to its exit status for a checkout with changes, the build of a hand of ten lines included, 9 rows each. With a model it was not run. The watcher's cycle of the same day, ten tasks at three attempts of `gpt-6-luna` on krun slots, was 30 rows for $0.0688 at list prices, so the 18 rows of a quick run are about $0.04, after the build of the hand, which took 165 s for a checkout with one changed file in the table below.

**The model credential** is the one `nanoeval worker` takes: the variables of the command, or `--claude-login` and `--codex-login`, which `NANOEVAL_CLAUDE_LOGIN` and `NANOEVAL_CODEX_LOGIN` name for every command of a shell. An evaluation whose agents or judge no credential serves is refused before anything is built.

**What a run says it ran on.** A run records the nanocode-ts build of the Worker that created it, and each runner reports the hand it placed: the pinned release, the revision it was built from, or the SHA-256 of the file that `NANOEVAL_NANOCODE` names. `status` and `compare` print both, the trajectory and the Harbor result of an attempt carry them as the version of the agent, and `compare` keeps the runs of one agent on different revisions apart. `--baseline RUN` sets a run against another, agent by agent, here two attempts of `gpt-6-luna` on the commit of the pinned hand and on the master of that day:

```
luna: run RUN against the baseline BASELINE

|  | Baseline | Run |
| --- | --- | --- |
| nanocode | nanocode-ts 2672c043e379 on nanocode 439011f972c4, hand nanocode 3f97ab009aa6 | nanocode-ts 8ff3d5f8c98b on nanocode f43ff49cee1d, hand nanocode f43ff49cee1d |
| Tasks | 2 | 2 |
| Attempts | 2 | 2 |
| Passed | 2 | 2 |
| Failed | 0 | 0 |
| Errored | 0 | 0 |
| pass@1 | 100.0% | 100.0% |
| Input tokens (cached) | 127,095 (85,632) | 153,565 (106,496) |
| Output tokens | 1,983 | 2,049 |
| Cost | $0.0060 | $0.0068 |

lost: none
gained: none
moved, within noise: none
same on both sides: 2 tasks; solved on both sides: 2, on neither: 0
verdict: no change beyond noise: of the 2 tasks scored on both sides 0 moved down and 0 up (p = 1.000 for worse, p = 1.000 for better)
rule: lost, gained, regression and improvement are called when pass counts this far apart have a chance of 0.05 or less under no change (exact one-sided test, the verdict over all tasks together), so each is wrong for an unchanged agent at most 1 time in 20
with these attempts no single task can be called, its chance cannot fall under 0.500: one task that flips is not evidence
```

**Reading a comparison.** The score of a task on a side is its passed attempts over its scored ones, and an attempt that errored is beside it, never in it. A task is `lost` or `gained` only when the chance of pass counts that far apart, were the two sides one agent, is 0.05 or less (Fisher's exact test, one-sided): with three attempts a side that is 3/3 against 0/3 and nothing less, and with one or two attempts no single task can be called, which the last line then says. Every other task whose rate changed is `moved, within noise`, with its chance. A task whose attempts all errored on a side has no verdict there and is not compared. The `verdict` asks the same of all tasks together, with the exact test stratified by task, so five tasks that each flip once in the same direction are a regression where none of them alone is. An agent that did not change is called a regression at most 1 time in 20, and each task is held to the same line by itself, so among many flaky tasks a single `lost` can be chance: gate on the verdict. pass@k is printed for each side, and again over the tasks both sides rate wherever those differ. `--baseline` may be repeated to give a baseline with its reruns, and a run named with its reruns is one side. Here a run of 8 tasks and 3 attempts against another, with a scripted model whose answers were planned:

```
a: run RUN against the baseline BASELINE

|  | Baseline | Run |
| --- | --- | --- |
| nanocode | nanocode-ts build-7968b53, hand nanocode-cli-3f97ab0 | nanocode-ts build-7968b53, hand nanocode-cli-3f97ab0 |
| Tasks | 8 | 8 |
| Attempts | 24 | 24 |
| Passed | 7 | 10 |
| Failed | 10 | 11 |
| Errored | 7 | 3 |
| pass@1 | 41.7% of 6 tasks | 47.6% of 7 tasks |
| pass@2 | 61.1% of 6 tasks | 52.4% of 7 tasks |
| pass@3 | 60.0% of 5 tasks | 57.1% of 7 tasks |
| pass@1 on the 6 tasks both sides rate | 41.7% | 38.9% |
| pass@2 on the 6 tasks both sides rate | 61.1% | 44.4% |
| pass@3 on the 5 tasks both sides rate | 60.0% | 40.0% |
| Input tokens (cached) | 2,405 (1,480) | 2,925 (1,800) |
| Output tokens | 259 | 315 |
| Cost | $0.0022 | $0.0027 |

lost: t1 (3/3 to 0/3, p = 0.050)
gained: none
moved, within noise: t2 (2/3 to 1/3, p = 0.500), t4 (1/3 to 3/3, p = 0.200), t6 (1/2 +1 errored to 3/3, p = 0.400)
no verdict on a side, so not compared: err (3 errored to 3 errored), t5 (3 errored to 3/3)
same on both sides: 2 tasks; solved on both sides: 3, on neither: 2
verdict: no change beyond noise: of the 6 tasks scored on both sides 2 moved down and 2 up (p = 0.534 for worse, p = 0.768 for better)
rule: lost, gained, regression and improvement are called when pass counts this far apart have a chance of 0.05 or less under no change (exact one-sided test, the verdict over all tasks together), so each is wrong for an unchanged agent at most 1 time in 20
```

**Whether the two sides are the same agent.** A run records, for each agent, who paid for its model (the gateway key, a key of the provider, a plan login, or the plan signed in on the Worker), the transport, the host and the effort its sessions reported when their turns started, and the reasoning tokens its model calls reported. `status` prints them (`model route of luna: ...`, `output tokens 203,868 (57,591 reasoning)`), the exported job carries them, and `compare` has a column for each. An agent of a run is set against the agent of the baseline that is the same harness and model at the same effort, whatever either was named, and the comparison says so when the names differ. When the sides differ in model, in an effort that was typed or in who paid, the comparison is refused in one line after the table of arms, and `run --baseline` refuses before it makes the run where the Worker already pays another way than the baseline was paid: the same model reached through a plan login and through a key is not one agent. `--unlike` makes the comparison anyway and marks it. A transport, a host or an effort that only the sessions reported is what the harness under test says of itself: where only these differ, a line `DIFFERS: ...` says so above the table and the comparison is made, verdict and gate included, since a revision of the harness can change them and may be what the comparison was made to find. A run made before runs recorded this reads `not recorded` and is compared under a warning, and the two comparisons printed above were made then: today each also has the rows below. Two arms of 89 Terminal-Bench 2.1 tasks with one attempt each, read again from their stored results and events as a run of today would have recorded them, with `--unlike`:

```
luna: run RUN against the baseline BASELINE with RERUN
set against nano-codex of the baseline: the same harness and model under another name
UNLIKE: payer the gateway key in the baseline and a plan login through the relay in the run, transport responses_https_sse in the baseline and responses_websocket_v2 in the run, host api.openai.com in the baseline and chatgpt.com in the run: the sides are not the same agent, so the verdict below is not one about the harness

|  | Baseline | Run |
| --- | --- | --- |
| nanocode | not recorded | not recorded |
| Model route | the gateway key, responses_https_sse to api.openai.com, effort medium | a plan login through the relay, responses_websocket_v2 to chatgpt.com, effort medium |
| Tasks | 89 | 89 |
| Attempts | 89 | 89 |
| Passed | 49 | 33 |
| Failed | 33 | 50 |
| Errored | 7 | 6 |
| pass@1 | 59.8% of 82 tasks | 39.8% of 83 tasks |
| pass@1 on the 80 tasks both sides rate | 58.8% | 41.3% |
| Input tokens (cached) | 75,021,375 (70,944,302) | 21,310,012 (19,709,952) |
| Output tokens (reasoning) | 1,082,359 (649,437) | 203,868 (57,591) |
| Model calls of a scored attempt, median | 12.5 | 8 |
| Agent time of a scored attempt, median | 2 min 10 s | 56 s |
| Cost | $1.8587 | $0.4590 |
```

**What it takes**, measured on a machine with 32 cores whose load average was 66 to 100 from other work:

| | Seconds |
| --- | --- |
| The hand, in an empty lab | 239 |
| The package, in an empty lab | About 900: 856 to its last step, which that build did not pass, see [DECISIONS.md](DECISIONS.md#2026-11-14-a-revision-of-nanocode-runs-on-one-machine-with-no-release) |
| Seven commits of nanocode later in the same lab: hand, package | 101, 189 |
| An older nanocode and another nanocode-ts in the same lab: hand, package | 347, 355 |
| A checkout with one changed file, after the lab had built an older revision: hand, package | 165, 262 |
| A revision that was built before | Nothing is built: 8.4 from the command to the first claim |
| Four tasks, two attempts each, four krun slots, the scripted model: the whole command | 55, 64 and 98 |

**A baseline of another version of the eval.** The tasks a lab imports become versions of its eval, one more with each task that is new, so a baseline is often of an earlier version than the run. A comparison is over the tasks both sides hold unchanged, by the digest of each task in its version: a task that only one side ran is named as before, and a task that is another task in the version of the baseline, its instruction, its tests or its environment changed, is left out and named, `left out, the task is another in the eval version of the baseline: write-greeting`. `--baseline latest` finds a run of any version that holds the tasks of this run unchanged.

**What it does not do.** The runs are on this machine only: a revision is not run on a deployed Worker or in leased sandboxes. A nanocode from before `5f8b457de` is refused when it is named: a slot starts its hand with `--own-processes`, so that a command that exhausts the memory of the slot ends alone, and a hand that does not know the option ends at once, which made every row of such a revision an error after its build. A nanocode-ts revision that does not build against the nanocode it is given ends the command with the compiler's error: name a pair that fits, with `--nanocode-ts` or `--sdk`, or pass `--sdk-fallback pinned`, which builds the package on the nanocode that the nanocode-ts revision names itself when the build on the one it was given fails. The command says so each time, the run records the pair, `nanocode-ts A on nanocode B, hand nanocode C`, and the failure is remembered in the lab, so the next command for that pair builds nothing twice. Such a run tests the new hand with the brain of the older nanocode, not the new brain. The hand is built for this machine and placed in slots with the machine's loader and libraries, as `NANOEVAL_NANOCODE` always was, and not against the old glibc of a release, so a row measures the revision and not the release build of it.

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

Importing part of a dataset (`--only`, `--limit`) and importing more later each make a new version that holds the earlier tasks too. `--limit N` takes the first N tasks in the order of their ids, at import and in a run, so both name the same tasks. `--keep-going` leaves out a task whose environment does not convert and names it. `--jobs N` converts N tasks at once, and the rows of the version are in the same order as one at a time.

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
- **GPQA and HealthBench are closed-book, and their tasks do not say so yet.** A task that sets `allow_internet = false` or Harbor's `network_mode = "no-network"` runs on a krun slot without a network (`--backend krun`), but these two importers still write tasks that leave it open, so an agent could search.
- **SWE-bench needs the network in the verifier**, which installs `uv` and `swebench`, and each instance image becomes a disk of its own in the store. A machine whose network holds back fresh packages needs `sandboxd --slot-env` with `UV_EXCLUDE_NEWER`, and one whose registries sit behind a proxy on its loopback needs `--slot-forward`.
- **Instance images are named by tag**, as the official harness names them. Only the dataset is pinned by digest.
- **Seven tasks of Terminal-Bench 2.1 do not pass with their own solution**, see [Unsound tasks](#unsound-tasks): a summary rates an agent over the other 82 beside all 89.

### Unsound tasks

A task is sound when its own solution passes its own verifier. That stops being true while the task stays the same: a solution installs a dependency without a version, a verifier installs from an archive that is emptied, a service renames a field. `unsound.json` lists the tasks for which it was shown, by dataset, each by the checksum of its package, with what fails and the report upstream.

```sh
node cli/nanoeval.ts run --eval terminal-bench-2.1 --oracle --wait    # prints the id of the run
node cli/nanoeval.ts oracle RUN                # exits 4 when the solution of a sound task did not pass
node cli/nanoeval.ts run --rerun RUN --errored --wait   # a row that a download or the machine failed
node cli/nanoeval.ts oracle RUN --with-reruns
```

`status`, `run --wait` and `compare` print a second line for an agent whose run holds listed tasks, such as `haiku on its 82 sound tasks: passed 60/82, errored 1, pass@1 74.1% of 81 tasks`, and name the tasks set apart. Nothing else changes: the tasks are run and scored, and the rate over all of them is printed as before. An entry names one version of a task, so a version that upstream fixes counts as sound the day it is imported. `--unsound FILE`, or `NANOEVAL_UNSOUND`, reads another list.

| Task of Terminal-Bench 2.1 | What does not pass, on 2026-11-14 | Where the cause is | Report |
| --- | --- | --- | --- |
| `build-cython-ext` | 10 of 11 tests. The solution installs `planarity` without a version, 1.0.0 names the node attribute `vertex_position` where pyknotid 0.5.3 reads `pos`, and the repository test `test_reconstructed_space_curve` ends in `KeyError: 'pos'`. With `planarity==0.6` the solution passes | The solution | [terminal-bench-2-1#240](https://github.com/harbor-framework/terminal-bench-2-1/issues/240) |
| `crack-7z-hash` | On a slot that shows the task exactly the one CPU it grants, the solution runs out of its 1,800 s unless the core is fast: john, run with no mode, tries 9,782 single-mode candidates before the wordlist that holds the password, and with one core in sight it computes them one at a time. Where john sees several cores under the same CPU time, as under Docker, the solution passes: 1,107 s on 5 cores under a quota of one, and 897 s on a slot of four vCPUs held to the CPU time of one, which slots do not do yet | The solution, and how many cores a slot shows | [terminal-bench-2#28](https://github.com/harbor-framework/terminal-bench-2/pull/28) |
| `mcmc-sampling-stan` | 2 of 6 tests. The solution installs `rstan` 2.32.7 with `remotes::install_version`, which takes the newest release of every dependency, whatever the lines before it pinned. `RcppParallel` 6 needs cmake, which the image lacks, so `rstan` is never installed. With `RcppParallel` pinned, as the report proposes, `rstan` installs, `StanHeaders` goes from the pinned 2.32.10 to 2.39.1.1, and the solution's model is refused for its array syntax (3 of 6 tests). With `upgrade = 'never'` on its installs as well the solution passes | The solution | [terminal-bench-2#74](https://github.com/harbor-framework/terminal-bench-2/issues/74) |
| `protein-assembly` | The solution ends in DnaChisel's `NoSolutionError`. It reads the residues of a chromophore from a feature of type `modified_monomer`, which the RCSB data API names `non_standard_monomer` since September 2026. With both names accepted the solution passes | The solution | [terminal-bench-2-1#247](https://github.com/harbor-framework/terminal-bench-2-1/pull/247) |
| `qemu-alpine-ssh`, `qemu-startup` | No test runs: the verifier's `apt-get install curl` gets 404 for three packages of `bullseye-security`, whose files left deb.debian.org when the support of Debian 11 ended. The same index is served with its files by archive.debian.org | The environment | [terminal-bench-2-1#233](https://github.com/harbor-framework/terminal-bench-2-1/issues/233) |
| `torch-tensor-parallelism` | The verifier now and then hangs until its 900 s. It pins torch 2.7.0, where destroying a Gloo process group can deadlock on the interpreter lock, which 2.8.0 fixed | The verifier | [pytorch#154976](https://github.com/pytorch/pytorch/pull/154976) |

Upstream has changed none of the seven: the registry's latest version of the dataset is the pinned one, and the task directories of `harbor-framework/terminal-bench-2-1` at `12b7565` are the imported ones. [DECISIONS.md](DECISIONS.md#2026-11-14-tasks-whose-own-solution-does-not-pass-are-set-apart) has each reproduction.

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

Three options are for a machine whose network stands between its slots and the internet. `--ca-bundle FILE` makes slots trust that bundle when the network re-signs TLS. `--slot-env FILE` starts them with the variables of that file, such as a package index or `UV_EXCLUDE_NEWER` where the registry holds back fresh releases. `--slot-forward ADDRESS:PORT`, which may repeat, lets private slots reach a listener on the machine's loopback at that same address, for a machine whose resolver or `/etc/hosts` sends package registries to a proxy there: the lines of the machine's `/etc/hosts` for that address, and for its IPv4-mapped IPv6 form, are in the `/etc/hosts` of every krun and ns slot, so a slot finds the proxy whatever resolver it asks. An attached runner takes the same three, and so does `nanoeval import`, for the `RUN` steps of a task's Dockerfile.

`--package-archive` is for a verifier that installs a package its distribution has since moved off its mirrors, as the verifiers of `qemu-alpine-ssh` and `qemu-startup` do with `curl` on Debian 11. While the verifier of a krun or ns slot runs, `deb.debian.org` and `security.debian.org` resolve in the slot to a listener of the runner, which passes every request to the mirror it names and serves a file under `pool/` that the mirror answers 404 for from the same path of `archive.debian.org`. The index the verifier reads is the mirror's own and apt checks each package against it, so the verifier installs what it would have installed while the mirror had the file. The row keeps the files that came from the archive as the artifact `verifier-archive.txt`, and the runner logs their count. The option is off by default: the runner listens on port 80 of a loopback address for each verifier, so it runs as root or with `net.ipv4.ip_unprivileged_port_start` at 80 or lower.

### krun slots

`--backend krun` gives every slot its own microVM, and is what a runner takes by itself on a machine with KVM. The machine of a runner needs:

- Linux on x86_64 or aarch64 with `/dev/kvm` readable and writable by the user that runs the runner, usually through the `kvm` group.
- [libkrunfw](https://github.com/containers/libkrunfw) 5 where the dynamic loader finds `libkrunfw.so.5`.
- `mke2fs` from e2fsprogs.
- A Rust toolchain through rustup. `krun/rust-toolchain.toml` pins it, and the first cargo call there installs it. Outside `krun/` cargo answers only when rustup has a default toolchain (`rustup default`), and the tests ask `cargo --version` from the checkout: without a default they skip everything that needs the launcher. The first import or runner builds the launcher in `krun/` (about a minute) and later ones reuse it. `NANOEVAL_KRUN` names a directory with a built `nanoeval-krun`, `nanoeval-krun-guest` and `nanoeval-net` instead.
- [passt](https://passt.top) installed as a system package (`apt install passt`), for the private network of slots and of a Dockerfile's `RUN` steps. A copy in a user's directory cannot sandbox itself where unprivileged user namespaces are restricted. `--network host` does not need it.

The machine that imports needs the same things and nothing more: the launcher pulls images and builds Dockerfiles itself, see [DESIGN.md](DESIGN.md#image-disks). No Docker, containerd or podman is used or needed, and none is called if one is installed. A Dockerfile whose `RUN` steps install from a registry that the machine's network re-signs or keeps on its loopback builds when the import has the machine's policy, `--ca-bundle`, `--slot-env` and `--slot-forward`, which the installed command has from the installation. The disk keeps none of the three. Tasks that name an image need none.

Unpacked disks are kept in `~/.cache/nanoeval/disks` (`NANOEVAL_CACHE` moves the cache) until `--disks remove` or `nanoeval prune` removes them. With `--network host` a slot shares the host's sockets, with the limits listed in [DESIGN.md](DESIGN.md#krun-slots).

### ns slots

`--backend ns` boots the same disks without a microVM, for a machine that has root and no KVM, such as a remote sandbox. A runner picks it by itself there. The machine of a runner needs:

- Root, and a kernel with overlayfs, loop devices, namespaces and, for limits, cgroup v2 with the memory controller.
- `unshare`, `setpriv`, `mount`, `losetup` and `mountpoint` from util-linux, `chroot` and `env --default-signal` from coreutils 8.31 or later, `mke2fs` and `pgrep`.
- `ip` and `nft` for the private network, and a resolver that is not on the machine's loopback.
- The launcher, as for krun slots. It needs neither KVM nor libkrunfw here, and `nanoeval runtime` builds one that is linked statically, with the musl C compiler of the machine that builds it (`musl-tools`: `x86_64-linux-musl-gcc`).

`nanoeval doctor --backend ns`, as root, checks a machine for these. A shell that only starts a runner holds no model credential, which doctor counts as missing: name the Worker there, `--url` and `--token`, and it asks the Worker how it pays for models instead.

Each slot gets its own mount, PID, IPC, UTS, cgroup and network namespaces, the task's memory and CPUs as cgroup limits, a root that grows to `storage_mb`, and a capability set without mounts and device nodes. It shares the machine's kernel, so it keeps attempts apart as a container does and less strongly than a microVM. [DESIGN.md](DESIGN.md#ns-slots) says what a slot may and may not do.

Installed agents and `--verifier-cache` work in ns slots as in krun slots. A task that closes the network of a phase does not run there: only a microVM has the gate that closes it, so such a run is refused unless it names `--backend krun`.

### A bare machine

What a fresh Ubuntu 24.04 with `/dev/kvm` needs before `npm ci` and the commands above work with krun slots, in this order. Two bare 48-thread machines were brought up this way, in about a minute each before the first import. A machine that has no `git` takes `sudo apt-get install git` before the clone that these steps are read from:

1. Packages: `sudo apt-get install build-essential ca-certificates curl e2fsprogs git musl-tools passt pkg-config xz-utils`. `musl-tools` is for the static launcher of `nanoeval runtime` and of ns slots, and `passt` must be the system package.
2. KVM for the user that runs nanoeval: `sudo usermod -aG "$(stat -c %G /dev/kvm)" "$USER"`, then a new login. Not an ACL on `/dev/kvm`: udev writes the device's mode again when the first microVM starts, and the ACL is gone. On a machine that is thrown away after a job, `scripts/ci-machine.sh` opens KVM to every user with a udev rule instead, and installs the packages of step 1 that such a machine lacks and the libkrunfw of step 5.
3. Node 24 from nodejs.org, checked against its `SHASUMS256.txt`: `curl -fsSLO https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt && f=$(grep -o 'node-v24[0-9.]*-linux-x64.tar.xz' SHASUMS256.txt | head -1) && curl -fsSLO https://nodejs.org/dist/latest-v24.x/$f && grep " $f\$" SHASUMS256.txt | sha256sum -c - && sudo tar -xJf $f -C /usr/local --strip-components=1`.
4. rustup (`curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none`). `(cd krun && cargo --version)` then installs the toolchain that `krun/rust-toolchain.toml` pins, with its musl targets, and `(cd krun && rustup default "$(rustup show active-toolchain | cut -d' ' -f1)")` makes it the default, so that cargo also answers outside `krun/`.
5. libkrunfw 5: `libkrunfw-x86_64.tgz` of its [5.5.0 release](https://github.com/containers/libkrunfw/releases/tag/v5.5.0), SHA-256 `c169206b01c89fbe134f1728bf4f988702bc7f73b4cf73e6fdece447d6fceca1`, with `lib64/libkrunfw.so.5.5.0` installed in `/usr/local/lib`, a link `libkrunfw.so.5` beside it, and `sudo ldconfig`. `nanoeval doctor` prints these as one command when the library is missing.
6. `npm ci` in the checkout. The first import, runner or lane then builds the launcher, 42 s on 24 cores.
7. `node cli/nanoeval.ts doctor`: it checks KVM, libkrunfw, cargo and passt of the steps above, the pinned hand, memory, disk and the pulls Docker Hub has left for this address, prints the command of each thing that is missing, and ends with `ready for krun slots` once the shell also holds a model credential: with none it ends `1 missing for krun slots` on that line alone, and the two variables of the scripted model in [Quick start](#quick-start) are enough for it. A base URL for a model that the shell names (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`) is asked, and one where nothing answers is missing too. It does not look for the compiler, `musl-tools` or `curl` of step 1: a launcher that is not built yet is built by the first import or runner, which then says what it lacks.

An import of Terminal-Bench 2.1 on such a machine took 9 minutes, 18 GB of store and 16 GB of layers, and 89 of the 100 pulls an hour that Docker Hub gives an address without a login, see [Checks](#checks).

## Following nanocode

`nanoeval watch` runs an eval as nanocode changes. It follows one branch of nanocode and one of nanocode-ts, runs the newest pair of revisions through `nanoeval revision` on a subset of an eval, sets the result against the last accepted baseline, and says when a revision lost tasks. One file configures it:

```toml
state = "~/.local/state/nanoeval/watch"
poll_sec = 300

[nanocode]
repository = "https://github.com/nanocodexyz/nanocode"
branch = "master"

[nanocode_ts]
repository = "https://github.com/nanocodexyz/nanocode-ts"
branch = "master"

[eval]
name = "terminal-bench-2.1"
tasks = ["fix-git", "cancel-async-tasks", "openssl-selfsigned-cert", "git-leak-recovery"]
attempts = 2
agents = ["haiku=claude:claude-haiku-5-5", "luna=codex:gpt-6-luna"]
slots = 4
options = ["--codex-login", "~/.codex/auth.json"]

[budget]
run_usd = 1
daily_usd = 20
daily_runs = 40

[hook]
command = ["sh", "-c", "cat >> ~/nanoeval-regressions.jsonl"]
```

```sh
nanoeval watch --config watch.toml --dry-run   # fetch, and print what it would evaluate
nanoeval watch --config watch.toml --once      # evaluate what is new, then exit: for a timer
nanoeval watch --config watch.toml             # the same every poll_sec, as a service

# One pair now, beside the baseline: a checkout with uncommitted changes, or a commit.
nanoeval watch --config watch.toml --nanocode ~/src/nanocode
nanoeval watch --config watch.toml --nanocode 0a9ed13f2337 --nanocode-ts pinned --only fix-git --attempts 4

nanoeval watch --config watch.toml --board     # the scoreboard
nanoeval watch --config watch.toml --accept EVALUATION   # a revision that lost tasks becomes the baseline
nanoeval watch --config watch.toml --retry     # try again the revisions it gave up on
```

**A pair that does not build.** The two branches move apart: for a while nanocode-ts master may not compile on nanocode master. `options = ["--sdk-fallback", "pinned"]` in a `[revision]` table makes every call build the package on the nanocode that the nanocode-ts revision names itself when the build on the new nanocode fails, so the watcher goes on evaluating the new hand instead of recording `build failed` for every commit until the branches fit again. Each line of `watch.jsonl` names the builds its rows ran on, and the line for the journal says when the package was built on another nanocode than the hand: `nanocode-ts 177b460accae ran as built on nanocode 0762d8433e0b, with the hand of 54c9ead97ff5`.

`tasks = "all"` takes every task of the eval. `options` of `[eval]` go to every run, and `options` of a `[revision]` table to every call, builds included: the host policy of a machine, `--sdk`, `--hand-profile`. `[revision] lab` names the lab directory and `command` the command, which is this checkout's `nanoeval` otherwise. A side that holds still names a revision instead of a repository and a branch: `[nanocode_ts]` with `revision = "pinned"` and nothing else follows nanocode alone and builds no package. A value that begins with `~/` is taken from the home directory, and `state` and `lab` are resolved from the directory of the file.

**What it writes.** Everything is under `state`. `watch.jsonl` gets one line for each evaluation: the pair, the verdict, every attempt of every task as a letter (`p` passed, `f` failed, `e` errored), pass@1 and pass@k, tokens and cost for each agent, what was gained and lost with its p-value, and each call of `nanoeval revision` with its log, its job directory and what it was charged. `scoreboard.md` is written from it after every line: the baseline with the passes of each task, a regression that stands, and one row for each evaluation and agent. Standard output gets one line for each evaluation, for the journal:

```
nanocode f43ff49cee1d nanocode-ts 8ff3d5f8c98b: REGRESSION, lost luna/fix-git 4/4 -> 0/4 (p 0.014); haiku pass@1 100.0% pass@2 100.0%; luna pass@1 75.0% pass@2 75.0%; 2 runs, $0.0412
```

The command of `[hook]` is started for each evaluation that lost tasks and for the one that names the first losing commit, with that line of `watch.jsonl` and the path of the scoreboard as JSON on its standard input. `on = [...]` names the verdicts to hear instead of `regression`, such as `build_failed` or `incomplete`. A hook that has not ended after `timeout_sec` of `[hook]`, 60 unless set, is killed. The watcher itself talks to no service: it runs `git fetch` and `nanoeval revision`.

**When a task counts as lost.** Two attempts say little, so a task is never called lost on what one run shows. The baseline of a task is its scored attempts on the last accepted revisions, `baseline.window` of them. A task whose passes moved against that, and that K more attempts could bring to p <= `baseline.alpha` (0.05) in a one-sided Fisher exact test, gets one rerun of K more attempts, and is lost or gained when the test on all of its attempts gives that. Anything less is listed as within noise. The window is by default the fewest accepted revisions at which a task that always passed and now never does is found: 5 at one attempt, 2 at two, 1 at three or more, and the first baseline runs that many times K attempts, so the first comparison can already find one. With two attempts a task of an unchanged revision is called lost at most 4 times in 1,000, where "passed at least once of two, then failed twice and twice again" would call it up to 148 times in 1,000. A task that the baseline solved three times of four and that now never passes is found 32 times in 100 with the default window and 78 with `window = 5`: [DECISIONS.md](DECISIONS.md#2026-11-14-nanoeval-watch-the-evals-run-as-nanocode-changes) has the table. At three attempts the default window is 1, which finds a task that stopped passing and little else: a subset with tasks the agent solves only sometimes wants `[baseline]` with `window = 3` and `alpha = 0.02`, whose numbers are in [the entry on the runs over the command itself](DECISIONS.md#2026-11-14-nanoeval-watch-over-nanoeval-revision-itself-with-a-model). An errored attempt is no attempt: it is run again once, and a revision whose tasks still lack their attempts is `incomplete`, neither accepted nor a regression.

**What moves the baseline.** A revision that lost nothing is accepted: it becomes the baseline, and its attempts join the window. One that lost a task is not. The baseline stays, every later revision is set against it, and the scoreboard keeps the regression until a revision loses nothing or `--accept` takes the losing one, after which the lost tasks start a new history.

**Several commits.** The newest pair is evaluated first and stands for the commits behind it, whose number its line records. Only when it lost tasks are those commits looked at: the two branches are put in one line by the dates of their commits, and that line is bisected on the lost tasks and their agents alone, a revision whose build fails being passed over, until the first losing commit is named. `bisect = "off"` leaves that to `--bisect`.

**Budget.** Every run is given `run_usd` as its model budget. A run starts only while the runs of the day (UTC) are below `daily_runs` and what the day spent plus one more `run_usd` is within `daily_usd`. An evaluation that meets the cap waits where it is and goes on the next day. A run that left no job, or whose rows have no cost, counts as its whole `run_usd`.

**Failures.** A build that fails is recorded with the path of its log, tried once more the next time, and then left: the revision is evaluated again only by `--retry`, and the next commit is evaluated as usual. A run that ends without a job, one that was interrupted and one that stays incomplete are treated the same way. `[retries]` sets the three counts, `build`, `run` and `errored`, each 1 by default. A pass over the branches ends at the first evaluation that did not complete, so a credential that expired costs one failed run each time and not one for each commit.

**Killed at any moment.** The state is that directory and nothing else. An evaluation is written down before each of its calls. Started again, the watcher waits for a call that is still running, takes the job of one that ended without it, and records one that died as `interrupted`, charged its whole budget, before it runs the revision again. No line is written twice, and a revision is given up on only in a line that says so. Two watchers on one state take turns on a lock, and a watcher leaves the lab alone while another evaluation holds it.

**As a timer.** [`scripts/nanoeval-watch.service`](scripts/nanoeval-watch.service) and [`scripts/nanoeval-watch.timer`](scripts/nanoeval-watch.timer) are examples for systemd user units beside the services of [Keep it running on a Linux machine](#keep-it-running-on-a-linux-machine):

```sh
cp scripts/nanoeval-watch.service scripts/nanoeval-watch.timer ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now nanoeval-watch.timer
journalctl --user -u nanoeval-watch -f
```

The unit stops the watcher alone, which stops the evaluation it runs: its rows go back, its slots are taken down, and the next start records the evaluation as `interrupted` and runs it again. The service runs `~/.local/bin/nanoeval`, the command that `scripts/install-linux.sh` installs, on `~/.config/nanoeval/watch.toml`, and reads `~/.config/nanoeval/watch.env` when that file exists. A user unit does not read the profile of a shell, so that file is where a model credential that is a variable goes, and a `PATH` that holds `cargo` and `node` where they are not in the directories systemd searches, as in `PATH=/home/you/.cargo/bin:/usr/local/bin:/usr/bin:/bin`: the build of a hand ends with `cargo is not on the PATH of this command` without it. The timer starts the service two minutes after the machine boots and five minutes after each run of it ends, so `systemctl --user start nanoeval-watch` starts the first one now. The examples set no memory limit: a machine that shares its memory adds `MemoryMax=`, and one whose `nanoeval` is not at `~/.local/bin` its own `ExecStart=`.

**What it takes from `nanoeval revision`.** The watcher reads no text the command prints, and `Watch.invocation` in `src/Watch.ts` and `invoke` in `cli/Watch.ts` are the two places that know the command. The tests play it with a stand-in, `test/StubRevision.ts`. It relies on these, and each was run with the command itself, on a machine with krun slots and a model:

- `revision --nanocode REV --nanocode-ts REV [--nanocode-repository URL] [--nanocode-ts-repository URL] [--lab DIR] --build-only` builds or finds both, takes a full commit id, a directory or `pinned`, needs no eval, agent or credential, and exits with 0 only when both are built. A hand that does not compile ends it with 1, and the line of the watcher carries the last lines of the compiler.
- The same without `--build-only` and with `--eval`, `--only`, `--agent`, `--attempts`, `--model-budget-usd`, `--slots`, `--name` and `--out DIR` runs those rows and writes the Harbor job of the run to DIR, as `nanoeval run --wait --out` does. Where it writes the job under `LAB/runs` instead, the watcher takes the one directory that is new there, by the name of the run if several are.
- An evaluation holds `flock` on `LAB/lock`, and the lab is `--lab`, `NANOEVAL_LAB` or `~/.local/share/nanoeval/lab`.
- Stopped by SIGTERM, it gives its rows back, takes its slots down, stops its runner and its Worker and frees the lock. The unit file stops the watcher that way. A runner or a Worker that has not stopped `--stop-sec` seconds (30) after its SIGTERM is killed with its process group, and the command says so.
- The port of the Worker is one the kernel gave the command, and the command keeps it until the Worker has ended, so no other process is given it between the choice and the start.
- The Worker of an evaluation refreshes the plan login it runs on, so a login file lasts across evaluations. One that is signed out ends the command with 1 before anything is built, with a line that says so and how to sign in again: the watcher records `run failed` with that line and runs the revision again the next time. A login that is signed out during a run ends its rows as `environment` errors with the same line, which the watcher records as `incomplete`.

## Deploy it

The Worker runs on Cloudflare with its Durable Object classes and one R2 bucket, and takes its models and its sandboxes from the [Tempo gateway](https://gateway.tempo-dev.workers.dev/docs) with one key, so that a run needs no machine of yours once its eval is imported. The table below says how much of that has run.

```sh
npx wrangler r2 bucket create nanoeval-blobs
npx wrangler deploy --var COMMIT:$(git rev-parse HEAD)
TOKEN=$(openssl rand -hex 32)
printf %s "$TOKEN" | npx wrangler secret put ACCESS_TOKEN
npx wrangler secret put TEMPO_KEY          # an sk-tempo- key: models and sandboxes are paid from its budget
export NANOEVAL_URL=https://nanoeval.ACCOUNT.workers.dev NANOEVAL_TOKEN=$TOKEN

# On a Linux machine with KVM, once: environments become disks in R2, and the runner one archive there.
node cli/nanoeval.ts import terminal-bench-2.1 --only fix-git --only openssl-selfsigned-cert --store r2
node cli/nanoeval.ts runtime --publish --out output/runtime.tgz      # prints its SHA-256

# From anywhere: the run leases a sandbox from the gateway and ends it when its rows are done.
node cli/nanoeval.ts run --eval terminal-bench-2.1 \
  --agent luna=codex:gpt-6-luna --agent haiku=claude:claude-haiku-5-5 \
  --provider gateway --template desktop --runtime-blob SHA256 --slots 3 \
  --sandbox-budget-usd 1 --model-budget-usd 1 --wait

# The whole benchmark with the tasks' own solutions, in four sandboxes whose lease is bought whole.
node cli/nanoeval.ts run --eval terminal-bench-2.1 --oracle \
  --provider gateway --template desktop --runtime-blob SHA256 --backend ns \
  --sandboxes 4 --slots 4 --disks remove --free-disk-mb 4000 \
  --sandbox-lease-sec 3300 --sandbox-timeout-sec 3600 --sandbox-budget-usd 1.9 --poll-ms 1000 --wait

# Or with a machine of yours as the runner.
node cli/nanoeval.ts run --eval terminal-bench-2.1 --oracle --sandboxes 0   # prints RUN
node cli/nanoeval.ts runner --run RUN --slots 4
```

| Variable of the Worker | For |
| --- | --- |
| `ACCESS_TOKEN` | The bearer token of the API, which the CLI takes as `NANOEVAL_TOKEN` |
| `TEMPO_KEY` | The gateway: `codex` and `claude` agents, installed agents, judges, and the sandboxes of `--provider gateway`. `TEMPO_GATEWAY_URL` names another gateway |
| `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`, with `ANTHROPIC_BASE_URL` | A key of its own for `claude` agents instead. The first is sent as a bearer token, the second as `x-api-key` |
| `OPENAI_API_KEY`, with `OPENAI_BASE_URL` | The same for `codex` agents |
| `WORKERS_AI_ACCOUNT_ID` | The Cloudflare account of a `codex` agent whose model nanocode asks over chat completions on Workers AI, `--agent glm=codex:glm-5.3`. The session posts to `/client/v4/accounts/ID/ai/v1/chat/completions` of `OPENAI_BASE_URL`, or of `api.cloudflare.com` without one, with `OPENAI_API_KEY` as the bearer token. Without the variable such a row ends at once as an agent error |
| `PUBLIC_URL` | The address that runners and hands dial, when it is not the one the run was created through |
| `COMMIT` | The commit that was deployed, which `nanoeval version` prints. Set by `--var COMMIT:…` of the deploy |
| `TEMPO_PRIVATE_KEY` | A wallet key for `--provider e2b`, see [Run it on E2B](#run-it-on-e2b) |
| `PLAN_SECRET` | 32 characters or more that seal a Claude plan signed in with `nanoeval plans`, see [A Claude plan instead of a key](#a-claude-plan-instead-of-a-key) |
| `CLAUDE_PLAN_URL` | One address in place of the hosts of Claude for the token, profile and Messages requests of a signed-in plan and for the Messages requests of a Claude login file, for a Worker under local workerd whose network needs a forwarder. The end-to-end lanes point it at their scripted Claude |

**A runner machine that follows a deploy.** A runner and a Worker work together when they speak the same protocol, a number that a change raises when it has to (`Protocol.version`). `nanoeval version` prints the protocol and the commit of both and exits with status 1 when they differ, a runner of another protocol than its Worker does not start, and one that meets such a run leaves it. So a deploy goes in this order:

```sh
npx wrangler deploy --var COMMIT:$(git rev-parse HEAD)            # 1. the Worker, with its commit
node cli/nanoeval.ts pool                                         #    its first line names the commit the pool runs: go on when it is that one
node cli/nanoeval.ts runtime --publish --out output/runtime.tgz   # 2. the archive that sandboxes start their runner from, for --runtime-blob
# 3. on each runner machine, when its runner holds no row:
git pull --ff-only && npm ci && node cli/nanoeval.ts version      #    the checkout at the Worker's commit
# then start `nanoeval runner --standing` again
```

The Worker first, and its pool with it. `nanoeval version` is answered by the Worker itself and names the new commit as soon as it is deployed. The pool is an object, and an object runs the code it started on until Cloudflare restarts it. By default Cloudflare lets an object that is busy keep the code before a deploy for up to 300 s, and the requests that a standing runner holds keep the pool busy for all of them: a runner started in that time enrols in a pool of the commit before. `wrangler.jsonc` therefore asks for `"code_update_strategy": { "mode": "immediate" }`, which restarts every object of the Worker with the deploy. A restart ends the requests an object holds, and a runner asks again. So after a deploy, read the first line of `nanoeval pool`, or `commit` of `GET /v1/pool`: it is the commit of the code the pool object runs, and a runner of the new commit is started once it is the one that was deployed. A pool that says no commit runs the code of a commit before it said one, and one whose members have no `machine` in `GET /v1/pool` the code before a runner served several runs: both are the code before, for up to 300 s after a deploy that did not ask for `immediate`.

A standing runner that is stopped gives its rows back, which costs each of them one of its `--claims`, so `nanoeval pool` is worth a look first: a member "with a run" is busy. Until a machine has followed, its runner of the earlier protocol goes on serving one run at a time. When such a run lasts longer than the runner's lease the pool closes its member, and the runner exits when that run is done and has to be started again: follow soon. As a service the runner needs no more than a restart when it fails: it exits with status 0 only when it is stopped, enrols again by itself when the pool closed it or the Worker did not answer for a while, and exits with status 1 when its machine cannot bring a slot up or the protocols differ.

**What it costs.** Model requests are charged per token, and the cost of an attempt is what the gateway reported with its responses: nanoeval reads `usage.cost`, in USD, from the last usage of each response (`message_delta` or the body of a Messages response, `response.usage` of a Responses one) and records it when the response ends, so an attempt that errors keeps what it spent. A request whose payment the gateway refuses in passing is sent again. One it refuses because the key, its wallet or its channel is spent, such as "The channel still lacks deposit after a top-up", waits and is sent again, longer each time up to `--lease-sec`, and no row starts while it waits; the first request that is paid ends the wait, and one still refused after `--setup-sec` ends its row and the rows not yet started as `budget` errors. The run ends the turn of that row itself, since a session may ask again after a 402 and would hold its slot until its agent timeout: the same holds for a session that is answered nothing but 401, 402, 403 or 404 from one request to another `--setup-sec` later, which ends as an `agent` error. `--key-deposit` and `--key-top-up` set the key's deposit and automatic top-up (`PATCH /api/keys/me`) when the run is created: a model request holds what it may cost, so the channel needs room for one hold of every request in flight at once. What a response does not report is in no spend of the run: on 2026-11-12 a key paid $2.14 in charges that no response named, beside $6.83 through its channel. So a run reads the key's usage (`GET /api/keys/me`) when it starts and when it ends, and `status` prints what the key was charged in between, through its channel and outside it, beside what the run recorded. Another run on the same key in those minutes is in that figure too. The gateway leases an E2B sandbox by the second at E2B's price, and runs commands in it as root. A run pays `--sandbox-lease-sec` (300) when it opens one, as much again whenever less than `--lease-sec` (60) of the lease is left while rows need the sandbox, and terminates it when they are done. E2B bills a renewal from the moment it is made, so each one pays the seconds that were left a second time: a longer lease loses less to renewals and more at the end. **On 2026-11-12 the gateway sold no renewal of an E2B sandbox**, so buy the lease whole: `--sandbox-lease-sec` for as long as the run needs its sandboxes, up to `--sandbox-timeout-sec`. Nothing is refunded for the part a run does not use, a sandbox that is refused its renewal takes no more rows and is used to the end of its lease, and rows still in flight then start again in a new sandbox. A `desktop` sandbox cost $0.46408 for 3,300 s, which is $0.506 an hour. Every request to the gateway's compute API is first sent without the key and answered with its price, which is checked against `--sandbox-budget-usd` and listed under `payments` in the run's status before the request goes again with the key. What the gateway then refuses is written back, so the spend counts what it answered. A `desktop` sandbox was quoted $0.04228 for 300 s, and a run that ended inside one lease recorded $0.0445 for its sandbox: the lease and the fees of its calls.

| | State |
| --- | --- |
| The Worker on Cloudflare, evals and runs in Durable Objects, blobs in R2 | Run for real |
| A krun runner on a Linux machine attached to it, hands dialing `wss://` from private slots | Run for real: four Terminal-Bench 2.1 tasks with their solutions, 4 passed, the first row claimed 1.2 s after the run was created |
| A sandbox leased from the gateway, and no runner of the operator's | Run for real, four runs started from a laptop with `--provider gateway --template desktop --runtime-blob SHA256 --backend ns`: each leased one sandbox, the runner started in it from the archive, and the first attempt started 8.5 to 17 s after the run was created. Each sandbox was terminated when its rows were done, and the key listed none afterwards |
| The solutions of four Terminal-Bench 2.1 tasks in such a sandbox | 4 of 4 passed, in 56 s for the command |
| `codex:gpt-6-luna` and `claude:claude-haiku-5-5` on the four tasks, 3 slots | 8 of 8 passed in 2 min 55 s, for $0.0507 and $0.0103 of model spend |
| `codex-cli:gpt-6-luna` and `claude-code:claude-haiku-5-5` on `fix-git` | 2 of 2 passed: Codex CLI 0.166.0 in 48 s for $0.0052 and Claude Code 2.1.318 in 25 s for $0.0051, their releases fetched in the sandbox |
| `gpt-6.1-sol` and `claude-opus-5-5` at high effort on `fix-git`, each as a session and as its vendor's command | 4 of 4 passed, one attempt each, for $0.3843 in all: a smoke test, not a benchmark |
| A Claude plan signed in on the Worker, and a run it pays for | Not run for real. Tested against a scripted Claude under local workerd |
| A lease renewed | Not run for real: the gateway answered every renewal `502` before a price. Tested against the scripted gateway |
| A run longer than one lease | Run for real: ten tasks in two sandboxes with leases of 240 s. A sandbox that was refused its renewal kept its row to the end of the lease, the row was claimed again in a third sandbox 12 s later, and the run ended with 9 passed, 1 failed and 1 lost claim for $0.1081 |
| All 89 tasks of Terminal-Bench 2.1 with their solutions, four sandboxes of four slots, leases of 3,300 s | Run for real: 79 passed, 8 failed and 2 errored in 2,016 s for $1.8651, with no claim lost. Five of the failures were two defects of ns slots in a sandbox, fixed since: rerun, the five passed, which makes 84, 3 and 2, against 82, 4 and 3 on krun slots. [DECISIONS.md](DECISIONS.md#2026-11-12-the-whole-of-terminal-bench-21-on-leased-sandboxes) explains every row |
| All 89 tasks with a model, one attempt each, in three runs: `claude:claude-haiku-5-5`, `claude-code:claude-haiku-5-5` and `codex:gpt-6-luna`, in `desktop` sandboxes that the operator opened at E2B for an hour each, four ns slots in each | Run for real: 61, 64 and 49 passed, the last with a rerun of the 23 rows that were refused payment when the key ran out. 84 of the 89 pass with their solutions. [DECISIONS.md](DECISIONS.md#2026-11-12-three-model-arms-over-the-whole-of-terminal-bench-21) has every row that ended without a verdict |

The key's usage was read before and after those four runs. Its payment channel had spent $0.465518, against $0.4556 of model spend and about $0.0021 of compute fees a run that the runs recorded, and the rest, about $0.0015, is a handful of list and status calls made by hand. Each lease took $0.04238 from the key's limit, outside the channel. So what a run records as spent matched what the key was charged. At the size of a benchmark it did not: over the three model arms the runs recorded $6.30, the channel had spent $6.83, and the wallet had paid another $2.14 in charges outside the channel that no response reported and no budget of a run saw, see [DECISIONS.md](DECISIONS.md#2026-11-12-three-model-arms-over-the-whole-of-terminal-bench-21). [DECISIONS.md](DECISIONS.md#2026-11-12-the-gateway-for-real-models-installed-agents-and-a-leased-sandbox) has every run.

The gateway pays the network fee of opening a key's payment channel. When it cannot, the key pays it, and a key whose wallet holds only the machine token is refused with `503` until the wallet holds a little of a fee token: the gateway's message says which. A run meets that as `environment` errors, and the sandboxes it was refused are written back.

### A Claude plan instead of a key

A Worker can pay for `claude` sessions with a Claude subscription that its operator signs in once, in place of an API key or the gateway. Whether a subscription may be used this way is governed by the terms of its provider, and is the operator's call.

```sh
printf %s "$(openssl rand -hex 32)" | npx wrangler secret put PLAN_SECRET   # once, before the first sign-in: it seals it
node cli/nanoeval.ts plans sign-in claude                    # prints the page of Claude to open
node cli/nanoeval.ts plans complete --code 'CODE'            # the code that page shows once you approve, quoted: it holds a #
node cli/nanoeval.ts plans                                   # claude plan: signed in as account ...
node cli/nanoeval.ts run --eval terminal-bench-2.1 --only fix-git \
  --agent haiku=claude:claude-haiku-5-5 --payer plan --sandboxes 0   # prints RUN, for a runner of yours
node cli/nanoeval.ts plans sign-out claude                   # forgets the sign-in and revokes its refresh token
```

`nanoeval worker` needs no secret from you: it takes `PLAN_SECRET` from the environment, or makes one once and keeps it in a private file of its state directory. On a terminal `plans sign-in claude` asks for the code itself. Without one it prints the page and ends, and `plans complete` takes the code as `--code` or on standard input, so a script can drive the two steps. `sign-in` prints the time until which the code is taken.

**What a run does with it.** `--payer plan` is kept with the run and shown by `status`, and every session of the run asks for the plan, the sessions of its judge too. Its agents and its judge are `claude` sessions: a `codex` agent or judge, and an installed agent (`claude-code`, `codex-cli`), are refused when the run is created. An installed agent takes its credential from the model endpoint of the run, which gives the key or the login file of the Worker, and a ChatGPT plan is not signed in on a Worker (below). A run is refused while no plan is signed in, before it has a row or a sandbox, with a message that names `nanoeval plans sign-in claude`. Without the option a run is paid as before, by the key, the gateway key or the login file of the Worker, whether or not a plan is signed in.

**What is recorded.** A plan charges nothing per response. Every response still passes the meter of the run: its tokens are in `agent/model-requests.jsonl` and in the usage of the attempt, and it carries no cost. The model spend of such a run is what each session estimates from its tokens at list prices, as it is for a key whose responses name no cost. It is a measure of use, not a charge, and it is what `--model-budget-usd` bounds, attempt by attempt: the estimate of a session arrives when its attempt ends, so rows that run together can pass the budget by what they were using. A web search the provider ran is added at its list price when its response ends.

**The token.** The Worker keeps the sign-in in a Durable Object of its own (`PlanVault`), sealed under a key derived from `PLAN_SECRET`: the access token, the refresh token and when they end. It refreshes an access token that ends within five minutes before it sends a request with it, and when Claude answers a request `401` it refreshes once and sends the request once more. The credential is added in the egress of the Worker, and no record, artifact, log or error of a run holds it. A refresh that Claude refuses signs the plan out, and one that fails any other way leaves the vault unable to tell whether its refresh token was used up: either way no request is paid until you sign in again. The request that asked is answered `401` with a message that names the plan, its row ends as an `environment` error with that message, the rows not yet started end the same way without starting, and after a new sign-in `run --rerun RUN --errored --payer plan` takes them up. A refresh token that Claude does not date is taken to last 30 days from the sign-in. What Claude answers once a plan's usage limit is reached was not observed. Nothing here sets it apart from another answer of the provider, so such a row ends as its session ends it, as an `agent` error.

**The secret.** Keep `PLAN_SECRET` as it is: a Worker whose secret changes cannot open its sign-in. `plans` then answers that the envelope does not open, and `plans sign-out claude` forgets the sign-in so that a new one can be made.

**A ChatGPT plan** is not signed in on a Worker. chatgpt.com refuses requests from Workers, so it would need the relay container of nanocode-egress beside the vault: a Cloudflare Container that `wrangler deploy` builds with Docker and that `wrangler.jsonc` lists under `containers` and `durable_objects`, and the device sign-in of ChatGPT in the command line. `nanoeval worker --codex-login` runs a local Worker on a ChatGPT plan through a relay process instead.

## Run it on E2B

An E2B sandbox is a machine with root and no KVM: one was probed, see [DECISIONS.md](DECISIONS.md#2026-11-11-e2b-for-real-slots-without-kvm-a-runner-without-a-checkout-a-paid-run). Its runner boots the same environment disks in [ns slots](#ns-slots), several per sandbox, and is started from one archive that the run publishes, so the template needs nothing of nanoeval's. The Worker has to be reachable from the sandbox, for the runner, its blobs and the hands: a deployed Worker, or a tunnel in front of a local one.

```sh
node scripts/e2b-quote.ts desktop 1800      # the live price of 8 vCPUs and 8 GiB for 30 minutes, nothing is paid

node cli/nanoeval.ts worker --token "$TOKEN" --public-url https://WORKER.example
node cli/nanoeval.ts import terminal-bench-2.1 --only fix-git --only openssl-selfsigned-cert --store r2

# The operator pays: any MPP client opens the sandbox, and nanoeval attaches a runner in it.
node cli/nanoeval.ts run --eval terminal-bench-2.1 --oracle --sandboxes 0 --runtime --slots 3   # prints RUN
tempo request -X POST --json '{"templateID":"desktop","timeout":1800}' -o sandbox.json https://mpp.e2b.dev/sandboxes
node cli/nanoeval.ts sandbox --run RUN --e2b sandbox.json --sandbox-timeout-sec 1800 --slots 3
node cli/nanoeval.ts status RUN

# The Worker pays, with TEMPO_PRIVATE_KEY in its variables.
node cli/nanoeval.ts run --eval terminal-bench-2.1 --oracle --provider e2b --template desktop --slots 3 \
  --sandbox-budget-usd 1 --wait
```

| | State |
| --- | --- |
| The operator pays | Run for real: four runs in one `desktop` sandbox, 13 attempts, oracle and `gpt-6-luna`, three slots at once, no attempt errored |
| The Worker pays | The provider and the payer ran against a local mock only. No key was put in a Worker |
| envd: commands, files, the access token | Run for real |
| `DELETE /sandboxes/ID` | Run for real |

**What it costs.** E2B bills $0.0001 per request and, when a sandbox is created, its whole lifetime: $0.0000133 per vCPU-second and $0.000004275 per GiB-second, which is $0.127 an hour for `code-interpreter-v1` (2 vCPUs, 2 GiB) and $0.506 for `desktop` (8 vCPUs, 8 GiB). Nothing is refunded for a sandbox that is killed early. Over MPP a sandbox lives an hour at most, and a request for more is charged before it is refused: nanoeval sends none, and with another client ask for 3,600 s or less, and send one request before several. A run that opens sandboxes itself buys the longest its rows can keep the slots busy, from their timeouts, up to that hour: name `--sandbox-timeout-sec` when you know better.

**The end of a sandbox.** `nanoeval sandbox` takes the timeout the sandbox was opened with (`--sandbox-timeout-sec`, counted from the time the answer file was written, or from `--opened-at`) and tells the run when the sandbox ends. Its runner then takes a row only while the setup, agent and verifier timeouts of the row end before the sandbox does. These are worst cases: with `--setup-sec 600` a Terminal-Bench row of 900 s and 900 s is taken in the first 20 minutes of an hour, and 33 of the 89 tasks allow more than an hour in all. Such a row is taken only in the first `--setup-sec` of a sandbox, which is the most time there is for it, and if the sandbox ends first it ends as an error and is not claimed again. When no row that is left fits, the runner leaves, `status` says so, and rows that no runner could take for `--setup-sec` end as errors that `run --rerun RUN --errored` picks up: open another sandbox before that to go on. A shorter `--setup-sec` lets a sandbox take rows for longer. Every charge the Worker signs is checked against `--sandbox-budget-usd` first and listed under `payments` in the run's status.

**Which template.** A runner admits rows by 80 % of the sandbox's memory, and a row that asks for more than that runs alone with what the machine has free when it starts. `desktop` ran three Terminal-Bench rows of 2 GiB at once. `code-interpreter-v1` runs one such row at a time. Over MPP only E2B's public templates exist.

**What isolates what.** ns slots share the sandbox's kernel: they keep attempts apart as containers do, less strongly than microVMs, and the sandbox is the boundary to the outside. The file a paid request answers with holds the sandbox's access token. Keep it private and delete it with the sandbox.

### How fast a run starts

A run keeps a timeline, and `nanoeval status` prints the first of each step as an offset from its creation. Three things decide it: whether a runner is already there, whether a sandbox is, and what the sandbox has to fetch.

```sh
# A machine of yours stands by for any run with --sandboxes 0 and its backend: the run is handed to it when it is created.
# It serves several such runs at once in its --slots, and a run created while they are busy waits for the next free one.
node cli/nanoeval.ts runner --standing --backend krun --slots 4
node cli/nanoeval.ts run --eval terminal-bench-2.1 --agent luna=codex:gpt-6-luna --sandboxes 0 --backend krun --wait

# A leased sandbox is kept for 10 minutes after its run, and the next run with the same template, runtime and backend takes it.
node cli/nanoeval.ts run --eval terminal-bench-2.1 --agent luna=codex:gpt-6-luna \
  --provider gateway --template base --runtime-blob SHA256 --backend ns \
  --sandbox-lease-sec 900 --warm-sec 600 --sandbox-budget-usd 1 --model-budget-usd 1 --wait
node cli/nanoeval.ts pool            # what is kept, until when, and what the pool paid; --close ends it now
node cli/nanoeval.ts timeline RUN    # every step of a run
```

Measured on a deployed Worker with `gpt-6-luna` on `openssl-selfsigned-cert` of Terminal-Bench 2.1, one row a run, seconds after the run was created, median and worst:

| Start | Runs | First claim | First model request | First verdict |
| --- | --- | --- | --- | --- |
| Before: a `desktop` sandbox leased for the run | 5 | 17.9, worst 32.9 | 27.8, worst 150.1 | 75.9, worst 192.0 |
| Before: a runner attached to the run by hand | 4 rows of one run | 1.2 | not measured | not measured |
| Cold: a `base` sandbox leased for the run | 6 | 11.4, worst 31.2 | 14.5, worst 25.2 (4 runs) | 58.4, worst 175.4 (5 runs) |
| Warm: a sandbox the pool kept | 1 | 0.55 | 2.69 | 53.9 |
| A standing runner on a Linux machine, krun slots | 20 | 0.27, worst 0.39 | the turn was submitted at 1.75, worst 2.27 (5 runs) | 9.3, worst 11.2 (5 runs with the task's solution) |

The warm row is one run and not the five that were planned: the key's limit was spent by another job before the rest ran, and the same end cut the first model request of the standing runner, whose turns were submitted and refused. Under local workerd, where nothing is far, a standing runner claims 10 to 13 ms after a run is created, the model is asked after 90 to 130 ms and the first verdict is in after 0.2 to 0.3 s.

A cold start cannot be shorter than what E2B and the gateway take: 3.6 to 4.6 s for the paid create, 0.2 to 1.7 s for its price, and about 1.3 s before a command starts to run in the new sandbox. The runner then fetches and unpacks its 20 MB archive in 2.3 s, sets up in 0.4 s and claims. `base` is the template to lease: it has root, Node 20 and `mke2fs`, where `desktop` has no Node and costs five times as much. A kept `base` sandbox costs $0.104 an hour at E2B's price, a `desktop` one $0.51, and the pool pays $0.0001 to terminate it. The gateway sold no renewal, so a kept sandbox lives as long as the lease its run bought: `--sandbox-lease-sec` has to cover the runs and the idle time. [DECISIONS.md](DECISIONS.md#2026-11-12-a-run-that-starts-at-once) has every run and every step.

## Checks

```sh
npm run lint          # format and lint
npm run check:types   # tsc for Node and for the Worker
npm test              # unit tests
npm run dry-run       # bundle the Worker
npm run e2e           # local workerd + sandboxd + a runner + krun slots + the scripted model, skipped where krun cannot run
NANOEVAL_E2E_BACKEND=dir npm run e2e       # the same on directory slots, anywhere
NANOEVAL_E2E_MODEL=oracle npm run e2e      # the task solutions in place of a model
NANOEVAL_E2E_BACKEND=dir NANOEVAL_E2E_MODEL=oracle NANOEVAL_E2E_SCENARIO=unsound npm run e2e  # a solution that fails: nanoeval oracle exits 4, and 0 once the task is listed as unsound
NANOEVAL_E2E_MODEL=installed npm run e2e   # installed agents, with a scripted command in place of the vendor's
NANOEVAL_E2E_MODEL=installed NANOEVAL_E2E_AGENT=fx npm run e2e   # the same for fx, over chat completions and Messages; also opencode and pi
NANOEVAL_E2E_STORE=r2 npm run e2e          # blobs in R2 through the Worker
NANOEVAL_E2E_SCENARIO=judge npm run e2e    # final messages and a judge, with the scripted model
NANOEVAL_E2E_SCENARIO=failures npm run e2e # failure kinds and fixtures, then a rerun of what errored, exported beside its run
NANOEVAL_E2E_BACKEND=dir NANOEVAL_E2E_SCENARIO=plan NANOEVAL_E2E_SLOTS=2 NANOEVAL_E2E_ATTEMPTS=1 npm run e2e  # a Claude plan signed in on the Worker pays, against a scripted Claude
NANOEVAL_E2E_BACKEND=dir NANOEVAL_E2E_SCENARIO=login npm run e2e  # a Claude login file whose token ended and is then rejected, refreshed against a scripted Claude; NANOEVAL_E2E_MODEL=installed for login files of both tools under installed agents
NANOEVAL_E2E_SCENARIO=restart npm run e2e  # the Worker killed and restarted during the run
NANOEVAL_E2E_BACKEND=dir NANOEVAL_E2E_SCENARIO=midturn npm run e2e  # the Worker killed in a turn, which goes on; NANOEVAL_E2E_KILL=model, wait or pair for the other three moments
NANOEVAL_E2E_SCENARIO=forgotten npm run e2e  # the session objects removed under a running row: it is claimed again
NANOEVAL_E2E_BACKEND=dir NANOEVAL_E2E_SCENARIO=cancelled NANOEVAL_E2E_TASKS=write-greeting npm run e2e  # a run cancelled in a turn: its sessions are deleted under a hand, a second socket and a reader of their events
NANOEVAL_E2E_BACKEND=dir NANOEVAL_E2E_SCENARIO=direct npm run e2e  # a codex session with direct tools and one in Code Mode, in one run
NANOEVAL_E2E_BACKEND=dir NANOEVAL_E2E_SCENARIO=subagent npm run e2e  # a session that starts a subagent: its usage against the requests the model endpoint answered; NANOEVAL_E2E_KILL=child or parent kills the Worker while the subagent works or after it ended
NANOEVAL_E2E_SCENARIO=runners npm run e2e  # two attached runners with separate caches
NANOEVAL_E2E_BACKEND=dir NANOEVAL_E2E_SCENARIO=standing npm run e2e  # a standing runner that two runs are handed to
NANOEVAL_E2E_BACKEND=dir NANOEVAL_E2E_SCENARIO=shared NANOEVAL_E2E_SLOTS=2 npm run e2e  # a standing runner with the rows of two runs in its slots, one of them read while it runs
NANOEVAL_E2E_BACKEND=dir NANOEVAL_E2E_SCENARIO=stopped NANOEVAL_E2E_SLOTS=6 npm run e2e  # a standing runner stopped during a run, and another started
NANOEVAL_E2E_BACKEND=dir NANOEVAL_E2E_SCENARIO=taken NANOEVAL_E2E_LEASE_SEC=10 npm run e2e  # a standing runner that a run took and handed nothing
NANOEVAL_E2E_BACKEND=dir NANOEVAL_E2E_GATEWAY=1 NANOEVAL_E2E_SCENARIO=warm npm run e2e  # a leased sandbox kept for a second run, then ended by the pool
NANOEVAL_E2E_SCENARIO=lost NANOEVAL_E2E_LEASE_SEC=3 npm run e2e  # a runner killed: its rows are claimed again
NANOEVAL_E2E_SCENARIO=resume NANOEVAL_E2E_SLOTS=8 npm run e2e  # a runner killed and started again: it goes on
NANOEVAL_E2E_SCENARIO=gone npm run e2e     # a microVM killed under its verifier: the row is claimed again
NANOEVAL_E2E_SCENARIO=gone NANOEVAL_E2E_KILL=agent npm run e2e  # a microVM killed under its agent; also with NANOEVAL_E2E_MODEL=oracle or installed
NANOEVAL_E2E_SCENARIO=network npm run e2e  # what a private slot reaches and what reaches it
NANOEVAL_E2E_SCENARIO=closed npm run e2e   # tasks that close the network of the agent, the verifier or both
NANOEVAL_E2E_SCENARIO=cache npm run e2e    # a verifier that finds what an oracle run kept for it
NANOEVAL_E2E_SCENARIO=disks npm run e2e    # cached disks removed when no row needs them; also disk, packing
NANOEVAL_E2E_BACKEND=dir NANOEVAL_E2E_SCENARIO=threads npm run e2e  # no slot count: one slot for each hardware thread of the runner
NANOEVAL_E2E_BACKEND=ns npm run e2e        # ns slots: as root on this machine, or inside a microVM guest without KVM
NANOEVAL_E2E_BACKEND=ns NANOEVAL_E2E_SCENARIO=network npm run e2e         # what a private ns slot reaches
NANOEVAL_E2E_BACKEND=ns NANOEVAL_E2E_MODEL=installed npm run e2e          # installed agents on ns slots; also NANOEVAL_E2E_SCENARIO=cache
NANOEVAL_E2E_MODEL=installed NANOEVAL_E2E_SCENARIO=closed npm run e2e     # an installed agent whose task closes its network
NANOEVAL_E2E_BACKEND=ns NANOEVAL_E2E_MODEL=oracle NANOEVAL_E2E_RUNTIME=1 npm run e2e   # the runner from its archive
NANOEVAL_E2E_GATEWAY=1 npm run e2e         # models and the run's sandbox through a scripted gateway, with one key
NANOEVAL_E2E_GATEWAY=1 NANOEVAL_E2E_MODEL=installed npm run e2e          # installed agents through it; both also on dir and ns slots
NANOEVAL_E2E_GATEWAY=1 NANOEVAL_E2E_BACKEND=ns NANOEVAL_E2E_MODEL=oracle NANOEVAL_E2E_RUNTIME=1 NANOEVAL_E2E_STORE=r2 npm run e2e   # a leased sandbox that starts its runner from the archive
NANOEVAL_E2E_GATEWAY=1 NANOEVAL_E2E_SCENARIO=fleet NANOEVAL_E2E_SLOTS=1 npm run e2e   # two leased sandboxes, one of which dies during the run
NANOEVAL_E2E_GATEWAY=1 NANOEVAL_E2E_SCENARIO=lapse NANOEVAL_E2E_SANDBOX_LEASE_SEC=6 NANOEVAL_E2E_SLOTS=1 NANOEVAL_E2E_ATTEMPTS=4 npm run e2e   # a gateway that sells no renewal: sandboxes end with their lease and are replaced
node test/revision.ts          # nanoeval revision on a lab, directory slots, the scripted model: progress, a served lab, the queue, baselines by name, a quick check of a checkout whose hand is built (needs cargo), a build that falls back
node test/revision.ts watch    # nanoeval watch over nanoeval revision itself: a baseline, then a regression on demand
NANOEVAL_E2E_MODEL=anthropic npm run e2e   # a real model with ANTHROPIC_API_KEY
NANOEVAL_E2E_MODEL=codex-plan npm run e2e  # a real model on the ChatGPT plan of ~/.codex/auth.json
(cd krun && cargo clippy --all-targets -- -D warnings && cargo test)   # the launcher and its image converter
python scripts/harbor-check.py output/job  # with Harbor's Python: load an exported job with Harbor's models
```

The scripted model answers the harness with fixed tool calls, so the end-to-end test needs no API key. It still imports a real eval and runs the real Worker, the real nanocode-ts harness, a real runner, the released hand and the real verifiers.

CI is six jobs on GitHub-hosted runners: `check` (lint, types, unit tests, the dry run), `e2e-dir`, `e2e-krun` and `e2e-ns` (the lanes on each kind of slot), `e2e-revision` (the two lanes of `nanoeval revision` and `nanoeval watch` on directory slots) and `krun` (the launcher). A hosted runner has `/dev/kvm` and nothing else that a microVM needs, so every job but `e2e-dir` and `e2e-revision` first runs `scripts/ci-machine.sh`, which opens KVM to the runner's user and installs passt, `musl-tools`, libkrunfw and the Rust toolchain that `krun/` pins, and keeps the build of the launcher and the image layers in caches. The lanes read their fixture images through the layer cache of the machine (`NANOEVAL_LAYERS`, or `oci` under `~/.cache/nanoeval`), so a second run on a machine pulls nothing, and a pull that Docker Hub refuses fails its lane with what the registry said. **The workflow has never run on GitHub**: Actions is disabled for this repository, by its own setting or by the organization's. Its steps were run on Linux machines instead, see [DECISIONS.md](DECISIONS.md#2026-11-14-the-workflow-made-ready-for-hosted-runners-with-kvm).

## Layout

| Path | Holds |
| --- | --- |
| `worker/` | The Worker: routes, the `Evals`, `Run`, `Pool` and `PlanVault` objects, the R2 blob routes, the harness sessions |
| `src/` | Host-agnostic modules: the eval row and its versions, the run ledger, the runner protocol, tasks, results, admission, budget, providers |
| `sandbox/` | `Runner.ts`, the task runner, and `Main.ts`, its entry when it is bundled into one file. `slot.sh`, one attempt in one slot. `Store.ts`, the blob store and the cache. `Converter.ts`, where an environment becomes a disk through the launcher. `Prune.ts`, what can go from the layer cache and from a directory store. `Sandboxd.ts`, the local sandbox daemon |
| `krun/` | The Rust workspace: the libkrun binding, the launcher and the guest binary of the krun backend, the image converter (`nanoeval-krun image`), and `nanoeval-net`, the relay of a private slot |
| `cli/` | The `nanoeval` command, the import pipeline, `Runtime.ts`, which builds the archive a remote sandbox starts its runner from, and `Doctor.ts`, the checks of `nanoeval doctor` |
| `datasets/` | The dataset adapters, and the graders they write into tasks |
| `scripts/` | `install-linux.sh`, the E2B price quote, `harbor-check.py`, which loads an exported job with Harbor's own models, `scripted-model.ts`, a model endpoint that needs no credential, and `mine-failures.ts`, which classes the failed attempts of runs against a passing competitor |
| `tasks/` | Three small Harbor tasks from gakonst/nanoeval |
| `test/` | Unit tests, the end-to-end test and its failure fixtures, and `Guest.ts`, the microVM guest that ns lanes run in on a machine without root, and `MockGateway.ts`, the scripted gateway of the gateway lanes, and `worker/Taken.ts`, the Worker of the lane `taken`, whose pool loses a call when the lane asks |

## License

[MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
