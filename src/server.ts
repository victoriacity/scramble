// `src/server.ts` provides the HTTP interface over the store.
import { DEFAULTS, type Attachment, type Message, type PostResult, type ServerOptions } from "./types";
import type { ChannelStore } from "./store";

/**
 *  The `serve()` function merges server-only settings for hostname and port onto
 *  the shared options. The function accepts typed fields only. The CLI parses the
 *  `--bind` string and passes a concrete hostname and/or port to `serve()`, so
 *  there is exactly one interpretation site.
 */
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

export function createHandler(store: ChannelStore, opts: ServerOptions = {}) {
  const maxChars = opts.maxChars ?? DEFAULTS.maxChars;
  const ratePerMin = opts.ratePerMin ?? DEFAULTS.ratePerMin;
  const repeatWindowMs = opts.repeatWindowMs ?? DEFAULTS.repeatWindowMs;
  const requireAuth = opts.token !== undefined;

  // The guard maintains its internal bookkeeping. The `joined` set records who
  // called POST /agents/:name, which means the caller joined as an agent. The guard
  // treats everyone else as a human and never rate-limits them, exactly as
  // DESIGN.md says.
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

  // The newline-delimited JSON stream sends a snapshot first, followed by the
  // live subscription.
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

  async function postChannel(channelSeg: string, req: Request): Promise<Response> {
    let body: { from?: string; text?: string; id?: string; lastSeen?: number; files?: Attachment[]; thread?: string };
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
    let channel: string;
    try {
      channel = decodeURIComponent(channelSeg);
    } catch {
      return json(400, { error: "invalid channel", channel: channelSeg });
    }
    let result: PostResult;
    try {
      result = store.post({
        channel,
        from,
        text,
        id,
        lastSeen: body.lastSeen,
        ...(body.files !== undefined && body.files.length > 0 ? { files: body.files } : {}),
        ...(body.thread !== undefined ? { thread: body.thread } : {}),
      });
    } catch {
      return json(400, { error: "invalid channel", channel });
    }
    if (joined.has(from)) record(from, text);
    return json(200, { seq: result.seq, crossings: result.crossings });
  }

  function channelCatchUp(channelSeg: string, url: URL): Response {
    let channel: string;
    try {
      channel = decodeURIComponent(channelSeg);
    } catch {
      return json(400, { error: "invalid channel", channel: channelSeg });
    }
    try {
      return json(200, store.read(channel, sinceNum(url)));
    } catch {
      return json(400, { error: "invalid channel", channel });
    }
  }

  function channelStream(channelSeg: string, url: URL): Response {
    let channel: string;
    try {
      channel = decodeURIComponent(channelSeg);
    } catch {
      return json(400, { error: "invalid channel", channel: channelSeg });
    }
    const exclude = url.searchParams.get("exclude");
    let initial: Message[];
    try {
      initial = store.read(channel, sinceNum(url));
    } catch {
      return json(400, { error: "invalid channel", channel });
    }
    if (exclude !== null) initial = initial.filter((m) => m.from !== exclude);
    return new Response(
      lineStream(
        initial,
        (m) => m.channel === channel && (exclude === null || m.from !== exclude),
        JSON.stringify,
      ),
      { headers: { "content-type": "application/x-ndjson" } },
    );
  }

  function agentStream(name: string, url: URL): Response {
    const initial = store.readAll(sinceNum(url)).filter(
      (m) => m.from !== name && store.channelsFor(name).includes(m.channel),
    );
    const matches = (m: Message): boolean =>
      m.from !== name && store.channelsFor(name).includes(m.channel);
    return new Response(
      lineStream(initial, matches, (m) => JSON.stringify(store.deliveryFor(name, m))),
      { headers: { "content-type": "application/x-ndjson" } },
    );
  }

  /**
   *  The operation returns a finite snapshot of pending items for an agent at a
   *  cursor as an array, containing the same set that the agent stream would have
   *  delivered first. Because `message check` needs a bounded, non-blocking read, the
   *  store's client holds the per-agent cursor and asks for everything after it.
   */
  function agentPending(name: string, url: URL): Response {
    const msgs = store.readAll(sinceNum(url)).filter(
      (m) => m.from !== name && store.channelsFor(name).includes(m.channel),
    );
    return json(200, msgs.map((m) => store.deliveryFor(name, m)));
  }

  async function joinAgent(name: string, req: Request): Promise<Response> {
    let body: { persona?: string; channel?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json(400, { error: "invalid JSON" });
    }
    joined.add(name);
    try {
      store.join(name, body.persona ?? "", body.channel ?? "");
      return json(200, { name });
    } catch {
      return json(400, { error: "invalid channel", channel: body.channel });
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
      return json(404, { error: "not found" });
    }
    if (parts[0] === "agents") {
      if (parts.length === 1) {
        if (method === "GET") return json(200, store.agents());
        return json(405, { error: "method not allowed" });
      }
      if (parts.length === 2 && method === "POST") return joinAgent(parts[1]!, req);
      if (parts.length === 3 && parts[2] === "stream" && method === "GET")
        return agentStream(parts[1]!, url);
      if (parts.length === 3 && parts[2] === "pending" && method === "GET")
        return agentPending(parts[1]!, url);
      return json(404, { error: "not found" });
    }
    if (parts[0] === "channels") {
      if (parts.length === 1) {
        if (method === "GET") return json(200, store.channels());
        return json(405, { error: "method not allowed" });
      }
      if (parts.length === 2) {
        if (method === "POST") return postChannel(parts[1]!, req);
        if (method === "GET") return channelCatchUp(parts[1]!, url);
        return json(405, { error: "method not allowed" });
      }
      if (parts.length === 3 && parts[2] === "stream" && method === "GET")
        return channelStream(parts[1]!, url);
      return json(404, { error: "not found" });
    }
    return json(404, { error: "not found" });
  };
}

export function serve(store: ChannelStore, opts: ServeOptions = {}) {
  return Bun.serve({
    port: opts.port ?? DEFAULTS.port,
    hostname: opts.hostname ?? "127.0.0.1",
    fetch: createHandler(store, opts),
  });
}
