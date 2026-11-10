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

- This repository has tests and CI. An evaluator's results are claims about other software, so its own behavior is checked without a person: `npm test` and `npm run e2e` run on every push.
- The README states what is implemented, what was run, and what is planned. Change it with the code.

## Project Principles

- The harness runs outside the sandbox, as a nanocode-ts session. The sandbox holds the task environment and a nanocode hand, nothing else of ours.
- nanoeval sends models only nanocode's native prompts and tool text, and the task's `instruction.md` unchanged.
- A sandbox provider creates, executes, writes and kills. Everything about slots belongs in `sandbox/slot.sh`, so every provider and every machine splits the same way.
- `src/` uses only the standard web platform types: no Node APIs, no `@cloudflare/workers-types`. `worker/` holds the Cloudflare code, `cli/` and `sandbox/Sandboxd.ts` the Node code.
- The run's ledger is the authority. Write the intent before an effect that costs money, and never retry an effect whose outcome is unknown.
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
- `npm test` runs the unit tests. `npm run e2e` runs the end-to-end test under local workerd.
- `npm run dry-run` bundles the Worker without deploying it.
- In `krun/`, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test` check the launcher. `NANOEVAL_E2E_BACKEND=krun` runs an end-to-end lane on microVM slots.

## Git Conventions

- Conventional commits, lowercase, no trailing period: `feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `chore:`. Scope optional.
- State the change, not the reason for it. Keep the body short: the problem, the resulting behavior, and one validation line.
- Never force push and never amend a pushed commit.
