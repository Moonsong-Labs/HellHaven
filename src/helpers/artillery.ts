export type Done = (error?: Error) => void;

export type ArtilleryEvents = Readonly<{
  emit: (type: string, name: string, value: number) => void;
}>;

export type ArtilleryContext = {
  vars?: Record<string, unknown>;
  scenario?: {
    vars?: Record<string, unknown>;
  };
};

/**
 * Artillery context notes:
 * - `context` is scoped to a single VU (virtual user). `context.vars` is NOT global across VUs.
 * - Artillery may merge `context.scenario.vars` back into `context.vars` across steps/iterations.
 *   We use `persistVars()` for values that must persist reliably for the rest of a scenario/VU
 *   (e.g. derived account info, SIWE session, muting flags).
 */
export function ensureVars(context: ArtilleryContext): Record<string, unknown> {
  if (!context.vars) context.vars = {};
  return context.vars;
}

/**
 * Ensure `context.scenario.vars` exists and return it.
 * Use this for values that must persist across scenario iterations/loops.
 *
 * Side effect: may create `context.scenario` and/or `context.scenario.vars`.
 */
export function ensureScenarioVars(
  context: ArtilleryContext
): Record<string, unknown> {
  if (!context.scenario) context.scenario = {};
  if (!context.scenario.vars) context.scenario.vars = {};
  return context.scenario.vars;
}

/**
 * Persist values to both:
 * - context.vars (available immediately in the current step/iteration)
 * - context.scenario.vars (persists across iterations; Artillery merges scenario vars back into vars)
 */
export function persistVars(
  context: ArtilleryContext,
  patch: Record<string, unknown>
): void {
  const vars = ensureVars(context);
  const svars = ensureScenarioVars(context);
  Object.assign(vars, patch);
  Object.assign(svars, patch);
}

/**
 * Read a required string variable.
 *
 * Throws if missing, not a string, or blank.
 */
export function requireVarString(
  vars: Record<string, unknown>,
  key: string
): string {
  const v = vars[key];
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new Error(`Missing or invalid var: ${key}`);
  }
  return v.trim();
}

/**
 * Parse a "boolean-like" variable from vars.
 *
 * Accepted values:
 * - boolean: true/false
 * - number: 1/0
 * - string: true/false, 1/0, yes/no (case-insensitive)
 *
 * Returns `undefined` if key is missing or value is not recognized.
 */
export function readVarBool(
  vars: Record<string, unknown>,
  key: string
): boolean | undefined {
  const v = vars[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "number")
    return v === 1 ? true : v === 0 ? false : undefined;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
  }
  return undefined;
}
