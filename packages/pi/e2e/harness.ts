import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect } from "vite-plus/test";

/** The Pi CLI to test: `PI_BIN`, or the dev dependency. */
export const PI_BIN =
  process.env.PI_BIN ?? fileURLToPath(new URL("../node_modules/.bin/pi", import.meta.url));
/** The extension to test: `PI_EXTENSION`, such as the unpacked npm tarball, or the build. */
const EXTENSION =
  process.env.PI_EXTENSION ?? fileURLToPath(new URL("../dist/index.mjs", import.meta.url));
/** Commands and hooks that only tests need, loaded next to the extension. */
const FIXTURE = fileURLToPath(new URL("fixture.ts", import.meta.url));

export const MODEL = "mock-model";
/** The mock providers, one per API format Pi speaks. */
export const PROVIDERS = {
  openai: "mock",
  anthropic: "mock-anthropic",
  responses: "mock-responses",
  google: "mock-google",
} as const;
export const PROVIDER = PROVIDERS.openai;

export const PI_VERSION = execFileSync(PI_BIN, ["--version"], { encoding: "utf8" }).trim();

export function piAtLeast(version: string): boolean {
  const parse = (value: string) => value.split(".").map(Number);
  const [running, wanted] = [parse(PI_VERSION), parse(version)];
  for (let index = 0; index < 3; index += 1) {
    if (running[index] !== wanted[index]) {
      return running[index] > wanted[index];
    }
  }
  return true;
}

export interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  reasoning?: number;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** One response of the mock model, in the order Pi makes requests. */
export type Reply =
  | { text?: string; reasoning?: string; toolCalls?: ToolCall[]; usage?: Usage }
  | { status: number; message?: string }
  /** Starts streaming a response and never finishes it. */
  | { hang: true };

export const DEFAULT_USAGE = { input: 100, output: 20, cacheRead: 0, reasoning: 0 };

/** A model endpoint for each of Pi's API formats that streams scripted replies. */
export class MockModel {
  readonly replies: Reply[] = [];
  readonly requests: Record<string, unknown>[] = [];

  private constructor(private readonly server: Server) {}

  static async start(): Promise<MockModel> {
    let model: MockModel | undefined;
    const server = createServer(async (req, res) => {
      const payload = JSON.parse(await body(req)) as Record<string, unknown>;
      model?.requests.push(payload);
      const reply = model?.replies.shift() ?? { text: "Done." };
      if ("status" in reply) {
        res.writeHead(reply.status, { "content-type": "application/json" });
        const message = reply.message ?? "mock failure";
        const type = reply.status >= 500 ? "server_error" : "invalid_request_error";
        res.end(JSON.stringify({ type: "error", error: { message, type } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const id = `resp_${model?.requests.length}`;
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      const format = path.endsWith(":streamGenerateContent")
        ? streamGoogle
        : path.endsWith("/messages")
          ? streamAnthropic
          : path.endsWith("/responses")
            ? streamResponses
            : streamOpenAi;
      if ("hang" in reply) {
        format(res, id, { text: "Let me think" }, false);
        return;
      }
      format(res, id, reply, true);
    });
    model = new MockModel(await listen(server));
    return model;
  }

  get url(): string {
    return `http://127.0.0.1:${port(this.server)}`;
  }

  close(): Promise<void> {
    this.server.closeAllConnections();
    return close(this.server);
  }
}

type Streamed = Extract<Reply, { text?: string }>;
type Stream = (res: ServerResponse, id: string, reply: Streamed, finish: boolean) => void;

function usageOf(reply: Streamed): typeof DEFAULT_USAGE {
  return { ...DEFAULT_USAGE, ...reply.usage };
}

function sse(res: ServerResponse, data: unknown, event?: string): void {
  res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
}

const streamOpenAi: Stream = (res, id, reply, finish) => {
  const chunk = (fields: Record<string, unknown>) =>
    sse(res, { id, object: "chat.completion.chunk", created: 0, model: MODEL, ...fields });
  const delta = (delta: Record<string, unknown>) => chunk({ choices: [{ index: 0, delta }] });
  delta({ role: "assistant" });
  if (reply.reasoning) {
    delta({ reasoning_content: reply.reasoning });
  }
  if (reply.text) {
    delta({ content: reply.text });
  }
  for (const [index, call] of (reply.toolCalls ?? []).entries()) {
    delta({
      tool_calls: [
        {
          index,
          id: `call_${id}_${index}`,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        },
      ],
    });
  }
  if (!finish) {
    return;
  }
  const finishReason = reply.toolCalls?.length ? "tool_calls" : "stop";
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
  const usage = usageOf(reply);
  chunk({
    choices: [],
    usage: {
      prompt_tokens: usage.input,
      completion_tokens: usage.output,
      total_tokens: usage.input + usage.output,
      prompt_tokens_details: { cached_tokens: usage.cacheRead },
      completion_tokens_details: { reasoning_tokens: usage.reasoning },
    },
  });
  res.end("data: [DONE]\n\n");
};

const streamAnthropic: Stream = (res, id, reply, finish) => {
  const event = (type: string, fields: Record<string, unknown> = {}) =>
    sse(res, { type, ...fields }, type);
  const usage = usageOf(reply);
  event("message_start", {
    message: {
      id,
      type: "message",
      role: "assistant",
      model: MODEL,
      content: [],
      stop_reason: null,
      usage: {
        input_tokens: usage.input - usage.cacheRead,
        output_tokens: 0,
        cache_read_input_tokens: usage.cacheRead,
        cache_creation_input_tokens: 0,
      },
    },
  });
  const blocks: [Record<string, unknown>, Record<string, unknown>][] = [];
  if (reply.text) {
    blocks.push([
      { type: "text", text: "" },
      { type: "text_delta", text: reply.text },
    ]);
  }
  for (const [index, call] of (reply.toolCalls ?? []).entries()) {
    blocks.push([
      { type: "tool_use", id: `toolu_${id}_${index}`, name: call.name, input: {} },
      { type: "input_json_delta", partial_json: JSON.stringify(call.arguments) },
    ]);
  }
  for (const [index, [block, delta]] of blocks.entries()) {
    event("content_block_start", { index, content_block: block });
    event("content_block_delta", { index, delta });
    if (!finish) {
      return;
    }
    event("content_block_stop", { index });
  }
  event("message_delta", {
    delta: { stop_reason: reply.toolCalls?.length ? "tool_use" : "end_turn" },
    usage: { output_tokens: usage.output },
  });
  event("message_stop");
  res.end();
};

const streamResponses: Stream = (res, id, reply, finish) => {
  const event = (type: string, fields: Record<string, unknown> = {}) =>
    sse(res, { type, ...fields }, type);
  const usage = usageOf(reply);
  const response = { id, object: "response", model: MODEL, status: "in_progress", output: [] };
  event("response.created", { response });
  const items: Record<string, unknown>[] = [];
  if (reply.text) {
    const item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed" };
    event("response.output_item.added", {
      output_index: items.length,
      item: { ...item, content: [] },
    });
    event("response.output_text.delta", {
      output_index: items.length,
      content_index: 0,
      item_id: item.id,
      delta: reply.text,
    });
    items.push({ ...item, content: [{ type: "output_text", text: reply.text, annotations: [] }] });
  }
  for (const [index, call] of (reply.toolCalls ?? []).entries()) {
    const item = {
      type: "function_call",
      id: `fc_${id}_${index}`,
      call_id: `call_${id}_${index}`,
      name: call.name,
      status: "completed",
    };
    event("response.output_item.added", {
      output_index: items.length,
      item: { ...item, arguments: "" },
    });
    items.push({ ...item, arguments: JSON.stringify(call.arguments) });
  }
  if (!finish) {
    return;
  }
  for (const [index, item] of items.entries()) {
    event("response.output_item.done", { output_index: index, item });
  }
  event("response.completed", {
    response: {
      ...response,
      status: "completed",
      output: items,
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        total_tokens: usage.input + usage.output,
        input_tokens_details: { cached_tokens: usage.cacheRead },
        output_tokens_details: { reasoning_tokens: usage.reasoning },
      },
    },
  });
  res.end();
};

const streamGoogle: Stream = (res, id, reply, finish) => {
  const usage = usageOf(reply);
  const parts: Record<string, unknown>[] = [];
  if (reply.text) {
    parts.push({ text: reply.text });
  }
  for (const call of reply.toolCalls ?? []) {
    parts.push({ functionCall: { name: call.name, args: call.arguments } });
  }
  sse(res, {
    responseId: id,
    modelVersion: MODEL,
    candidates: [{ content: { role: "model", parts } }],
  });
  if (!finish) {
    return;
  }
  sse(res, {
    responseId: id,
    modelVersion: MODEL,
    candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: usage.input,
      candidatesTokenCount: usage.output - usage.reasoning,
      thoughtsTokenCount: usage.reasoning,
      cachedContentTokenCount: usage.cacheRead,
      totalTokenCount: usage.input + usage.output,
    },
  });
  res.end();
};

export interface SentSpan {
  name: string;
  op: string;
  status: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  isSegment: boolean;
  startTimestamp: number;
  endTimestamp: number;
  attributes: Record<string, unknown>;
}

/** A Sentry ingest endpoint that keeps the envelopes it receives. */
export class MockSentry {
  readonly envelopes: { headers: Record<string, unknown>; spans: SentSpan[] }[] = [];
  private pending = 0;

  private constructor(private readonly server: Server) {}

  static async start(): Promise<MockSentry> {
    let sentry: MockSentry | undefined;
    const server = createServer(async (req, res) => {
      if (sentry) {
        sentry.pending += 1;
      }
      const lines = (await body(req)).split("\n").filter(Boolean);
      const items = lines.slice(1).map((line) => JSON.parse(line) as Record<string, unknown>);
      const spans = items
        .flatMap((item) => (Array.isArray(item.items) ? (item.items as RawSpan[]) : []))
        .map(toSentSpan);
      sentry?.envelopes.push({ headers: JSON.parse(lines[0]), spans });
      if (sentry) {
        sentry.pending -= 1;
      }
      res.end("{}");
    });
    sentry = new MockSentry(await listen(server));
    return sentry;
  }

  get dsn(): string {
    return `http://public@127.0.0.1:${port(this.server)}/1`;
  }

  get spans(): SentSpan[] {
    return this.envelopes.flatMap((envelope) => envelope.spans);
  }

  /** Waits until every request that reached the server has been read. */
  async idle(): Promise<void> {
    while (this.pending > 0) {
      await sleep(10);
    }
  }

  close(): Promise<void> {
    return close(this.server);
  }
}

interface RawSpan {
  name: string;
  status: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  is_segment: boolean;
  start_timestamp: number;
  end_timestamp: number;
  attributes: Record<string, { value: unknown }>;
}

function toSentSpan(span: RawSpan): SentSpan {
  const attributes = Object.fromEntries(
    Object.entries(span.attributes).map(([key, { value }]) => [key, value]),
  );
  return {
    name: span.name,
    op: String(attributes["sentry.op"]),
    status: span.status,
    traceId: span.trace_id,
    spanId: span.span_id,
    parentSpanId: span.parent_span_id,
    isSegment: span.is_segment,
    startTimestamp: span.start_timestamp,
    endTimestamp: span.end_timestamp,
    attributes,
  };
}

export interface PiEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Without `sentry`, Pi runs without `SENTRY_PI_DSN`. `settings` are merged into Pi's settings, and
 * an `env` value of `undefined` unsets the variable.
 */
export interface PiOptions {
  sentry?: MockSentry;
  provider?: string;
  contextWindow?: number;
  settings?: Record<string, unknown>;
  env?: Record<string, string | undefined>;
  extensions?: string[];
  setup?: (cwd: string) => void;
}

/** The Pi CLI in RPC mode, with the extension loaded and an isolated home directory. */
export class Pi {
  readonly events: PiEvent[] = [];
  private stdout = "";

  private constructor(
    private readonly process: ChildProcess,
    readonly cwd: string,
  ) {
    let buffered = "";
    process.stdout?.setEncoding("utf8").on("data", (data: string) => {
      buffered += data;
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          this.events.push(JSON.parse(line));
        } catch {
          this.stdout += `${line}\n`;
        }
      }
    });
  }

  static start(model: MockModel, options: PiOptions = {}): Pi {
    const home = mkdtempSync(join(tmpdir(), "sentry-pi-e2e-"));
    const agentDir = join(home, "agent");
    const cwd = join(home, "work");
    mkdirSync(agentDir);
    mkdirSync(cwd);
    options.setup?.(cwd);
    const definition = {
      id: MODEL,
      reasoning: true,
      input: ["text", "image"],
      contextWindow: options.contextWindow ?? 100_000,
      maxTokens: 1_000,
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
    };
    const provider = (api: string, baseUrl: string) => ({
      baseUrl,
      api,
      apiKey: "mock",
      models: [definition],
    });
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          [PROVIDERS.openai]: provider("openai-completions", `${model.url}/v1`),
          [PROVIDERS.anthropic]: provider("anthropic-messages", model.url),
          [PROVIDERS.responses]: provider("openai-responses", `${model.url}/v1`),
          [PROVIDERS.google]: provider("google-generative-ai", `${model.url}/v1beta`),
        },
      }),
    );
    // Retry right away, and let a manual compaction summarize even a short conversation.
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        retry: { baseDelayMs: 10 },
        compaction: { keepRecentTokens: 0 },
        ...options.settings,
      }),
    );
    const args = [
      ["--mode", "rpc"],
      ["--no-session", "--offline", "--no-extensions", "--no-skills", "--no-context-files"],
      ["--extension", EXTENSION, "--extension", FIXTURE],
      (options.extensions ?? []).flatMap((extension) => ["--extension", extension]),
      ["--provider", options.provider ?? PROVIDER, "--model", MODEL],
    ].flat();
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("SENTRY_PI_")),
    );
    Object.assign(env, {
      HOME: home,
      PI_CODING_AGENT_DIR: agentDir,
      SENTRY_PI_DSN: options.sentry?.dsn,
      SENTRY_PI_ENVIRONMENT: "e2e",
      ...options.env,
    });
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) {
        delete env[name];
      }
    }
    const child = spawn(PI_BIN, args, { cwd, env, stdio: ["pipe", "pipe", "inherit"] });
    return new Pi(child, cwd);
  }

  send(command: Record<string, unknown>): void {
    this.process.stdin?.write(`${JSON.stringify(command)}\n`);
  }

  async command(command: Record<string, unknown>): Promise<PiEvent> {
    const from = this.events.length;
    this.send(command);
    const response = await this.waitFor(
      (event) => event.type === "response" && event.command === command.type,
      from,
    );
    if (!response.success) {
      throw new Error(`Pi rejected ${String(command.type)}: ${String(response.error)}`);
    }
    return response;
  }

  /** Sends a prompt and waits until Pi has settled the run that handles it. */
  async prompt(message: string, fields: Record<string, unknown> = {}): Promise<void> {
    const from = this.events.length;
    this.send({ type: "prompt", message, ...fields });
    await this.waitFor((event) => event.type === "agent_settled", from);
  }

  async waitFor(predicate: (event: PiEvent) => boolean, from = 0): Promise<PiEvent> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const event = this.events.slice(from).find(predicate);
      if (event) {
        return event;
      }
      await sleep(20);
    }
    const recent = this.events.slice(-5).map((event) => event.type);
    throw new Error(`Timed out waiting for a Pi event; last events: ${recent.join(", ")}`);
  }

  /** Ends the session the way a user quitting Pi does, which flushes the extension's spans. */
  async exit(): Promise<void> {
    const exited = new Promise((resolve) => this.process.once("exit", resolve));
    this.process.stdin?.end();
    await exited;
  }
}

export interface Mocks {
  model: MockModel;
  sentry: MockSentry;
  /** Runs Pi through `drive`, quits it and returns the spans the extension sent. */
  run(drive: (pi: Pi) => Promise<void>, options?: PiOptions): Promise<SentSpan[]>;
}

/** Starts a mock model and Sentry for each test of the file. */
export function useMocks(): Mocks {
  const mocks = {
    async run(drive: (pi: Pi) => Promise<void>, options: PiOptions = {}): Promise<SentSpan[]> {
      const pi = Pi.start(mocks.model, { sentry: mocks.sentry, ...options });
      await drive(pi);
      await pi.exit();
      await mocks.sentry.idle();
      return mocks.sentry.spans;
    },
  } as Mocks;
  beforeEach(async () => {
    mocks.model = await MockModel.start();
    mocks.sentry = await MockSentry.start();
  });
  afterEach(async () => {
    await mocks.model.close();
    await mocks.sentry.close();
  });
  return mocks;
}

export function only(spans: SentSpan[], op: string): SentSpan {
  const matching = spans.filter((span) => span.op === op);
  expect(matching).toHaveLength(1);
  return matching[0];
}

export function ofOp(spans: SentSpan[], op: string): SentSpan[] {
  return spans.filter((span) => span.op === op);
}

export function childrenOf(spans: SentSpan[], parent: SentSpan): SentSpan[] {
  return spans.filter((span) => span.parentSpanId === parent.spanId);
}

export function messages(span: SentSpan, key: "input" | "output"): unknown[] {
  return JSON.parse(String(span.attributes[`gen_ai.${key}.messages`]));
}

/** Waits until `condition` holds, for up to 5 seconds. */
export async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for a condition");
    }
    await sleep(20);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listen(server: Server): Promise<Server> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function port(server: Server): number {
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}
