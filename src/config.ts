export type Env = Readonly<{
  network: "testnet" | "stagenet" | "local";
}>;

export type NetworkName = Env["network"];

function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

export function parseNetworkName(raw: string): NetworkName {
  const v = raw.trim();
  if (v === "testnet" || v === "stagenet" || v === "local") {
    return v;
  }
  throw new Error(
    `Invalid NETWORK: ${raw} (expected 'testnet', 'stagenet' or 'local')`
  );
}

export function readEnv(): Env {
  const network = parseNetworkName(getRequiredEnv("NETWORK"));
  return { network };
}
