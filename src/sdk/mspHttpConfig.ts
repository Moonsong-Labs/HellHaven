import type { HttpClientConfig } from "@storagehub-sdk/core";
import type { NetworkConfig } from "../networks.js";

/**
 * Build the HttpClientConfig for connecting to the MSP service for a given network.
 * Intentionally tiny so processors can stay "ultra clean".
 */
export function buildMspHttpClientConfig(
  network: NetworkConfig
): HttpClientConfig {
  return {
    baseUrl: network.msp.baseUrl,
    ...(typeof network.msp.timeoutMs === "number"
      ? { timeoutMs: network.msp.timeoutMs }
      : {}),
  } satisfies HttpClientConfig;
}
