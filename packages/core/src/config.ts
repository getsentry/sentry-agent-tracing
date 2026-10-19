export interface Config {
  dsn: string;
  environment?: string;
  org?: string;
  dataCollection: DataCollection;
}

/**
 * What is sent besides structure, timing, models, token usage and cost, like the JS SDK's
 * `dataCollection` option. Everything is collected by default. `genAI.inputs` covers the messages
 * sent to the model, system instructions and tool call arguments; `genAI.outputs` model responses
 * including reasoning, summaries, tool results and tool error messages.
 */
export interface DataCollection {
  genAI: {
    inputs: boolean;
    outputs: boolean;
  };
}

export type ConfigKey =
  | "dsn"
  | "environment"
  | "org"
  | "dataCollection.genAI.inputs"
  | "dataCollection.genAI.outputs";

/** `origin` names where a setting comes from, such as a file path or an environment variable. */
export interface ConfigSource {
  origin: (key: ConfigKey) => string;
  values: Partial<Record<ConfigKey, string>>;
}

/** `config` is `undefined` when no DSN is set, in which case plugins do nothing. */
export interface ResolvedConfig {
  config?: Config;
  origins: Partial<Record<ConfigKey, string>>;
}

const CONFIG_KEYS: ConfigKey[] = [
  "dsn",
  "environment",
  "org",
  "dataCollection.genAI.inputs",
  "dataCollection.genAI.outputs",
];

const BOOLEAN_KEYS = new Set<ConfigKey>([
  "dataCollection.genAI.inputs",
  "dataCollection.genAI.outputs",
]);

/**
 * The environment variable of a setting, such as `SENTRY_PI_DSN` for `dsn` or
 * `SENTRY_PI_DATA_COLLECTION_GEN_AI_INPUTS` for `dataCollection.genAI.inputs`.
 */
export function envName(prefix: string, key: ConfigKey): string {
  const parts = key.split(".").map((part) => part.replace(/([a-z])([A-Z])/g, "$1_$2"));
  return prefix + parts.join("_").toUpperCase();
}

/**
 * Reads the environment variable of each setting, such as `<prefix>DSN`. Each plugin has its own
 * prefix, so a `SENTRY_DSN` set for an app the developer works on doesn't send their agent
 * sessions to that app's project.
 * A variable set to an empty string still counts, which unsets the setting.
 */
export function readEnv(prefix: string, env: NodeJS.ProcessEnv = process.env): ConfigSource {
  const values: ConfigSource["values"] = {};
  for (const key of CONFIG_KEYS) {
    const value = env[envName(prefix, key)];
    if (value !== undefined) {
      values[key] = value;
    }
  }
  return { origin: (key) => envName(prefix, key), values };
}

/** `dataCollection` is a nested object of booleans. Throws when a setting has the wrong type. */
export function readConfigObject(name: string, object: unknown): ConfigSource {
  const origin = () => name;
  if (object === undefined) {
    return { origin, values: {} };
  }
  if (typeof object !== "object" || object === null || Array.isArray(object)) {
    throw new Error(`${name}: expected an object`);
  }
  const values: ConfigSource["values"] = {};
  for (const key of CONFIG_KEYS) {
    const value = key
      .split(".")
      .reduce<unknown>(
        (parent, part) =>
          typeof parent === "object" && parent !== null
            ? (parent as Record<string, unknown>)[part]
            : undefined,
        object,
      );
    if (value === undefined) {
      continue;
    }
    const boolean = BOOLEAN_KEYS.has(key);
    if (typeof value === "string" && !boolean) {
      values[key] = value;
    } else if (typeof value === "boolean" && boolean) {
      values[key] = String(value);
    } else {
      throw new Error(`${name}: ${key} must be ${boolean ? "true or false" : "a string"}`);
    }
  }
  return { origin, values };
}

/** Later sources win. */
export function resolveConfig(sources: ConfigSource[]): ResolvedConfig {
  const values: ConfigSource["values"] = {};
  const origins: ResolvedConfig["origins"] = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source.values) as [ConfigKey, string][]) {
      values[key] = value;
      origins[key] = source.origin(key);
    }
  }
  if (!values.dsn) {
    return { origins };
  }

  return {
    config: {
      dsn: values.dsn,
      environment: values.environment || undefined,
      org: values.org || undefined,
      dataCollection: {
        genAI: {
          inputs: parseBoolean(values["dataCollection.genAI.inputs"]),
          outputs: parseBoolean(values["dataCollection.genAI.outputs"]),
        },
      },
    },
    origins,
  };
}

/** Data collection is on unless turned off; an unknown value keeps the default. */
function parseBoolean(value: string | undefined): boolean {
  return !["0", "false", "no", "off"].includes(value?.toLowerCase() ?? "");
}
