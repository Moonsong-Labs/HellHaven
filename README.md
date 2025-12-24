# HellHaven: DataHaven/StorageHub Load Tests

This repo is an Artillery-based load testing suite to measure limits and identify bottlenecks in DataHaven and StorageHub.

## Requirements

- **Node.js >= 22**
- `pnpm`

## Install

```bash
pnpm install
```

## Environment variables

Required:
- `NETWORK` (`testnet`, `stagenet` or `local`)

Per-test required:
- `TEST_MNEMONIC` (required by tests that derive accounts and do SIWE)
- `FILE_KEY` (required by the download test)

## Network configuration

Network URLs/IDs are intentionally **hardcoded** in `src/networks.ts`:
- **Testnet**: MSP `https://deo-dh-backend.testnet.datahaven-infra.network`
- **Stagenet**: MSP `https://deo-dh-backend.stagenet.datahaven-infra.network`
- **Local**: MSP `http://127.0.0.1:8080`, RPC `http://127.0.0.1:9888`

Local notes:
- `NETWORK=local` matches the “normal” local StorageHub defaults when you boot a local network from the StorageHub repo with:
  - `pnpm docker:start:solochain-evm:initialised`
  - See StorageHub docs: [Spawning solochain-evm-initialised fullnet](https://github.com/Moonsong-Labs/storage-hub/tree/main/test#spawning-solochain-evm-initialised-fullnet)
- It assumes:
  - MSP at `http://127.0.0.1:8080`
  - EVM/Substrate RPC at `http://127.0.0.1:9888` / `ws://127.0.0.1:9888`
- **SIWE domain/uri**: these should be provided by the dApp doing SIWE (they are not “network” properties). For local testing, a dApp often runs on `localhost:3000` or `localhost:3001`.
  - `localhost:3001` / `http://localhost:3001` is what the StorageHub repo’s `demo-app` (SDK examples) commonly uses.

## Commands

- `pnpm fmt` — check formatting
- `pnpm fmt:fix` — apply formatting
- `pnpm lint` — check lint rules
- `pnpm lint:fix` — apply safe lint fixes
- `pnpm test:run scenarios/<file>.yml` — run any scenario (build + logs wrapper)

List available scenarios:

```bash
ls scenarios
```

Run one:

```bash
NETWORK=stagenet pnpm test:run scenarios/<file>.yml
```

Examples (replace the scenario file with anything from `ls scenarios`):

```bash
NETWORK=local pnpm test:run scenarios/artillery.msp-unauth.yml
```

```bash
LOG_LEVEL=info LOG_CONSOLE=true \
NETWORK=stagenet \
TEST_MNEMONIC="test test test test test test test test test test test junk" \
pnpm test:run scenarios/examples.getProfile.yml
```

```bash
LOG_LEVEL=info LOG_CONSOLE=true \
NETWORK=stagenet \
TEST_MNEMONIC="test test test test test test test test test test test junk" \
FILE_KEY="<your-file-key>" \
pnpm test:run scenarios/download.yml
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
LOG_LEVEL=debug NETWORK=testnet pnpm test:run scenarios/artillery.msp-unauth.yml
```

```bash
LOG_LEVEL=info LOG_FILE=./artillery.log NETWORK=testnet pnpm test:run scenarios/artillery.msp-unauth.yml
```

## Standalone MSP unauth load test

This test randomly calls:
- `GET /health` (`client.info.getHealth()`)
- `GET /info` (`client.info.getInfo()`)

It uses `NETWORK=testnet|stagenet` and the MSP base URL from `src/networks.ts`.

Run:

```bash
NETWORK=stagenet pnpm test:run scenarios/artillery.msp-unauth.yml
```

Knobs (optional):
- `VU_SLEEP_MIN_MS=50` / `VU_SLEEP_MAX_MS=250` (jitter per request loop)
- `MSP_TIMEOUT_MS=60000` (override HTTP timeout)

Metrics emitted (counters + histograms):
- `msp.health.ok`, `msp.health.ms`
- `msp.info.ok`, `msp.info.ms`
- `msp.req.err` (total request errors)

## Download load test

This test performs init steps (derive + SIWE) and downloads a file from the MSP, measuring throughput and latency.

Required env vars:
- `NETWORK` (`testnet`, `stagenet` or `local`)
- `TEST_MNEMONIC`
- `FILE_KEY` (the file key/hash to download)

Run:

```bash
NETWORK=stagenet FILE_KEY=<your-file-key> pnpm test:run scenarios/download.yml
```

Knobs (optional):
- `LOG_LEVEL=info` (see Logging section)

Metrics emitted:
- `download.file.ok`, `download.file.ms` (file download)
- `download.bytes` (total bytes downloaded per request)
- `download.file.err` (error counter)
- `auth.siwe.err` (only if SIWE fails; init steps are muted so only errors surface)

## How initialization + mute metrics works

Most scenarios follow the same pattern:
- **Init** (muted): `deriveAccount` → `SIWE`
- **Actions** (not muted): call one or more action processors (e.g. `actionGetProfile`, `downloadFile`)

The muting is controlled by two processor steps:
- `muteMetrics`: while muted, the metrics helper will **only emit `*.err` counters**; it drops ok counters + histograms.
- `unmuteMetrics`: restores normal metric emission for the action phase.

This keeps summaries focused on action timings while still surfacing setup/auth failures.

### What `deriveAccount` does
- Picks a unique account index (via the local index allocator started by `scripts/run-with-logs.ts`)
- Derives an account from `TEST_MNEMONIC`
- Persists `privateKey` (and derivation metadata) into Artillery vars for later steps

### What `SIWE` does
- Reads the derived `privateKey`
- Calls the SDK SIWE auth (`mspClient.auth.SIWE(...)`)
- Persists the resulting `__siweSession` into Artillery vars

## How to add a new test

1) **Create a scenario file** under `scenarios/` (for example `scenarios/myTest.yml`).

2) **Use the standard template**:
- `config.processor: "../dist/src/processors/index.js"`
- Init steps (muted): `muteMetrics` → `deriveAccount` → `SIWE` → `unmuteMetrics`
- Then call your action processor(s)

3) Run it via the generic runner:

```bash
NETWORK=stagenet pnpm test:run scenarios/myTest.yml
```

(Optional) If you want a shortcut alias, add `test:myTest`: `"pnpm test:run scenarios/myTest.yml"`.

## Metrics (quick orientation)

Metrics depend on the scenario and processor functions used. Common ones:
- `msp.health.ok`, `msp.health.ms`, `msp.info.ok`, `msp.info.ms`, `msp.req.err`
- `action.getProfile.ok`, `action.getProfile.ms`, `action.getProfile.err`
- `download.file.ok`, `download.file.ms`, `download.bytes`, `download.file.err`

When init steps are wrapped with `muteMetrics`/`unmuteMetrics`, only `*.err` counters from init will appear in the summary (ok + histograms are muted).


