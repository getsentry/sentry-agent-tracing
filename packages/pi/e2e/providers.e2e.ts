import { expect, test } from "vite-plus/test";
import { MODEL, only, PROVIDERS, useMocks } from "./harness.ts";

const mocks = useMocks();

/** Where each API puts the output token limit of a request. */
const MAX_TOKENS: Record<string, (payload: Record<string, unknown>) => unknown> = {
  anthropic: (payload) => payload.max_tokens,
  responses: (payload) => payload.max_output_tokens,
  google: (payload) =>
    (payload.generationConfig as Record<string, unknown> | undefined)?.maxOutputTokens ??
    (payload.config as Record<string, unknown> | undefined)?.maxOutputTokens,
};

test.each(["anthropic", "responses", "google"] as const)(
  "a request through the %s API is recorded the same way",
  async (api) => {
    mocks.model.replies.push(
      { toolCalls: [{ name: "bash", arguments: { command: "echo hi" } }] },
      { text: "Hello there.", usage: { cacheRead: 40 } },
    );
    const spans = await mocks.run((pi) => pi.prompt("Say hello"), {
      provider: PROVIDERS[api],
    });

    expect(only(spans, "gen_ai.execute_tool").attributes["gen_ai.tool.call.result"]).toBe("hi\n");
    const chats = spans.filter((span) => span.op === "gen_ai.chat");
    expect(chats.map((span) => span.attributes["gen_ai.response.finish_reasons"])).toEqual([
      '["tool_call"]',
      '["stop"]',
    ]);
    const chat = chats[1];
    expect(chat.status).toBe("ok");
    expect(chat.attributes).toMatchObject({
      "gen_ai.provider.name": PROVIDERS[api],
      "gen_ai.request.model": MODEL,
      "gen_ai.response.model": MODEL,
      "gen_ai.response.id": "resp_2",
      "gen_ai.response.streaming": true,
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.cache_read.input_tokens": 40,
      "gen_ai.usage.output_tokens": 20,
      "gen_ai.request.max_tokens": MAX_TOKENS[api](mocks.model.requests[1]),
    });
    expect(chat.attributes["gen_ai.request.max_tokens"]).toEqual(expect.any(Number));
    expect(chat.attributes["gen_ai.output.messages"]).toContain("Hello there.");
    expect(chat.attributes["gen_ai.cost.total_tokens"]).toBeGreaterThan(0);
  },
);
