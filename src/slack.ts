// src/slack.ts — the Slack frontend bridge. All IO is injected: `transport` is
// the Slack seam (postMessage + connect), and `cfg` carries the daemon seams
// (post into a room, subscribe to the room firehose). Never imports a Slack SDK.
import { DM_PREFIX, type Message, type PostInput } from "./types";

/** One agent's Slack identity. A per-agent `botToken` promotes the agent to a
 *  real bot user (posts with its own token); otherwise the agent posts through
 *  the single app under its `username` + `iconEmoji` (chat:write.customize). */
export interface AgentSlack {
  username: string;
  botToken?: string;
  botId?: string;
  iconEmoji?: string;
}

export interface SlackConfig {
  /** room name -> Slack channel id. Channel messages map to rooms through this. */
  channels: Record<string, string>;
  /** agent name -> its Slack identity. */
  agents: Record<string, AgentSlack>;
  /** Slack user id -> name, used to normalize <@U..> mentions and to name
   *  inbound senders in the room. */
  roster: Record<string, string>;
  /** DM Slack channel id -> the owning agent's name (real-bot tier only). */
  dmRecipient: Record<string, string>;
  /** The single app's own bot id, so its persona posts never loop back in. */
  botId?: string;
  /** Channel agent<->agent DM rooms are mirrored read-only into (default
   *  "#scramble-dms"). */
  dmMirrorChannel?: string;
  /** When true, record the postMessage API calls instead of calling them. */
  dryRun?: boolean;
  /** Injected daemon seam: deliver an inbound Slack message to a room. */
  post: (input: PostInput) => unknown;
  /** Injected daemon seam: subscribe to every room message (the firehose). */
  subscribe: (fn: (message: Message) => void) => () => void;
}

/** The API call the bridge makes to Slack, what dry-run captures. */
export interface SlackMessageOpts {
  channel: string;
  text: string;
  token?: string;
  username?: string;
  iconEmoji?: string;
}

/** An inbound Slack message event, normalized to the bridge's shape (a real
 *  socket-mode transport maps raw events onto this). */
export interface InboundSlackMessage {
  type: string;
  channel: string;
  channelType?: string;
  user?: string;
  botId?: string;
  text?: string;
  ts: string;
}

/** The injected Slack seam. Tests pass a fake; a real transport calls the Slack
 *  API and connects a socket-mode stream. */
export interface SlackTransport {
  postMessage(opts: SlackMessageOpts): Promise<unknown>;
  connect(onEvent: (message: InboundSlackMessage) => void): { close?: () => void };
}

export interface SlackBridge {
  /** In dry-run mode, every postMessage call the bridge WOULD have made. */
  calls: SlackMessageOpts[];
  close: () => void;
}

export function createBridge(cfg: SlackConfig, transport: SlackTransport): SlackBridge {
  const calls: SlackMessageOpts[] = [];
  // dm `<agent>/<user>` -> the Slack DM channel id that reply posts go back to.
  const dmChannels = new Map<string, string>();
  const mirrorChannel = cfg.dmMirrorChannel ?? "#scramble-dms";

  // Every bot id the bridge posts with; an inbound message from any of them is
  // the bridge's own echo, so it is dropped to keep messages from looping back.
  const ownBots = new Set<string>();
  if (cfg.botId) ownBots.add(cfg.botId);
  for (const a of Object.values(cfg.agents)) if (a.botId) ownBots.add(a.botId);

  const roomForChannel = new Map<string, string>();
  for (const [room, ch] of Object.entries(cfg.channels)) roomForChannel.set(ch, room);

  /** Rewrite Slack `<@U..>` mentions to `@name` when the roster knows them,
   *  so the room text carries one mention form. Unknown ids are left intact. */
  function normalize(text: string): string {
    return text.replace(/<@([UW][A-Z0-9]+)(?:\|[^>]+)?>/g, (whole, id: string) => {
      const name = cfg.roster[id];
      return name ? `@${name}` : whole;
    });
  }

  /** Pick the agent's identity tier and post to Slack (or record it in dry-run). */
  function send(agent: string | undefined, channel: string, text: string): void {
    const opts: SlackMessageOpts = { channel, text };
    const ident = agent ? cfg.agents[agent] : undefined;
    if (ident) {
      if (ident.botToken) {
        opts.token = ident.botToken;
      } else {
        opts.username = ident.username;
        if (ident.iconEmoji) opts.iconEmoji = ident.iconEmoji;
      }
    }
    if (cfg.dryRun) {
      calls.push(opts);
      return;
    }
    void transport.postMessage(opts);
  }

  /** Route an observed room message back into Slack. */
  function onRoomMessage(m: Message): void {
    if (!m.room.startsWith(DM_PREFIX)) {
      // Group channel: post an agent's reply under that agent's identity.
      const ch = cfg.channels[m.room];
      if (ch && cfg.agents[m.from]) send(m.from, ch, m.text);
      return;
    }
    const segs = m.room.split("/");
    const a = segs[1];
    const b = segs[2];
    if (!a || !b) return;
    if (cfg.agents[a]) {
      if (cfg.agents[b]) {
        // Agent<->agent DM: mirror read-only, prefixed, as the app.
        send(undefined, mirrorChannel, `[${a}↔${b}] ${m.text}`);
      } else if (m.from === a) {
        // The agent's own DM reply goes back into the human's DM channel.
        const ch = dmChannels.get(`${a}/${b}`);
        if (ch) send(a, ch, m.text);
      }
    }
  }

  function onInbound(m: InboundSlackMessage): void {
    if (m.type !== "message" || !m.text || (m.botId && ownBots.has(m.botId))) return;
    const isIm = m.channelType === "im";
    const room = isIm ? dmInbound(m) : roomForChannel.get(m.channel);
    if (!room) return;
    const from = (m.user && cfg.roster[m.user]) ?? "";
    if (!from) return;
    cfg.post({ room, from, text: normalize(m.text), id: `${m.channel}:${m.ts}` });
  }

  /** A Slack DM targets one real-bot agent; map it to dm/<agent>/<slack-user>,
   *  recording the DM channel so the agent's replies route back. */
  function dmInbound(m: InboundSlackMessage): string | undefined {
    const agent = cfg.dmRecipient[m.channel];
    if (!agent || !m.user) return undefined;
    dmChannels.set(`${agent}/${m.user}`, m.channel);
    return `dm/${agent}/${m.user}`;
  }

  const unsubscribe = cfg.subscribe(onRoomMessage);
  const conn = transport.connect(onInbound);

  return {
    calls,
    close() {
      unsubscribe();
      conn.close?.();
    },
  };
}