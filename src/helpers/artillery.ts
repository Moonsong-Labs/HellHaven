export type Done = (error?: Error) => void;

export type ArtilleryEvents = Readonly<{
  emit: (type: string, name: string, value: number) => void;
}>;

export type ArtilleryContext = {
  vars?: Record<string, unknown>;
};

/**
 * Artillery context notes:
 * - `context` is scoped to a single VU (virtual user). `context.vars` is NOT global across VUs.
 * - This repo intentionally persists per-VU state in `context.vars` only.
 */
export function ensureVars(context: ArtilleryContext): Record<string, unknown> {
  if (!context.vars) context.vars = {};
  return context.vars;
}

/**
 * Persist values for the lifetime of the VU.
 *
 * NOTE: We intentionally only write to `context.vars` (VU-scoped).
 */
export function persistVars(
  context: ArtilleryContext,
  patch: Record<string, unknown>
): void {
  const vars = ensureVars(context);
  Object.assign(vars, patch);
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

/**
 * Read a var from the VU-scoped Artillery context.
 */
export function getPersistedVar(
  context: ArtilleryContext,
  key: string
): unknown {
  const vars = ensureVars(context);
  if (Object.prototype.hasOwnProperty.call(vars, key)) return vars[key];
  return undefined;
}
