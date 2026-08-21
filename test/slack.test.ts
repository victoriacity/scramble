import { describe, expect, test } from "bun:test";
import {
  createBridge,
  type SlackBridge,
  type SlackConfig,
  type SlackEvent,
  type SlackPostOptions,
  type SlackTransport,
} from "../src/slack";

interface Fake {
  transport: SlackTransport;
  sent: SlackPostOptions[];
  handler?: (ev: SlackEvent) => void;
}

function fake(): Fake {
  const f: Fake = {
    sent: [],
    transport: {
      connect(on) {
        f.handler = on;
      },
      postMessage(o) {
        f.sent.push(o);
        return Promise.resolve();
      },
    },
  };
  return f;
}

function baseCfg(over?: Partial<SlackConfig>): SlackConfig {
  return {
    channels: { general: "C1" },
    agents: { alice: { token: "T_ALICE" }, bob: {} },
    dmChannels: { D1: "alice" },
    roster: { U111: "ana", U222: "dev" },
    postToChannel() {},
    ...over,
  };
}

function make(cfg: SlackConfig) {
  const f = fake();
  const posted: Array<{ channel: string; from: string; text: string }> = [];
  cfg.postToChannel = (channel, from, text) => posted.push({ channel, from, text });
  const bridge = createBridge(cfg, f.transport);
  bridge.connect();
  return { f, bridge, posted };
}

function route(b: SlackBridge, channel: string, from: string, text: string) {
  b.publish({ seq: 1, ts: "t", channel, from, text, id: "i", mentions: [] });
}

describe("connect + inbound", () => {
  test("a channel message posts into the channel as the human's name", () => {
    const { f, posted } = make(baseCfg());
    f.handler?.({ type: "message", channel: "C1", user: "U111", text: "hi everyone" });
    expect(posted).toEqual([{ channel: "general", from: "ana", text: "hi everyone" }]);
  });

  test("a PRIVATE channel message routes exactly like a public one", () => {
    // Slack gates private channels behind groups:history + message.groups (see
    // docs/slack-manifest.yaml), but the bridge routes on the channel id in
    // cfg.channels, not on the channel's type. This proves that: a private
    // channel id mapped like any other lands in its channel.
    const { f, posted } = make(baseCfg({ channels: { general: "C1", secret: "G_PRIV" } }));
    f.handler?.({ type: "message", channel: "G_PRIV", user: "U111", text: "private note" });
    expect(posted).toEqual([{ channel: "secret", from: "ana", text: "private note" }]);
  });

  test("a private channel message from an unmapped id is ignored", () => {
    const { f, posted } = make(baseCfg({ channels: { general: "C1" } }));
    f.handler?.({ type: "message", channel: "G_UNMAPPED", user: "U111", text: "not ours" });
    expect(posted).toEqual([]);
  });

  test("inbound <@U…> mention normalizes to @name via the roster", () => {
    const { f, posted } = make(baseCfg());
    f.handler?.({ type: "message", channel: "C1", user: "U111", text: "<@U222> confirm" });
    expect(posted).toEqual([{ channel: "general", from: "ana", text: "@dev confirm" }]);
  });

  test("an unknown mention id is left verbatim", () => {
    const { f, posted } = make(baseCfg());
    f.handler?.({ type: "message", channel: "C1", user: "U111", text: "<@U999> ping" });
    expect(posted).toEqual([{ channel: "general", from: "ana", text: "@U999 ping" }]);
  });

  test("a Slack user id not in the roster falls back to the raw id", () => {
    const { f, posted } = make(baseCfg());
    f.handler?.({ type: "message", channel: "C1", user: "U777", text: "who?" });
    expect(posted).toEqual([{ channel: "general", from: "U777", text: "who?" }]);
  });

  test("the bridge's own bot ids are self-filtered and never loop back", () => {
    const { f, posted } = make(baseCfg({ botIds: ["B1"] }));
    f.handler?.({ type: "message", channel: "C1", user: "U1", bot_id: "B1", text: "loop" });
    expect(posted).toEqual([]);
  });

  test("non-message events and messages without text are ignored", () => {
    const { f, posted } = make(baseCfg());
    f.handler?.({ type: "app_mention", channel: "C1", text: "hi" });
    f.handler?.({ type: "message", channel: "C1", user: "U111" });
    expect(posted).toEqual([]);
  });

  test("a channel event for an unlisted channel is dropped", () => {
    const { f, posted } = make(baseCfg());
    f.handler?.({ type: "message", channel: "NOWHERE", user: "U111", text: "hi" });
    expect(posted).toEqual([]);
  });

  test("a Slack DM maps to channel dm/<agent>/<slack-user> and is created on first message", () => {
    const { f, posted } = make(baseCfg());
    f.handler?.({ type: "message", channel: "D1", user: "U111", text: "hello" });
    expect(posted).toEqual([{ channel: "dm/alice/ana", from: "ana", text: "hello" }]);
  });

  test("a DM with no user still routes (raw peer name is empty)", () => {
    const { f, posted } = make(baseCfg());
    f.handler?.({ type: "message", channel: "D1", text: "anon hello" });
    expect(posted).toEqual([{ channel: "dm/alice/", from: "", text: "anon hello" }]);
  });
});

describe("outbound publish", () => {
  test("a real-user-tier agent posts group messages with its own bot token", () => {
    const { bridge, f } = make(baseCfg());
    route(bridge, "general", "alice", "hi");
    expect(bridge.calls).toEqual([{ channel: "C1", text: "hi", token: "T_ALICE" }]);
    expect(f.sent).toEqual(bridge.calls);
  });

  test("both identity tiers publish into a PRIVATE channel", () => {
    const cfg = baseCfg({
      channels: { secret: "G_PRIV" },
      agents: { alice: { token: "T_ALICE" }, bob: { icon: ":robot:" } },
      token: "T_APP",
    });
    const { bridge } = make(cfg);
    route(bridge, "secret", "alice", "real-user tier");
    route(bridge, "secret", "bob", "persona tier");
    expect(bridge.calls).toEqual([
      { channel: "G_PRIV", text: "real-user tier", token: "T_ALICE" },
      { channel: "G_PRIV", text: "persona tier", token: "T_APP", username: "bob", icon_emoji: ":robot:" },
    ]);
  });

  test("a persona-tier agent posts through the app with display name + icon", () => {
    const { bridge } = make(baseCfg({ agents: { bob: { icon: ":robot:" } }, token: "T_APP" }));
    route(bridge, "general", "bob", "howdy");
    expect(bridge.calls).toEqual([
      { channel: "C1", text: "howdy", token: "T_APP", username: "bob", icon_emoji: ":robot:" },
    ]);
  });

  test("a group channel with no bound channel publishes nothing", () => {
    const { bridge, f } = make(baseCfg());
    route(bridge, "unbound", "alice", "hi");
    expect(bridge.calls).toEqual([]);
    expect(f.sent).toEqual([]);
  });

  test("an agent <-> agent DM mirrors read-only into the default mirror channel", () => {
    const { bridge } = make(baseCfg({ agents: { alice: { token: "T" }, bob: {} } }));
    route(bridge, "dm/alice/bob", "alice", "want to sync?");
    expect(bridge.calls).toEqual([
      { channel: "#scramble-dms", text: "[alice↔bob] alice: want to sync?" },
    ]);
  });

  test("the DM mirror honors a configured mirror channel", () => {
    const { bridge } = make(
      baseCfg({ agents: { alice: { token: "T" }, bob: {} }, dmMirrorChannel: "#audit" }),
    );
    route(bridge, "dm/alice/bob", "bob", "sure");
    expect(bridge.calls).toEqual([
      { channel: "#audit", text: "[alice↔bob] bob: sure" },
    ]);
  });

  test("an agent -> slack-user DM is posted back through the agent's own DM channel", () => {
    const { bridge } = make(baseCfg());
    route(bridge, "dm/alice/ana", "alice", "got it");
    expect(bridge.calls).toEqual([{ channel: "D1", text: "got it", token: "T_ALICE" }]);
  });

  test("a DM channel whose agent has no bound DM channel is skipped", () => {
    const { bridge } = make(baseCfg({ agents: { x: {} } }));
    route(bridge, "dm/x/y", "x", "hi");
    expect(bridge.calls).toEqual([]);
  });

  test("a malformed dm channel with no second segment is skipped", () => {
    const { bridge } = make(baseCfg());
    route(bridge, "dm", "alice", "hi");
    expect(bridge.calls).toEqual([]);
  });
});

describe("dry-run", () => {
  test("records would-be calls but never hits the transport", () => {
    const { bridge, f } = make(baseCfg({ dryRun: true }));
    route(bridge, "general", "alice", "hi");
    expect(bridge.calls).toEqual([{ channel: "C1", text: "hi", token: "T_ALICE" }]);
    expect(f.sent).toEqual([]);
  });

  test("dry-run still routes inbound into the channel", () => {
    const { f, posted } = make(baseCfg({ dryRun: true }));
    f.handler?.({ type: "message", channel: "C1", user: "U111", text: "hi" });
    expect(posted).toEqual([{ channel: "general", from: "ana", text: "hi" }]);
  });
});

