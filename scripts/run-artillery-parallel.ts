import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";

type Args = Readonly<{
  scriptPath: string;
  workers: number;
}>;

function parseWorkers(raw: string | undefined): number {
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `Invalid ARTILLERY_WORKERS: ${raw} (expected positive integer)`
    );
  }
  return n;
}

function parseArgs(argv: string[]): Args {
  const scriptPath = argv[2];
  if (!scriptPath) {
    throw new Error(
      "Usage: pnpm exec tsx scripts/run-artillery-parallel.ts <script.yml>"
    );
  }
  const workers = parseWorkers(process.env.ARTILLERY_WORKERS);
  return { scriptPath, workers };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function stamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function runOne(
  workerIndex: number,
  scriptPath: string,
  runStamp: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

    const logsDir = join(process.cwd(), "logs");
    mkdirSync(logsDir, { recursive: true });
    const logPath = join(
      logsDir,
      `artillery-${runStamp}-worker${workerIndex}.log`
    );
    const file = createWriteStream(logPath, { flags: "a" });
    file.write(`[worker ${workerIndex}] script=${scriptPath}\n`);

    const child = spawn(cmd, ["exec", "artillery", "run", scriptPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ARTILLERY_WORKER_INDEX: String(workerIndex),
      },
    });
    child.on("error", reject);
    child.stdout.on("data", (chunk: Buffer) => {
      file.write(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      file.write(chunk);
      process.stderr.write(chunk);
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const { scriptPath, workers } = parseArgs(process.argv);
  const runStamp = stamp();

  if (workers === 1) {
    const code = await runOne(1, scriptPath, runStamp);
    process.exitCode = code;
    return;
  }

  const results = await Promise.all(
    Array.from({ length: workers }, (_v, i) =>
      runOne(i + 1, scriptPath, runStamp)
    )
  );

  const worst = results.reduce((acc, x) => (x !== 0 ? x : acc), 0);
  process.exitCode = worst;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
