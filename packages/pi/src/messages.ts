import type { ContextEvent, convertToLlm, ToolInfo } from "@earendil-works/pi-coding-agent";
import type {
  GenAiMessage,
  GenAiPart,
  GenAiToolDefinition,
} from "@sentry-internal/agent-tracing-core";

/** A message in Pi's session, including Pi's own types such as compaction summaries. */
type AgentMessage = ContextEvent["messages"][number];
/** A message as Pi sends it to the model. */
export type LlmMessage = ReturnType<typeof convertToLlm>[number];
export type AssistantMessage = Extract<LlmMessage, { role: "assistant" }>;

type ContentBlock = Exclude<Extract<LlmMessage, { role: "user" }>["content"], string>[number];

const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;
const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;
const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;
const BRANCH_SUMMARY_SUFFIX = `</summary>`;

/**
 * Converts session messages to the messages Pi sends to the model, the same way as Pi's
 * convertToLlm (core/messages.ts). Importing it could load it from another copy of Pi than the
 * running one.
 */
export function toLlmMessages(messages: AgentMessage[]): LlmMessage[] {
  return messages.flatMap((message): LlmMessage[] => {
    switch (message.role) {
      case "bashExecution":
        // `!!` commands are run without adding them to the context.
        return message.excludeFromContext
          ? []
          : [userText(bashExecutionText(message), message.timestamp)];
      case "custom":
        return [
          {
            role: "user",
            content:
              typeof message.content === "string"
                ? [{ type: "text", text: message.content }]
                : message.content,
            timestamp: message.timestamp,
          },
        ];
      case "branchSummary":
        return [
          userText(
            BRANCH_SUMMARY_PREFIX + message.summary + BRANCH_SUMMARY_SUFFIX,
            message.timestamp,
          ),
        ];
      case "compactionSummary":
        return [
          userText(
            COMPACTION_SUMMARY_PREFIX + message.summary + COMPACTION_SUMMARY_SUFFIX,
            message.timestamp,
          ),
        ];
      case "system":
      case "user":
      case "assistant":
      case "toolResult":
        return [message];
      default:
        // Message types added in newer Pi releases.
        return [];
    }
  });
}

function userText(text: string, timestamp: number): LlmMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function bashExecutionText(message: Extract<AgentMessage, { role: "bashExecution" }>): string {
  let text = `Ran \`${message.command}\`\n`;
  text += message.output ? `\`\`\`\n${message.output}\n\`\`\`` : "(no output)";
  if (message.cancelled) {
    text += "\n\n(command cancelled)";
  } else if (
    message.exitCode !== null &&
    message.exitCode !== undefined &&
    message.exitCode !== 0
  ) {
    text += `\n\nCommand exited with code ${message.exitCode}`;
  }
  if (message.truncated && message.fullOutputPath) {
    text += `\n\n[Output truncated. Full output: ${message.fullOutputPath}]`;
  }
  return text;
}

export function toGenAiMessages(messages: LlmMessage[]): GenAiMessage[] {
  return messages.map((message): GenAiMessage => {
    switch (message.role) {
      case "system":
      case "user":
        return { role: message.role, parts: contentParts(message.content) };
      case "assistant":
        return toGenAiOutputMessage(message);
      case "toolResult":
        return {
          role: "tool",
          parts: [
            {
              type: "tool_call_response",
              id: message.toolCallId,
              name: message.toolName,
              result: text(message.content),
            },
          ],
        };
    }
  });
}

export function toGenAiOutputMessage(message: AssistantMessage): GenAiMessage {
  const parts: GenAiPart[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      parts.push({ type: "text", content: block.text });
    } else if (block.type === "thinking") {
      if (!block.redacted) {
        parts.push({ type: "reasoning", content: block.thinking });
      }
    } else {
      parts.push({ type: "tool_call", id: block.id, name: block.name, arguments: block.arguments });
    }
  }
  return { role: "assistant", parts, finish_reason: toFinishReason(message.stopReason) };
}

export function toFinishReason(stopReason: AssistantMessage["stopReason"]): string {
  return stopReason === "toolUse" ? "tool_call" : stopReason;
}

export function toGenAiToolDefinitions(tools: ToolInfo[]): GenAiToolDefinition[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export function text(content: string | ContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** Images become blob parts without their base64 data, like in Sentry's own Pi integrations. */
function contentParts(content: string | ContentBlock[]): GenAiPart[] {
  if (typeof content === "string") {
    return [{ type: "text", content }];
  }
  return content.map((block): GenAiPart =>
    block.type === "text"
      ? { type: "text", content: block.text }
      : { type: "blob", mime_type: block.mimeType },
  );
}
