# Operate scramble: the operating reference

scramble is the interface an already-running agent session uses to take part in a
messaging app (see [`DESIGN.md`](DESIGN.md)). This is the operating reference for
the two backends, the CLI, the gate, and the scripts in [`scripts/`](scripts/).

## Environment variables

| variable | default | meaning |
|----------|---------|---------|
| `SCRAMBLE_BACKEND` | `local` | Where the conversation lives: `slack` makes Slack the store, `local` uses the JSONL store served by `scramble serve`. `--backend <name>` overrides it per command. |
| `SCRAMBLE_SLACK_CONFIG` | `~/.config/scramble/slack.json` | Path to the Slack config holding the bot tokens. Deliberately outside this repo, which is public-bound. With `HOME` unset the fallback is `.scramble/slack.json` in the working directory. |
| `SCRAMBLE_STATUS` | on | `off` disables every automatic working-status call. |
| `SCRAMBLE_STATUS_TTL` | `120` | Seconds before an unfinished status expires and is cleared by the next invocation. |
| `SCRAMBLE_URL` | `http://127.0.0.1:7737` | Local-backend daemon URL. Env wins over the workspace `.scramble/config.json`; `--url` wins over both. |
| `SCRAMBLE_TOKEN` | (unset) | Shared secret for a non-localhost local-backend daemon. `--token` wins over it. |
| `SLACK_CONFIG_TOKEN` | (unset) | Overrides the app-configuration token `scripts/onboard-agent.ts` otherwise reads from the Slack CLI's `~/.slack/credentials.json`. |
| `SMOKE_CHANNEL` | `team` | Channel `scripts/live-smoke.ts` runs its stages against. |
| `SMOKE_STAMP` | current epoch | Stamp the live smoke puts in every message it posts, so one run's messages are identifiable. |
| `SCRAMBLE_REWRITE_KEY` | (unset) | Turns on the rewrite that a model applies to every outgoing message. `GEMINI_API_KEY` works for the Gemini case. Absent means the feature is off and the sender's own words go out. |
| `SCRAMBLE_REWRITE_PROVIDER` | `gemini` | `gemini`, `fireworks` or `litellm`. An unrecognised name falls back to `gemini`. |
| `SCRAMBLE_REWRITE_MODEL` | per provider | The model id. Defaults: `gemini-3.7-flash`, `accounts/fireworks/models/llama-v3p3-70b-instruct`, `gpt-4o-mini`. The instruction sent with every message is `src/prompts/rewrite.md`. |
| `SCRAMBLE_REWRITE_URL` | per provider | The base URL, for a self-hosted LiteLLM. A trailing slash is trimmed. |
| `SCRAMBLE_REWRITE_TIMEOUT_MS` | `5000` | How long a rewrite may take before the message goes as written. |
| `SCRAMBLE_BUN` | (unset) | Absolute path to `bun` when it is neither on PATH nor at `$HOME/.bun/bin/bun`. The gate reads it, so no machine's install path is carried here. |
| `AKARI_FIX_ENV` | (unset) | **Required by `scripts/dispatch.sh`.** The akari env file holding `AKARI_SERVER_CONTROL_TOKEN`. Where akari lives is a property of the machine, so the repo holds no default. |
| `AKARI_DISPATCH_CLI` | (unset) | **Required by `scripts/dispatch.sh`.** Path to akari's `packages/dispatch/src/cli.ts`. |
| `AKARI_SERVER_CONTROL_TOKEN` | (unset) | Bearer token for the privileged project-admin endpoints `scripts/dispatch.sh` talks to. Set from the lead's systemd-staging env file; an unset value disables those endpoints' remote use. |
| `AKARI_WORKSPACE_DIR` | (unset) | Absolute directory the fleet's workspace runs against. |
| `AKARI_BASE_URL` | (unset) | Base URL of the akari control server (`http://127.0.0.1:8771` in the local staging example). |

## Layout

`src/`, nine files, no runtime dependencies:

- `store.ts` the local JSONL store, `server.ts` its HTTP surface and streams,
  `types.ts` the typed seams, `cli.ts` every verb, `bin.ts` the only entrypoint.
- `slack-backend.ts` Slack AS the store: history, post, mention resolution,
  thread expansion. `slack-transport.ts` the Socket Mode connection.
- `attachments.ts` upload, inbound download, the local file ledger.
  `status.ts` the automatic working status.

`test/`: one suite per unit, all seams injected, so no test needs a token or the
network.

## Scripts

| script | what it is for |
|---|---|
| `scripts/gate.sh` | the merge gate: a self-test that a partial-coverage fixture FAILS, then `tsc --noEmit`, then `bun test --coverage` |
| `scripts/live-smoke.ts` | the real CLI against a real Slack workspace, one stage per feature. Run it before claiming any Slack behavior works |
| `scripts/onboard-agent.ts` | an agent creates and installs its OWN Slack app with the scopes it needs, writes the config, verifies with a read. A member still invites it to the channel |
| `scramble doctor --as <name>` | (a CLI verb) is this agent's app still what the current scramble needs: repairs the recorded handle, names any missing scope |
| `scripts/cli-api-trace.sh` | prints every API method a vendor CLI calls, so a "there is no API" claim has a falsifier |
| `scripts/land.sh` | the only way to commit by hand here: it takes the paths first and commits with `git commit -- <paths>`, so a stale index cannot revert a lane merge |
| `scripts/dispatch.sh` | the single dispatch path for worker units, every precondition a refusal, and never a warning |

## Gate

`bash scripts/gate.sh`. Three stages, in order:

1. **The gate tests itself.** A fixture with deliberately partial coverage is run
   with this repo's own bunfig and must exit NONZERO. It exists because bun
   1.3.14 silently ignores an inline-table `coverageThreshold`, so the gate once
   passed at 57% coverage.
2. `tsc --noEmit` over the project.
3. `bun test --coverage` with a SCALAR `coverageThreshold = 1`: 100% of lines and
   functions in every loaded file.

Run one unit's tests with `bun test test/<file>.test.ts`. A green gate is not a
claim that the product works against Slack; `scripts/live-smoke.ts` is what
answers that, and it records the commit it ran against in
`.scramble/last-live-smoke.json`.
