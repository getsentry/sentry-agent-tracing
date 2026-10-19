import type { RequestParameters } from "@sentry-internal/agent-tracing-core";

/** The names each provider's API uses for a setting, across Pi's API adapters. */
const NAMES = {
  temperature: ["temperature"],
  topP: ["top_p", "topP"],
  topK: ["top_k", "topK"],
  maxTokens: [
    "max_tokens",
    "max_completion_tokens",
    "max_output_tokens",
    "maxOutputTokens",
    "maxTokens",
  ],
  frequencyPenalty: ["frequency_penalty", "frequencyPenalty"],
  presencePenalty: ["presence_penalty", "presencePenalty"],
  seed: ["seed"],
  stopSequences: ["stop_sequences", "stopSequences", "stop"],
} as const;

/**
 * The sampling settings of a provider request, read from its payload. The payload is in the
 * provider's own format: Google nests settings in `config` or `generationConfig`, Bedrock in
 * `inferenceConfig`.
 */
export function requestParameters(payload: unknown): RequestParameters | undefined {
  if (!isObject(payload)) {
    return undefined;
  }
  const scopes = [
    payload,
    payload.config,
    payload.generationConfig,
    payload.inferenceConfig,
  ].filter(isObject);
  const find = (names: readonly string[]): unknown => {
    for (const scope of scopes) {
      for (const name of names) {
        if (scope[name] !== undefined && scope[name] !== null) {
          return scope[name];
        }
      }
    }
    return undefined;
  };
  const seed = find(NAMES.seed);
  const stop = find(NAMES.stopSequences);
  return {
    temperature: number(find(NAMES.temperature)),
    topP: number(find(NAMES.topP)),
    topK: number(find(NAMES.topK)),
    maxTokens: number(find(NAMES.maxTokens)),
    frequencyPenalty: number(find(NAMES.frequencyPenalty)),
    presencePenalty: number(find(NAMES.presencePenalty)),
    // The conventions type the seed as a string.
    seed: typeof seed === "number" || typeof seed === "string" ? String(seed) : undefined,
    stopSequences:
      typeof stop === "string"
        ? [stop]
        : Array.isArray(stop) && stop.every((value) => typeof value === "string")
          ? stop
          : undefined,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
