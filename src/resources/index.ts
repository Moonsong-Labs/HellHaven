import { RESOURCES } from "./manifest.js";

export { RESOURCES };

export function pickRandomResource() {
  if (RESOURCES.length === 0) {
    throw new Error(
      "No resources available. Add files under `resources/` and run `pnpm build` (or `pnpm util:resources:manifest`)."
    );
  }
  const idx = Math.floor(Math.random() * RESOURCES.length);
  const picked = RESOURCES[idx];
  if (!picked)
    throw new Error("pickRandomResourceOrThrow: index out of bounds");
  return picked;
}

export function pickSequentialResource(params: Readonly<{ sequence: number }>) {
  if (RESOURCES.length === 0) {
    throw new Error(
      "No resources available. Add files under `resources/` and run `pnpm build` (or `pnpm util:resources:manifest`)."
    );
  }
  const idx =
    ((params.sequence % RESOURCES.length) + RESOURCES.length) %
    RESOURCES.length;
  const picked = RESOURCES[idx];
  if (!picked) throw new Error("pickSequentialResource: index out of bounds");
  return picked;
}
