// src/slack.ts — the Slack frontend bridge.
// The Slack transport and the room POST seam are both injected, so tests drive
// the whole bridge with fakes — no Slack account, no network. Every outbound
// Slack call is recorded on `bridge.calls`; in dryRun mode that recording is
// the whole result and the transport is never invoked.

import { DM_PREFIX, type Message } from "./types";

/** One outbound Slack chat.postMessage call. */
export interface SlackPostOptions {
  channel: string;
  text: string;
  /** per-agent bot token (real-user tier) — omitted for the persona tier. */
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

/** Per-agent identity. token present -> real Slack user; absent -> persona. */
export interface SlackAgent {
  token?: string; // real-user tier: post with this per-agent bot token
  icon?: string; //  persona avatar emoji for the customize tier
}

export interface SlackConfig {
  /** room name -> channel id. */
  channels: Record<string, string>;
  /** name -> identity config. */
  agents: Record<string, SlackAgent>;
  /** Slack DM channel id -> agent whose bot that DM is opened with = the agent. */
  dmChannels: Record<string, string>;
  /** Slack user id -> room name, for <@U…> -> @name normalization. */
  roster: Record<string, string>;
  /** The room POST seam: post inbound Slack text into a room as a human. */
  postToRoom(room: string, from: string, text: string): void;
  /** Own bot ids the bridge never re-posts (self-filter). */
  botIds?: string[];
  /** App token, used for every persona-tier post (chat:write.customize). */
  token?: string;
  /** Read-only channel for agent <-> agent DM mirror (default "#scramble-dms"). */
  dmMirrorChannel?: string;
  /** Record would-be calls instead of hitting the transport. */
  dryRun?: boolean;
}

export interface SlackBridge {
  /** Every outbound Slack call, in order (the dry-run surface). */
  calls: SlackPostOptions[];
  /** Open the socket-mode connection and route its events. */
  connect(): void;
  /** Push one room/firehose message out to Slack. */
  publish(msg: Message): void;
}

export function createBridge(cfg: SlackConfig, transport: SlackTransport): SlackBridge {
  const calls: SlackPostOptions[] = [];
  const ownBotIds = new Set(cfg.botIds ?? []);
  const mirror = cfg.dmMirrorChannel ?? "#scramble-dms";
  const roomByChannel = Object.fromEntries(Object.entries(cfg.channels).map(([r, c]) => [c, r]));
  const dmChannelByAgent = Object.fromEntries(Object.entries(cfg.dmChannels).map(([c, a]) => [a, c]));

  function replyTo(opts: SlackPostOptions): void {
    calls.push({
      channel: opts.channel,
      text: opts.text,
      ...(opts.token ? { token: opts.token } : {}),
      ...(opts.username ? { username: opts.username } : {}),
      ...(opts.icon_emoji ? { icon_emoji: opts.icon_emoji } : {}),
    });
    if (cfg.dryRun) return;
    void transport.postMessage(opts);
  }

  // Identity tier per agent: with a per-agent bot token it posts as a real Slack
  // user; without one the single app posts the agent's display name + icon.
  function identityFor(name: string): Pick<SlackPostOptions, "token" | "username" | "icon_emoji"> {
    const agent = cfg.agents[name];
    if (agent?.token) return { token: agent.token };
    return { token: cfg.token, username: name, icon_emoji: agent?.icon };
  }

  function normalize(text: string): string {
    return text.replace(/<@([A-Z0-9]+)>/g, (_m, uid: string) => `@${cfg.roster[uid] ?? uid}`);
  }

  function rosterName(user: string | undefined): string {
    return user === undefined ? "" : cfg.roster[user] ?? user;
  }

  function handleEvent(ev: SlackEvent): void {
    if (ev.type !== "message" || !ev.text) return;
    if (ev.bot_id && ownBotIds.has(ev.bot_id)) return;
    const text = normalize(ev.text);
    const dmAgent = cfg.dmChannels[ev.channel ?? ""];
    if (dmAgent) {
      const from = rosterName(ev.user);
      cfg.postToRoom(`dm/${dmAgent}/${from}`, from, text);
      return;
    }
    const room = roomByChannel[ev.channel ?? ""];
    if (room === undefined) return;
    cfg.postToRoom(room, rosterName(ev.user), text);
  }

  function dmParts(room: string): [string | undefined, string | undefined] {
    const parts = room.split("/");
    return [parts[1], parts[2]];
  }

  function publish(msg: Message): void {
    const [a, b] = dmParts(msg.room);
    if (msg.room.startsWith(DM_PREFIX)) {
      if (a !== undefined && b !== undefined && cfg.agents[a] && cfg.agents[b]) {
        // agent <-> agent DM is mirrored read-only into the designated channel.
        replyTo({ channel: mirror, text: `[${a}↔${b}] ${msg.from}: ${msg.text}` });
        return;
      }
      const dmChannel = a === undefined ? undefined : dmChannelByAgent[a];
      if (dmChannel === undefined) return;
      replyTo({ channel: dmChannel, text: msg.text, ...identityFor(msg.from) });
      return;
    }
    const channel = cfg.channels[msg.room];
    if (channel === undefined) return;
    replyTo({ channel, text: msg.text, ...identityFor(msg.from) });
  }

  return { calls, connect: () => transport.connect(handleEvent), publish };
}