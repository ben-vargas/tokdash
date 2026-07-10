/** Unified command construction and shell-escaping safety. */

import { describe, expect, test } from "bun:test";
import {
  buildUnifiedFetchCommand,
  buildVersionCommand,
  CommandValidationError,
  extractJsonPayload,
  UNIFIED_TIMEOUT_MS,
} from "../src/server/command";
import type { HostConfig } from "../src/shared/types";

const HOST: HostConfig = {
  id: "local",
  label: "Local",
  color: "#7c8cf8",
  enabled: true,
  ssh: null,
  ccusageCmd: "bunx ccusage@latest",
};
const OPTS = {
  since: "2026-04-11",
  until: "2026-07-10",
  timezone: "America/Boise",
};

describe("buildUnifiedFetchCommand", () => {
  test("builds the exact one-invocation command without extra sources", () => {
    const built = buildUnifiedFetchCommand(HOST, OPTS);
    expect(built.command).toBe(
      "bunx ccusage@latest daily --json --sections daily,monthly,session --by-agent -s 2026-04-11 -u 2026-07-10 -z America/Boise",
    );
    expect(built.argv).toEqual([
      "ccusage",
      "daily",
      "--json",
      "--sections",
      "daily,monthly,session",
      "--by-agent",
      "-s",
      "2026-04-11",
      "-u",
      "2026-07-10",
      "-z",
      "America/Boise",
    ]);
  });

  test("writes named stores to one quoted temporary config", () => {
    const path = "/tmp/O'Malley omp sessions";
    const built = buildUnifiedFetchCommand(
      {
        ...HOST,
        extraSources: [
          { type: "pi-jsonl", agent: "omp", path },
          { type: "pi-jsonl", agent: "lab", path: "/tmp/lab sessions" },
        ],
      },
      OPTS,
    );
    const json = JSON.stringify({
      pi: {
        stores: [
          { name: "omp", path },
          { name: "lab", path: "/tmp/lab sessions" },
        ],
      },
    });
    const quotedJson = `'${json.replaceAll("'", "'\\''")}'`;
    expect(built.command).toBe(
      `CFG=$(mktemp); trap 'rm -f "$CFG"' EXIT; printf '%s' ${quotedJson} > "$CFG"; ` +
        "bunx ccusage@latest daily --json --sections daily,monthly,session --by-agent -s 2026-04-11 -u 2026-07-10 -z America/Boise --config \"$CFG\"",
    );
    expect(built.argv.at(-2)).toBe("--config");
    expect(built.argv.at(-1)).toBe("<tempfile>");
  });

  test.each([
    { since: "2026-01-01; id" },
    { until: "$(id)" },
    { timezone: "America/Boise; id" },
  ])("rejects unsafe window input %#", (bad) => {
    expect(() => buildUnifiedFetchCommand(HOST, bad)).toThrow(
      CommandValidationError,
    );
  });

  test("uses the fixed three-minute timeout", () => {
    expect(UNIFIED_TIMEOUT_MS).toBe(180_000);
  });
});

test("buildVersionCommand appends only --version", () => {
  expect(buildVersionCommand(HOST.ccusageCmd).command).toBe(
    "bunx ccusage@latest --version",
  );
});

test("extractJsonPayload tolerates surrounding bunx noise", () => {
  expect(extractJsonPayload('noise\n{"daily":[]}\nnotice')).toBe('{"daily":[]}');
  expect(extractJsonPayload("pure noise")).toBe("pure noise");
});
