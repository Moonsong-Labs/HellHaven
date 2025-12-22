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