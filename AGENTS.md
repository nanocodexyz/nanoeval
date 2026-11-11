# Agent Guidelines

## Development

These principles come from nanocodexyz/nanocode's `AGENTS.md` and nanocodexyz/nanocode-ts's, and apply to every change here.

- Keep code simple and changes small. Match the surrounding code and preserve unrelated work.
- No code comments, doc comments or section dividers. Only comments that a tool reads stay, such as `@ts-expect-error`.
- No magic constants or arbitrary caps: a limit comes from a protocol, a measurement or host policy passed in. Surface invalid states. Never hide them with silent truncation, clamping or fallbacks.
- Make invalid states unrepresentable: model a lifecycle as one discriminated union whose variants carry only what that phase has.
- Inference, subagents and durability live in the brain. Tools run on the hand. Never silently replay dispatched work: report uncertain outcomes.
- Never modify a benchmark task or its verifier to make an agent pass. An infrastructure failure is an error, never a score.
- Keep every run artifact in ignored `output/`. Never commit artifacts, credentials or personal data.
- This file holds principles only and rarely changes. DECISIONS.md is the growing log: add what each change establishes and why, with the commands, dates and measurements behind it.

## Differences from nanocode-ts

- This repository has tests and CI. An evaluator's results are claims about other software, so its own behavior is checked without a person: `npm test` and the end-to-end lanes run on every push.
- The README states what is implemented, what was run, and what is planned. Change it with the code.

## Project Principles

- The harness runs outside the sandbox, as a nanocode-ts session. The sandbox holds the task environment and a nanocode hand, nothing else of ours.
- nanoeval sends models only nanocode's native prompts and tool text, and the task's `instruction.md` unchanged.
- An installed agent is the exception to both, for comparison only: a vendor's own command line inside the slot, with its own prompts and tools. It gets the instruction unchanged and no credential: its model requests go through the run.
- An eval is imported once and never changed: a version is named by a digest over its rows, and every file a row needs is a blob named by its SHA-256. A reader verifies a blob before it uses it.
- An environment is converted when it is imported, never when an attempt starts. `sandbox/Converter.ts` is the only place that knows how, and it runs the launcher in `krun/`. Nothing in this repository calls a container engine, at import or at run time.
- A run is rows, and its ledger is the authority. A runner claims, runs and reports facts. The run decides what they mean, and only the holder of a row's current claim token writes to it.
- A sandbox provider creates, executes, writes and kills, and a run asks it only to start a runner. Everything about one slot belongs in `sandbox/slot.sh`, so every machine runs an attempt the same way. Admission belongs to the runner of the machine it describes.
- `src/` uses only the standard web platform types: no Node APIs, no `@cloudflare/workers-types`. `worker/` holds the Cloudflare code, `cli/` and the TypeScript of `sandbox/` the Node code. Table logic that must be tested without workerd is written against `src/Sql.ts`.
- Write the intent before an effect that costs money, and never retry an effect whose outcome is unknown. A lost claim is recorded and its row starts again from nothing: it is never resumed by another runner.
- A measurement in DECISIONS.md names one run, commit, machine and sample count, and keeps every lane including losses.

## TypeScript Conventions

The conventions of nanocode-ts's `AGENTS.md` apply: erasable syntax only, `.ts` extensions on relative imports, module files imported as namespaces, functions and plain data instead of classes (errors and Durable Objects excepted), error names in the namespaced form such as `Task.InvalidError`, at most two positional parameters, alphabetical order where order has no meaning.

## Rust Conventions

`krun/` is the only Rust in the repository. The Rust conventions of nanocode-ts's `AGENTS.md` apply: edition 2024, the toolchain pinned in `krun/rust-toolchain.toml`, `#[expect(lint, reason = "...")]` instead of `#[allow]`, `pub(crate)` unless another crate needs the item, alphabetical order where order has no meaning, and no dependency a few lines would replace. `unsafe` is limited to the libkrun binding in `krun/nanovm` and to taking ownership of an accepted socket in the guest.

## Tooling

- Use npm. Declare every dependency at an exact version. nanocode-ts is installed from its release tarball, as its README says.
- Prettier is banned. Vite+ runs oxfmt and oxlint, configured in `vite.config.ts`.
- Node runs the TypeScript sources directly. There is no build step outside `wrangler`.

## Commands

- `npm run check` formats and lints with fixes. `npm run lint` checks without fixing.
- `npm run check:types` runs `tsc` for the Node sources and for the Worker.
- `npm test` runs the unit tests. `npm run e2e` runs the end-to-end test under local workerd on microVM slots, and is skipped where krun cannot run. `NANOEVAL_E2E_BACKEND=dir` runs it on directory slots anywhere, and `NANOEVAL_E2E_BACKEND=ns` on ns slots, as root or inside a microVM guest.
- `npm run dry-run` bundles the Worker without deploying it.
- In `krun/`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test` check the launcher.

## Git Conventions

- Conventional commits, lowercase, no trailing period: `feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `chore:`. Scope optional.
- State the change, not the reason for it. Keep the body short: the problem, the resulting behavior, and one validation line.
- Never force push and never amend a pushed commit.
