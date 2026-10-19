import { homedir } from "node:os";
import { conversationUrl, envName, type ConfigKey } from "@sentry-internal/agent-tracing-core";
import { ENV_PREFIX, type PiConfig } from "./config.ts";

export function formatStatus(resolved: PiConfig, sessionId: string | undefined): string {
  const { config, origins } = resolved;
  if (!config) {
    return [
      "Sentry tracing is disabled: no DSN is set.",
      `Set ${envName(ENV_PREFIX, "dsn")}, or "sentry": { "dsn": "…" } in ${shorten(resolved.globalSettings)}.`,
      ...resolved.warnings.map(shorten),
    ].join("\n");
  }
  const setting = (key: ConfigKey, value: string | undefined) => {
    const origin = origins[key];
    return value === undefined ? [] : [`${key}: ${value}${origin ? ` (${shorten(origin)})` : ""}`];
  };
  const url = sessionId && conversationUrl(config, sessionId);
  return [
    "Sentry tracing is enabled.",
    ...setting("dsn", withoutKey(config.dsn)),
    ...setting("environment", config.environment),
    ...setting("org", config.org),
    ...setting("dataCollection.genAI.inputs", String(config.dataCollection.genAI.inputs)),
    ...setting("dataCollection.genAI.outputs", String(config.dataCollection.genAI.outputs)),
    ...(url ? [`conversation: ${url}`] : []),
    ...resolved.warnings.map(shorten),
  ].join("\n");
}

/** The DSN without its public key, for screenshots and screen shares. */
function withoutKey(dsn: string): string {
  try {
    const url = new URL(dsn);
    url.username = "";
    return url.toString();
  } catch {
    return dsn;
  }
}

function shorten(text: string): string {
  const home = homedir();
  return text.startsWith(home) ? `~${text.slice(home.length)}` : text;
}
