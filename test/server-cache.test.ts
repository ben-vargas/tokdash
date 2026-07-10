/**
 * Snapshot cache: atomic writes (temp + rename, no leftovers), load-on-read,
 * corrupt/invalid files degrade to "no snapshot" instead of crashing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotStore } from "../src/server/cache";
import { emptyHostUsageData } from "../src/shared/merge";
import type { HostSnapshot } from "../src/shared/types";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokdash-cache-test-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

function sampleSnapshot(hostId: string): HostSnapshot {
  return {
    hostId,
    fetchedAt: "2026-07-02T12:00:00.000Z",
    timezone: "America/Boise",
    window: { from: "2026-04-03", to: "2026-07-02" },
    commands: [
      {
        name: "unified",
        argv: ["ccusage", "daily", "--json", "--sections", "daily,monthly,session"],
        exitCode: 0,
        durationMs: 42,
        bytes: 120,
        stderrTail: "Saved lockfile",
        timedOut: false,
      },
    ],
    raw: { unified: '{"daily":[],"monthly":[],"session":[],"totals":{}}' },
    data: {
      ...emptyHostUsageData(),
      daily: [
        {
          date: "2026-06-01",
          cost: 12.5,
          agents: ["claude"],
          modelsUsed: ["claude-opus-4-8"],
          modelBreakdowns: [],
          inputTokens: 1,
          outputTokens: 2,
          cacheCreationTokens: 3,
          cacheReadTokens: 4,
          totalTokens: 10,
        },
      ],
      agents: ["claude"],
    },
    warnings: [],
    error: null,
  };
}

describe("SnapshotStore", () => {
  test("save + get round-trips through disk (fresh store instance)", async () => {
    const dir = tempDir();
    const store = new SnapshotStore(dir, () => {});
    await store.save(sampleSnapshot("local"));

    // a brand-new store must load from disk, not memory
    const reloaded = new SnapshotStore(dir, () => {});
    const snap = reloaded.get("local");
    expect(snap).not.toBeNull();
    expect(snap?.hostId).toBe("local");
    expect(snap?.data.daily[0]?.cost).toBe(12.5);
    expect(snap?.commands[0]?.name).toBe("unified");
  });

  test("atomic write: only <hostId>.json remains, no temp files", async () => {
    const dir = tempDir();
    const store = new SnapshotStore(dir, () => {});
    await store.save(sampleSnapshot("local"));
    await store.save(sampleSnapshot("local")); // overwrite path too
    const files = readdirSync(dir);
    expect(files).toEqual(["local.json"]);
    expect(files.some((f) => f.includes(".tmp"))).toBe(false);
  });

  test("missing snapshot => null", () => {
    const store = new SnapshotStore(tempDir(), () => {});
    expect(store.get("nope")).toBeNull();
  });

  test("corrupt JSON on disk => null, not a crash", () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "local.json"), '{"hostId": "local", truncated…');
    const warnings: string[] = [];
    const store = new SnapshotStore(dir, (m) => warnings.push(m));
    expect(store.get("local")).toBeNull();
    expect(warnings.length).toBe(1);
  });

  test("schema-invalid snapshot on disk => null, not a crash", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "local.json"),
      JSON.stringify({ hostId: "local", fetchedAt: 42, nonsense: true }),
    );
    const store = new SnapshotStore(dir, () => {});
    expect(store.get("local")).toBeNull();
  });

  test("snapshot whose hostId does not match its filename is ignored", async () => {
    const dir = tempDir();
    const store = new SnapshotStore(dir, () => {});
    await store.save(sampleSnapshot("other"));
    // copy other.json to local.json
    writeFileSync(
      join(dir, "local.json"),
      JSON.stringify(sampleSnapshot("other"), null, 2),
    );
    const fresh = new SnapshotStore(dir, () => {});
    expect(fresh.get("local")).toBeNull();
    expect(fresh.get("other")).not.toBeNull();
  });

  test("host ids never traverse the filesystem (encoded filenames)", async () => {
    const dir = tempDir();
    const store = new SnapshotStore(dir, () => {});
    await store.save(sampleSnapshot("we/../ird"));
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    expect(files[0]).toBe(`${encodeURIComponent("we/../ird")}.json`);
    expect(store.get("we/../ird")?.hostId).toBe("we/../ird");
  });

  test("save updates the in-memory copy immediately", async () => {
    const dir = tempDir();
    const store = new SnapshotStore(dir, () => {});
    expect(store.get("local")).toBeNull(); // memoized miss
    await store.save(sampleSnapshot("local"));
    expect(store.get("local")).not.toBeNull(); // save must refresh the memo
  });
});
