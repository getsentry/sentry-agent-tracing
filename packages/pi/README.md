# @sentry/pi

[![npm version](https://img.shields.io/npm/v/@sentry/pi.svg)](https://www.npmjs.com/package/@sentry/pi)

> [!WARNING]
> Work in progress.

See what your [Pi](https://pi.dev) sessions cost and where they go wrong: token usage and cost per prompt, slow or failed model requests, and broken tool calls, in Sentry's agent monitoring.

## Install

Requires Pi 0.87.0 or later.

```sh
pi install npm:@sentry/pi
```

## Configuration

Add the DSN to `~/.pi/agent/settings.json`:

```json
{
  "sentry": {
    "dsn": "https://<key>@<org>.ingest.sentry.io/<project>"
  }
}
```

Each setting can also be set with an environment variable, which takes priority over `settings.json`.

| Setting                        | Variable                                   | Description                                                                    |
| ------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------ |
| `dsn`                          | `SENTRY_PI_DSN`                            | Required. Without it, the extension does nothing.                              |
| `environment`                  | `SENTRY_PI_ENVIRONMENT`                    | Environment name.                                                              |
| `org`                          | `SENTRY_PI_ORG`                            | Organization slug, used to link to the session in Sentry from Pi's status bar. |
| `dataCollection.genAI.inputs`  | `SENTRY_PI_DATA_COLLECTION_GEN_AI_INPUTS`  | `false` leaves out prompts, system prompts and tool arguments.                 |
| `dataCollection.genAI.outputs` | `SENTRY_PI_DATA_COLLECTION_GEN_AI_OUTPUTS` | `false` leaves out responses, summaries and tool results.                      |

`/sentry` shows whether tracing is enabled and where each setting comes from.
