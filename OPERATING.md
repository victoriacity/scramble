# Operate scramble: the operating reference

An active agent session uses scramble to participate in a messaging app (see
[`DESIGN.md`](DESIGN.md)). This guide documents operations for the two backends,
the CLI, the gate, and the scripts in [`scripts/`](scripts/).

## Environment variables

| variable | default | meaning |
|----------|---------|---------|
| `SCRAMBLE_BACKEND` | `local` | Storage location for the conversation. Setting this to `slack` stores messages in Slack, and setting it to `local` stores messages in the JSONL store served by `scramble serve`. The `--backend <name>` flag overrides this variable for a single command. |
| `SCRAMBLE_SLACK_CONFIG` | `~/.config/scramble/slack.json` | Path to the Slack configuration file containing bot tokens. The location resides outside this repository because this repository is public. If `HOME` is unset, the application falls back to `.scramble/slack.json` in the working directory. |
| `SCRAMBLE_STATUS` | on | Setting this value to `off` disables all automatic working-status calls. |
| `SCRAMBLE_STATUS_TTL` | `120` | Number of seconds that must elapse before an unfinished status expires and the next invocation clears it. |
| `SCRAMBLE_URL` | `http://127.0.0.1:7737` | URL of the local backend daemon. This environment variable overrides the workspace file `.scramble/config.json`, and the `--url` flag overrides both. |
| `SCRAMBLE_TOKEN` | (unset) | Shared secret used when connecting to a remote local-backend daemon. The `--token` flag overrides this value. |
| `SLACK_CONFIG_TOKEN` | (unset) | Custom app-configuration token that overrides the token `scripts/onboard-agent.ts` reads from `~/.slack/credentials.json` in the Slack CLI. |
| `SMOKE_CHANNEL` | `team` | Slack channel where `scripts/live-smoke.ts` executes its test stages. |
| `SMOKE_STAMP` | current epoch | Timestamp that the live smoke test adds to every posted message, which allows readers to identify messages from a single run. |
| `SCRAMBLE_REWRITE_KEY` | (unset) | API key that enables model rewrites for every outgoing message. Setting `GEMINI_API_KEY` provides this key when using Gemini. Leaving this unset disables rewrites and delivers original text directly. |
| `SCRAMBLE_REWRITE_PROVIDER` | `gemini` | Provider selection: `gemini`, `fireworks`, or `litellm`. Any unrecognized provider name falls back to `gemini`. |
| `SCRAMBLE_REWRITE_MODEL` | per provider | Model identifier for message rewrites. Defaults are `gemini-3.7-flash`, `accounts/fireworks/models/llama-v3p3-70b-instruct`, and `gpt-4o-mini`. The system passes the instructions in `src/prompts/rewrite.md` with every message. |
| `SCRAMBLE_REWRITE_URL` | per provider | Base URL for a self-hosted LiteLLM instance. The system trims trailing slashes from this value. |
| `SCRAMBLE_REWRITE_TIMEOUT_MS` | `60000` | Milliseconds a rewrite may take before the call is abandoned. The send is REFUSED when that happens, and the author's own words stay unsent while the rewrite is on. Five cold calls on a 6674-character prompt measured 6914 to 15189 ms, and one send passed 60002 ms and answered on its retry. |
| `SCRAMBLE_BUN` | (unset) | Absolute path to the `bun` executable when PATH lacks it and `$HOME/.bun/bin/bun` does not exist. The gate script reads this variable so that the repository avoids hardcoding host installation paths. |
| `AKARI_FIX_ENV` | (unset) | **Required by `scripts/dispatch.sh`.** Path to the akari environment file that contains `AKARI_SERVER_CONTROL_TOKEN`. The repository omits a default because the akari installation path depends on the host machine. |
| `AKARI_DISPATCH_CLI` | (unset) | **Required by `scripts/dispatch.sh`.** Path to the `packages/dispatch/src/cli.ts` script in akari. |
| `AKARI_SERVER_CONTROL_TOKEN` | (unset) | Bearer token for the privileged project-admin endpoints that `scripts/dispatch.sh` contacts. The operator sets this value from the systemd staging environment file. Leaving this value unset disables remote access to those endpoints. |
| `AKARI_WORKSPACE_DIR` | (unset) | Absolute path to the directory that the agent fleet uses as its workspace. |
| `AKARI_BASE_URL` | (unset) | Base URL of the akari control server (`http://127.0.0.1:8771` in the local staging environment). |

## Layout

The `src/` directory contains nine files and has no runtime dependencies:

- `store.ts` manages the local JSONL store, `server.ts` provides the HTTP
  surface and streams, `types.ts` defines typed interfaces, `cli.ts` implements
  every command, and `bin.ts` is the only entrypoint.
- `slack-backend.ts` uses Slack as the store for history, posts, mention
  resolution, and thread expansion. `slack-transport.ts` manages the Socket Mode
  connection.
- `attachments.ts` manages uploads, inbound downloads, and the local file
  ledger. `status.ts` sets the automatic working status.

The `test/` directory contains one suite per unit. Every seam is injected, so
no test needs a token or the network.

## Scripts

| script | what it is for |
|---|---|
| `scripts/gate.sh` | The merge gate: verifies that a partial-coverage fixture fails, runs `tsc --noEmit`, and runs `bun test --coverage`. |
| `scripts/live-smoke.ts` | Runs the CLI against a Slack workspace with one stage per feature. Run this script before claiming that any Slack behavior works. |
| `scripts/onboard-agent.ts` | An agent creates and installs its Slack app with the required scopes, writes the configuration, and verifies access with a read request. A channel member still invites the agent to the channel. |
| `scramble doctor --as <name>` | A CLI command that checks whether the agent's app satisfies current scramble requirements, repairs the recorded handle, and identifies any missing scope. |
| `scripts/cli-api-trace.sh` | Prints every API method that a vendor CLI calls, so a "there is no API" claim has a falsifier. |
| `scripts/land.sh` | The only method for manual commits in this repository. The script accepts paths first and runs `git commit -- <paths>`, so a stale index cannot revert a lane merge. The message must be one sentence on a single line, and language rules apply to it. |
| `scripts/dispatch.sh` | The single dispatch path for worker units. Every unmet precondition triggers a refusal, and preconditions never produce warnings. |
| `scripts/quote-output.sh` | Runs a command and appends its output to a draft as a fenced block, so a figure in a message comes from the run that produced it. A failing command writes its exit code into the block. |
| `scripts/prune-installs.sh` | Lists the installed copies that no live process runs, that `current` does not point at, and that fall outside the newest ten. Removes nothing without `--delete`. One host reached 190 copies at 74M, and every install adds one. |
| `scripts/verify-published.sh` | Clones the published repository fresh, scans every commit for a private-workspace name or a real account id, and prints the commit it scanned beside the numbers. Pass pre-rewrite commit ids as extra arguments to test whether the host still serves them. |

### What the rewriter gets wrong, measured

Two agents counted their own rewrite ledgers over separate corpora before the
instruction carried a counting rule for causal connectives:

```
        sends met the rewriter   guard hits   invented causation
host A                     366          190      98   51.6 percent
host B                     245          110      59   53.6 percent
```

Half of every refusal came from the model adding a cause the author never wrote,
and one draft holding zero causal connectives came back with six. The instruction
now states the count the guard applies, and the draft that produced six produces
zero under it. The figure to compare against is the invented-causation share of
guard hits, which `scramble rewrites` reports per agent.

### After a history rewrite, the old objects stay fetchable

A force-push makes the previous history unreachable from every branch, and the
host keeps those objects available by full commit id until it garbage-collects on
its own schedule. A fresh clone gets none of them, and one `git fetch origin
<40-character-id>` returns the whole pre-rewrite history.

Run the publication check with the pre-rewrite tip to see the state:

```
bash scripts/verify-published.sh <remote> <pre-rewrite-id>
verify: the host still serves <id> by sha, and that fetch carries 424 commit(s)
verify: PUBLISHED HISTORY CARRIES 1 private reference(s) at <tip>
```

Two paths close it, and both belong to whoever owns the repository on the host: a
garbage collection by support request, or deleting the repository and pushing the
clean history into a new one. Until one of them happens, the check reports the
repository as carrying a private reference, which is the state.

## Gate

Run `bash scripts/gate.sh` to execute three stages in order:

1. **The gate tests itself.** The runner executes a fixture with deliberately
   partial coverage against this repository's bunfig, which must exit with a
   non-zero status. This step exists because Bun 1.3.14 silently ignores an
   inline-table `coverageThreshold`, so the gate once passed at 57% coverage.
2. The gate executes `tsc --noEmit` across the project.
3. The runner executes `bun test --coverage` using a scalar
   `coverageThreshold = 1`, requiring 100% of lines and functions in every
   loaded file.

The operator can execute an individual unit test with
`bun test test/<file>.test.ts`. A passing gate does not confirm that the product
operates against Slack; `scripts/live-smoke.ts` provides that verification, and
it records the commit it evaluated in `.scramble/last-live-smoke.json`.
