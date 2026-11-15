#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import * as Fs from 'node:fs/promises'
import * as Os from 'node:os'
import * as Path from 'node:path'
import * as Readline from 'node:readline/promises'
import * as Consumers from 'node:stream/consumers'
import { parseArgs } from 'node:util'
import * as Catalog from '../datasets/Catalog.ts'
import * as Dataset from '../datasets/Dataset.ts'
import * as Source from '../datasets/Source.ts'
import * as Sandboxd from '../sandbox/Sandboxd.ts'
import * as Converter from '../sandbox/Converter.ts'
import * as Prune from '../sandbox/Prune.ts'
import * as Runner from '../sandbox/Runner.ts'
import * as Store from '../sandbox/Store.ts'
import * as Baseline from '../src/Baseline.ts'
import * as Bootstrap from '../src/Bootstrap.ts'
import * as Compare from '../src/Compare.ts'
import * as Config from '../src/Config.ts'
import * as E2b from '../src/E2b.ts'
import * as Eval from '../src/Eval.ts'
import * as Installed from '../src/Installed.ts'
import * as Logins from '../src/Logins.ts'
import type * as Ledger from '../src/Ledger.ts'
import * as Pins from '../src/Pins.ts'
import * as Protocol from '../src/Protocol.ts'
import * as Result from '../src/Result.ts'
import * as Route from '../src/Route.ts'
import type * as Runs from '../src/Runs.ts'
import * as Sandbox from '../src/Sandbox.ts'
import * as Slot from '../src/Slot.ts'
import * as Subset from '../src/Subset.ts'
import * as Task from '../src/Task.ts'
import * as Timeline from '../src/Timeline.ts'
import * as Unsound from '../src/Unsound.ts'
import * as Doctor from './Doctor.ts'
import * as Import from './Import.ts'
import * as Login from './Login.ts'
import * as Plan from './Plan.ts'
import * as Revision from './Revision.ts'
import * as Runtime from './Runtime.ts'
import * as Watch from './Watch.ts'

const usage = `nanoeval <command>

  help      [COMMAND]
            Print the usage of one command, or of every command. COMMAND --help prints the
            same.
  doctor    [--backend krun|ns|dir] [--url URL --token T]
            Check this machine for what a run needs, and print under each thing it lacks the
            one command that gives it: Node and the pinned packages, the pinned hand, for
            krun slots /dev/kvm, libkrunfw, mke2fs, passt and the launcher, for ns slots
            root and their tools, the memory a runner admits rows by, the free disk where
            blobs, disks, layers and the lab go, Docker Hub and the pulls it has left for
            this address, and a model credential: of the Worker when one is named, of this
            shell otherwise. A shell with none is missing one, so a machine check ends
            ready only with one exported. A base URL that this shell names for a model
            (ANTHROPIC_BASE_URL, OPENAI_BASE_URL) is asked, and is missing when nothing
            answers there. Without --backend it checks for the slots a runner takes by
            itself here: krun where the machine has /dev/kvm, ns as root, dir otherwise.
            It exits 0 when nothing is missing and 1 when something is.
  sandboxd  --token T [--host 127.0.0.1] [--port 8788] [--root output/sandboxes]
            [--exec-timeout-ms 600000]
            [--ca-bundle FILE] [--slot-env FILE] [--slot-forward ADDRESS:PORT...]
            [--store DIR] [--cache DIR]
            Serve this machine as a local sandbox provider: a run starts one task runner in
            each sandbox it opens here. With --ca-bundle, slots trust that certificate bundle,
            for a machine whose network re-signs TLS. With --slot-env, they start with the
            variables of that file. With --slot-forward, a slot on a private network reaches
            that listener on this machine's loopback at the same address, and the names that
            this machine's /etc/hosts gives the address are in the slot's. --store names the
            directory blob store its runners read, and --cache where they keep verified blobs
            and unpacked environment disks.
  worker    --token T [--host 127.0.0.1] [--port 8787] [--state output/worker] [--tick-ms 500]
            [--sandbox-url URL --sandbox-token T] [--claude-login FILE] [--codex-login FILE]
            [--public-url URL] [--nanocode-ts DIR]
            Run the Worker under local workerd. Model API keys and base URLs are taken from
            ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN (sent as a bearer token),
            ANTHROPIC_BASE_URL, OPENAI_API_KEY and OPENAI_BASE_URL, and TEMPO_KEY with
            TEMPO_GATEWAY_URL pays for the models of both providers and for the sandboxes of
            run --provider gateway where a provider has no key of its own. A login
            file (~/.claude/.credentials.json, ~/.codex/auth.json) makes that provider's
            agents run on the plan signed in there. The Worker asks this command for the
            token of each model request, and the command refreshes the login as its tool
            does, when the token ends within five minutes and once when the provider
            rejects it, and writes the file back in the tool's format. --public-url
            names the address that runners and hands on other machines dial, such as a
            tunnel in front of this Worker. --nanocode-ts, or NANOEVAL_NANOCODE_TS, names
            the directory of a built nanocode-ts package that the Worker bundles in place
            of the pinned one, as nanoeval revision builds it: runs created on it record
            NANOEVAL_NANOCODE_TS_REVISION as their harness, or the WASM build of the package.
            PLAN_SECRET, which seals a plan signed in with nanoeval plans, is taken from the
            environment, or made once and kept in a private file of the state directory.
  plan      refresh [--codex-login FILE] [--claude-login FILE] [--within-sec 21600]
            [--secret-command CMD [--relay-url-file FILE] [--pushed FILE]]
            Refresh each named plan login with its refresh token when its token ends within
            --within-sec, and write the new tokens back to the file as its tool does:
            ~/.codex/auth.json when no file is named. A login that is signed out ends the
            command with 1 and a line that says so. With --secret-command,
            run CMD with sh for each of CHATGPT_ACCESS_TOKEN, CHATGPT_ACCOUNT_ID and, from
            --relay-url-file, CHATGPT_RELAY_URL whose value changed since the last push:
            the name in NANOEVAL_SECRET_NAME and the value on standard input, such as
            'wrangler secret put "$NANOEVAL_SECRET_NAME"'. --pushed keeps a SHA-256 of each
            value pushed (~/.config/nanoeval/plan-pushed.json).
  plans     --url URL --token T [sign-in claude | complete [--code CODE] | sign-out claude]
            Print whether a Claude plan is signed in on the Worker, or change that. sign-in
            prints the page of Claude to open. The code that page shows once you approve
            goes to complete, as --code or on standard input; on a terminal sign-in asks
            for it itself. The Worker keeps the sign-in sealed with its PLAN_SECRET,
            refreshes its token when a request needs one, and pays with it for the sessions
            of run --payer plan. Whether a subscription may be used this way is governed by
            the terms of its provider.
  datasets  List the datasets that import knows, with the source each is pinned to and what
            was run end to end.
  import    --url URL --token T (DATASET | --task DIR...) [--eval NAME] [--only ID]... [--limit N]
            [--backend krun|ns|dir] [--store DIR|r2] [--cache DIR] [--layers DIR] [--sources DIR]
            [--report FILE] [--keep-going] [--pull-wait SEC]
            [--ca-bundle FILE] [--slot-env FILE] [--slot-forward ADDRESS:PORT...]
            Import a dataset, or local task directories, as a version of a durable eval:
            the adapter writes each task, its instruction, tests and solution become blobs
            kept apart, and its environment is converted once into the disk a slot boots
            (krun and ns) or kept as files (dir). Blobs go to a directory store (--store DIR,
            ~/.local/share/nanoeval/store) or to R2 through the Worker (--store r2). The
            layers of the images it reads from their registries are kept in --layers
            (CACHE/oci), so a later import downloads none of them again. The eval is named
            after the dataset unless --eval names it. --report writes the time each
            task took in the adapter, the conversion, the packing and the upload. With
            --keep-going, a task whose environment does not convert is named and left out,
            and the rest become the version. --limit N takes the first N tasks in the order
            of their ids, which is the order run --limit counts in. The RUN steps of a
            task's Dockerfile get the host policy that slots get, from --ca-bundle,
            --slot-env and --slot-forward or from NANOEVAL_CA_BUNDLE, NANOEVAL_SLOT_ENV and
            NANOEVAL_SLOT_FORWARD, and the disk keeps none of it. A registry that limits
            pulls (429) fails the conversion with what it said. --pull-wait SEC, or
            NANOEVAL_PULL_WAIT_SEC, waits that long for it first.
  import    DATASET --out DIR [--only ID]... [--limit N] [--sources DIR]
            Write the dataset's tasks as Harbor task directories instead, with dataset.json.
  evals     --url URL --token T
            List the imported evals, each with its latest version and its count of tasks.
  eval      --url URL --token T NAME[@DIGEST] [--subsets FILE]
            List the versions and the tasks of one eval, with the subsets that
            subsets.json names for it.
  run       --url URL --token T (--eval NAME[@DIGEST] [--only TASK]... [--only-file FILE]...
            [--subset NAME]... [--subsets FILE] [--limit N] | --task DIR...
            | --rerun RUN [--failed] [--errored] [--only TASK]... [--agent ID]...)
            [--baseline RUN|latest]... [--with-reruns] [--unlike]
            [--fail-on regression|lost|any-failure]...
            (--agent ID=HARNESS:MODEL[:THINKING]... | --oracle) [--judge PROVIDER:MODEL[:THINKING]]
            [--attempts 1] [--provider local|e2b|gateway] [--backend auto|krun|ns|dir] [--slots 4]
            [--sandboxes 1] [--memory-mb N] [--network private|host] [--template NAME]
            [--sandbox-timeout-sec N] [--sandbox-lease-sec 300] [--runtime | --runtime-blob SHA256]
            [--sandbox-budget-usd 0] [--model-budget-usd N] [--setup-sec 600] [--attach-sec 60]
            [--lease-sec 60] [--claims 3] [--step-retries 3] [--poll-ms 250]
            [--disks keep|remove] [--free-disk-mb N] [--verifier-cache] [--name NAME] [--wait]
            [--key-deposit N] [--key-top-up N]
            [--out DIR] [--location HINT] [--warm-sec N [--warm-budget-usd 0]]
            [--payer deployment|plan]
            Create the rows of a run, task x agent x attempt, against one version of an eval.
            --only names a task by its id, by its name as status prints it, or by a pattern
            with * and ?, which takes every task whose id or name it matches. --only-file
            reads such names from a file, one a line, # starts a comment. --subset takes the
            tasks listed under that name for the eval in subsets.json of this checkout
            (--subsets FILE or NANOEVAL_SUBSETS for another file), which holds
            {"EVAL": {"SUBSET": ["task", ...]}}. The three add up, --limit then takes the
            first N of them, and a name or a pattern that finds no task is refused.
            Task runners claim the rows: the run starts one in each sandbox it opens
            (--sandboxes, with --slots attempts at once each), and nanoeval runner attaches
            more from any machine. --sandboxes 0 waits for attached runners only. With
            --backend auto, the default, each runner boots environment disks in microVMs
            (krun) where its machine has KVM and in namespaces (ns) where it has root. A task
            that closes the network of its agent or verifier needs --backend krun. --task
            imports the directories into the eval named local first. --rerun makes a run of
            the attempts of RUN that did not pass, each pointing at the attempt it retries,
            on the same eval version and agents and with the same attempt numbers. --failed
            or --errored narrows it to those, both together are every attempt that did not
            pass, --only to the tasks named, and --agent ID to the attempts of those agents
            of RUN. It is refused with --eval, --task, --limit, --oracle or --attempts,
            which it takes from RUN. It takes the budgets, the limits and the sandbox
            settings of RUN wherever the command names none: --model-budget-usd,
            --sandboxes, --slots, --setup-sec and the rest. --sandbox-timeout-sec and the
            runtime are not taken over.
            A row whose runner stops answering for --lease-sec is claimable again, at most
            --claims times in all, and then ends as an error. Rows are claimed longest
            timeouts first. A row that no runner could take for --setup-sec ends as an
            error when the run opens no sandbox itself: no runner is attached, or the
            sandbox of every runner ends before the timeouts of the row do.
            A model request whose payment is refused in passing is sent again, at most
            --step-retries times. One that is refused because the key or its channel is
            spent waits and is sent again, and no row starts while it waits; one still
            refused after --setup-sec ends its row as a budget error, and every row not yet
            started with it. The run ends the turn of such a row itself, and the turn of a
            session that is answered nothing but 401, 402, 403 or 404 for --setup-sec, so
            neither holds its slot to its agent timeout. --key-deposit and --key-top-up
            set the deposit that the channel of the Worker's TEMPO_KEY opens with and each
            automatic top-up, in the key's token, when the run is created: size them for
            one hold of every model request the run may have in flight at once.
            --model-budget-usd bounds the model spend of the run. Every model request is
            admitted before it is sent: none once the budget is spent, and under it only
            while the requests in flight, each taken to cost what the largest response of
            the run did, leave room. A request without room waits, at most --lease-sec, and
            is refused then. A row that is refused a request ends as a budget error, and so
            does every row not yet started once the budget is spent. The run passes its
            budget by less than one request. Where responses carry no cost, on a plan or a
            key of a provider, the spend is what sessions estimate when their attempts end,
            and only the provider's web searches, at list price, count request by request.
            With --disks remove, the default for --provider e2b and gateway, a runner removes
            each environment disk it unpacked once no row of the run needs it. With --free-disk-mb, a runner claims only while its
            machine has that much free disk, and prepares one environment at a time.
            With --verifier-cache, the verifier of a krun or ns slot finds what uv downloaded for
            the same task on this machine before, when an oracle run with the option kept it.
            An agent's HARNESS is claude or codex, a nanocode session outside the slot,
            claude-code or codex-cli, that vendor's command line inside the slot: a pinned
            release that the runner fetches once, pointed at an endpoint of the run that adds
            the model credential, so none enters the slot. nanocode-codex and nanocode-claude
            run nanocode exec with that harness inside the slot the same way, from the slot's
            runtime nanocode (NANOEVAL_NANOCODE on the runner names another build).
            A claude, codex, codex-direct or codex-jobs HARNESS followed by +preflight (nanoxp=codex+preflight:
            gpt-6-luna:high) has the runner probe the slot once before the first turn (tools on
            PATH and their versions, CPUs, memory, free disk, OS, whether pypi.org answers) and
            puts what it printed before the instruction, in an <environment_facts> block.
            fx, opencode and pi are named with the API their model is asked over, as in fx-chat
            (chat completions), fx-messages (Anthropic Messages) or fx-responses (OpenAI
            Responses), since their command lines speak all three and the run adds the
            credential of that provider.
            With --payer plan, the Claude plan signed in on the Worker (nanoeval plans) pays
            for the sessions of the run, its judge included, in place of the Worker's own
            credential: its agents and its judge are claude sessions, nothing is charged per
            response, and the model spend that is recorded and that --model-budget-usd
            bounds is what the sessions estimate from their tokens at list prices. The run
            is refused while no plan is signed in. Once the plan gives no credential any
            more, the rows that asked end as environment errors and no row is started.
            With --oracle no model runs: each task's solution is run in its slot, then the
            verifier. --judge names the model that answers the verifiers of judged tasks.
            With --wait, poll until the run finishes, print the summary and write the Harbor
            job to --out, or under NANOEVAL_RUNS_DIR when that is set. It then exits 0 when
            no attempt errored, also when attempts failed, and 1 when one errored or was
            cancelled. Without --wait it exits 0 once the run is created. A command that
            is refused exits 1, and an unknown command 2. With --wait, --baseline RUN
            (repeat it for the reruns of the baseline, or add --with-reruns for every rerun
            the baseline has) sets the run against that run as compare --baseline does.
            --baseline latest takes the latest finished run of the same eval version that
            ran on the builds this checkout pins, was not cancelled, is no rerun, and holds
            the tasks and the agents of this run, whatever they were named there, paid for
            as the Worker pays now. A baseline whose agent is another model, has another
            effort typed, or was paid for another way is refused before the run is made:
            --unlike compares them anyway and marks the comparison. A transport, a host or
            an effort that only the sessions reported and that differs is said above the
            comparison, which is made. --fail-on makes the exit status a gate:
            regression exits 3 when the verdict against the baseline is a regression,
            lost exits 3 also when a single task is lost, any-failure exits 4 when an
            attempt failed or errored. 3 goes before 4, and 4 before 1.
            An e2b sandbox is paid for its whole lifetime when it is opened, 3600 s at most:
            without --sandbox-timeout-sec the run takes the longest its rows can keep its
            slots busy, from the setup, agent and verifier timeouts of their tasks, up to
            that. A sandbox takes a row only while the timeouts of the row end before it
            does, and the run opens another for the rows that are left. A gateway sandbox is
            opened with the Worker's TEMPO_KEY and paid by the lease: --sandbox-lease-sec at
            first, and as much again whenever less than --lease-sec of it is left while rows
            need the sandbox, never past that lifetime. --runtime, which --provider e2b and
            gateway imply, publishes the runner as one archive in the Worker's blob store, so
            a sandbox without this checkout starts its runner from it. --runtime-blob names
            an archive that nanoeval runtime --publish put there before, for a machine that
            cannot build one. --location asks Cloudflare to keep the run in one of its
            regions (wnam, enam, weur, eeur, apac, oc, sam, afr, me) instead of the one
            nearest to this command: every call of a runner and every hand goes there, so
            name the region of the sandboxes. A Worker's RUN_LOCATION_HINT is its default.
            With --warm-sec, a sandbox the run opens is kept in the pool of the deployment
            for that long after the run is done with it, with its runner standing by and its
            disks unpacked, and a later run with the same provider, template, runtime,
            backend and network takes it instead of opening one. The pool renews its lease
            from --warm-budget-usd while it is idle and terminates it when the idle time or
            what is paid ends. Any run takes a sandbox that is kept, with or without the
            option.
  runner    --url URL --token T (--run RUN | --standing --backend krun|ns|dir [--location HINT])
            [--home DIR] [--ends-in-sec N]
            [--backend krun|ns] [--slots N] [--memory-mb N]
            [--free-disk-mb N] [--poll-ms N] [--store DIR] [--cache DIR]
            [--ca-bundle FILE] [--slot-env FILE] [--slot-forward ADDRESS:PORT...]
            Attach a task runner on this machine to a run: it claims rows up to its own
            capacity, fetches their blobs by digest, boots each environment disk under a
            copy-on-write disk of its own, and reports to the run until the run is finished.
            With --ends-in-sec, the machine is one that ends then: the runner takes a row
            only while the setup, agent and verifier timeouts of the row end before that, and
            leaves once no row that is left does.
            With --standing it attaches to the deployment instead: it sets its slots up once,
            waits in the pool, and a run created with --sandboxes 0 and its backend and
            network is handed to it the moment it is created. It serves several runs at
            once: their rows share its slots and its memory, and a run that is created
            while every slot is busy waits for the next free one. It enrols again when the
            pool closes it, and leaves the pool when it is stopped.
  pool      --url URL --token T [--close] [--location HINT]
            List the runners and sandboxes the deployment keeps between runs, and what it
            paid for them while no run had them. --close terminates the idle ones now. A
            deployment has one pool per region that a run or a standing runner names with
            --location, beside the one of its default: a run takes from the pool of its own.
  sandbox   --url URL --token T --run RUN --e2b FILE --sandbox-timeout-sec N [--opened-at TIME]
            [--backend krun|ns] [--slots N] [--memory-mb N] [--free-disk-mb N] [--poll-ms N]
            Attach a runner in an E2B sandbox that someone else opened and paid for: FILE is
            the answer of POST https://mpp.e2b.dev/sandboxes, with its sandboxID and
            envdAccessToken. The run must have been created with --runtime, through an
            address the sandbox reaches or on a Worker started with --public-url.
            --sandbox-timeout-sec is the timeout the sandbox was opened with, 3600 at most,
            counted from --opened-at or else from the time FILE was written: the runner is
            told when its sandbox ends, takes a row only while the timeouts of the row end
            before that, and leaves once no row that is left does. A row whose timeouts no
            sandbox of that length covers is taken in the first --setup-sec of a sandbox,
            and ends as an error, without another claim, if the sandbox ends first.
  runtime   --out FILE [--cache DIR] [--publish --url URL --token T]
            Build the archive a remote sandbox starts its runner from: the bundled runner,
            slot.sh, the static launcher, guest and relay, and the pinned hand. With
            --publish, put it in the Worker's blob store and print the SHA-256 that
            run --runtime-blob takes.
  version   --url URL --token T
            Print the protocol and the commit of the Worker and of this checkout. A runner
            and a Worker work together when their protocols are the same, and the command
            exits with status 1 when they are not. A Worker names its commit when it was
            deployed with --var COMMIT:$(git rev-parse HEAD).
  runs      --url URL --token T [--limit N]
            List the runs of the deployment, the newest first: id, state, counts, when it
            was created, its eval and its name. A run made by a Worker of a commit before
            this list existed is not in it.
  status    --url URL --token T RUN [--rows | --tasks] [--unsound FILE]
            Print the summary of a run: its eval and builds, who paid for the model of each
            agent and how its sessions reached it, the reruns it has, its counts and spend,
            one line an agent with outcomes, mean reward, pass@k, tokens and cost, a
            line for the judge where attempts were judged, and one line an attempt. RUN is
            the id of a run, the start of its id or its --name, here and wherever a command
            takes a run that exists: timeline, attempt, export, cancel, compare, oracle,
            run --rerun and --baseline. On a terminal too short for a line an attempt, one
            line a task with its pass counts instead:
            --rows lists every attempt, --tasks prints one line a task anywhere. Where the
            run holds tasks that the list of unsound tasks names (see oracle), each agent
            has a second line with its counts and pass@k over the sound tasks alone, and
            one line names the tasks set apart. run --wait and compare print the same.
  timeline  --url URL --token T RUN
            Print where the time of a run went: every mark the run and its runners recorded,
            by its offset from the creation of the run, with the span it measured.
  attempt   --url URL --token T RUN ATTEMPT [ARTIFACT]
            Print a row of a run: its phase, its claims, its result once it has ended, and
            the names of what can be read of it. With ARTIFACT, write that file to standard
            output. A row that is still running gives agent/events.jsonl and
            agent/trajectory.json as its session has them at that moment, and
            agent/model-requests.jsonl with the model requests that were answered.
  export    --url URL --token T RUN --out DIR
            Write the run as a Harbor job directory, and print where.
  compare   --url URL --token T [--baseline RUN|latest]... [--with-reruns] [--unlike]
            [--fail-on regression|lost|any-failure]... RUN...
            Print one table of the agents of these runs: attempts, outcomes, time, tokens and
            estimated cost per agent, and the outcome of every task per agent. Runs of one
            agent on different nanocode revisions are separate rows, and so are runs that
            hold the same rows; a run and its reruns are one row. With --baseline, each run
            (with the reruns of it that are named) is also set against the baseline, which
            is every run named with --baseline taken together, agent by agent: attempts,
            pass@k, also over the tasks both sides scored where those differ, tokens, cost,
            the pass counts of every task that moved, and a verdict. A task is lost or
            gained, and the verdict a regression or an improvement, only when pass counts
            that far apart have a chance of 0.05 or less under no change; otherwise a task
            moved within noise. A task whose attempts all errored on a side is not compared.
            An agent is set against the agent of the baseline that is the same harness and
            model at the same effort, whatever either was named, and against the one of its
            name otherwise. Sides that differ in model, in an effort that was typed or in
            who paid for the model are refused after the table: --unlike compares them
            anyway under a line that says how they differ. Where only the transport, the
            host or the effort that their sessions reported differ, which a revision of the
            harness can change, a line says so and the comparison is made. A side that
            records none of this is compared with a warning.
            --baseline latest is the latest finished run on the pinned builds that holds the
            tasks and agents of the runs named and was paid for and reached as they were, as
            for run, in whichever version of the eval holds those tasks unchanged. A task
            that is another task in the eval version of the baseline is left out and named.
            --with-reruns adds to every run named, and to the baseline, the reruns it has.
            --fail-on makes the exit status a gate, as for run: 3 for a regression (or, with
            lost, a lost task) of any of the runs, 4 with any-failure when an attempt of the
            runs that stands failed or errored, 0 otherwise.
  oracle    --url URL --token T RUN... [--with-reruns] [--unsound FILE]
            Check runs made with --oracle: the solution of every sound task has to pass its
            own verifier. A task is unsound when unsound.json of this checkout (--unsound
            FILE or NANOEVAL_UNSOUND for another file) lists the checksum of its version:
            {"DATASET": [{"task": ID, "checksum": "sha256:...", "reason": TEXT,
            "upstream": URL}, ...]}, one entry for each task whose own solution was shown not
            to pass, with the cause and the report filed where the dataset lives. Every
            other task is sound, a newer version of a listed task too. The runs named, or
            with --with-reruns every rerun they have as well, are read as they stand after
            their reruns. It prints how many sound tasks pass and each that does not, then
            the unsound ones with their outcome, reason and report, and exits 4 when the
            solution of a sound task failed or errored, and 0 otherwise.
  revision  [--nanocode REV|DIR|pinned] [--nanocode-ts REV|DIR|pinned] [--sdk REV|DIR|pinned]
            [--sdk-fallback pinned] [--lab DIR] [--hand-profile release]
            [--nanocode-repository URL|DIR] [--nanocode-ts-repository URL|DIR] [--build-only]
            [--baseline RUN|latest|previous|REV|DIR|pinned]... [--claude-login FILE]
            [--codex-login FILE] [--quiet] [--stop-sec 30]
            (--serve [--port N] | --quick | --eval NAME [--only ID]... [--limit N] | --task DIR...)
            (--agent ID=HARNESS:MODEL[:THINKING]... | --oracle) and the other options of run
            Evaluate a revision of nanocode on this machine without a release: build the hand
            from --nanocode (a commit, branch or tag of the repository, or a checkout with
            its uncommitted changes) and the nanocode-ts package of --nanocode-ts (master
            unless named) against it, start the Worker under local workerd on that package
            and on the state of the lab (--lab, NANOEVAL_LAB, DATA/nanoeval/lab), import the
            tasks the eval of the lab does not hold yet, create the run, attach a runner
            with the built hand (krun slots unless --backend says otherwise), wait, print
            the summary and write the Harbor job to LAB/runs/RUN. With --baseline, set the
            run against that run of the lab. pinned stands for what this checkout pins: the
            released hand, the released package, or for --sdk the nanocode revision that
            the nanocode-ts revision names itself. With --ca-bundle, the build of the package
            trusts that bundle too, as the slots do. --nanocode-ts pinned skips the build of
            the package for a change that only the hand runs. Without --nanocode the hand is
            the pinned one, and without both nothing is built: that run is the baseline of
            the pins. Builds are kept by revision in the lab, so a revision is built once.
            A nanocode from before 5f8b457de is refused when it is named: its hand does not
            know --own-processes, which a slot starts it with. With --sdk-fallback pinned, a
            package that does not build on the nanocode it is given is built on the one its
            nanocode-ts revision names itself, and the command and the run say so.
            One evaluation runs in a lab at a time, and the others wait in the order in
            which they were started. --baseline also takes previous, the run before this
            one in the lab, and a revision as --nanocode takes it (or pinned), the latest
            run on that hand: both are looked up when this evaluation has the lab, so an
            evaluation that waits names one that has not run yet. A baseline of another
            version of the lab's eval is compared on the tasks both hold unchanged, and
            the others are named. The model credential is the one nanoeval worker takes:
            the variables of this command, or --claude-login and --codex-login, or
            NANOEVAL_CLAUDE_LOGIN and NANOEVAL_CODEX_LOGIN. --limit counts in the tasks the
            lab holds. Standard error gets one line a phase with the time since the command
            began, and the count of rows that ended while the run goes on: --quiet leaves
            both out. The Worker and the runner of an evaluation are stopped with SIGTERM
            when it ends, and killed when they have not stopped --stop-sec seconds later.
            --quick is "did this change break anything": the subset quick of
            terminal-bench-2.1 in subsets.json (or --eval, --subset, --only), 3 attempts a
            task, the agents, model budget and slots of the latest quick run on the pinned
            builds that this lab recorded unless they are named, that run as the baseline,
            and --fail-on regression: 0 when nothing moved beyond noise, 3 on a regression.
            Without --nanocode it makes that run on the pinned builds, with nothing to build.
            --build-only builds and prints the variables that make nanoeval worker, nanoeval
            runner and npm run e2e use the builds. --serve builds and runs nothing: it
            answers runs, status, compare, attempt and export for the lab until it is
            interrupted, to be read only, from the Worker of the evaluation that runs or
            else from one of its own on the pinned package, and holds no evaluation up.
  cancel    --url URL --token T RUN
            Cancel a run: its rows that have not ended end as cancelled, and its sandboxes
            are closed.
  prune     [--dry-run] [--cache DIR]
            On this machine, remove the cached environment disks that no slot is using and
            the cached blobs.
  prune     layers --days N [--remove] [--layers DIR] [--cache DIR]
            List what the layer cache of imports (--layers, CACHE/oci) holds that no import
            used for N days: image layers, configs and manifests, and downloads abandoned
            that long ago, each with its size. With --remove, remove them. That is refused
            while an import converts an image from that cache.
  prune     store --url URL --token T [--remove] [--allow-empty] [--store DIR]
            List the blobs of a directory store that no version of any eval of the Worker
            names, and the files an import that died left staged, each with its size. With
            --remove, remove them. That is refused while an import writes to the store, and
            when the Worker names no blob of the store, unless --allow-empty says that
            emptying it is meant. Eval versions are never removed, and blobs in R2 are not
            pruned.
${Watch.usage}`

async function walk(
  root: string,
  directory = '',
): Promise<{ executable: boolean; path: string }[]> {
  const found: { executable: boolean; path: string }[] = []
  for (const entry of await Fs.readdir(Path.join(root, directory), { withFileTypes: true })) {
    const path = directory ? directory + '/' + entry.name : entry.name
    if (entry.isDirectory()) found.push(...(await walk(root, path)))
    else if (entry.isFile())
      found.push({ executable: ((await Fs.stat(Path.join(root, path))).mode & 0o111) !== 0, path })
  }
  return found
}

export async function readTask(root: string): Promise<Task.Source> {
  const entries = await walk(root)
  const files: Record<string, Uint8Array> = {}
  for (const entry of entries) files[entry.path] = await Fs.readFile(Path.join(root, entry.path))
  return {
    executable: entries.filter((entry) => entry.executable).map((entry) => entry.path),
    files,
  }
}

export async function loadTask(root: string, options: Task.load.Options = {}): Promise<Task.Task> {
  return Task.load(await readTask(root), options)
}

export function parseJudge(text: string): Config.Judge {
  const match = /^(claude|codex):([^:]+)(?::([a-z]+))?$/.exec(text)
  if (!match) throw new Error('a judge is PROVIDER:MODEL[:THINKING], not ' + text)
  return {
    model: match[2]!,
    provider: match[1] as Config.Judge['provider'],
    ...(match[3] ? { thinking: match[3] } : {}),
  }
}

export const oracle: Config.Agent = { id: 'oracle', model: 'solution', provider: 'oracle' }

const orchestrations: Record<string, Config.Orchestration> = {
  'codex-direct': 'direct',
  'codex-jobs': 'jobs',
}

export function parseAgent(text: string): Config.Agent {
  const match = new RegExp(
    '^([^=]+)=(' +
      ['claude', 'codex-direct', 'codex-jobs', 'codex', ...Installed.harnesses].join('|') +
      ')(\\+preflight)?:([^:]+)(?::([a-z]+))?(?::branches=([0-9]+))?$',
  ).exec(text)
  if (!match) throw new Error('an agent is ID=HARNESS:MODEL[:THINKING][:branches=N], not ' + text)
  const orchestration = orchestrations[match[2]!]
  const installed = Installed.harness(match[2]!)
  return {
    ...(installed?.api ? { api: installed.api } : {}),
    ...(match[6] ? { branches: Number(match[6]) } : {}),
    id: match[1]!,
    model: match[4]!,
    ...(orchestration ? { orchestration } : {}),
    ...(match[3] ? { preflight: true as const } : {}),
    provider: orchestration ? 'codex' : (installed?.kind ?? (match[2] as 'claude' | 'codex')),
    ...(match[5] ? { thinking: match[5] } : {}),
  }
}

export function rerunSelection(values: {
  attempts?: string | undefined
  errored: boolean
  eval?: string | undefined
  failed: boolean
  limit?: string | undefined
  oracle: boolean
  task?: readonly string[] | undefined
}): Ledger.Selection {
  const kept = (['attempts', 'eval', 'limit', 'oracle', 'task'] as const).filter((name) =>
    Array.isArray(values[name]) ? values[name].length : values[name],
  )
  if (kept.length)
    throw new Error(
      'a rerun keeps the eval and the attempt numbers of its run: leave out --' +
        kept.join(' and --') +
        ', and narrow it with --failed, --errored, --only or --agent',
    )
  return values.failed === values.errored ? 'unpassed' : values.failed ? 'failed' : 'errored'
}

function subsetsFile(named: string | undefined): string {
  return Path.resolve(
    named ??
      process.env['NANOEVAL_SUBSETS'] ??
      Path.join(import.meta.dirname, '..', 'subsets.json'),
  )
}

export async function unsoundList(named: string | undefined): Promise<Unsound.List> {
  const chosen = named ?? process.env['NANOEVAL_UNSOUND']
  const file = Path.resolve(chosen ?? Path.join(import.meta.dirname, '..', 'unsound.json'))
  const text = await Fs.readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' && chosen === undefined) return undefined
    throw new Error('the list of unsound tasks ' + file + ' cannot be read: ' + error.message)
  })
  return text === undefined ? {} : Unsound.parse(text, file)
}

type Api = ReturnType<typeof client>

const digested = new Map<string, Promise<Record<string, string>>>()

function digests(
  api: Api,
  reference: { name: string; version: string },
): Promise<Record<string, string>> {
  const key = reference.name + '@' + reference.version
  let found = digested.get(key)
  if (!found) {
    found = api
      .eval(key)
      .then((held) => Object.fromEntries(held.entries.map((entry) => [entry.name, entry.digest])))
    digested.set(key, found)
  }
  return found
}

async function results(api: Api, id: string): Promise<Compare.Run> {
  const run = await api.results(id)
  return { ...run, digests: await digests(api, run.eval) }
}

async function candidate(api: Api, id: string): Promise<Baseline.Candidate> {
  const [config, status] = await Promise.all([api.config(id), api.status(id)])
  const held = await digests(api, status['eval'])
  return {
    cancelled: Boolean(status['cancelled']),
    eval: status['eval'],
    id,
    members: Compare.planned(config.agents, {
      routes: (agent) => (status['agents']?.[agent.id]?.routes ?? []) as Route.Route[],
      run: id,
    }),
    nanocode: status['nanocode'] ?? { hands: [], harness: null },
    rerun: Boolean(config.rerun),
    state: status['state'],
    tasks: Object.fromEntries(
      [...new Set((status['attempts'] as { task: string }[]).map((attempt) => attempt.task))].map(
        (name) => [name, held[name] ?? ''],
      ),
    ),
  }
}

async function withReruns(api: Api, ids: readonly string[]): Promise<string[]> {
  const found: string[] = []
  const add = async (id: string): Promise<void> => {
    if (found.includes(id)) return
    found.push(id)
    for (const rerun of ((await api.status(id))['reruns'] ?? []) as string[]) await add(rerun)
  }
  for (const id of ids) await add(id)
  return found
}

export async function pins(): Promise<{ hand: string; harness: string }> {
  const manifest = JSON.parse(
    await Fs.readFile(Path.join(import.meta.dirname, '..', 'package.json'), 'utf8'),
  ) as { dependencies: Record<string, string> }
  return {
    hand: Pins.release(Slot.runtime.release),
    harness: Pins.pinned(manifest.dependencies['nanocode-ts']!),
  }
}

async function baselines(
  api: Api,
  input: {
    hand?: ((revision: string) => Promise<string>) | undefined
    named: readonly string[]
    reruns: boolean
    wanted: () => Promise<Omit<Baseline.Wanted, 'rule'>>
  },
): Promise<Compare.Run[]> {
  const ids: string[] = []
  for (const name of input.named) {
    const kind = Baseline.named(name)
    if (kind === 'id' || (kind === 'revision' && !input.hand)) {
      ids.push(await runId(api, name))
      continue
    }
    const begun = kind === 'revision' ? begins(name, (await api.runs()).runs) : undefined
    if (begun) {
      ids.push(begun)
      continue
    }
    const wanted: Baseline.Wanted = {
      ...(await input.wanted()),
      rule:
        kind === 'latest'
          ? { kind, pins: await pins() }
          : kind === 'previous'
            ? { kind }
            : { hand: await input.hand!(name), kind },
    }
    const listed = (await api.runs()).runs.filter(
      (run) => run.state === 'finished' && run.eval.name === wanted.eval.name,
    )
    const found = await Baseline.find(wanted, {
      ids: listed.map((run) => run.id),
      read: (id) => candidate(api, id),
    })
    const unpaid = wanted.members.filter(
      (member) => member.agent.provider !== 'oracle' && !member.routes.some((route) => route.payer),
    )
    console.error(
      'baseline: ' +
        found.id +
        ', ' +
        Baseline.said(wanted, found) +
        (unpaid.length
          ? '. Who pays for the model of ' +
            unpaid.map((member) => member.label).join(' and ') +
            ' is not recorded, so the model route was not compared'
          : wanted.members.some((member) => member.routes.length)
            ? ', on the same model route'
            : ''),
    )
    ids.push(found.id)
  }
  const all = input.reruns ? await withReruns(api, ids) : ids
  return Promise.all(all.map((id) => results(api, id)))
}

export function agentText(agent: Config.Agent): string {
  return (
    agent.id +
    '=' +
    (agent.orchestration ? agent.provider + '-' + agent.orchestration : Installed.name(agent)) +
    (agent.preflight ? '+preflight' : '') +
    ':' +
    agent.model +
    (agent.thinking ? ':' + agent.thinking : '') +
    (agent.branches ? ':branches=' + agent.branches : '')
  )
}

export type Gate = 'any-failure' | 'lost' | 'regression'

export function gates(named: readonly string[] | undefined): Set<Gate> {
  const known: readonly string[] = ['any-failure', 'lost', 'regression']
  const found = (named ?? []).flatMap((value) => value.split(','))
  for (const name of found)
    if (!known.includes(name))
      throw new Error('--fail-on takes regression, lost or any-failure, not ' + name)
  return new Set(found as Gate[])
}

export function exitStatus(input: {
  changes: readonly Compare.Change[]
  counts: { errored: number; failed: number }
  on: ReadonlySet<Gate>
  waited: boolean
}): number {
  const { on } = input
  if (
    (on.has('regression') || on.has('lost')) &&
    Compare.regressed(input.changes, on.has('lost') ? 'lost' : 'regression')
  )
    return 3
  if (on.has('any-failure') && (input.counts.failed || input.counts.errored)) return 4
  return input.waited && input.counts.errored ? 1 : 0
}

function judged(changes: readonly Compare.Change[], on: ReadonlySet<Gate>): void {
  if (!on.has('regression') && !on.has('lost')) return
  if (!changes.length)
    throw new Error(
      '--fail-on ' + [...on].join(',') + ' needs a baseline: name one with --baseline',
    )
  const blind = changes.filter((change) => !change.overall.tasks)
  if (blind.length)
    throw new Error(
      '--fail-on ' +
        [...on].join(',') +
        ' cannot be judged: the baseline and the run share no scored task of ' +
        blind.map((change) => change.agent).join(' and '),
    )
}

export function client(options: { token: string; url: string }) {
  const base = options.url.replace(/\/+$/, '')
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(base + path, {
      ...init,
      headers: { ...init.headers, authorization: 'Bearer ' + options.token },
    })
    if (!response.ok)
      throw new Error(path + ' answered ' + response.status + ': ' + (await response.text()))
    return response
  }
  return {
    attach: async (run: string, body: Protocol.Attach = {}) =>
      (await (
        await call('/v1/runs/' + run + '/runners', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()) as Config.Runner,
    blob: async (digest: string): Promise<Eval.Blob> => {
      const head = await call('/v1/blobs/' + digest, { method: 'HEAD' })
      return { bytes: Number(head.headers.get('content-length')), digest }
    },
    config: async (run: string) =>
      (await (await call('/v1/runs/' + run + '/config')).json()) as Config.Config & {
        eval: { name: string; version: string }
      },
    eval: async (reference: string, options: { tasks?: boolean } = {}) =>
      (await (
        await call('/v1/evals/' + encodeURIComponent(reference) + (options.tasks ? '?tasks=1' : ''))
      ).json()) as { entries: Eval.Entry[]; tasks?: Eval.Task[]; version: Eval.Version },
    evals: async () =>
      (await (await call('/v1/evals')).json()) as {
        evals: { dataset: string; digest: string; name: string; tasks: number; updatedAt: number }[]
      },
    putVersion: async (
      name: string,
      body: {
        base?: string | null
        dataset: string
        source: Record<string, string>
        tasks: readonly Eval.Task[]
      },
    ) =>
      (await (
        await call('/v1/evals/' + encodeURIComponent(name), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json()) as { name: string; version: Eval.Version },
    versions: async (name: string) =>
      (await (await call('/v1/evals/' + encodeURIComponent(name) + '/versions')).json()) as {
        versions: Eval.Version[]
      },
    artifact: async (run: string, attempt: string, name: string) =>
      (
        await call(
          '/v1/runs/' + run + '/attempts/' + attempt + '/artifacts/' + encodeURIComponent(name),
        )
      ).text(),
    artifactBytes: async (run: string, attempt: string, name: string) =>
      new Uint8Array(
        await (
          await call(
            '/v1/runs/' + run + '/attempts/' + attempt + '/artifacts/' + encodeURIComponent(name),
          )
        ).arrayBuffer(),
      ),
    attempt: async (run: string, attempt: string) =>
      (await call('/v1/runs/' + run + '/attempts/' + attempt)).json() as Promise<
        Record<string, any>
      >,
    cancel: async (run: string) =>
      (await call('/v1/runs/' + run + '/cancel', { method: 'POST' })).json(),
    create: async (config: Config.Config, placement: { location?: string } = {}) =>
      (await (
        await call('/v1/runs' + (placement.location ? '?location=' + placement.location : ''), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(config),
        })
      ).json()) as { attempts: number; eval: { name: string; version: string }; id: string },
    harbor: async (run: string) =>
      (await (await call('/v1/runs/' + run + '/harbor')).json()) as Job,
    planComplete: async (code: string) =>
      (
        await call('/v1/plans/claude/complete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code }),
        })
      ).json(),
    planSignIn: async () =>
      (await (
        await call('/v1/plans/claude/sign-in', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).json()) as { authorization_url: string; expires_at: number },
    planSignOut: async () => (await call('/v1/plans/claude', { method: 'DELETE' })).json(),
    plans: async () => (await (await call('/v1/plans')).json()) as { claude: Record<string, any> },
    pool: async (action?: 'close', location?: string) =>
      (
        await call(
          '/v1/pool' + (action ? '/close' : '') + (location ? '?location=' + location : ''),
          action ? { method: 'POST' } : {},
        )
      ).json() as Promise<Record<string, any>>,
    results: async (run: string) =>
      (await (await call('/v1/runs/' + run + '/results')).json()) as Compare.Run,
    routes: async (): Promise<Route.Deployment | undefined> => {
      const response = await fetch(base + '/v1/routes', {
        headers: { authorization: 'Bearer ' + options.token },
      })
      if (response.status === 404) return undefined
      if (!response.ok)
        throw new Error('/v1/routes answered ' + response.status + ': ' + (await response.text()))
      return (await response.json()) as Route.Deployment
    },
    runs: async (limit?: number) =>
      (await (await call('/v1/runs' + (limit === undefined ? '' : '?limit=' + limit))).json()) as {
        runs: Runs.Listed[]
      },
    standing: async (body: Protocol.Enrol, location?: string) => {
      const response = await fetch(
        base + '/v1/pool/members' + (location ? '?location=' + location : ''),
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + options.token,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      )
      if (response.ok) return (await response.json()) as Protocol.Standing
      const said =
        'the pool answered ' +
        response.status +
        ' to a runner that enrols: ' +
        (await response.text())
      throw response.status < 500 ? new Runner.RefusedError(said) : new Error(said)
    },
    status: async (run: string) =>
      (await call('/v1/runs/' + run)).json() as Promise<Record<string, any>>,
    version: async (): Promise<Protocol.Version | undefined> => {
      const response = await fetch(base + '/v1/version', {
        headers: { authorization: 'Bearer ' + options.token },
      })
      if (response.status === 404) return undefined
      if (!response.ok)
        throw new Error('/v1/version answered ' + response.status + ': ' + (await response.text()))
      return (await response.json()) as Protocol.Version
    },
    timeline: async (run: string) =>
      (await (await call('/v1/runs/' + run + '/timeline')).json()) as {
        createdAt: number
        id: string
        marks: Timeline.Mark[]
      },
  }
}

export type Job = {
  artifacts: { attempt: string; names: string[]; trial: string }[]
  files: Record<string, string>
}

export async function exportJob(
  api: ReturnType<typeof client>,
  options: { out: string; run: string },
): Promise<Job> {
  const write = async (path: string, contents: string | Uint8Array) => {
    const target = Path.join(options.out, path)
    await Fs.mkdir(Path.dirname(target), { recursive: true })
    await Fs.writeFile(target, contents)
  }
  const job = await api.harbor(options.run)
  for (const [path, contents] of Object.entries(job.files)) await write(path, contents)
  for (const entry of job.artifacts)
    for (const name of entry.names)
      await write(
        entry.trial + '/' + name,
        await api.artifactBytes(options.run, entry.attempt, name),
      )
  return job
}

function used(
  row: {
    cachedTokens: number
    costUsd: number | null
    inputTokens: number
    outputTokens: number
    reasoningTokens?: number | null
  },
  reasoning = false,
): string {
  return (
    'input tokens ' +
    Number(row.inputTokens).toLocaleString('en-US') +
    ' (' +
    Number(row.cachedTokens).toLocaleString('en-US') +
    ' cached), output tokens ' +
    Number(row.outputTokens).toLocaleString('en-US') +
    (reasoning
      ? ' (' +
        (row.reasoningTokens === undefined
          ? 'reasoning ' + Route.unrecorded
          : row.reasoningTokens === null
            ? 'reasoning not reported'
            : Number(row.reasoningTokens).toLocaleString('en-US') + ' reasoning') +
        ')'
      : '') +
    ', cost ' +
    (row.costUsd === null ? 'not known' : '$' + Number(row.costUsd).toFixed(4))
  )
}

export function shown(
  status: Record<string, any>,
  input: { height?: number; rows: boolean; tasks: boolean; unsound?: readonly string[] },
): string {
  const unsound = input.unsound ?? []
  const full = summary(status, { unsound })
  if (input.rows) return full
  if (input.tasks) return summary(status, { tasks: true, unsound })
  return input.height !== undefined && full.split('\n').length > input.height
    ? summary(status, { tasks: true, unsound }) +
        '\n(one line a task so that it fits the screen: --rows lists every attempt)'
    : full
}

export function summary(
  status: Record<string, any>,
  options: { tasks?: boolean; unsound?: readonly string[] } = {},
): string {
  const cancelled = (status['attempts'] as Record<string, any>[]).filter(
    (attempt) => attempt['failure']?.kind === 'cancelled',
  ).length
  const lines = [
    'run ' +
      status['id'] +
      ' (' +
      status['name'] +
      '): ' +
      status['state'] +
      (cancelled
        ? ', cancelled with ' + cancelled + (cancelled === 1 ? ' row' : ' rows') + ' not finished'
        : ''),
    'attempts: ' +
      Object.entries(status['counts'] as Record<string, number>)
        .map(([name, value]) => name + ' ' + value)
        .join(', '),
    'spend: model $' +
      Number(status['spend'].modelUsd).toFixed(4) +
      (status['spend'].modelBudgetUsd === undefined
        ? ''
        : ' of a budget of $' + status['spend'].modelBudgetUsd) +
      (!status['key'] && status['spend'].unpricedResponses ? ' estimated from tokens' : '') +
      (status['spend'].uncostedAttempts
        ? ', without ' +
          status['spend'].uncostedAttempts +
          (status['spend'].uncostedAttempts === 1 ? ' attempt' : ' attempts') +
          ' whose model calls have no cost'
        : '') +
      ', sandboxes $' +
      Number(status['spend'].sandboxUsd).toFixed(4) +
      (status['spend'].sandboxBudgetUsd
        ? ' of a budget of $' + status['spend'].sandboxBudgetUsd
        : ''),
  ]
  const usd = (value: unknown) => '$' + Number(value).toFixed(4)
  const offset = (at: unknown) =>
    '+' + ((Number(at) - Number(status['createdAt'])) / 1000).toFixed(0) + ' s'
  const key = status['key'] as Record<string, any> | null | undefined
  if (key?.['charged'])
    lines.push(
      'key charged: ' +
        usd(key['charged'].usd) +
        ' while the run ran, ' +
        usd(key['charged'].channelUsd) +
        ' through its channel and ' +
        usd(key['charged'].outsideUsd) +
        ' outside it, against ' +
        usd(Number(status['spend'].modelUsd) + Number(status['spend'].sandboxUsd)) +
        ' recorded',
    )
  else if (key?.['error']) lines.push('key charged: not read: ' + String(key['error']))
  else if (key?.['start']) lines.push('key charged: read again when the run ends')
  if (key && status['spend'].unpricedResponses)
    lines.push(
      'responses without a cost: ' +
        status['spend'].unpricedResponses +
        ', so the recorded spend leaves them out',
    )
  if (status['spend'].webSearches) {
    const unpriced = Number(status['spend'].unpricedTools ?? 0)
    lines.push(
      'web searches and other tools run by the model provider: ' +
        status['spend'].webSearches +
        (status['spend'].toolsUsd === undefined
          ? ', counted in the recorded spend only where a response reported them in its cost'
          : (unpriced < status['spend'].webSearches
              ? ', ' + usd(status['spend'].toolsUsd) + ' of the model spend'
              : '') +
            (unpriced
              ? ', ' +
                unpriced +
                ' unpriced: nothing says what they cost, or whether the cost of their response holds it'
              : '')),
    )
  }
  if (status['payer'] === 'plan')
    lines.push(
      'payer: the Claude plan signed in on the Worker; nothing is charged per response, and the model spend is what the sessions estimate at list prices',
    )
  if (status['refused'])
    lines.push(
      (status['refused'].plan
        ? 'models: the plan gave no credential at '
        : 'models: payment refused at ') +
        offset(status['refused'].at) +
        ', no row is started after that: ' +
        String(status['refused'].message).slice(0, 300),
    )
  for (const runner of (status['runners'] ?? []) as Record<string, any>[])
    if (runner['error'])
      lines.push(
        'runner ' +
          runner['id'] +
          ' (' +
          runner['state'] +
          '): ' +
          String(runner['error']).slice(0, 300),
      )
    else if (runner['drained'] && runner['state'] === 'ready')
      lines.push('runner ' + runner['id'] + ' claims no more rows: ' + runner['drained'])
  const lost = status['lostClaim'] as Record<string, any> | undefined
  if (lost)
    lines.push(
      'claims lost: ' +
        status['lostClaims'] +
        ', and what their model calls cost is in the spend of the run and in the cost of no agent; the last, claim ' +
        lost['n'] +
        ' of ' +
        lost['attempt'] +
        ' on runner ' +
        lost['runner'] +
        ', ' +
        (lost['ending'] === 'expired' ? 'expired' : 'was ' + lost['ending']) +
        ' in the ' +
        lost['phase'] +
        ' phase' +
        (lost['error']
          ? ': ' + String(lost['error']).replace(/\s+/g, ' ').trim().slice(0, 300)
          : ''),
    )
  const opening = status['opening'] as Record<string, any> | null | undefined
  if (opening) {
    const open = ((status['sandboxes'] ?? []) as Record<string, any>[]).filter(
      (sandbox) =>
        ['ready', 'starting'].includes(sandbox['state']) ||
        (sandbox['state'] === 'creating' && sandbox['handle'] !== null),
    ).length
    const times = opening['failures'] + (opening['failures'] === 1 ? ' time' : ' times')
    lines.push(
      'sandboxes: ' +
        (open ? open + ' open; another' : 'none open; one') +
        ' could not be opened ' +
        times +
        ' since ' +
        offset(opening['since']) +
        (opening['closed']
          ? ', and no other is asked for after failures that do not pass'
          : ', and is asked for again at ' + offset(opening['nextAt'])) +
        (opening['endsAt'] === null
          ? ''
          : '; the rows that wait end as errors at ' +
            offset(opening['endsAt']) +
            ' unless one starts') +
        ': ' +
        String(opening['message']).replace(/\s+/g, ' ').trim().slice(0, 300),
    )
  }
  if (status['strandedAt'])
    lines.push(
      'rows wait since ' +
        offset(status['strandedAt']) +
        ' for a runner whose sandbox lives as long as their timeouts, and end as errors when none comes',
    )
  for (const [agent, row] of Object.entries(status['agents'] as Record<string, any>))
    lines.push(
      agent +
        ': passed ' +
        row.passed +
        '/' +
        row.attempts +
        ', errored ' +
        row.errored +
        (row.meanReward === null || row.meanReward === undefined
          ? ''
          : ', mean reward ' +
            Number(row.meanReward).toFixed(3) +
            (row.scored === undefined || row.scored === row.attempts
              ? ''
              : ' of ' + row.scored + ' scored')) +
        [
          ...Object.entries(row.passAtK as Record<string, number>).map(([k, value]) => {
            const rated = row.rated?.[k] as number | undefined
            return (
              'pass@' +
              k +
              ' ' +
              (value * 100).toFixed(1) +
              '%' +
              (rated === undefined || rated === row.tasks
                ? ''
                : ' of ' + rated + (rated === 1 ? ' task' : ' tasks'))
            )
          }),
          ...(row.inputTokens || row.outputTokens || row.costUsd !== null ? [used(row, true)] : []),
        ]
          .map((part) => ', ' + part)
          .join(''),
    )
  lines.push(...(options.unsound ?? []))
  const judges = Object.values(status['agents'] as Record<string, any>).flatMap((row) =>
    row.judge?.attempts ? [row.judge] : [],
  )
  if (judges.length) {
    const total = (name: string) => judges.reduce((sum, judge) => sum + Number(judge[name]), 0)
    lines.push(
      'judge: ' +
        total('attempts') +
        (total('attempts') === 1 ? ' attempt' : ' attempts') +
        ' judged, ' +
        used({
          cachedTokens: total('cachedTokens'),
          costUsd: judges.some((judge) => judge.costUsd !== null) ? total('costUsd') : null,
          inputTokens: total('inputTokens'),
          outputTokens: total('outputTokens'),
        }) +
        ', beside the agents and in the spend of the run',
    )
  }
  const start = Timeline.summary((status['start'] ?? {}) as Timeline.Start)
  if (start) lines.splice(3, 0, 'start: ' + start)
  if (status['eval'])
    lines.splice(1, 0, 'eval: ' + status['eval'].name + '@' + status['eval'].version)
  if (status['rerunOf'])
    lines.splice(2, 0, 'rerun of ' + status['rerunOf'].run + ' (' + status['rerunOf'].select + ')')
  if (status['reruns']?.length)
    lines.splice(
      status['rerunOf'] ? 3 : 2,
      0,
      'reruns: ' +
        (status['reruns'] as string[]).join(', ') +
        ' (compare --with-reruns reads this run as it stands after them)',
    )
  lines.splice(
    status['eval'] ? 2 : 1,
    0,
    ...(status['nanocode'] ? ['nanocode: ' + Pins.text(status['nanocode'] as Pins.Pins)] : []),
    ...Object.entries(status['agents'] as Record<string, any>).flatMap(([agent, row]) =>
      row.routes === undefined || row.routes.length
        ? ['model route of ' + agent + ': ' + Route.text(row.routes as Route.Route[] | undefined)]
        : [],
    ),
  )
  if (options.tasks) {
    const tasks = new Map<string, Record<string, any>[]>()
    for (const attempt of status['attempts'] as Record<string, any>[]) {
      const name = attempt['task'] + ' ' + attempt['agent']
      tasks.set(name, [...(tasks.get(name) ?? []), attempt])
    }
    for (const [name, attempts] of tasks) {
      const count = (outcome: string) =>
        attempts.filter((attempt) => attempt['outcome'] === outcome).length
      const errors = attempts.filter((attempt) => attempt['outcome'] === 'errored')
      const late = attempts.filter((attempt) => attempt['outcome'] && Result.timeout(attempt))
      const open = attempts.filter((attempt) => !attempt['outcome'])
      lines.push(
        '  ' +
          name +
          ' ' +
          (count('passed') + count('failed') || !errors.length
            ? count('passed') + '/' + (count('passed') + count('failed'))
            : '') +
          (late.length ? ' (' + late.length + ' ' + Result.afterTimeout + ')' : '') +
          (errors.length
            ? (count('passed') + count('failed') ? ' +' : '') +
              errors.length +
              ' errored (' +
              [...new Set(errors.map((attempt) => attempt['failure']?.kind ?? 'unknown'))]
                .sort()
                .join(', ') +
              ')'
            : '') +
          (open.length ? ' +' + open.length + ' not ended' : ''),
      )
    }
    return lines.join('\n')
  }
  for (const attempt of status['attempts'] as Record<string, any>[]) {
    const late = Result.timeout(attempt)
    const state = attempt['outcome'] ?? attempt['phase']
    lines.push(
      '  ' +
        [
          attempt['id'],
          attempt['task'],
          attempt['agent'],
          '#' + attempt['n'],
          late ? Result.late(state, late) : state,
          attempt['oomKills'] ? 'oom_kills=' + attempt['oomKills'] : '',
          attempt['claims'] > 1 ? 'claims=' + attempt['claims'] : '',
          attempt['retries'] ? 'retries=' + attempt['retries'] : '',
          attempt['retryOf']
            ? 'retries ' + attempt['retryOf'].run.slice(0, 8) + '/' + attempt['retryOf'].attempt
            : '',
          attempt['failure'] && !late
            ? attempt['failure'].kind +
              ': ' +
              String(attempt['failure'].message).replace(/\s+/g, ' ').trim().slice(0, 160)
            : '',
        ]
          .filter(Boolean)
          .join(' '),
    )
  }
  return lines.join('\n')
}

export async function importEval(
  api: ReturnType<typeof client>,
  input: {
    backend: Config.Backend
    cache: string
    cases: AsyncIterable<Dataset.Case>
    dataset: string
    layers: string
    log?(line: string): void
    name: string
    policy?: Converter.Policy
    refused?(id: string, error: Error): void
    source: Record<string, string>
    store: Store.Store
  },
): Promise<{ tasks: Eval.Task[]; timings: Import.Timing[]; version: Eval.Version }> {
  const held = await input.store.hold()
  try {
    const { tasks, timings } = await Import.cases(input.cases, {
      cache: input.cache,
      converter: Converter.create({
        home: Path.join(input.cache, 'converter'),
        layers: input.layers,
        ...(input.log ? { log: input.log } : {}),
        notice: (line) => console.error(line),
        ...(input.policy ? { policy: input.policy } : {}),
      }),
      format: Config.kind(input.backend),
      ...(input.log ? { log: input.log } : {}),
      ...(input.refused ? { refused: input.refused } : {}),
      store: input.store,
    })
    if (!tasks.length) throw new Error('the import selected no task')
    const { version } = await api.putVersion(input.name, {
      dataset: input.dataset,
      source: input.source,
      tasks,
    })
    return { tasks, timings, version }
  } finally {
    await held.release()
  }
}

function loginFiles(values: {
  'claude-login'?: string | undefined
  'codex-login'?: string | undefined
}): Partial<Record<Login.Kind, string>> {
  return {
    ...(values['claude-login'] ? { claude: Path.resolve(values['claude-login']) } : {}),
    ...(values['codex-login'] ? { codex: Path.resolve(values['codex-login']) } : {}),
  }
}

export function planSummary(claude: Record<string, any>): string {
  const time = (at: number) => new Date(at).toISOString()
  if (claude['state'] === 'authenticated')
    return (
      'claude plan: signed in as account ' +
      claude['account_id'] +
      ', with a token until ' +
      time(claude['expires_at']) +
      ' that the Worker refreshes when a request needs one'
    )
  if (claude['state'] === 'pending')
    return (
      'claude plan: a sign-in waits until ' +
      time(claude['expires_at']) +
      ' for its code: nanoeval plans complete --code CODE'
    )
  return 'claude plan: ' + claude['state'] + ': sign in with ' + Config.planSignIn
}

export function runsTable(runs: readonly Runs.Listed[]): string {
  return runs
    .map((run) =>
      [
        run.id,
        run.state,
        run.counts
          ? 'passed ' +
            run.counts.passed +
            ', failed ' +
            run.counts.failed +
            ', errored ' +
            run.counts.errored +
            ' of ' +
            run.counts.total +
            (run.state === 'running'
              ? ', active ' + run.counts.active + ', unclaimed ' + run.counts.unclaimed
              : '')
          : 'its counts were not read',
        'created ' + new Date(run.createdAt).toISOString(),
        run.eval.name + '@' + run.eval.version.slice(0, 12),
        run.name,
      ].join('  '),
    )
    .join('\n')
}

export function rerunConfig(
  own: Config.Config,
  input: { named: ReadonlySet<string>; parent: Config.Config },
): Config.Config {
  const { named, parent } = input
  const from = <T>(flag: string, mine: T, theirs: T): T => (named.has(flag) ? mine : theirs)
  const modelUsd = from('model-budget-usd', own.budget.modelUsd, parent.budget.modelUsd)
  const freeDiskMb = from('free-disk-mb', own.sandbox.freeDiskMb, parent.sandbox.freeDiskMb)
  const leaseSec = from('sandbox-lease-sec', own.sandbox.leaseSec, parent.sandbox.leaseSec)
  const memoryMb = from('memory-mb', own.sandbox.memoryMb, parent.sandbox.memoryMb)
  const template = from('template', own.sandbox.template, parent.sandbox.template)
  const warm = from('warm-sec', own.sandbox.warm, parent.sandbox.warm)
  return {
    ...own,
    budget: {
      ...(modelUsd === undefined ? {} : { modelUsd }),
      sandboxUsd: from('sandbox-budget-usd', own.budget.sandboxUsd, parent.budget.sandboxUsd),
    },
    limits: {
      attachSec: from('attach-sec', own.limits.attachSec, parent.limits.attachSec),
      claims: from('claims', own.limits.claims, parent.limits.claims),
      leaseSec: from('lease-sec', own.limits.leaseSec, parent.limits.leaseSec),
      setupSec: from('setup-sec', own.limits.setupSec, parent.limits.setupSec),
      stepRetries: from('step-retries', own.limits.stepRetries, parent.limits.stepRetries),
    },
    sandbox: {
      backend: from('backend', own.sandbox.backend, parent.sandbox.backend),
      disks: from('disks', own.sandbox.disks, parent.sandbox.disks),
      ...(freeDiskMb === undefined ? {} : { freeDiskMb }),
      ...(leaseSec === undefined ? {} : { leaseSec }),
      max: from('sandboxes', own.sandbox.max, parent.sandbox.max),
      ...(memoryMb === undefined ? {} : { memoryMb }),
      network:
        named.has('network') || named.has('backend') ? own.sandbox.network : parent.sandbox.network,
      pollMs: from('poll-ms', own.sandbox.pollMs, parent.sandbox.pollMs),
      provider: from('provider', own.sandbox.provider, parent.sandbox.provider),
      ...(own.sandbox.runtime ? { runtime: own.sandbox.runtime } : {}),
      slots: from('slots', own.sandbox.slots, parent.sandbox.slots),
      ...(template === undefined ? {} : { template }),
      ...(own.sandbox.timeoutSec === undefined ? {} : { timeoutSec: own.sandbox.timeoutSec }),
      ...(own.sandbox.verifierCache || parent.sandbox.verifierCache
        ? { verifierCache: true as const }
        : {}),
      ...(warm === undefined ? {} : { warm }),
    },
  }
}

export function checkout(): string | undefined {
  const head = spawnSync('git', [
    '-C',
    Path.resolve(import.meta.dirname, '..'),
    'rev-parse',
    'HEAD',
  ])
  return head.status === 0 ? head.stdout.toString().trim() : undefined
}

export function versions(worker: Protocol.Version | undefined): { agree: boolean; text: string } {
  const commit = checkout()
  return {
    agree: worker?.protocol === Protocol.version,
    text: [
      worker
        ? 'worker: protocol ' +
          worker.protocol +
          ', commit ' +
          (worker.commit ?? 'not named: deploy it with --var COMMIT:$(git rev-parse HEAD)')
        : 'worker: says no version, so it is of a commit before protocols had a number',
      'this checkout: protocol ' +
        Protocol.version +
        ', commit ' +
        (commit ?? 'not known: this is no git checkout'),
      worker?.protocol !== Protocol.version
        ? 'they do not work together: move both to one commit, the Worker first'
        : worker.commit && commit && worker.commit !== commit
          ? 'the commits differ and the protocol is the same'
          : undefined,
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

export function poolSummary(status: Record<string, any>): string {
  const time = (at: number | null) => (at === null ? 'never' : new Date(at).toISOString())
  const members = status['members'] as Record<string, any>[]
  return [
    'pool: ' +
      members.filter((member) => member['state'] === 'idle').length +
      ' idle, ' +
      members.filter((member) => member['state'] === 'assigned').length +
      ' with a run, spend $' +
      Number(status['spendUsd']).toFixed(4) +
      ', commit ' +
      (status['commit'] === undefined
        ? 'not said: its object runs the code of a commit before the pool said one'
        : (status['commit'] ?? 'not named: deploy it with --var COMMIT:$(git rev-parse HEAD)')),
    ...members.map(
      (member) =>
        '  ' +
        [
          'm' + member['id'],
          member['spec'].kind,
          member['spec'].provider,
          member['spec'].template,
          member['spec'].backend,
          member['state'],
          member['holding'] ? 'standing by' : undefined,
          member['run'] ? 'run ' + member['run'] : undefined,
          'runs ' + member['runs'],
          member['handle'],
          member['state'] === 'idle' && member['idleUntil'] !== null
            ? 'idle until ' + time(member['idleUntil'])
            : undefined,
          member['paidUntil'] === null ? undefined : 'paid until ' + time(member['paidUntil']),
          member['error'],
        ]
          .filter(Boolean)
          .join(' '),
    ),
    ...(status['payments'] as Record<string, any>[]).map(
      (payment) =>
        '  paid $' +
        Number(payment['usd']).toFixed(6) +
        ' for m' +
        payment['member'] +
        ' at ' +
        time(payment['at']) +
        ': ' +
        (JSON.parse(payment['detail']) as { description: string }).description,
    ),
  ].join('\n')
}

export function blobStore(
  name: string | undefined,
  api: { token: string; url: string },
): Store.Store {
  return name === 'r2'
    ? Store.remote({ base: api.url.replace(/\/+$/, '') + '/v1/blobs', token: api.token })
    : Store.directory(Path.resolve(name ?? Store.defaultRoot()))
}

async function main(
  lab?: Revision.Lab,
  given: { hand?: (revision: string) => Promise<string>; values?: Record<string, unknown> } = {},
): Promise<void> {
  const { positionals, tokens, values } = parseArgs({
    allowPositionals: true,
    tokens: true,
    options: {
      agent: { multiple: true, type: 'string' },
      'allow-empty': { default: false, type: 'boolean' },
      'attach-sec': { default: '60', type: 'string' },
      attempts: { type: 'string' },
      backend: { type: 'string' },
      baseline: { multiple: true, type: 'string' },
      'build-only': { default: false, type: 'boolean' },
      'ca-bundle': { type: 'string' },
      cache: { type: 'string' },
      claims: { default: '3', type: 'string' },
      close: { default: false, type: 'boolean' },
      'claude-login': { type: 'string' },
      code: { type: 'string' },
      'codex-login': { type: 'string' },
      config: { type: 'string' },
      days: { type: 'string' },
      detach: { default: false, type: 'boolean' },
      disks: { type: 'string' },
      'dry-run': { default: false, type: 'boolean' },
      e2b: { type: 'string' },
      'ends-in-sec': { type: 'string' },
      errored: { default: false, type: 'boolean' },
      eval: { type: 'string' },
      'exec-timeout-ms': { default: '600000', type: 'string' },
      help: { default: false, short: 'h', type: 'boolean' },
      'fail-on': { multiple: true, type: 'string' },
      failed: { default: false, type: 'boolean' },
      'free-disk-mb': { type: 'string' },
      'hand-profile': { default: 'release', type: 'string' },
      home: { type: 'string' },
      host: { default: '127.0.0.1', type: 'string' },
      judge: { type: 'string' },
      'keep-going': { default: false, type: 'boolean' },
      'key-deposit': { type: 'string' },
      'key-top-up': { type: 'string' },
      lab: { type: 'string' },
      layers: { type: 'string' },
      'lease-sec': { default: '60', type: 'string' },
      limit: { type: 'string' },
      location: { type: 'string' },
      'memory-mb': { type: 'string' },
      'model-budget-usd': { type: 'string' },
      name: { type: 'string' },
      nanocode: { type: 'string' },
      'nanocode-repository': { default: Revision.repositories.nanocode, type: 'string' },
      'nanocode-ts': { type: 'string' },
      'nanocode-ts-repository': { default: Revision.repositories.nanocodeTs, type: 'string' },
      network: { type: 'string' },
      only: { multiple: true, type: 'string' },
      'only-file': { multiple: true, type: 'string' },
      'opened-at': { type: 'string' },
      oracle: { default: false, type: 'boolean' },
      out: { type: 'string' },
      payer: { type: 'string' },
      'poll-ms': { type: 'string' },
      port: { type: 'string' },
      provider: { default: 'local', type: 'string' },
      'public-url': { type: 'string' },
      'pull-wait': { type: 'string' },
      'relay-url-file': { type: 'string' },
      publish: { default: false, type: 'boolean' },
      pushed: { type: 'string' },
      quick: { default: false, type: 'boolean' },
      quiet: { default: false, type: 'boolean' },
      remove: { default: false, type: 'boolean' },
      report: { type: 'string' },
      rerun: { type: 'string' },
      rows: { default: false, type: 'boolean' },
      root: { type: 'string' },
      run: { type: 'string' },
      runtime: { default: false, type: 'boolean' },
      'runtime-blob': { type: 'string' },
      'sandbox-budget-usd': { default: '0', type: 'string' },
      'sandbox-lease-sec': { type: 'string' },
      'sandbox-token': { default: process.env['NANOEVAL_SANDBOX_TOKEN'], type: 'string' },
      'sandbox-url': { type: 'string' },
      sdk: { type: 'string' },
      'sdk-fallback': { type: 'string' },
      serve: { default: false, type: 'boolean' },
      'sandbox-timeout-sec': { type: 'string' },
      sandboxes: { default: '1', type: 'string' },
      'secret-command': { type: 'string' },
      'setup-sec': { default: '600', type: 'string' },
      'slot-env': { type: 'string' },
      standing: { default: false, type: 'boolean' },
      'slot-forward': { multiple: true, type: 'string' },
      slots: { type: 'string' },
      sources: { type: 'string' },
      state: { type: 'string' },
      'step-retries': { default: '3', type: 'string' },
      'stop-sec': { default: '30', type: 'string' },
      store: { type: 'string' },
      subset: { multiple: true, type: 'string' },
      subsets: { type: 'string' },
      task: { multiple: true, type: 'string' },
      tasks: { default: false, type: 'boolean' },
      template: { type: 'string' },
      'tick-ms': { default: '500', type: 'string' },
      token: { default: process.env['NANOEVAL_TOKEN'], type: 'string' },
      unsound: { type: 'string' },
      url: { default: process.env['NANOEVAL_URL'], type: 'string' },
      'verifier-cache': { default: false, type: 'boolean' },
      wait: { default: false, type: 'boolean' },
      'warm-budget-usd': { default: '0', type: 'string' },
      'warm-sec': { type: 'string' },
      unlike: { default: false, type: 'boolean' },
      'with-reruns': { default: false, type: 'boolean' },
      'within-sec': { default: '21600', type: 'string' },
    },
  })
  const [named, ...rest] = positionals
  const screen = {
    ...(process.stdout.isTTY ? { height: process.stdout.rows } : {}),
    rows: values.rows,
    tasks: values.tasks,
  }
  const command = lab ? 'run' : named
  if (values.quick && command !== 'revision' && !lab)
    throw new Error('--quick is an option of nanoeval revision')
  if (lab)
    Object.assign(values, given.values, {
      backend: values.backend ?? 'krun',
      sandboxes: '0',
      token: lab.token,
      url: lab.url,
      wait: true,
    })
  if (!lab && (values.help || named === 'help')) {
    const topic = named === 'help' ? rest[0] : named
    const text = help(usage, topic)
    if (text === undefined) throw unknown(topic!)
    console.log(text)
    return
  }
  const required = (value: string | undefined, name: string): string => {
    if (!value) throw new Error((name === name.toUpperCase() ? name : '--' + name) + ' is required')
    return value
  }
  const seconds = (value: string, name: string): number => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0)
      throw new Error('--' + name + ' is a number of seconds above zero, not ' + value)
    return parsed
  }
  const hostPolicy = {
    ...(values['ca-bundle'] ? { NANOEVAL_CA_BUNDLE: Path.resolve(values['ca-bundle']) } : {}),
    ...(values.cache ? { NANOEVAL_CACHE: Path.resolve(values.cache) } : {}),
    ...(values['slot-env'] ? { NANOEVAL_SLOT_ENV: Path.resolve(values['slot-env']) } : {}),
    ...(values['slot-forward'] ? { NANOEVAL_SLOT_FORWARD: values['slot-forward'].join(' ') } : {}),
    ...(values.store ? { NANOEVAL_STORE: Path.resolve(values.store) } : {}),
  }

  if (command === 'sandboxd') {
    const server = await Sandboxd.start({
      env: hostPolicy,
      execTimeoutMs: Number(values['exec-timeout-ms']),
      host: values.host,
      port: Number(values.port ?? '8788'),
      root: values.root ?? Path.join(process.cwd(), 'output', 'sandboxes'),
      token: required(values.token, 'token'),
    })
    console.log('nanoeval sandboxd listening on ' + server.url)
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, () => void server.close().then(() => process.exit(0)))
    return
  }

  if (command === 'plan') {
    if (rest[0] !== 'refresh') throw new Error('plan has one command, refresh')
    const named = loginFiles(values)
    const files = Object.keys(named).length
      ? named
      : { codex: Path.join(Os.homedir(), '.codex', 'auth.json') }
    const urls = Login.urls(process.env)
    const refreshed: Partial<Record<Login.Kind, Login.Login>> = {}
    for (const kind of Object.keys(files).sort() as Login.Kind[]) {
      const { login, outcome } = await Login.refresh(kind, {
        path: files[kind]!,
        ...(urls[kind] ? { url: urls[kind] } : {}),
        withinMs: seconds(values['within-sec'], 'within-sec') * 1000,
      })
      refreshed[kind] = login
      console.log(
        (outcome === 'refreshed' ? 'refreshed: ' : 'kept: ') +
          Login.describe(kind, { login, path: files[kind]! }),
      )
    }
    if (!values['secret-command']) return
    if (!refreshed.codex)
      throw new Error('--secret-command pushes a ChatGPT login: name it with --codex-login')
    const pushed = await Plan.push(
      {
        CHATGPT_ACCESS_TOKEN: Logins.token(refreshed.codex.headers)!,
        CHATGPT_ACCOUNT_ID: refreshed.codex.headers['chatgpt-account-id']!,
        ...(values['relay-url-file']
          ? { CHATGPT_RELAY_URL: await Plan.relayUrl(Path.resolve(values['relay-url-file'])) }
          : {}),
      },
      {
        command: values['secret-command'],
        state: Path.resolve(
          values.pushed ?? Path.join(Os.homedir(), '.config', 'nanoeval', 'plan-pushed.json'),
        ),
      },
    )
    console.log(
      pushed.length ? 'pushed ' + pushed.join(', ') : 'nothing changed since the last push',
    )
    return
  }

  if (command === 'worker') {
    const vars: Record<string, string> = { ACCESS_TOKEN: required(values.token, 'token') }
    for (const name of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'NANOEVAL_REPLY_LIMIT',
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'TEMPO_GATEWAY_URL',
      'TEMPO_KEY',
    ])
      if (process.env[name]) vars[name] = process.env[name]
    if (values['sandbox-url']) {
      vars['LOCAL_SANDBOX_URL'] = values['sandbox-url']
      vars['LOCAL_SANDBOX_TOKEN'] = required(values['sandbox-token'], 'sandbox-token')
    }
    vars['TICK_MS'] = values['tick-ms']
    if (values['public-url']) vars['PUBLIC_URL'] = values['public-url']

    const files = loginFiles(values)
    const logins = Object.keys(files).length
      ? await Login.serve(files, {
          log: (line) => console.error(line),
          urls: Login.urls(process.env),
        })
      : undefined
    Object.assign(vars, logins?.vars)
    for (const kind of Object.keys(files).sort() as Login.Kind[])
      await logins!.current(kind).then(
        (login) =>
          console.error(
            Login.describe(kind, { login, path: files[kind]! }) +
              ': it is refreshed before that, and once when the provider rejects it',
          ),
        (error: unknown) => {
          if (!(error instanceof Login.RefusedError)) throw error
          console.error(
            'the agents of that login fail until it is signed in again, which needs no restart of this command',
          )
        },
      )
    const relay = values['codex-login'] ? await Plan.relay() : undefined
    Object.assign(vars, relay?.vars)
    const state = Path.resolve(values.state ?? Path.join('output', 'worker'))
    vars['PLAN_SECRET'] =
      process.env['PLAN_SECRET'] ?? (await Plan.secret(Path.join(state, 'plan.secret')))
    const harness = await Revision.wrangler({
      ...process.env,
      ...(values['nanocode-ts'] ? { NANOEVAL_NANOCODE_TS: values['nanocode-ts'] } : {}),
    })
    Object.assign(vars, harness.vars)

    const root = Path.resolve(import.meta.dirname, '..')
    const directory = await Fs.mkdtemp(Path.join(Os.tmpdir(), 'nanoeval-worker-'))
    const file = Path.join(directory, 'vars.env')
    await Fs.writeFile(file, Plan.envFile(vars), { mode: 0o600 })
    const child = spawn(
      process.execPath,
      [
        Path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
        'dev',
        '--ip',
        values.host,
        '--port',
        values.port ?? '8787',
        '--inspector-port',
        '0',
        '--persist-to',
        state,
        '--env-file',
        file,
        ...harness.arguments,
      ],
      { cwd: root, stdio: 'inherit' },
    )
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, () => child.kill(signal))
    const code = await new Promise<number>((resolve) =>
      child.once('exit', (exit) => resolve(exit ?? 1)),
    )
    await relay?.close()
    await logins?.close()
    await Fs.rm(directory, { force: true, recursive: true })
    process.exit(code)
  }

  if (command === 'revision') {
    const claude = values['claude-login'] ?? process.env['NANOEVAL_CLAUDE_LOGIN']
    const codex = values['codex-login'] ?? process.env['NANOEVAL_CODEX_LOGIN']
    const logins = {
      ...(claude ? { claude: Path.resolve(claude) } : {}),
      ...(codex ? { codex: Path.resolve(codex) } : {}),
    }
    const directory = Path.resolve(values.lab ?? Revision.defaultLab())
    const progress = Revision.progress({
      live: Boolean(process.stderr.isTTY),
      now: Date.now,
      quiet: values.quiet,
      write: (text) => void process.stderr.write(text),
    })
    const log = progress.line
    const pollMs = Number(values['poll-ms'] ?? '250')
    const stopSec = seconds(values['stop-sec'], 'stop-sec')
    if (values['sdk-fallback'] !== undefined && values['sdk-fallback'] !== Revision.pinned)
      throw new Error(
        '--sdk-fallback takes pinned, the nanocode that the nanocode-ts revision names itself, not ' +
          values['sdk-fallback'],
      )
    if (values.serve) {
      const served = await Revision.serve({
        lab: directory,
        log,
        logins,
        pollMs,
        ...(values.port ? { port: Number(values.port) } : {}),
        stopSec,
      })
      for (const signal of ['SIGINT', 'SIGTERM'] as const)
        process.once(signal, () => void served.close().then(() => process.exit(1)))
      console.log(
        'the lab is served to be read until this command is interrupted, beside the evaluations that run in it: NANOEVAL_URL=' +
          served.url +
          ' NANOEVAL_TOKEN=$(cat ' +
          Path.join(directory, 'token') +
          ')',
      )
      await new Promise(() => {})
    }
    const quick: Record<string, unknown> = {}
    if (values.quick) {
      const refused = (['build-only', 'rerun', 'task'] as const).filter((name) =>
        Array.isArray(values[name]) ? values[name].length : values[name],
      )
      if (refused.length)
        throw new Error(
          '--quick picks the tasks, the attempts and the baseline of a new run: leave out --' +
            refused.join(' and --'),
        )
      const name = (values.eval ?? Revision.quick.eval).split('@')[0]!
      const planned = Revision.plan({
        ...(values.nanocode ? { nanocode: values.nanocode } : {}),
        ...(values['nanocode-ts'] ? { nanocodeTs: values['nanocode-ts'] } : {}),
        ...(values.sdk ? { sdk: values.sdk } : {}),
      })
      const builds = planned.hand !== undefined || planned.package !== undefined
      const latest = Revision.standard(await Revision.recorded(directory), {
        eval: name,
        pins: await pins(),
      })
      const once =
        'nanoeval revision --quick --agent ID=HARNESS:MODEL makes one, with nothing to build'
      Object.assign(quick, {
        attempts: values.attempts ?? String(Revision.quick.attempts),
        eval: values.eval ?? Revision.quick.eval,
      })
      if (
        !values.only?.length &&
        !values['only-file']?.length &&
        !values.subset?.length &&
        !values.limit
      )
        quick['subset'] = [Revision.quick.subset]
      if (builds && !values.baseline?.length) {
        if (!latest)
          throw new Error(
            '--quick sets a revision against the latest quick run of ' +
              name +
              ' on the pinned builds, and this lab has none: ' +
              once,
          )
        quick['baseline'] = [latest.id]
      }
      if (builds && !values['fail-on']?.length) quick['fail-on'] = ['regression']
      if (!values.oracle && !values.agent?.length) {
        const settings = latest?.settings
        if (!settings)
          throw new Error(
            '--quick without --agent takes the agents of the latest quick run of ' +
              name +
              ' on the pinned builds, and this lab has none: ' +
              once,
          )
        if (settings.agents.some((agent) => agent.provider === 'oracle')) quick['oracle'] = true
        else quick['agent'] = settings.agents.map(agentText)
        if (!values.judge && settings.judge)
          quick['judge'] =
            settings.judge.provider +
            ':' +
            settings.judge.model +
            (settings.judge.thinking ? ':' + settings.judge.thinking : '')
        if (!values['model-budget-usd'] && settings.modelUsd !== undefined)
          quick['model-budget-usd'] = String(settings.modelUsd)
        if (!values.slots) quick['slots'] = String(settings.slots)
      }
      Object.assign(values, quick)
      log(
        'quick: ' +
          name +
          ', ' +
          (quick['subset'] ? 'the subset ' + Revision.quick.subset : 'the tasks named') +
          ', ' +
          values.attempts +
          ' attempts a task, ' +
          (values.oracle ? 'the solutions' : (values.agent ?? []).join(' and ')) +
          (values.baseline?.length
            ? ', against ' +
              values.baseline
                .map((id) =>
                  id === latest?.id ? id + ', the latest quick run on the pinned builds' : id,
                )
                .join(' and ')
            : '') +
          (values['fail-on']?.length ? ', exit 3 on ' + values['fail-on'].join(' or ') : ''),
      )
    }
    if (!values['build-only'])
      for (const kind of Revision.credentials({
        agents: values.oracle ? [] : (values.agent ?? []).map(parseAgent),
        ...(values.judge ? { judge: parseJudge(values.judge) } : {}),
        logins,
        variables: process.env,
      }))
        await Login.refresh(kind, {
          path: logins[kind]!,
          ...(Login.urls(process.env)[kind] ? { url: Login.urls(process.env)[kind] } : {}),
          withinMs: Login.tools[kind].refreshEarlyMs,
        }).catch((error: unknown) => {
          if (!(error instanceof Login.RefreshError)) throw error
          log(error.message + '; it is used as it is')
        })
    const held = await Revision.hold(directory, {
      waiting: (ahead) =>
        log(
          ahead.length
            ? 'lab: waiting in ' +
                directory +
                ' for ' +
                ahead.length +
                (ahead.length === 1 ? ' evaluation' : ' evaluations') +
                ' that came first: ' +
                ahead.map((ticket) => ticket.what + ' (process ' + ticket.pid + ')').join(', ')
            : 'lab: waiting for another command that holds ' + directory,
        ),
      what:
        'nanocode ' +
        (values.nanocode ?? Revision.pinned) +
        (values.name ? ', ' + values.name : '') +
        (values['build-only'] ? ', build only' : ''),
    })
    let opened: Revision.Lab | undefined
    const end = async () => {
      await opened?.close()
      await held.release()
    }
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, () => void end().then(() => process.exit(1)))
    try {
      const bundle = values['ca-bundle'] ?? process.env['NANOEVAL_CA_BUNDLE']
      const builds = await Revision.build({
        ...(bundle ? { caBundle: Path.resolve(bundle) } : {}),
        lab: directory,
        log,
        ...(values.nanocode ? { nanocode: values.nanocode } : {}),
        ...(values['nanocode-ts'] ? { nanocodeTs: values['nanocode-ts'] } : {}),
        profile: values['hand-profile'],
        repositories: {
          nanocode: values['nanocode-repository'],
          nanocodeTs: values['nanocode-ts-repository'],
        },
        ...(values.sdk ? { sdk: values.sdk } : {}),
        ...(values['sdk-fallback'] ? { sdkFallback: true } : {}),
      })
      if (values['build-only']) {
        console.log(Revision.environment(builds))
        return
      }
      opened = await Revision.open({
        builds,
        lab: directory,
        logins,
        pollMs,
        progress,
        stopSec,
      })
      await main(opened, {
        hand: async (revision) =>
          revision === Revision.pinned
            ? (await pins()).hand
            : Pins.hand(
                (
                  await Revision.resolve(revision, {
                    repository: values['nanocode-repository'],
                    tree: Path.join(directory, 'source', 'nanocodex'),
                  })
                ).id,
              ),
        values: quick,
      })
    } finally {
      await end()
    }
    return
  }

  const selection: Dataset.Selection = {
    ...(values.limit ? { limit: Number(values.limit) } : {}),
    ...(values.only?.length ? { only: values.only } : {}),
  }
  const backend = (values.backend ?? 'auto') as Config.Backend
  const cache = Path.resolve(values.cache ?? Store.defaultCache())

  if (command === 'doctor') {
    const asked = values.backend
    if (asked !== undefined && asked !== 'dir' && asked !== 'krun' && asked !== 'ns')
      throw new Error('--backend is krun, ns or dir, not ' + asked)
    const facts = await Doctor.gather({
      env: process.env,
      root: Path.resolve(import.meta.dirname, '..'),
      token: values.token,
      url: values.url,
    })
    const wanted = asked ?? Doctor.backend(facts)
    const found = Doctor.checks(facts, wanted)
    console.log(Doctor.report(found, wanted))
    process.exitCode = found.some((check) => check.level === 'miss') ? 1 : 0
    return
  }

  if (command === 'datasets') {
    for (const adapter of Catalog.adapters)
      console.log(
        [
          adapter.name + (adapter.state === 'verified' ? '' : ' (not verified end to end)'),
          '  ' + adapter.description,
          '  source: ' + JSON.stringify(adapter.source),
          '  run: ' + adapter.proof,
        ].join('\n'),
      )
    return
  }

  if (command === 'prune' && rest.length) {
    if (rest.length > 1 || (rest[0] !== 'layers' && rest[0] !== 'store'))
      throw new Error('prune takes layers, store or nothing, not ' + rest.join(' '))
    if (rest[0] === 'layers') {
      process.exitCode = await Prune.layers({
        days: required(values.days, 'days'),
        home: Path.join(cache, 'converter'),
        layers: Path.resolve(values.layers ?? Converter.defaultLayers(cache)),
        remove: values.remove,
      })
      return
    }
    if (values.store === 'r2')
      throw new Error('prune store takes a directory store: blobs in R2 are not pruned')
    await Prune.store({
      allowEmpty: values['allow-empty'],
      api: client({ token: required(values.token, 'token'), url: required(values.url, 'url') }),
      log: (line) => console.log(line),
      remove: values.remove,
      root: Path.resolve(values.store ?? Store.defaultRoot()),
    })
    return
  }

  if (command === 'prune') {
    const child = spawn(
      'bash',
      [
        Path.resolve(import.meta.dirname, '../sandbox/slot.sh'),
        'prune',
        ...(values['dry-run'] ? ['dry-run'] : []),
      ],
      { env: { ...process.env, NANOEVAL_CACHE: cache }, stdio: 'inherit' },
    )
    process.exitCode = await new Promise<number>((resolve) =>
      child.once('exit', (exit) => resolve(exit ?? 1)),
    )
    return
  }

  if (command === 'runtime') {
    const out = Path.resolve(required(values.out, 'out'))
    const built = values.publish
      ? {
          ...(await Runtime.publish(
            blobStore('r2', {
              token: required(values.token, 'token'),
              url: required(values.url, 'url'),
            }),
            { cache, out },
          )),
          file: out,
        }
      : await Runtime.build({ cache, out })
    console.log(built.file + ': sha256 ' + built.digest + ', ' + built.bytes + ' bytes')
    return
  }

  const adapter = command === 'import' && rest[0] ? Catalog.find(rest[0]) : undefined
  if (command === 'import' && rest[0] && !adapter)
    throw new Error(
      'no dataset is named ' +
        rest[0] +
        ': import knows ' +
        Catalog.adapters.map((candidate) => candidate.name).join(', '),
    )
  const sources = Source.create(
    values.sources ? Path.resolve(values.sources) : Source.defaultRoot(),
  )
  if (command === 'import' && adapter && values.out) {
    const manifest = await Dataset.write(adapter, { ...selection, out: values.out, store: sources })
    console.log(manifest.dataset + ': ' + manifest.tasks.length + ' tasks in ' + values.out)
    return
  }

  if (command === 'runner' && values.config) {
    const file = Path.resolve(values.config)
    const home = Path.dirname(file)
    if (values.detach) {
      const pid = await Runner.detach({
        arguments: [Path.resolve(import.meta.filename), 'runner', '--config', file],
        home,
      })
      console.log('runner started as process ' + pid)
      return
    }
    process.chdir(home)
    await Runner.run({
      cache,
      config: JSON.parse(await Fs.readFile(file, 'utf8')) as Config.Runner,
      home,
      store: Path.resolve(values.store ?? Store.defaultRoot()),
    })
    process.exit(0)
  }

  if (
    !command ||
    ![
      'attempt',
      'cancel',
      'compare',
      'eval',
      'evals',
      'export',
      'import',
      'oracle',
      'plans',
      'pool',
      'run',
      'runner',
      'runs',
      'sandbox',
      'status',
      'timeline',
      'version',
    ].includes(command)
  ) {
    if (command) throw unknown(command)
    console.log(usage)
    return
  }
  if (!values.url)
    throw new Error(
      '--url is required, or NANOEVAL_URL: the address of the Worker, which nanoeval worker prints, http://127.0.0.1:8787 unless its --port names another',
    )
  if (!values.token)
    throw new Error('--token is required, or NANOEVAL_TOKEN: the token the Worker was started with')
  const access = { token: values.token, url: values.url }
  const api = client(access)

  if (command === 'plans') {
    const [action, provider] = rest
    const known =
      action === undefined ||
      (action === 'complete' && provider === undefined) ||
      ((action === 'sign-in' || action === 'sign-out') && provider === 'claude')
    if (!known || rest.length > 2)
      throw new Error(
        'plans takes sign-in claude, complete, sign-out claude or nothing, not ' + rest.join(' '),
      )
    const code = async () => {
      if (values.code) return values.code
      if (!process.stdin.isTTY) return (await Consumers.text(process.stdin)).trim()
      const terminal = Readline.createInterface({ input: process.stdin, output: process.stdout })
      try {
        return (await terminal.question('code: ')).trim()
      } finally {
        terminal.close()
      }
    }
    if (action === 'sign-in') {
      const started = await api.planSignIn()
      console.log(
        'open ' +
          started.authorization_url +
          '\nand approve. The page then shows a code: give it, before ' +
          new Date(started.expires_at).toISOString() +
          ", to nanoeval plans complete --code 'CODE'",
      )
      if (!process.stdin.isTTY) return
      await api.planComplete(await code())
    }
    if (action === 'complete') await api.planComplete(await code())
    if (action === 'sign-out') await api.planSignOut()
    console.log(planSummary((await api.plans()).claude))
    return
  }

  if (command === 'runs') {
    const { runs } = await api.runs(values.limit === undefined ? undefined : Number(values.limit))
    if (runs.length) console.log(runsTable(runs))
    return
  }

  if (command === 'version') {
    const { agree, text } = versions(await api.version())
    console.log(text)
    process.exitCode = agree ? 0 : 1
    return
  }

  if (command === 'evals') {
    for (const entry of (await api.evals()).evals)
      console.log(
        entry.name +
          '@' +
          entry.digest.slice(0, 12) +
          '  ' +
          entry.tasks +
          ' tasks  ' +
          entry.dataset,
      )
    return
  }

  if (command === 'eval') {
    const reference = required(rest[0], 'NAME')
    const found = await api.eval(reference)
    const name = reference.split('@')[0]!
    console.log(
      name +
        '@' +
        found.version.digest +
        '\n  dataset: ' +
        found.version.dataset +
        ' ' +
        JSON.stringify(found.version.source) +
        '\n  created: ' +
        new Date(found.version.createdAt).toISOString() +
        '\n  tasks: ' +
        found.version.tasks,
    )
    for (const version of (await api.versions(name)).versions)
      console.log(
        '  version ' +
          version.digest.slice(0, 12) +
          '  ' +
          version.tasks +
          ' tasks  ' +
          new Date(version.createdAt).toISOString() +
          (version.parent ? '  after ' + version.parent.slice(0, 12) : ''),
      )
    for (const entry of found.entries) console.log('  ' + entry.id + '  ' + entry.name)
    const file = subsetsFile(values.subsets)
    const text = await Fs.readFile(file, 'utf8').catch(() => undefined)
    for (const [subset, wanted] of Object.entries(
      text === undefined ? {} : (Subset.parse(text, file)[name] ?? {}),
    ).sort(([left], [right]) => left.localeCompare(right))) {
      const tasks = Subset.match(found.entries, wanted)
      console.log(
        '  subset ' +
          subset +
          ': ' +
          tasks.ids.join(' ') +
          (tasks.unknown.length ? '  (no task: ' + tasks.unknown.join(' ') + ')' : ''),
      )
    }
    return
  }

  const policy = Converter.policy({
    ...process.env,
    ...hostPolicy,
    ...(values['pull-wait'] ? { NANOEVAL_PULL_WAIT_SEC: values['pull-wait'] } : {}),
  })
  const refusals: { error: string; id: string }[] = []
  const imported = async (
    source: AsyncIterable<Dataset.Case>,
    target: { dataset: string; name: string; source: Record<string, string> },
  ) => {
    const result = await importEval(api, {
      ...(values['keep-going']
        ? {
            refused: (id: string, error: Error) => {
              refusals.push({ error: error.message, id })
              console.error('not imported: ' + error.message)
            },
          }
        : {}),
      backend,
      cache,
      cases: source,
      dataset: target.dataset,
      layers: Path.resolve(values.layers ?? Converter.defaultLayers(cache)),
      log: (line) => (lab ? lab.progress.line(line) : console.error(line)),
      name: target.name,
      policy,
      source: target.source,
      store: blobStore(values.store, access),
    })
    if (values.report)
      await Fs.writeFile(
        values.report,
        JSON.stringify(
          {
            name: target.name,
            policy: {
              caBundle: policy.caBundle !== undefined,
              slotEnv: policy.envFile !== undefined,
              slotForward: policy.forwards !== undefined,
            },
            refused: refusals,
            timings: result.timings,
            version: result.version,
          },
          null,
          2,
        ) + '\n',
      )
    return result
  }

  if (command === 'import') {
    if (adapter && adapter.state !== 'verified')
      console.error(adapter.name + ' is not verified end to end: ' + adapter.proof)
    if (!adapter && !values.task?.length) throw new Error('import takes a DATASET or --task DIR')
    const result = adapter
      ? await imported(adapter.cases({ ...selection, store: sources }), {
          dataset: adapter.name,
          name: values.eval ?? adapter.name,
          source: adapter.source,
        })
      : await imported(Import.directories(values.task!), {
          ...Import.local,
          name: values.eval ?? Import.local.name,
        })
    console.log(
      (values.eval ?? adapter?.name ?? Import.local.name) +
        '@' +
        result.version.digest +
        ': ' +
        result.version.tasks +
        ' tasks, ' +
        result.tasks.length +
        ' imported now' +
        (refusals.length ? ', ' + refusals.length + ' not imported' : ''),
    )
    process.exitCode = refusals.length ? 1 : 0
    return
  }

  if (command === 'sandbox') {
    const run = required(values.run, 'run')
    const created = JSON.parse(
      await Fs.readFile(required(values.e2b, 'e2b'), 'utf8'),
    ) as E2b.Created
    const runtime = (await api.config(run)).sandbox.runtime
    if (!runtime)
      throw new Error(
        'the run was created without --runtime: a sandbox without this checkout cannot start its runner',
      )
    const file = required(values.e2b, 'e2b')
    const timeoutSec = seconds(
      required(values['sandbox-timeout-sec'], 'sandbox-timeout-sec'),
      'sandbox-timeout-sec',
    )
    if (timeoutSec > E2b.maxTimeoutSec)
      throw new Error(
        'E2B over MPP keeps a sandbox for at most ' +
          E2b.maxTimeoutSec +
          ' s: --sandbox-timeout-sec is the timeout the sandbox was opened with',
      )
    const openedAt = values['opened-at']
      ? Date.parse(values['opened-at'])
      : (await Fs.stat(file)).mtimeMs
    if (!Number.isFinite(openedAt))
      throw new Error('--opened-at is a time such as 2026-11-12T04:30:00Z')
    const leftSec = Math.floor((openedAt + timeoutSec * 1000 - Date.now()) / 1000)
    if (leftSec <= 0)
      throw new Error(
        'the sandbox was opened at ' +
          new Date(openedAt).toISOString() +
          ' for ' +
          timeoutSec +
          ' s and has ended',
      )
    const handle = E2b.handle(created)
    const sandbox = E2b.connect(handle)
    const answered = await api.attach(run, { leftSec })
    const runner: Config.Runner = {
      ...answered,
      ...(values.backend ? { backend } : {}),
      ...(values['free-disk-mb'] ? { freeDiskMb: Number(values['free-disk-mb']) } : {}),
      ...(values['memory-mb'] ? { memoryMb: Number(values['memory-mb']) } : {}),
      ...(values['poll-ms'] ? { pollMs: Number(values['poll-ms']) } : {}),
      ...(values.slots ? { slots: Number(values.slots) } : {}),
    }
    const home = handle.home + '/' + run
    const script = home + '/' + Bootstrap.files.script
    await sandbox.write(home + '/' + Bootstrap.files.config, Buffer.from(JSON.stringify(runner)))
    await sandbox.write(
      script,
      Buffer.from(
        Bootstrap.script({
          cache: handle.home + '/cache',
          home,
          run,
          runtime,
          token: answered.token,
          url: answered.url,
        }),
      ),
    )
    console.log(
      'runner ' +
        answered.runner +
        ' of run ' +
        run +
        ' in sandbox ' +
        handle.id +
        ', which ends in ' +
        leftSec +
        ' s: ' +
        (await Sandbox.run(sandbox, 'bash ' + Sandbox.quote(script))).trim(),
    )
    return
  }

  if (command === 'pool') {
    console.log(poolSummary(await api.pool(values.close ? 'close' : undefined, values.location)))
    return
  }

  if (command === 'runner' && values.standing) {
    if (backend === 'auto') throw new Error('a standing runner names its --backend')
    const home = Path.resolve(values.home ?? Path.join('output', 'runners', 'standing'))
    await Fs.mkdir(home, { recursive: true })
    const leaseSec = Number(values['lease-sec'])
    const network = (values.network ?? Config.network({ backend })) as Config.Runner['network']
    const worker = versions(await api.version())
    if (!worker.agree) throw new Error(worker.text)
    console.error(worker.text)
    const machine = crypto.randomUUID()
    const enroll = () =>
      api.standing({ backend, machine, network, noticeSec: leaseSec }, values.location)
    const pool = await enroll()
    process.chdir(home)
    Object.assign(process.env, hostPolicy)
    await Runner.run({
      cache,
      home,
      override: {
        ...(values['free-disk-mb'] ? { freeDiskMb: Number(values['free-disk-mb']) } : {}),
        ...(values['memory-mb'] ? { memoryMb: Number(values['memory-mb']) } : {}),
        ...(values['poll-ms'] ? { pollMs: Number(values['poll-ms']) } : {}),
        ...(values.slots ? { slots: Number(values.slots) } : {}),
      },
      standing: {
        backend,
        enroll,
        leaseSec,
        network,
        pollMs: Number(values['poll-ms'] ?? '250'),
        pool,
        setupSec: Number(values['setup-sec']),
        url: access.url,
      },
      store: Path.resolve(values.store ?? Store.defaultRoot()),
    })
    process.exit(0)
  }

  if (command === 'runner') {
    const run = required(values.run, 'run')
    const home = Path.resolve(values.home ?? Path.join('output', 'runners', run.slice(0, 8)))
    await Fs.mkdir(home, { recursive: true })
    const file = Path.join(home, 'runner.json')
    const earlier = await Fs.readFile(file, 'utf8').then(
      (text) => JSON.parse(text) as Config.Runner,
      () => undefined,
    )
    const answered =
      earlier?.run === run
        ? earlier
        : await api.attach(
            run,
            values['ends-in-sec'] ? { leftSec: seconds(values['ends-in-sec'], 'ends-in-sec') } : {},
          )
    await Fs.writeFile(file, JSON.stringify(answered), { mode: 0o600 })
    process.chdir(home)
    Object.assign(process.env, hostPolicy)
    await Runner.run({
      cache,
      config: {
        ...answered,
        ...(values.backend ? { backend } : {}),
        ...(values['free-disk-mb'] ? { freeDiskMb: Number(values['free-disk-mb']) } : {}),
        ...(values['memory-mb'] ? { memoryMb: Number(values['memory-mb']) } : {}),
        ...(values['poll-ms'] ? { pollMs: Number(values['poll-ms']) } : {}),
        ...(values.slots ? { slots: Number(values.slots) } : {}),
        url: access.url,
      },
      home,
      store: Path.resolve(values.store ?? Store.defaultRoot()),
    })
    process.exit(0)
  }

  if (command === 'run') {
    if (values.oracle && values.agent?.length)
      throw new Error('--oracle runs no model: leave out --agent')
    const unsound = await unsoundList(values.unsound)
    const on = gates(values['fail-on'])
    if ((values.baseline?.length || on.size) && !values.wait)
      throw new Error('--baseline and --fail-on read a run that ended: add --wait')
    if ((on.has('regression') || on.has('lost')) && !values.baseline?.length)
      throw new Error(
        '--fail-on ' + [...on].join(',') + ' needs a baseline: name one with --baseline',
      )
    const wants = async (name: string) => {
      const file = subsetsFile(values.subsets)
      const texts = await Promise.all(
        (values['only-file'] ?? []).map((path) => Fs.readFile(path, 'utf8')),
      )
      return [
        ...(values.only ?? []),
        ...texts.flatMap(Subset.lines),
        ...(values.subset?.length
          ? Subset.named(
              Subset.parse(
                await Fs.readFile(file, 'utf8').catch(() => {
                  throw new Error(
                    '--subset reads ' + file + ', which is not there: name it with --subsets',
                  )
                }),
                file,
              ),
              { eval: name, file, names: values.subset },
            )
          : []),
      ]
    }
    if (lab && !values.task?.length && !values.rerun) {
      const name = required(values.eval, 'eval').split('@')[0]!
      const entries = (await api.evals()).evals.some((entry) => entry.name === name)
        ? (await api.eval(name)).entries
        : []
      const found = Subset.match(entries, await wants(name))
      const loose = found.unknown.filter((text) => Subset.glob(text) || text.includes('/'))
      if (loose.length)
        throw new Error(
          'the lab holds no task of ' +
            name +
            ' that matches ' +
            loose.join(' or ') +
            ': a task is imported by its id',
        )
      const wanted = Revision.missing(
        entries.map((entry) => entry.id),
        {
          ...(selection.limit === undefined ? {} : { limit: selection.limit }),
          ...(found.ids.length || found.unknown.length
            ? { only: [...found.ids, ...found.unknown] }
            : {}),
        },
      )
      const dataset = Catalog.find(name)
      if (wanted && !dataset)
        throw new Error(
          'the lab holds no eval ' +
            name +
            ' with these tasks, and import knows no dataset of that name: name --task DIR or one of nanoeval datasets',
        )
      if (wanted && dataset)
        lab.progress.line(
          'import: ' +
            (wanted.only ? wanted.only.length + ' tasks' : 'the tasks') +
            ' of ' +
            name +
            ' that the lab does not hold yet',
        )
      if (wanted && dataset)
        await imported(dataset.cases({ ...wanted, store: sources }), {
          dataset: dataset.name,
          name,
          source: dataset.source,
        })
    }
    const rerun = values.rerun ? await runId(api, values.rerun) : undefined
    const parent = rerun ? await api.config(rerun) : undefined
    let reference: Eval.Reference
    let only = values.only
    if (parent) reference = parent.eval
    else if (values.task?.length) {
      lab?.progress.line('import: ' + values.task.length + ' task directories')
      const result = await imported(Import.directories(values.task), {
        ...Import.local,
        name: values.eval ?? Import.local.name,
      })
      reference = { name: values.eval ?? Import.local.name, version: result.version.digest }
      only = result.tasks.map((task) => task.id)
    } else {
      const [name, digest] = required(values.eval, 'eval').split('@')
      reference = { name: name!, ...(digest ? { version: digest } : {}) }
    }
    const wanted = values.task?.length ? [] : await wants(reference.name)
    if (wanted.length)
      only = Subset.resolve(
        (await api.eval(reference.name + (reference.version ? '@' + reference.version : '')))
          .entries,
        { eval: reference.name, wanted },
      )
    const named = new Set(tokens.flatMap((token) => (token.kind === 'option' ? [token.name] : [])))
    if (lab) named.add('sandboxes')
    const provider = (
      parent && !named.has('provider') ? parent.sandbox.provider : values.provider
    ) as Config.Config['sandbox']['provider']
    const runtime = values['runtime-blob']
      ? await api.blob(values['runtime-blob'])
      : values.runtime || provider === 'e2b' || provider === 'gateway'
        ? await Runtime.publish(blobStore('r2', access), {
            cache,
            out: Path.join(cache, 'runtime.tgz'),
          })
        : undefined
    if (runtime) console.error('runner runtime ' + runtime.digest + ', ' + runtime.bytes + ' bytes')
    const select = values.rerun ? rerunSelection(values) : 'unpassed'
    const own: Config.Config = {
      agents: parent
        ? Config.rerunAgents(
            parent.agents,
            (values.agent ?? []).map((text) => text.split('=')[0]!),
          )
        : values.oracle
          ? [oracle]
          : (values.agent ?? []).map(parseAgent),
      attempts: parent ? parent.attempts : Number(values.attempts ?? '1'),
      budget: {
        ...(values['model-budget-usd'] ? { modelUsd: Number(values['model-budget-usd']) } : {}),
        sandboxUsd: Number(values['sandbox-budget-usd']),
      },
      eval: reference,
      ...(values.judge
        ? { judge: parseJudge(values.judge) }
        : parent?.judge
          ? { judge: parent.judge }
          : {}),
      ...(values['key-deposit'] || values['key-top-up']
        ? {
            key: {
              ...(values['key-deposit'] ? { deposit: Number(values['key-deposit']) } : {}),
              ...(values['key-top-up'] ? { topUp: Number(values['key-top-up']) } : {}),
            },
          }
        : {}),
      ...(selection.limit === undefined || parent ? {} : { limit: selection.limit }),
      limits: {
        attachSec: Number(values['attach-sec']),
        claims: Number(values.claims),
        leaseSec: Number(values['lease-sec']),
        setupSec: Number(values['setup-sec']),
        stepRetries: Number(values['step-retries']),
      },
      name:
        values.name ?? 'nanoeval-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'),
      ...(only?.length ? { only } : {}),
      ...((values.payer ?? parent?.payer)
        ? { payer: (values.payer ?? parent?.payer) as Config.Payer }
        : {}),
      ...(rerun ? { rerun: { run: rerun, select } } : {}),
      sandbox: {
        backend,
        disks: (values.disks ?? Config.disks(provider)) as 'keep' | 'remove',
        ...(values['free-disk-mb'] ? { freeDiskMb: Number(values['free-disk-mb']) } : {}),
        ...(values['sandbox-lease-sec'] ? { leaseSec: Number(values['sandbox-lease-sec']) } : {}),
        max: Number(values.sandboxes),
        ...(values['memory-mb'] ? { memoryMb: Number(values['memory-mb']) } : {}),
        network: (values.network ??
          Config.network({ backend })) as Config.Config['sandbox']['network'],
        pollMs: Number(values['poll-ms'] ?? '250'),
        provider,
        ...(runtime ? { runtime } : {}),
        slots: Number(values.slots ?? '4'),
        ...(values.template ? { template: values.template } : {}),
        ...(values['sandbox-timeout-sec']
          ? { timeoutSec: Number(values['sandbox-timeout-sec']) }
          : {}),
        ...(values['verifier-cache'] || parent?.sandbox.verifierCache
          ? { verifierCache: true as const }
          : {}),
        ...(values['warm-sec']
          ? {
              warm: {
                idleSec: Number(values['warm-sec']),
                usd: Number(values['warm-budget-usd']),
              },
            }
          : {}),
      },
    }
    const config = parent ? rerunConfig(own, { named, parent }) : own
    const deployment = await api.routes()
    const unserved = Route.unserved(deployment, {
      plan: config.payer === 'plan',
      users: [
        ...config.agents.flatMap((agent) =>
          agent.provider === 'oracle'
            ? []
            : [
                {
                  name: 'the agent ' + agent.id,
                  provider: Installed.is(agent.provider)
                    ? Installed.provider(agent.provider, agent.api)
                    : agent.provider,
                },
              ],
        ),
        ...(config.judge ? [{ name: 'the judge', provider: config.judge.provider }] : []),
      ],
    })
    if (unserved) throw new Error(unserved)
    const asked = () =>
      Compare.planned(config.agents, {
        routes: (agent) => {
          const paid = Route.planned(deployment, {
            plan: config.payer === 'plan',
            provider: Installed.is(agent.provider)
              ? Installed.provider(agent.provider, agent.api)
              : agent.provider,
          })
          return paid ? [paid] : []
        },
      })
    const baseline = await baselines(api, {
      hand: given.hand,
      named: values.baseline ?? [],
      reruns: values['with-reruns'],
      wanted: async () => {
        if (parent)
          throw new Error(
            'a baseline by rule reads the selection of a new run: name the baseline of a rerun by its id',
          )
        const found = await api.eval(
          reference.name + (reference.version ? '@' + reference.version : ''),
        )
        return {
          eval: { name: reference.name },
          members: asked(),
          not: [],
          tasks: Object.fromEntries(
            Eval.select(found.entries, {
              ...(config.limit === undefined ? {} : { limit: config.limit }),
              ...(config.only?.length ? { only: config.only } : {}),
            }).map((entry) => [entry.name, entry.digest]),
          ),
        }
      },
    })
    if (baseline.length && !values.unlike) {
      const refusal = Compare.unlike(
        Compare.pairs(Compare.members(Compare.standing(baseline)), asked()),
      )
      if (refusal) throw new Error(refusal)
    }
    const created = await api.create(config, values.location ? { location: values.location } : {})
    console.log(
      'run ' +
        created.id +
        ': ' +
        created.attempts +
        ' attempts of ' +
        created.eval.name +
        '@' +
        created.eval.version.slice(0, 12),
    )
    if (!values.wait) return
    const runner = await lab?.runner(created.id, hostPolicy)

    for (;;) {
      const gone = runner ? runner.exit() !== null : false
      const status = await api.status(created.id)
      lab?.progress.rows(status['counts'])
      if (status['state'] === 'finished') {
        lab?.progress.settle()
        const ended = await results(api, created.id)
        console.log(shown(status, { ...screen, unsound: Unsound.summary(ended.attempts, unsound) }))
        const compared = baseline.length ? ended : undefined
        const changes = compared ? Compare.changes(baseline, compared) : []
        const refusal = values.unlike
          ? undefined
          : Compare.unlike(changes.map((change) => change.pair))
        if (compared) {
          process.stdout.write(
            '\n' +
              Compare.table([...baseline, compared]) +
              (refusal
                ? ''
                : '\n' +
                  Compare.against(baseline, compared) +
                  Unsound.against({ baseline, list: unsound, run: [compared] })),
          )
        }
        if (lab) {
          await lab.record({
            agents: status['agents'],
            at: new Date().toISOString(),
            ...(baseline.length ? { baseline: baseline[0]!.id } : {}),
            counts: status['counts'],
            eval: status['eval'],
            id: created.id,
            cancelled: Boolean(status['cancelled']),
            name: config.name,
            nanocode: status['nanocode'],
            quick: values.quick,
            rerun: Boolean(config.rerun),
            settings: {
              agents: config.agents,
              attempts: config.attempts,
              ...(config.judge ? { judge: config.judge } : {}),
              ...(config.budget.modelUsd === undefined ? {} : { modelUsd: config.budget.modelUsd }),
              slots: config.sandbox.slots,
            } satisfies Revision.Settings,
            spend: status['spend'],
          })
        }
        const out =
          values.out ??
          (lab ? Path.join(lab.directory, 'runs', created.id) : undefined) ??
          (process.env['NANOEVAL_RUNS_DIR']
            ? Path.join(
                process.env['NANOEVAL_RUNS_DIR'],
                config.name + '-' + created.id.slice(0, 8),
              )
            : undefined)
        if (out) {
          await exportJob(api, { out, run: created.id })
          console.log('job written to ' + out)
        }
        if (refusal) throw new Error(refusal)
        judged(changes, on)
        process.exitCode = exitStatus({ changes, counts: status['counts'], on, waited: true })
        return
      }
      if (gone) {
        await api.cancel(created.id)
        throw new Error('the runner ended before the run did: see ' + runner!.log)
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }

  const run = await runId(api, required(rest[0], 'RUN'))
  const runIds =
    command === 'compare' || command === 'oracle'
      ? [run, ...(await Promise.all(rest.slice(1).map((name) => runId(api, name))))]
      : [run]
  if (command === 'compare') {
    const on = gates(values['fail-on'])
    if ((on.has('regression') || on.has('lost')) && !values.baseline?.length)
      throw new Error(
        '--fail-on ' + [...on].join(',') + ' needs a baseline: name one with --baseline',
      )
    const runs = await Promise.all(
      (values['with-reruns'] ? await withReruns(api, runIds) : runIds).map((id) =>
        results(api, id),
      ),
    )
    const baseline = await baselines(api, {
      named: values.baseline ?? [],
      reruns: values['with-reruns'],
      wanted: async () => ({
        eval: { name: runs[0]!.eval.name },
        members: Compare.members(Compare.standing(runs)),
        not: runs.map((result) => result.id),
        tasks: Object.fromEntries(
          runs.flatMap((result) =>
            result.attempts.map((attempt) => [
              attempt.task.name,
              result.digests?.[attempt.task.name] ?? '',
            ]),
          ),
        ),
      }),
    })
    const sides = baseline.length ? Compare.lineages(runs) : []
    const changes = sides.flatMap((side) => Compare.changes(baseline, side))
    const refusal = values.unlike ? undefined : Compare.unlike(changes.map((change) => change.pair))
    const unsound = await unsoundList(values.unsound)
    process.stdout.write(
      Compare.table([...baseline, ...runs]) +
        (refusal
          ? ''
          : sides.length
            ? sides
                .map(
                  (side) =>
                    '\n' +
                    Compare.against(baseline, side) +
                    Unsound.against({ baseline, list: unsound, run: side }),
                )
                .join('')
            : Unsound.summary(
                Compare.standing(runs).flatMap((result) => result.attempts),
                unsound,
              )
                .map((line) => line + '\n')
                .join('')),
    )
    if (refusal) throw new Error(refusal)
    judged(changes, on)
    const standing = Compare.standing(runs).flatMap((result) => result.attempts)
    process.exitCode = exitStatus({
      changes,
      counts: {
        errored: standing.filter((attempt) => attempt.outcome === 'errored').length,
        failed: standing.filter((attempt) => attempt.outcome === 'failed').length,
      },
      on,
      waited: false,
    })
    return
  }
  if (command === 'oracle') {
    const found = Unsound.check(
      await Promise.all(
        (values['with-reruns'] ? await withReruns(api, runIds) : runIds).map((id) =>
          api.results(id),
        ),
      ),
      await unsoundList(values.unsound),
    )
    process.stdout.write(Unsound.report(found))
    if (Unsound.failed(found)) process.exitCode = 4
    return
  }
  if (command === 'status') {
    const status = await api.status(run)
    const [results, unsound] = await Promise.all([api.results(run), unsoundList(values.unsound)])
    console.log(shown(status, { ...screen, unsound: Unsound.summary(results.attempts, unsound) }))
  }
  if (command === 'timeline') {
    const timeline = await api.timeline(run)
    console.log(Timeline.table(timeline.marks, timeline.createdAt))
  }
  if (command === 'cancel') console.log(JSON.stringify(await api.cancel(run)))
  if (command === 'export') {
    const out = required(values.out, 'out')
    await exportJob(api, { out, run })
    console.log('job written to ' + out)
  }
  if (command === 'attempt') {
    const attempt = required(rest[1], 'ATTEMPT')
    if (rest[2]) process.stdout.write(await api.artifactBytes(run, attempt, rest[2]))
    else console.log(JSON.stringify(await api.attempt(run, attempt), null, 2))
  }
}

export function help(text: string, command: string | undefined): string | undefined {
  if (!command) return text
  const kept: string[] = []
  let keep = false
  for (const line of text.split('\n').slice(2)) {
    const head = /^  (\S+)/.exec(line)
    if (head) keep = head[1] === command
    if (keep) kept.push(line)
  }
  return kept.length ? 'nanoeval ' + command + '\n\n' + kept.join('\n') : undefined
}

export function commands(text: string): string[] {
  return [
    ...new Set(
      text
        .split('\n')
        .slice(2)
        .flatMap((line) => /^  (\S+)/.exec(line)?.[1] ?? []),
    ),
  ]
}

export class UnknownCommandError extends Error {
  override name = 'Cli.UnknownCommandError'
}

function unknown(command: string): UnknownCommandError {
  return new UnknownCommandError(
    'no command is named ' +
      command +
      ': the commands are ' +
      commands(usage).join(', ') +
      '. nanoeval help COMMAND prints one',
  )
}

const whole = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const shortId = /^[0-9a-f]{8}[0-9a-f-]*$/

export function named(
  given: string,
  listed: readonly { id: string; name: string | null }[],
): string {
  if (whole.test(given)) return given
  const found = listed.filter((run) => run.id.startsWith(given) || run.name === given)
  if (found.length === 1) return found[0]!.id
  throw new Error(
    found.length
      ? given +
          ' names ' +
          found.length +
          ' runs, ' +
          found.map((run) => run.id).join(' and ') +
          ': name one by more of its id'
      : 'no run of this Worker has an id that begins with ' +
          given +
          ', or that name: nanoeval runs lists them',
  )
}

export function begins(given: string, listed: readonly { id: string }[]): string | undefined {
  if (!shortId.test(given)) return undefined
  const found = listed.filter((run) => run.id.startsWith(given))
  return found.length === 1 ? found[0]!.id : undefined
}

async function runId(api: Api, given: string): Promise<string> {
  return whole.test(given) ? given : named(given, (await api.runs()).runs)
}

export function refusal(error: unknown, worker?: string): string {
  if (!(error instanceof Error)) return String(error)
  if (error instanceof TypeError && error.message === 'fetch failed') {
    const reasons =
      error.cause instanceof AggregateError
        ? error.cause.errors.map((reason) => (reason instanceof Error ? reason.message : ''))
        : [error.cause instanceof Error ? error.cause.message : String(error.cause ?? '')]
    const cause = reasons.filter(Boolean).join(', ')
    const at = worker && URL.canParse(worker) ? new URL(worker) : undefined
    const port = at ? at.port || (at.protocol === 'https:' ? '443' : '80') : undefined
    const hosts = at?.hostname === 'localhost' ? ['localhost', '127.0.0.1', '::1'] : [at?.hostname]
    return at && hosts.some((host) => cause.includes(host + ':' + port))
      ? 'no Worker answers at ' +
          worker +
          ' (' +
          cause +
          '): start one with nanoeval worker, or name another with --url or NANOEVAL_URL'
      : 'a request got no answer' + (cause ? ': ' + cause : '')
  }
  const code = (error as { code?: unknown }).code
  const stated =
    error.constructor === Error ||
    error.name.includes('.') ||
    (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS'))
  if (!stated) return error.stack ?? error.message
  const answered = /^(\S+) answered (\d+): (.*)$/s.exec(error.message)
  if (!answered) return error.message
  let said = answered[3]!
  try {
    const body = JSON.parse(said) as { error?: unknown }
    if (typeof body.error === 'string') said = body.error
  } catch {}
  return said + ' (' + answered[1] + ' answered ' + answered[2] + ')'
}

if (import.meta.main)
  await (process.argv[2] === 'watch' ? Watch.main(process.argv.slice(3)) : main()).catch(
    (error: unknown) => {
      const at = process.argv.indexOf('--url')
      console.error(
        'nanoeval: ' + refusal(error, at < 0 ? process.env['NANOEVAL_URL'] : process.argv[at + 1]),
      )
      process.exit(error instanceof UnknownCommandError ? 2 : 1)
    },
  )
