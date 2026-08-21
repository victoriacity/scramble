// src/server.ts — the HTTP surface over the store.
import { DEFAULTS, type Message, type PostResult, type ServerOptions } from "./types";
import type { RoomStore } from "./store";

/** serve() merges the server-only knobs (hostname/port) onto the shared ones.
 *  Typed fields only: the CLI owns --bind string parsing and hands serve() a
 *  concrete hostname and/or port, so there is exactly one interpretation site. */
export interface ServeOptions extends ServerOptions {
  port?: number;
  hostname?: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sinceNum(url: URL): number {
  const raw = url.searchParams.get("since");
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function createHandler(store: RoomStore, opts: ServerOptions = {}) {
  const maxChars = opts.maxChars ?? DEFAULTS.maxChars;
  const ratePerMin = opts.ratePerMin ?? DEFAULTS.ratePerMin;
  const repeatWindowMs = opts.repeatWindowMs ?? DEFAULTS.repeatWindowMs;
  const requireAuth = opts.token !== undefined;

  // Guard bookkeeping. `joined` records who went through POST /agents/:name —
  // "joined as an agent". Everyone else is treated as a human and never
  // rate-limited, exactly as DESIGN.md says.
  const joined = new Set<string>();
  const rates = new Map<string, { times: number[]; lastText: string; lastTs: number }>();
  const encoder = new TextEncoder();

  function guard(sender: string, text: string): Response | null {
    const now = Date.now();
    const rec = rates.get(sender);
    if (rec && rec.lastText === text && now - rec.lastTs < repeatWindowMs) {
      return json(429, { error: "repeat", repeatWindowMs });
    }
    if (!rec) {
      rates.set(sender, { times: [], lastText: "", lastTs: 0 });
    }
    const times = (rates.get(sender) as { times: number[] }).times.filter(
      (t) => now - t < 60_000,
    );
    rates.get(sender)!.times = times;
    if (times.length >= ratePerMin) {
      return json(429, { error: "rate", ratePerMin, windowMs: 60_000 });
    }
    return null;
  }

  function record(sender: string, text: string): void {
    const now = Date.now();
    const rec = rates.get(sender)!;
    rec.times.push(now);
    rec.lastText = text;
    rec.lastTs = now;
  }

  // A newline-delimited JSON stream: snapshot first, then live subscription.
  function lineStream(
    initial: Message[],
    matches: (m: Message) => boolean,
    toLine: (m: Message) => string,
  ): ReadableStream<Uint8Array> {
    let unsubscribe: (() => void) | undefined;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const m of initial) controller.enqueue(encoder.encode(toLine(m) + "\n"));
        unsubscribe = store.subscribe((m) => {
          if (matches(m)) controller.enqueue(encoder.encode(toLine(m) + "\n"));
        });
      },
      cancel() {
        unsubscribe?.();
      },
    });
  }

  async function index(): Promise<Response> {
    const file = Bun.file("web/index.html");
    if (await file.exists()) return new Response(file);
    return json(404, { error: "index.html not found" });
  }

  async function postRoom(roomSeg: string, req: Request): Promise<Response> {
    let body: { from?: string; text?: string; id?: string; lastSeen?: number };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json(400, { error: "invalid JSON" });
    }
    const from = body.from ?? "";
    const text = body.text ?? "";
    const id = body.id ?? "";
    if (text.length > maxChars) return json(413, { error: "shorten", max: maxChars });
    if (joined.has(from)) {
      const rejected = guard(from, text);
      if (rejected) return rejected;
    }
    let room: string;
    try {
      room = decodeURIComponent(roomSeg);
    } catch {
      return json(400, { error: "invalid room", room: roomSeg });
    }
    let result: PostResult;
    try {
      result = store.post({ room, from, text, id, lastSeen: body.lastSeen });
    } catch {
      return json(400, { error: "invalid room", room });
    }
    if (joined.has(from)) record(from, text);
    return json(200, { seq: result.seq, crossings: result.crossings });
  }

  function roomCatchUp(roomSeg: string, url: URL): Response {
    let room: string;
    try {
      room = decodeURIComponent(roomSeg);
    } catch {
      return json(400, { error: "invalid room", room: roomSeg });
    }
    try {
      return json(200, store.read(room, sinceNum(url)));
    } catch {
      return json(400, { error: "invalid room", room });
    }
  }

  function roomStream(roomSeg: string, url: URL): Response {
    let room: string;
    try {
      room = decodeURIComponent(roomSeg);
    } catch {
      return json(400, { error: "invalid room", room: roomSeg });
    }
    const exclude = url.searchParams.get("exclude");
    let initial: Message[];
    try {
      initial = store.read(room, sinceNum(url));
    } catch {
      return json(400, { error: "invalid room", room });
    }
    if (exclude !== null) initial = initial.filter((m) => m.from !== exclude);
    return new Response(
      lineStream(
        initial,
        (m) => m.room === room && (exclude === null || m.from !== exclude),
        JSON.stringify,
      ),
      { headers: { "content-type": "application/x-ndjson" } },
    );
  }

  function agentStream(name: string, url: URL): Response {
    const initial = store.readAll(sinceNum(url)).filter(
      (m) => m.from !== name && store.roomsFor(name).includes(m.room),
    );
    const matches = (m: Message): boolean =>
      m.from !== name && store.roomsFor(name).includes(m.room);
    return new Response(
      lineStream(initial, matches, (m) => JSON.stringify(store.deliveryFor(name, m))),
      { headers: { "content-type": "application/x-ndjson" } },
    );
  }

  function firehose(url: URL): Response {
    return new Response(lineStream(store.readAll(sinceNum(url)), () => true, JSON.stringify), {
      headers: { "content-type": "application/x-ndjson" },
    });
  }

  async function joinAgent(name: string, req: Request): Promise<Response> {
    let body: { persona?: string; room?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json(400, { error: "invalid JSON" });
    }
    joined.add(name);
    try {
      store.join(name, body.persona ?? "", body.room ?? "");
      return json(200, { name });
    } catch {
      return json(400, { error: "invalid room", room: body.room });
    }
  }

  return async (req: Request): Promise<Response> => {
    if (requireAuth && req.headers.get("authorization") !== `Bearer ${opts.token}`) {
      return json(401, { error: "unauthorized" });
    }
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter((s) => s !== "");
    const method = req.method;

    if (parts.length === 0) {
      if (method === "GET") return index();
      return json(405, { error: "method not allowed" });
    }
    if (parts[0] === "stream" && parts.length === 1) {
      if (method === "GET") return firehose(url);
      return json(405, { error: "method not allowed" });
    }
    if (parts[0] === "agents") {
      if (parts.length === 1) {
        if (method === "GET") return json(200, store.agents());
        return json(405, { error: "method not allowed" });
      }
      if (parts.length === 2 && method === "POST") return joinAgent(parts[1]!, req);
      if (parts.length === 3 && parts[2] === "stream" && method === "GET")
        return agentStream(parts[1]!, url);
      return json(404, { error: "not found" });
    }
    // The current global seq. A bridge reads it once at startup and opens its
    // stream there, so a reconnect resumes rather than republishing the room.
    if (parts[0] === "seq" && parts.length === 1) {
      if (method === "GET") return json(200, { seq: store.tip() });
      return json(405, { error: "method not allowed" });
    }
    if (parts[0] === "rooms") {
      if (parts.length === 1) {
        if (method === "GET") return json(200, store.rooms());
        return json(405, { error: "method not allowed" });
      }
      if (parts.length === 2) {
        if (method === "POST") return postRoom(parts[1]!, req);
        if (method === "GET") return roomCatchUp(parts[1]!, url);
        return json(405, { error: "method not allowed" });
      }
      if (parts.length === 3 && parts[2] === "stream" && method === "GET")
        return roomStream(parts[1]!, url);
      return json(404, { error: "not found" });
    }
    return json(404, { error: "not found" });
  };
}

export function serve(store: RoomStore, opts: ServeOptions = {}) {
  return Bun.serve({
    port: opts.port ?? DEFAULTS.port,
    hostname: opts.hostname ?? "127.0.0.1",
    fetch: createHandler(store, opts),
  });
}