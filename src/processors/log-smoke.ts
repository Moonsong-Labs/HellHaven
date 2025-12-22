import { getLogger } from "../log.js";

type Done = (error?: Error) => void;

type ArtilleryEvents = Readonly<{
  emit: (type: string, name: string, value: number) => void;
}>;

type ArtilleryContext = {
  vars?: Record<string, unknown>;
};

export async function logSmoke(
  context: ArtilleryContext,
  events: ArtilleryEvents,
  done?: Done
): Promise<void> {
  const logger = getLogger();
  logger.info(
    { pid: process.pid, cwd: process.cwd(), vars: context.vars ?? {} },
    "log-smoke info"
  );
  logger.debug({ pid: process.pid }, "log-smoke debug");
  events.emit("counter", "log.smoke.ok", 1);
  done?.();
}


