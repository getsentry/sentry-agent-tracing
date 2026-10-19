import {
  createStackParser,
  generateTraceId,
  getDynamicSamplingContextFromSpan,
  Scope,
  SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN,
  SPAN_STATUS_ERROR,
  startInactiveSpan,
  type DynamicSamplingContext,
  type Envelope,
  type Span,
  type StartSpanOptions,
  withScope,
} from "@sentry/core";
import { nodeStackLineParser, ServerRuntimeClient } from "@sentry/core/server";
import {
  ERROR_TYPE,
  GEN_AI_AGENT_NAME,
  GEN_AI_CONVERSATION_ID,
  GEN_AI_COST_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_COST_CACHE_READ_INPUT_TOKENS,
  GEN_AI_COST_INPUT_TOKENS,
  GEN_AI_COST_OUTPUT_TOKENS,
  GEN_AI_COST_TOTAL_TOKENS,
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OPERATION_NAME,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_FREQUENCY_PENALTY,
  GEN_AI_REQUEST_MAX_TOKENS,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_REQUEST_PRESENCE_PENALTY,
  GEN_AI_REQUEST_REASONING_LEVEL,
  GEN_AI_REQUEST_SEED,
  GEN_AI_REQUEST_STOP_SEQUENCES,
  GEN_AI_REQUEST_TEMPERATURE,
  GEN_AI_REQUEST_TOP_K,
  GEN_AI_REQUEST_TOP_P,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_RESPONSE_ID,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_RESPONSE_STREAMING,
  GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK,
  GEN_AI_SYSTEM_INSTRUCTIONS,
  GEN_AI_TOOL_CALL_ARGUMENTS,
  GEN_AI_TOOL_CALL_RESULT,
  GEN_AI_TOOL_DEFINITIONS,
  GEN_AI_TOOL_DESCRIPTION,
  GEN_AI_TOOL_NAME,
  GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
  GEN_AI_USAGE_TOTAL_TOKENS,
} from "@sentry/conventions/attributes";
import {
  GEN_AI_CONVERSATION_COMPACTED,
  GEN_AI_CONVERSATION_COMPACTION_REASON,
  GEN_AI_OPERATION,
} from "./attributes.ts";
import type { Config, DataCollection } from "./config.ts";
import type {
  AgentEvent,
  GenAiMessage,
  GenAiToolDefinition,
  ModelCallEvent,
  RequestParameters,
  SessionStartEvent,
  SummaryEvent,
  TokenCost,
  TokenUsage,
  ToolCallEndEvent,
  ToolCallStartEvent,
  TurnEndEvent,
  TurnStartEvent,
} from "./events.ts";
import { makeFetchTransport } from "./transport.ts";

/** `flush` sends everything recorded so far, and never throws. */
export interface AgentTracer {
  handle(event: AgentEvent): void;
  flush(): Promise<void>;
}

const ORIGIN = "auto.gen_ai.agent_tracing";
const FLUSH_TIMEOUT_MS = 2000;
/**
 * Span status of interrupted turns, and of tools they left unfinished. Streamed
 * spans only know `ok` and `error`, and this arrives as `ok`, as in Sentry's pi-durable integration.
 */
const CANCELLED = "cancelled";

interface Turn {
  span: Span;
  tools: Map<string, Span>;
  usage: TokenUsage;
  input?: GenAiMessage[];
  output?: GenAiMessage[];
  toolDefinitions?: GenAiToolDefinition[];
}

/** `name` is the plugin, such as `pi` for `sentry.agent-tracing.pi`. */
export interface SdkInfo {
  name: string;
  version: string;
  packageName: string;
}

export function createTracer(config: Config, sdk: SdkInfo): AgentTracer {
  return new SentryTracer(config, sdk);
}

class SentryTracer implements AgentTracer {
  private readonly client: ServerRuntimeClient;
  private readonly collect: DataCollection;
  // Plugins run inside the agent's process, so the SDK uses its own client and scope
  // instead of Sentry.init(), which would install global handlers.
  private readonly scope = new Scope();
  private session?: SessionStartEvent;
  private readonly turns = new Map<string, Turn>();
  private readonly samplingContexts = new Map<string, Partial<DynamicSamplingContext>>();

  constructor(config: Config, sdk: SdkInfo) {
    this.collect = config.dataCollection;
    this.client = new ServerRuntimeClient({
      dsn: config.dsn,
      environment: config.environment,
      platform: "node",
      runtime: { name: "node", version: process.version },
      tracesSampleRate: 1,
      integrations: [],
      sendClientReports: false,
      transport: makeFetchTransport,
      stackParser: createStackParser(nodeStackLineParser()),
      // Sent as the User-Agent, in the envelope header, and as sentry.sdk.* on every span.
      _metadata: {
        sdk: {
          name: `sentry.agent-tracing.${sdk.name}`,
          version: sdk.version,
          packages: [{ name: `npm:${sdk.packageName}`, version: sdk.version }],
        },
      },
    });
    this.scope.setClient(this.client);
    this.client.on("beforeEnvelope", (envelope) => this.addSamplingContext(envelope));
    this.client.init();
  }

  handle(event: AgentEvent): void {
    try {
      this.dispatch(event);
    } catch {
      // A broken event must never affect the agent.
    }
  }

  private dispatch(event: AgentEvent): void {
    switch (event.type) {
      case "session_start":
        return this.sessionStart(event);
      case "session_end":
        return this.sessionEnd(event.timestamp);
      case "turn_start":
        return this.turnStart(event);
      case "turn_end":
        return this.turnEnd(event);
      case "model_call":
        return this.modelCall(event);
      case "tool_call_start":
        return this.toolCallStart(event);
      case "tool_call_end":
        return this.toolCallEnd(event);
      case "summary":
        return this.summary(event);
    }
  }

  async flush(): Promise<void> {
    try {
      await this.client.flush(FLUSH_TIMEOUT_MS);
    } catch {
      // Losing telemetry must never affect the agent.
    }
  }

  private sessionStart(event: SessionStartEvent): void {
    this.session = event;
    // Scope attributes are added to every span.
    this.scope.setAttributes({ [GEN_AI_AGENT_NAME]: event.agent });
  }

  private sessionEnd(timestamp: number): void {
    for (const turnId of this.turns.keys()) {
      this.endTurn(turnId, timestamp);
    }
  }

  private turnStart(event: TurnStartEvent): void {
    const agentName = this.session?.agent ?? "agent";
    this.scope.setPropagationContext({ traceId: generateTraceId(), sampleRand: Math.random() });
    // The prompt, the final response and the available tools are added when the turn ends.
    const span = this.startRootSpan({
      name: `invoke_agent ${agentName}`,
      op: "gen_ai.invoke_agent",
      startTime: event.timestamp,
      attributes: {
        ...this.commonAttributes(event.sessionId),
        [GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION.INVOKE_AGENT,
      },
    });
    this.turns.set(event.turnId, { span, tools: new Map(), usage: {} });
  }

  private turnEnd(event: TurnEndEvent): void {
    this.endTurn(
      event.turnId,
      event.timestamp,
      event.error ?? (event.interrupted ? CANCELLED : undefined),
    );
  }

  private endTurn(turnId: string, timestamp: number, error?: string): void {
    const turn = this.turns.get(turnId);
    if (!turn) {
      return;
    }
    this.turns.delete(turnId);

    // Close whatever an interruption left open, so the trace is complete.
    for (const span of turn.tools.values()) {
      span.setStatus({ code: SPAN_STATUS_ERROR, message: CANCELLED });
      this.endSpan(span, timestamp);
    }
    turn.span.setAttributes({
      ...usageAttributes(turn.usage),
      ...(this.collect.genAI.inputs && {
        [GEN_AI_INPUT_MESSAGES]: turn.input && JSON.stringify(turn.input),
      }),
      [GEN_AI_OUTPUT_MESSAGES]:
        this.collect.genAI.outputs && turn.output ? JSON.stringify(turn.output) : undefined,
      [GEN_AI_TOOL_DEFINITIONS]: turn.toolDefinitions && JSON.stringify(turn.toolDefinitions),
    });
    if (error) {
      turn.span.setStatus({ code: SPAN_STATUS_ERROR, message: error });
    }
    this.endSpan(turn.span, timestamp);
  }

  private modelCall(event: ModelCallEvent): void {
    const turn = this.turns.get(event.turnId);
    if (!turn) {
      return;
    }
    const span = this.startSpan({
      parentSpan: turn.span,
      name: `chat ${event.requestModel}`,
      op: "gen_ai.chat",
      startTime: event.startTimestamp,
      attributes: {
        ...this.commonAttributes(event.sessionId),
        [GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION.CHAT,
        // Only ever true: the conventions leave it unset unless compaction is known.
        [GEN_AI_CONVERSATION_COMPACTED]: event.compacted || undefined,
        [GEN_AI_PROVIDER_NAME]: event.provider,
        [GEN_AI_REQUEST_MODEL]: event.requestModel,
        [GEN_AI_REQUEST_REASONING_LEVEL]: event.reasoningLevel,
        ...requestAttributes(event.request),
        // Required on chat spans; fall back to the requested model when the provider doesn't report one.
        [GEN_AI_RESPONSE_MODEL]: event.responseModel ?? event.requestModel,
        [GEN_AI_RESPONSE_ID]: event.responseId,
        [GEN_AI_RESPONSE_FINISH_REASONS]:
          event.finishReason && JSON.stringify([event.finishReason]),
        [GEN_AI_RESPONSE_STREAMING]: event.timeToFirstChunk !== undefined,
        [GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK]: event.timeToFirstChunk,
        ...usageAttributes(event.usage),
        ...costAttributes(event.cost),
        ...(this.collect.genAI.inputs && {
          [GEN_AI_SYSTEM_INSTRUCTIONS]: event.systemInstructions,
          [GEN_AI_INPUT_MESSAGES]:
            event.inputMessages &&
            JSON.stringify(event.inputMessages.filter((message) => message.role !== "system")),
        }),
        [GEN_AI_OUTPUT_MESSAGES]:
          this.collect.genAI.outputs && event.outputMessages
            ? JSON.stringify(event.outputMessages)
            : undefined,
        [GEN_AI_TOOL_DEFINITIONS]: event.toolDefinitions && JSON.stringify(event.toolDefinitions),
      },
    });
    if (event.error) {
      span.setStatus({ code: SPAN_STATUS_ERROR, message: event.error });
    }
    this.endSpan(span, event.timestamp);
    if (event.usage) {
      addUsage(turn.usage, event.usage);
    }
    turn.input ??= event.inputMessages && promptMessages(event.inputMessages);
    turn.output = event.outputMessages ?? turn.output;
    turn.toolDefinitions = event.toolDefinitions ?? turn.toolDefinitions;
  }

  private toolCallStart(event: ToolCallStartEvent): void {
    const turn = this.turns.get(event.turnId);
    if (!turn) {
      return;
    }
    const parentSpan =
      (event.parentToolCallId && turn.tools.get(event.parentToolCallId)) || turn.span;
    const span = this.startSpan({
      parentSpan,
      name: event.skillName
        ? `execute_tool skill ${event.skillName}`
        : `execute_tool ${event.toolName}`,
      op: "gen_ai.execute_tool",
      startTime: event.timestamp,
      attributes: {
        ...this.commonAttributes(event.sessionId),
        [GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION.EXECUTE_TOOL,
        [GEN_AI_TOOL_NAME]: event.toolName,
        [GEN_AI_TOOL_DESCRIPTION]: event.toolDescription,
        [GEN_AI_TOOL_CALL_ARGUMENTS]: this.collect.genAI.inputs
          ? stringify(event.arguments)
          : undefined,
      },
    });
    turn.tools.set(event.toolCallId, span);
  }

  private toolCallEnd(event: ToolCallEndEvent): void {
    const turn = this.findTurn((turn) => turn.tools.has(event.toolCallId));
    const span = turn?.tools.get(event.toolCallId);
    if (!turn || !span) {
      return;
    }
    turn.tools.delete(event.toolCallId);
    if (this.collect.genAI.outputs) {
      span.setAttribute(GEN_AI_TOOL_CALL_RESULT, stringify(event.result));
    }
    if (event.error) {
      // The message is often the tool's output.
      span.setStatus({
        code: SPAN_STATUS_ERROR,
        message: this.collect.genAI.outputs ? event.error : "Tool failed",
      });
      // Feeds the Tool Errors widget. Without a known kind of failure, OTel's generic value.
      span.setAttribute(ERROR_TYPE, event.errorType ?? "_OTHER");
    }
    this.endSpan(span, event.timestamp);
  }

  /**
   * A compaction becomes a `compact` span with the request that wrote the summary as a `chat`
   * child, a branch summary just that `chat` span. Between turns, they get a trace of their own.
   */
  private summary(event: SummaryEvent): void {
    const turn = event.turnId === undefined ? undefined : this.turns.get(event.turnId);
    if (!turn) {
      this.scope.setPropagationContext({ traceId: generateTraceId(), sampleRand: Math.random() });
    }
    const start = (options: StartSpanOptions, parentSpan: Span | undefined): Span =>
      parentSpan ? this.startSpan({ ...options, parentSpan }) : this.startRootSpan(options);

    const compact =
      event.kind === "compaction"
        ? start(
            {
              name: GEN_AI_OPERATION.COMPACT,
              op: "gen_ai.compact",
              startTime: event.startTimestamp,
              attributes: {
                ...this.commonAttributes(event.sessionId),
                [GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION.COMPACT,
                [GEN_AI_CONVERSATION_COMPACTION_REASON]: event.reason,
              },
            },
            turn?.span,
          )
        : undefined;

    if (event.requestModel !== undefined && event.summary !== undefined) {
      const chat = start(
        {
          name: `chat ${event.requestModel}`,
          op: "gen_ai.chat",
          startTime: event.requestTimestamp ?? event.startTimestamp,
          attributes: {
            ...this.commonAttributes(event.sessionId),
            [GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION.CHAT,
            [GEN_AI_PROVIDER_NAME]: event.provider,
            [GEN_AI_REQUEST_MODEL]: event.requestModel,
            [GEN_AI_RESPONSE_MODEL]: event.requestModel,
            ...usageAttributes(event.usage),
            ...costAttributes(event.cost),
            [GEN_AI_OUTPUT_MESSAGES]: this.collect.genAI.outputs
              ? JSON.stringify([
                  {
                    role: "assistant",
                    parts: [{ type: "text", content: event.summary }],
                    finish_reason: "stop",
                  },
                ])
              : undefined,
          },
        },
        compact ?? turn?.span,
      );
      this.endSpan(chat, event.timestamp);
      if (turn && event.usage) {
        addUsage(turn.usage, event.usage);
      }
    }

    if (compact) {
      if (event.error) {
        compact.setStatus({ code: SPAN_STATUS_ERROR, message: event.error });
      }
      this.endSpan(compact, event.timestamp);
    }
  }

  private commonAttributes(sessionId: string): Record<string, string> {
    return {
      [SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: ORIGIN,
      [GEN_AI_CONVERSATION_ID]: sessionId,
    };
  }

  /**
   * Starts the root span of a trace and keeps the trace's dynamic sampling context. The SDK only
   * computes it with a client on the global scope, so `addSamplingContext` adds it to the trace's
   * span envelopes, which Sentry rejects without one.
   */
  private startRootSpan(options: StartSpanOptions): Span {
    const span = this.startSpan({ ...options, parentSpan: null });
    this.samplingContexts.set(
      span.spanContext().traceId,
      withScope(this.scope, () => getDynamicSamplingContextFromSpan(span)),
    );
    return span;
  }

  private addSamplingContext(envelope: Envelope): void {
    const headers = envelope[0] as { trace?: Partial<DynamicSamplingContext> };
    for (const [itemHeaders, payload] of envelope[1]) {
      if (itemHeaders.type !== "span") {
        continue;
      }
      const spans = (payload as { items: { trace_id: string; is_segment?: boolean }[] }).items;
      const traceId = spans[0]?.trace_id;
      const dsc = traceId === undefined ? undefined : this.samplingContexts.get(traceId);
      if (traceId === undefined || !dsc) {
        continue;
      }
      headers.trace ??= dsc;
      // The root span ends last, so no later envelope belongs to its trace.
      if (spans.some((span) => span.is_segment)) {
        this.samplingContexts.delete(traceId);
      }
    }
  }

  private startSpan(options: StartSpanOptions): Span {
    return startInactiveSpan({ ...options, scope: this.scope });
  }

  private endSpan(span: Span, timestamp: number): void {
    // A span hands itself to the client of the current scope when it ends, and only that client
    // streams it. Making the tracer's scope current just for the call keeps the client out of the
    // agent's global scope; without one there, a root span would be sent as a transaction instead.
    withScope(this.scope, () => span.end(timestamp));
  }

  private findTurn(predicate: (turn: Turn) => boolean): Turn | undefined {
    for (const turn of this.turns.values()) {
      if (predicate(turn)) {
        return turn;
      }
    }
    return undefined;
  }
}

function usageAttributes(usage: TokenUsage | undefined): Record<string, number | undefined> {
  return {
    [GEN_AI_USAGE_INPUT_TOKENS]: usage?.inputTokens,
    [GEN_AI_USAGE_OUTPUT_TOKENS]: usage?.outputTokens,
    [GEN_AI_USAGE_TOTAL_TOKENS]:
      usage?.inputTokens === undefined || usage.outputTokens === undefined
        ? undefined
        : usage.inputTokens + usage.outputTokens,
    [GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: usage?.cacheReadInputTokens,
    [GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS]: usage?.cacheCreationInputTokens,
    [GEN_AI_USAGE_REASONING_OUTPUT_TOKENS]: usage?.reasoningOutputTokens,
  };
}

/** Relay keeps a reported total cost instead of pricing the call from Sentry's model list. */
function costAttributes(cost: TokenCost | undefined): Record<string, number | undefined> {
  return {
    [GEN_AI_COST_INPUT_TOKENS]: cost?.inputTokens,
    [GEN_AI_COST_OUTPUT_TOKENS]: cost?.outputTokens,
    [GEN_AI_COST_CACHE_READ_INPUT_TOKENS]: cost?.cacheReadInputTokens,
    [GEN_AI_COST_CACHE_CREATION_INPUT_TOKENS]: cost?.cacheCreationInputTokens,
    [GEN_AI_COST_TOTAL_TOKENS]: cost?.totalTokens,
  };
}

function requestAttributes(
  request: RequestParameters | undefined,
): Record<string, number | string | string[] | undefined> {
  return {
    [GEN_AI_REQUEST_TEMPERATURE]: request?.temperature,
    [GEN_AI_REQUEST_TOP_P]: request?.topP,
    [GEN_AI_REQUEST_TOP_K]: request?.topK,
    [GEN_AI_REQUEST_MAX_TOKENS]: request?.maxTokens,
    [GEN_AI_REQUEST_FREQUENCY_PENALTY]: request?.frequencyPenalty,
    [GEN_AI_REQUEST_PRESENCE_PENALTY]: request?.presencePenalty,
    [GEN_AI_REQUEST_SEED]: request?.seed,
    [GEN_AI_REQUEST_STOP_SEQUENCES]: request?.stopSequences,
  };
}

/** A count stays unset until some call reports it. */
function addUsage(total: TokenUsage, usage: TokenUsage): void {
  for (const key of Object.keys(usage) as (keyof TokenUsage)[]) {
    const value = usage[key];
    if (value !== undefined) {
      total[key] = (total[key] ?? 0) + value;
    }
  }
}

/** The messages a turn starts with: those after the previous turn's last model response. */
function promptMessages(messages: GenAiMessage[]): GenAiMessage[] {
  const lastResponse = messages.findLastIndex((message) => message.role === "assistant");
  return messages.slice(lastResponse + 1).filter((message) => message.role !== "system");
}

function stringify(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}
