/**
 * Multi-machine scoping.
 *
 * Every usage row carries a `machine_id`. Rows written by the in-process
 * watchers and the unauthenticated local monitor path use LOCAL_MACHINE_ID, so
 * a single-machine install behaves exactly as it did before the hub existed.
 * Remote edges post to `/api/ingest/v1` with their own stable id (a UUID from
 * the edge config, ideally) and their rows never collide with local ones even
 * when the provider hands both machines the same session id.
 */
export const LOCAL_MACHINE_ID = "local";

/** Machine ids are used in SQLite keys and URLs, so keep them short and sane. */
export const MAX_MACHINE_ID_LENGTH = 128;
export const MAX_MACHINE_LABEL_LENGTH = 128;

/** Machine scope handed to the db helpers. `label` is display-only. */
export interface MachineCtx {
  id: string;
  label?: string | null;
}

export const LOCAL_MACHINE: MachineCtx = { id: LOCAL_MACHINE_ID, label: null };

/**
 * Validate an edge-supplied machine id. Returns null when it can't be used —
 * the ingest route turns that into a 400 rather than silently bucketing a
 * malformed edge into `local` and corrupting the local machine's history.
 */
export function normalizeMachineId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  if (!id || id.length > MAX_MACHINE_ID_LENGTH) return null;
  // Conservative charset: what a UUID, a hostname or a slug needs, nothing more.
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) return null;
  return id;
}

export function normalizeMachineLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const label = raw.trim();
  if (!label) return null;
  return label.slice(0, MAX_MACHINE_LABEL_LENGTH);
}
