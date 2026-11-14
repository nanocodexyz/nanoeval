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

## Status

The table says what was run. "The first version" is the flow before the eval table, whose slots pulled images when an attempt started: [DECISIONS.md](DECISIONS.md) keeps what it measured.

| Piece | State |
| --- | --- |
| Eval table (`Evals` Durable Object): rows, immutable versions, `nanoeval import`, `evals`, `eval` | Implemented, tested: unit tests for digests and versions, and every end-to-end lane imports before it runs |
| Blob store by SHA-256: a directory on a machine | Implemented, tested. Terminal-Bench 2.1 is imported into one: 89 tasks, 19.2 GB of packed disks, in under 5 minutes |
| Blob store by SHA-256: R2 through the Worker | Implemented, tested end to end under local workerd: small evals, and one 1.40 GB disk uploaded in parts, downloaded, and downloaded again with the stream cut three times and resumed by range. Run against Cloudflare's R2 on a deployed Worker with four Terminal-Bench 2.1 disks of 38.6 to 147.1 MB: imported from a Linux machine in 85 s, and fetched there by a runner. Then all 89 disks of Terminal-Bench 2.1, 19.2 GB, imported in 2,169 s and fetched by runners in leased sandboxes |
| Environment conversion at import (`sandbox/Converter.ts`), with no container engine | Implemented, tested: `nanoeval-krun image build`, `pack` and `unpack`. The 89 images of Terminal-Bench 2.1, one SWE-bench instance image, `python:3.12-slim` and the 14 Dockerfiles of this repository converted. The 89 disks have the same trees as disks made from `docker export`, apart from the files an engine adds. See [DESIGN.md](DESIGN.md#environment-conversion) for what a Dockerfile may use |
| Host policy for the `RUN` steps of a Dockerfile (`import --ca-bundle`, `--slot-env`, `--slot-forward`) | Implemented, tested on a Linux machine whose network re-signs TLS and serves the Python and npm registries on its loopback: a fixture that installs with pip and npm is refused without the options and imports with them, five Terminal-Bench 2.1 tasks built from their Dockerfiles, and no disk holds the bundle, a variable or a forward. On the base layers of the published images the trees differ only in what the day of a build decides, see [DECISIONS.md](DECISIONS.md#2026-11-11-the-smaller-gaps) |
| Run table (`Run` Durable Object): rows, claims, leases, CLI and API | Implemented, tested: unit tests for claims, leases, expiry and fencing, and end to end under local workerd |
| Task runners (`nanoeval runner`), started by a run through a sandbox or attached by hand | Implemented, tested: two runners with separate caches on one machine work one run |
| A timeline of every run: what the run, its sandbox and its runners did from its creation to the first claim, the first model request and each verdict (`nanoeval status`, `nanoeval timeline RUN`, `timeline.json` of an exported job) | Implemented, tested: unit tests, and read on a deployed Worker for every run of [How fast a run starts](#how-fast-a-run-starts) |
| No polling where a run starts: a claim, the attach of a hand and the end of a turn are requests the run holds until there is an answer, and a runner follows its slots by file events | Implemented, tested end to end: every lane runs on it |
| Standing runners (`nanoeval runner --standing`) and the pool of a deployment (`nanoeval pool`): a run is handed to a runner that is already there | Implemented, tested: unit tests for the table, and an end-to-end lane where two runs are handed to one runner and claim 10 to 13 ms after they are created. Run for real: 20 runs handed to a krun runner on a Linux machine, the first row claimed 0.11 to 0.39 s after each was created |
| A standing runner with several runs at once: their rows share its slots, a run created while it is busy is handed to it at once and waits for a free slot, and the runner enrols again when the pool closes it and leaves the pool when it is stopped | Implemented, tested: unit tests for the table, and end-to-end lanes on directory slots where a second run is created while the runner has a row in flight and finishes beside it, and where the pool is closed under an idle runner. Two runs at once also ran on krun slots under local workerd. **Not run on a deployed Worker** |
| A sandbox kept warm between runs (`run --warm-sec`): its runner stands by with its disks unpacked, and the pool renews and terminates it | Implemented, tested against the scripted gateway on directory and ns slots: the second run pays for no sandbox and fetches no disk, the pool renews the lease while the sandbox is idle and terminates it when the idle time ends, and every charge is recorded once. Run for real: one run on a kept sandbox claimed 0.55 s after it was created, and the pool terminated two sandboxes at the end of their idle time. **The pool has not paid a renewal for real**: the gateway sold none |
| A runner lost during a run: its rows are claimed again, at most `--claims` times, and nothing scores twice | Implemented, tested end to end: a killed runner's rows end scored by the other runner, with the lost claims recorded |
| A slot that ends under its row, such as a microVM that the kernel killed for memory: the row goes back to the run and is claimed again | Implemented, tested end to end on krun slots: a microVM killed with a signal while its verifier runs, and the row passes on its second claim. Not run with a kill by the kernel, and not on ns slots |
| A runner stopped during a run: its rows go back at once, it is handed none on its way out, and it leaves no slot | Implemented, tested end to end on directory slots: a standing runner is stopped later than `--setup-sec` with a row in flight, and the runner started after it finishes the row on its second claim, within seconds and not a lease |
| A leased sandbox that dies during a run, and one whose lease ends | Implemented, tested end to end against the scripted gateway on directory and krun slots: the rows of a sandbox that died are claimed again in another, and a run goes on in new sandboxes when no renewal is sold. The second also ran for real |
| A runner restarted during a run | Tested: it goes on with the slots it had and loses no claim. Started again after a restart of its machine, or by a nanoeval with another hand, backend or network, it sets its home up again, and the rows of the slots that ended with the machine go back to the run: a unit test of `slot.sh setup` with the boot id that the home recorded rewritten. **Not met on a machine that restarted** |
| A runner whose machine cannot bring a slot up | Implemented, tested: the row goes back to the run and counts one claim, the runner claims no more rows, finishes the ones whose slots are up and exits with what the machine said, and `status` shows it as refused. A unit test of the exit status of `slot.sh up`, and an end-to-end lane on directory slots beside a runner that works: every row ends scored there and none errors. By hand: the `up` of an ns slot as root with a cgroup that is gone, a home that is full, the same runner started again once its machine was repaired, and a leased sandbox against the scripted gateway, which is failed and replaced. **Not run**: the lane on krun slots, an ns slot in a run, a real sandbox |
| A session that no longer has the turn of its row: its object was deleted, or started empty under another nanocode-ts build | Implemented, tested: the run ends the claim as `forgotten` with what the session answered, the row goes back and counts one claim, and a row that is out of claims ends as an `environment` error that names the session. A unit test of the ledger, and an end-to-end lane on directory and krun slots that removes the session objects of a Worker under a row in its `run` phase: the row was claimed again a tenth of a second after the Worker answered, ended scored, and the spend kept the response the lost session had been answered. Without the change the same lane ends after four leases, 240 s, with the row an error. By hand: a row out of claims, a judge session, and sessions lost while the verifier ran. **Not run**: a deployed Worker, a move between two nanocode-ts builds, a session lost before its turn was submitted |
| Rerun lineage (`nanoeval run --rerun RUN [--failed\|--errored]`) | Implemented, tested end to end: each row names the attempt it retries |
| nanocode-ts harness sessions | Implemented, on nanocode-ts `build-7968b53`. Tested end to end under local workerd. A cell that names no yield runs for two minutes before it goes back to the model (`CELL_YIELD_MS`), where the protocol gives it 10 s: the plain lane on directory slots runs a cell of 12 s and asks that it ends in the exec that started it. Measured with a model on 20 tasks, one attempt each: 174 model calls where 10 s took 219, 9 `wait` calls where it took 29, 17 passed where 16 did. See [DECISIONS.md](DECISIONS.md#2026-11-13-a-cell-yields-after-two-minutes-set-by-the-brain) |
| Installed agents (`codex-cli`, `claude-code`): the vendor's command line inside the slot, its model requests through an endpoint of the run that adds the credential | Implemented, tested: unit tests for the agent syntax, the commands, the credential swap and the usage meter, and end-to-end lanes with a scripted command on directory and krun slots (tasks, failure kinds, a restarted and a lost runner), on ns slots in a guest (tasks), and on krun slots whose tasks close the agent's network. Codex CLI 0.166.0 ran 6 Terminal-Bench 2.1 tasks on krun slots through a ChatGPT plan login beside a nanocode session on the same model: 6 passed for each, and it passed two fixtures in an Alpine image. The Claude Code 2.1.318 binaries ran on krun slots in an Alpine and a Debian image against a scripted Messages endpoint. Through the gateway, from a deployed Worker, both commands ran on ns slots in a sandbox the run leased, where the runner fetched their releases: Codex CLI 0.166.0 and Claude Code 2.1.318 each passed `fix-git` on a small model, and again at high effort on a large one. Those are the first answers Claude Code had from a real Messages endpoint, see [Deploy it](#deploy-it). Claude Code has not run with an Anthropic API key or a plan login: no valid login was at hand. See [DESIGN.md](DESIGN.md#installed-agents) |
| `nanoeval compare RUN...`: the agents of one or more runs in one table | Implemented, tested |
| Local sandbox provider (`nanoeval sandboxd`) | Implemented, tested |
| Slot backend `krun`, one libkrun microVM per slot | Implemented, tested on a Linux machine with KVM: every end-to-end lane, 32 microVMs at once, and Terminal-Bench 2.1 with the tasks' own solutions, imported once and run by two runners: 82 of the 89 pass, and all 89 rows end as they did when slots pulled images. [DECISIONS.md](DECISIONS.md#2026-11-11-no-container-engine-at-import-or-at-run-time) has the table |
| Slot backend `ns`, one set of namespaces per slot over the same disk, for a machine with root and no KVM | Implemented, tested inside a microVM guest without KVM (the slot test and the scripted, oracle, failures, judge, network, restart and packing lanes) and in E2B sandboxes. It shares the machine's kernel: see [ns slots](#ns-slots) |
| A runner that picks its backend (`--backend auto`, the default of a run) | Implemented, tested: `krun` where `/dev/kvm` opens, `ns` where the runner is root |
| Slot backend `dir` | Implemented, tested. For development and for lanes on a machine with neither KVM nor root |
| Released `nanocode hand` in a slot, including Alpine images | Implemented, tested. The pinned hand, `nanocode-cli-3f97ab0`, ran the 89 solutions of Terminal-Bench 2.1 through its Bash tool on ns slots beside `--oracle`: 80 passed against 84, and the four it does not pass run longer than that tool's ten minutes. `claude-haiku-5-5` passed 65 of the 89 tasks with the pins before, and on 21 of the tasks 19 with this hand and the harness build before this one, `build-81eada9`, 18 and 17 with the two sets before them, one attempt a row, on a 5-core machine without KVM. **Not run on these builds**: `codex` agents, `gpt-6-luna`, all 89 tasks with a model, a sandbox. See [DECISIONS.md](DECISIONS.md#2026-11-13-the-harness-moves-to-nanocode-ts-build-81eada9-and-the-hand-to-nanocode-cli-3f97ab0) |
| Real model run | Tested with `gpt-6-luna` on a ChatGPT plan login: 3 Terminal-Bench tasks of the imported eval, 2 passed and 1 ended as a `verifier` error that its rerun passed, and the end-to-end lane before the eval table. `claude-haiku-4-5` through the Anthropic API ran on the first version only. Through the gateway, from a deployed Worker: `gpt-6-luna` and `claude-haiku-5-5` each passed 4 of 4 Terminal-Bench 2.1 tasks, and `gpt-6.1-sol` and `claude-opus-5-5` one task at high effort, see [Deploy it](#deploy-it) |
| Oracle run (`nanoeval run --oracle`): each task's own solution instead of a model | Implemented, tested |
| Dataset adapters (`nanoeval import`, `datasets`) | Implemented, tested: unit tests import from recorded fixtures with no network |
| `terminal-bench-2.1`, imported from the Harbor registry by digest | Verified: the 89 packages match the ones Harbor downloads byte for byte. Imported as an eval and run with the tasks' own solutions, see above |
| `terminal-bench-2.0` | 89 tasks imported and checked against their digests with the first version. 2 imported as an eval and run with their own solutions on krun slots: both passed |
| `swe-bench-verified` | 500 instances written as task directories with the first version. 1 imported as an eval: its image became a disk of 1.1 GB packed and its gold patch passed on a krun slot. The other 499 have not been converted or run |
| `gpqa-diamond` | 198 tasks. 5 imported as an eval and run with their reference answers: all passed. 5 ran with `gpt-6-luna` on the first version only |
| `healthbench-professional` | 410 cases. 2 imported as an eval and run with their physician answers, judged by `gpt-6-luna`. 3 ran with `gpt-6-luna` on the first version only |
| A task graded on the agent's final message, and a judge answered by the orchestrator | Implemented, tested end to end on krun and dir slots with the scripted model and with the fixtures' own answers, and with a `gpt-6-luna` judge on two HealthBench cases of an imported eval |
| GraphWalks, MRCR, Arena-Hard, BrowseComp, GDPval, SWE-Atlas QnA, GeneBench Pro, ARC-AGI-3, Agents' Last Exam importers | Not ported. [Datasets](#datasets) says why |
| Harbor job export and ATIF-v1.7 trajectories | Implemented. Exported jobs load with the models of Harbor 0.25.0 (`scripts/harbor-check.py`). The shapes Harbor enforces are unit tested. The tokens and steps of a session come from the model calls its object keeps beside its log, see [DESIGN.md](DESIGN.md#harness-outside-the-sandbox): unit tested on the events of nanocode-ts `build-81eada9`, and every end-to-end lane with a session checks that an attempt whose model endpoint answered has its calls and tokens and one agent step for each call. A model call that a session reads back from its log when it goes on after its Worker was lost is counted once, and the instruction it accepts again is one step |
| Failure kinds `verifier`, `agent_timeout`, `environment` | Implemented, tested |
| A verifier that scores without the test report it names is an error, not a zero | Implemented, tested |
| Every file a verifier writes is kept, binary files included | Implemented, tested |
| The count of processes a task's memory limit killed (`oomKills`) | Implemented, tested on krun slots |
| Cached disks removed when no row needs them (`--disks remove`), and `nanoeval prune` | Implemented, tested, and run for real in leased sandboxes, where each disk went with its row. Below `--free-disk-mb` a runner also removes the disks of the run that none of its own rows uses: tested in the disk lanes, not met for real |
| The layer cache pruned by days since last use (`nanoeval prune layers`) | Implemented, tested: unit tests on temporary caches, and on a Linux machine with KVM: a removal during an image build was refused, the build succeeded, and the next removal took 10 of 44 blobs. Listed only, not removed, on the 16 GB cache of the Terminal-Bench 2.1 import |
| Unreferenced blobs of a directory store pruned (`nanoeval prune store`) | Implemented, tested: unit tests on temporary stores, and on a Linux machine with KVM: a removal during an import was refused, the next removed 6 of 14 files, and an oracle run of the eval passed afterwards. Listed only on the store of the Terminal-Bench 2.1 import, where every blob is referenced. Blobs in R2 are not pruned, and eval versions are never removed |
| What uv downloads for a verifier, kept per task (`run --verifier-cache`, off by default) | Implemented for krun and ns slots, tested end to end with a fixture on both, and on krun slots on ten Terminal-Bench 2.1 tasks with their solutions: the same ten outcomes with and without it, and 60 s of verifier time against 103 to 120 s. Only an oracle's attempt fills it. apt and pip are not cached |
| A task that asks for more memory than its runner admits | Implemented, tested: it runs alone, with the memory its machine has free when it starts instead of the 80 % a runner admits to rows that share, and a row that did not pass after that limit killed a process is an `environment` error. Unit tests, and a lane on ns slots in a guest. Run for real with the earlier limit only: the eight tasks of Terminal-Bench 2.1 that ask for 8 GiB ran with 6,364 MB, and with models one row, `rstan-to-pystan` under Claude Code, had two processes killed at that limit. **Not run in a sandbox since** |
| The order rows are claimed in | Implemented, unit tested: longest timeouts first within an attempt number, and as many runners begin with a row that needs a whole machine as the share of the remaining work such rows are, so the others fill their slots at once. Simulated with the durations of two arms of Terminal-Bench 2.1, see [DECISIONS.md](DECISIONS.md#2026-11-12-what-the-three-arms-found-fixed). **Not run at that size since** |
| A runner that knows when its sandbox ends (`sandbox --sandbox-timeout-sec`, `runner --ends-in-sec`, and every sandbox a run opens or takes from the pool) | Implemented, tested: unit tests and a lane on directory slots. A runner takes a row only while the setup, agent and verifier timeouts of the row end before its sandbox does, stops claiming once no row that is left does, and the status and the timeline of the run say so. A row whose timeouts no sandbox of that length covers is taken in the first `--setup-sec` of a sandbox and ends as an error, without another claim, if the sandbox ends first. A row that no runner could take for `--setup-sec` ends as an error in a run that opens no sandbox itself. **Not run in a paid sandbox** |
| A model request whose payment is refused | Implemented, tested: unit tests on the gateway's own answers, and lanes with a scripted gateway for sessions and for installed agents. A refusal that passes (`delta-too-small`, `insufficient-balance`) is sent again up to `--step-retries` times. One that says the key or its wallet is spent (`payment_failed`) ends the row as a `budget` error and every row not yet started with it, unclaimed. **Not met for real since** |
| Model spend by response, and what the key was charged | Implemented, tested in the gateway lanes: each response is recorded with its cost as it ends, so an attempt that errors or is cancelled keeps what it spent and `--model-budget-usd` sees it while rows run. A gateway run reads its key's usage at its start and its end and `status` prints what the key was charged, through its channel and outside it, beside what the run recorded. Searches and fetches the model provider ran are counted, not priced. **Against the scripted gateway only**: the real key's usage was read once, by hand |
| A floor on free disk for claims (`--free-disk-mb`) | Implemented, tested. It is reactive: it does not reserve what running attempts write later |
| Orchestrator restart during a run | Tested: the Worker is killed with attempts in flight, restarts on the same state, and the run finishes. A turn that it was killed in goes on where it was, since nanocode-ts `build-7968b53`: three lanes on directory slots kill the Worker while a cell runs on the hand, while the model is asked and while a `wait` is out, and ask that every command ran once, that only the request without an answer was sent again, that no tool call has an unknown outcome, and that the usage and the trajectory are those of the responses the model endpoint answered. On `build-2672c04` the same turn started again from its instruction, and the lanes fail there. **Not run**: a deployed Worker, a real model, a `codex` session, a Worker killed together with the hand. See [DECISIONS.md](DECISIONS.md#2026-11-14-a-turn-goes-on-after-its-worker-was-killed-on-nanocode-ts-build-7968b53) |
| E2B sandboxes paid by the operator (`nanoeval sandbox`) | Run for real: a sandbox opened with an MPP wallet CLI, a runner attached in it, 13 attempts of Terminal-Bench 2.1 tasks on ns slots, with the tasks' solutions and with `gpt-6-luna`. Then at the size of a benchmark: three model arms over all 89 tasks of Terminal-Bench 2.1 in 28 such sandboxes of an hour each. See [Run it on E2B](#run-it-on-e2b) |
| E2B sandboxes paid by the Worker (`--provider e2b`) | Implemented and tested against a local mock, with the bodies, the envd calls and the kill checked against the real service. A lifetime over the 3,600 s that E2B keeps a sandbox over MPP is refused before anything is paid, by the run, the provider and `scripts/e2b-quote.ts`. **The Worker has not paid for a sandbox**: no key was put in one |
| Sandboxes leased from the gateway (`--provider gateway`) | Implemented, tested end to end against a scripted gateway on directory, krun and ns slots: each request priced before it is paid, the lease renewed while rows run, the sandbox terminated at the end, and on ns slots the runner started from the runtime archive. Run for real: four runs started on a laptop each leased one `desktop` sandbox from the gateway, started the runner in it from the runtime archive, ran their rows on ns slots and terminated it, with no runner on a machine of the operator's. A run recorded $0.0445 for its sandbox, which agrees with what the key was charged. Then at the size of a benchmark: all 89 tasks of Terminal-Bench 2.1 with their solutions in four sandboxes of four ns slots, 79 passed in 2,016 s, and 84 with the five rows that two defects of ns slots had failed, rerun after their fix. **No renewal has been paid for real**: the gateway sold none on the day, so a lease is bought whole, and a sandbox that is sold no renewal is used to the end of its lease and then replaced, which a run of ten tasks with leases of 240 s did. See [Deploy it](#deploy-it) |
| The runner runtime (`--runtime`, `nanoeval runtime`): the runner as one archive that a sandbox without a checkout starts from | Implemented, tested: in a guest on Node 20.9, and on E2B's `desktop` template, which has no Node |
| A sandbox lifetime chosen by the run from the timeouts of its rows | Implemented, unit tested: the longest its rows can keep its slots busy, up to what the provider keeps a sandbox for. A sandbox whose end comes before the timeouts of the rows that are left takes no more of them, and the run opens another for those. Not exercised as a paid lifetime: the E2B sandboxes paid for had one named by hand, and a gateway sandbox takes it as a bound that costs nothing |
| `storage_mb` | The size of a krun slot's copy-on-write disk |
| Images whose user is not root, and images without bash | Tested with a fixture: tests and solutions are put in place as root, and the agent and the verifier run as the image's user |
| Codex models (`provider: codex`) | Tested on a ChatGPT plan login (`nanoeval worker --codex-login`). With a key nanocode-ts takes Responses over HTTPS: tested against a scripted gateway, and run through the real one from a deployed Worker with `gpt-6-luna` and `gpt-6.1-sol`. Not run with an OpenAI API key |
| Claude plan login (`nanoeval worker --claude-login`) | Run once, on the first flow: `claude-haiku-4-5` on `uppercase-message` reached the model through the plan and ended `failed`. The hand's `Bash` tool needs bash, which that Alpine image lacks, see [DECISIONS.md](DECISIONS.md#2026-11-11-installed-agents-and-nanocode-beside-codex-cli). Not run on the eval table: the login had expired and its tool could not renew it without a browser |
| A Claude plan signed in on the Worker (`nanoeval plans`, `run --payer plan`) | Implemented, tested against a scripted Claude only: unit tests of the sealed record, the sign-in, the refresh after a `401` and what a run refuses, and an end-to-end lane on directory slots under local workerd where the command line signs in, a run is paid by the plan with a token refreshed on the way, a run without the option leaves the plan alone, a plan whose refresh is refused ends its rows as `environment` errors, and no file of the lane holds a token or the secret. Not run against Claude: no sign-in, refresh or model request of a real plan was made, under local workerd or on a deployed Worker |
| Models through the gateway with one key (`TEMPO_KEY`), and a bearer token for an Anthropic endpoint (`ANTHROPIC_AUTH_TOKEN`) | Implemented, tested: unit tests, and end-to-end lanes where a scripted gateway serves a `codex` and a `claude` session, or a scripted Codex CLI and Claude Code, refuses anything but the key as a bearer token, and reports the cost of each response, which becomes the cost of the attempt. Run for real from a deployed Worker: `codex` and `claude` sessions, Codex CLI and Claude Code all answered and passed their rows, 14 attempts in three runs, and the $0.4556 of model spend that the runs recorded agrees with what the key's channel was charged, see [Deploy it](#deploy-it) |
| Services on one Linux machine (`scripts/install-linux.sh`) | Implemented, tested: installed under a second name on other ports with the store, cache, layers and state on chosen paths, ran an import and a run through the installed services, and removed again |
| A certificate bundle and variables for slots (`sandboxd --ca-bundle`, `--slot-env`) | Implemented, tested |
| A private network per slot (`--network private`, the default for `krun` and `ns` slots) | Implemented, tested on a Linux machine with KVM: a slot has its own loopback and ports, reaches the internet, and is reached neither by another slot nor by the host |
| The shared host network (`--network host`) | Implemented. Attempts that listen on a fixed port are not isolated from each other there |
| A hand of a private slot attached to a Worker over `wss://` | Run from private ns slots in an E2B sandbox, through a tunnel in front of a local Worker, and from private krun slots on a Linux machine to a deployed Worker |
| Listeners on the machine's loopback that private slots may reach (`sandboxd --slot-forward`) | Implemented, tested with a registry proxy on a machine's loopback |
| Deployment to Cloudflare | Deployed and run: an import into R2, four Terminal-Bench 2.1 tasks with their solutions on a krun runner attached from a Linux machine, 4 of 4 passed, and the same four with their solutions, with models and with installed agents in sandboxes leased from the gateway, where nothing of the operator's ran. See [Deploy it](#deploy-it) |
| A task that closes the network of its agent, its verifier or both (`allow_internet = false`, Harbor's `network_mode`) | Implemented for krun slots on a private network, tested end to end: a closed phase reaches neither the internet, by name or by address, nor the machine, and the attempt completes. Refused on `dir` and `ns` slots, on `--network host`, and with `--backend auto`, whose runners may take ns: such a run names `--backend krun`. A network allowlist is refused. No dataset shipped here closes a phase yet |
| Tasks with a Compose file or MCP servers, separate verifier environments, `reward.json` | Refused, except `reward.json`, which is not read: a verifier that writes only it ends as a `verifier` error. Planned |
| Prompt-cache cohorts, duration-ordered dispatch, R2 artifacts, MPP sessions | Planned |

## Run it locally

Requirements: Linux and Node 24. For `krun` evals and slots, which a runner takes by itself on a machine with KVM: `/dev/kvm`, libkrunfw 5, `mke2fs`, passt, and a Rust toolchain through rustup or a built launcher, see [krun slots](#krun-slots). No Docker or other container engine, on any machine. The first import or runner of a machine builds the launcher and `nanoeval-net` from `krun/` (about a minute) and later ones reuse them. `NANOEVAL_KRUN` names a directory with the built binaries instead.

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

`--out` writes the Harbor job directory. `nanoeval status`, `attempt`, `export` and `cancel` read a run later, and `attempt` lists the claims of a row. `nanoeval run --task DIR` does steps 3 and 4 at once, into the eval named `local`. A machine without KVM that has root runs the same evals in [ns slots](#ns-slots): a runner picks them by itself, and `--backend ns` names them. A machine with neither takes `--backend dir` in both steps: no isolation, for development.

Blobs go to a directory by default, `~/.local/share/nanoeval/store` (`--store DIR` or `NANOEVAL_STORE`), which the runners of the same machine read. `--store r2` uploads them through the Worker into its `BLOBS` bucket instead, and runners then fetch them through their run. A runner keeps what it fetched, verified, in `~/.cache/nanoeval` (`--cache` or `NANOEVAL_CACHE`). An import keeps the image layers it read from registries in `oci` under that cache (`--layers` or `NANOEVAL_LAYERS`), so importing a dataset again downloads none of them.

**More runners.** A run starts one runner in each sandbox it opens. Any machine that reaches the Worker can add one:

```sh
node cli/nanoeval.ts run --eval samples --oracle --sandboxes 0   # prints the run's id and waits for runners
node cli/nanoeval.ts runner --run RUN --slots 4 --cache /var/cache/nanoeval-a
node cli/nanoeval.ts runner --run RUN --slots 4 --cache /var/cache/nanoeval-b
```

Each claims rows up to its own slots and memory and leaves when the run is finished. A runner that is killed loses its rows after `--lease-sec` (60 s), and another claims them. A runner started again in the same `--home` goes on with the slots it had. After a restart of its machine it sets the home up again and has no slots left: the rows it held go back to the run.

Every krun slot gets a network of its own (`--network private`): its own loopback and ports, the internet, and no way in from another slot or from the machine. A hand dials `ws://127.0.0.1`, which nanocode accepts only on loopback, so each slot relays that one address to the Worker. `--network host` puts the slots on the machine's network instead, where they share its ports.

Without an API key, a plan login works. `nanoeval worker --codex-login ~/.codex/auth.json` runs `codex` agents such as `--agent luna=codex:gpt-6-luna` on the ChatGPT plan signed in there, and `--claude-login ~/.claude/.credentials.json` does the same for `claude` agents. The access token is read once when the Worker starts and is never refreshed: sign in again with that tool and restart the Worker when it expires. A plan signed in on the Worker itself is refreshed by it and is chosen run by run, on a local Worker as on a deployed one: see [A Claude plan instead of a key](#a-claude-plan-instead-of-a-key).

An agent whose harness is `codex-cli` or `claude-code` runs that vendor's command line inside the slot instead of a nanocode session outside it, on the same credentials of the Worker, and `nanoeval compare` puts the agents of one or more runs in one table:

```sh
node cli/nanoeval.ts run --eval terminal-bench-2.1 --only fix-git --only regex-log \
  --agent nano=codex:gpt-6.1-sol:high --agent cli=codex-cli:gpt-6.1-sol:high --wait
node cli/nanoeval.ts compare RUN
```

The first such run on a machine downloads the pinned release of the command into the cache and checks it against its SHA-256: an archive of 200 MB for Codex CLI, 517 MB unpacked, and 632 MB for the two builds of Claude Code. The task image is not changed, and the credential stays in the Worker: the command gets an address and a token that are good for that attempt only. Prompts and tools are each harness's own, see [DESIGN.md](DESIGN.md#installed-agents) for what such a comparison holds equal. A `codex-cli` agent has token counts and no cost estimate of its own, so `--model-budget-usd` bounds it only when the endpoint reports what it charged, as the gateway does.

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
- **GPQA and HealthBench are closed-book, and their tasks do not say so yet.** A task that sets `allow_internet = false` or Harbor's `network_mode = "no-network"` runs on a krun slot without a network (`--backend krun`), but these two importers still write tasks that leave it open, so an agent could search.
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

`--backend krun` gives every slot its own microVM, and is what a runner takes by itself on a machine with KVM. The machine of a runner needs:

- Linux on x86_64 or aarch64 with `/dev/kvm` readable and writable by the user that runs the runner, usually through the `kvm` group.
- [libkrunfw](https://github.com/containers/libkrunfw) 5 where the dynamic loader finds `libkrunfw.so.5`.
- `mke2fs` from e2fsprogs.
- A Rust toolchain through rustup. The first import or runner builds the launcher in `krun/` (about a minute) and later ones reuse it. `NANOEVAL_KRUN` names a directory with a built `nanoeval-krun`, `nanoeval-krun-guest` and `nanoeval-net` instead.
- [passt](https://passt.top) installed as a system package (`apt install passt`), for the private network of slots and of a Dockerfile's `RUN` steps. A copy in a user's directory cannot sandbox itself where unprivileged user namespaces are restricted. `--network host` does not need it.

The machine that imports needs the same things and nothing more: the launcher pulls images and builds Dockerfiles itself, see [DESIGN.md](DESIGN.md#image-disks). No Docker, containerd or podman is used or needed, and none is called if one is installed. A Dockerfile whose `RUN` steps install from a registry that the machine's network re-signs or keeps on its loopback builds when the import has the machine's policy, `--ca-bundle`, `--slot-env` and `--slot-forward`, which the installed command has from the installation. The disk keeps none of the three. Tasks that name an image need none.

Unpacked disks are kept in `~/.cache/nanoeval/disks` (`NANOEVAL_CACHE` moves the cache) until `--disks remove` or `nanoeval prune` removes them. With `--network host` a slot shares the host's sockets, with the limits listed in [DESIGN.md](DESIGN.md#krun-slots).

### ns slots

`--backend ns` boots the same disks without a microVM, for a machine that has root and no KVM, such as a remote sandbox. A runner picks it by itself there. The machine of a runner needs:

- Root, and a kernel with overlayfs, loop devices, namespaces and, for limits, cgroup v2 with the memory controller.
- `unshare`, `setpriv`, `mount`, `losetup` and `mountpoint` from util-linux, `chroot` and `env --default-signal` from coreutils 8.31 or later, `mke2fs` and `pgrep`.
- `ip` and `nft` for the private network, and a resolver that is not on the machine's loopback.
- The launcher, as for krun slots. It needs neither KVM nor libkrunfw here, and `nanoeval runtime` builds one that is linked statically.

Each slot gets its own mount, PID, IPC, UTS, cgroup and network namespaces, the task's memory and CPUs as cgroup limits, a root that grows to `storage_mb`, and a capability set without mounts and device nodes. It shares the machine's kernel, so it keeps attempts apart as a container does and less strongly than a microVM. [DESIGN.md](DESIGN.md#ns-slots) says what a slot may and may not do.

Installed agents and `--verifier-cache` work in ns slots as in krun slots. A task that closes the network of a phase does not run there: only a microVM has the gate that closes it, so such a run is refused unless it names `--backend krun`.

## Deploy it

The Worker runs on Cloudflare with its Durable Object classes and one R2 bucket, and takes its models and its sandboxes from the [Tempo gateway](https://gateway.tempo-dev.workers.dev/docs) with one key, so that a run needs no machine of yours once its eval is imported. The table below says how much of that has run.

```sh
npx wrangler r2 bucket create nanoeval-blobs
npx wrangler deploy
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
| `PUBLIC_URL` | The address that runners and hands dial, when it is not the one the run was created through |
| `TEMPO_PRIVATE_KEY` | A wallet key for `--provider e2b`, see [Run it on E2B](#run-it-on-e2b) |
| `PLAN_SECRET` | 32 characters or more that seal a Claude plan signed in with `nanoeval plans`, see [A Claude plan instead of a key](#a-claude-plan-instead-of-a-key) |
| `CLAUDE_PLAN_URL` | One address in place of the hosts of Claude for the token, profile and Messages requests of a signed-in plan, for a Worker under local workerd whose network needs a forwarder. The end-to-end lane points it at its scripted Claude |

**What it costs.** Model requests are charged per token, and the cost of an attempt is what the gateway reported with its responses: nanoeval reads `usage.cost`, in USD, from the last usage of each response (`message_delta` or the body of a Messages response, `response.usage` of a Responses one) and records it when the response ends, so an attempt that errors keeps what it spent. A request whose payment the gateway refuses in passing is sent again, and one it refuses because the key or its wallet is spent ends the rows not yet started as `budget` errors. What a response does not report is in no spend of the run: on 2026-11-12 a key paid $2.14 in charges that no response named, beside $6.83 through its channel. So a run reads the key's usage (`GET /api/keys/me`) when it starts and when it ends, and `status` prints what the key was charged in between, through its channel and outside it, beside what the run recorded. Another run on the same key in those minutes is in that figure too. The gateway leases an E2B sandbox by the second at E2B's price, and runs commands in it as root. A run pays `--sandbox-lease-sec` (300) when it opens one, as much again whenever less than `--lease-sec` (60) of the lease is left while rows need the sandbox, and terminates it when they are done. E2B bills a renewal from the moment it is made, so each one pays the seconds that were left a second time: a longer lease loses less to renewals and more at the end. **On 2026-11-12 the gateway sold no renewal of an E2B sandbox**, so buy the lease whole: `--sandbox-lease-sec` for as long as the run needs its sandboxes, up to `--sandbox-timeout-sec`. Nothing is refunded for the part a run does not use, a sandbox that is refused its renewal takes no more rows and is used to the end of its lease, and rows still in flight then start again in a new sandbox. A `desktop` sandbox cost $0.46408 for 3,300 s, which is $0.506 an hour. Every request to the gateway's compute API is first sent without the key and answered with its price, which is checked against `--sandbox-budget-usd` and listed under `payments` in the run's status before the request goes again with the key. What the gateway then refuses is written back, so the spend counts what it answered. A `desktop` sandbox was quoted $0.04228 for 300 s, and a run that ended inside one lease recorded $0.0445 for its sandbox: the lease and the fees of its calls.

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

**What is recorded.** A plan charges nothing per response. Every response still passes the meter of the run: its tokens are in `agent/model-requests.jsonl` and in the usage of the attempt, and it carries no cost. The model spend of such a run is what each session estimates from its tokens at list prices, as it is for a key whose responses name no cost. It is a measure of use, not a charge, and it is what `--model-budget-usd` bounds.

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
NANOEVAL_E2E_MODEL=installed npm run e2e   # installed agents, with a scripted command in place of the vendor's
NANOEVAL_E2E_STORE=r2 npm run e2e          # blobs in R2 through the Worker
NANOEVAL_E2E_SCENARIO=judge npm run e2e    # final messages and a judge, with the scripted model
NANOEVAL_E2E_SCENARIO=failures npm run e2e # failure kinds and fixtures, then a rerun of what errored
NANOEVAL_E2E_BACKEND=dir NANOEVAL_E2E_SCENARIO=plan NANOEVAL_E2E_SLOTS=2 NANOEVAL_E2E_ATTEMPTS=1 npm run e2e  # a Claude plan signed in on the Worker pays, against a scripted Claude
NANOEVAL_E2E_SCENARIO=restart npm run e2e  # the Worker killed and restarted during the run
NANOEVAL_E2E_BACKEND=dir NANOEVAL_E2E_SCENARIO=midturn npm run e2e  # the Worker killed in a turn, which goes on; NANOEVAL_E2E_KILL=model or wait for the other two moments
NANOEVAL_E2E_SCENARIO=forgotten npm run e2e  # the session objects removed under a running row: it is claimed again
NANOEVAL_E2E_SCENARIO=runners npm run e2e  # two attached runners with separate caches
NANOEVAL_E2E_BACKEND=dir NANOEVAL_E2E_SCENARIO=standing npm run e2e  # a standing runner that two runs are handed to
NANOEVAL_E2E_BACKEND=dir NANOEVAL_E2E_SCENARIO=shared NANOEVAL_E2E_SLOTS=2 npm run e2e  # a standing runner with the rows of two runs in its slots
NANOEVAL_E2E_BACKEND=dir NANOEVAL_E2E_SCENARIO=stopped NANOEVAL_E2E_SLOTS=6 npm run e2e  # a standing runner stopped during a run, and another started
NANOEVAL_E2E_BACKEND=dir NANOEVAL_E2E_GATEWAY=1 NANOEVAL_E2E_SCENARIO=warm npm run e2e  # a leased sandbox kept for a second run, then ended by the pool
NANOEVAL_E2E_SCENARIO=lost NANOEVAL_E2E_LEASE_SEC=3 npm run e2e  # a runner killed: its rows are claimed again
NANOEVAL_E2E_SCENARIO=resume NANOEVAL_E2E_SLOTS=8 npm run e2e  # a runner killed and started again: it goes on
NANOEVAL_E2E_SCENARIO=gone npm run e2e     # a microVM killed under its verifier: the row is claimed again
NANOEVAL_E2E_SCENARIO=network npm run e2e  # what a private slot reaches and what reaches it
NANOEVAL_E2E_SCENARIO=closed npm run e2e   # tasks that close the network of the agent, the verifier or both
NANOEVAL_E2E_SCENARIO=cache npm run e2e    # a verifier that finds what an oracle run kept for it
NANOEVAL_E2E_SCENARIO=disks npm run e2e    # cached disks removed when no row needs them; also disk, packing
NANOEVAL_E2E_BACKEND=ns npm run e2e        # ns slots: as root on this machine, or inside a microVM guest without KVM
NANOEVAL_E2E_BACKEND=ns NANOEVAL_E2E_SCENARIO=network npm run e2e         # what a private ns slot reaches
NANOEVAL_E2E_BACKEND=ns NANOEVAL_E2E_MODEL=installed npm run e2e          # installed agents on ns slots; also NANOEVAL_E2E_SCENARIO=cache
NANOEVAL_E2E_MODEL=installed NANOEVAL_E2E_SCENARIO=closed npm run e2e     # an installed agent whose task closes its network
NANOEVAL_E2E_BACKEND=ns NANOEVAL_E2E_MODEL=oracle NANOEVAL_E2E_RUNTIME=1 npm run e2e   # the runner from its archive
NANOEVAL_E2E_GATEWAY=1 npm run e2e         # models and the run's sandbox through a scripted gateway, with one key
NANOEVAL_E2E_GATEWAY=1 NANOEVAL_E2E_MODEL=installed npm run e2e          # installed agents through it; both also on dir and ns slots
NANOEVAL_E2E_GATEWAY=1 NANOEVAL_E2E_BACKEND=ns NANOEVAL_E2E_MODEL=oracle NANOEVAL_E2E_RUNTIME=1 NANOEVAL_E2E_STORE=r2 npm run e2e   # a leased sandbox that starts its runner from the archive
NANOEVAL_E2E_GATEWAY=1 NANOEVAL_E2E_SCENARIO=fleet NANOEVAL_E2E_SLOTS=1 npm run e2e   # two leased sandboxes, one of which dies during the run
NANOEVAL_E2E_GATEWAY=1 NANOEVAL_E2E_SCENARIO=lapse NANOEVAL_E2E_SANDBOX_LEASE_SEC=8 NANOEVAL_E2E_SLOTS=1 NANOEVAL_E2E_ATTEMPTS=4 npm run e2e   # a gateway that sells no renewal: sandboxes end with their lease and are replaced
NANOEVAL_E2E_MODEL=anthropic npm run e2e   # a real model with ANTHROPIC_API_KEY
NANOEVAL_E2E_MODEL=codex-plan npm run e2e  # a real model on the ChatGPT plan of ~/.codex/auth.json
(cd krun && cargo clippy --all-targets -- -D warnings && cargo test)   # the launcher and its image converter
python scripts/harbor-check.py output/job  # with Harbor's Python: load an exported job with Harbor's models
```

The scripted model answers the harness with fixed tool calls, so the end-to-end test needs no API key. It still imports a real eval and runs the real Worker, the real nanocode-ts harness, a real runner, the released hand and the real verifiers.

CI runs these on a GitHub-hosted runner, which has no libkrunfw: the `krun` lanes, the converter's test and the launcher's integration tests skip there, and only the directory lanes run, so no hosted lane isolates an attempt or converts an image. The `ns` lanes skip there too: the test is not root, and the guest it would boot needs KVM. The workflow has not run on GitHub since the eval table and the converter landed. Every step of it was run on a Linux machine with KVM instead, see [DECISIONS.md](DECISIONS.md).

## Layout

| Path | Holds |
| --- | --- |
| `worker/` | The Worker: routes, the `Evals`, `Run`, `Pool` and `PlanVault` objects, the R2 blob routes, the harness sessions |
| `src/` | Host-agnostic modules: the eval row and its versions, the run ledger, the runner protocol, tasks, results, admission, budget, providers |
| `sandbox/` | `Runner.ts`, the task runner, and `Main.ts`, its entry when it is bundled into one file. `slot.sh`, one attempt in one slot. `Store.ts`, the blob store and the cache. `Converter.ts`, where an environment becomes a disk through the launcher. `Prune.ts`, what can go from the layer cache and from a directory store. `Sandboxd.ts`, the local sandbox daemon |
| `krun/` | The Rust workspace: the libkrun binding, the launcher and the guest binary of the krun backend, the image converter (`nanoeval-krun image`), and `nanoeval-net`, the relay of a private slot |
| `cli/` | The `nanoeval` command, the import pipeline, and `Runtime.ts`, which builds the archive a remote sandbox starts its runner from |
| `datasets/` | The dataset adapters, and the graders they write into tasks |
| `scripts/` | `install-linux.sh`, the E2B price quote, and `harbor-check.py`, which loads an exported job with Harbor's own models |
| `tasks/` | Three small Harbor tasks from gakonst/nanoeval |
| `test/` | Unit tests, the end-to-end test and its failure fixtures, and `Guest.ts`, the microVM guest that ns lanes run in on a machine without root, and `MockGateway.ts`, the scripted gateway of the gateway lanes |

## License

[MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
