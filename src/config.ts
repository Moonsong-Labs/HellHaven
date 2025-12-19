export type Env = Readonly<{
  network: "testnet" | "stagenet" | "local";
}>;

function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

export function readEnv(): Env {
  const networkRaw = getRequiredEnv("NETWORK");
  if (
    networkRaw !== "testnet" &&
    networkRaw !== "stagenet" &&
    networkRaw !== "local"
  ) {
    throw new Error(
      `Invalid NETWORK: ${networkRaw} (expected 'testnet', 'stagenet' or 'local')`
    );
  }
  const network = networkRaw;
  return { network };
}
