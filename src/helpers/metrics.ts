import {
  ensureScenarioVars,
  ensureVars,
  readVarBool,
  type ArtilleryContext,
  type ArtilleryEvents,
} from "./artillery.js";

export function metricsMuted(context: ArtilleryContext): boolean {
  const vars = ensureVars(context);
  const svars = ensureScenarioVars(context);
  return (
    readVarBool(vars, "__muteMetrics") === true ||
    readVarBool(svars, "__muteMetrics") === true ||
    readVarBool(vars, "MUTE_METRICS") === true ||
    readVarBool(svars, "MUTE_METRICS") === true
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
  };

  return { counter, histogram };
}
