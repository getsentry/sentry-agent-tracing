import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createTracer,
  conversationUrl,
  type AgentTracer,
} from "@sentry-internal/agent-tracing-core";
import pkg from "../package.json" with { type: "json" };
import { loadConfig, type PiConfig, type Project } from "./config.ts";
import { toLlmMessages } from "./messages.ts";
import { SessionRecorder, type RequestModel } from "./recorder.ts";
import { formatStatus } from "./status.ts";

const SDK = { name: "pi", version: pkg.version, packageName: pkg.name };
const STATUS_KEY = "sentry";
const ACTIVE = "Sentry ●";
const INACTIVE = "Sentry ○";

/** An OSC 8 hyperlink; terminals without support show the plain text. */
function hyperlink(text: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function requestModel(ctx: ExtensionContext): RequestModel | undefined {
  return ctx.model && { provider: ctx.model.provider, id: ctx.model.id };
}

function project(ctx: ExtensionContext): Project {
  return { cwd: ctx.cwd, trusted: ctx.isProjectTrusted() };
}

export default function sentry(pi: ExtensionAPI): void {
  let resolved = loadConfig();
  let currentSessionId: string | undefined;

  pi.registerCommand("sentry", {
    description: "Show Sentry tracing status and configuration",
    handler: async (_args, ctx) => ctx.ui.notify(formatStatus(resolved, currentSessionId), "info"),
  });

  const shown = new Set<string>();
  const reload = (ctx: ExtensionContext): PiConfig => {
    resolved = loadConfig(project(ctx));
    currentSessionId = ctx.sessionManager.getSessionId();
    for (const warning of resolved.warnings) {
      if (ctx.hasUI && !shown.has(warning)) {
        shown.add(warning);
        ctx.ui.notify(`Sentry: ${warning}`, "warning");
      }
    }
    return resolved;
  };

  const config = resolved.config;
  if (!config) {
    pi.on("session_start", (_event, ctx) => {
      reload(ctx);
      if (ctx.hasUI) {
        ctx.ui.setStatus(STATUS_KEY, INACTIVE);
      }
    });
    return;
  }

  let tracer: AgentTracer | undefined;
  let recorder: SessionRecorder | undefined;

  const guard = async (run: () => void | Promise<void>): Promise<void> => {
    try {
      await run();
    } catch {
      // Tracing must never affect the agent.
    }
  };

  // Pi also loads extensions without starting a session, so the tracer is created here.
  pi.on("session_start", (_event, ctx) =>
    guard(() => {
      const sessionConfig = reload(ctx).config ?? config;
      const sessionId = ctx.sessionManager.getSessionId();
      const url = conversationUrl(sessionConfig, sessionId);
      if (ctx.hasUI) {
        ctx.ui.setStatus(
          STATUS_KEY,
          url ? `${ACTIVE} · ${hyperlink("Go to conversation ↗", url)}` : ACTIVE,
        );
      }
      const current = createTracer(sessionConfig, SDK);
      tracer = current;
      recorder = new SessionRecorder(sessionId, (agentEvent) => current.handle(agentEvent));
      recorder.sessionStart();
    }),
  );

  pi.on("session_shutdown", (_event, ctx) =>
    guard(async () => {
      const ending = { tracer, recorder };
      tracer = undefined;
      recorder = undefined;
      ending.recorder?.sessionShutdown();
      await ending.tracer?.flush();
      if (ctx.hasUI) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    }),
  );

  pi.on("agent_start", () => guard(() => recorder?.agentStart()));

  // Pi 1.1 added `aborted`.
  pi.on("agent_settled", (event) =>
    guard(() => recorder?.agentSettled("aborted" in event && event.aborted === true)),
  );

  // Runs after every extension's `context` handler, so these are the messages sent. The leading
  // system message holds the system prompt and tools, which are recorded separately.
  pi.on("context_with_system", (event, ctx) =>
    guard(() => {
      const messages =
        event.messages[0]?.role === "system" ? event.messages.slice(1) : event.messages;
      const active = new Set(pi.getActiveTools());
      recorder?.context(
        toLlmMessages(messages),
        ctx.getSystemPrompt(),
        pi.getAllTools().filter((tool) => active.has(tool.name)),
        requestModel(ctx),
        messages.some((message) => message.role === "compactionSummary"),
      );
    }),
  );

  pi.on("before_provider_request", (event) =>
    guard(() => recorder?.providerRequest(event.payload)),
  );

  pi.on("message_update", (event) => guard(() => recorder?.messageUpdate(event)));

  pi.on("message_end", (event) => guard(() => recorder?.messageEnd(event)));

  pi.on("tool_execution_start", (event) =>
    guard(() =>
      recorder?.toolExecutionStart(
        event,
        pi.getAllTools().find((tool) => tool.name === event.toolName)?.description,
      ),
    ),
  );

  pi.on("tool_execution_end", (event) => guard(() => recorder?.toolExecutionEnd(event)));

  pi.on("session_before_compact", () => guard(() => recorder?.compactionStart()));

  pi.on("session_compact", (event, ctx) =>
    guard(() => recorder?.compactionEnd(event, requestModel(ctx))),
  );

  pi.on("session_compact_failed", (event, ctx) =>
    guard(() => recorder?.compactionFailed(event, requestModel(ctx))),
  );

  pi.on("session_before_tree", (event) => guard(() => recorder?.treeStart(event)));

  pi.on("session_tree", (event, ctx) => guard(() => recorder?.treeEnd(event, requestModel(ctx))));
}
