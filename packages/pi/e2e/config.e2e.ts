import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { ofOp, only, type Pi, useMocks } from "./harness.ts";

const mocks = useMocks();

const projectSettings = (settings: Record<string, unknown>) => (cwd: string) => {
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(settings));
};

const statuses = (pi: Pi) =>
  pi.events
    .filter((event) => event.type === "extension_ui_request" && event.method === "setStatus")
    .map((event) => event.statusText as string | undefined);

const notifications = (pi: Pi) =>
  pi.events
    .filter((event) => event.type === "extension_ui_request" && event.method === "notify")
    .map((event) => String(event.message));

/** Runs `/sentry` and returns what it shows. */
async function status(pi: Pi): Promise<string> {
  const from = pi.events.length;
  pi.send({ type: "prompt", message: "/sentry" });
  const event = await pi.waitFor(
    (event) =>
      event.type === "extension_ui_request" &&
      event.method === "notify" &&
      String(event.message).startsWith("Sentry tracing"),
    from,
  );
  return String(event.message);
}

const environments = () =>
  ofOp(mocks.sentry.spans, "gen_ai.invoke_agent").map(
    (span) => span.attributes["sentry.environment"],
  );

test("the DSN can come from Pi's settings, and the environment variables win", async () => {
  let shown = "";
  let bar: (string | undefined)[] = [];
  await mocks.run(
    async (pi) => {
      await pi.prompt("Hello");
      shown = await status(pi);
      bar = statuses(pi);
    },
    {
      sentry: undefined,
      settings: { sentry: { dsn: mocks.sentry.dsn, environment: "settings" } },
    },
  );

  expect(environments()).toEqual(["e2e"]);
  expect(bar).toEqual(["Sentry ●"]);
  expect(shown).toContain("Sentry tracing is enabled.");
  expect(shown).toContain(`dsn: ${mocks.sentry.dsn.replace(/\/\/[^@]+@/, "//")}`);
  expect(shown).toMatch(/dsn: .* \(.*settings\.json\)/);
  expect(shown).toContain("environment: e2e (SENTRY_PI_ENVIRONMENT)");
});

test("a trusted project can set the environment and turn data collection off, nothing else", async () => {
  let shown: string[] = [];
  await mocks.run(
    async (pi) => {
      await pi.prompt("Hello");
      shown = notifications(pi);
    },
    {
      settings: {
        defaultProjectTrust: "always",
        sentry: { dataCollection: { genAI: { outputs: false } } },
      },
      env: { SENTRY_PI_ENVIRONMENT: undefined },
      setup: projectSettings({
        sentry: {
          environment: "project",
          dsn: "https://key@127.0.0.1:9/1",
          dataCollection: { genAI: { inputs: false, outputs: true } },
        },
      }),
    },
  );

  expect(environments()).toEqual(["project"]);
  const chat = only(mocks.sentry.spans, "gen_ai.chat");
  expect(chat.attributes["gen_ai.input.messages"]).toBeUndefined();
  expect(chat.attributes["gen_ai.output.messages"]).toBeUndefined();
  expect(shown).toContainEqual(
    expect.stringMatching(
      /settings\.json: dsn, dataCollection\.genAI\.outputs ignored, a project can only set the environment and turn data collection off$/,
    ),
  );
});

test("with data collection off, spans keep their structure and usage but no content", async () => {
  mocks.model.replies.push(
    {
      toolCalls: [
        { name: "bash", arguments: { command: "echo secret-output" } },
        { name: "read", arguments: { path: "secret-file.txt" } },
      ],
    },
    { text: "secret-answer" },
  );
  const spans = await mocks.run((pi) => pi.prompt("secret-prompt"), {
    env: {
      SENTRY_PI_DATA_COLLECTION_GEN_AI_INPUTS: "false",
      SENTRY_PI_DATA_COLLECTION_GEN_AI_OUTPUTS: "false",
    },
  });

  expect(spans.map((span) => span.op).sort()).toEqual([
    "gen_ai.chat",
    "gen_ai.chat",
    "gen_ai.execute_tool",
    "gen_ai.execute_tool",
    "gen_ai.invoke_agent",
  ]);
  expect(JSON.stringify(spans)).not.toContain("secret");
  const read = spans.find((span) => span.name === "execute_tool read");
  expect(read?.status).toBe("error");
  expect(read?.attributes["sentry.status.message"]).toBe("Tool failed");
  expect(ofOp(spans, "gen_ai.chat")[1].attributes["gen_ai.usage.input_tokens"]).toBe(100);
});

test("an untrusted project's settings are ignored", async () => {
  let shown: string[] = [];
  await mocks.run(
    async (pi) => {
      await pi.prompt("Hello");
      shown = notifications(pi);
    },
    {
      env: { SENTRY_PI_ENVIRONMENT: undefined },
      setup: projectSettings({ sentry: { environment: "project" } }),
    },
  );

  expect(environments()).toHaveLength(1);
  expect(environments()).not.toContain("project");
  expect(shown).toContainEqual(
    expect.stringMatching(/settings\.json: ignored because the project isn't trusted$/),
  );
});

test("with an organization, the status bar links to the conversation", async () => {
  let bar: (string | undefined)[] = [];
  let sessionId = "";
  await mocks.run(
    async (pi) => {
      await pi.waitFor((event) => event.method === "setStatus");
      bar = statuses(pi);
      const state = await pi.command({ type: "get_state" });
      sessionId = (state.data as { sessionId: string }).sessionId;
    },
    { env: { SENTRY_PI_ORG: "acme" } },
  );

  const url = new URL(mocks.sentry.dsn);
  const link = `${url.protocol}//${url.host}/organizations/acme/explore/agents/conversations/${sessionId}/`;
  expect(bar).toEqual([`Sentry ● · \x1b]8;;${link}\x1b\\Go to conversation ↗\x1b]8;;\x1b\\`]);
});

test("/sentry says why tracing is off", async () => {
  let shown = "";
  let bar: (string | undefined)[] = [];
  await mocks.run(
    async (pi) => {
      shown = await status(pi);
      await pi.waitFor((event) => event.method === "setStatus");
      bar = statuses(pi);
    },
    { sentry: undefined, settings: { sentry: { environment: 1 } } },
  );

  expect(bar).toEqual(["Sentry ○"]);
  expect(shown).toContain("Sentry tracing is disabled: no DSN is set.");
  expect(shown).toContain("Set SENTRY_PI_DSN");
  expect(shown).toMatch(/settings\.json: environment must be a string/);
});
