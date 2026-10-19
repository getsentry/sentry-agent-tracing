import { expect, test } from "vite-plus/test";
import { childrenOf, messages, ofOp, only, until, useMocks } from "./harness.ts";

const mocks = useMocks();

const conversation = (span: { attributes: Record<string, unknown> }) =>
  span.attributes["gen_ai.conversation.id"];

test("each prompt is a trace in the session's conversation, and a new session starts another", async () => {
  const spans = await mocks.run(async (pi) => {
    await pi.prompt("First");
    await pi.prompt("Second");
    await pi.command({ type: "new_session" });
    // Switching sessions sends the old session's spans: two turns with a request each.
    await until(() => mocks.sentry.spans.length === 4);
    await pi.prompt("Third");
  });

  const turns = ofOp(spans, "gen_ai.invoke_agent");
  expect(turns).toHaveLength(3);
  expect(new Set(turns.map((turn) => turn.traceId)).size).toBe(3);
  expect(conversation(turns[0])).toBe(conversation(turns[1]));
  expect(conversation(turns[2])).not.toBe(conversation(turns[0]));
  for (const turn of turns) {
    expect(conversation(only(childrenOf(spans, turn), "gen_ai.chat"))).toBe(conversation(turn));
  }
});

test("without SENTRY_PI_DSN nothing is sent and Pi works as usual, even with SENTRY_DSN", async () => {
  mocks.model.replies.push({ text: "Hi." });
  const spans = await mocks.run(
    async (pi) => {
      await pi.prompt("Hello");
      const response = await pi.command({ type: "get_last_assistant_text" });
      expect(response.data).toMatchObject({ text: "Hi." });
    },
    { sentry: undefined, env: { SENTRY_DSN: mocks.sentry.dsn } },
  );

  expect(spans).toEqual([]);
  expect(mocks.sentry.envelopes).toEqual([]);
});

test("a branch summary becomes a chat span in a trace of its own", async () => {
  mocks.model.replies.push(
    { text: "First answer." },
    { text: "Second answer." },
    { text: "The branch tried a second question." },
  );
  const spans = await mocks.run(async (pi) => {
    await pi.prompt("First");
    await pi.prompt("Second");
    await pi.command({ type: "prompt", message: "/e2e-tree" });
    await until(() => mocks.model.requests.length === 3);
  });

  const summary = ofOp(spans, "gen_ai.chat").find((span) =>
    JSON.stringify(messages(span, "output")).includes("The branch tried a second question."),
  );
  expect(summary).toBeDefined();
  expect(summary?.isSegment).toBe(true);
  expect(summary?.parentSpanId).toBeUndefined();
  expect(summary?.attributes["gen_ai.usage.input_tokens"]).toBe(100);
  expect(ofOp(spans, "gen_ai.compact")).toEqual([]);
  expect(ofOp(spans, "gen_ai.invoke_agent")).toHaveLength(2);
});
