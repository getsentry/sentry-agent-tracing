import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  readConfigObject,
  readEnv,
  resolveConfig,
  type ConfigKey,
  type ConfigSource,
  type ResolvedConfig,
} from "@sentry-internal/agent-tracing-core";

export const ENV_PREFIX = "SENTRY_PI_";
const SETTINGS_KEY = "sentry";

export interface PiConfig extends ResolvedConfig {
  globalSettings: string;
  warnings: string[];
}

export interface Project {
  cwd: string;
  trusted: boolean;
}

/**
 * Reads the global settings, then the project settings, then the environment, with later ones
 * winning. The settings live in Pi's `settings.json` rather than a file of their own because Pi
 * only asks whether to trust a project when it has protected files like `.pi/settings.json`, and
 * treats every other project as trusted.
 * A trusted project can only set the environment and turn data collection off, so a repository
 * can't send the developer's sessions to a Sentry project it controls or collect more than they
 * allowed. Without `project`, as when the extension loads before a session starts, the project
 * settings are skipped.
 */
export function loadConfig(project?: Project, env: NodeJS.ProcessEnv = process.env): PiConfig {
  const warnings: string[] = [];
  const globalSettings = join(agentDir(env), "settings.json");
  const sources = [readSettings(globalSettings, warnings)];
  if (project) {
    sources.push(projectSettings(project, warnings));
  }
  sources.push(readEnv(ENV_PREFIX, env));
  return { ...resolveConfig(sources), globalSettings, warnings };
}

/** Pi's agent directory, like its `getAgentDir()`, which the extension doesn't import. */
function agentDir(env: NodeJS.ProcessEnv): string {
  const dir = env.PI_CODING_AGENT_DIR;
  if (!dir) {
    return join(homedir(), ".pi", "agent");
  }
  if (dir === "~") {
    return homedir();
  }
  return dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
}

function projectSettings({ cwd, trusted }: Project, warnings: string[]): ConfigSource {
  const path = join(cwd, ".pi", "settings.json");
  const source = readSettings(path, warnings);
  const keys = Object.keys(source.values);
  if (keys.length === 0) {
    return source;
  }
  if (!trusted) {
    warnings.push(`${path}: ignored because the project isn't trusted`);
    return { origin: source.origin, values: {} };
  }
  const values: ConfigSource["values"] = {};
  const ignored: string[] = [];
  for (const [key, value] of Object.entries(source.values) as [ConfigKey, string][]) {
    if (key === "environment" || (key.startsWith("dataCollection.") && value === "false")) {
      values[key] = value;
    } else {
      ignored.push(key);
    }
  }
  if (ignored.length > 0) {
    warnings.push(
      `${path}: ${ignored.join(", ")} ignored, a project can only set the environment and turn data collection off`,
    );
  }
  return { origin: source.origin, values };
}

/** The `sentry` object of a settings file; a missing file sets nothing. */
function readSettings(path: string, warnings: string[]): ConfigSource {
  let settings: unknown;
  try {
    // Pi strips a byte order mark before parsing.
    settings = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`${path}: ${(error as Error).message}`);
    }
    return { origin: () => path, values: {} };
  }
  try {
    return readConfigObject(path, (settings as Record<string, unknown> | null)?.[SETTINGS_KEY]);
  } catch (error) {
    warnings.push((error as Error).message);
    return { origin: () => path, values: {} };
  }
}
