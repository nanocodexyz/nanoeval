# Design

nanoeval runs coding-agent evaluations with the agent harness outside the task sandbox. An eval is imported once into a durable table of normalized tasks. A run is a table of rows, one per task, agent and attempt, against one version of that table. Individual task runners on sandbox hosts claim rows and run each in a microVM of its own, behind a nanocode hand that dials the row's harness session in a Cloudflare Worker on [nanocode-ts](https://github.com/nanocodexyz/nanocode-ts).

It revives two earlier bodies of work:

- [gakonst/nanoeval](https://github.com/gakonst/nanoeval) (Rust, July 2026, last commit `10aed6b`): a library-first evaluator that kept the Nanocodex harness on the host and ran each attempt's tools in a disposable libkrun microVM.
- The eval stack in nanocode's history (`harbor_adapter/`, then `crates/experimental/nanocodex-eval` and `crates/nanocodex-vm`), removed from the tree in `2d4a4c539` (2026-10-13): dataset adapters that converted benchmarks into its own task packages once, a SQLite workset with one row per task, treatment and repetition, a coordinator whose workers claimed rows, and attempt roots that were a copy-on-write disk over a prepared image disk.

The shape of the second is the shape here: import once, a durable table, runners that claim rows, a copy-on-write disk per attempt. [Reused](#reused) says what came from where.

## Shape

```
 nanoeval import ─ adapter ─ normalize ─ convert ──▶ blob store (SHA-256)   directory | R2 through the Worker
                                            │        instruction, tests, solution, environment disk
                                            ▼
 nanoeval CLI ──HTTP──▶ Worker ──▶ Evals (Durable Object, one per eval)
                          │          table of tasks, immutable versions named by a digest
                          │
                          ├──▶ Run (Durable Object, one per run)
                          │      rows task × agent × attempt of one eval version
                          │      claims and leases, budgets, artifacts, results, lineage
                          │          ▲ claim, heartbeat, session, turn, judge, artifacts, finish
                          │          │
                          │      runner (one per sandbox host, started through the provider or attached)
                          │          admission by its own slots, memory and disk
                          │          blob cache by digest ─▶ slot.sh ─▶ microVM: disk + copy-on-write disk
                          │                                               │
                          └──▶ AgentSession (Durable Object, one per claim) ◀── hand (WebSocket, dialed from the slot)
                                 nanocode-ts harness: model calls, Code Mode, journal
```

| Piece | Where | Role |
| --- | --- | --- |
| `worker/index.ts` | Worker | Routes `/v1/evals`, `/v1/blobs` and `/v1/runs`, and `/sessions` to nanocode-ts |
| `worker/Evals.ts`, `src/Eval.ts` | Durable Object | One eval: its tasks and its versions |
| `worker/Blobs.ts` | Worker | The R2 side of the blob store |
| `worker/Run.ts`, `src/Ledger.ts` | Durable Object | One run: rows, claims, leases, sessions, budgets, results. The ledger is plain SQL over an interface, so it is unit tested without workerd |
| `src/Installed.ts`, `src/Proxy.ts`, `worker/Model.ts` | Worker and sandbox host | [Installed agents](#installed-agents): a vendor's command line inside the slot, and the endpoint of the run that its model requests go through |
| `worker/Sessions.ts` | Durable Object | `App.create` from `nanocode-ts/cloudflare`: one harness session per claim, model requests forwarded with the deployment's API key or plan login |
| `sandbox/Runner.ts` | Sandbox host | A task runner: claims rows, fetches blobs, drives `slot.sh`, reports to the run |
| `sandbox/slot.sh` | Sandbox host | One attempt in one slot: environment up, hand, solution, verifier, down |
| `sandbox/Main.ts`, `cli/Runtime.ts`, `src/Bootstrap.ts` | Sandbox host and CLI | The runner as one bundled file, the archive a remote sandbox starts it from, and the script that does |
| `sandbox/Store.ts` | Node | The blob store: a directory, or R2 through the Worker, and the verified cache of a machine |
| `sandbox/Converter.ts` | Node | Where a task environment becomes a disk, and where a disk is packed and unpacked: three commands of the launcher in `krun/` |
| `sandbox/Sandboxd.ts` | Any machine | The local provider's daemon: makes one machine a sandbox host |
| `src/Sandbox.ts`, `src/Local.ts`, `src/E2b.ts` | Worker | The provider contract and its two providers |
| `src/Payment.ts`, `src/Budget.ts` | Worker | MPP charges through mppx, refused past the run's budget, recorded in the ledger |
| `src/Task.ts`, `src/Atif.ts`, `src/Harbor.ts`, `src/Result.ts`, `src/Verdict.ts` | Worker and CLI | Harbor task loading, ATIF-v1.7 trajectories, Harbor job export, outcomes, and what a verifier's facts mean |
| `src/Judge.ts` | Worker | The judge request a verifier writes and the answer it reads |
| `src/Compare.ts` | CLI | The table of `nanoeval compare`: the agents of one or more runs side by side |
| `datasets/` | Node | The dataset adapters behind `nanoeval import` |
| `cli/nanoeval.ts`, `cli/Import.ts`, `cli/Plan.ts` | Node | Import, run, read status and artifacts, serve `sandboxd`, attach a runner, start the Worker under local workerd with its credentials |

## Harness outside the sandbox

The harness is a nanocode-ts session in a Durable Object. The sandbox holds only the task environment and a hand. A hand is the nanocode process that runs an agent's Code Mode cells and tools on a machine, while inference, subagents and durability stay with the brain. The released `nanocode hand <url> --token <token>` binary dials the session's `/sessions/<name>/hands` WebSocket with a token that the session mints (`nch_…`), so the sandbox needs no inbound port.

This is the placement that `HARNESS_PLACEMENT.md` in gakonst/nanoeval argued for: model credentials and the authoritative event journal never enter the untrusted task environment, a lost sandbox is an environment error instead of a lost harness, and no agent CLI, Node runtime or CA bundle is installed into task images. In July 2026 this needed a custom guest (`nanocodex-vm-guest`) and a typed RPC over a virtio console. Today the hand protocol is that boundary, and nanoeval uses it unchanged.

An [installed agent](#installed-agents) is the one exception: a vendor's command line inside the slot, for comparing nanocode with it. Its model credential stays outside as well.

A runner is on the host side of that boundary, like the orchestrator: it is nanoeval's own process on the sandbox host, outside every guest. It holds a token that is good for the runner routes of one run and nothing else, and no model credential.

## Evals

An eval is what a run runs against: a named table of tasks in one common format, with every file it needs stored by content.

```
 nanoeval import DATASET | --task DIR...
   datasets/<Adapter>.ts     the pinned source becomes task packages (unchanged, see Datasets)
   cli/Import.ts             one package becomes one row:
                               instruction.md          ─▶ blob
                               tests/                  ─▶ blob (a tar archive)
                               solution/               ─▶ blob (a tar archive), kept apart
                               environment             ─▶ sandbox/Converter.ts ─▶ ext4 disk ─▶ packed ─▶ blob
   sandbox/Store.ts          every blob is stored under its SHA-256
   POST /v1/evals/NAME       the rows become a version of the eval
```

**The row.** `src/Eval.ts` defines it. A task row holds its id, its name, the Harbor package checksum, its resources (`cpus`, `memoryMb`, `storageMb`), its timeouts, whether it allows the internet, its environment and verifier variables, the verifier's flags, and four blobs by digest and size: the instruction, the tests archive, the solution archive when the package has one, and the environment. A `disk` environment is the packed ext4 disk a microVM boots, with the image's metadata beside it in the row: environment, working directory, user, entrypoint and command, architecture, and the digest of the image it came from. A `dir` environment is an archive of files for the directory backend. Nothing in a row is pulled or built at run time.

**Versions.** The table lives in the SQLite of an `Evals` Durable Object, one per eval name. A version is a set of rows, named by the SHA-256 of the canonical JSON of its dataset, its pinned source and the digest of every row. A version is never changed. Importing more tasks makes a new version that holds the earlier rows with the new ones laid over them by id, and names the earlier version as its parent. Importing the same rows again finds the same digest and changes nothing. An eval holds one dataset from one source. A run names its eval as `NAME@DIGEST`, the Run object resolves a bare name to the latest version when the run is created, and the run's status, results and Harbor export carry the digest. `nanoeval evals` lists the evals and `nanoeval eval NAME[@DIGEST]` shows the versions and tasks of one.

**The blob store.** One interface, `has`, `put` and `fetch` by SHA-256, with two implementations in `sandbox/Store.ts`:

| Store | Where blobs live | For |
| --- | --- | --- |
| Directory | `<root>/sha256/<aa>/<digest>` on a machine, read-only files, linked instead of copied on one filesystem | The local provider. A disk of several GB never passes through a Worker request and is not held twice |
| R2 through the Worker | The `BLOBS` bucket. Blobs up to 64 MiB are one request that R2 checks against the digest, larger ones are multipart uploads in 64 MiB parts | A deployed Worker and sandboxes on other machines. A runner reads a blob through its run, which serves only digests that its rows name |

A reader never trusts a store. A runner fetches a blob into the cache of its machine, hashes it, and keeps it only when the digest matches, so a blob is verified once per machine whichever store it came from. A blob that is missing or does not match ends the attempt as an `environment` error without a retry.

**Solutions.** A solution archive is a blob of its own. The Run object drops the solution from every row of a run that has a model agent before it stores them, so a runner of such a run is never told the digest, and the run's blob route refuses a digest that its rows do not name. Only an oracle run keeps it.

**Local task directories.** `nanoeval run --task DIR` imports the directories into the eval named `local` and runs that version with only those tasks, so there is one path into a run.

## Environment conversion

A task's environment is converted when it is imported, once, and never at run time. `sandbox/Converter.ts` is the one place that knows how:

```ts
type Converter = {
  format: string
  name: string
  convert(environment: { context?: string; image?: string; storageMb: number }, disk: string): Promise<Eval.Meta>
  pack(disk: string, file: string): Promise<void>
  unpack(file: string, disk: string): Promise<void>
}
```

It runs the launcher of the microVM backend and nothing else:

| Call | Command | Result |
| --- | --- | --- |
| `convert` | `nanoeval-krun image build (--ref IMAGE \| --dockerfile DIR) --size-mb STORAGE_MB --cache LAYERS` | An ext4 disk of the task's `storage_mb` that holds the image's layers, and the image's configuration, which becomes the row's metadata |
| `pack` | `nanoeval-krun image pack` | The non-zero blocks of the disk through zstd: the blob an eval stores, named by its SHA-256 |
| `unpack` | `nanoeval-krun image unpack` | The sparse disk again, in a runner's cache. A disk that is already there is kept, so runners that share a cache unpack it once |

[Image disks](#image-disks) describes the three commands. No container engine takes part, at import or at run time: the launcher reads an image from its registry over HTTPS, or runs the steps of a Dockerfile in a builder microVM, and the kernel of that microVM writes the disk.

**What a row records.** The digest and size of the packed disk, which is what a runner fetches and boots. The packed form, `nkrdisk1`: a runner refuses a row whose form is not the one its converter unpacks, so an eval imported with an earlier form is imported again. The metadata from the image's configuration: architecture, environment, working directory, user, entrypoint, command, and the digest of the platform manifest the disk was made from. The import adds the default `PATH` when the image sets none, so a row says exactly what a guest starts with. And `source`, the image reference or a digest of the build context.

**Once per source.** The import keeps a record of each conversion under its inputs (converter, source and size), so the 198 GPQA tasks that share one image convert it once, and importing again converts nothing. The layers, configs and manifests read from a registry are kept by digest in the layer cache, `--layers` (`NANOEVAL_LAYERS`, `oci` under the cache by default). It is host policy, like the blob store, and a second import of a dataset downloads no layer.

**A Dockerfile on a restricted network.** A `RUN` step runs in the builder microVM on a private network, like a slot, and gets the host policy a slot gets: `image build --ca-bundle FILE`, `--env-file FILE` and `--forward ADDRESS:PORT`, which `nanoeval import` passes from `--ca-bundle`, `--slot-env` and `--slot-forward` or from `NANOEVAL_CA_BUNDLE`, `NANOEVAL_SLOT_ENV` and `NANOEVAL_SLOT_FORWARD`, the variables the installed command reads. So a step that installs with pip or npm builds on a machine whose network re-signs TLS or keeps registries behind a proxy on its loopback. The policy belongs to the machine and not to the environment, and none of it reaches the disk or the row, see [Image disks](#image-disks). A task that names an image needs none of it: the launcher reads registries with the machine's own bundle (`SSL_CERT_FILE` or the system one). What a registry behind such a proxy served is what the disk holds, as it is for a slot that installs through it.

## What a machine needs

| Machine | Needs |
| --- | --- |
| Every one | Linux, Node 24, this checkout after `npm ci`, and bash with coreutils, tar and curl |
| One that imports `krun` evals, or runs `krun` slots | x86_64 or aarch64 with `/dev/kvm` readable and writable by the user. [libkrunfw](https://github.com/containers/libkrunfw) 5 where the dynamic loader finds `libkrunfw.so.5`. `mke2fs` from e2fsprogs. The launcher: cargo builds it from `krun/` when it is first needed, which takes a Rust toolchain through rustup with the musl target, or `NANOEVAL_KRUN` names a directory with a built `nanoeval-krun`, `nanoeval-krun-guest` and `nanoeval-net` |
| One whose slots are on a private network, or that imports a Dockerfile with a `RUN` step | [passt](https://passt.top) as a system package |
| One that runs `ns` slots | Root. A kernel with overlayfs, loop devices and namespaces. `unshare`, `setpriv`, `mount`, `losetup`, `mountpoint` (util-linux), `chroot` and `env --default-signal` (coreutils 8.31 or later), `mke2fs`, `pgrep`. cgroup v2 with the memory controller for limits. `ip` and `nft` and a resolver that is not on the loopback for the private network. The launcher as for krun, without KVM or libkrunfw. Debian 12 and Ubuntu 22.04 sandboxes of E2B have all of it |
| One that runs `dir` slots only | Nothing more. No isolation |
| The Worker under local workerd | Nothing more: wrangler comes with `npm ci` |

No machine needs a container engine, an image store or a user namespace, and only ns slots need root. `git grep -i docker` finds Harbor's field `docker_image`, the `Dockerfile` a task may ship and the launcher reads, and what [DECISIONS.md](DECISIONS.md) recorded when one was used.

## Runs

A run is `tasks × agents × attempts` of one eval version. Each attempt is one row in the SQLite of its `Run` Durable Object, written when the run is created, and moves through these phases:

| Phase | Entered when | Who acts |
| --- | --- | --- |
| `unclaimed` | The run is created, or a claim is lost | Waits for a runner with room |
| `claimed` | A runner claims the row | The runner fetches the row's blobs and boots the environment. The row has a lease, a claim token and a session name of its own |
| `attach` | The environment is ready | The run mints a hand token, and the runner starts the hand inside the slot |
| `run` | The hand is listed | The run submits the instruction as one turn on that hand, under `agent.timeout_sec`. In an oracle run the runner starts the solution instead |
| `verify` | The turn completed, or its deadline passed and it was cancelled | The runner stops the hand, copies `tests/` in only now, and runs `tests/test.sh` under `verifier.timeout_sec` |
| `judge` | The verifier wrote a judge request and no reward | The run answers each prompt in a session of its own. The runner writes the answers as a verifier input and verifies once more |
| `done` | The verifier reported, or a failure ended the attempt | The run stores events, trajectory and result, and deletes the session. The runner takes the slot down |

Every attempt ends as `passed`, `failed` or `errored`, with the verifier reward kept beside it. A failure carries a kind: `agent`, `agent_timeout`, `verifier`, `verifier_timeout`, `environment`, `budget`, `cancelled` or `internal`. An agent timeout keeps its verifier reward, as Harbor does, unless the verifier itself failed. Every other failure is an error with no reward, so an infrastructure failure never becomes a score of zero.

**Claims.** A runner asks for rows with what its machine has free: slots and memory. The run answers first-fit in row order, so one 8 GiB task does not hold back the 2 GiB tasks behind it, and writes for each row a claim: a random token, the runner, a lease that ends `--lease-sec` later, and a session name that no earlier claim used. Every later call of the runner for that row carries the token and extends the lease, and so does its heartbeat. A call whose token is not the row's current one is refused with `410`, and the runner drops that slot. The run decides what the facts mean: a runner reports the verifier's exit code, reward, files and killed processes, and `src/Verdict.ts` turns them into a score or a failure, the same way for every runner.

**A lost runner.** When a lease ends without a call, the run cancels the row's turn, records the model usage of that session against the budget, deletes the session, ends the claim as `expired` and makes the row `unclaimed` again. The next claim starts from an empty environment and a new session, so nothing of the lost claim is replayed and it cannot score: a row is finished only by the holder of its current token, once. A row is claimed at most `--claims` times (3 by default). After the last loss it ends as an `environment` error that names the losses. A failure that a live runner reports, such as an environment that did not boot, is final: only a lost lease puts a row back. The claims of a row are kept in order with their runner, phase and ending, and `nanoeval attempt` shows them.

**Rerun lineage.** `nanoeval run --rerun RUN` makes a run with one row for each attempt of `RUN` that did not pass (`--failed` and `--errored` narrow it), on the same eval version and agents. Each row keeps the run and attempt it retries, its result carries them as `retryOf`, and the earlier run lists the runs that rerun it. Results of the earlier run are never changed.

**Admission** belongs to the runner, since only the machine knows what it has. A runner counts each attempt's declared memory against its limit (80% of the machine by default, `--memory-mb` otherwise) and offers its free slots. With `--free-disk-mb` it offers a slot only while the filesystems of its slots and its cache have that much free, and only while no other attempt of it is preparing its environment, so each claim sees what the previous disk took. The floor is reactive: what running attempts write later is not reserved, because the only declared figure, `storage_mb`, is the size of the machine a task asks for and not what it uses. When every runner of a run reports that it is idle for want of disk for `--setup-sec`, the rows that still wait end as `environment` errors.

**The orchestrator** creates the rows, answers claims, enforces the model and sandbox budgets, holds the sessions, and starts and stops runners through the sandbox provider: it opens a sandbox while rows wait and no runner has room, up to `--sandboxes`, and closes one when no row waits and its runner holds none. Its alarm (`TICK_MS`) no longer drives attempts. It expires leases, watches runners and sandboxes, and ends the run. A restarted Durable Object continues from the ledger, and runners retry their calls until it answers.

**A verifier that did not run its tests.** A Harbor verifier conventionally writes a CTRF report to `/logs/verifier/ctrf.json` and derives the reward from its test runner's exit code, so a verifier that cannot install the runner writes reward 0. nanoeval takes the report as the sign that tests ran: when `tests/test.sh` names `ctrf.json`, a reward other than 1 without that file is a `verifier` error. It reads no installer output and knows no benchmark. It does not cover a verifier that names no report, one whose runner starts and then fails to import a missing dependency, or a solution that could not install its own dependencies.

**Memory.** After the verifier a slot counts the processes of the attempt that the kernel killed for memory, from the kernel log of its microVM. The attempt carries the count as `oomKills`. It does not change the score: a task's memory is part of the task.

## Runners

A runner is one Node process on a sandbox host, `nanoeval runner`. A run starts one in each sandbox it opens, through the provider's `exec`, with a file that holds the run's address and runner token. `nanoeval runner --url URL --run RUN` attaches one more from any machine that reaches the Worker, and `--sandboxes 0` makes a run wait for attached runners only. Several runners on several machines work one run: each claims what it has room for, and the ledger is the only thing they share.

```
 start      slot.sh setup (hand, launcher, network), probe ─▶ hello with the machine's capabilities
 loop       claim rows up to free slots and memory
            per row:  blobs by digest from the cache, the directory store or the run
                      disk kind: unpack once per machine into <cache>/disks/<digest>.ext4
                      slot.sh up ─▶ session and hand token from the run ─▶ slot.sh hand
                      wait for the turn, or run the solution ─▶ slot.sh verify ─▶ judge round if asked
                      artifacts and the verifier's facts to the run ─▶ slot.sh down
            heartbeat every third of the lease
 end        the run says every row is done ─▶ leave
```

- **It picks the backend its machine has.** A run asks for `auto` unless `--backend` names one: a runner then boots disks in microVMs (`krun`) where `/dev/kvm` opens for it, and in namespaces (`ns`) where it is root. Both boot the same disk, so runners of both kinds work one run. The backend a runner took is in its capabilities, and in each result it finished. `nanoeval runner --backend` names one for that runner.
- **It drives `slot.sh` and does not replace it.** The slot functions of the microVM backend were kept instead of being folded into the runner. A phase of a slot runs detached and leaves a status file, so the microVM, the hand and a running verifier outlive the runner. A runner that is restarted in the same directory reads each slot's saved row and goes on from the phase it was in, with the same runner id and claims. It tells the run which rows it still holds, and the run puts back at once any other row that the ledger gave it, such as one it claimed and had not saved when it died. The calls of a row can be repeated in any phase after the one they belong to, so a runner that is a step behind the ledger catches up instead of failing. The runner reads those status files itself every 25 ms, where the orchestrator used to ask for them through the provider once per tick.
- **Calls that wait on the Worker back off** from 25 ms to `--poll-ms` (250 ms by default): the hand's attach, the turn and the judge. A deployed Worker wants a larger value, since each poll is a request.
- **The cache of a machine** is `$NANOEVAL_CACHE` (`~/.cache/nanoeval`): `blobs/<digest>` for verified blobs and `disks/<digest>.ext4` for unpacked disks with their metadata. A microVM holds a shared lock on its disk while it runs. With `--disks remove` a runner deletes the packed blob as soon as its disk is unpacked, and removes a disk that it unpacked for this run when the run says no other row needs it. A disk that was in the cache before is kept. `nanoeval prune` removes every cached disk that no microVM holds, every cached blob and every [verifier cache](#verifier-cache).
- **A stopped runner** (SIGTERM) releases its rows, which makes them claimable at once, and takes its slots down. A killed one is found by its leases.
- **Host policy stays with the host**: `--ca-bundle`, `--slot-env` and `--slot-forward` are options of `sandboxd` or of an attached runner, and the capabilities a runner reports record them.

## A runner without a checkout

A sandbox of a public template has no checkout, no launcher and no Node that runs TypeScript. A run made with `--runtime`, which `--provider e2b` implies, publishes the runner as one blob and starts it from that.

```
 nanoeval run --runtime         cli/Runtime.ts builds runtime.tgz and uploads it to the Worker's blob store
   runner.mjs                     sandbox/Main.ts and the runner, one file, for Node 20 and later (esbuild)
   slot.sh
   krun/nanoeval-krun             static, built without libkrun: exec, copy, image unpack
   krun/nanoeval-krun-guest       static: the agent of a slot
   krun/nanoeval-net              static: the relay
   nanocode                       the pinned hand, checked against its release checksum when the archive is built
 the run, or nanoeval sandbox   writes runner.json and bootstrap.sh into the sandbox and runs the script
 bootstrap.sh                   fetch GET /v1/runs/RUN/runner/blobs/DIGEST with the runner token, check its SHA-256,
                                unpack under <cache>/runtime/DIGEST, find node >= 20 or fetch Node 24 by checksum,
                                start runner.mjs as root with NANOEVAL_KRUN, NANOEVAL_NANOCODE and NANOEVAL_CACHE
```

The archive is 20 MB and is named by its digest like every blob, so the run's blob route serves it beside the blobs its rows name, and a sandbox that already unpacked that digest fetches nothing. The script is generated in `src/Bootstrap.ts` from the run's address, id and runner token, and holds no other secret. Everything a slot needs after that is in the archive: no registry, package index or release page is asked at run time, with two exceptions: nodejs.org when the template has no Node, and the pinned release of an [installed agent](#installed-agents) when a row names one. The launcher of the archive starts no microVM, so its runner runs ns slots: installed agents and the verifier cache work there, and a task that closes a phase is refused, see [Closed phases](#slot-networks).

**Blobs through the Worker.** A runner fetches its disks from the run's blob route, which reads R2. A `GET` may name `Range: bytes=N-`, and a download that breaks is requested again from the bytes the runner has, up to six times a second apart and doubling, then checked against its digest like any blob.

## The slot splitter

`sandbox/slot.sh` runs one attempt in one slot, and packs N of them onto a machine. A runner calls it. `probe` reports what the machine can isolate with (`kvm`, `krun`, `ns`, `cgroup`, `userns`, `bwrap`, CPUs, memory) and which backend and network it was set up for. `kvm` says that `/dev/kvm` can be opened for reading and writing, `krun` that the installed launcher reached KVM and loaded libkrunfw, `ns` that the machine has root and the tools of an ns slot, and `cgroup` that ns slots are limited.

| Backend | Isolation | State |
| --- | --- | --- |
| `krun` | One libkrun microVM per slot, as in gakonst/nanoeval and `crates/nanocodex-vm`. The environment disk is the root filesystem under a copy-on-write disk of the slot, the task's CPUs, memory and storage size the machine, and the hand runs inside it. Needs `/dev/kvm` and libkrunfw | Implemented, tested |
| `dir` | One directory per slot, no isolation, from a `dir` environment. For development, and for the end-to-end lanes of a machine without KVM | Implemented, tested |
| `ns` | One set of namespaces per slot over the same environment disk, as root, for machines without KVM such as remote sandboxes. The kernel is shared, see [ns slots](#ns-slots) | Implemented, tested in a guest without KVM and on E2B |

There is no container backend: an environment is a disk, and a container engine does not boot one. The directory backend stays because it costs one branch per phase and lets every lane of the eval table, the claims and the runners run where no microVM can.

**Users.** A slot removes and copies `/tests` and `/solution` and creates `/logs/verifier` as root, and leaves that directory writable by anyone. The hand, the solution and the verifier run as the user of the image.

The hand binary is a glibc build. `slot.sh setup` downloads the pinned release, checks its SHA-256, and copies the binary with its loader and libraries into one read-only directory. Each microVM mounts it and starts the hand through that loader, so the hand runs in musl images such as Alpine without a change to the task image.

An E2B sandbox is itself a Firecracker microVM and exposes no KVM to its guest. It has root, so it runs ns slots. See [Sandbox providers](#sandbox-providers).

## krun slots

A krun slot is one libkrun microVM. In gakonst/nanoeval the harness stayed on the host and a guest binary served four tools to it over a virtio console. Here the guest runs the released hand, which dials the attempt's session itself, so the tool proxy is gone and the guest binary only assembles the root filesystem and starts commands.

```
 host                                                    microVM, one per slot
 slot.sh ─ nanoeval-krun vm ─ libkrun ─────────────────▶ libkrun init (PID 1)
             vda  <digest>.ext4, read-only, one per disk  └ nanoeval-krun-guest
             vdb  upper.ext4, sparse, one per slot            overlay(vda, vdb) becomes /
             virtiofs rt, read-only: the hand, CA bundle      rt mounted at /opt/nanoeval
             virtiofs io: tests in, verifier logs out         vsock port 1024
             virtio-net on a passt process of its own         eth0, when the network is private
 slot.sh ─ nanoeval-krun exec ─ vm.sock ─ vsock ───────▶ hand, solution, verifier
```

| Piece | Runs | Role |
| --- | --- | --- |
| `krun/nanovm` | Host | The libkrun binding: one VM's disks, shares, vsock ports and command |
| `krun/host`, `nanoeval-krun` | Host | `vm` is the VMM process of one microVM, with the gate of a slot that closes a phase. `exec`, `copy-in`, `copy-out`, `stop` and `ready` talk to a guest. `check` says whether this machine can start one. `image` makes the disk of a task environment, see [Image disks](#image-disks) |
| `krun/guest`, `nanoeval-krun-guest` | Guest | A static musl binary. Mounts the disks, pivots into the overlay, then serves requests on a vsock port. In build mode it keeps the disk at `/mnt/root` and applies layers and Dockerfile steps to it |
| `krun/wire` | Both | The request and frame encoding of that port, and the address plan of a private guest |
| `krun/net`, `nanoeval-net` | Host and slot | The relay of a private slot, on both sides. A static binary, which the guest and the launcher use as a library |

**Root filesystem.** The environment disk of the row is the root, unpacked once per machine into the runner's cache under the digest of its blob, beside the image's environment, working directory and user from the row. Nothing is pulled or built when a slot comes up. Every slot attaches the disk read-only and adds a sparse ext4 of its own, of the task's `storage_mb`, as the upper layer of an overlay that the guest mounts, so what an attempt writes never reaches the disk or another attempt. Taking a slot down deletes that file. The disk was written by a kernel when it was converted, so owners, modes, devices and links are real, with no root and no fakeroot on the host.

**Commands.** libkrun's init stays PID 1 and reaps. The guest binary listens on a vsock port that libkrun maps to a UNIX socket in the slot directory. `nanoeval-krun exec` sends a command with its environment, user and working directory, streams output, and returns the exit code. The guest leaves the session of the console once it has booted, so a command has no controlling terminal: a program that asks `/dev/tty` for a password fails instead of stopping. A closed connection sends SIGTERM to that command, which is how a hand is stopped and how a timeout ends a solution or a verifier. `tests/` and `solution/` reach the guest through the `io` share only in their own phase and are copied into the root, so the agent never sees them and they are ordinary files when they run.

**Resources.** vCPUs are the task's `cpus` rounded up, memory is `memory_mb`, and the root can grow to `storage_mb`. A runner counts a slot's declared memory. An idle guest costs the host far less, since libkrun backs guest memory on demand. The VMM raises its limit on open files to the hard limit: a share keeps a descriptor on the host for every file its guest has looked up, and a tree of more than about a thousand files did not copy under the usual soft limit of 1024.

**Network.** A krun slot has a private network by default, described under [Slot networks](#slot-networks). With `--network host` it uses libkrun's TSI instead: the VMM makes the guest's sockets on the host, and a connection to `127.0.0.1` that nothing in the guest listens on reaches the host's loopback. The limits of TSI are why it is not the default:

- A listener in the guest is also bound on the host, with `SO_REUSEPORT`. Two guests may listen on one port, and each reaches its own listener first, but a guest or the host with no listener of its own on that port reaches another guest's.
- A guest cannot serve on a port the host keeps for root: a listener on port 80 did not come up, since the VMM is not root.
- Some socket options do not hold: a gRPC client fails with "Failed to set SO_REUSEADDR". ICMP and raw sockets do not exist.
- A connected UDP socket to a loopback address stays in the guest, so a resolver on the host's loopback is reached with `options use-vc`.

**What a guest gets that its image lacks.** `/opt/nanoeval` with the hand and the certificate bundle. `/etc/resolv.conf` and `/etc/hosts`, written at boot over what the image has, on the slot's own disk. Nothing else: no agent, no shell, no init system.

## ns slots

An ns slot is the same environment disk without a microVM, for a machine that has root and no KVM, which is what a remote sandbox such as E2B's is. `slot.sh` prepares the root with the machine's own tools, and the guest agent of a krun slot serves it, so every phase after `up` is the code of a krun slot.

```
 machine (root)                                             slot: mount, PID, IPC, UTS, cgroup and network namespaces
 <digest>.ext4 ─ loop, read-only, mounted once ─ lowerdir ┐
 upper.ext4 ─ loop, sparse, one per slot ─ upperdir ──────┴▶ overlay becomes /
 rt, read-only bind: the hand, CA bundle ─────────────────▶ /opt/nanoeval
 ctl, bind: vm.sock, relay.sock, io/ ─────────────────────▶ /.nanoeval, mode 700
 cgroup nanoeval/<slot>: memory.max, cpu.max ─────────────▶ every process of the slot
 nevN ─ veth, a /30, masquerade ──────────────────────────▶ eth0, when the network is private
 slot.sh ─ nanoeval-krun exec ─ ctl/vm.sock ──────────────▶ nanoeval-krun-guest ns (PID 1) ─ ns-serve ─ hand, solution, verifier
```

| Step of `up` | Done by |
| --- | --- |
| Mount the cached disk read-only at `<digest>.mnt`, once per machine, under a lock | `mount -o loop,ro` |
| Format the slot's upper disk at the task's `storage_mb` | `mke2fs`, as for a krun slot |
| Make the slot's cgroup and write the task's memory and CPUs | cgroup v2, when the machine has the memory controller |
| Start a shell in new namespaces, inside that cgroup | `unshare --mount --pid --ipc --uts --cgroup [--net] --fork --kill-child` |
| Mount the upper disk, the overlay, `/proc`, a read-only `/sys`, a `/dev` of six devices with its own `devpts` and `shm`, the runtime and the control directory | `mount`, in the slot's mount namespace, so everything goes when the slot does |
| Link the slot to the machine and give it its address and route | `ip`, when the network is private |
| Move the root over `/`, reset every signal to its default, bound the capabilities, change root, start the agent | `mount --move`, `env --default-signal`, `setpriv --bounding-set`, `chroot` |

**The agent.** `nanoeval-krun-guest ns` stays PID 1 of the slot and reaps, and starts itself again as `ns-serve`, which listens on `/.nanoeval/vm.sock`. A request, an exec with its environment, user and working directory, a copy of `tests/` from `/.nanoeval/io`, a relay through `/.nanoeval/relay.sock`: all are what a krun slot does over vsock and virtiofs. The launcher on the machine side is the same client, built without libkrun (`--no-default-features`) and linked statically, so it runs where libkrunfw is not installed. Killing the `unshare` process kills PID 1, and the kernel ends every process, mount and link of the slot.

**What a slot may do.** Root in a slot is the machine's root with a bounded capability set: Docker's default without `CAP_MKNOD`. It cannot mount, make a device node, load a module, trace a process outside its PID namespace or write `/proc/sys`, which is read-only with `/proc/bus`, `/proc/fs`, `/proc/irq` and `/proc/sysrq-trigger`. `/proc/kcore`, `/proc/keys` and the timer and scheduler lists are masked. The old root stays mounted under the new one, where no path reaches it. The control directory is root-only: the agent's socket gives root in the slot nothing it does not have, the relay dials only what the slot's allow list holds, and `io/` is empty except while tests are copied in.

**What it is not.** A slot shares the machine's kernel. A kernel bug that a microVM would contain reaches the machine, `nproc` shows the machine's CPUs under a CPU limit, and the kernel log, the clock and the cgroup tree are the machine's. Slots are isolated from each other as containers are, less strongly than microVMs, and the sandbox around them is the boundary to the outside. On a machine that is not disposable, use krun.

**Limits** come from cgroup v2: `memory.max` is the task's `memory_mb` with no swap, `cpu.max` its CPUs rounded up, and `oomKills` is `oom_kill` of the slot's `memory.events`. A machine without the memory controller runs ns slots without limits: setup says so, and the runner's capabilities report `cgroup: false`.

**The disk cache** is the krun one. The lower mount lives beside the disk as `<digest>.mnt`, a slot holds the shared lock of `<digest>.use` as a microVM does, and `--disks remove` and `nanoeval prune` unmount it before they delete the disk.

### Testing without root

The machine these lanes were written on refuses user namespaces and gives no root. A libkrun microVM is a root machine without KVM, the shape of a remote sandbox, so `test/Guest.ts` boots one from a Debian 12 disk with Node 24 (`test/guest/Dockerfile`, converted with `nanoeval-krun image build`), shares this checkout into it read-only, and gives `sandboxd` a machine to run its commands on. `NANOEVAL_E2E_BACKEND=ns npm run e2e` then runs the Worker, the import and the directory store on the host, and the runner, the hand and the ns slots inside the guest, which reaches the Worker through the launcher's relay. On a machine where the test is root, the same lanes run ns slots directly. `NANOEVAL_E2E_RUNTIME=1` makes the run publish the runner runtime and start its runner through the bootstrap, as a remote sandbox does.

## Image disks

`nanoeval-krun image` turns a task's environment into the disk a krun slot boots, with no container engine on the machine: it reads an image from its registry, or runs a Dockerfile, and a builder microVM writes the disk from the layers. `sandbox/Converter.ts` calls it when a task is imported.

```
 nanoeval-krun image build (--ref NAME | --dockerfile DIR) --size-mb N --out DISK.ext4 --meta META.json
                           [--ca-bundle FILE] [--env-file FILE]... [--forward ADDRESS:PORT]...
   registry     the manifest for the platform, through an index, fetched by digest
   blob store   layers, configs and manifests in <cache>/blobs/sha256, one lock and one download per blob
   mke2fs       an empty sparse ext4 of N MiB
   builder VM   nanoeval-krun vm --build DISK [--source DISK]... [--context DIR]
     Apply      one layer's archive over vsock, unpacked by the guest as root
     Run        a RUN step in the disk, with /proc, /dev, /sys and a resolver for that step only
     Install    a COPY from the context share or from another disk
   DISK.ext4, META.json   renamed into place under a lock on the output

 nanoeval-krun image pack DISK.ext4 --out FILE      the non-zero blocks through zstd, addressed by SHA-256
 nanoeval-krun image unpack FILE --out DISK.ext4    a sparse disk again, both digests checked
 nanoeval-krun image tree DISK.ext4                 every entry of a disk, for comparing two
```

| Piece | Runs | Role |
| --- | --- | --- |
| `krun/host/src/image/reference.rs`, `registry.rs`, `store.rs`, `oci.rs` | Host | Image references, anonymous registry requests, the blob store, manifest and config shapes |
| `krun/host/src/image/dockerfile.rs` | Host | A Dockerfile as steps with their lines, and its word splitting and variable expansion |
| `krun/host/src/image/build.rs` | Host | Both sources, the stages of a Dockerfile, the metadata file |
| `krun/host/src/image/machine.rs` | Host | The builder microVM as a child process, and requests to its guest |
| `krun/host/src/image/pack.rs` | Host | The packed form |
| `krun/guest/src/build.rs` | Guest | `Apply`, `Install`, `Mkdir`, `Run` and `Tree` on a disk mounted at `/mnt/root` |

**From a reference.** `NAME:TAG` or `NAME@sha256:…`, on Docker Hub or any registry that speaks the OCI distribution protocol. A tag is resolved to a digest with a `HEAD` request, and every manifest is then fetched by digest and kept, so a second conversion asks the registry for nothing it has. An index or manifest list is searched for `--platform`, by default `linux` and the machine's architecture. Schema 2 and OCI manifests are read. Schema 1 and layers that are not gzip, zstd or plain tar are refused by name. Requests are anonymous: a bearer challenge is answered with a token asked for without credentials, and a registry that wants more is an error. Certificates are checked against `SSL_CERT_FILE` or the system bundle.

A blob is downloaded to `<digest>.part` under a lock on that file, resumed with a range request, hashed, and renamed to its digest. Four blobs of an image download at once. A failed request is tried again six times, a second apart at first and doubling. A `429` waits as long as `Retry-After` says, or a minute at a time, for at most the window the registry names in `ratelimit-limit` and six hours when it names none.

**Layers.** The builder guest mounts the new disk at `/mnt/root` and never makes it its own root. Each request works in a thread that leaves the shared filesystem state and changes its root to the disk, so an absolute link in the image resolves inside the image and nothing of the microVM is mounted over what the layers write. A guest that had entered the disk would write the `/dev`, `/proc` and `/sys` entries of a layer into its own mounts. The host decompresses a layer and sends the archive in frames, hashing it on the way, and the conversion fails when a layer does not hash to the `diff_ids` entry of the image config.

The guest applies a layer as a container engine does: `.wh.NAME` removes `NAME`. `.wh..wh..opq` removes what earlier layers left in its directory and keeps what this layer wrote, in whichever order the archive has them. An entry replaces what is there unless both are directories. Hard links, symlinks, fifos and devices are made as such. The owner is set before the mode, so a setuid bit stays. Extended attributes come from the PAX records, for files and for directories. Directory times are set after each layer.

**From a Dockerfile.** One builder microVM runs each stage on a disk that starts as the stage's base image. Stages that the last one does not copy from are not built.

| Instruction | Support |
| --- | --- |
| `FROM image [AS name]`, `FROM scratch`, `ARG` before `FROM` | Yes. `--platform` and a stage as the base are refused |
| `RUN`, shell and exec form | In the stage's microVM, as `USER` in `WORKDIR` with `ENV` and `ARG` set. `--mount`, `--network`, `--security` and heredocs are refused |
| `COPY` and `ADD` from the build context | Through a read-only share of the context. Wildcards, every flag but `--from`, an ignore file, and `ADD` of a URL or of an archive it would unpack are refused |
| `COPY --from` a stage or an image | The source disk is attached read-only to the stage's microVM. An image is converted first |
| `ENV`, `ARG`, `WORKDIR`, `USER`, `CMD`, `ENTRYPOINT`, `SHELL` | Yes, with `$NAME`, `${NAME}`, `${NAME:-word}` and `${NAME:+word}` where a Dockerfile expands them |
| `EXPOSE`, `HEALTHCHECK`, `LABEL`, `MAINTAINER`, `STOPSIGNAL`, `VOLUME` | Read past: a slot uses none of them |
| `ONBUILD` and anything else | Refused by name, with the line |

A `RUN` step gets `/proc`, `/dev` and `/sys`, a resolver file and a hosts file, mounted in a mount namespace of its own thread, so they are gone with the step and the image's own `/etc/resolv.conf` and `/etc/hosts` are what the disk keeps. Its network is a slot's: `--network private`, the default, is passt and needs it installed, and `--network host` is TSI with the machine's resolver. A step has no terminal and no input.

**Host policy in a step.** The three options change what a step reaches and nothing the disk keeps.

| Option | In a step | How it stays out of the disk |
| --- | --- | --- |
| `--ca-bundle FILE` | The bundle is at `/opt/nanoeval/ca.pem`, where a slot has it, and the variables a slot names point at it: `CARGO_HTTP_CAINFO`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `NODE_EXTRA_CA_CERTS`, `PIP_CERT`, `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE` | It is a file on a tmpfs that the guest mounts at `/opt/nanoeval` in the mount namespace of that step's thread, so the disk never holds it. A directory made for the mount point is removed after the step and its parent's times are set back |
| `--env-file FILE` | Its variables, after the image's `ENV` and `ARG` and after the trust variables, so the machine's value wins | They are added to the step's request only. `ENV` state, and so the image's configuration and the row, never sees them |
| `--forward ADDRESS:PORT` | A private builder listens on that loopback address and relays to the machine's, as a slot does. With `--network host` the guest reaches the machine's loopback already | The relay is the launcher's own thread behind a socket in its scratch directory, with the forwards as its allow list |

`META.json` says which were applied, as `policy`, with the names of the variables and not their values, and the import's report says which were set. They are not part of an environment's identity: the same context under another policy is the same source, and a conversion record is reused. What a step itself writes from them stays, such as a lock file that names an index, and a step that removes `/opt` fails while the bundle is mounted there.

`COPY` follows what BuildKit was measured to do, in [DECISIONS.md](DECISIONS.md#2026-11-11-task-images-become-disks-without-docker): files from the context belong to root, files from a stage or an image keep their owner, modes and times are kept, a link named as a source is followed inside its own tree, a directory's contents are copied, a destination directory made on the way belongs to root with mode 755 and takes only the time of the source directory, a directory met on both sides takes the source's mode and owner, and a directory on one side against a file on the other is an error. `WORKDIR` makes missing directories as the current `USER`.

**The disk.** ext4 without a journal, made by `mke2fs` with the options of a slot's upper disk. Its UUID and directory hash seed come from the image digest, so every conversion of an image lists its directories in the same order. `lost+found` is removed. It holds what the layers hold and nothing else. What `docker create` adds to a container is not there: `/.dockerenv`, the empty `/etc/hostname`, `/etc/hosts` and `/etc/resolv.conf` that Docker mounts over, the `/etc/mtab` link, and its own `/dev`, `/proc` and `/sys`. A slot writes its resolver and hosts files when it boots.

**Metadata.** `META.json` is what a runner needs beside the disk:

```json
{
  "schema": "nanoeval-environment-v1",
  "source": { "reference": "alpine:3.21" },
  "platform": "linux/amd64",
  "size_mb": 10240,
  "image_digest": "sha256:2d8a1104…",
  "images": [
    {
      "reference": "alpine:3.21",
      "index_digest": "sha256:bc214871…",
      "manifest_digest": "sha256:2d8a1104…",
      "config_digest": "sha256:e50d940e…",
      "layers": [
        {
          "digest": "sha256:871d48e9…",
          "media_type": "application/vnd.oci.image.layer.v1.tar+gzip",
          "size": 3625402
        }
      ]
    }
  ],
  "config": {
    "architecture": "amd64",
    "os": "linux",
    "env": ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
    "working_dir": "/",
    "user": "",
    "entrypoint": null,
    "cmd": ["/bin/sh"]
  },
  "bytes_allocated": 13049856,
  "seconds": { "download": 1.19, "convert": 0.14 }
}
```

For a reference, `image_digest` is the digest of the platform's manifest. For a Dockerfile, `source` is `{"dockerfile": "sha256:…"}`, a digest over the context's files, the platform and the size, `images` lists every image the build read, and `image_digest` is a digest over that source digest and their manifests. `config.env` is the image's own: the import adds the default `PATH` to the row when it has none. A build whose metadata already names the same source, platform and size is skipped, without a request to the registry.

**Identity.** Two digests name an environment, for two questions. `image_digest` says what it was made from: equal digests at equal sizes are the same files, owners, modes and times, in the same directory order. The SHA-256 of the packed disk says which bytes a run boots, and that is what an eval records and fetches by. They are two because the conversion is not reproducible byte for byte: a kernel writes the disk and stamps every inode with its clock, and places the data as its memory allows, so two conversions of one image differed in 3 to 5 % of their blocks for small images and in 36 % for one of 2.2 GiB, and in no entry of their trees. Making the packed digest follow from the image would mean writing ext4 without a kernel.

**Packed form.** A disk of 10 GiB holds a few hundred MB, and a sparse file does not survive an upload. `image pack` writes, through zstd at level 3:

```
 "NKRDISK1"                        8 bytes
 size of the disk                  u64, little endian
 offset, length, bytes             a run of non-zero 4 KiB blocks, at most 1 MiB, in ascending order, repeated
 size of the disk, 0               the end
 SHA-256 of everything above       32 bytes
```

A block of zeros is left out whether the file system had allocated it or not, so the packed bytes follow from the disk's bytes alone, and packing a restored disk gives the same file. The SHA-256 of the packed file is its address. `image unpack` writes the runs into a sparse, read-only file, checks the digest inside and, with `--sha256`, the one of the file, and keeps nothing when either is wrong. Both hold a lock on their output while they write it, and `image unpack` keeps a disk it finds once it has the lock, so of two runners that restore one disk at once the second writes nothing. A disk is therefore named by the digest of its file, as a runner's cache names it.

**Limits.** A command that runs as a user of the image, in a `RUN` step as in a slot, has that user's primary group and no supplementary groups. Hard links between the files of one `COPY` become separate files. Registries are read without credentials. Every image is a whole disk: images that share base layers share them in the layer cache and not in the store.

## Slot networks

A `krun` slot gets a network of its own (`--network private`, the default): its own loopback and port space, connections out, and nothing in. `--network host` shares the machine's network through TSI. A `dir` slot is a directory and stays on the machine's network. The network is a property of the machine a runner serves: `slot.sh setup` prepares it, `probe` reports it, the run refuses a runner that reports another, and the run's status shows it as `network` in the runner's capabilities.

```
 slot                                                       host
 hand ─ ws://127.0.0.1:P ─▶ listener on the slot's loopback
                              │ the guest agent ─ vsock port 1025 ─ relay.sock
                              ▼
                            nanoeval-net host, one per slot ─ allow list ─▶ 127.0.0.1:P, the Worker
 everything else ─▶ the guest's passt
```

| | krun slot |
| --- | --- |
| Network stack | A virtio-net device on a passt process that the VMM starts for this guest alone. No TSI. The guest agent sets the address, the route and the MTU over netlink |
| Out | passt opens the host's sockets for the guest's connections |
| Names | The guest's resolver address, which passt forwards to the machine's resolver |
| In | passt forwards no port, and the gateway address is not mapped to the host (`--no-map-gw`) |
| What the image needs | Nothing |
| What the host needs | cargo to build `nanoeval-net`, or the built binary, and passt installed as a system package |

**The relay.** A hand accepts a plain `ws://` URL only for a loopback address, and a local Worker listens on the machine's loopback, which a private slot cannot reach. So the slot listens on the Worker's address and port on its own loopback, and each connection it accepts is carried to the host through a vsock port that libkrun connects to `relay.sock`. The slot side names the address it wants in a first line. The host side is one `nanoeval-net host` process per slot. It dials the address only when the slot's allow list holds it, and a slot cannot write that list. The list holds the session's address while the hand runs, so the listener and the entry exist exactly as long as the hand does: the guest's listener belongs to the hand's exec request, and `slot.sh verify` resets the list before the verifier starts. The relays belong to the slot, not to `sandboxd` or the runner, so a restart of either does not cut a hand off. A Worker reached over `wss://` needs none of this: the hand dials out.

**Forwards.** A machine's resolver may answer a name with an address on the machine's own loopback, where a proxy for package registries listens. A private slot would find nothing there. `sandboxd --slot-forward ADDRESS:PORT` names such listeners, and every slot then listens on the same address of its own loopback for its whole life and relays to the host's, through the same socket and allow list. It is host policy like `--ca-bundle`, and the runner's capabilities record it as `slot_forward`.

**Closed phases.** Harbor's task format says what each phase may reach: `network_mode` in `[environment]` is the baseline, `public` or `no-network`, `[agent]` and `[verifier]` may each override it, and `allow_internet = false` is the deprecated way to write `no-network`. `src/Task.ts` reads them as Harbor 0.25.0 resolves them, and refuses `allowlist` and `allowed_hosts`. A row records the agent's network as `network.allowInternet` and the verifier's as `network.verifierInternet` only when it differs, so the rows of every eval imported before are unchanged.

```
 slot                                   host
 eth0 ─ virtio-net ─ VMM ─ gate ─ passt        frames pass only while slots/<slot>/net/open exists
 127.0.0.1:P ─ vsock ─ relay.sock ─ allow      the list holds the forwards only in an open phase,
                                               and the session only while the hand runs
```

A slot whose task closes a phase starts its microVM with `vm --gate net/open`. The gate is two threads of the VMM between its network device and passt. Each reads one frame, four bytes of length and the frame, and writes it on only if the file exists, so a closed phase drops every frame in both directions, at a frame boundary, and nothing is queued for later. `slot.sh` writes the file and the relay's allow list when the slot comes up, for the agent's phase, and again in `verify`, after the hand is stopped and before the tests are copied in. The file is in the slot's directory on the host, which no guest can write. A slot that closes nothing has no gate and runs as before.

| Phase closed | Reaches | Does not reach |
| --- | --- | --- |
| The agent's | Its own loopback, and through the relay its session while the hand runs, or its model endpoint while an installed agent runs | Any address by name or number, the gateway, a forward of the machine |
| The verifier's | Its own loopback | The same, and the session, which the relay forgot when the hand stopped |

So the hand still attaches and the turn still runs, since both go through the relay and model requests leave from the Worker. A closed agent phase needs a session at `ws://127.x.x.x`: a hand cannot dial a deployed Worker over `wss://` without a network, and the slot refuses. An [installed agent](#installed-agents) is held to the same: its model endpoint is relayed at `http://127.x.x.x` and refused at `https://`. Processes the agent left running are still there when the verifier's phase opens the network, as in Harbor, where both phases share one environment. Only krun slots on a private network can close a phase: the gate is in the VMM, and an ns slot's link is the machine's kernel's, which nothing here closes. A run on `--network host`, on `dir` or `ns` slots, or with `--backend auto`, whose runners may take ns, that selects such a task is refused when it is created, and `slot.sh up` refuses it again.

**What is not isolated.** A private krun slot reaches whatever the machine serves on its other addresses, such as its LAN address. It has IPv4 only. While the hand runs, the Worker's port on the slot's loopback is taken.

**ns slots** get the same network by other means, since the kernel is the machine's. A private ns slot has a network namespace with its own loopback and one end of a veth pair, `eth0`, on a /30 of 10.213.0.0/16. The machine keeps the other end, `nevN`, forwards, and holds one nftables table, `ip nanoeval`, made at setup:

| Rule | Effect |
| --- | --- |
| `postrouting`: masquerade what leaves from 10.213.0.0/16 by another interface | A slot reaches the internet as the machine |
| `forward`: drop from one `nev*` link to another | A slot does not reach another slot |
| `input`: drop what arrives on a `nev*` link | A slot does not reach the machine itself, which is where a sandbox's control daemon listens, and an answer to a connection the machine opened to a slot never arrives |

The slot's resolver file holds the machine's nameservers, so setup refuses a machine whose only resolver is on its loopback. A hand that dials `ws://127.0.0.1` is relayed as in a krun slot, through a UNIX socket in the control directory instead of vsock, and a hand that dials `wss://` goes out through the masquerade. With `--network host` an ns slot keeps the machine's network namespace and shares its ports.

## Verifier cache

A Terminal-Bench verifier installs its tools in every attempt: `apt-get update`, `apt-get install -y curl`, the uv installer, and `uvx` with a Python and the test runner. On ten tasks that was 84 to 85 % of the verifier's time, see [DECISIONS.md](DECISIONS.md). `nanoeval run --verifier-cache`, off by default, keeps the part of it that is a download with a cache of its own: what uv fetches.

```
 runner       slots/<slot>/verifier.cache: KEY and read, or write for the attempt of an oracle
 slot.sh verify
   hit        <cache>/verifier/KEY is copied through the io share into /var/cache/nanoeval-verifier,
              after the tests, and the verifier starts with UV_CACHE_DIR and UV_PYTHON_CACHE_DIR in it
   miss, model    nothing: the verifier runs as it does without the option
   miss, oracle   the verifier starts with the two variables in an empty directory, and what uv wrote
                  there is copied out and kept as <cache>/verifier/KEY when test.sh ended with 0
```

- **Two variables, no mounts and no changed script.** uv keeps wheels, index answers and built environments in `UV_CACHE_DIR` and the archives of the Pythons it downloads in `UV_PYTHON_CACHE_DIR`. Both are download caches: uv decides which Python and which versions to use as it does without them, and takes the bytes from the directory when it has them. Nothing is mounted over a directory the agent may have written, and `tests/test.sh` runs unchanged. A verifier sees the two variables and the directory, and finds its tools sooner.
- **Only an oracle fills it.** The processes of an agent are still in the environment while the verifier runs. A cache that any attempt may write would carry what one agent left there into every later verifier of that task. An oracle's attempt runs the task's own solution, so the cache holds what the task's own verifier downloaded on a solved environment. An attempt reads a copy and never writes back.
- **krun and ns slots.** Both take the same path in `slot.sh verify`: the directory goes in and out through the exchange directory of the slot. `dir` slots have no cache, and a run that asks for one there is refused.
- **Nothing before the verifier.** The directory reaches the slot as `tests/` does, through the share and only in `verify`, so the agent cannot see which tools its verifier uses.
- **The key** is a digest over the environment's blob, the tests archive, the verifier's variables and the variables the host gives its slots (`--slot-env`, which may hold `UV_EXCLUDE_NEWER` or an index). It is per task, so the cache helps the second and later attempts of a task on one machine, which is every attempt of a model after an oracle run.
- **Not cached:** `apt-get update` and `apt-get install`, whose results depend on the day and on what the agent did to the package lists, the uv installer, which is fetched over TLS from a release, and pip. `dir` slots have no cache.

## Pruning

Three things grow on a machine. A runner's cache is cleared by `nanoeval prune`, see [Runners](#runners). The layer cache of imports and the directory blob store had nothing that removed from them. `nanoeval prune layers` and `nanoeval prune store` do, and both only list, one line per file with its size and then a total, until `--remove` is given.

```
 nanoeval prune layers --days N [--remove]     sandbox/Prune.ts ─▶ nanoeval-krun image prune --cache LAYERS --days N [--remove]
 nanoeval prune store [--remove]               sandbox/Prune.ts: GET /v1/evals, /v1/evals/NAME/versions, /v1/evals/NAME@DIGEST?tasks=1
                                               every blob of every row of every version is kept, the rest is listed
```

**The layer cache, by last use.** A layer, config or manifest is unused when its last use is N days back or more. The last use is the later of the file's access time and its modification time. The launcher's store sets the access time itself whenever it serves a blob from the cache (`Store::fetch` when the file is there, `Store::document` when it reads one), so the record does not depend on how the filesystem is mounted, and a cache written before this is aged by what its filesystem recorded. Partial downloads (`<digest>.part`) and temporary manifests (`<digest>.<pid>.tmp`) that old are listed and removed the same way. A name that is none of these is reported as `ignored` and left. `--days` has no default: how long a layer is worth keeping is host policy.

**A removal and a build exclude each other.** `image build` holds a shared `flock` on `<cache>/lock` for as long as it has the store open, which is the whole conversion. `image prune --remove` takes that lock exclusively without waiting, and when a build holds it, it removes nothing and says so. A build that starts during a removal waits for it. Under that lock a removal still takes each blob's own download lock, the `flock` on `<digest>.part` that `Store::fetch` takes, reads the file's times again, and removes it only if it is still unused. A partial download whose lock is held is a download in progress and is kept. A dry run takes no lock and creates no file. It reads the directory and the metadata of its entries, so it changes no blob's times.

**The store, by reference.** A blob of a directory store is referenced when a row of any version of any eval of the Worker names it: the instruction, the tests, the solution archive and the environment disk or files. Versions are never removed and a run names one version, so a blob no version names is one no run can ask for. Everything else under `<root>/sha256` with a digest for a name is unreferenced. Files that `put` stages beside a blob (`<digest>.<pid>-<hex>`) are leftovers of an import that died and are removed with them. A file that is neither is reported as `unknown` and left.

**A removal and an import exclude each other.** An import uploads its blobs before its version exists, so they are unreferenced while it runs. A directory store has a lock file, `<root>/lock`. `importEval` holds it shared from before the first blob is looked up until the Worker has created the version, and `prune store --remove` holds it exclusively, without waiting, from before it reads the versions until the last file is removed. So a removal sees every version of every import that finished, is refused while one runs, and an import that starts during it waits. Node has no `flock`. `Store.lock` runs `flock FILE sh -c 'echo held && exec cat'` with a pipe for its input: the line says the lock is held, and the lock is released when the pipe closes, which is when the holder releases it, exits or is killed. `slot.sh` already needs `flock`. A dry run takes no lock, so during an import it lists that import's blobs.

**The wrong Worker.** The reference set comes from one Worker. Pointed at a Worker with another state, a removal would take every blob. So `--remove` is refused when the Worker names no blob that the store holds, which includes a Worker with no eval, unless `--allow-empty` says that emptying the store is meant. A store that two Workers import into must not be pruned against either.

**Not pruned.** Blobs in R2: the Worker has no route that lists a bucket, and `prune store --store r2` is refused. Eval versions: a version is immutable and runs name it, and the Worker cannot list its runs, so nothing can say that a version is unused.

**Limits.** The two locks exclude only processes that take them. An import or a launcher from a checkout before this change takes neither, and a removal beside one can take a blob it is about to use: the import then fails on that task, or its version names a blob that is gone and a run of it ends as an `environment` error. Nothing is corrupted, since every reader verifies digests. `flock` is local to a machine. A cache or store whose files another user owns cannot have its access times set, and a build from it fails with the file's name. An eval whose first version was created and whose entry in the list of evals was not written is not seen, until it is imported again.

## Installed agents

An agent of a run is one of two kinds. A session agent (`claude`, `codex`) is the design of this document: a nanocode-ts session outside the slot, and a hand inside it. An installed agent (`claude-code`, `codex-cli`) is a vendor's own command line running inside the slot. It exists so that one run compares nanocode with the harness each vendor ships, on the same rows, disks, verifiers and scoring. It gives up the placement this document argues for: the harness, its tool loop and its event stream are in the task environment. Its credential is not.

```
 runner ─ slot.sh agents ─▶ <cache>/agents/<kind>-<version>    the pinned release, fetched once per machine, SHA-256 checked
                             └ linked into rt/agents/<kind>     which every krun and ns slot has read-only under /opt/nanoeval
 runner ─ endpoint ───────▶ run: a token of this claim, and the address /v1/runs/RUN/model/ROW
 runner ─ slot.sh agent ──▶ slot: sh -c COMMAND, the instruction on its input, the token in one variable
                             command ─ http://127.0.0.1:P ─ the slot's relay ─▶ Worker /v1/runs/RUN/model/ROW/...
                                                                               the token is checked against the row's claim
                                                                               the credential is added, the request forwarded,
                                                                               its status and usage written to the run
 runner ◀─ agent.status, agent.out, agent.err ─ then the verifier, as for every agent
```

| Piece | Where | Role |
| --- | --- | --- |
| `src/Installed.ts` | Worker and runner | The two commands: the pinned release of each, the shell command that starts it, and what its event stream means |
| `src/Proxy.ts`, `worker/Model.ts` | Worker | The model endpoint: which routes it forwards, how the token of an attempt becomes the credential of the deployment, and the usage read from a response as it passes |
| `slot.sh agents`, `slot.sh agent` | Sandbox host | Fetching a release into the cache of the machine, and one agent in one slot as a detached phase with a status file |

| | Codex CLI | Claude Code |
| --- | --- | --- |
| Agent | `ID=codex-cli:MODEL[:THINKING]` | `ID=claude-code:MODEL[:THINKING]` |
| Pinned release | 0.166.0: `codex-package-<arch>-unknown-linux-musl.tar.gz` of the GitHub release `rust-v0.166.0` | 2.1.318: the native binaries `linux-<arch>` and `linux-<arch>-musl` of the release bucket, with the checksums of its manifest |
| Runs in | Any image: every binary of the package is static. The package is needed, not the lone `codex` binary, which fails every tool call without `codex-code-mode-host` beside it | An image with glibc 2.26 or later takes the glibc build, an image with musl the musl build, which needs nothing but musl's libc. The command chooses by the loader the image has, and ends as an `agent` error in an image with neither |
| Does not run | The npm package: it needs Node in the image | The npm package, and the binary through a loader of ours: it reads itself from `/proc/self/exe` |
| Pointed at the run by | `-c model_provider` and `-c model_providers.nanoeval={base_url, env_key, wire_api="responses"}` | `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` |
| Started as | `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -m MODEL -c model_reasoning_effort="THINKING" -` | `claude -p --output-format stream-json --verbose --dangerously-skip-permissions --model MODEL --effort THINKING`, with `IS_SANDBOX=1` so that it accepts root |
| Its own state | `CODEX_HOME` | `CLAUDE_CONFIG_DIR` |

**The release.** Nothing is installed into a task image, at import or at run time. `slot.sh agents` downloads the release of the machine's architecture into `<cache>/agents` under a lock, refuses it when its SHA-256 is not the pinned one, and links it into the directory that slots already mount read-only for the hand. A second sandbox of the machine takes it from the cache. `NANOEVAL_AGENT_CODEX_CLI` and `NANOEVAL_AGENT_CLAUDE_CODE` name a file to run instead, which is how the end-to-end lanes run a scripted command.

**ns slots and remote sandboxes.** An ns slot runs the command as a krun slot does: `slot.sh agent` takes the same path for both, through the agent of the slot and its relay. [The runtime archive](#a-runner-without-a-checkout) of a remote sandbox carries no release: `slot.sh agents` fetches it there with `curl` when the first row asks for one, and needs `sha256sum` and `tar` beside it.

**The command.** It runs as the image's user in the task's working directory with the task's variables, like the hand. The instruction is its standard input, unchanged. Its state directory is `/var/lib/nanoeval-agent`, made before it starts and removed before the verifier, so nothing of it is left when the tests run except what the agent did to the task. Nothing else is written into the guest: the command line is an argument of the exec request.

**The endpoint.** A run forwards model requests for its installed agents at `/v1/runs/RUN/model/ROW/`. The token is an HMAC over the row and its current claim under a secret of the run, so it names one claim and needs no table. A request is served only while that claim holds the row, the row is in its `run` phase, and the agent's deadline has not passed: a finished agent, a verifier and a lost claim have no endpoint. Only the generation routes of the agent's provider are forwarded, `responses` and `responses/compact` for Codex, `v1/messages` and `v1/messages/count_tokens` for Claude. The credential is the one sessions use, see [Model credentials](#model-credentials): the plan login when the deployment has one, the API key otherwise, and for a ChatGPT plan the same loopback relay. The token, and any account or relay header the guest sent, are dropped before the request leaves. On a private network the slot relays the Worker's loopback address for exactly as long as the agent runs, as it does for a hand, and the allow list is reset before the verifier.

**Accounting.** The run writes each request before it forwards it, and its status, duration and usage when the response has passed: the usage is read from the provider's events as they stream through. The attempt's token counts are the sum over the requests of its last claim, the requests are kept as `agent/model-requests.jsonl`, and a lost claim's tokens are recorded with that claim. The cost is what the command itself reports: Claude Code prints one, Codex CLI none, so a `codex-cli` attempt has tokens and no cost, and `--model-budget-usd` does not bound it.

**What is the same as for a session agent.** The row, its claims and leases, admission, the disk and the copy-on-write disk, the network, the user, the verifier and the judge, the export. The agent's timeout is the task's: `timeout` ends the command, and the attempt is an `agent_timeout` that keeps its verifier reward. A command that exits with another code is an `agent` error with what it printed. The command is a detached phase of the slot, so a runner that restarts goes on with it, a lost runner's row is claimed again from an empty environment, and a cancelled run takes the slot down with the command in it.

**What the comparison does and does not control.** One run holds the task, its instruction, the environment disk, the resources, the network, the timeout, the verifier and the scoring equal, and the model and its thinking level by name. It does not hold equal what makes a harness a harness:

- **Prompts and tools.** Each harness sends its own system prompt and its own tools: nanocode its Code Mode cells, Codex CLI its shell and patch tools, Claude Code its Bash, Read and Edit. Context management, compaction, retries and what a thinking level means are each harness's own. That is the thing compared.
- **Where the harness runs.** An installed agent spends the task's CPU and memory: the command is a process of a few hundred MB in a guest of the task's size, and the task's memory limit can end it. A session agent spends none, and pays a round trip to the Worker for each tool call.
- **The trajectory.** A session's events are the harness's journal. An installed agent's are what its command prints: `agent/events.jsonl` is that stream unchanged, and `agent/trajectory.json` the ATIF steps made from it. Lost on the way: the time of each step, which neither stream carries. For Codex CLI the tokens of each model call, since its stream reports usage once per turn, and reasoning beyond the summaries it prints. For Claude Code the completion tokens of a step, which its stream reports as they were when the message began. The totals of both come from the endpoint, not from the stream.
- **The plan.** Both arms of a provider use one credential, so they share its rate limits when they run at once.
- **Versions.** The commands are pinned here, the nanocode release in `src/Slot.ts`. A comparison names them, and the export carries them.

**Not verified.** Claude Code against Anthropic, with an API key or a plan login: no valid login was at hand, see [DECISIONS.md](DECISIONS.md#2026-11-11-installed-agents-and-nanocode-beside-codex-cli). Its release was run on krun slots against a scripted Messages endpoint. For a plan login the endpoint adds the `oauth-2025-04-20` beta as nanocode-egress does, and whether Anthropic accepts a plan token on the requests Claude Code makes in this mode has not been tried. A deployed Worker reached over `https://`, and aarch64, have not been run either. On ns slots only the scripted command of the lanes ran, and no installed agent ran in a remote sandbox.

## Sandbox providers

A provider creates a sandbox, runs a command in it, writes a file to it, and kills it (`src/Sandbox.ts`). The contract is unchanged, and a run now asks one thing of a sandbox: it writes `runner.json` into it and runs `nanoeval runner --detach --config runner.json`. A run with a runtime writes `bootstrap.sh` beside it and runs that instead, see [A runner without a checkout](#a-runner-without-a-checkout). Everything else is between that runner and the run.

**Local.** `nanoeval sandboxd` serves a machine over HTTP with a bearer token. A sandbox is a directory, and `nanoeval` on its path is this checkout. Deleting a sandbox ends its runner and every slot it still has. This is the single-machine mode of the earlier versions: one large machine, many slots.

A machine's network is host policy, and `sandboxd` passes it to the runners it starts. `--ca-bundle FILE` mounts a certificate bundle into each slot and names it in the variables that OpenSSL, curl, uv, pip, requests, Node, git and cargo read, for a network that re-signs TLS. `--slot-env FILE` starts each slot with the variables of a file. Both change what the agent and the verifier see, so the capabilities in the run's status record them as `ca_bundle` and `slot_env`. Neither is set by default. `--slot-forward` is the third piece of host policy, described under [Slot networks](#slot-networks). `--store` and `--cache` name the directory blob store and the cache of the machine.

**E2B over MPP.** `src/E2b.ts` talks to `https://mpp.e2b.dev`, whose bodies match E2B's REST API:

1. `POST /sandboxes {templateID, timeout, metadata}` answers `402` with `WWW-Authenticate: Payment …` challenges (`method="tempo"`, intents `charge` and `session`, each in two six-decimal tokens).
2. `src/Payment.ts` builds the payer with mppx (`tempo.charge`). Its `onChallenge` hook reads the amount, charges the run's budget, signs the credential, and records the charge. A challenge over budget is refused before anything is signed.
3. The paid response, `201`, carries `sandboxID` and `envdAccessToken`. Commands then go to envd at `https://49983-<id>.e2b.app/process.Process/Start` as a Connect server stream in JSON, and files to `/files` as `application/octet-stream`, both with the token. That data plane is free.
4. `DELETE /sandboxes/<id>` is a paid request too, $0.0001, and answers `204`.

E2B bills the requested lifetime when the sandbox is created and does not refund an early kill. Over MPP it serves only its public templates, and CPU and memory are fixed by the template. A sandbox is a Firecracker guest without KVM, with root: its runner is started from [the runtime archive](#a-runner-without-a-checkout) and runs [ns slots](#ns-slots). The runner and the hands dial the Worker, so the Worker needs an address the sandbox reaches: a deployed Worker, or a tunnel in front of a local one (`nanoeval worker --public-url`).

Two ways pay for a sandbox:

| | The Worker pays | The operator pays |
| --- | --- | --- |
| How | `nanoeval run --provider e2b`, with `TEMPO_PRIVATE_KEY` in the Worker | `nanoeval run --sandboxes 0 --runtime`, any MPP client for `POST /sandboxes`, then `nanoeval sandbox --run RUN --e2b ANSWER.json` |
| Budget | `--sandbox-budget-usd`, checked before each charge is signed, charges in the run's `payments` | The payer's own limit. The run records no payment |
| Lifetime | The run's, see [Budget and payments](#budget-and-payments) | Whatever the operator bought |
| Ends | The run kills the sandbox when its runner holds no row | The operator kills it, or it expires |
| State | Run against a local mock only | Run for real, see [DECISIONS.md](DECISIONS.md#2026-11-11-e2b-for-real-slots-without-kvm-a-runner-without-a-checkout-a-paid-run) |

The answer of the paid request holds the sandbox's access token: keep the file private and delete it with the sandbox.

The E2B JavaScript SDK is not used. It cannot pay, and it needs `nodejs_compat`. The envd protocol it wraps is two requests.

## Tasks and results

Tasks are Harbor task directories, schema 1.1, as Terminal-Bench 2.x ships them: `task.toml`, `instruction.md`, `environment/`, `tests/test.sh`. The verifier writes `/logs/verifier/reward.txt`. An import turns each directory into a row of an eval, see [Evals](#evals), and a run carries rows and no files. `environment.build_timeout_sec` bounds a slot's start when the task sets it, and `--setup-sec` otherwise. Tasks that ship a Compose file, declare MCP servers, or need GPUs, a separate verifier environment or a network allowlist are refused when they are imported. A task that closes the network of a phase is refused when a run is created on slots that cannot close it, see [Closed phases](#slot-networks). `verifier.environment_mode` is `shared`, as Harbor 0.25.0 writes it, or `same`, as the earlier loader did. Compose is recognized by `environment/docker-compose.yaml`, which is what Harbor acts on, not by a `[metadata]` flag. A task of the earlier Harbor format, which writes `version = "1.0"` where later tasks write `schema_version`, loads the same way: Terminal-Bench 2.0 is published in it.

[Datasets](#datasets) describes where task packages come from, and [Final messages and judges](#final-messages-and-judges) the two additions to the task format.

`nanoeval export` writes a Harbor job directory: `config.json` and `result.json` for the job, and per trial `config.json`, `result.json`, `agent/trajectory.json` (ATIF-v1.7), `agent/events.jsonl`, `verifier/test-stdout.txt` and every file the verifier wrote, such as `verifier/reward.txt` and `verifier/ctrf.json`, bytes intact. A verifier file over 4 MiB is named in `verifier-omitted.txt` instead, and a solution or verifier log keeps its last 4 MiB behind a line that says it was cut. The shapes are those of Harbor's `JobResult`, `TrialResult`, `JobConfig` and `TrialConfig`: a trial's id is the job's UUID with its last group replaced by the attempt number, its config names the task by path, and the job counts every trial with an exception as errored, as Harbor does, which includes an agent timeout that nanoeval scores. The CLI reads the result files in one request and each artifact in its own. Token counts and the harness's cost estimate come from the session's events, per attempt.

## Datasets

A dataset adapter turns a published benchmark into task packages in the Harbor layout, and `nanoeval import` turns those into the rows of an eval, once, on the machine that imports. Nothing about a dataset exists at run time: the Worker and the runners see rows. The adapters are those of nanocode's `crates/experimental/nanocodex-eval-adapters` (removed in `2d4a4c539`), ported to TypeScript in `datasets/`.

```
 nanoeval import NAME
   datasets/Catalog.ts   the datasets, each with the digests it is pinned to
   datasets/Source.ts    downloads into ~/.cache/nanoeval/sources, kept by SHA-256
   datasets/<Adapter>.ts rows of the source become task files
   datasets/assets/      the verifier of each dataset: test.sh, grade.py, solve.sh
   cli/Import.ts         each task becomes a row of the eval NAME, see Evals
 nanoeval import NAME --out DIR
   datasets/Dataset.ts   writes DIR/<task>/ and DIR/dataset.json instead, to read or to hand to Harbor
```

**Selection.** `--only ID` names tasks, and `--limit N` takes the first N in the order of their ids, compared as strings. `Dataset.select` orders the ids of every adapter before it chooses, `dataset.json` lists tasks in the same order, and the rows of an eval are read in it, so `import D --limit N` makes the rows that `run --eval D --limit N` takes from a whole import. The order of the rows in a source file is not used: a run could not recover it from rows.

**Pins.** A source is a file with a SHA-256 written in the adapter, or a set of task packages with a digest over their digests. A download that does not match is refused and not kept. The eval's version records the dataset and the pins, and every row its id, its name and its package checksum, the same checksum a run reports. Importing part of a dataset (`--only`, `--limit`) adds to the eval as a new version. An eval holds one dataset from one source. `dataset.json` (`nanoeval-dataset-v1`) records the same for a directory written with `--out`.

| Dataset | Where the tasks come from | What the importer writes |
| --- | --- | --- |
| Terminal-Bench 2.0 and 2.1 | The Harbor registry, read without a login as Harbor's client reads it: the dataset version is found by its digest, its task list must hash to the pinned digest, and each `dist.tar.gz` must unpack to the package hash the list names | The package, unchanged |
| SWE-bench Verified | One Parquet file from Hugging Face at a pinned revision | `instruction.md` is the problem statement. `docker_image` is the official instance image. `tests/` holds the instance row and a verifier that asks the official `swebench` package for the evaluation script, runs it, and lets the package read the log. `solution/` applies the gold patch |
| GPQA Diamond | `dataset.zip` of the authors' repository at a pinned commit, opened with the password its README publishes | The authors' prompt with the choices in the order of their baseline (`random.seed(0)`, one `random.shuffle` per row). The correct letter stays in `tests/case.json` |
| HealthBench Professional | One JSON Lines file from Hugging Face at a pinned revision | The user's message as the instruction. The rubric stays in `tests/case.json`, the physician's answer in `solution/` |

The Terminal-Bench source is the registry and not the Git repository, although the earlier adapter cloned `harbor-framework/terminal-bench-2-1` at a pinned commit. At that commit 88 of the 89 tasks hash the same as the registry's packages. `sanitize-git-repo` differs in five lines of `tests/test_outputs.py`, where the repository splits fake credentials into two string literals and the published package does not. Leaderboard runs use the packages, so the importer does too.

A small task shared by thousands of cases needs no new format: every GPQA and HealthBench task names the same image, so the import converts it once, every row names the same disk digest, and the slots of a machine share one unpacked disk under their own overlays.

## Final messages and judges

Two things the Harbor layout cannot say are added under `[metadata.nanoeval]` in `task.toml`. Harbor keeps `[metadata]` free-form, so these tasks still load there, and a task without the table behaves as before.

```toml
[metadata.nanoeval]
final_message = true   # the verifier grades the agent's last message
judge = true           # the verifier may ask a model
```

**Verifier inputs.** The runner writes into `tests/.nanoeval/` of the slot's copy of the task, after the agent has ended and before `tests/` is copied into the environment. The files therefore reach the environment exactly as `tests/` does, and the agent never sees them.

| File in the environment | Written when | Holds |
| --- | --- | --- |
| `/tests/.nanoeval/final_message.txt` | `final_message = true` | The message that completed the turn, which the run hands to the runner. Empty when the agent ran out of time. In an oracle run, `solution/final_message.txt` |
| `/tests/.nanoeval/judge-response.json` | The verifier asked | `{"responses":[{"id","text"}]}`, one per request, in order |

**Judge.** Model credentials stay in the Worker, and a slot gets neither a credential nor an address to call. On a [private network](#slot-networks) the verifier cannot reach the Worker at all, since the relay's allow list is reset before it starts, and the judge works the same: the request and the answers are files that the runner reads and writes on the host, and the run answers them.

```
 verify, round 1   tests/test.sh writes /logs/verifier/judge-request.json
                   {"requests":[{"id":"rubric-0","prompt":"..."}]} and no reward
 judge             the runner hands the request to the run, which submits each prompt as a turn of its own session,
                   with no hand, on the model of the run's judge, and waits
 verify, round 2   the runner writes the answers as a verifier input and tests/test.sh
                   runs again: it finds them and writes the reward
```

- The run names the judge (`--judge PROVIDER:MODEL[:THINKING]`). A run with a judged task and no judge is refused at submission. A request cannot choose its model.
- A request is read only when the first round wrote no reward and the task says `judge = true`. It is at most 2 MiB, the limit of the earlier judge service. A malformed request, a failed judge turn, or a second round without a reward is a `verifier` error, never a score.
- The second round starts from an empty `/logs/verifier`, so a grader must produce the same prompts twice. There is one judge round.
- Judge sessions use the credentials and the egress of agent sessions. Their tokens are kept beside the attempt as `judge` and count against the model budget. The request and the answers are artifacts of the attempt.
- In an oracle run the graded text is `solution/final_message.txt` as the import wrote it, not what `solve.sh` printed. A grader that measures the answer, as the length adjustment of HealthBench does, measures the dataset's own text, in characters.
- The HealthBench grader keeps the prompt, the parser and the arithmetic of the earlier adapter. The arithmetic is that of `calculate_score` and `calculate_length_adjusted_score` in OpenAI's `simple-evals`. The prompt is shorter than the `simple-evals` template, and an answer that is not the JSON object is a `verifier` error where `simple-evals` asks again.
- The judge is a nanocode session, so the model sees nanocode's system prompt before the grader's prompt. In the earlier stack the judge was also an agent turn without tools. A judge call cost about 9,300 input tokens of that prompt in the runs recorded in DECISIONS.md.

## Model credentials

The session sends a model request without a credential, and `worker/Sessions.ts` adds one in the `Forward` egress. With `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` it is the API key. With a plan login it is that plan's access token: `CLAUDE_CODE_OAUTH_TOKEN` for Claude, and `CHATGPT_ACCESS_TOKEN` with `CHATGPT_ACCOUNT_ID` for Codex, which make nanocode-ts open the session in its subscription mode for that provider. chatgpt.com refuses requests from workerd, so Codex plan requests go to the nanocode-egress relay (`CHATGPT_RELAY_URL`, `CHATGPT_RELAY_SECRET`), a Node process that forwards only the Codex Responses endpoints.

`nanoeval worker` fills these for local workerd. It reads the access token of `--claude-login` or `--codex-login` once at start, never the refresh token, starts the relay on a loopback port with a random secret, and hands every variable to wrangler in a mode 600 file in a private temporary directory that it removes on exit. It does not refresh a login: an expired one fails at the provider, and the attempt ends as an `agent` error.

## Budget and payments

A run carries `budget.sandboxUsd` and an optional `budget.modelUsd`. Every MPP charge is checked against the sandbox budget before it is signed and is written to the run's `payments` table with its challenge. No row is claimed once the model spend reaches the model budget, and the rows that still wait end as `budget` errors. The spend counts finished attempts and the sessions of lost claims. A sandbox whose creation was interrupted by an orchestrator restart is marked `unknown` and is not retried, since its payment may have happened.

**Lifetime.** A paid sandbox is bought for a lifetime when it is created, and an early kill refunds nothing. Unless `--sandbox-timeout-sec` names it, the run computes it when it is created (`Config.lifetimeSec`): the worst case of a row is its setup limit, its agent timeout and its verifier timeout, three times that last one for a judged task. The rows are placed longest first, each on the slot that is free soonest, over `--sandboxes` times `--slots` slots, and the lifetime is the busiest slot plus the setup limit for the bootstrap. A run whose lifetime exceeds what E2B sells, 86,400 s, is refused with the figure. The bound ignores memory admission: a sandbox that expires with rows in flight loses them like any lost runner, and the run opens another while the budget lasts. E2B can also extend a running sandbox (`refreshes`), which would let a run buy time as it uses it. That is not used yet.

## Rejected alternatives

| Alternative | Why not |
| --- | --- |
| The harness inside the task container (Harbor installed agent) | Credentials in untrusted environments. Task images need a runtime, a CA bundle and a CLI. A dead container takes the diagnostics with it |
| The Worker as a `WorkspaceHost` that calls the sandbox's exec API for each tool call | Loses the native hand's process sessions, PTYs and patch engine. One HTTP request per tool call instead of one WebSocket per attempt |
| Cloudflare Workflows or Queues for the attempt lifecycle | A run needs one writer for claims and payments. A Durable Object is that writer, and it runs unchanged under local workerd |
| D1 for the tables, and R2 for results | A table belongs to one eval or one run and has one writer, so it lives in that object's SQLite. Artifacts are chunked there too. R2 holds the blobs of evals, and is planned for large artifacts |
| The E2B SDK in the Worker | It cannot pay and needs `nodejs_compat` |
| bwrap or an unprivileged user namespace for slots without KVM | A user namespace cannot loop-mount the environment disk, so the disk would have to be unpacked into a tree whose owners are mapped. A remote sandbox has root, and with it the kernel mounts the disk as it is |
| `dir` slots in a remote sandbox | They cannot run an imported image at all, and do not isolate attempts |
| A second agent for ns slots, in shell or in the runner | Exec with a user and an environment, the copy of tests, the relay and the reaping of orphans would each exist twice. The guest agent got a second transport instead |
| `pivot_root` for an ns slot | The shell that prepares the root would need `umount` from the image afterwards, and the agent cannot unmount once its capabilities are bounded. `mount --move` and `chroot` leave the old root under the new one, unreachable by path |
| Dropping capabilities inside the agent | It needs `prctl`, which is `unsafe` in Rust or one more crate. `setpriv` is on every machine that has `unshare` |
| `CAP_MKNOD` for ns slots, as Docker grants | Docker pairs it with a device cgroup. Without one, a device node is the sandbox's disk |
| passt or slirp for the network of ns slots | Not installed in a sandbox, and the kernel there has veth and nftables. One table and one link per slot need no process |
| One loop device per slot for the environment disk | The page cache would hold the image once per slot. The disk is mounted once and every overlay reads it |
| A checkout and `npm ci` in the sandbox | 300 MB and a registry at run time, in a sandbox whose Node does not run TypeScript. The runner is one file of 40 kB |
| A custom E2B template with nanoeval installed | E2B over MPP serves public templates only |
| A lifetime that is a guess, or a fixed hour | A sandbox that expires loses its rows, and one bought too long is paid in full. The bound comes from the tasks, and an operator may name a shorter one |
| MPP sessions for E2B | Charges need no channel state. Sessions are planned: one deposit, vouchers per request, the remainder refunded on close |
| crun or podman with the krun runtime, or krunvm | A container engine and an image store on every sandbox host, where a runner needs neither: it boots a disk. krunvm manages images through buildah |
| Firecracker | A VMM executable with an API socket per VM, block devices only, and tap devices that need root. libkrun links into one unprivileged process and shares directories |
| The guest tool proxy of `nanocodex-vm` | It reimplemented `exec_command`, `write_stdin`, `apply_patch` and `view_image` in a guest. The released hand is that implementation now. Only a narrow exec port remains, for the hand, the solution and the verifier |
| A shared directory as the guest root, with a host overlayfs per slot | A host overlay mount needs root or a user namespace, and the machine it was tried on refuses unprivileged user namespace mappings. Files in a shared directory also belong to the unprivileged VMM user |
| A copy of the image per slot, as a tree or as a sparse ext4 copy | 0.3 to 1.0 s and 1 GB per slot for a 1 GB image, against 15 ms on an idle disk and 4 MB for an overlay upper disk |
| A qcow2 or device-mapper snapshot of the image | Device-mapper needs root and a kernel module. qcow2 needs qemu-img on every host and a second disk format in the VMM. The guest overlay needs neither |
| `mke2fs -d` under fakeroot to build the image disk | As fast as the builder microVM (4.3 s against 4.4 s for a 1 GB archive), but it adds fakeroot to every host and fakes what a kernel does for real |
| passt run from a user's directory | The packaged passt sandboxes itself in a user namespace. Run from a user's directory on Ubuntu 24.04 it exits with "Failed to sandbox process", and libkrun then panics activating the device. The system package carries the AppArmor profile that lets it, so that is the requirement |
| gvproxy for the guest network, as in gakonst/nanoeval | As released (v0.8.9, read from its source) it maps an address of the guest's network to the host's `127.0.0.1` and serves its port-forwarding API to the guest at the gateway, so a guest could reach the host's loopback and ask for listeners on the host. Closing both needs a configuration file or a build of our own. It is a 12.9 MB Go binary to fetch where passt is a distribution package |
| TSI with a port map, or TSI for outbound connections only | libkrun hijacks every guest socket or none. A listener is still bound on the host, and the socket options that fail still fail |
| libkrun's own DHCP client for the guest's address | It gives up 100 ms after its request. The address plan is fixed, so the guest agent sets it and a slow passt cannot leave a guest without an address |
| The login file of a plan copied into the slot for an installed agent, as Harbor's installed agents get theirs | It is a refresh token for the whole plan, in an environment that the task's code and the model both control, and every attempt would refresh it against the others. The endpoint of the run gives an attempt a token that is worth nothing after it |
| The vendor's command line installed into the image, at import or when an attempt starts | It changes the task image, needs Node and a registry in it, and costs every attempt an install. A static or libc-only binary shared read-only needs none of that |
| A proxy with the credential on the runner's machine | A runner holds no model credential. The Worker already forwards for sessions, and one place counts the tokens of a run |
| Intercepting the command's own traffic to its vendor with a certificate in the guest | The command would still need the credential, and the image a certificate authority of ours |
| The vendor's command line outside the slot, with its tools sent into the slot | Neither command has a hand protocol. Replacing its tools with ours would compare something neither vendor ships |
| The session relay inside `sandboxd` or the runner | It would end every hand when either restarts. A slot's processes outlive both |
| A listener for the Worker on the bridge's gateway, or TLS in front of it | Every slot could reach the first, and the second needs a certificate that every hand trusts |
| A Rust crate beside `krun/` for the importers, reusing the earlier adapters as they are | They are written against `nanocodex-eval`'s import store, case plans and task format, about 3,300 lines that no longer exist, so little would be reused as it is. The task loader, the checksum and the CLI they must agree with are TypeScript, and a second binary would have to be built on every machine that imports. What ports unchanged is the data: the pins, the prompts and the graders |
| Cloning the Terminal-Bench repository at a pinned commit, as the earlier adapter did | One of its 89 tasks differs from the published package, see [Datasets](#datasets) |
| Generating SWE-bench evaluation scripts while importing | That needs Python and the `swebench` package on the importing machine. The verifier already runs in an environment with a network, and asks the same pinned package there |
| The earlier SWE-bench grader, `pytest` over the listed tests | It is only right for repositories whose tests are pytest ids, and it passes on exit status. The official parsers decide per test |
| A judge endpoint that the verifier calls with a token, as the earlier judge service was | The slot would need a route to the Worker, which a private slot network does not give, and a token that outlives the agent's processes in the same environment. A file needs neither |
| The Run object driving every slot through the provider's `exec`, as the first version did | Every phase waited for the next alarm, about half a tick each, and every tick was a request per sandbox. One object did the admission of every machine from figures it had to ask for. A runner knows its machine, waits on local files, and calls the run only when something changed |
| A container engine for the environment: at run time in every slot, as a slot backend of its own, or only at import to pull, build and export | At run time it meant two environment formats, an image store on the smallest disk of the host, and a pull or a build inside every first attempt, where it was counted as the attempt's setup and could fail as its error. At import it still put a daemon, its image store and root-equivalent access on every machine that imports, to produce a disk that the launcher makes from the layers itself in less time. Converted once and without one, an environment is a file with a digest |
| Task files carried in every run, as the first version did | 27.8 MB of base64 for Terminal-Bench 2.1 in each submission, stored again in each run. A run now names a version and its rows name blobs |
| The disk as a raw file in the store, hashed whole | A task's disk is as large as its `storage_mb`, 10 GiB for every Terminal-Bench task, and mostly holes. The packed file is what is stored and hashed, and a runner unpacks it once |
| A version per imported task | 89 versions for one import. A version is what one import made |
| A queue or a push from the run to its runners | A runner behind NAT or in a sandbox has no inbound port. Claims are pulled, like the hand's connection |
| A lease kept by a lock file, as the earlier workset kept its claims | That needs one filesystem. Runners are on several machines, so a lease is a time that a heartbeat moves |
| Retrying a lost row without a bound, as the earlier workset did | A row that kills its runner, by memory or by a kernel fault, would be claimed forever. `--claims` bounds it and the row ends as an error that says so |
| Retrying a failure that a runner reported | An environment that does not boot will not boot on the next claim either, and a retry hides it. `--rerun --errored` retries on request and keeps the lineage |
| The runner as a shell script, like `slot.sh`, or inside `krun/` | It holds a state machine over HTTP with JSON. Shell has neither, and the Rust workspace is the launcher of one microVM. The runner is TypeScript and shares the row, protocol and admission types with the Worker |
| Folding `slot.sh` into the runner | Its detached phases and status files are what lets a slot outlive the runner and a restarted runner go on. It is also what the unit tests and the network lane drive directly |
| A model request sent by the Worker itself for the judge | A plan login only works through the session protocol of nanocode-ts, so a second client for each provider would be needed beside it |
| Asking the agent to write its answer to a file | It changes the dataset's prompt. The final message is what these datasets grade |
| The solution's output as the final message of an oracle run | The log of a solution also holds what the shell prints. A file in `solution/` is exact |
| Admission that reserves each task's `storage_mb` | Every Terminal-Bench 2.1 task declares 10 GiB and most write a few hundred MB, so a 12 GiB budget would run one attempt at a time. The floor on free disk claims by what is measured |
| Recognizing a verifier's failed installs from its output | It needs the error texts of pip, uv, apt, npm and curl, and breaks with each release of each. The missing report is one fact |
| The exit code of `tests/test.sh` as the sign of a broken verifier | Harbor's convention writes the reward from the runner's exit code and then exits 0 either way |
| A library that writes ext4 on the host from the layers, as `arcbox-ext4` did in `nanocodex-vm` | It must write every feature a layer can carry by itself: extended attributes, devices, hard links, large files. A `RUN` step needs a kernel on the disk anyway, and the builder microVM that makes disks from archives was already here, so a kernel writes all of it |
| `oci-client` for the registry, as `nanocodex-vm` used | It brings tokio and reqwest for three kinds of request. The converter is one blocking process: ureq with rustls and ring, and the calls written out |
| skopeo, umoci, buildah or crane to fetch and unpack | They are container tools, and the point is that a host needs none. Unpacking still needs root or a user namespace on the host |
| One flat archive made on the host from the layers, fed to the existing unpacker | Which entries survive is only known after every layer is read, so each layer would be read twice or indexed. Applying them in order is what an engine does and needs neither |
| Unpacking layers after the guest has entered the disk, as the first builder did with one archive of a whole container | `/dev`, `/proc` and `/sys` of the microVM lie over the disk there, so those entries of a layer land in the guest's mounts and the directories keep the times of the conversion. A root directory per request has no mounts in it |
| The files `docker create` puts into a container, written into the disk for equivalence | They are Docker's mount points, not the image. An image's own `/etc/hosts` would be lost, as it is in `docker export` |
| A disk that is the same byte for byte for one image | A kernel writes it, stamps each inode with its clock and places the data as its memory allows: 142 of 3,186 blocks differed between two conversions of `alpine:3.21` and 204,264 of 575,152 for an image of 2.2 GiB. The trees were equal, so the image digest is the identity of the content and the packed digest the address of the bytes |
| `tar --sparse`, `zstd --sparse` or qcow2 as the packed form | Each needs a tool on every host, and none gives the same bytes for the same disk when the holes of the file differ |
| zstd above level 3 for the packed form | On a disk with 2.2 GiB of data, level 9 gave 13 % fewer bytes for 4.3 times the CPU, and level 19 took 139 s against 1.6 s |
| The unpacker of the earlier packed form kept beside the new one | It would keep GNU tar and zstd on every runner for evals that take minutes to import again. A row names its form, and a runner refuses one it does not unpack |
| The bundle of `--ca-bundle` copied into the disk for its `RUN` steps, or appended to the image's own | It is the machine's, and it would be in every slot of every machine that runs the eval. A mount in the step's namespace is gone with the step |
| The variables of `--env-file` as `ENV` of the build | They would be in the row and in every slot. They are part of a step's request only |
| A closed slot as a microVM with no network device | The verifier of a task may have a network when its agent has none, and libkrun cannot add a device to a running guest |
| passt started when a phase opens and killed when it closes | Frames a closed guest sent wait in the socket and reach the internet when passt starts, and a passt killed in the middle of a frame leaves the stream out of step |
| A firewall inside the guest for a closed phase | The agent is root in its guest |
| The verifier cache as a disk attached when the microVM boots, as the earlier runner had it | A guest sees every device from its start, so the agent could read it, and one that is writable is written by the agent's processes |
| The cache mounted over `/root/.cache/uv`, `/root/.local`, `/var/lib/apt/lists` and `/var/cache/apt/archives` | It hides what the agent wrote there, which may be what the task asked for, and the lists of another day decide which packages `apt-get install` asks a mirror for |
| The setup lines cut from a verifier on a hit | It is the task's verifier. A cache may only make its downloads cheaper |
| A verifier cache that the first attempt of any agent fills | The processes of that agent are alive in the environment while the verifier downloads, and every later attempt would run what they left in the cache |
| The dependency setup of a verifier run in a spare microVM to fill the cache | A verifier on an unsolved environment can run until its timeout, 900 s for some tasks, and an oracle run already does the same work on a solved one |
| A second launcher protocol for disks made from one archive | Only the export of a container needed it. The request, its command and the boot on one writable disk went with their caller |
| A registry mirror or a login, to stay under Docker Hub's anonymous limit | The limit counts manifest requests, and a conversion makes one or two. 89 images converted from an empty store without meeting it. A `429` waits instead |

## Reused

| From | What | How |
| --- | --- | --- |
| gakonst/nanoeval `tasks/` | `write-greeting`, `uppercase-message`, `extract-todos` | Copied. `docker_image` removed so the Dockerfile builds |
| gakonst/nanoeval `crates/nanoeval/src/task.rs` | Task schema 1.1 fields and refusals | Ported to `src/Task.ts` |
| gakonst/nanoeval `crates/nanoeval-harbor` | Harbor trial and job result shapes, pass@k, the package content hash | Ported to `src/Harbor.ts`, `src/Result.ts`, `src/Task.ts` |
| gakonst/nanoeval `crates/nanoeval/src/atif.rs` | ATIF-v1.7 projection of agent events | Ported to `src/Atif.ts` for nanocode-ts session events |
| gakonst/nanoeval `evaluator.rs` | Atomic slot and memory admission, 80% default memory | Ported to `src/Admission.ts`. It now runs in the runner, on the machine it describes |
| gakonst/nanoeval verifier flow | Tests withheld until the agent ends, same environment, reward file | Kept in `slot.sh verify` |
| `HARNESS_PLACEMENT.md`, `NANOCODEX_VM_TOOLS.md` | Host harness, tools in the environment | Realized by the nanocode hand |
| nanocode-ts | `App.create`, `Forward`, hand tokens, the hand protocol | Used as a dependency |
| nanocode | The `nanocode hand` release binary | Downloaded and verified in each sandbox |
| gakonst/nanoeval `crates/nanovm` | The libkrun binding: `VmConfig`, `GuestCommand`, `KrunVm`, the capability probe | Ported to `krun/nanovm`. Read-only roots, vsock ports in both directions and a virtio-net device on a socket it is handed added. gvproxy, egress leases and the process config file left out |
| gakonst/nanoeval and nanocode `Cargo.lock` | libkrun `df85b8b` with libkrunfw 5 | The same pin, and the same lock entries for its dependencies |
| nanocode `crates/nanocodex-vm` `overlay.rs` and guest | A read-only image disk under a sparse upper disk per attempt, mounted and pivoted into by the guest | Reimplemented in `krun/guest/src/boot.rs` |
| nanocode `crates/nanocodex-vm` `image/` | An image disk made once and kept under a digest, with the image's environment and working directory in a record beside it | The disk is made at import and stored as a blob, with that record in the eval's row. The OCI pull and the Dockerfile build are `nanoeval-krun image build`, which `sandbox/Converter.ts` runs |
| nanocode `crates/experimental/nanocodex-eval/src/workset.rs` | One row per task, treatment and repetition, written before anything runs. The states `unclaimed`, `running`, and a scored end. A claim token that fences every terminal write (`WHERE state = 'running' AND claim_id = ?`). Attempts kept append-only, with an infrastructure failure putting the row back without consuming it | Ported to `src/Ledger.ts`: `attempts` and `claims` tables with the same fencing and the same append-only claims. The lock file that proved a claim alive became a lease with a heartbeat, and the retries of a lost row are bounded |
| nanocode `…/src/import/mod.rs`, `digest.rs` | An import store named by a digest over the dataset, its source and the digest of each task, with a re-import that changes nothing, and task packages whose instruction, tests, solution and environment are kept apart | Ported to `src/Eval.ts` and `cli/Import.ts`: a version digest over the same three things, and four blobs per row. The store on disk became the Evals object and the blob store. The package digest is Harbor's checksum, kept from the first version here |
| nanocode `…/src/coordinator.rs` | One HTTP owner of the ledger. `POST /v1/claims`, artifacts uploaded under the claim, `POST /v1/claims/{token}/finish`, and a heartbeat route that its client already called for a Cloudflare coordinator. Worker names advisory, the token the authority | The Run object is that owner and `sandbox/Runner.ts` the worker: `claims`, `heartbeat`, `rows/<id>/artifacts`, `rows/<id>/finish`. Its release of a worker's claims when the worker exits is `leave` |
| nanocode `…/src/vm.rs` | The attempt root: the prepared disk read-only under a fresh sparse upper disk, with tests copied in only for the verifier | Kept, see [krun slots](#krun-slots) |
| gakonst/nanoeval `evaluator.rs` | A request for more memory than the machine has is counted as the whole machine, so it runs alone | Kept in `Admission.fill` |
| nanocode `crates/experimental/nanocodex-eval-adapters/src/lib.rs` | The pinned revisions and SHA-256 digests of SWE-bench Verified, GPQA and HealthBench Professional | Copied into `datasets/SweBench.ts`, `GpqaDiamond.ts` and `HealthBench.ts`, and checked again against the live sources |
| nanocode `…/src/source.rs` | Downloads kept by digest and refused on a mismatch, a ZIP member opened without a host `unzip` | Ported to `datasets/Source.ts` and `datasets/Zip.ts`. Git checkouts and LFS left out: no shipped dataset needs them |
| nanocode `…/src/harbor.rs` | Harbor packages imported unchanged, a dataset digest over the task digests | Ported to `datasets/HarborHub.ts`, reading the registry in place of a checkout |
| nanocode `…/src/swe_bench.rs` | The instance image name, the problem statement as the instruction, the instance row hidden in `tests/` | Ported to `datasets/SweBench.ts`. All 500 rows in place of the first one. The grader is new |
| nanocode `…/src/gpqa_diamond.rs`, `assets/gpqa-diamond/` | The prompt, CPython's seed-zero shuffle, the canary check, `grade.py` and `test.sh` | Ported. `grade.py` reads the final message from the verifier inputs and writes `reward.txt`, otherwise unchanged. `test.sh` unchanged |
| nanocode `…/src/healthbench_professional.rs`, `assets/healthbench-professional/` | The case checks, the scoring constants, the grader prompt, the score | Ported. `grade.py` keeps the prompt, the parser and the arithmetic, and writes a judge request where it called the judge service |
| nanocode `crates/experimental/nanocodex-eval/src/judge.rs` | A judge that is an agent turn without tools on the evaluator's own login, with no credential in the environment, and its 2 MiB request limit | Kept as the design. The loopback service and its token became a request file |
| nanocode `…/src/import/mod.rs` | `dataset.json` with the source and a digest per task, `output = final_message` | Kept as `nanoeval-dataset-v1` for `import --out` and `[metadata.nanoeval] final_message` |
| Harbor `adapters/swebench` | The pinned grader packages (`swebench==4.0.3`, `datasets==2.16.1`, `fastcore<1.11`), task resources and timeouts | The same values in `datasets/assets/swe-bench/test.sh` and `datasets/SweBench.ts` |
| nanocode `crates/nanocodex-vm/src/image/mod.rs` | Blobs kept by digest under a lock per blob and checked against it, the manifest of the machine's platform chosen from an index, the layer media types, a Dockerfile as stages run in a builder VM with earlier stages and other images attached as disks, variable expansion, the default `PATH`, and the refusal of what is not supported | Ported to `krun/host/src/image`. `oci-client`, tokio and `arcbox-ext4` left out: the registry calls are written over ureq, and the guest writes the disk. The reference and blob records, the context disk, the base disk cache and its reflink copies left out. `USER`, `ENTRYPOINT`, `SHELL`, `ADD`, exec-form `RUN`, quoting, resumed downloads and the check against `diff_ids` added |
| The first krun backend here: `slot.sh` `_krun_image`, `krun/guest/src/unpack.rs` | A builder microVM that unpacks an archive as root onto a fresh ext4, so the host needs neither root nor fakeroot | The builder and its archive input are kept and fed the layers of an image. The request that unpacked one flat archive of a whole container, the `unpack` command and the boot on a single writable disk are removed with their only caller |
| nanocode `crates/nanocodex-vm/src/image/mod.rs` | A store of layers that outlives a conversion and is shared by every conversion on a machine | Kept as the layer cache of an import, `--layers`. A second import of Terminal-Bench 2.1 downloaded no layer |
| The OCI image layer rules, and the order Docker's `UnpackLayer` applies an opaque directory in | Whiteouts, opaque directories, directory times set after each layer | Reimplemented in `krun/guest/src/build.rs` |

## What the earlier runner had

The eval stack of nanocode at `2d4a4c539^` (`crates/experimental/nanocodex-eval`, `crates/nanocodex-vm`) against this repository:

| Earlier piece | What it did | Here |
| --- | --- | --- |
| Attempt roots (`vm.rs`, `nanocodex-vm/src/overlay.rs`) | A fresh sparse ext4 upper disk over a read-only image disk for each attempt, or a reflink copy that could be kept | Back as krun slots over the disk of the eval's row. Keeping the root of a finished attempt is not carried over: planned, for looking at a failure |
| Workset (`workset.rs`) | One SQLite row per task, treatment and repetition, claimed under file locks | Back as the run's rows and claims, with leases in place of file locks, see [Runs](#runs) |
| Dataset adapters and import store (`nanocodex-eval-adapters`, `import/mod.rs`) | Pinned sources normalized into task packages, stored under a digest | Back for five datasets as adapters, and as the eval table and blob store, see [Evals](#evals). The rest are listed in the README with what each needs |
| Judge service (`judge.rs`) | An OpenAI-compatible endpoint on the host for verifiers | Replaced by the judge request file |
| Separate verifier environment (`vm.rs`, `tests/Dockerfile`) | The verifier in a fresh machine from its own image, with only named artifacts carried over | Refused at submission. Planned: GDPval, SWE-Atlas QnA and GeneBench Pro need it |
| Network modes (`network_mode`, `allow_internet = false`) | A candidate without a network and a verifier with one | Back for krun slots on a private network, per phase, see [Closed phases](#slot-networks). An allowlist is refused |
| Transcripts (`transcript.json`) | A prompt of several messages | Not carried over. Planned: MRCR and 115 HealthBench cases need it |
| Verifier-dependency cache (`vm.rs`) | The `apt` and `uv` setup of Terminal-Bench verifiers kept on a cache disk that was mounted over `/var/cache/apt/archives`, `/var/lib/apt/lists`, `/root/.cache/uv` and `/root/.local`, with the setup lines cut from the script on a hit | Back in a smaller form, off by default: what uv downloads, in directories of its own that two variables name, see [Verifier cache](#verifier-cache). apt is not cached and no script is changed |
| Rerun lineage (`eval/run/retained.rs`, later the workset) | A run that retries what an earlier one did not pass. At `2d4a4c539^` the workset kept no pointer between them: a retry was a new generation or another attempt row | Back with the pointer: `run --rerun`, see [Runs](#runs) |
| Profiles (`profile.rs`, `nanocodex.toml`) | Named recipes of benchmarks, harnesses, models and thinking levels | Not needed yet: a run is a command line over dataset directories. A run file is the equivalent when one is wanted |
| Capture proxy (`capture_proxy.rs`) | Recorded the model traffic of other harnesses for comparison | Back as the model endpoint of a run, see [Installed agents](#installed-agents). It adds the credential as well as recording the usage, so the other harness holds none |
| Coordinator and pull workers (`coordinator.rs`, `cluster.rs`) | One HTTP owner of the ledger, workers that claim tasks, a host load sampler | Back as the Run object and its runners. The load sampler is not carried over: a runner admits by declared memory and measured free disk |
| Named rewards and scoring policies (`reward.json`) | Several rewards per attempt and a rule for passing | Not carried over. A grader writes one `reward.txt`, and the summary reports the mean reward beside the pass rate |
| Image builds without a container engine (`nanocodex-vm/src/image`) | OCI pulls and Dockerfile builds straight to a disk | Back as `nanoeval-krun image build`, see [Image disks](#image-disks), and the only way an environment is made |

Also not carried over yet: warm spare microVMs, prompt-cache cohorts, duration-ordered dispatch, egress leases.
