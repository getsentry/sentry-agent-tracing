import { basename, dirname } from "node:path";
import type {
  MessageEndEvent,
  MessageUpdateEvent,
  SessionBeforeTreeEvent,
  SessionCompactEvent,
  SessionCompactFailedEvent,
  SessionTreeEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentEvent,
  GenAiMessage,
  GenAiToolDefinition,
  RequestParameters,
  SummaryEvent,
  TokenCost,
  TokenUsage,
} from "@sentry-internal/agent-tracing-core";
import {
  text,
  toFinishReason,
  toGenAiMessages,
  toGenAiOutputMessage,
  toGenAiToolDefinitions,
  type AssistantMessage,
  type LlmMessage,
} from "./messages.ts";
import { requestParameters } from "./request.ts";

type PiUsage = AssistantMessage["usage"];
/** The message of Node's AbortError, which an aborted request fails with. */
const ABORT_ERROR = "This operation was aborted";

interface Turn {
  id: string;
  aborted: boolean;
  error?: string;
}

export interface RequestModel {
  provider: string;
  id: string;
}

interface ModelCall {
  startTimestamp: number;
  firstChunkTimestamp?: number;
  model?: RequestModel;
  request?: RequestParameters;
  compacted: boolean;
  systemInstructions: string;
  inputMessages: GenAiMessage[];
  toolDefinitions: GenAiToolDefinition[];
}

/**
 * Turns the Pi extension events of one session into AgentEvents.
 *
 * A Pi agent run handles one user prompt and becomes a turn. It can span several agent_start and
 * agent_end pairs, for automatic retries, compaction recovery or queued messages, and is only over
 * at agent_settled. Pi's own turns are single model requests and become model calls.
 */
export class SessionRecorder {
  private turn?: Turn;
  private call?: ModelCall;
  private summaryStart?: {
    kind: SummaryEvent["kind"];
    timestamp: number;
    requestTimestamp?: number;
  };

  constructor(
    private readonly sessionId: string,
    private readonly emit: (event: AgentEvent) => void,
  ) {}

  sessionStart(): void {
    this.emit({ type: "session_start", ...this.base(), agent: "pi" });
  }

  sessionShutdown(): void {
    this.endTurn();
    this.emit({ type: "session_end", ...this.base() });
  }

  agentStart(): void {
    // A run that continues, for example to retry, starts again within the same turn.
    if (this.turn) {
      return;
    }
    this.turn = { id: crypto.randomUUID(), aborted: false };
    this.emit({ type: "turn_start", ...this.base(), turnId: this.turn.id });
  }

  agentSettled(aborted: boolean): void {
    if (this.turn && aborted) {
      this.turn.aborted = true;
    }
    this.endTurn();
  }

  context(
    messages: LlmMessage[],
    systemInstructions: string,
    tools: ToolInfo[],
    model: RequestModel | undefined,
    compacted: boolean,
  ): void {
    this.call = {
      startTimestamp: Date.now(),
      model,
      compacted,
      systemInstructions,
      inputMessages: toGenAiMessages(messages),
      toolDefinitions: toGenAiToolDefinitions(tools),
    };
  }

  providerRequest(payload: unknown): void {
    // Retries send the same context again; time the attempt that produced the response.
    if (this.call) {
      this.call.startTimestamp = Date.now();
      this.call.firstChunkTimestamp = undefined;
      this.call.request = requestParameters(payload);
    } else if (this.summaryStart) {
      // A request outside a model call of the agent is the one writing the summary.
      this.summaryStart.requestTimestamp = Date.now();
    }
  }

  /** The first text, thinking or tool call delta is the response's first content chunk. */
  messageUpdate(event: MessageUpdateEvent): void {
    if (
      this.call &&
      this.call.firstChunkTimestamp === undefined &&
      event.assistantMessageEvent.type.endsWith("_delta")
    ) {
      this.call.firstChunkTimestamp = Date.now();
    }
  }

  messageEnd(event: MessageEndEvent): void {
    const message = event.message as LlmMessage;
    if (!this.turn || message.role !== "assistant") {
      return;
    }
    this.emitModelCall(this.turn, message);
  }

  toolExecutionStart(event: ToolExecutionStartEvent, toolDescription: string | undefined): void {
    if (!this.turn) {
      return;
    }
    this.emit({
      type: "tool_call_start",
      ...this.base(),
      turnId: this.turn.id,
      toolCallId: event.toolCallId,
      parentToolCallId: event.parentToolCallId,
      toolName: event.toolName,
      toolDescription,
      skillName: skillName(event.toolName, event.args),
      arguments: event.args,
    });
  }

  compactionStart(): void {
    this.summaryStart = { kind: "compaction", timestamp: Date.now() };
  }

  /** `model` is Pi's current model, which writes Pi's own summaries. */
  compactionEnd(event: SessionCompactEvent, model: RequestModel | undefined): void {
    const entry = event.compactionEntry;
    this.emitSummary("compaction", event.fromExtension ? undefined : model, {
      reason: event.reason,
      summary: entry.summary,
      ...usageAndCost(entry.usage, false),
    });
  }

  compactionFailed(event: SessionCompactFailedEvent, model: RequestModel | undefined): void {
    // Pi rejects a compaction it can't run, for example of a session too small to compact,
    // before session_before_compact.
    if (this.summaryStart?.kind !== "compaction") {
      return;
    }
    this.emitSummary("compaction", event.fromExtension ? undefined : model, {
      reason: event.reason,
      error: event.aborted ? "cancelled" : (event.errorMessage ?? "Compaction failed"),
    });
  }

  treeStart(event: SessionBeforeTreeEvent): void {
    // Only moves that summarize the branch being left make a model request worth a span.
    this.summaryStart = event.preparation.userWantsSummary
      ? { kind: "branch_summary", timestamp: Date.now() }
      : undefined;
  }

  treeEnd(event: SessionTreeEvent, model: RequestModel | undefined): void {
    const entry = event.summaryEntry;
    if (!entry) {
      this.summaryStart = undefined;
      return;
    }
    this.emitSummary("branch_summary", event.fromExtension ? undefined : model, {
      summary: entry.summary,
      ...usageAndCost(entry.usage, false),
    });
  }

  toolExecutionEnd(event: ToolExecutionEndEvent): void {
    if (!this.turn) {
      return;
    }
    const result = toolResultText(event.result);
    const error = event.isError ? toolError(event.toolName, result) : undefined;
    this.emit({
      type: "tool_call_end",
      ...this.base(),
      toolCallId: event.toolCallId,
      result,
      error,
      errorType: error && ERROR_TYPES.find(([pattern]) => pattern.test(error))?.[1],
    });
  }

  private emitModelCall(turn: Turn, message: AssistantMessage): void {
    const call = this.call;
    this.call = undefined;
    const timestamp = Date.now();
    // Before Pi 1.1, an abort during a tool call is followed by a request that fails with the
    // abort signal's error.
    if (message.stopReason === "aborted" || message.errorMessage === ABORT_ERROR) {
      turn.aborted = true;
    }
    turn.error =
      message.stopReason === "error" ? (message.errorMessage ?? "Request error") : undefined;

    this.emit({
      type: "model_call",
      sessionId: this.sessionId,
      timestamp,
      turnId: turn.id,
      startTimestamp: call?.startTimestamp ?? timestamp,
      timeToFirstChunk:
        call?.firstChunkTimestamp === undefined
          ? undefined
          : (call.firstChunkTimestamp - call.startTimestamp) / 1000,
      provider: message.provider,
      // The model the user selected, which can be a virtual model that routes to another one.
      requestModel: call?.model?.id ?? message.model,
      reasoningLevel: message.providerThinkingLevel ?? message.thinkingLevel,
      responseModel: message.responseModel ?? message.model,
      responseId: message.responseId,
      finishReason: toFinishReason(message.stopReason),
      request: call?.request,
      compacted: call?.compacted,
      ...usageAndCost(
        message.usage,
        message.stopReason === "error" || message.stopReason === "aborted",
      ),
      systemInstructions: call?.systemInstructions,
      inputMessages: call?.inputMessages,
      outputMessages: [toGenAiOutputMessage(message)],
      toolDefinitions: call?.toolDefinitions,
      error:
        message.stopReason === "error" || message.stopReason === "aborted"
          ? (message.errorMessage ?? `Request ${message.stopReason}`)
          : undefined,
    });
  }

  /** Sends a request that got no response before the turn ended, as a failed model call. */
  private emitInterruptedCall(turn: Turn, call: ModelCall): void {
    const timestamp = Date.now();
    this.emit({
      type: "model_call",
      sessionId: this.sessionId,
      timestamp,
      turnId: turn.id,
      startTimestamp: call.startTimestamp,
      provider: call.model?.provider,
      requestModel: call.model?.id ?? "unknown",
      compacted: call.compacted,
      systemInstructions: call.systemInstructions,
      inputMessages: call.inputMessages,
      toolDefinitions: call.toolDefinitions,
      error: "Interrupted before a response",
    });
  }

  /** Without `model`, as for summaries written by an extension, no model request is known. */
  private emitSummary(
    kind: SummaryEvent["kind"],
    model: RequestModel | undefined,
    details: Omit<
      SummaryEvent,
      | "type"
      | "kind"
      | "sessionId"
      | "timestamp"
      | "startTimestamp"
      | "requestTimestamp"
      | "provider"
      | "requestModel"
    >,
  ): void {
    const timestamp = Date.now();
    const summaryStart = this.summaryStart?.kind === kind ? this.summaryStart : undefined;
    this.summaryStart = undefined;
    this.emit({
      type: "summary",
      sessionId: this.sessionId,
      timestamp,
      kind,
      turnId: this.turn?.id,
      startTimestamp: summaryStart?.timestamp ?? timestamp,
      requestTimestamp: summaryStart?.requestTimestamp,
      provider: model?.provider,
      requestModel: model?.id,
      ...details,
    });
  }

  private endTurn(): void {
    if (!this.turn) {
      return;
    }
    if (this.call) {
      this.turn.aborted = true;
      this.emitInterruptedCall(this.turn, this.call);
    }
    this.emit({
      type: "turn_end",
      ...this.base(),
      turnId: this.turn.id,
      interrupted: this.turn.aborted,
      // A run that ends on a failed request failed; an interrupted one is cancelled instead.
      error: this.turn.aborted ? undefined : this.turn.error,
    });
    this.turn = undefined;
    this.call = undefined;
  }

  private base(): { sessionId: string; timestamp: number } {
    return { sessionId: this.sessionId, timestamp: Date.now() };
  }
}

function toolResultText(result: unknown): unknown {
  if (
    typeof result === "object" &&
    result !== null &&
    "content" in result &&
    Array.isArray(result.content)
  ) {
    return text(result.content);
  }
  return result;
}

/** The fixed messages of Pi's own tool failures, with their `error.type`. */
const ERROR_TYPES: [RegExp, string][] = [
  [/^Tool \S+ not found$/, "tool_not_found"],
  [/^Validation failed for tool /, "invalid_arguments"],
  [
    /^Tool call "[^"]+" was not executed: the response hit the output token limit/,
    "truncated_arguments",
  ],
  [/^Tool execution was blocked$/, "blocked"],
  [/^(Operation|Command) aborted$/, "cancelled"],
  [/^Command timed out after /, "timeout"],
  [/^Command exited with code /, "exit_code"],
  [/^Command terminated without an exit code$/, "terminated"],
];

/** The status line Pi's bash tool appends to the output of a failed command. */
const BASH_STATUS =
  /^Command (exited with code |timed out after |aborted$|terminated without an exit code$)/;

/** A failed bash call's status line says why it failed; other tools' results are the error. */
function toolError(toolName: string, result: unknown): string {
  if (typeof result !== "string") {
    return "Tool failed";
  }
  if (toolName === "bash") {
    const status = result.trimEnd().split("\n").at(-1)?.trim();
    if (status && BASH_STATUS.test(status)) {
      return status;
    }
  }
  return result;
}

/**
 * Token counts and cost of a Pi response, in Sentry's terms: input includes cache reads and
 * writes. A failed request may not have been billed and reports 0 for everything, which would
 * read as a real call that cost nothing, so it gets neither unless it reports tokens.
 */
function usageAndCost(
  usage: PiUsage | undefined,
  unbilled: boolean,
): { usage?: TokenUsage; cost?: TokenCost } {
  if (!usage || (unbilled && !usage.totalTokens)) {
    return {};
  }
  return {
    usage: {
      inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
      outputTokens: usage.output,
      cacheReadInputTokens: usage.cacheRead,
      cacheCreationInputTokens: usage.cacheWrite,
      reasoningOutputTokens: usage.reasoning,
    },
    // Pi reports 0 for models it has no price for; Relay then prices the call itself.
    cost:
      usage.cost && usage.cost.total > 0
        ? {
            inputTokens: usage.cost.input + usage.cost.cacheRead + usage.cost.cacheWrite,
            outputTokens: usage.cost.output,
            cacheReadInputTokens: usage.cost.cacheRead,
            cacheCreationInputTokens: usage.cost.cacheWrite,
            totalTokens: usage.cost.total,
          }
        : undefined,
  };
}

/** The skill a call loads: models load a skill by reading its `SKILL.md`. */
function skillName(toolName: string, args: unknown): string | undefined {
  if (toolName !== "read" || typeof args !== "object" || args === null || !("path" in args)) {
    return undefined;
  }
  const { path } = args;
  return typeof path === "string" && basename(path).toLowerCase() === "skill.md"
    ? basename(dirname(path))
    : undefined;
}
