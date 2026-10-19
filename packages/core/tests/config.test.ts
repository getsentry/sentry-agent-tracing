import { expect, test } from "vite-plus/test";
import { envName, readConfigObject, readEnv, resolveConfig } from "../src/config.ts";

const DSN = "https://abc123@sentry.io/42";

test("is disabled without a DSN", () => {
  expect(resolveConfig([readEnv("SENTRY_PI_", {})]).config).toBeUndefined();
});

test("reads the prefixed environment variables only", () => {
  expect(
    resolveConfig([
      readEnv("SENTRY_PI_", {
        SENTRY_DSN: "https://app@sentry.io/1",
        SENTRY_PI_DSN: DSN,
        SENTRY_PI_ENVIRONMENT: "dev",
      }),
    ]).config,
  ).toEqual({
    dsn: DSN,
    environment: "dev",
    dataCollection: { genAI: { inputs: true, outputs: true } },
  });
});

test("data collection settings are nested in files and flat in the environment", () => {
  expect(envName("SENTRY_PI_", "dataCollection.genAI.inputs")).toBe(
    "SENTRY_PI_DATA_COLLECTION_GEN_AI_INPUTS",
  );
  const file = readConfigObject("settings.json", {
    dsn: DSN,
    dataCollection: { genAI: { inputs: false } },
  });
  const env = readEnv("SENTRY_PI_", { SENTRY_PI_DATA_COLLECTION_GEN_AI_OUTPUTS: "0" });

  expect(resolveConfig([file, env]).config?.dataCollection).toEqual({
    genAI: { inputs: false, outputs: false },
  });
  expect(() =>
    readConfigObject("settings.json", { dataCollection: { genAI: { inputs: "no" } } }),
  ).toThrow("settings.json: dataCollection.genAI.inputs must be true or false");
});

test("later sources win and are recorded as the origin", () => {
  const file = readConfigObject("settings.json", {
    dsn: DSN,
    environment: "file",
    org: "acme",
  });
  const env = readEnv("SENTRY_PI_", { SENTRY_PI_ENVIRONMENT: "env", SENTRY_PI_ORG: "" });

  expect(resolveConfig([file, env])).toEqual({
    config: {
      dsn: DSN,
      environment: "env",
      dataCollection: { genAI: { inputs: true, outputs: true } },
    },
    origins: {
      dsn: "settings.json",
      environment: "SENTRY_PI_ENVIRONMENT",
      org: "SENTRY_PI_ORG",
    },
  });
});

test("an empty variable unsets the DSN from a file", () => {
  const file = readConfigObject("settings.json", { dsn: DSN });
  const env = readEnv("SENTRY_PI_", { SENTRY_PI_DSN: "" });

  expect(resolveConfig([file, env]).config).toBeUndefined();
});

test("a settings object with the wrong types throws", () => {
  expect(() => readConfigObject("settings.json", { dsn: 42 })).toThrow(
    "settings.json: dsn must be a string",
  );
  expect(() => readConfigObject("settings.json", "dsn")).toThrow(
    "settings.json: expected an object",
  );
});
