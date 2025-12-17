import { readFileSync } from "node:fs";
import { join } from "node:path";

export type PrivateKeySource = Readonly<{
  keys: ReadonlyArray<string>;
  sourcePath: string;
}>;

function defaultKeysPath(): string {
  return join(process.cwd(), "data", "private_keys.csv");
}

function readKeysPath(): string {
  return process.env.PRIVATE_KEYS_FILE ?? defaultKeysPath();
}

function parseCsv(text: string): ReadonlyArray<string> {
  const lines = text
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const out: string[] = [];
  for (const line of lines) {
    if (line.toLowerCase() === "privatekey") {
      continue;
    }
    // One-column CSV: privateKey
    out.push(line);
  }
  return out;
}

function parseJson(text: string): ReadonlyArray<string> {
  const parsed: unknown = JSON.parse(text);
  if (Array.isArray(parsed)) {
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item === "string") {
        out.push(item);
        continue;
      }
      if (
        item &&
        typeof item === "object" &&
        typeof (item as Record<string, unknown>).privateKey === "string"
      ) {
        out.push((item as Record<string, unknown>).privateKey as string);
      }
    }
    return out;
  }
  throw new Error("JSON must be an array of strings or objects { privateKey }");
}

export function loadPrivateKeys(): PrivateKeySource {
  const sourcePath = readKeysPath();
  const text = readFileSync(sourcePath, "utf8");
  const keys = sourcePath.endsWith(".json") ? parseJson(text) : parseCsv(text);
  if (keys.length === 0) {
    throw new Error(`No private keys found in ${sourcePath}`);
  }
  return { keys, sourcePath };
}

let cache: PrivateKeySource | undefined;
let idx = 0;

export function nextPrivateKey(): Readonly<{
  privateKey: string;
  sourcePath: string;
}> {
  if (!cache) {
    cache = loadPrivateKeys();
  }
  const keys = cache.keys;
  const privateKey = keys[idx % keys.length];
  if (!privateKey) {
    throw new Error(
      `No private key available at index ${idx} from ${cache.sourcePath}`
    );
  }
  idx += 1;
  return { privateKey, sourcePath: cache.sourcePath };
}
