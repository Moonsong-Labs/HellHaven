import pino, { type Logger } from "pino";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type LogLevel =
  | "fatal"
  | "error"
  | "warn"
  | "info"
  | "debug"
  | "trace"
  | "silent";

export type LogConfig = Readonly<{
  level: LogLevel;
  filePath?: string;
  consoleEnabled: boolean;
  fileEnabled: boolean;
}>;

function readLogLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "error").toLowerCase();
  if (
    raw === "fatal" ||
    raw === "error" ||
    raw === "warn" ||
    raw === "info" ||
    raw === "debug" ||
    raw === "trace" ||
    raw === "silent"
  ) {
    return raw;
  }
  throw new Error(
    `Invalid LOG_LEVEL: ${raw} (expected fatal|error|warn|info|debug|trace|silent)`
  );
}

function readConsoleEnabled(): boolean {
  const raw = (process.env.LOG_CONSOLE ?? "true").toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") {
    return true;
  }
  if (raw === "false" || raw === "0" || raw === "no") {
    return false;
  }
  throw new Error(`Invalid LOG_CONSOLE: ${raw} (expected true/false)`);
}

function readLogFilePath(): string | undefined {
  const raw = process.env.LOG_FILE;
  return raw && raw.length > 0 ? raw : undefined;
}

function readFileEnabled(): boolean {
  const raw = (process.env.LOG_FILE_ENABLED ?? "true").toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") {
    return true;
  }
  if (raw === "false" || raw === "0" || raw === "no") {
    return false;
  }
  throw new Error(`Invalid LOG_FILE_ENABLED: ${raw} (expected true/false)`);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function buildDefaultLogFilePath(): string {
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  const dir = join(process.cwd(), "logs");
  mkdirSync(dir, { recursive: true });
  return join(dir, `run-${stamp}-pid${process.pid}.jsonl`);
}

export function readLogConfig(): LogConfig {
  const base: { level: LogLevel; filePath?: string; consoleEnabled: boolean } =
    {
      level: readLogLevel(),
      consoleEnabled: readConsoleEnabled(),
    };
  const fileEnabled = readFileEnabled();
  const configuredPath = readLogFilePath();
  const filePath = fileEnabled
    ? (configuredPath ?? buildDefaultLogFilePath())
    : undefined;

  const out: {
    level: LogLevel;
    filePath?: string;
    consoleEnabled: boolean;
    fileEnabled: boolean;
  } = { ...base, fileEnabled };
  if (filePath) {
    out.filePath = filePath;
  }
  return out;
}

let singleton: Logger | undefined;

export function getLogger(): Logger {
  if (singleton) {
    return singleton;
  }

  const cfg = readLogConfig();
  // NOTE: When using pino.multistream, each stream has its own level filter.
  // If you omit it, pino defaults that stream to "info", which would drop debug logs.
  const streams: Array<{ stream: pino.DestinationStream; level: LogLevel }> = [];

  if (cfg.consoleEnabled) {
    streams.push({
      stream: pino.destination({ dest: 1, sync: false }),
      level: cfg.level,
    });
  }
  if (cfg.filePath) {
    streams.push({
      // Artillery runs can end quickly and may not flush async streams.
      // Use sync writes for file logs to avoid empty/truncated JSONL.
      stream: pino.destination({ dest: cfg.filePath, sync: true }),
      level: cfg.level,
    });
  }

  // If neither console nor file is enabled, force silence.
  const level =
    streams.length === 0 ? ("silent" satisfies LogLevel) : cfg.level;
  const destination =
    streams.length <= 1
      ? (streams[0]?.stream ?? pino.destination({ dest: 1, sync: false }))
      : pino.multistream(streams);

  singleton = pino({ level }, destination);
  return singleton;
}
