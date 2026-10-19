# Contributing

## Layout

| Package                      | What it is                                                                                                              |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `packages/core`              | Agent-agnostic: configuration, the event model, the tracer. Private, bundled into each plugin.                          |
| `packages/pi` (`@sentry/pi`) | The Pi extension. Translates Pi's extension events into core events and adds the `/sentry` command and status bar item. |

## Setup

The repository uses [Vite+](https://viteplus.dev) (`vp`) and pnpm.

```sh
vp install
```

## Commands

```sh
vp check                          # format, lint and type check
vp check --fix                    # same, fixing what it can
vp run -r test                    # unit tests
vp run -r build                   # build every package
vp run ready                      # all of the above
vp run --filter @sentry/pi dev    # rebuild packages/pi/dist on change
vp run --filter @sentry/pi e2e    # end-to-end tests with the real Pi CLI
```

## Running Pi with the extension

Build it, then start the Pi installed as a dev dependency with it:

```sh
export SENTRY_PI_DSN=https://<key>@<org>.ingest.sentry.io/<project>
export SENTRY_PI_ENVIRONMENT=local
packages/pi/node_modules/.bin/pi --extension packages/pi/dist/index.mjs
```

Restart Pi to pick up a rebuilt extension. Spans are sent about half a second after each prompt finishes, and whatever is left when Pi exits. `/sentry` shows the resolved settings.

## End-to-end tests

`packages/pi/e2e` runs the Pi CLI in RPC mode against a mock model server and a mock Sentry, each test with its own home directory. They cover turns, tools, compactions, sessions, the provider APIs and configuration.

| Variable       | Default                      | Use                                                         |
| -------------- | ---------------------------- | ----------------------------------------------------------- |
| `PI_BIN`       | The dev dependency's `pi`    | Test another Pi version, for example one installed with npm |
| `PI_EXTENSION` | `packages/pi/dist/index.mjs` | Test another build, for example the unpacked npm tarball    |

```sh
npm install --prefix /tmp/pi @earendil-works/pi-coding-agent@0.87.0
PI_BIN=/tmp/pi/node_modules/.bin/pi vp run --filter @sentry/pi e2e
```

CI runs them against the oldest supported Pi, 0.87.0, and the latest, using the packed tarball.

## How the Pi extension works

It subscribes to Pi's [extension events](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md):

| Pi event                                                              | Used for                                                                                       |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `session_start`, `session_shutdown`                                   | Settings, the tracer and the status bar; sending what's left on exit                           |
| `agent_start`, `agent_settled`                                        | One trace per prompt, including retries and other continuations                                |
| `context_with_system`                                                 | The messages, system prompt and tools of each model request, after every extension's `context` |
| `before_provider_request`, `message_update`                           | Request timing, sampling settings from the provider payload, time to first chunk               |
| `message_end`                                                         | Model, response, token usage, cost and stop reason                                             |
| `tool_execution_start`, `tool_execution_end`                          | Tool calls; nested calls sit under the tool that made them                                     |
| `session_before_compact`, `session_compact`, `session_compact_failed` | Compactions                                                                                    |
| `session_before_tree`, `session_tree`                                 | Branch summaries                                                                               |

The extension imports nothing from Pi at runtime. Pi loads it as native ESM, so those imports would resolve to the copy of Pi next to the extension, not the running one. Messages are converted the same way as Pi's `convertToLlm` instead.

Attribute keys come from [`@sentry/conventions`](https://www.npmjs.com/package/@sentry/conventions). New ones are proposed in [getsentry/sentry-conventions](https://github.com/getsentry/sentry-conventions) first, and kept in `packages/core/src/attributes.ts` until they're released.

## Commits

Conventional commit titles, such as `feat(pi): Add a /sentry status command`. Each commit passes `vp check`. Craft builds the changelog from them.

## Releasing

Run the **Release** workflow from the Actions tab, with a version or `auto`. Craft bumps `packages/pi/package.json`, and the release is published once its issue in [getsentry/publish](https://github.com/getsentry/publish) is approved. The npm tarball comes from the `npm-package` artifact of the CI workflow.
