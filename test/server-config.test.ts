import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfigFile, requireConfig } from "../src/server/config";
import { isValidTimezone } from "../src/shared/dates";

let rootDir: string;
let configPath: string;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "tokdash-config-test-"));
  configPath = join(rootDir, "tokdash.config.json");
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe("config file defaults", () => {
  test("readConfigFile returns a valid default config for a missing file", () => {
    const result = readConfigFile(configPath);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(isValidTimezone(result.config.timezone)).toBe(true);
    expect(result.config).toEqual({
      timezone: result.config.timezone,
      fetchWindowDays: 90,
      refreshIntervalMinutes: 15,
      hosts: [],
    });
  });

  test("requireConfig returns the same default config for a missing file", () => {
    const read = readConfigFile(configPath);
    if (!read.ok) throw new Error(read.error);
    expect(requireConfig(configPath)).toEqual(read.config);
  });

  test("an existing malformed file remains a hard error", () => {
    writeFileSync(configPath, "{ not valid JSON");
    const result = readConfigFile(configPath);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected malformed config to fail");
    expect(result.error).toContain("not valid JSON");
    expect(() => requireConfig(configPath)).toThrow("not valid JSON");
  });

  test("an existing schema-invalid file remains a hard error", () => {
    writeFileSync(configPath, JSON.stringify({ timezone: "UTC", hosts: [] }));
    const result = readConfigFile(configPath);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid config to fail");
    expect(result.error).toContain("config failed validation");
    expect(() => requireConfig(configPath)).toThrow("config failed validation");
  });

  test("a non-ENOENT read failure remains a hard error", () => {
    const result = readConfigFile(rootDir);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected unreadable config to fail");
    expect(result.error).toContain("cannot read config file");
    expect(() => requireConfig(rootDir)).toThrow("cannot read config file");
  });
});
