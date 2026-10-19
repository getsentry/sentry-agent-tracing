/**
 * Agent-agnostic events that every plugin maps its agent's native data onto.
 * The tracer turns these into the same trace shape for every agent:
 * one conversation per session, one trace per user turn.
 */
export type AgentEvent =
  | SessionStartEvent
  | SessionEndEvent
  | TurnStartEvent
  | TurnEndEvent
  | ModelCallEvent
  | ToolCallStartEvent
  | ToolCallEndEvent
  | SummaryEvent;

export type AgentName = "pi";

/** Timestamps are Unix epoch milliseconds. */
interface BaseEvent {
  sessionId: string;
  timestamp: number;
}

export interface SessionStartEvent extends BaseEvent {
  type: "session_start";
  agent: AgentName;
}

export interface SessionEndEvent extends BaseEvent {
  type: "session_end";
}

export interface TurnStartEvent extends BaseEvent {
  type: "turn_start";
  turnId: string;
}

export interface TurnEndEvent extends BaseEvent {
  type: "turn_end";
  turnId: string;
  interrupted?: boolean;
  error?: string;
}

/**
 * One model request. `timestamp` is when the response finished, and `timeToFirstChunk` the seconds
 * from the request until the first streamed chunk.
 */
export interface ModelCallEvent extends BaseEvent {
  type: "model_call";
  turnId: string;
  startTimestamp: number;
  timeToFirstChunk?: number;
  provider?: string;
  requestModel: string;
  reasoningLevel?: string;
  responseModel?: string;
  responseId?: string;
  finishReason?: string;
  usage?: TokenUsage;
  cost?: TokenCost;
  request?: RequestParameters;
  compacted?: boolean;
  systemInstructions?: string;
  inputMessages?: GenAiMessage[];
  outputMessages?: GenAiMessage[];
  toolDefinitions?: GenAiToolDefinition[];
  error?: string;
}

/** A message in the format of `gen_ai.input.messages` and `gen_ai.output.messages`. */
export interface GenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  parts: GenAiPart[];
  finish_reason?: string;
}

export type GenAiPart =
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_call"; id: string; name: string; arguments: unknown }
  | { type: "tool_call_response"; id: string; name?: string; result: unknown }
  // Images and other binary content, without their data.
  | { type: "blob"; mime_type: string };

/** A tool in the format of `gen_ai.tool.definitions`. */
export interface GenAiToolDefinition {
  type: "function";
  name: string;
  description?: string;
  parameters?: unknown;
}

/** Token counts of a model request. `inputTokens` includes cache reads and writes. */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningOutputTokens?: number;
}

/** Cost in USD, as reported by the agent. `inputTokens` includes cache reads and writes. */
export interface TokenCost {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalTokens?: number;
}

export interface RequestParameters {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: string;
  stopSequences?: string[];
}

/**
 * A tool call starts. `parentToolCallId` is set when another tool made the call, which it nests
 * under, and `skillName` when the call loads a skill, such as a read of its SKILL.md.
 */
export interface ToolCallStartEvent extends BaseEvent {
  type: "tool_call_start";
  turnId: string;
  toolCallId: string;
  parentToolCallId?: string;
  toolName: string;
  toolDescription?: string;
  skillName?: string;
  arguments?: unknown;
}

export interface ToolCallEndEvent extends BaseEvent {
  type: "tool_call_end";
  toolCallId: string;
  result?: unknown;
  error?: string;
  errorType?: string;
}

/**
 * A summary that replaces part of the conversation: a compaction, or the summary of a branch the
 * session moved away from. `timestamp` is when it finished. `turnId` is unset between turns, which
 * get a trace of their own. The `request*` fields, `usage` and `cost` describe the model request
 * that wrote the summary, and are unset when none is known. `reason` is what triggered it, such as
 * `manual` or `overflow`.
 */
export interface SummaryEvent extends BaseEvent {
  type: "summary";
  kind: "compaction" | "branch_summary";
  turnId?: string;
  startTimestamp: number;
  requestTimestamp?: number;
  provider?: string;
  requestModel?: string;
  reason?: string;
  summary?: string;
  usage?: TokenUsage;
  cost?: TokenCost;
  error?: string;
}
