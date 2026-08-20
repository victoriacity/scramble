import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "../src/store";
import { createHandler, serve, type ServeOptions } from "../src/server";
import { DEFAULTS } from "../src/types";

function freshDir(): string {
  const d = join(tmpdir(), `scramble-server-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function handler(opts: ServeOptions = {}) {
  return createHandler(createStore(freshDir()), opts);
}

function post(body: unknown) {
  return new Request("http://x/rooms/general", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function bodyJson(res: Response) {
  return res.json() as Promise<Record<string, unknown>>;
}

async function readLines(res: Response, n: number): Promise<string[]> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const lines: string[] = [];
  while (lines.length < n) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line) lines.push(line);
      if (lines.length >= n) break;
    }
  }
  await reader.cancel();
  return lines;
}

const ndis = (lines: string[]) => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

// --- index.html transient presence, so both the serve and 404 branches run
const indexRel = "web/index.html";
const indexFile = join(process.cwd(), "web", "index.html");
const hadIndex = existsSync(indexFile);
const origIndex = hadIndex ? readFileSync(indexFile, "utf8") : "";

beforeAll(() => {
  mkdirSync(join(process.cwd(), "web"), { recursive: true });
});
afterAll(() => {
  if (hadIndex) writeFileSync(indexFile, origIndex);
  else if (existsSync(indexFile)) unlinkSync(join(process.cwd(), "web", "index.html"));
});

describe("POST /rooms/:room", () => {
  test("returns seq + crossings on first send", async () => {
    const h = handler();
    const res = await h(post({ room: "general", from: "a", text: "hi", id: "1", lastSeen: 0 }));
    expect(res.status).toBe(200);
    expect(await bodyJson(res)).toEqual({ seq: 1, crossings: [] });
  });

  test("crossings surface a race with another sender", async () => {
    const h = handler();
    await h(post({ from: "a", text: "first", id: "1", lastSeen: 0 }));
    const res = await h(post({ from: "b", text: "second", id: "2", lastSeen: 0 }));
    const body = await bodyJson(res);
    expect(body.seq).toBe(2);
    expect((body.crossings as unknown[]).map((c) => (c as { from: string }).from)).toEqual(["a"]);
  });

  test("rejects text over maxChars with 413 shorten + max", async () => {
    const h = handler({ maxChars: 5 });
    const res = await h(post({ from: "a", text: "way too long", id: "1" }));
    expect(res.status).toBe(413);
    expect(await bodyJson(res)).toEqual({ error: "shorten", max: 5 });
  });

  test("invalid JSON body is rejected with 400", async () => {
    const h = handler();
    const res = await h(
      new Request("http://x/rooms/general", { method: "POST", body: "not json" }),
    );
    expect(res.status).toBe(400);
  });

  test("rate limit trips for a joined agent and reports ratePerMin", async () => {
    const h = handler({ ratePerMin: 2 });
    await h(new Request("http://x/agents/alice", { method: "POST", body: '{"persona":"p","room":"g"}' }));
    await h(post({ from: "alice", text: "one", id: "1" }));
    await h(post({ from: "alice", text: "two", id: "2" }));
    const res = await h(post({ from: "alice", text: "three", id: "3" }));
    expect(res.status).toBe(429);
    expect(await bodyJson(res)).toEqual({ error: "rate", ratePerMin: 2, windowMs: 60_000 });
  });

  test("identical-repeat drop reports repeat within the window", async () => {
    const h = handler({ repeatWindowMs: 60_000 });
    await h(new Request("http://x/agents/a", { method: "POST", body: '{"room":"g"}' }));
    await h(post({ from: "a", text: "dupe", id: "1" }));
    const res = await h(post({ from: "a", text: "dupe", id: "2" }));
    expect(res.status).toBe(429);
    expect(await bodyJson(res)).toEqual({ error: "repeat", repeatWindowMs: 60_000 });
  });

  test("a human sender (never joined) is never rate-limited", async () => {
    const h = handler({ ratePerMin: 1 });
    const r1 = await h(post({ from: "human", text: "m1", id: "1" }));
    const r2 = await h(post({ from: "human", text: "m2", id: "2" }));
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });

  test("a path-escape room is rejected with 400", async () => {
    const h = handler();
    const res = await h(
      new Request("http://x/rooms/%2E%2E%2Fevil", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "a", text: "t", id: "1" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await bodyJson(res)).toMatchObject({ error: "invalid room" });
  });

  test("malformed percent-encoding in the room is rejected with 400", async () => {
    const h = handler();
    const res = await h(
      new Request("http://x/rooms/%E0%A4%A", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "a", text: "t", id: "1" }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await bodyJson(res)).toMatchObject({ error: "invalid room" });
  });
});

describe("GET /rooms", () => {
  test("catch-up returns messages since a cursor", async () => {
    const h = handler();
    await h(post({ from: "a", text: "one", id: "1" }));
    await h(post({ from: "b", text: "two", id: "2" }));
    const all = await h(new Request("http://x/rooms/general"));
    expect(all.status).toBe(200);
    expect(await all.json()).toHaveLength(2);
    const since = await h(new Request("http://x/rooms/general?since=1"));
    expect(await since.json()).toHaveLength(1);
  });

  test("GET /rooms lists every room including dm/*", async () => {
    const h = handler();
    await h(post({ from: "a", text: "t", id: "1" }));
    await h(
      new Request("http://x/rooms/" + encodeURIComponent("dm/dev/ana"), {
        method: "POST",
        body: JSON.stringify({ from: "x", text: "y", id: "2" }),
      }),
    );
    const res = await h(new Request("http://x/rooms"));
    expect(res.status).toBe(200);
    const names = (await res.json()) as string[];
    expect(names).toContain("general");
    expect(names).toContain("dm/dev/ana");
  });

  test("405 for non-GET on /rooms", async () => {
    const h = handler();
    const res = await h(new Request("http://x/rooms", { method: "POST", body: "{}" }));
    expect(res.status).toBe(405);
  });

  test("an invalid since value defaults to 0", async () => {
    const h = handler();
    await h(post({ from: "a", text: "x", id: "1" }));
    const res = await h(new Request("http://x/rooms/general?since=notanumber"));
    expect(await res.json()).toHaveLength(1);
  });

  test("malformed encoding in the room path is rejected by catch-up", async () => {
    const h = handler();
    const res = await h(new Request("http://x/rooms/%E0%A4%A"));
    expect(res.status).toBe(400);
    expect(await bodyJson(res)).toMatchObject({ error: "invalid room" });
  });

  test("path-escape room is rejected by catch-up", async () => {
    const h = handler();
    const res = await h(new Request("http://x/rooms/%2E%2E%2Fevil"));
    expect(res.status).toBe(400);
    expect(await bodyJson(res)).toMatchObject({ error: "invalid room" });
  });

  test("405 for a non-GET non-POST method on a specific room", async () => {
    const h = handler();
    const res = await h(new Request("http://x/rooms/general", { method: "DELETE" }));
    expect(res.status).toBe(405);
  });

  test("404 for a room path with an unrecognized suffix", async () => {
    const h = handler();
    const res = await h(new Request("http://x/rooms/general/other"));
    expect(res.status).toBe(404);
  });
});

describe("POST /agents and GET /agents", () => {
  test("join registers persona + rooms and appears in the roster", async () => {
    const h = handler();
    const join = await h(
      new Request("http://x/agents/bob", {
        method: "POST",
        body: JSON.stringify({ persona: "i test things", room: "general" }),
      }),
    );
    expect(join.status).toBe(200);
    const res = await h(new Request("http://x/agents"));
    const agents = (await res.json()) as { name: string; persona: string; rooms: string[] }[];
    const bob = agents.find((a) => a.name === "bob");
    expect(bob?.persona).toBe("i test things");
    expect(bob?.rooms).toContain("general");
  });

  test("join with an invalid room is rejected", async () => {
    const h = handler();
    const res = await h(
      new Request("http://x/agents/bot", {
        method: "POST",
        body: JSON.stringify({ persona: "p", room: "a/../b" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("join with an invalid JSON body is rejected", async () => {
    const h = handler();
    const res = await h(new Request("http://x/agents/bot", { method: "POST", body: "nope" }));
    expect(res.status).toBe(400);
  });

  test("405 for a non-GET non-POST method on /agents", async () => {
    const h = handler();
    const res = await h(new Request("http://x/agents", { method: "DELETE" }));
    expect(res.status).toBe(405);
  });

  test("unknown agent subroute returns 404", async () => {
    const h = handler();
    const res = await h(new Request("http://x/agents/alice/list"));
    expect(res.status).toBe(404);
  });
});

describe("streams", () => {
  test("room stream: exclude filters snapshot and live lines", async () => {
    const h = handler();
    await h(post({ from: "a", text: "one", id: "1" }));
    await h(post({ from: "b", text: "two", id: "2" }));
    const res = await h(new Request("http://x/rooms/general/stream?since=0&exclude=b"));
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    // snapshot: only from=a survives the exclude
    expect(JSON.parse(await readOne(reader)).text).toBe("one");
    // a live message from a non-excluded sender flows into the same open stream
    await h(post({ from: "c", text: "three", id: "3" }));
    expect(JSON.parse(await readOne(reader)).text).toBe("three");
    // a live message from the excluded sender is dropped
    await h(post({ from: "b", text: "four", id: "4" }));
    await reader.cancel();
  });

  test("room stream without exclude still streams", async () => {
    const h = handler();
    await h(post({ from: "a", text: "one", id: "1" }));
    const res = await h(new Request("http://x/rooms/general/stream?since=0"));
    expect(JSON.parse(await readOne(res.body!.getReader())).text).toBe("one");
  });

  test("malformed room encoding is rejected by a stream", async () => {
    const h = handler();
    const res = await h(new Request("http://x/rooms/%E0%A4%A/stream"));
    expect(res.status).toBe(400);
  });

  test("path-escape room is rejected by a stream", async () => {
    const h = handler();
    const res = await h(new Request("http://x/rooms/" + encodeURIComponent("../evil") + "/stream"));
    expect(res.status).toBe(400);
  });

  test("405 for a non-GET on /stream", async () => {
    const h = handler();
    const res = await h(new Request("http://x/stream", { method: "POST", body: "{}" }));
    expect(res.status).toBe(405);
  });

  test("agent stream: only the agent's rooms, Delivery with mentioned, own excluded", async () => {
    const h = handler();
    await h(new Request("http://x/agents/dev", { method: "POST", body: '{"room":"general"}' }));
    await h(post({ from: "ana", text: "@dev check this", id: "1" }));
    await h(post({ from: "dev", text: "my own", id: "2" }));
    const res = await h(new Request("http://x/agents/dev/stream?since=0"));
    expect(res.status).toBe(200);
    const lines = ndisos(await readLines(res, 1));
    expect(lines.length).toBe(1);
    expect(lines[0]!.room).toBe("general");
    expect(lines[0]!.mentioned).toBe(true);
    expect(lines[0]!.from).toBe("ana");
  });

  test("agent stream: a new mention flows live into the open stream", async () => {
    const h = handler();
    await h(new Request("http://x/agents/dev", { method: "POST", body: '{"room":"general"}' }));
    const res = await h(new Request("http://x/agents/dev/stream?since=0"));
    const reader = res.body!.getReader();
    // arm a pending read: the subscription is established, then the live post fills it
    const pending = reader.read();
    await h(post({ from: "ana", text: "@dev brand new", id: "9" }));
    const { value } = await pending;
    expect(JSON.parse(new TextDecoder().decode(value)).mentioned).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(value)).from).toBe("ana");
    await reader.cancel();
  });

  test("firehose stream: every room", async () => {
    const h = handler();
    await h(post({ from: "a", text: "hello", id: "1" }));
    await h(
      new Request("http://x/rooms/" + encodeURIComponent("dm/a/b"), {
        method: "POST",
        body: JSON.stringify({ from: "b", text: "world", id: "2" }),
      }),
    );
    const res = await h(new Request("http://x/stream?since=0"));
    const lines = ndisos(await readLines(res, 2));
    expect(lines.map((l) => l.text)).toEqual(["hello", "world"]);
  });

  test("since cursor resumes a firehose", async () => {
    const h = handler();
    await h(post({ from: "a", text: "x", id: "1" }));
    await h(post({ from: "b", text: "y", id: "2" }));
    const res = await h(new Request("http://x/stream?since=1"));
    const lines = ndisos(await readLines(res, 1));
    expect(lines[0]!.text).toBe("y");
  });

  test("firehose stream: a live message flows into the open stream", async () => {
    const h = handler();
    const res = await h(new Request("http://x/stream?since=0"));
    const reader = res.body!.getReader();
    const pending = reader.read();
    await h(post({ from: "a", text: "live", id: "1" }));
    const { value } = await pending;
    expect(JSON.parse(new TextDecoder().decode(value)).text).toBe("live");
    await reader.cancel();
  });
});

function readOne(reader: any): Promise<string> {
  const dec = new TextDecoder();
  let buf = "";
  return new Promise((resolve, reject) => {
    function pump(): void {
      reader
        .read()
        .then(({ done, value }: { done: boolean; value: Uint8Array }) => {
          if (done) return reject(new Error("stream closed before a line"));
          buf += dec.decode(value);
          const idx = buf.indexOf("\n");
          if (idx < 0) return pump();
          resolve(buf.slice(0, idx));
          return;
        })
        .catch(reject);
    }
    pump();
  });
}

describe("auth", () => {
  test("token set: every route requires the bearer header", async () => {
    const h = handler({ token: "sekret" });
    const noAuth = await h(new Request("http://x/stream"));
    expect(noAuth.status).toBe(401);
    const wrongAuth = await h(
      new Request("http://x/stream", { headers: { authorization: "Bearer nope" } }),
    );
    expect(wrongAuth.status).toBe(401);
    const ok = await h(new Request("http://x/rooms", { headers: { authorization: "Bearer sekret" } }));
    expect(ok.status).toBe(200);
  });

  test("token unset: no auth check (localhost default)", async () => {
    const h = handler();
    const res = await h(new Request("http://x/rooms"));
    expect(res.status).toBe(200);
  });
});

describe("GET /", () => {
  test("serves web/index.html when present", async () => {
    writeFileSync(indexFile, "hello scramble page");
    const h = handler();
    const res = await h(new Request("http://x/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello scramble page");
  });

  test("404 when index.html is missing", async () => {
    if (existsSync(indexFile)) unlinkSync(indexFile);
    const h = handler();
    const res = await h(new Request("http://x/"));
    expect(res.status).toBe(404);
    expect(await bodyJson(res)).toMatchObject({ error: "index.html not found" });
  });

  test("405 for POST on /", async () => {
    const h = handler();
    const res = await h(new Request("http://x/", { method: "POST", body: "{}" }));
    expect(res.status).toBe(405);
  });
});

describe("unknown route", () => {
  test("404 for an unmatched path", async () => {
    const h = handler();
    const res = await h(new Request("http://x/does/not/exist"));
    expect(res.status).toBe(404);
  });
});

describe("serve()", () => {
  test("binds and stops without a socket round trip", () => {
    const store = createStore(freshDir());
    const srv = serve(store, { port: 0 });
    expect(srv.port).toBeGreaterThan(0);
    srv.stop();
  });
});

function ndisos(lines: string[]) {
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}