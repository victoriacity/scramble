// src/slack-transport.ts: the shared Slack wire types and the transport over
// the slack BACKEND. The bridge (src/slack.ts) is gone, so the types the
// socket-mode transport and the backend both need live here, next to the socket
// surface. Everything is on bun built-ins (fetch + an injected WebSocket), so
// tests use fakes and never touch the network. The binding of createSocket to
// bun's real WebSocket lives in src/bin.ts (the edge).

/** One outbound Slack chat.postMessage call. */
export interface SlackPostOptions {
  channel: string;
  text: string;
  /** per-agent bot token (the backend falls back to the config token). */
  token?: string;
  /** persona display name (chat:write.customize path). */
  username?: string;
  /** persona avatar. */
  icon_emoji?: string;
}

/** A Slack Event-API event as delivered by the socket-mode transport. */
export interface SlackEvent {
  type?: string;
  subtype?: string;
  text?: string;
  channel?: string;
  user?: string;
  bot_id?: string;
}

/** The injected Slack seam: connect wires the event stream, postMessage sends. */
export interface SlackTransport {
  connect(onEvent: (ev: SlackEvent) => void): void;
  postMessage(opts: SlackPostOptions): Promise<void>;
}

/** The tiny socket surface the transport drives. src/bin.ts adapts bun's
 *  WebSocket onto it; tests pass a fake. */
export interface SlackSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: ((code?: number, reason?: string) => void) | null;
  onerror: (() => void) | null;
}

export interface SlackTransportDeps {
  /** app-level token (xapp-) with connections:write, for apps.connections.open. */
  appToken: string;
  /** main bot token (xoxb-) used as the persona-tier postMessage fallback. */
  botToken?: string;
  /** injected fetch; tests stub it. */
  fetch(input: string, init?: RequestInit): Promise<Response>;
  /** injected socket factory; tests stub it. */
  createSocket(url: string): SlackSocket;
  /** injectable wait so the reconnect backoff needs no real delay in tests. */
  sleep(ms: number): Promise<void>;
}

const CONNECT_URL = "https://slack.com/api/apps.connections.open";
const POST_URL = "https://slack.com/api/chat.postMessage";
const INITIAL_BACKOFF = 1_000;
const MAX_BACKOFF = 30_000;

/** A socket-mode envelope. Slack redelivers any envelope you do not ACK, so
 *  the transport replies with the envelope_id for every frame that has one. */
interface Frame {
  type?: string;
  envelope_id?: string;
  payload?: { event?: SlackEvent };
}

export function createSlackTransport(deps: SlackTransportDeps): SlackTransport {
  let socket: SlackSocket | null = null;
  let backoff = INITIAL_BACKOFF;

  function nextBackoff(): number {
    const d = backoff;
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
    return d;
  }

  function send(obj: unknown): void {
    socket?.send(JSON.stringify(obj));
  }

  function handleFrame(raw: string, onEvent: (ev: SlackEvent) => void): void {
    let env: Frame;
    try {
      env = JSON.parse(raw) as Frame;
    } catch {
      return;
    }
    if (env.type === "disconnect") {
      // A server-initiated disconnect: close cleanly; onclose schedules the
      // reconnect so the client comes back before Slack stops delivering.
      socket?.close(1000, "disconnect");
      return;
    }
    if (env.envelope_id !== undefined) send({ envelope_id: env.envelope_id });
    if (env.type === "events_api" && env.payload?.event) {
      onEvent(env.payload.event);
    }
  }

  async function openLoop(onEvent: (ev: SlackEvent) => void): Promise<void> {
    let url: string;
    try {
      const res = await deps.fetch(CONNECT_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${deps.appToken}` },
      });
      const data = (await res.json()) as { ok?: boolean; url?: string };
      if (data.ok !== true || typeof data.url !== "string") {
        scheduleRetry(onEvent);
        return;
      }
      url = data.url;
    } catch {
      scheduleRetry(onEvent);
      return;
    }
    const sock = deps.createSocket(url);
    socket = sock;
    sock.onopen = () => {
      backoff = INITIAL_BACKOFF;
    };
    sock.onmessage = (raw) => handleFrame(raw, onEvent);
    sock.onclose = () => {
      socket = null;
      scheduleRetry(onEvent);
    };
  }

  function scheduleRetry(onEvent: (ev: SlackEvent) => void): void {
    const delay = nextBackoff();
    void deps.sleep(delay).then(() => {
      void openLoop(onEvent);
    });
  }

  return {
    connect(onEvent) {
      void openLoop(onEvent);
    },
    async postMessage(opts: SlackPostOptions): Promise<void> {
      const payload: Record<string, string> = { channel: opts.channel, text: opts.text };
      if (opts.username) payload.username = opts.username;
      if (opts.icon_emoji) payload.icon_emoji = opts.icon_emoji;
      const token = opts.token ?? deps.botToken ?? "";
      const res = await deps.fetch(POST_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      // Slack signals failure with HTTP 200 + {"ok":false,"error":...}. A
      // reader of that body has to surface it as the failure it is.
      if (data.ok !== true) {
        throw new Error(data.error ?? "Slack postMessage failed");
      }
    },
  };
}