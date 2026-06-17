# AGENTS.md

Guidance for AI agents working in this repository. Keep changes minimal and aligned with the existing code.

## Project

`relay-protocol-oracle` is the reference implementation of a Relay protocol oracle: a Dockerized Fastify HTTP service (TypeScript/Node) that attests on-chain events (e.g. depository deposits, solver fills/refunds) across multiple VMs and exposes a signed-attestation API. See [README.md](./README.md) for the operator quick-start and [docs/overview.md](./docs/overview.md) for what the oracle attests and its API surface.

## Setup

- Package manager: Yarn 1 (classic), pinned via `packageManager` in `package.json`.
- Install dependencies: `yarn install`.
- Runtime config comes from environment variables. Copy [.env.example](./.env.example) for a minimal local setup. Accessing RPC endpoints locally typically requires the VPN.
- `ENVIRONMENT` selects which `configs/chains.*.json` and `configs/hub.*.json` files load.

## Common commands

Verified against `package.json` scripts:

- Build: `yarn build` (`tsc -b`, emits to `dist/`)
- Run tests: `yarn test` (Jest)
- Start the service: `yarn start` (runs `dist/index.js`, so build first)
- Lint: `yarn lint` (ESLint, `--max-warnings 0`)
- Lint and autofix: `yarn lint:fix`
- Secret/SAST scan: `yarn semgrep`

Local dev convenience (from the README): `export $(cat .env | xargs) && yarn start` after creating `.env`.

## Layout

- `src/` — service source
  - `index.ts`, `http-server.ts`, `config.ts` — entrypoint, Fastify server, config loading
  - `api/` — HTTP routes and request handling
  - `services/attestation/` — attestation logic, including per-VM code under `services/attestation/vm/`
  - `signers/` — signing modules (`raw-private-key`, `aws-kms`)
  - `common/` — shared utilities (chains, signature verification, etc.)
- `test/` — Jest tests (`test/unit/`, `test/common/`)
- `configs/` — per-environment chain and hub config JSON
- `docs/` — `overview.md` and `indexing/` (per-VM indexing docs)
- `audits/`, `eslint-rules/`, `.semgrep/` — audits, custom lint rules, SAST config
- `Dockerfile`, `entrypoint.sh` — container build and startup

## Conventions

- Open a pull request for review; do not push directly to `main`.
- Match the style and structure of surrounding code; ESLint runs with `--max-warnings 0`, so keep lint clean.
- Do not bypass git hooks (no `git commit --no-verify`). The pre-commit hook runs `lint-staged` and a gitleaks secret scan; fix the underlying issue rather than skipping.
- Tests live under `test/`; add or update tests alongside changes.
