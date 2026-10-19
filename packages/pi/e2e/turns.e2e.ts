import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import {
  childrenOf,
  messages,
  MODEL,
  ofOp,
  only,
  piAtLeast,
  PROVIDER,
  useMocks,
} from "./harness.ts";

const mocks = useMocks();

test("a prompt with a tool call becomes one trace", async () => {
  mocks.model.replies.push(
    {
      reasoning: "The user wants the output.",
      toolCalls: [{ name: "bash", arguments: { command: "echo hello" } }],
      usage: { cacheRead: 40, reasoning: 5 },
    },
    { text: "It printed hello." },
  );
  const spans = await mocks.run(async (pi) => {
    await pi.command({ type: "set_thinking_level", level: "high" });
    await pi.prompt("Run echo hello");
  });

  const agent = only(spans, "gen_ai.invoke_agent");
  const tool = only(spans, "gen_ai.execute_tool");
  const chats = ofOp(spans, "gen_ai.chat");
  expect(chats).toHaveLength(2);

  expect(agent.name).toBe("invoke_agent pi");
  expect(agent.isSegment).toBe(true);
  expect(agent.status).toBe("ok");
  for (const span of [tool, ...chats]) {
    expect(span.traceId).toBe(agent.traceId);
    expect(span.parentSpanId).toBe(agent.spanId);
  }
  for (const span of spans) {
    expect(span.attributes).toMatchObject({
      "gen_ai.agent.name": "pi",
      "gen_ai.conversation.id": agent.attributes["gen_ai.conversation.id"],
      "sentry.environment": "e2e",
      "sentry.sdk.name": "sentry.agent-tracing.pi",
    });
  }

  const [first, second] = chats;
  expect(first.name).toBe(`chat ${MODEL}`);
  expect(first.status).toBe("ok");
  expect(first.attributes).toMatchObject({
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": PROVIDER,
    "gen_ai.request.model": MODEL,
    "gen_ai.request.max_tokens": mocks.model.requests[0].max_completion_tokens,
    "gen_ai.response.model": MODEL,
    "gen_ai.response.id": "resp_1",
    "gen_ai.response.streaming": true,
    "gen_ai.response.finish_reasons": '["tool_call"]',
    // Input tokens include cache reads.
    "gen_ai.usage.input_tokens": 100,
    "gen_ai.usage.cache_read.input_tokens": 40,
    "gen_ai.usage.output_tokens": 20,
    "gen_ai.usage.reasoning.output_tokens": 5,
  });
  // Pi 0.99 added the thinking level to responses.
  if (piAtLeast("0.99.0")) {
    expect(first.attributes["gen_ai.request.reasoning.level"]).toBe("high");
  }
  expect(first.attributes["gen_ai.response.time_to_first_chunk"]).toBeGreaterThanOrEqual(0);
  // 60 input tokens at $3, 40 cache reads at $0.30 and 20 output tokens at $15 per million.
  expect(first.attributes["gen_ai.cost.input_tokens"]).toBeCloseTo(60 * 3e-6 + 40 * 0.3e-6, 12);
  expect(first.attributes["gen_ai.cost.cache_read.input_tokens"]).toBeCloseTo(40 * 0.3e-6, 12);
  expect(first.attributes["gen_ai.cost.output_tokens"]).toBeCloseTo(20 * 15e-6, 12);
  expect(first.attributes["gen_ai.system_instructions"]).toEqual(expect.any(String));
  const definitions = JSON.parse(String(first.attributes["gen_ai.tool.definitions"]));
  expect(definitions).toContainEqual({
    type: "function",
    name: "bash",
    description: expect.any(String),
    parameters: expect.objectContaining({ type: "object" }),
  });
  expect(messages(first, "input")).toEqual([
    { role: "user", parts: [{ type: "text", content: "Run echo hello" }] },
  ]);
  expect(messages(first, "output")).toEqual([
    {
      role: "assistant",
      parts: [
        { type: "reasoning", content: "The user wants the output." },
        {
          type: "tool_call",
          id: expect.any(String),
          name: "bash",
          arguments: { command: "echo hello" },
        },
      ],
      finish_reason: "tool_call",
    },
  ]);

  // The second request's input has every message the model received.
  const input = messages(second, "input");
  expect(input).toHaveLength(3);
  expect(input[0]).toEqual({ role: "user", parts: [{ type: "text", content: "Run echo hello" }] });
  expect(input[1]).toMatchObject({ role: "assistant" });
  expect(input[2]).toMatchObject({
    role: "tool",
    parts: [{ type: "tool_call_response", name: "bash", result: "hello\n" }],
  });
  expect(messages(second, "output")).toEqual([
    {
      role: "assistant",
      parts: [{ type: "text", content: "It printed hello." }],
      finish_reason: "stop",
    },
  ]);

  expect(messages(agent, "input")).toEqual([
    { role: "user", parts: [{ type: "text", content: "Run echo hello" }] },
  ]);
  expect(messages(agent, "output")).toEqual(messages(second, "output"));
  expect(agent.attributes["gen_ai.tool.definitions"]).toBe(
    second.attributes["gen_ai.tool.definitions"],
  );

  expect(tool.name).toBe("execute_tool bash");
  expect(tool.status).toBe("ok");
  expect(tool.attributes).toMatchObject({
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": "bash",
    "gen_ai.tool.call.arguments": '{"command":"echo hello"}',
    "gen_ai.tool.call.result": "hello\n",
  });
  expect(tool.attributes["gen_ai.tool.description"]).toEqual(expect.any(String));

  // The turn adds up its requests.
  expect(agent.attributes).toMatchObject({
    "gen_ai.usage.input_tokens": 200,
    "gen_ai.usage.output_tokens": 40,
    "gen_ai.usage.cache_read.input_tokens": 40,
  });

  // Sentry rejects span envelopes without the trace's dynamic sampling context.
  for (const { headers } of mocks.sentry.envelopes) {
    expect(headers.trace).toMatchObject({ public_key: "public", trace_id: agent.traceId });
    expect(headers.sdk).toMatchObject({ name: "sentry.agent-tracing.pi" });
  }
});

test("a retried request stays in the turn's trace", async () => {
  mocks.model.replies.push({ status: 500 }, { text: "Second try." });
  const spans = await mocks.run((pi) => pi.prompt("Hello"));

  const agent = only(spans, "gen_ai.invoke_agent");
  const chats = ofOp(spans, "gen_ai.chat");
  expect(chats.map((span) => span.status)).toEqual(["error", "ok"]);
  for (const span of chats) {
    expect(span.parentSpanId).toBe(agent.spanId);
  }
  expect(chats[0].attributes["sentry.status.message"]).toContain("mock failure");
  expect(chats[0].attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
  expect(JSON.stringify(messages(chats[1], "output"))).toContain("Second try.");
  expect(agent.status).toBe("ok");
});

test("a request that fails after every retry fails the turn", async () => {
  mocks.model.replies.push({ status: 500 }, { status: 500 });
  const spans = await mocks.run((pi) => pi.prompt("Hello"), {
    settings: { retry: { baseDelayMs: 10, maxRetries: 1 } },
  });

  const agent = only(spans, "gen_ai.invoke_agent");
  const chats = ofOp(spans, "gen_ai.chat");
  expect(chats.map((span) => span.status)).toEqual(["error", "error"]);
  expect(chats.map((span) => span.parentSpanId)).toEqual([agent.spanId, agent.spanId]);
  expect(mocks.model.requests).toHaveLength(2);
  expect(agent.status).toBe("error");
  expect(agent.attributes["sentry.status.message"]).toContain("mock failure");
});

test("a request that can't be retried fails the turn", async () => {
  mocks.model.replies.push({ status: 400, message: "invalid request" });
  const spans = await mocks.run((pi) => pi.prompt("Hello"));

  const agent = only(spans, "gen_ai.invoke_agent");
  const chat = only(spans, "gen_ai.chat");
  expect(chat.status).toBe("error");
  expect(chat.attributes["sentry.status.message"]).toContain("invalid request");
  expect(agent.status).toBe("error");
  expect(agent.attributes["sentry.status.message"]).toBe(chat.attributes["sentry.status.message"]);
  expect(mocks.model.requests).toHaveLength(1);
});

test("an abort while the model streams fails the request as cancelled", async () => {
  mocks.model.replies.push({ hang: true });
  const spans = await mocks.run(async (pi) => {
    pi.send({ type: "prompt", message: "Write a long story" });
    await pi.waitFor((event) => event.type === "message_update");
    const from = pi.events.length;
    pi.send({ type: "abort" });
    await pi.waitFor((event) => event.type === "agent_settled", from);
  });

  const agent = only(spans, "gen_ai.invoke_agent");
  const chat = only(spans, "gen_ai.chat");
  expect(chat.status).toBe("error");
  expect(chat.attributes["gen_ai.response.finish_reasons"]).toBe('["aborted"]');
  expect(JSON.stringify(messages(chat, "output"))).toContain("Let me think");
  // The turn is cancelled, which streamed spans send as ok.
  expect(agent.status).toBe("ok");
});

test("an abort during a tool call fails the tool as cancelled", async () => {
  mocks.model.replies.push({
    toolCalls: [{ name: "bash", arguments: { command: "sleep 30" } }],
  });
  const spans = await mocks.run(async (pi) => {
    pi.send({ type: "prompt", message: "Wait a while" });
    await pi.waitFor((event) => event.type === "tool_execution_start");
    const from = pi.events.length;
    pi.send({ type: "abort" });
    await pi.waitFor((event) => event.type === "agent_settled", from);
  });

  const agent = only(spans, "gen_ai.invoke_agent");
  const tool = only(spans, "gen_ai.execute_tool");
  expect(tool.status).toBe("error");
  expect(tool.attributes["error.type"]).toBe("cancelled");
  expect(tool.attributes["sentry.status.message"]).toBe("Command aborted");
  expect(agent.status).toBe("ok");
});

test("failed tool calls get an error type", async () => {
  mocks.model.replies.push(
    {
      toolCalls: [
        { name: "bash", arguments: { command: "echo oops; exit 3" } },
        { name: "bash", arguments: { command: "sleep 5", timeout: 1 } },
        { name: "bash", arguments: { cmd: "ls" } },
        { name: "unknown_tool", arguments: {} },
        { name: "read", arguments: { path: "missing.txt" } },
      ],
    },
    { text: "Those failed." },
  );
  const spans = await mocks.run((pi) => pi.prompt("Try some tools"));

  const tools = ofOp(spans, "gen_ai.execute_tool");
  const byArguments = (args: string) =>
    tools.find((span) => span.attributes["gen_ai.tool.call.arguments"] === args)?.attributes;
  expect(byArguments('{"command":"echo oops; exit 3"}')).toMatchObject({
    "error.type": "exit_code",
    "sentry.status.message": "Command exited with code 3",
    "gen_ai.tool.call.result": expect.stringContaining("oops"),
  });
  expect(byArguments('{"command":"sleep 5","timeout":1}')).toMatchObject({
    "error.type": "timeout",
    "sentry.status.message": expect.stringMatching(/^Command timed out after /),
  });
  expect(byArguments('{"cmd":"ls"}')).toMatchObject({ "error.type": "invalid_arguments" });
  expect(tools.find((span) => span.name === "execute_tool unknown_tool")?.attributes).toMatchObject(
    { "error.type": "tool_not_found", "sentry.status.message": "Tool unknown_tool not found" },
  );
  // Without a known kind of failure, OTel's generic value.
  expect(byArguments('{"path":"missing.txt"}')).toMatchObject({ "error.type": "_OTHER" });
  for (const tool of tools) {
    expect(tool.status).toBe("error");
  }
  expect(only(spans, "gen_ai.invoke_agent").status).toBe("ok");
});

test("reading a skill's SKILL.md names the tool span after the skill", async () => {
  mocks.model.replies.push(
    { toolCalls: [{ name: "read", arguments: { path: "skills/release/SKILL.md" } }] },
    { text: "Loaded." },
  );
  const spans = await mocks.run((pi) => pi.prompt("Load the release skill"), {
    setup: (cwd) => {
      mkdirSync(join(cwd, "skills/release"), { recursive: true });
      writeFileSync(join(cwd, "skills/release/SKILL.md"), "# Release\n");
    },
  });

  const tool = only(spans, "gen_ai.execute_tool");
  expect(tool.name).toBe("execute_tool skill release");
  expect(tool.attributes["gen_ai.tool.name"]).toBe("read");
});

test.runIf(piAtLeast("0.99.0"))("tool calls made by codemode nest under it", async () => {
  mocks.model.replies.push(
    {
      toolCalls: [
        {
          name: "codemode",
          arguments: {
            code: "const r = await tools.bash({ command: 'echo nested' }); text(r.output);",
          },
        },
      ],
    },
    { text: "Done." },
  );
  const spans = await mocks.run((pi) => pi.prompt("Use codemode"), {
    extensions: ["builtin:codemode"],
    settings: { defaultTools: ["+codemode"] },
  });

  const codemode = spans.find((span) => span.name === "execute_tool codemode");
  expect(codemode?.status).toBe("ok");
  const [nested] = childrenOf(spans, codemode!);
  expect(nested.name).toBe("execute_tool bash");
  expect(nested.attributes["gen_ai.tool.call.result"]).toContain("nested");
});

test("the input has images, shell commands and extension messages as Pi sends them", async () => {
  const spans = await mocks.run(async (pi) => {
    await pi.command({ type: "bash", command: "echo from-shell" });
    await pi.command({ type: "bash", command: "echo hidden", excludeFromContext: true });
    await pi.command({ type: "prompt", message: "/e2e-note a note from an extension" });
    await pi.prompt("What is in this image?", {
      images: [{ type: "image", data: PIXEL, mimeType: "image/png" }],
    });
  });

  const input = JSON.stringify(messages(only(spans, "gen_ai.chat"), "input"));
  expect(input).toContain("Ran `echo from-shell`");
  expect(input).not.toContain("hidden");
  expect(input).toContain("a note from an extension");
  expect(input).toContain('{"type":"blob","mime_type":"image/png"}');
  expect(input).not.toContain(PIXEL);
});

/** A 1x1 transparent PNG. */
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
