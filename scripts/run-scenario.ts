import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

/**
 * Scenario runner wrapper used by `pnpm test:run` to provide TWO core features:
 *
 * 1) **Per-run logs**
 *    Ensures JSONL logging is written to a run-specific file via `LOG_FILE` + `RUN_ID`.
 *
 * 2) **Unique account indices across VUs**
 *    Starts a local "index allocator" HTTP server and sets `INDEX_ALLOCATOR_URL` for
 *    the child process. This avoids duplicated indices when Artillery VUs run in
 *    isolated JS sandboxes (where in-process counters can repeat).
 *
 * Consumer:
 * `src/processors/account-derive.ts` calls `${INDEX_ALLOCATOR_URL}/next` to get a unique
 * derivation index per VU (see `fetchNextIndex()` / `deriveAccount()`).
 */

type IndexAllocatorConfig = Readonly<{
  startIndex: number;
}>;

function parseIndexAllocatorStart(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    // eslint-disable-next-line no-console
    console.error(
      `[run-scenario] Invalid INDEX_ALLOCATOR_START=${String(
        raw
      )} (expected integer >= 0)`
    );
    process.exit(2);
  }
  return n;
}

async function startIndexAllocatorServer(
  cfg: IndexAllocatorConfig
): Promise<Readonly<{ url: string; close: () => Promise<void> }>> {
  let counter = cfg.startIndex;
  const server = http.createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      try {
        const url = req.url ?? "/";

        // Endpoint:
        // - GET /next -> { index: number }
        if (req.method === "GET" && url.startsWith("/next")) {
          const idx = counter++;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ index: idx }));
          return;
        }

        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      } catch (_e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal_error" }));
      }
    }
  );

  // Bind to loopback only; ephemeral port.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to bind allocator server");
  }

  const url = `http://127.0.0.1:${addr.port}`;

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { url, close };
}

function usageAndExit(): never {
  // eslint-disable-next-line no-console
  console.error(
    [
      "Usage:",
      "  pnpm exec tsx scripts/run-scenario.ts -- <command> [args...]",
      "",
      "Core features:",
      "  - Per-run logs: sets LOG_FILE / RUN_ID if not already set.",
      "  - Index allocator: starts a local server and sets INDEX_ALLOCATOR_URL for the child process.",
      "    (Consumed by src/processors/account-derive.ts via GET /next.)",
      "",
      "Examples:",
      "  pnpm exec tsx scripts/run-scenario.ts -- artillery run scenarios/examples.getProfile.yml",
      "  LOG_FILE=./logs/my-run.jsonl pnpm exec tsx scripts/run-scenario.ts -- artillery run scenarios/examples.getProfile.yml",
    ].join("\n")
  );
  process.exit(2);
}

function nowStamp(): string {
  const d = new Date();
  const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 8);
}

function sanitizeRunId(raw: string): string {
  // Keep it path-safe and easy to read.
  return raw.replaceAll(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

function ensureRunLogEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.LOG_FILE && env.LOG_FILE.trim().length > 0) {
    return env;
  }

  const runIdRaw =
    env.RUN_ID && env.RUN_ID.trim().length > 0
      ? env.RUN_ID.trim()
      : `${nowStamp()}-${randomSuffix()}`;
  const runId = sanitizeRunId(runIdRaw);

  const dir = join(process.cwd(), "logs");
  mkdirSync(dir, { recursive: true });

  return {
    ...env,
    RUN_ID: runId,
    LOG_FILE: join(dir, `run-${runId}.jsonl`),
  };
}

const sepIdx = process.argv.indexOf("--");
if (sepIdx === -1) usageAndExit();

const cmd = process.argv[sepIdx + 1];
if (!cmd) usageAndExit();

const args = process.argv.slice(sepIdx + 2);

// Core feature #1: per-run logs
const runLogEnv = ensureRunLogEnv(process.env);

// Core feature #2: shared unique account indices for the run
const allocator = await startIndexAllocatorServer({
  startIndex: parseIndexAllocatorStart(process.env.INDEX_ALLOCATOR_START),
});

const childEnv: NodeJS.ProcessEnv = {
  ...runLogEnv,
  INDEX_ALLOCATOR_URL: allocator.url,
};

// eslint-disable-next-line no-console
console.log(`[run-scenario] LOG_FILE=${childEnv.LOG_FILE}`);
// eslint-disable-next-line no-console
console.log(`[run-scenario] INDEX_ALLOCATOR_URL=${allocator.url}`);

const child = spawn(cmd, args, {
  stdio: "inherit",
  env: childEnv,
  shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
  void (async () => {
    try {
      await allocator.close();
    } catch {
      // best-effort cleanup
    }

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  })();
});


