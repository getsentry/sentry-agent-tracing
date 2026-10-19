/**
 * GenAI attribute keys that aren't in `@sentry/conventions` yet, proposed in
 * getsentry/sentry-conventions#723.
 */
export const GEN_AI_CONVERSATION_COMPACTED = "gen_ai.conversation.compacted";
export const GEN_AI_CONVERSATION_COMPACTION_REASON = "gen_ai.conversation.compaction.reason";

/** Well-known values for `gen_ai.operation.name`. */
export const GEN_AI_OPERATION = {
  CHAT: "chat",
  COMPACT: "compact",
  EXECUTE_TOOL: "execute_tool",
  INVOKE_AGENT: "invoke_agent",
} as const;
