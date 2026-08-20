import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore, type RoomStore } from "../src/store";

function freshDir(): string {
  const d = join(tmpdir(), `scramble-store-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function open(dir: string): RoomStore {
  return createStore(dir);
}

test("post appends and returns seq plus crossings", () => {
  const dir = freshDir();
  const s = open(dir);
  const r = s.post({ room: "general", from: "a", text: "hi", id: "1", lastSeen: 0 });
  expect(r.seq).toBe(1);
  expect(r.crossings).toEqual([]);

  // b races: lastSeen 0, should see a's message as crossing (not its own)
  const r2 = s.post({ room: "general", from: "b", text: "yo", id: "2", lastSeen: 0 });
  expect(r2.seq).toBe(2);
  expect(r2.crossings).toEqual([expect.objectContaining({ from: "a", seq: 1, text: "hi" })]);
});

test("crossings exclude sender's own messages and respect lastSeen", () => {
  const dir = freshDir();
  const s = open(dir);
  s.post({ id: "a", from: "a", text: "one", room: "r", lastSeen: 0 });
  // a posts again after seeing seq 1: no crossings
  const second = s.post({ id: "a2", from: "a", text: "two", room: "r", lastSeen: 1 });
  expect(second.seq).toBe(2);
  expect(second.crossings).toEqual([]);
  // a's own earlier message should never appear as a crossing to a
  const b = s.post({ id: "b1", from: "b", text: "b", room: "r", lastSeen: 0 });
  expect(b.crossings.map((m) => m.from)).toEqual(["a", "a"]);
});

test("dedup: repeated id returns original result and appends nothing", () => {
  const dir = freshDir();
  const s = open(dir);
  const first = s.post({ id: "dup", from: "a", text: "msg", room: "r", lastSeen: 0 });
  const again = s.post({ id: "dup", from: "a", text: "DIFFERENT", room: "r", lastSeen: 0 });
  expect(again).toEqual(first);
  expect(s.read("r")).toHaveLength(1);
});

test("read and readAll implement since catch-up", () => {
  const dir = freshDir();
  const s = open(dir);
  s.post({ id: "1", from: "a", text: "one", room: "g", lastSeen: 0 });
  s.post({ id: "2", from: "b", text: "two", room: "dm/x/y", lastSeen: 0 });
  s.post({ id: "3", from: "c", text: "three", room: "g", lastSeen: 0 });
  expect(s.read("g")).toHaveLength(2);
  expect(s.read("g", 1)).toHaveLength(1);
  expect(s.readAll().map((m) => m.seq)).toEqual([1, 2, 3]);
  expect(s.readAll(2).map((m) => m.seq)).toEqual([3]);
});

test("crash-safe seq recovery across a reopened store", () => {
  const dir = freshDir();
  const s1 = open(dir);
  s1.post({ id: "1", from: "a", text: "x", room: "g", lastSeen: 0 });
  s1.post({ id: "2", from: "b", text: "y", room: "r", lastSeen: 0 });
  expect(s1.rooms()).toEqual(["g", "r"]);

  const s2 = open(dir); // new store over same dir
  const next = s2.post({ id: "3", from: "a", text: "z", room: "g", lastSeen: 0 });
  expect(next.seq).toBe(3);
  expect(s2.readAll()).toHaveLength(3);
  // dedup keys survive a reboot too
  const dup = s2.post({ id: "1", from: "a", text: "x", room: "g", lastSeen: 0 });
  expect(dup.seq).toBe(1);
  expect(s2.readAll()).toHaveLength(3);
});

test("room names with slashes map to subdirectories", () => {
  const dir = freshDir();
  const s = open(dir);
  s.post({ id: "1", from: "a", text: "hi", room: "dm/dev/ana", lastSeen: 0 });
  s.post({ id: "2", from: "a", text: "hey", room: "nested/deep/room", lastSeen: 0 });
  expect(s.rooms()).toEqual(["dm/dev/ana", "nested/deep/room"]);
  expect(s.read("dm/dev/ana")).toHaveLength(1);
});

test("path escapes are rejected", () => {
  const dir = freshDir();
  const s = open(dir);
  for (const bad of ["../evil", "a/../b", "..", "/abs"]) {
    expect(() => s.post({ id: "x", from: "a", text: "t", room: bad, lastSeen: 0 })).toThrow();
  }
  expect(() => s.read("..")).toThrow();
});

test("join derives membership and records persona", () => {
  const dir = freshDir();
  const s = open(dir);
  const r1 = s.post({ id: "1", from: "alice", text: "t", room: "general", lastSeen: 0 });
  expect(r1.seq).toBe(1);
  s.join("bob", "i test things", "general");
  const ag = s.agents();
  const alice = ag.find((a) => a.name === "alice");
  const bob = ag.find((a) => a.name === "bob");
  expect(alice?.rooms).toContain("general");
  expect(bob?.persona).toBe("i test things");
  expect(bob?.rooms).toContain("general");
});

test("automatic membership in dm/<name>/* rooms", () => {
  const dir = freshDir();
  const s = open(dir);
  s.post({ id: "1", from: "x", text: "hi", room: "dm/dev/ana", lastSeen: 0 });
  s.join("dev", "p", "other");
  // dev is the dm/<name> first segment: auto-membered.
  expect(s.roomsFor("dev")).toContain("dm/dev/ana");
  // ana is not auto-membered in dev's DM; she joins only by posting there.
  expect(s.roomsFor("ana")).not.toContain("dm/dev/ana");
  s.post({ id: "2", from: "ana", text: "reply", room: "dm/dev/ana", lastSeen: 0 });
  expect(s.roomsFor("ana")).toContain("dm/dev/ana");
});

test("roomsFor includes rooms from posts and explicit joins", () => {
  const dir = freshDir();
  const s = open(dir);
  s.post({ id: "1", from: "carol", text: "t", room: "g", lastSeen: 0 });
  s.join("carol", "p", "other");
  const rooms = s.roomsFor("carol");
  expect(rooms).toContain("g");
  expect(rooms).toContain("other");
});

test("subscribe notifies per append and unsubscribes", () => {
  const dir = freshDir();
  const s = open(dir);
  const seen: number[] = [];
  const un = s.subscribe((m) => seen.push(m.seq));
  s.post({ id: "1", from: "a", text: "t", room: "g", lastSeen: 0 });
  expect(seen).toEqual([1]);
  un();
  s.post({ id: "2", from: "b", text: "t", room: "g", lastSeen: 0 });
  expect(seen).toEqual([1]);
});

test("deliveryFor stamps mentioned from mentions", () => {
  const dir = freshDir();
  const s = open(dir);
  s.join("dev", "p", "g");
  const r = s.post({ id: "1", from: "ana", text: "@dev check this", room: "g", lastSeen: 0 });
  const msg = s.read("g")[0]!;
  expect(r.seq).toBe(1);
  const d = s.deliveryFor("dev", msg);
  expect(d.mentioned).toBe(true);
  expect(d.mentions).toEqual(["dev"]);
  const not = s.deliveryFor("ana", msg);
  expect(not.mentioned).toBe(false);
});

test("mentions in a DM room include every participant but the sender", () => {
  const dir = freshDir();
  const s = open(dir);
  const r = s.post({ id: "1", from: "ana", text: "hi", room: "dm/ana/bob", lastSeen: 0 });
  const msg = s.read("dm/ana/bob")[0]!;
  expect(r.seq).toBe(1);
  expect(msg.mentions).toEqual(["bob"]);
  const bobDeliv = s.deliveryFor("bob", msg);
  expect(bobDeliv.mentioned).toBe(true);
  const anaDeliv = s.deliveryFor("ana", msg);
  expect(anaDeliv.mentioned).toBe(false);
});

test("reopened store derives membership and dedup from disk", () => {
  const dir = freshDir();
  const s1 = open(dir);
  s1.post({ id: "m1", from: "eve", text: "p1", room: "core/db", lastSeen: 0 });
  const s2 = open(dir);
  expect(s2.agents().find((a) => a.name === "eve")?.rooms).toContain("core/db");
  expect(s2.readAll()).toHaveLength(1);
});

test("empty room list on fresh store", () => {
  const s = open(freshDir());
  expect(s.rooms()).toEqual([]);
  expect(s.agents()).toEqual([]);
});