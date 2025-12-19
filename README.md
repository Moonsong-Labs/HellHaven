# HellHaven: DataHaven/StorageHub Load Tests

This repo is an Artillery-based load testing suite to measure limits and identify bottlenecks in DataHaven and StorageHub.

## Requirements

- **Node.js >= 22** (SDK `@storagehub-sdk/core@0.3.4` declares this)
- `pnpm`

## Install

```bash
pnpm install
```

## Environment variables

Required:
- `NETWORK` (`testnet`, `stagenet` or `local`)

Optional:
- none (health checks are unauthenticated)

## Network configuration

Network URLs/IDs are intentionally **hardcoded** in `src/networks.ts` and are copied from `datahaven-monitor`:
- **Testnet**: MSP `https://deo-dh-backend.testnet.datahaven-infra.network`
- **Stagenet**: MSP `https://deo-dh-backend.stagenet.datahaven-infra.network`
- **Local**: MSP `http://127.0.0.1:8080`, RPC `http://127.0.0.1:9888`

Local notes:
- `NETWORK=local` expects:
  - MSP at `http://127.0.0.1:8080`
  - EVM/Substrate RPC at `http://127.0.0.1:9888` / `ws://127.0.0.1:9888`
  - SIWE domain/uri: `localhost:3001` / `http://localhost:3001`

## Commands

- `pnpm fmt` — check formatting
- `pnpm fmt:fix` — apply formatting
- `pnpm lint` — check lint rules
- `pnpm lint:fix` — apply safe lint fixes
- `pnpm test` — build -> artillery
- `pnpm test:msp-unauth` — standalone unauth MSP load test (no SIWE, no keys)

Examples (local):

```bash
NETWORK=local pnpm test:msp-unauth
```

```bash
LOG_LEVEL=info LOG_CONSOLE=true TEST_MNEMONIC="test test test test test test test test test test test junk" NETWORK=local pnpm test
```

## Logging

Logging is handled by **Pino**.

Env vars:
- `LOG_LEVEL`: `fatal|error|warn|info|debug|trace|silent` (default: `error`)
- `LOG_CONSOLE`: `true|false` (default: `true`)
- `LOG_FILE_ENABLED`: `true|false` (default: `true`). When enabled and `LOG_FILE` is not set, logs are written to `./logs/run-<date_time>-pid<PID>.jsonl`.
- `LOG_FILE`: path to a log file (optional). When set, logs are appended to that file in addition to console (unless `LOG_CONSOLE=false`).

Examples:

```bash
LOG_LEVEL=debug NETWORK=testnet pnpm test
```

```bash
LOG_LEVEL=info LOG_FILE=./artillery.log NETWORK=testnet pnpm test
```

## Standalone MSP unauth load test

This test randomly calls:
- `GET /health` (`client.info.getHealth()`)
- `GET /info` (`client.info.getInfo()`)

It uses `NETWORK=testnet|stagenet` and the MSP base URL from `src/networks.ts`.

Run:

```bash
NETWORK=stagenet pnpm test:msp-unauth
```

Knobs (optional):
- `ARTILLERY_WORKERS=4` (true parallel local processes; spawns N concurrent Artillery runs)
- `VU_SLEEP_MIN_MS=50` / `VU_SLEEP_MAX_MS=250` (jitter per request loop)
- `MSP_TIMEOUT_MS=60000` (override HTTP timeout)

Metrics emitted (counters + histograms):
- `msp.health.ok`, `msp.health.ms`
- `msp.info.ok`, `msp.info.ms`
- `msp.req.err` (total request errors)

## Scenario output

Counters:
- `sdk.storagehub.connect.ok`
- `sdk.msp.connect.ok`
- `sdk.disconnect.ok`
- `sdk.connect.error`

Timings:
- `sdk.storagehub.connect.ms`
- `sdk.msp.connect.ms`


