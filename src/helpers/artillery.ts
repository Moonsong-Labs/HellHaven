export type Done = (error?: Error) => void;

export type ArtilleryEvents = Readonly<{
  emit: (type: string, name: string, value: number) => void;
}>;

export type ArtilleryContext = {
  vars?: Record<string, unknown>;
};

export function ensureVars(context: ArtilleryContext): Record<string, unknown> {
  if (!context.vars) context.vars = {};
  return context.vars;
}

export function requireVarString(
  vars: Record<string, unknown>,
  key: string
): string {
  const v = vars[key];
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new Error(`Missing or invalid var: ${key}`);
  }
  return v.trim();
}


