import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store";
import { createHandler } from "../src/server";

const webDir = join(process.cwd(), "web");
mkdirSync(webDir, { recursive: true });
const indexPath = join(webDir, "index.html");

function readPage(): string {
  return readFileSync(indexPath, "utf8");
}

function freshHandler() {
  const d = join(
    tmpdir(),
    `scramble-web-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(d, { recursive: true });
  const h = createHandler(createStore(d));
  return { h, dir: d };
}

async function seed(h: (req: Request) => Promise<Response>): Promise<void> {
  // Create a real room so room-scoped routes resolve to a non-empty room.
  await h(
    new Request("http://x/rooms/general", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "ana", text: "hi", id: "1" }),
    }),
  );
}

describe("web/index.html", () => {
  test("the page exists and is served by the handler at GET /", async () => {
    expect(existsSync(indexPath)).toBe(true);
    const html = readPage();
    expect(html).toContain("<title>scramble</title>");

    const { h } = freshHandler();
    const res = await h(new Request("http://x/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(html);
  });

  test("contains no external http(s) asset URL", () => {
    const html = readPage();
    expect(html).not.toMatch(/https?:\/\/[^\s"'<>]+/);
    // every src/href reference is relative or data — never absolute http(s)
    const refs = html.match(/\b(?:src|href)\s*=\s*["'][^"']+["']/g) ?? [];
    for (const ref of refs) {
      const url = ref.match(/["']([^"']+)["']/)![1]!;
      expect(url.startsWith("http://") || url.startsWith("https://")).toBe(false);
    }
  });

  test("every fetch route the page uses is answered by the handler", async () => {
    const html = readPage();
    // The page's script builds its requests from these route fragments:
    //   "/rooms"                          → GET /rooms (room list)
    //   "/rooms/" + room + "?since=0"     → GET /rooms/:room (catch-up)
    //   "/rooms/" + room + "/stream?since=0" → GET /rooms/:room/stream (live)
    //   "/rooms/" + room + POST           → POST /rooms/:room (send)
    expect(html).toContain('fetch("/rooms")');
    expect(html).toContain('"/rooms/" + encodeURIComponent');
    expect(html).toContain('?since=0"');
    expect(html).toContain('"/rooms/" + encodeURIComponent(room)');
    expect(html).toContain('method: "POST"');

    const { h } = freshHandler();
    await seed(h);

    // room list answers, not 404
    const roomsRes = await h(new Request("http://x/rooms"));
    expect(roomsRes.status).toBe(200);
    const rooms = (await roomsRes.json()) as string[];
    expect(rooms).toContain("general");

    // catch-up history answers for the room the page would select
    const histRes = await h(new Request("http://x/rooms/general?since=0"));
    expect(histRes.status).toBe(200);
    expect((await histRes.json()) as unknown[]).toHaveLength(1);

    // live stream answers
    const streamRes = await h(new Request("http://x/rooms/general/stream?since=0"));
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("content-type")).toContain("ndjson");
    await streamRes.body!.cancel();

    // send answers
    const postRes = await h(
      new Request("http://x/rooms/general", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "bob", text: "hey", id: "2" }),
      }),
    );
    expect(postRes.status).toBe(200);
  });

  test("the page exposes the composer and name persistence hooks", () => {
    const html = readPage();
    expect(html).toContain('id="name"');
    expect(html).toContain('id="text"');
    expect(html).toContain('localStorage');
    expect(html).toContain('"scramble-name"');
    expect(html).toMatch(/prefers-color-scheme:\s*dark/);
  });
});