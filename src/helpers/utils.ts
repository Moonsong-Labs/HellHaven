/**
 * Generic utility functions.
 */

/**
 * Sleep for a specified duration (milliseconds).
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

