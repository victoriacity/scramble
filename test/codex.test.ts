import { describe, expect, test } from "bun:test";
import {
  createDriver,
  parseCodex,
  type CodexConfig,
  type Spawn,
  type SpawnResult,
} from "../src/codex";
import type { Delivery, PostResult } from "../src/types";

function delivery(room: string, text: string, from = "ana"): Delivery {
  return { seq: 1, ts: "", room, from, text, id: "x", mentions: [], mentioned: true };
}

async function* gen<T>(items: T[]): AsyncGenerator<T> {
  for (const it of items) yield* [it];
}

const assistantMsg = (session: string | undefined, text: string): string =>
  JSON.stringify({
    type: "response_item",
    payload: { message: { role: "assistant", session, content: [{ type: "output_text", text }] } },
  });

function makePost(posts: Array<{ room: string; text: string }>) {
  return async (room: string, text: string): Promise<PostResult> => {
    posts.push({ room, text });
    return { seq: posts.length, crossings: [] };
  };
}

describe("parseCodex", () => {
  test("extracts session id and the LAST assistant message text", () => {
    const stdout = [
      "not json",
      "",
      '{"type":"event","payload":{"id":"other"}}',
      JSON.stringify({ type: "response_item", payload: { message: { role: "user", content: [{ type: "input_text", text: "hi" }] } } }),
      JSON.stringify({ type: "response_item", payload: { id: "no-payload-message" } }),
      assistantMsg("sess_first", "first answer"),
      assistantMsg(undefined, ""),
      assistantMsg("sess_final", "final reply"),
    ].join("\n");
    const parsed = parseCodex(stdout);
    expect(parsed.sessionId).toBe("sess_final");
    expect(parsed.text).toBe("final reply");
  });

  test("returns empty text when nothing is an assistant message", () => {
    expect(parseCodex("garbage\n")).toEqual({ text: "" });
  });
});

describe("createDriver", () => {
  test("bootstrap: first message runs plain codex exec and posts the reply", async () => {
    const posts: Array<{ room: string; text: string }> = [];
    const cfg: CodexConfig = {
      name: "codie",
      stream: () => gen([delivery("general", "hello")]),
      post: makePost(posts),
    };
    const spawn: Spawn = (argv) => make({ stdout: assistantMsg("sess_boot", "hello world"), exitCode: 0 });
    await createDriver(cfg, spawn).done;
    expect(posts).toEqual([{ room: "general", text: "hello world" }]);
  });

  test("resume: the resolved session id is passed to subsequent execs", async () => {
    const calls: Array<{ argv: string[]; prompt: string }> = [];
    const posts: Array<{ room: string; text: string }> = [];
    const spawn: Spawn = (argv, prompt) => {
      calls.push({ argv, prompt });
      // bootstrap resolves a session id; the resumed exec inherits it (no new one)
      const session = argv.includes("resume") ? null : "sess_resolved";
      return make({ stdout: assistantMsg(session, `reply to "${prompt}"`), exitCode: 0 });
    };
    const cfg: CodexConfig = {
      name: "codie",
      stream: () => gen([delivery("g", "a"), delivery("g", "b")]),
      post: makePost(posts),
    };
    await createDriver(cfg, spawn).done;
    expect(calls[0]!.argv).toEqual(["exec", "--json"]);
    expect(calls[1]!.argv).toEqual(["exec", "resume", "sess_resolved", "--json"]);
    expect(posts.map((p) => p.text)).toEqual(["reply to \"a\"", "reply to \"b\""]);
  });

  test("serialization: a turn finishes before the next starts", async () => {
    const posts: Array<{ room: string; text: string }> = [];
    const spawnCalls: Array<{ argv: string[]; prompt: string }> = [];
    const releases: Array<(r: SpawnResult) => void> = [];
    const spawn: Spawn = (argv, prompt) => {
      spawnCalls.push({ argv, prompt });
      return new Promise<SpawnResult>((res) => releases.push(res));
    };
    const cfg: CodexConfig = {
      name: "codie",
      stream: () => gen([delivery("g", "one"), delivery("g", "two")]),
      post: makePost(posts),
    };
    const drv = createDriver(cfg, spawn);
    // exactly one turn in flight for the session; the second waits
    for (let i = 0; i < 5 && spawnCalls.length < 1; i++) await settle();
    expect(spawnCalls.length).toBe(1);
    releases.shift()!({ stdout: assistantMsg(null, "reply one"), exitCode: 0 });
    await settle();
    expect(spawnCalls.length).toBe(2);
    releases.shift()!({ stdout: assistantMsg(null, "reply two"), exitCode: 0 });
    await drv.done;
    expect(posts.map((p) => p.text)).toEqual(["reply one", "reply two"]);
  });

  test("failure path: a non-zero exit posts an error line and keeps delivering", async () => {
    const posts: Array<{ room: string; text: string }> = [];
    const spawn: Spawn = (argv) => make({ stdout: "", exitCode: 7 });
    const cfg: CodexConfig = {
      name: "codie",
      stream: () => gen([delivery("g", "boom")]),
      post: makePost(posts),
    };
    await createDriver(cfg, spawn).done;
    expect(posts).toEqual([{ room: "g", text: "error: codex exec failed (exit 7)" }]);
  });

  test("unparseable output posts an error and is never swallowed", async () => {
    const posts: Array<{ room: string; text: string }> = [];
    const spawn: Spawn = () => make({ stdout: "not json", exitCode: 0 });
    const cfg: CodexConfig = {
      name: "codie",
      stream: () => gen([delivery("g", "nope")]),
      post: makePost(posts),
    };
    await createDriver(cfg, spawn).done;
    expect(posts).toEqual([{ room: "g", text: "error: codex exec returned no assistant message" }]);
  });
});

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

function make(r: SpawnResult): SpawnResult {
  return { stdout: r.stdout, exitCode: r.exitCode };
}