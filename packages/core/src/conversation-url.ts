import type { Config } from "./config.ts";

/**
 * Links to a conversation (`gen_ai.conversation.id`) in Sentry. The DSN only has the
 * organization ID, so this needs the organization slug from the `org` setting; without it,
 * there is no link.
 */
export function conversationUrl(config: Config, conversationId: string): string | undefined {
  if (!config.org) {
    return undefined;
  }
  const dsn = new URL(config.dsn);
  const path = `explore/agents/conversations/${encodeURIComponent(conversationId)}/`;
  if (dsn.hostname === "sentry.io" || dsn.hostname.endsWith(".sentry.io")) {
    return `https://${config.org}.sentry.io/${path}`;
  }
  // Self-hosted Sentry serves the UI from the DSN's host.
  return `${dsn.protocol}//${dsn.host}/organizations/${config.org}/${path}`;
}
