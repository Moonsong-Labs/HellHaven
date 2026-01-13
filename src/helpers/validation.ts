/**
 * Ensure a string is 0x-prefixed.
 * If it already starts with `0x`, return as-is; otherwise prepend `0x`.
 *
 * If `bytes` is provided, enforce the expected length for a 0x-hex string:
 * - total length must be `2 + bytes * 2` (e.g. 32 bytes => 66 chars including `0x`)
 *
 * This does not validate hex content (keep that check where needed).
 */
export function ensure0xPrefix(raw: string, bytes?: number): `0x${string}` {
  const s = raw.trim();
  const value = (s.startsWith("0x") ? s : `0x${s}`) as `0x${string}`;
  if (bytes !== undefined) {
    const expectedLen = 2 + bytes * 2;
    if (value.length !== expectedLen) {
      throw new Error(
        `Expected 0x-prefixed hex string of ${bytes} bytes (length ${expectedLen}), got length ${value.length}`
      );
    }
  }
  return value;
}


/**
 * Read a numeric value from environment variables.
 *
 * Behavior (kept intentionally strict/simple to avoid drift across call sites):
 * - if env var is missing/empty => fallback
 * - if env var parses to a finite number > 0 => that number
 * - otherwise => fallback
 */
export function readNumberEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type Dict = Readonly<Record<string, unknown>>;

/**
 * Require an object-like dictionary at a runtime boundary.
 *
 * Note: This intentionally does not try to validate nested shapes; it just ensures
 * we can safely index into the returned value.
 */
export function requireDict(value: unknown, label: string): Dict {
  if (!value || typeof value !== "object") {
    throw new Error(`${label} is not an object`);
  }
  return value as Dict;
}

/**
 * Require a non-empty string.
 */
export function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Require an integer-like value.
 *
 * Accepts:
 * - integer numbers
 * - numeric strings representing integers (e.g. "42")
 */
export function requireInteger(value: unknown, label: string): number {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    n = Number(value);
  } else {
    throw new Error(`${label} must be an integer`);
  }

  if (!Number.isInteger(n)) {
    throw new Error(`${label} must be an integer`);
  }

  return n;
}
