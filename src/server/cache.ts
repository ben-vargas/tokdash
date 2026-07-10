/**
 * Snapshot persistence: .cache/snapshots/<hostId>.json (stale-while-revalidate).
 *
 *   - Atomic writes: write a temp file in the same directory, then rename.
 *   - Load on startup / lazily on first access; schema-validated on read.
 *   - A corrupt or schema-invalid file degrades to "no snapshot" (warn, never
 *     crash) — and the LAST GOOD snapshot held in memory is never discarded
 *     by a later failure (the refresh layer only calls save() with either a
 *     fresh snapshot or a previous-preserving degraded one).
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostSnapshotSchema } from "../shared/schemas";
import type { HostSnapshot } from "../shared/types";

/** Host ids come from user config — never let them traverse the filesystem. */
function snapshotFileName(hostId: string): string {
  return `${encodeURIComponent(hostId)}.json`;
}

export class SnapshotStore {
  private readonly mem = new Map<string, HostSnapshot | null>();

  constructor(
    private readonly dir: string,
    private readonly log: (msg: string) => void = (msg) =>
      console.warn(`[cache] ${msg}`),
  ) {}

  get directory(): string {
    return this.dir;
  }

  /**
   * Last known snapshot for a host, or null. Reads through to disk once per
   * host; results (including misses) are memoized — save() refreshes them.
   */
  get(hostId: string): HostSnapshot | null {
    const cached = this.mem.get(hostId);
    if (cached !== undefined) return cached;
    const loaded = this.loadFromDisk(hostId);
    this.mem.set(hostId, loaded);
    return loaded;
  }

  private loadFromDisk(hostId: string): HostSnapshot | null {
    const path = join(this.dir, snapshotFileName(hostId));
    if (!existsSync(path)) return null;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (err) {
      this.log(`cannot read snapshot ${path}: ${String(err)}`);
      return null;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      this.log(`snapshot ${path} is not valid JSON; ignoring it`);
      return null;
    }
    const parsed = hostSnapshotSchema.safeParse(json);
    if (!parsed.success) {
      this.log(`snapshot ${path} failed schema validation; ignoring it`);
      return null;
    }
    if (parsed.data.hostId !== hostId) {
      this.log(`snapshot ${path} is for host ${parsed.data.hostId}; ignoring it`);
      return null;
    }
    return parsed.data;
  }

  /** Persist a snapshot atomically (temp file + rename) and update memory. */
  async save(snapshot: HostSnapshot): Promise<void> {
    this.mem.set(snapshot.hostId, snapshot);
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, snapshotFileName(snapshot.hostId));
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await rename(tmp, path);
  }
}
