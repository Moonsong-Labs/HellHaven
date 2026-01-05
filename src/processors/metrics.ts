import { toError } from "../helpers/errors.js";
import {
  persistVars,
  type ArtilleryContext,
  type ArtilleryEvents,
  type Done,
} from "../helpers/artillery.js";

/**
 * Utility step: mute metric emissions (counters/histograms) for subsequent steps.
 * Useful to run init-like steps without polluting Artillery summaries.
 */
export async function muteMetrics(
  context: ArtilleryContext,
  _events: ArtilleryEvents,
  done?: Done
): Promise<void> {
  try {
    // Policy: muted => emit only error counters, drop ok counters + histograms.
    persistVars(context, { __muteMetrics: true });
    done?.();
  } catch (err) {
    done?.(toError(err));
  }
}

/**
 * Utility step: unmute metric emissions.
 */
export async function unmuteMetrics(
  context: ArtilleryContext,
  _events: ArtilleryEvents,
  done?: Done
): Promise<void> {
  try {
    persistVars(context, { __muteMetrics: false });
    done?.();
  } catch (err) {
    done?.(toError(err));
  }
}
