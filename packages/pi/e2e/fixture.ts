import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** What tests can't reach through Pi's RPC commands. */
export default function fixture(pi: ExtensionAPI): void {
  // Moves back to the first prompt, summarizing the branch it leaves.
  pi.registerCommand("e2e-tree", {
    description: "Navigate to the first prompt with a branch summary",
    handler: async (_args, ctx) => {
      const first = ctx.sessionManager
        .getEntries()
        .find((entry) => entry.type === "message" && entry.message.role === "user");
      if (first) {
        await ctx.navigateTree(first.id, { summarize: true });
      }
    },
  });

  // Adds a custom message, which Pi sends to the model as a user message.
  pi.registerCommand("e2e-note", {
    description: "Add a custom message to the context",
    handler: async (args) => {
      pi.sendMessage({ customType: "e2e-note", content: args, display: true });
    },
  });

  // Writes the compaction summary instead of Pi.
  pi.on("session_before_compact", (event) =>
    process.env.E2E_EXTENSION_COMPACTION
      ? {
          compaction: {
            summary: "Summary written by an extension.",
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
          },
        }
      : undefined,
  );
}
