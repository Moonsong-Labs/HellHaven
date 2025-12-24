export type Env = Readonly<{
  network: "testnet" | "stagenet" | "local";
}>;

export type NetworkName = Env["network"];

import { readRequiredEnv } from "./helpers/env.js";

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
  const network = parseNetworkName(readRequiredEnv("NETWORK"));
  return { network };
}
