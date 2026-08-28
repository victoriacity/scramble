// The file `src/slack-transport.ts` contains the shared Slack wire types and the
// transport over the Slack backend. Because the bridge (`src/slack.ts`) is gone,
// the types that the socket-mode transport and the backend both need live here,
// next to the socket surface. The code relies on Bun built-ins (`fetch` and an
// injected `WebSocket`), so tests use fakes and never touch the network. The
// binding of `createSocket` to Bun's real `WebSocket` lives in `src/bin.ts` at the
// edge.

/**
 *  The system makes one outbound `chat.postMessage` call to Slack.
 */
export interface SlackPostOptions {
  channel: string;
  text: string;
  /**
   *  Each agent can specify a bot token, and the backend falls back to the config
   *  token.
   */
  token?: string;
  /**
   *  The `chat:write.customize` path sets the persona display name.
   */
  username?: string;
  /**
   *  The persona has an avatar.
   */
  icon_emoji?: string;
}

/**
 *  The socket-mode transport delivers this Slack Event-API event.
 */
export interface SlackEvent {
  type?: string;
  subtype?: string;
  text?: string;
  channel?: string;
  user?: string;
  bot_id?: string;
}

/**
 *  The injected Slack interface uses `connect` to wire the event stream and
 *  `postMessage` to send messages.
 */
export interface SlackTransport {
  connect(onEvent: (ev: SlackEvent) => void): void;
  postMessage(opts: SlackPostOptions): Promise<void>;
}

/**
 *  The transport drives this minimal socket interface. `src/bin.ts` adapts Bun's
 *  WebSocket onto it, and tests pass a mock socket.
 */
export interface SlackSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: ((code?: number, reason?: string) => void) | null;
  onerror: (() => void) | null;
}

export interface SlackTransportDeps {
  /**
   *  The `apps.connections.open` method requires an app-level token (`xapp-`) with the
   *  `connections:write` scope.
   */
  appToken: string;
  /**
   *  The system uses the main bot token (`xoxb-`) as the fallback for persona-tier
   *  `postMessage` calls.
   */
  botToken?: string;
  /**
   *  The system injects `fetch`, and the tests stub it.
   */
  fetch(input: string, init?: RequestInit): Promise<Response>;
  /**
   *  The socket factory is injected, and tests stub it.
   */
  createSocket(url: string): SlackSocket;
  /**
   *  The wait function is injectable, so the reconnect backoff needs no real delay
   *  in tests.
   */
  sleep(ms: number): Promise<void>;
}

const CONNECT_URL = "https://slack.com/api/apps.connections.open";
const POST_URL = "https://slack.com/api/chat.postMessage";
const INITIAL_BACKOFF = 1_000;
const MAX_BACKOFF = 30_000;

/**
 *  Slack redelivers any socket-mode envelope that you do not acknowledge, so the
 *  transport replies with the `envelope_id` for every frame that contains one.
 */
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
      // When the server initiates a disconnect, the client closes cleanly. The onclose
      // handler schedules the reconnect so the client comes back before Slack stops
      // delivering.
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
      // Slack signals failure by returning an HTTP 200 status code with
      // {"ok":false,"error":...} in the body. The client reading that body must surface
      // it as a failure.
      if (data.ok !== true) {
        throw new Error(data.error ?? "Slack postMessage failed");
      }
    },
  };
}
