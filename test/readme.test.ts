import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCOPE_NAMES, BOT_EVENT_NAMES } from "../src/app-manifest";

const ROOT = join(import.meta.dir, "..");
const plan = readFileSync(join(ROOT, "PLAN.md"), "utf8");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
// The onboarding script generates the app manifest from src/app-manifest.ts, and
// `doctor` verifies a live app against that manifest. This process still reads
// the script's TEXT for the settings it writes literally (socket mode, org
// deploy).
const onboard = readFileSync(join(ROOT, "scripts", "onboard-agent.ts"), "utf8");
const joinDoc = readFileSync(join(ROOT, "JOIN.md"), "utf8");

// The global contract note specifies that every command accepts `--url` and
// `--token`, regardless of the row in which the command appears.
const GLOBAL_FLAGS = ["--url", "--token"];

// The parser extracts the authoritative CLI contract table from PLAN.md into
// verb -> Set<flags>, omitting global flags.
function parseContract(): Map<string, Set<string>> {
  const verbs = new Map<string, Set<string>>();
  const lines = plan.split("\n");
  const start = lines.findIndex((l) => l.startsWith("## The CLI contract"));
  if (start < 0) throw new Error("PLAN.md: CLI contract section not found");
  for (const line of lines.slice(start)) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 3) continue;
    if (cells.every((c) => /^[-:]+$/.test(c))) continue; // header separator
    if (cells[0] === "command") continue; // column header row
    const verb = cells[1]!.replace(/`/g, "").trim().split(/\s+/)[0]!;
    const flags = cells[2]!.match(/--[a-z-]+/g) ?? [];
    // The check merges new data into existing entries. The key is the first word, and
    // the contract defines several rows per verb, including `message send`,
    // `message read`, and `message react`. Replacing entries kept only the flags from
    // the last row, so a flag documented on `message send` failed this check because a
    // later `message` row had none of it.
    const already = verbs.get(verb) ?? new Set<string>();
    for (const f of flags) already.add(f);
    verbs.set(verb, already);
  }
  return verbs;
}

const CONTRACT = parseContract();
function allowedFlags(verb: string): Set<string> {
  const base = new Set(CONTRACT.get(verb) ?? []);
  for (const f of GLOBAL_FLAGS) base.add(f);
  return base;
}

// Extract every command-like line from the README, including the contents of
// fenced code blocks and all inline `code` spans, and split them into logical
// lines.
function codeLines(md: string): string[] {
  const chunks: string[] = [];
  let inFence = false;
  for (const raw of md.split("\n")) {
    if (/^\s*`{3,}/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      chunks.push(raw);
      continue;
    }
    for (const span of raw.match(/`([^`]+)`/g) ?? []) {
      chunks.push(span.slice(1, -1));
    }
  }
  return chunks;
}

function scrambleCommands(md: string): string[] {
  const out: string[] = [];
  for (const rawLine of codeLines(md)) {
    // The command strips a shell prompt marker if one is present.
    const line = rawLine.replace(/^\s*\$?\s*/, "");
    const tokens = line.split(/\s+/).filter((t) => t !== "");
    const i = tokens.indexOf("scramble");
    if (i >= 0) out.push(tokens.slice(i).join(" "));
  }
  return out;
}

describe("README documents only contract commands", () => {
  const commands = scrambleCommands(readme);

  test("parses the six contract verbs out of PLAN.md", () => {
    for (const verb of ["post", "listen", "history", "next", "join", "serve"]) {
      expect(CONTRACT.has(verb), `verb ${verb} in contract`).toBe(true);
    }
  });

  test("every scramble command uses a contract verb and contract flags", () => {
    expect(commands.length).toBeGreaterThan(0);
    for (const cmd of commands) {
      const tokens = cmd.split(/\s+/);
      const payload = tokens.slice(1); // drop the leading "scramble"
      const verb = payload[0]!;
      expect(CONTRACT.has(verb), `verb "${verb}" from README is not in the contract`).toBe(true);
      const flags = payload.slice(1).filter((t) => /^--[a-z-]+$/.test(t));
      const allowed = allowedFlags(verb);
      for (const f of flags) {
        expect(allowed.has(f), `flag ${f} on "scramble ${verb}" is not contract-callable`).toBe(true);
      }
    }
  });
});

describe("README content", () => {
  test("opens by saying what scramble is, in the product's own words", () => {
    const second = readme.split("\n\n");
    const intro = second[1] ?? second[0] ?? "";
    // Scramble is the interface an existing session uses to take part in a messaging
    // app. The entire design rests on this distinction, which the opening must carry.
    expect(intro).toContain("interface");
    expect(intro).toContain("messaging app");
    expect(intro).toContain("agent session");
    expect(intro).toContain("shell command");
  });

  test("the onboarding call to action is one sentence pointing at JOIN.md", () => {
    const cta = "Onboard yourself into our Slack by following JOIN.md in <path-to-scramble>.";
    expect(readme).toContain(cta);
    // The section contains one sentence and no machine path. The walkthrough belongs
    // in the document the line points at, where the agent can ask the person its two
    // questions.
    expect(cta.split(". ").length).toBe(1);
    expect(cta).not.toContain("/opt/");
  });

  test("JOIN.md runs the onboarding as a conversation, asking both names", () => {
    expect(joinDoc).toContain("Ask what you should be called in the channel");
    expect(joinDoc).toContain("Ask them to confirm the name Slack will show");
    expect(joinDoc).toContain("--app-name");
    expect(joinDoc).toContain("/invite @<handle>");
  });

  test("documents the two read modes table", () => {
    expect(readme).toContain("stream");
    expect(readme).toContain("blocking");
    expect(readme).toContain("supported-vendor list");
  });

  test("points the Slack setup at the self-onboarding script", () => {
    expect(readme).toContain("scripts/onboard-agent.ts");
    expect(readme).toContain("users:read");
  });

  test("leads with Slack and keeps the local store to a short fallback", () => {
    // This README addresses the scenario scramble exists for, where the conversation
    // is already in Slack. The local store is a fallback and a test fixture, so the
    // documentation mentions it, whereas a tour of daemons, tokens, and tunnels would
    // obscure the Slack path the reader came for.
    const slack = readme.indexOf("## Slack");
    const local = readme.indexOf("## The local store");
    expect(slack).toBeGreaterThan(0);
    expect(local).toBeGreaterThan(slack);
    // The section is short. A handful of lines follow that heading.
    const tail = readme.slice(local).split("\n").filter((l) => l.trim() !== "");
    expect(tail.length).toBeLessThan(22);
    // The OPERATING.md file provides operational details for the daemon.
    expect(readme).toContain("OPERATING.md");
    expect(readme).not.toContain("ssh -L");
  });

  test("recommends raft before it explains itself", () => {
    const raft = readme.indexOf("## Consider raft first");
    expect(raft).toBeGreaterThan(0);
    expect(raft).toBeLessThan(readme.indexOf("## Quickstart"));
    expect(readme).toContain("raft.build");
    // The reason scramble exists is the only justification for choosing it over raft.
    expect(readme).toContain("already reside in Slack");
  });
});

describe("the app manifest the onboarding script builds", () => {
  test("declares every scope a feature needs", () => {
    // The integration omits `chat:write.customize`. Running one app per agent means
    // each agent is a real Slack user, so an identity that is only a display name has
    // no purpose.
    for (const scope of [
      "chat:write",
      "channels:history",
      "groups:history",
      "im:history",
      "im:read",
      "im:write",
      "users:read",
      "channels:read",
      "groups:read",
      "files:read",
      "files:write",
      "reactions:write",
      "reactions:read",
      "assistant:write",
    ]) {
      expect(SCOPE_NAMES).toContain(scope);
    }
    expect(SCOPE_NAMES).not.toContain("chat:write.customize");
    // The app does not request channels:join. An app cannot add itself to a public or
    // private Slack conversation, so a member invites the app and the scope provides
    // no benefit.
    expect(SCOPE_NAMES).not.toContain("channels:join");
  });

  test("subscribes one event per conversation kind, AND the invite", () => {
    expect(BOT_EVENT_NAMES).toContain("message.channels");
    expect(BOT_EVENT_NAMES).toContain("message.groups");
    expect(BOT_EVENT_NAMES).toContain("message.im");
    // Without this subscription, an invite delivers nothing and nothing reports it.
    // Slack sends no event that an app has not subscribed to, so the agent never
    // hears when someone adds it to a channel. Every app created before this event was
    // added kept three events until `doctor` learned to compare.
    expect(BOT_EVENT_NAMES).toContain("member_joined_channel");
  });

  test("enables socket mode AND declares org deploy, or the inbox is silently dead", () => {
    expect(onboard).toContain("socket_mode_enabled: true");
    // `apps.developerInstall` with an organization-level credential creates an
    // enterprise installation regardless of the `team_id` passed to the call. An
    // organization installation whose manifest sets `org_deploy_enabled: false`
    // receives no events, while every REST API call continues to function. Live
    // measurements confirm these results.
    expect(onboard).toContain("org_deploy_enabled: true");
    expect(onboard).not.toContain("org_deploy_enabled: false,");
  });

  test("refuses an enterprise id, which is what needs an administrator", () => {
    expect(onboard).toContain("is an ENTERPRISE id");
    expect(onboard).toContain("team_id");
  });
});
