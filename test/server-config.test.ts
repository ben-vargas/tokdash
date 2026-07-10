import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  readConfigFile,
  requireConfig,
  resolveConfigPath,
  writeConfigFile,
} from "../src/server/config";
import { isValidTimezone } from "../src/shared/dates";

let rootDir: string;
let configPath: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  rootDir = mkdtempSync(join(tmpdir(), "tokdash-config-test-"));
  process.chdir(rootDir);
  rootDir = process.cwd();
  configPath = join(rootDir, "tokdash.config.json");
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(rootDir, { recursive: true, force: true });
});

describe("config path resolution", () => {
  test("TOKDASH_CONFIG wins over the cwd file and XDG default", () => {
    writeFileSync(configPath, "{}");
    const envPath = join(rootDir, "explicit.json");
    expect(
      resolveConfigPath({
        TOKDASH_CONFIG: envPath,
        XDG_CONFIG_HOME: join(rootDir, "xdg"),
      }),
    ).toBe(envPath);
  });

  test("the cwd config wins when present without TOKDASH_CONFIG", () => {
    writeFileSync(configPath, "{}");
    expect(resolveConfigPath({ XDG_CONFIG_HOME: join(rootDir, "xdg") })).toBe(
      configPath,
    );
  });

  test("the XDG config path is used when no override exists", () => {
    const xdgHome = join(rootDir, "xdg-config");
    expect(resolveConfigPath({ XDG_CONFIG_HOME: xdgHome })).toBe(
      join(xdgHome, "tokdash", "config.json"),
    );
  });

  test("a custom XDG_CONFIG_HOME is respected", () => {
    const customHome = join(rootDir, "custom-config-home");
    expect(resolveConfigPath({ XDG_CONFIG_HOME: customHome })).toBe(
      join(customHome, "tokdash", "config.json"),
    );
  });

  test("XDG_CONFIG_HOME defaults to ~/.config when unset", () => {
    expect(resolveConfigPath({})).toBe(
      join(homedir(), ".config", "tokdash", "config.json"),
    );
  });
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

describe("config writes", () => {
  test("writeConfigFile creates missing parent directories", async () => {
    const nestedPath = join(rootDir, "a", "b", "c", "config.json");
    const config = requireConfig(nestedPath);
    await writeConfigFile(nestedPath, config);
    expect(readConfigFile(nestedPath)).toEqual({ ok: true, config });
  });
});
