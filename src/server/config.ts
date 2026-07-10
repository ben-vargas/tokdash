/**
 * Config I/O. The file at TOKDASH_CONFIG (default ./tokdash.config.json) is
 * re-read FRESHLY on every API request — it is tiny, and this makes hand
 * edits take effect without a restart. Writes (PUT /api/config) validate
 * first, then atomically rewrite the whole document (temp file + rename).
 * An invalid config file on disk yields a clear 500 from the routes layer,
 * never a crash loop.
 */

import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { z } from "zod";
import { KNOWN_HARNESS_SET } from "../shared/constants";
import { isValidTimezone } from "../shared/dates";
import { appConfigSchema } from "../shared/schemas";
import type { AppConfig } from "../shared/types";

export function resolveConfigPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return resolve(env["TOKDASH_CONFIG"] ?? "tokdash.config.json");
}

export type ConfigReadResult =
  | { ok: true; config: AppConfig }
  | { ok: false; error: string };

function defaultConfig(): AppConfig {
  const guessedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    timezone: isValidTimezone(guessedTimezone) ? guessedTimezone : "UTC",
    fetchWindowDays: 90,
    refreshIntervalMinutes: 15,
    hosts: [],
  };
}

/**
 * Validate a candidate config document (schema + real-IANA timezone check —
 * TZ_RE alone accepts strings Intl rejects). Shared by reads and PUT.
 */
export function validateConfig(candidate: unknown): ConfigReadResult {
  const parsed = appConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, error: `config failed validation: ${z.prettifyError(parsed.error)}` };
  }
  if (!isValidTimezone(parsed.data.timezone)) {
    return {
      ok: false,
      error: `config timezone is not a valid IANA timezone: ${JSON.stringify(parsed.data.timezone)}`,
    };
  }
  const ids = parsed.data.hosts.map((h) => h.id);
  if (new Set(ids).size !== ids.length) {
    return { ok: false, error: "config host ids must be unique" };
  }
  const reservedAgents = new Set([...KNOWN_HARNESS_SET, "all", "pi"]);
  for (const host of parsed.data.hosts) {
    const sources = host.extraSources ?? [];
    const agents = new Set<string>();
    const paths = new Set<string>();
    const normalizedPaths: Array<{ raw: string; normalized: string }> = [];
    for (const source of sources) {
      if (reservedAgents.has(source.agent)) {
        return {
          ok: false,
          error: `config host ${JSON.stringify(host.id)} extraSources agent ${JSON.stringify(source.agent)} is reserved`,
        };
      }
      if (agents.has(source.agent)) {
        return {
          ok: false,
          error: `config host ${JSON.stringify(host.id)} extraSources agent names must be unique: ${JSON.stringify(source.agent)}`,
        };
      }
      agents.add(source.agent);
      const normalizedPath = posix.normalize(source.path);
      const normalized =
        normalizedPath === "/" ? normalizedPath : normalizedPath.replace(/\/+$/, "");
      if (paths.has(normalized)) {
        return {
          ok: false,
          error: `config host ${JSON.stringify(host.id)} extraSources paths must be unique: ${JSON.stringify(source.path)}`,
        };
      }
      paths.add(normalized);
      normalizedPaths.push({ raw: source.path, normalized });
    }
    for (let i = 0; i < normalizedPaths.length; i += 1) {
      for (let j = i + 1; j < normalizedPaths.length; j += 1) {
        const left = normalizedPaths[i]!;
        const right = normalizedPaths[j]!;
        const leftPrefix = left.normalized === "/" ? "/" : `${left.normalized}/`;
        const rightPrefix = right.normalized === "/" ? "/" : `${right.normalized}/`;
        if (
          left.normalized.startsWith(rightPrefix) ||
          right.normalized.startsWith(leftPrefix)
        ) {
          return {
            ok: false,
            error: `config host ${JSON.stringify(host.id)} extraSources paths must not overlap: ${JSON.stringify(left.raw)} and ${JSON.stringify(right.raw)}`,
          };
        }
      }
    }
  }
  return { ok: true, config: parsed.data };
}

/** Read + validate the config file. Never throws. */
export function readConfigFile(path: string): ConfigReadResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, config: defaultConfig() };
    }
    return { ok: false, error: `cannot read config file ${path}: ${String(err)}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `config file ${path} is not valid JSON: ${String(err)}` };
  }
  return validateConfig(json);
}

/** Like readConfigFile but throws — for RefreshManager's loadConfig. */
export function requireConfig(path: string): AppConfig {
  const result = readConfigFile(path);
  if (!result.ok) throw new Error(result.error);
  return result.config;
}

/** Validate then atomically rewrite the whole config document. */
export async function writeConfigFile(
  path: string,
  config: AppConfig,
): Promise<AppConfig> {
  const validated = validateConfig(config);
  if (!validated.ok) throw new Error(validated.error);
  const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await writeFile(tmp, `${JSON.stringify(validated.config, null, 2)}\n`, "utf8");
  await rename(tmp, path);
  return validated.config;
}
