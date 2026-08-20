import { describe, expect, test } from "bun:test";
import {
  createBridge,
  type InboundSlackMessage,
  type SlackConfig,
  type SlackTransport,
} from "../src/slack";
import type { Message } from "../src/types";

/** A fake Slack transport: records postMessage calls, lets tests inject events. */
function fakeTransport() {
  const posted: Record<string, unknown>[] = [];
  let handler: ((m: InboundSlackMessage) => void) | undefined;
  let socketClosed = false;
  const transport: SlackTransport = {
    async postMessage(opts) {
      posted.push(opts as unknown as Record<string, unknown>);
      return undefined;
    },
    connect(onEvent) {
      handler = onEvent;
      return { close: () => { socketClosed = true; } };
    },
  };
  return {
    transport,
    posted,
    socketClosed: () => socketClosed,
    emit: (m: InboundSlackMessage) => handler?.(m),
  };
}

/** A fake store seam: captures posts and the firehose subscription callback. */
interface FakeStore {
  cfg: SlackConfig;
  post: { room: string; from: string; text: string; id: string }[];
  fire: (m: Message) => void;
  storeClosed: () => boolean;
}

function fakeStore(): FakeStore {
  const posted: { room: string; from: string; text: string; id: string }[] = [];
  let fn: ((m: Message) => void) | undefined;
  let closed = false;
  const cfg = {
    channels: {},
    agents: {},
    roster: {},
    dmRecipient: {},
    post(p: { room: string; from: string; text: string; id: string }) {
      posted.push(p);
      return { seq: 1, crossings: [] };
    },
    subscribe(cb: (m: Message) => void) {
      fn = cb;
      return () => { closed = true; };
    },
  };
  return {
    cfg: cfg as unknown as SlackConfig,
    post: posted,
    fire: (m: Message) => fn?.(m),
    storeClosed: () => closed,
  };
}

function wire(cfg: Partial<SlackConfig>) {
  const store = fakeStore();
  const tx = fakeTransport();
  const full: SlackConfig = {
    channels: {},
    agents: {},
    roster: {},
    dmRecipient: {},
    post: store.cfg.post,
    subscribe: store.cfg.subscribe,
    ...cfg,
  };
  const bridge = createBridge(full, tx.transport);
  return { full, store, tx, bridge };
}

const msg = (p: Partial<Message> & { room: string; from: string; text: string }): Message => ({
  seq: 1,
  ts: "t",
  id: "1",
  mentions: [],
  ...p,
});

describe("outbound identity tiers (room -> Slack)", () => {
  test("a room mapped to a channel posts an agent reply as a real bot user when a bot token is set", () => {
    const { store, tx, bridge } = wire({
      channels: { general: "C1" },
      agents: { dev: { username: "Dev", botToken: "xoxb-token", botId: "UAGENT" } },
    });
    store.fire(msg({ room: "general", from: "dev", text: "hi" }));
    expect(tx.posted).toEqual([{ channel: "C1", text: "hi", token: "xoxb-token" }]);
    bridge.close();
  });

  test("an agent without a bot token posts through the app with username and icon", () => {
    const { store, tx, bridge } = wire({
      channels: { general: "C1" },
      agents: { bob: { username: "Bob", iconEmoji: ":robot_face:" } },
    });
    store.fire(msg({ room: "general", from: "bob", text: "yo" }));
    expect(tx.posted).toEqual([
      { channel: "C1", text: "yo", username: "Bob", iconEmoji: ":robot_face:" },
    ]);
    bridge.close();
  });

  test("a persona without an icon omits the iconEmoji field", () => {
    const { store, tx, bridge } = wire({
      channels: { general: "C1" },
      agents: { bob: { username: "Bob" } },
    });
    store.fire(msg({ room: "general", from: "bob", text: "yo" }));
    expect(tx.posted).toEqual([{ channel: "C1", text: "yo", username: "Bob" }]);
    bridge.close();
  });

  test("a room with no mapped channel posts nothing", () => {
    const { store, tx, bridge } = wire({
      channels: { other: "C9" },
      agents: { bob: { username: "Bob", botToken: "t" } },
    });
    store.fire(msg({ room: "general", from: "bob", text: "yo" }));
    expect(tx.posted).toEqual([]);
    bridge.close();
  });

  test("a non-agent message (a human) is not re-posted into a group channel", () => {
    const { store, tx, bridge } = wire({
      channels: { general: "C1" },
    });
    store.fire(msg({ room: "general", from: "sam", text: "hi" }));
    expect(tx.posted).toEqual([]);
    bridge.close();
  });
});

describe("inbound Slack message -> room (with mention normalization)", () => {
  test("a channel message posts to the mapped room as the human and rewrites <@U> mentions", () => {
    const { store, tx, bridge } = wire({
      channels: { general: "C1" },
      roster: { U1: "sam", U2: "dev" },
    });
    tx.emit({
      type: "message",
      channel: "C1",
      channelType: "channel",
      user: "U1",
      text: "hey <@U2|Dev> please look",
      ts: "1700.001",
    });
    expect(store.post).toEqual([
      { room: "general", from: "sam", text: "hey @dev please look", id: "C1:1700.001" },
    ]);
    bridge.close();
  });

  test("a message to an unmapped channel is dropped", () => {
    const { store, tx, bridge } = wire({
      channels: { other: "C9" },
      roster: { U1: "sam" },
    });
    tx.emit({ type: "message", channel: "C1", channelType: "channel", user: "U1", text: "x", ts: "t" });
    expect(store.post).toEqual([]);
    bridge.close();
  });

  test("an unknown mention id is left intact", () => {
    const { store, tx, bridge } = wire({
      channels: { general: "C1" },
      roster: { U1: "sam" },
    });
    tx.emit({
      type: "message",
      channel: "C1",
      channelType: "channel",
      user: "U1",
      text: "@dev see <@U99> too",
      ts: "t",
    });
    expect(store.post[0]?.text).toBe("@dev see <@U99> too");
    bridge.close();
  });

  test("non-message and bot-echo events are ignored", () => {
    const { store, tx, bridge } = wire({
      channels: { general: "C1" },
      roster: { U1: "sam" },
      agents: { dev: { username: "Dev", botId: "UAGENT" } },
      botId: "UAPP",
    });
    // not a message event
    tx.emit({ type: "reaction_added", channel: "C1", ts: "t" });
    // own persona bot echo
    tx.emit({ type: "message", channel: "C1", channelType: "channel", botId: "UAPP", user: "U1", text: "x", ts: "t" });
    // an agent's own real-bot echo
    tx.emit({ type: "message", channel: "C1", channelType: "channel", botId: "UAGENT", text: "x", ts: "t" });
    // empty text
    tx.emit({ type: "message", channel: "C1", channelType: "channel", user: "U1", text: "", ts: "t" });
    expect(store.post).toEqual([]);
    bridge.close();
  });

  test("an unknown sender (no roster entry) is dropped", () => {
    const { store, tx, bridge } = wire({
      channels: { general: "C1" },
      roster: {},
    });
    tx.emit({ type: "message", channel: "C1", channelType: "channel", user: "UXYZ", text: "x", ts: "t" });
    expect(store.post).toEqual([]);
    bridge.close();
  });
});

describe("DMs", () => {
  test("a Slack DM to an agent creates the dm room and records the reply channel", () => {
    const { store, tx, bridge } = wire({
      roster: { UHUMAN: "carol" },
      dmRecipient: { D1: "dev" },
      agents: { dev: { username: "Dev", botToken: "xoxb-dev", botId: "UAGENT" } },
    });
    tx.emit({ type: "message", channel: "D1", channelType: "im", user: "UHUMAN", text: "hello", ts: "t" });
    expect(store.post).toEqual([
      { room: "dm/dev/UHUMAN", from: "carol", text: "hello", id: "D1:t" },
    ]);
    bridge.close();
  });

  test("the agent's reply in a dm room goes back through its bot token", () => {
    const { store, tx, bridge } = wire({
      channels: { general: "C1" },
      roster: { UHUMAN: "carol" },
      dmRecipient: { D1: "dev" },
      agents: { dev: { username: "Dev", botToken: "xoxb-dev", botId: "b" } },
    });
    // the human DM sets up the reply channel
    tx.emit({ type: "message", channel: "D1", channelType: "im", user: "UHUMAN", text: "hello", ts: "t1" });
    // the agent replies into the dm room; it should go to the DM channel
    store.fire(msg({ room: "dm/dev/UHUMAN", from: "dev", text: "hi back" }));
    expect(tx.posted).toEqual([{ channel: "D1", text: "hi back", token: "xoxb-dev" }]);
    bridge.close();
  });

  test("a DM reply from a non-owner is not reposted (stays out of the channel)", () => {
    const { store, tx, bridge } = wire({
      roster: { UHUMAN: "carol" },
      dmRecipient: { D1: "dev" },
      agents: { dev: { username: "Dev", botToken: "t" } },
    });
    tx.emit({ type: "message", channel: "D1", channelType: "im", user: "UHUMAN", text: "hello", ts: "t" });
    store.fire(msg({ room: "dm/dev/UHUMAN", from: "carol", text: "more" }));
    expect(tx.posted).toEqual([]);
    bridge.close();
  });

  test("an agent<->agent DM is mirrored read-only with a prefix", () => {
    const { store, tx, bridge } = wire({
      channels: { general: "C1" },
      agents: { ana: { username: "Ana" }, dev: { username: "Dev" } },
      dmMirrorChannel: "#scramble-dms",
    });
    store.fire(msg({ room: "dm/ana/dev", from: "ana", text: "let's pair" }));
    expect(tx.posted).toEqual([
      { channel: "#scramble-dms", text: "[ana↔dev] let's pair" },
    ]);
    bridge.close();
  });

  test("agent-agent DMs mirror to the default #scramble-dms when unconfigured", () => {
    const { store, tx, bridge } = wire({
      agents: { ana: { username: "Ana" }, dev: { username: "Dev" } },
    });
    store.fire(msg({ room: "dm/ana/dev", from: "dev", text: "ok" }));
    expect(tx.posted[0]?.channel).toBe("#scramble-dms");
    bridge.close();
  });

  test("a malformed or unknown dm room is ignored", () => {
    const { store, tx, bridge } = wire({
      agents: { ana: { username: "Ana" }, dev: { username: "Dev" } },
    });
    store.fire(msg({ room: "dm/ana", from: "ana", text: "x" }));
    store.fire(msg({ room: "otherstuff", from: "someone", text: "x" }));
    expect(tx.posted).toEqual([]);
    bridge.close();
  });
});

describe("dry-run mode", () => {
  test("records the API calls it would make instead of calling the transport", () => {
    const { store, tx, bridge } = wire({
      dryRun: true,
      channels: { general: "C1" },
      agents: { bob: { username: "Bob" }, dev: { username: "Dev", botToken: "xoxb" }, ana: { username: "Ana" } },
    });
    store.fire(msg({ room: "general", from: "bob", text: "one" }));
    store.fire(msg({ room: "general", from: "dev", text: "two" }));
    store.fire(msg({ room: "dm/ana/dev", from: "ana", text: "three" }));
    expect(tx.posted).toEqual([]); // nothing reached the transport
    expect(bridge.calls).toEqual([
      { channel: "C1", text: "one", username: "Bob" },
      { channel: "C1", text: "two", token: "xoxb" },
      { channel: "#scramble-dms", text: "[ana↔dev] three" },
    ]);
    bridge.close();
  });
});

describe("teardown", () => {
  test("close tears down the store subscription and the socket", () => {
    const { store, bridge, tx } = wire({});
    bridge.close();
    expect(store.storeClosed()).toBe(true);
    expect(tx.socketClosed()).toBe(true);
  });
});