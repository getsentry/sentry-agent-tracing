import { expect, test } from "vite-plus/test";
import { childrenOf, messages, ofOp, only, type Pi, type SentSpan, useMocks } from "./harness.ts";

const mocks = useMocks();

/** Runs `/compact` and returns whether Pi compacted. */
async function compact(pi: Pi): Promise<boolean> {
  const from = pi.events.length;
  pi.send({ type: "compact" });
  const response = await pi.waitFor(
    (event) => event.type === "response" && event.command === "compact",
    from,
  );
  return response.success === true;
}

function summaryText(span: SentSpan): string {
  return JSON.stringify(messages(span, "output"));
}

test("a manual compaction gets a trace of its own and marks later requests", async () => {
  mocks.model.replies.push(
    { text: "First answer." },
    { text: "The user said hello.", usage: { input: 300, output: 30 } },
    { text: "Hi again." },
  );
  const spans = await mocks.run(async (pi) => {
    await pi.prompt("Hello");
    expect(await compact(pi)).toBe(true);
    await pi.prompt("Hello again");
  });

  const compaction = only(spans, "gen_ai.compact");
  expect(compaction.name).toBe("compact");
  expect(compaction.isSegment).toBe(true);
  expect(compaction.status).toBe("ok");
  expect(compaction.attributes).toMatchObject({
    "gen_ai.operation.name": "compact",
    "gen_ai.conversation.compaction.reason": "manual",
  });

  const [summary] = childrenOf(spans, compaction);
  expect(summary.op).toBe("gen_ai.chat");
  expect(summary.traceId).toBe(compaction.traceId);
  expect(summary.attributes).toMatchObject({
    "gen_ai.usage.input_tokens": 300,
    "gen_ai.usage.output_tokens": 30,
  });
  expect(summary.attributes["gen_ai.cost.total_tokens"]).toBeGreaterThan(0);
  expect(summaryText(summary)).toContain("The user said hello.");

  const turns = ofOp(spans, "gen_ai.invoke_agent");
  expect(turns).toHaveLength(2);
  const [before, after] = turns.map((turn) => only(childrenOf(spans, turn), "gen_ai.chat"));
  expect(before.attributes["gen_ai.conversation.compacted"]).toBeUndefined();
  expect(after.attributes["gen_ai.conversation.compacted"]).toBe(true);
});

test("a compaction at the context threshold runs inside the turn", async () => {
  mocks.model.replies.push(
    { text: "A long answer.", usage: { input: 1_500, output: 100 } },
    { text: "Summary of the long answer." },
  );
  const spans = await mocks.run((pi) => pi.prompt("Explain everything"), {
    contextWindow: 2_000,
    settings: {
      retry: { baseDelayMs: 10 },
      compaction: { keepRecentTokens: 0, reserveTokens: 1_000 },
    },
  });

  const agent = only(spans, "gen_ai.invoke_agent");
  const compaction = only(spans, "gen_ai.compact");
  expect(compaction.parentSpanId).toBe(agent.spanId);
  expect(compaction.attributes["gen_ai.conversation.compaction.reason"]).toBe("threshold");
  const summary = only(childrenOf(spans, compaction), "gen_ai.chat");
  expect(summaryText(summary)).toContain("Summary of the long answer.");
  // The turn's totals include the summary request.
  expect(agent.attributes["gen_ai.usage.input_tokens"]).toBe(1_600);
});

test("a context overflow compacts and retries inside the turn", async () => {
  mocks.model.replies.push(
    { status: 400, message: "prompt is too long: 213462 tokens > 200000 maximum" },
    { text: "Summary before the overflow." },
    { text: "Answer after compacting." },
  );
  const spans = await mocks.run(async (pi) => {
    await pi.prompt("Hello");
  });

  const agent = only(spans, "gen_ai.invoke_agent");
  const compaction = only(spans, "gen_ai.compact");
  expect(compaction.parentSpanId).toBe(agent.spanId);
  expect(compaction.attributes["gen_ai.conversation.compaction.reason"]).toBe("overflow");
  expect(summaryText(only(childrenOf(spans, compaction), "gen_ai.chat"))).toContain(
    "Summary before the overflow.",
  );

  const chats = ofOp(childrenOf(spans, agent), "gen_ai.chat");
  expect(chats.map((span) => span.status)).toEqual(["error", "ok"]);
  expect(chats[1].attributes["gen_ai.conversation.compacted"]).toBe(true);
  // The retry after compacting succeeded, so the turn did too.
  expect(agent.status).toBe("ok");
});

test("a failed compaction fails its compact span", async () => {
  mocks.model.replies.push({ text: "First answer." }, { status: 400, message: "summary refused" });
  const spans = await mocks.run(async (pi) => {
    await pi.prompt("Hello");
    expect(await compact(pi)).toBe(false);
  });

  const compaction = only(spans, "gen_ai.compact");
  expect(compaction.status).toBe("error");
  expect(compaction.attributes["sentry.status.message"]).toContain("summary refused");
  expect(childrenOf(spans, compaction)).toEqual([]);
});

test("a compaction Pi rejects as too small sends nothing", async () => {
  const spans = await mocks.run(async (pi) => {
    expect(await compact(pi)).toBe(false);
  });

  expect(ofOp(spans, "gen_ai.compact")).toEqual([]);
});

test("a compaction written by an extension has no chat span", async () => {
  mocks.model.replies.push({ text: "First answer." });
  const spans = await mocks.run(
    async (pi) => {
      await pi.prompt("Hello");
      expect(await compact(pi)).toBe(true);
    },
    { env: { E2E_EXTENSION_COMPACTION: "1" } },
  );

  const compaction = only(spans, "gen_ai.compact");
  expect(compaction.status).toBe("ok");
  expect(childrenOf(spans, compaction)).toEqual([]);
  expect(mocks.model.requests).toHaveLength(1);
});
