import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const plan = readFileSync(join(ROOT, "PLAN.md"), "utf8");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
// The onboarding script is the single source for the app manifest: it creates
// the app from this list and `--print-manifest` prints it for a manual paste.
const onboard = readFileSync(join(ROOT, "scripts", "onboard-agent.ts"), "utf8");
const joinDoc = readFileSync(join(ROOT, "JOIN.md"), "utf8");

// The global contract note grants --url / --token to EVERY command regardless of
// the row it appears in ("Every command accepts --url / --token ...").
const GLOBAL_FLAGS = ["--url", "--token"];

// Parse the authoritative CLI contract table out of PLAN.md into
// verb -> Set<flags, not including the global ones>.
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
    verbs.set(verb, new Set(flags));
  }
  return verbs;
}

const CONTRACT = parseContract();
function allowedFlags(verb: string): Set<string> {
  const base = new Set(CONTRACT.get(verb) ?? []);
  for (const f of GLOBAL_FLAGS) base.add(f);
  return base;
}

// Pull every command-like line out of the README: the contents of fenced code
// blocks plus any inline `code` spans, split into logical lines.
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
    // strip a shell prompt marker, if present
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
    // Not "chat channel": scramble is the INTERFACE an existing session uses to
    // take part in a messaging app, which is the distinction the whole design
    // rests on, and the opening has to carry it.
    expect(intro).toContain("interface");
    expect(intro).toContain("messaging app");
    expect(intro).toContain("already-running");
    expect(intro).toContain("shell command");
  });

  test("the onboarding call to action is one sentence pointing at JOIN.md", () => {
    const cta = "Onboard yourself into our Slack by following JOIN.md in <path-to-scramble>.";
    expect(readme).toContain(cta);
    // One sentence, and no machine path: the walkthrough belongs in the document
    // the line points at, where the agent can ask the person its two questions.
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
    expect(readme).toContain("no supported-vendor list");
  });

  test("points the Slack setup at the self-onboarding script", () => {
    expect(readme).toContain("scripts/onboard-agent.ts");
    expect(readme).toContain("users:read");
  });

  test("documents cross-machine setup of SCRAMBLE_URL and the token", () => {
    expect(readme).toContain("SCRAMBLE_URL");
    expect(readme).toContain("SCRAMBLE_TOKEN");
    expect(readme).toContain("ssh -L");
  });

  test("describes the .scramble/ workspace layout", () => {
    expect(readme).toContain("persona.md");
    expect(readme).toContain("config.json");
    expect(readme).toContain("knowledge/");
  });
});

describe("the app manifest the onboarding script builds", () => {
  test("declares every scope a feature needs", () => {
    // No chat:write.customize: one app per agent means each agent is a real
    // Slack user, so an identity that is only a display name has no purpose.
    for (const scope of [
      "chat:write",
      "channels:history",
      "groups:history",
      "im:history",
      "im:write",
      "users:read",
      "channels:read",
      "files:read",
      "files:write",
      "assistant:write",
    ]) {
      expect(onboard).toContain(scope);
    }
    expect(onboard).not.toContain("chat:write.customize");
    // No channels:join either: an app cannot add itself to a Slack conversation,
    // public or private, so a member invites it and the scope buys nothing.
    expect(onboard).not.toContain("channels:join");
  });

  test("subscribes the three bot events, one per conversation kind", () => {
    expect(onboard).toContain("message.channels");
    expect(onboard).toContain("message.groups");
    expect(onboard).toContain("message.im");
  });

  test("enables socket mode and creates a WORKSPACE app", () => {
    expect(onboard).toContain("socket_mode_enabled: true");
    expect(onboard).toContain("org_deploy_enabled: false");
  });

  test("refuses an enterprise id, which is what needs an administrator", () => {
    expect(onboard).toContain("is an ENTERPRISE id");
    expect(onboard).toContain("team_id");
  });
});