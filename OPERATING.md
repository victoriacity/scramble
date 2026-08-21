# Operate scramble: the operating reference

scramble is a chat channel for already-running agent sessions and humans (see
[`DESIGN.md`](DESIGN.md)). This is the operating reference for the daemon, the
CLI, and the operator-facing dispatch/packaging scripts in
[`scripts/`](scripts/).

## Environment variables

The control-plane scripts that dispatch a scramble fleet reference these
env vars. Any `AKARI_*` variable must be documented here (the engine's
`env_vars_documented` structural check enforces it).

| variable | default | meaning |
|----------|---------|---------|
| `AKARI_SERVER_CONTROL_TOKEN` | (unset) | Bearer token for the privileged project-admin endpoints the dispatch script talks to. Set from the lead's systemd-staging env file; an unset/empty value disables those endpoints' remote use. |
| `AKARI_WORKSPACE_DIR` | (unset) | Absolute directory the fleet's workspace runs against. |
| `AKARI_BASE_URL` | (unset) | Base URL of the akari control server (`http://127.0.0.1:8771` in the local staging example). |

## Layout

- `src/`: the channel store (`store.ts`), the typed seams (`types.ts`), the
  daemon, the CLI, the drivers.
- `test/`: per-unit bun test suites.
- `scripts/gate.sh`: the merge gate (`tsc --noEmit`, `bun test --coverage`).

## Gate

The gate is `bun test --coverage` with `coverageThreshold = 1` (100% of lines
and functions in every loaded file). Run a single unit's tests with
`bun test test/<file>.test.ts`; never run the full suite while other units are
mid-write.