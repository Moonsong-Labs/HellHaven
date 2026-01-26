import {
  ensureVars,
  readVarBool,
  type ArtilleryContext,
  type ArtilleryEvents,
} from "./artillery.js";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname, join } from "node:path";

export function metricsMuted(context: ArtilleryContext): boolean {
  const vars = ensureVars(context);
  return (
    readVarBool(vars, "__muteMetrics") === true ||
    readVarBool(vars, "MUTE_METRICS") === true
  );
}

function isErrorMetricName(name: string): boolean {
  // Convention used across this repo: counters for failures end with ".err"
  // (e.g. "auth.siwe.err", "init.derive.err", "action.getProfile.err").
  return name.endsWith(".err") || name.endsWith(".error");
}

export type MetricsEmitter = Readonly<{
  counter: (name: string, value?: number) => void;
  histogram: (name: string, value: number) => void;
}>;

type MetricSample = Readonly<{
  ts: number;
  elapsedMs: number;
  pid: number;
  type: "counter" | "histogram";
  name: string;
  value: number;
}>;

let metricsJsonlStream: WriteStream | undefined;
const METRICS_RUN_START_MS = Date.now();

function buildDefaultMetricsFilePath(): string {
  // Prefer RUN_ID so the metrics file lines up with the log file naming from `scripts/run-with-logs.ts`.
  // run-with-logs always injects RUN_ID + LOG_FILE into the child process.
  const runId = process.env.RUN_ID?.trim();
  if (runId && runId.length > 0) {
    const dir = join(process.cwd(), "logs");
    mkdirSync(dir, { recursive: true });
    return join(dir, `${runId}-metrics.jsonl`);
  }

  // Fallback: if LOG_FILE looks like ./logs/<id>-run.jsonl (or old ./logs/run-<id>.jsonl),
  // mirror it as ./logs/<id>-metrics.jsonl
  const logFile = process.env.LOG_FILE?.trim();
  const m1 = logFile?.match(/(^|\/)([a-zA-Z0-9._-]+)-run\.jsonl$/);
  if (m1?.[2]) {
    const dir = join(process.cwd(), "logs");
    mkdirSync(dir, { recursive: true });
    return join(dir, `${m1[2]}-metrics.jsonl`);
  }
  const m2 = logFile?.match(/(^|\/)run-([a-zA-Z0-9._-]+)\.jsonl$/);
  if (m2?.[2]) {
    const dir = join(process.cwd(), "logs");
    mkdirSync(dir, { recursive: true });
    return join(dir, `${m2[2]}-metrics.jsonl`);
  }

  // Last-resort: local stamp (same idea as default log.ts behavior).
  const d = new Date();
  const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  const dir = join(process.cwd(), "logs");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${stamp}-pid${process.pid}-metrics.jsonl`);
}

function getMetricsJsonlStream(): WriteStream | undefined {
  const p =
    process.env.METRICS_FILE?.trim() ??
    process.env.ARTILLERY_METRICS_JSONL_PATH?.trim() ??
    buildDefaultMetricsFilePath();
  if (metricsJsonlStream) return metricsJsonlStream;

  // Ensure parent folder exists (opt-in feature; safe to create).
  mkdirSync(dirname(p), { recursive: true });
  metricsJsonlStream = createWriteStream(p, { flags: "a" });
  metricsJsonlStream.on("error", () => {
    // If writing fails, disable to avoid crashing load runs.
    metricsJsonlStream = undefined;
  });
  return metricsJsonlStream;
}

function writeMetricSample(sample: MetricSample): void {
  const s = getMetricsJsonlStream();
  if (!s) return;
  try {
    s.write(`${JSON.stringify(sample)}\n`);
  } catch {
    // ignore
  }
}

/**
 * Option B: bind an emitter once per step.
 *
 * Policy:
 * - not muted: emit everything
 * - muted: emit only counters that look like errors (name ends with .err/.error), and drop histograms
 */
export function createEmitter(
  context: ArtilleryContext,
  events: ArtilleryEvents
): MetricsEmitter {
  const muted = metricsMuted(context);

  const counter = (name: string, value = 1): void => {
    if (muted && !isErrorMetricName(name)) return;
    events.emit("counter", name, value);
  };

  const histogram = (name: string, value: number): void => {
    if (muted) return;
    events.emit("histogram", name, value);
    writeMetricSample({
      ts: Date.now(),
      elapsedMs: Date.now() - METRICS_RUN_START_MS,
      pid: process.pid,
      type: "histogram",
      name,
      value,
    });
  };

  return { counter, histogram };
}
