// channel: append-only JSONL log under <dir>/<channel>.jsonl
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join as pathJoin, normalize, sep } from "node:path";
import {
  DM_PREFIX,
  type Agent,
  type Delivery,
  type Message,
  type PostInput,
  type PostResult,
} from "./types";

export interface ChannelStore {
  post(input: PostInput): PostResult;
  read(channel: string, since?: number): Message[];
  readAll(since?: number): Message[];
  join(name: string, persona: string, channel: string): void;
  agents(): Agent[];
  channels(): string[];
  subscribe(fn: (m: Message) => void): () => void;
  channelsFor(name: string): string[];
  deliveryFor(name: string, msg: Message): Delivery;
}

function assertSafeChannel(channel: string): void {
  if (channel.length === 0) throw new Error(`channel name may not be empty`);
  for (const seg of channel.split("/")) {
    if (seg === "." || seg === ".." || seg.includes("..") || seg === "") {
      throw new Error(`channel name escapes data dir: ${channel}`);
    }
  }
}

function channelPath(dir: string, channel: string): string {
  assertSafeChannel(channel);
  const base = normalize(dir) + sep;
  const full = normalize(pathJoin(dir, channel + ".jsonl"));
  if (!full.startsWith(base)) throw new Error(`channel name escapes data dir: ${channel}`);
  return full;
}

function parseLog(text: string): Message[] {
  const out: Message[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t) out.push(JSON.parse(t) as Message);
  }
  return out;
}

export function createStore(dir: string): ChannelStore {
  mkdirSync(dir, { recursive: true });

  const channels = new Map<string, Message[]>();
  const byId = new Map<string, PostResult>();
  const memberChannels = new Map<string, Set<string>>();
  const personas = new Map<string, string>();
  const listeners: Array<(m: Message) => void> = [];
  let nextSeq = 1;

  // Rebuild from existing JSONL logs: next seq, membership, dedup keys.
  const stack: Array<[string, string]> = [[dir, ""]];
  while (stack.length) {
    const [d, rel] = stack.pop()!;
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) stack.push([pathJoin(d, ent.name), childRel]);
      else if (ent.isFile() && ent.name.endsWith(".jsonl")) {
        const channel = childRel.slice(0, -".jsonl".length);
        const msgs = parseLog(readFileSync(pathJoin(d, ent.name), "utf8"));
        channels.set(channel, msgs);
        for (const m of msgs) {
          if (m.seq >= nextSeq) nextSeq = m.seq + 1;
          let set = memberChannels.get(m.from);
          if (!set) { set = new Set<string>(); memberChannels.set(m.from, set); }
          set.add(channel);
          if (!byId.has(m.id)) byId.set(m.id, { seq: m.seq, crossings: [] });
        }
      }
    }
  }

  function append(msg: Message): void {
    const path = channelPath(dir, msg.channel);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(msg) + "\n");
  }

  function computeMentions(from: string, channel: string, text: string): string[] {
    const known = new Set<string>([...memberChannels.keys(), ...personas.keys()]);
    if (channel.startsWith(DM_PREFIX)) {
      const peers = new Set<string>();
      for (const seg of channel.split("/").slice(1)) {
        if (seg && seg !== from) peers.add(seg);
      }
      return [...peers];
    }
    const tokens = new Set(
      text
        .split(/\s+/)
        .filter((t) => t.startsWith("@"))
        .map((t) => t.slice(1).replace(/^\W+/, "").replace(/\W+$/, "")),
    );
    const out = new Set<string>();
    for (const name of known) if (name !== from && tokens.has(name)) out.add(name);
    return [...out];
  }

  function channelsFor(name: string): string[] {
    const out = new Set<string>(memberChannels.get(name) ?? []);
    for (const channel of channels.keys()) {
      if (channel.startsWith(`${DM_PREFIX}${name}/`)) out.add(channel);
    }
    return [...out];
  }

  function post(input: PostInput): PostResult {
    const dup = byId.get(input.id);
    if (dup) return dup;
    assertSafeChannel(input.channel);
    const channelMsgs = channels.get(input.channel) ?? [];
    const msg: Message = {
      seq: nextSeq++,
      ts: new Date().toISOString(),
      channel: input.channel,
      from: input.from,
      text: input.text,
      id: input.id,
      mentions: computeMentions(input.from, input.channel, input.text),
      ...(input.files && input.files.length > 0 ? { files: input.files } : {}),
      ...(input.thread !== undefined ? { thread: input.thread } : {}),
    };
    append(msg);
    channels.set(input.channel, [...channelMsgs, msg]);
    let set = memberChannels.get(input.from);
    if (!set) { set = new Set<string>(); memberChannels.set(input.from, set); }
    set.add(input.channel);
    const lastSeen = input.lastSeen ?? 0;
    const crossings = channelMsgs.filter((m) => m.seq > lastSeen && m.from !== input.from);
    const result: PostResult = { seq: msg.seq, crossings };
    byId.set(input.id, result);
    for (const fn of [...listeners]) fn(msg);
    return result;
  }

  function read(channel: string, since = 0): Message[] {
    channelPath(dir, channel);
    return (channels.get(channel) ?? []).filter((m) => m.seq > since);
  }

  function readAll(since = 0): Message[] {
    const out: Message[] = [];
    for (const msgs of channels.values()) for (const m of msgs) if (m.seq > since) out.push(m);
    return out.sort((a, b) => a.seq - b.seq);
  }

  function join(name: string, persona: string, channel: string): void {
    personas.set(name, persona);
    if (channel === "") return;
    assertSafeChannel(channel);
    let set = memberChannels.get(name);
    if (!set) { set = new Set<string>(); memberChannels.set(name, set); }
    set.add(channel);
  }

  function agents(): Agent[] {
    const names = new Set<string>([...memberChannels.keys(), ...personas.keys()]);
    return [...names].map((name) => ({
      name,
      persona: personas.get(name) ?? "",
      channels: channelsFor(name),
    }));
  }

  function deliveryFor(name: string, msg: Message): Delivery {
    return { ...msg, mentioned: msg.mentions.includes(name) };
  }

  return {
    post,
    read,
    readAll,
    join,
    agents,
    channels: () => [...channels.keys()],
    subscribe(fn) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    channelsFor,
    deliveryFor,
  };
}