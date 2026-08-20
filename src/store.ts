// room: append-only JSONL log under <dir>/<room>.jsonl
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

export interface RoomStore {
  post(input: PostInput): PostResult;
  read(room: string, since?: number): Message[];
  readAll(since?: number): Message[];
  join(name: string, persona: string, room: string): void;
  agents(): Agent[];
  rooms(): string[];
  subscribe(fn: (m: Message) => void): () => void;
  roomsFor(name: string): string[];
  deliveryFor(name: string, msg: Message): Delivery;
}

function assertSafeRoom(room: string): void {
  if (room.length === 0) throw new Error(`room name may not be empty`);
  for (const seg of room.split("/")) {
    if (seg === "." || seg === ".." || seg.includes("..") || seg === "") {
      throw new Error(`room name escapes data dir: ${room}`);
    }
  }
}

function roomPath(dir: string, room: string): string {
  assertSafeRoom(room);
  const base = normalize(dir) + sep;
  const full = normalize(pathJoin(dir, room + ".jsonl"));
  if (!full.startsWith(base)) throw new Error(`room name escapes data dir: ${room}`);
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

export function createStore(dir: string): RoomStore {
  mkdirSync(dir, { recursive: true });

  const rooms = new Map<string, Message[]>();
  const byId = new Map<string, PostResult>();
  const memberRooms = new Map<string, Set<string>>();
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
        const room = childRel.slice(0, -".jsonl".length);
        const msgs = parseLog(readFileSync(pathJoin(d, ent.name), "utf8"));
        rooms.set(room, msgs);
        for (const m of msgs) {
          if (m.seq >= nextSeq) nextSeq = m.seq + 1;
          let set = memberRooms.get(m.from);
          if (!set) { set = new Set<string>(); memberRooms.set(m.from, set); }
          set.add(room);
          if (!byId.has(m.id)) byId.set(m.id, { seq: m.seq, crossings: [] });
        }
      }
    }
  }

  function append(msg: Message): void {
    const path = roomPath(dir, msg.room);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(msg) + "\n");
  }

  function computeMentions(from: string, room: string, text: string): string[] {
    const known = new Set<string>([...memberRooms.keys(), ...personas.keys()]);
    if (room.startsWith(DM_PREFIX)) {
      const peers = new Set<string>();
      for (const seg of room.split("/").slice(1)) {
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

  function roomsFor(name: string): string[] {
    const out = new Set<string>(memberRooms.get(name) ?? []);
    for (const room of rooms.keys()) {
      if (room.startsWith(`${DM_PREFIX}${name}/`)) out.add(room);
    }
    return [...out];
  }

  function post(input: PostInput): PostResult {
    const dup = byId.get(input.id);
    if (dup) return dup;
    assertSafeRoom(input.room);
    const roomMsgs = rooms.get(input.room) ?? [];
    const msg: Message = {
      seq: nextSeq++,
      ts: new Date().toISOString(),
      room: input.room,
      from: input.from,
      text: input.text,
      id: input.id,
      mentions: computeMentions(input.from, input.room, input.text),
    };
    append(msg);
    rooms.set(input.room, [...roomMsgs, msg]);
    let set = memberRooms.get(input.from);
    if (!set) { set = new Set<string>(); memberRooms.set(input.from, set); }
    set.add(input.room);
    const lastSeen = input.lastSeen ?? 0;
    const crossings = roomMsgs.filter((m) => m.seq > lastSeen && m.from !== input.from);
    const result: PostResult = { seq: msg.seq, crossings };
    byId.set(input.id, result);
    for (const fn of [...listeners]) fn(msg);
    return result;
  }

  function read(room: string, since = 0): Message[] {
    roomPath(dir, room);
    return (rooms.get(room) ?? []).filter((m) => m.seq > since);
  }

  function readAll(since = 0): Message[] {
    const out: Message[] = [];
    for (const msgs of rooms.values()) for (const m of msgs) if (m.seq > since) out.push(m);
    return out.sort((a, b) => a.seq - b.seq);
  }

  function join(name: string, persona: string, room: string): void {
    assertSafeRoom(room);
    personas.set(name, persona);
    let set = memberRooms.get(name);
    if (!set) { set = new Set<string>(); memberRooms.set(name, set); }
    set.add(room);
  }

  function agents(): Agent[] {
    const names = new Set<string>([...memberRooms.keys(), ...personas.keys()]);
    return [...names].map((name) => ({
      name,
      persona: personas.get(name) ?? "",
      rooms: roomsFor(name),
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
    rooms: () => [...rooms.keys()],
    subscribe(fn) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    roomsFor,
    deliveryFor,
  };
}