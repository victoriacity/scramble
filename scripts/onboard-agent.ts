#!/usr/bin/env bun
// Onboard THIS agent to Slack with no human in the loop.
//
//   bun scripts/onboard-agent.ts <agent-name> [--app-name <name>] [--channel <name|id>]
//                                 [--description "…"] [--long-description "…"]
//                                 [--icon <file.png>] [--team <T…>] [--print-manifest]
//
// Run it AGAIN for an agent that already has an app and it updates that app
// rather than creating a second one, so an agent can rewrite its own description
// or change its own avatar whenever it wants to.
//
// <agent-name> is what the agent is called in scramble (`--as`). `--app-name` is
// what SLACK shows: the app's name and its bot display name, which is what
// appears beside every message and in @-mention autocomplete, so a person should
// confirm it before it exists. It defaults to the agent name.
//
// The only human operation is one-time and machine-wide: install the Slack CLI
// and run `slack login`. After that an agent creates and installs its OWN Slack
// app from the CLI's stored credential, so nothing about adding the tenth agent
// involves a person.
//
// The two API calls that matter, measured against a real Enterprise Grid org:
//
//   apps.manifest.create  { manifest, team_id }          -> app_id
//   apps.developerInstall { app_id, bot_scopes, team_id } -> bot + app-level tokens
//
// TWO FIELDS DECIDE WHETHER THIS WORKS, and they are easy to get wrong.
//
// team_id: omit it and developerInstall answers
// {"ok":false,"error":"app_approval_request_eligible"}, which reads like a
// policy needing an administrator. Pass the WORKSPACE id and it answers ok:true.
//
// org_deploy_enabled: with an ORG-level CLI credential the resulting install is
// an ENTERPRISE install anyway (auth.test reports is_enterprise_install true,
// team_id = the E… org) no matter which team_id was passed. That is fine, since
// on Enterprise Grid the workspace IS a team in the org and events carry
// team_id = T…, but ONLY if the manifest declares org_deploy_enabled:true. With
// false, Slack accepts the install, every REST call works, the socket opens and
// says hello, and not one event is ever delivered. Do not read the two as
// alternatives: the install is org-wide and the manifest must say so.
//
// What it does, in order: create the app, install it, join the channel when the
// channel is public, write ~/.config/scramble/slack.json, and verify with a real
// read. It never prints a token.

import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";

// The scopes, and why each one is here. THIS LIST IS THE SOURCE: the app is
// created from it, and `--print-manifest` prints the manifest for anyone pasting
// it into the browser by hand, so there is no second copy to drift.
const SCOPES: Array<[string, string]> = [
  ["chat:write", "post a message, a threaded reply, and the living status message"],
  ["channels:history", "read a public channel"],
  ["groups:history", "read a private channel"],
  ["im:history", "read a DM"],
  ["im:read", "FIND your own DM conversation. Without it conversations.list types=im answers missing_scope, so a human's DM exists and the agent cannot locate it"],
  ["im:write", "open and write a DM, so a human can talk to this agent alone"],
  ["users:read", "resolve <@U…> to a name; without it a mention matches no agent"],
  ["channels:read", "name a channel by its id, and find a public channel by name"],
  ["groups:read", "FIND a private channel you were invited to. groups:history reads one you already know; without groups:read an agent cannot discover its own channel id and needs the Slack CLI credential to look it up"],
  ["files:write", "upload an attachment"],
  ["files:read", "download an inbound attachment"],
  ["reactions:write", "react to a message with an emoji, which is how a channel acknowledges without adding a line"],
  ["reactions:read", "see which reactions a message already carries, so a reply does not repeat what a reaction already said"],
  ["assistant:write", "the automatic working status on an assistant thread"],
];
const BOT_EVENTS = ["message.channels", "message.groups", "message.im"];

/** Slack's own constraint, measured: a `long_description` under 175 characters
 *  is rejected with
 *  `failed_constraint … min_length expected 175`, so a short one is padded out
 *  by the caller rather than silently dropped. */
const LONG_DESCRIPTION_MIN = 175;

function manifestFor(
  name: string,
  description?: string,
  longDescription?: string,
): Record<string, unknown> {
  return {
    display_information: {
      name,
      ...(description !== undefined && description !== "" ? { description } : {}),
      ...(longDescription !== undefined && longDescription.length >= LONG_DESCRIPTION_MIN
        ? { long_description: longDescription }
        : {}),
    },
    features: { bot_user: { display_name: name, always_online: false } },
    oauth_config: { scopes: { bot: SCOPES.map(([s]) => s) } },
    settings: {
      event_subscriptions: { bot_events: BOT_EVENTS },
      socket_mode_enabled: true,
      token_rotation_enabled: false,
      // TRUE, and this field decides whether the agent's inbox works at all.
      // `apps.developerInstall` with an org-level credential produces an
      // ENTERPRISE install (auth.test: is_enterprise_install true) whatever
      // team_id is passed. An app installed that way while declaring
      // org_deploy_enabled:false is a contradiction Slack ACCEPTS in silence:
      // the tokens work, every REST call works, the socket opens and says
      // hello, and no event is ever delivered. Measured on 2026-08-21 by
      // flipping this one field on a live app: messages began arriving on the
      // socket seconds later, from a bot and from a human.
      org_deploy_enabled: true,
    },
  };
}

function die(msg: string): never {
  console.error(`onboard: ${msg}`);
  process.exit(1);
}

/** The Slack CLI's stored credential. `slack login` writes it, and any `slack`
 *  command refreshes it, which is why an expired one is reported with that fix
 *  rather than worked around here. */
function configToken(): { token: string; enterpriseId: string } {
  const fromEnv = process.env.SLACK_CONFIG_TOKEN;
  if (fromEnv !== undefined && fromEnv !== "") return { token: fromEnv, enterpriseId: "" };
  const path = join(process.env.HOME ?? "", ".slack", "credentials.json");
  if (!existsSync(path)) {
    die(
      `no Slack CLI credential at ${path}. The one human step for this machine:\n` +
        `  1. install the Slack CLI (https://docs.slack.dev/tools/slack-cli)\n` +
        `  2. run \`slack login\` and paste the /slackauthticket command it prints into Slack`,
    );
  }
  const all = JSON.parse(readFileSync(path, "utf8")) as Record<string, { token?: string }>;
  for (const [id, v] of Object.entries(all)) {
    if (typeof v.token === "string" && v.token !== "") return { token: v.token, enterpriseId: id };
  }
  return die(`${path} holds no token. Run \`slack login\`.`);
}

async function api(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const j = (await res.json()) as Record<string, unknown>;
  if (j.ok !== true) {
    const err = String(j.error ?? "unknown");
    if (err === "invalid_auth" || err === "token_expired" || err === "token_revoked") {
      die(
        `${method} answered ${err}. The CLI's credential is short-lived and any \`slack\`\n` +
          `command refreshes it: run \`slack auth list\`, then this script again.`,
      );
    }
    if (err === "app_approval_request_eligible") {
      die(
        `${method} answered app_approval_request_eligible for team ${String(j.team_id)}.\n` +
          `Pass --team <T…> with the WORKSPACE id rather than the enterprise id.`,
      );
    }
    die(`${method} failed: ${err} ${JSON.stringify(j).slice(0, 300)}`);
  }
  return j;
}

async function get(token: string, path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return (await res.json()) as Record<string, unknown>;
}

/** The WORKSPACE this app belongs to. On Enterprise Grid the CLI's auth is the
 *  ORG, so the workspace has to be named explicitly somewhere; auth.teams.list
 *  answers it, and a single workspace needs no flag at all. */
async function resolveTeam(token: string, flag?: string): Promise<string> {
  // AN ENTERPRISE ID IS NOT A WORKSPACE, and passing one is how this whole path
  // looked impossible for an afternoon: with `E…` as the team,
  // apps.developerInstall answers app_approval_request_eligible, which reads
  // like a Slack policy requiring an administrator per agent. It is not a
  // policy; it is the wrong parameter. Refused here so the call is never made.
  const notEnterprise = (id: string): string => {
    if (/^E[A-Z0-9]{6,}$/.test(id)) {
      die(
        `${id} is an ENTERPRISE id, not a workspace id. Installing an app there needs an\n` +
          `administrator's approval; installing it to a WORKSPACE does not. Pass the T… id\n` +
          `for the workspace (\`auth.teams.list\` lists them, and this script reads it for you\n` +
          `when the login covers exactly one).`,
      );
    }
    return id;
  };
  if (flag !== undefined && flag !== "") return notEnterprise(flag);
  const r = await get(token, "auth.teams.list");
  const teams = (r.teams as Array<{ id: string; name: string }> | undefined) ?? [];
  if (teams.length === 1) {
    console.log(`onboard: workspace ${teams[0]!.id} (${teams[0]!.name})`);
    return notEnterprise(teams[0]!.id);
  }
  if (teams.length === 0) die("auth.teams.list returned no workspace; pass --team <T…>");
  die(
    `this login covers ${teams.length} workspaces, so name one with --team:\n` +
      teams.map((t) => `  ${t.id}  ${t.name}`).join("\n"),
  );
}

/** Find a conversation by name or accept an id as given. The CLI's credential
 *  holds `groups:read`, which no bot token here does, so a PRIVATE channel is
 *  discoverable through it: the agent never has to be handed an id. */
async function resolveChannel(
  token: string,
  team: string,
  nameOrId: string,
): Promise<{ id: string; name: string; private: boolean }> {
  if (/^[CDG][A-Z0-9]{6,}$/.test(nameOrId)) {
    const info = await get(token, `conversations.info?channel=${encodeURIComponent(nameOrId)}`);
    const c = info.channel as { name?: string; is_private?: boolean } | undefined;
    return { id: nameOrId, name: c?.name ?? nameOrId, private: c?.is_private === true };
  }
  const want = nameOrId.replace(/^#/, "");
  for (const types of ["public_channel", "private_channel"]) {
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const q = `conversations.list?types=${types}&limit=200&team_id=${team}${cursor ? `&cursor=${cursor}` : ""}`;
      const r = await get(token, q);
      const list = (r.channels as Array<{ id: string; name: string; is_private?: boolean }>) ?? [];
      const hit = list.find((c) => c.name === want);
      if (hit) return { id: hit.id, name: hit.name, private: types === "private_channel" };
      cursor = String((r.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "");
      if (cursor === "") break;
    }
  }
  return die(`no channel named "${want}" is visible to this login`);
}

// --- the run ---------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
// A positional that is not some flag's value. Written out rather than clever,
// because a wrong guess here creates a real Slack app under the wrong name.
const VALUED_FLAGS = new Set(["--channel", "--team", "--app-name", "--description", "--long-description", "--icon"]);
const agent = (() => {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) continue;
    if (i > 0 && VALUED_FLAGS.has(argv[i - 1]!)) continue;
    return a;
  }
  return undefined;
})();
const appName = flag("app-name") ?? agent;
const description = flag("description");
const longDescription = flag("long-description");
const iconPath = flag("icon");

if (argv.includes("--print-manifest")) {
  console.log(JSON.stringify(manifestFor(appName ?? agent ?? "scramble-agent"), null, 2));
  process.exit(0);
}
if (agent === undefined || appName === undefined) {
  die(
    "usage: bun scripts/onboard-agent.ts <agent-name> [--app-name <name>] " +
      "[--channel <name|id>] [--team <T…>]",
  );
}

const { token } = configToken();
const team = await resolveTeam(token, flag("team"));

/** Upload the app's avatar. `apps.icon.set` takes the image in a `file` form
 *  field, and the manifest cannot carry an icon at all: measured, a manifest with
 *  an `icon` property is rejected as an `invalid additional property`, and Slack
 *  answers `invalid_icon_size` to anything under 512 by 512. */
async function setIcon(appId: string, path: string): Promise<void> {
  if (!existsSync(path)) die(`no icon file at ${path}`);
  const form = new FormData();
  form.set("app_id", appId);
  form.set("file", new Blob([readFileSync(path)]), path.split("/").pop() ?? "icon.png");
  const res = await fetch("https://slack.com/api/apps.icon.set", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const j = (await res.json()) as { ok?: boolean; error?: string };
  if (j.ok !== true) {
    die(
      `apps.icon.set answered ${String(j.error)}. Slack wants a square PNG of at least ` +
        `512 by 512; anything smaller answers invalid_icon_size.`,
    );
  }
  console.log(`onboard: avatar set from ${path}`);
}

// AN AGENT THAT ALREADY HAS AN APP UPDATES IT. Running this again to change a
// description or an avatar must not create a second Slack app, so the appId in
// the agent's own config entry decides between update and create.
const existingCfg: { agents?: Record<string, { appId?: string }> } = existsSync(
  process.env.SCRAMBLE_SLACK_CONFIG ?? join(process.env.HOME ?? ".", ".config", "scramble", "slack.json"),
)
  ? (JSON.parse(
      readFileSync(
        process.env.SCRAMBLE_SLACK_CONFIG ?? join(process.env.HOME ?? ".", ".config", "scramble", "slack.json"),
        "utf8",
      ),
    ) as { agents?: Record<string, { appId?: string }> })
  : {};
const existingAppId = existingCfg.agents?.[agent]?.appId;
if (existingAppId !== undefined && existingAppId !== "") {
  console.log(`onboard: agent "${agent}" already owns app ${existingAppId}, updating it`);
  if (description !== undefined || longDescription !== undefined) {
    if (longDescription !== undefined && longDescription.length < LONG_DESCRIPTION_MIN) {
      die(
        `--long-description is ${longDescription.length} characters and Slack requires at ` +
          `least ${LONG_DESCRIPTION_MIN}. Say more, or leave it out.`,
      );
    }
    // READ THE MANIFEST BEFORE WRITING IT. apps.manifest.update REPLACES the
    // whole manifest, so sending one built from the flags alone wipes whatever
    // the flags did not mention: the first version of this code reset the app's
    // display name to the agent name and erased a long_description that was
    // already there. Export, patch only what was asked for, send that back.
    const exported = await api(token, "apps.manifest.export", { app_id: existingAppId });
    const current = (exported.manifest ?? {}) as Record<string, unknown>;
    const info = { ...((current.display_information ?? {}) as Record<string, unknown>) };
    // The bot's display_name is a SECOND place the name lives, and it is the one
    // that shows beside every message, so --app-name has to move both or the two
    // drift apart in exactly the way a reader notices.
    const features = { ...((current.features ?? {}) as Record<string, unknown>) };
    if (flag("app-name") !== undefined) {
      info.name = appName;
      features.bot_user = {
        ...((features.bot_user ?? {}) as Record<string, unknown>),
        display_name: appName,
      };
    }
    if (description !== undefined) info.description = description;
    if (longDescription !== undefined) info.long_description = longDescription;
    await api(token, "apps.manifest.update", {
      app_id: existingAppId,
      manifest: { ...current, display_information: info, features },
    });
    console.log(
      `onboard: updated${description !== undefined ? " description" : ""}` +
        `${longDescription !== undefined ? " long_description" : ""}, ` +
        `keeping the name and every field not passed`,
    );
  }
  if (iconPath !== undefined) await setIcon(existingAppId, iconPath);

  // SCOPES ARE RECONCILED EVERY RUN, with no flag. The list above is what a
  // scramble agent needs, so an app installed before a scope was added is behind
  // and its owner cannot tell from the outside: the missing scope shows up as a
  // one-word error from an unrelated call. Comparing and reinstalling is cheap,
  // and the reinstall hands back the token carrying the new scope.
  const exported = await api(token, "apps.manifest.export", { app_id: existingAppId });
  const cur = (exported.manifest ?? {}) as Record<string, unknown>;
  const curScopes = new Set(
    ((((cur.oauth_config ?? {}) as Record<string, unknown>).scopes as Record<string, unknown> | undefined)
      ?.bot as string[] | undefined) ?? [],
  );
  const want = SCOPES.map(([sc]) => sc);
  // ORG DEPLOY IS RECONCILED TOO. An app created before this was understood
  // declares org_deploy_enabled:false while being installed org-wide, which
  // Slack accepts while delivering no events at all, so the agent's inbox is
  // dead and nothing says so. Repaired on the same run as the scopes.
  const settingsNow = (cur.settings ?? {}) as Record<string, unknown>;
  const orgDeployBroken = settingsNow.org_deploy_enabled !== true;
  if (orgDeployBroken) {
    console.log("onboard: this app declares org_deploy_enabled:false, which silently kills its event delivery");
    await api(token, "apps.manifest.update", {
      app_id: existingAppId,
      manifest: { ...cur, settings: { ...settingsNow, org_deploy_enabled: true } },
    });
  }

  const missing = want.filter((sc) => !curScopes.has(sc));
  if (missing.length > 0 || orgDeployBroken) {
    if (missing.length > 0) console.log(`onboard: this app is missing ${missing.length} scope(s): ${missing.join(", ")}`);
    if (missing.length > 0) {
      const oauth = { ...((cur.oauth_config ?? {}) as Record<string, unknown>) };
      oauth.scopes = { ...((oauth.scopes ?? {}) as Record<string, unknown>), bot: want };
      await api(token, "apps.manifest.update", {
        app_id: existingAppId,
        manifest: { ...cur, oauth_config: oauth, settings: { ...settingsNow, org_deploy_enabled: true } },
      });
    }
    const re = await api(token, "apps.developerInstall", {
      app_id: existingAppId,
      bot_scopes: want,
      team_id: team,
    });
    const fresh = (re.api_access_tokens as { bot?: string; app_level?: string } | undefined) ?? {};
    if (fresh.bot !== undefined && fresh.bot !== "") {
      const cfgP =
        process.env.SCRAMBLE_SLACK_CONFIG ??
        join(process.env.HOME ?? ".", ".config", "scramble", "slack.json");
      const c = JSON.parse(readFileSync(cfgP, "utf8")) as {
        agents?: Record<string, { token?: string; appToken?: string; appId?: string; handle?: string }>;
      };
      c.agents = c.agents ?? {};
      c.agents[agent] = {
        ...(c.agents[agent] ?? {}),
        token: fresh.bot,
        ...(fresh.app_level !== undefined && fresh.app_level !== "" ? { appToken: fresh.app_level } : {}),
        appId: existingAppId,
      };
      writeFileSync(cfgP, `${JSON.stringify(c, null, 2)}\n`);
      chmodSync(cfgP, 0o600);
      console.log("onboard: reinstalled with the full scope list, config updated with the fresh token");
    }
  }

  if (
    description === undefined &&
    longDescription === undefined &&
    iconPath === undefined &&
    missing.length === 0 &&
    !orgDeployBroken
  ) {
    console.log("onboard: nothing to change. Scopes already match, and no --description or --icon was passed.");
  }
  process.exit(0);
}

console.log(`onboard: creating the app "${appName}" as a WORKSPACE app for agent "${agent}"`);
if (longDescription !== undefined && longDescription.length < LONG_DESCRIPTION_MIN) {
  die(
    `--long-description is ${longDescription.length} characters and Slack requires at least ` +
      `${LONG_DESCRIPTION_MIN}. Say more, or leave it out.`,
  );
}
const created = await api(token, "apps.manifest.create", {
  manifest: manifestFor(appName, description, longDescription),
  team_id: team,
});
const appId = String(created.app_id);
console.log(`onboard: app ${appId} created`);

const installed = await api(token, "apps.developerInstall", {
  app_id: appId,
  bot_scopes: SCOPES.map(([s]) => s),
  team_id: team,
});
const tokens = installed.api_access_tokens as { bot?: string; app_level?: string } | undefined;
const botToken = tokens?.bot;
const appToken = tokens?.app_level;
if (botToken === undefined || botToken === "") die("developerInstall returned no bot token");
console.log(`onboard: installed to ${team}, bot token and app-level token received`);

if (iconPath !== undefined) await setIcon(appId, iconPath);
const who = await get(botToken, "auth.test");
console.log(`onboard: the bot is @${String(who.user)} (${String(who.bot_id)})`);

// The channel. AN AGENT DOES NOT JOIN A CHANNEL, whether it is public or
// private: a member invites it. The channel mapping is written either way, so
// the agent works the moment the invite lands, with nothing to re-run.
let channelName: string | undefined;
let channelId: string | undefined;
const wanted = flag("channel");
if (wanted !== undefined && wanted !== "") {
  const ch = await resolveChannel(token, team, wanted);
  channelId = ch.id;
  channelName = ch.name;
  console.log(
    `onboard: the one human operation left is the invite. In #${ch.name}, a member runs\n` +
      `           /invite @${String(who.user)}`,
  );
}

// The config, merged so a machine can hold several agents, and never printed.
const cfgPath =
  process.env.SCRAMBLE_SLACK_CONFIG ?? join(process.env.HOME ?? ".", ".config", "scramble", "slack.json");
type Cfg = {
  token?: string;
  appToken?: string;
  channels?: Record<string, string>;
  agents?: Record<string, { token?: string; appToken?: string; appId?: string; handle?: string }>;
  roster?: Record<string, string>;
  dmChannels?: Record<string, string>;
};
const cfg: Cfg = existsSync(cfgPath) ? (JSON.parse(readFileSync(cfgPath, "utf8")) as Cfg) : {};
// The APP ID is recorded beside the tokens, because an agent that cannot name
// its own app cannot change its own scopes (apps.manifest.update) or remove it
// (apps.manifest.delete). Recovering it afterwards took a bots.info lookup
// through a DIFFERENT agent's token, which the design should not need.
cfg.agents = {
  ...(cfg.agents ?? {}),
  [agent]: {
    token: botToken,
    ...(appToken !== undefined && appToken !== "" ? { appToken } : {}),
    appId,
    // The HANDLE, which is not the agent's name: Slack resolves a mention to
    // `scramble_dev` while this agent is `scramble-dev`, and without recording
    // the alias a real mention arrives with mentioned:false and the wake path
    // sleeps through it.
    handle: String(who.user),
  },
};
cfg.token = cfg.token ?? botToken;
if (appToken !== undefined && appToken !== "") cfg.appToken = cfg.appToken ?? appToken;
if (channelId !== undefined && channelName !== undefined) {
  cfg.channels = { ...(cfg.channels ?? {}), [channelName]: channelId };
}
cfg.roster = { ...(cfg.roster ?? {}), [String(who.user_id)]: String(who.user) };
mkdirSync(dirname(cfgPath), { recursive: true });
writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
chmodSync(cfgPath, 0o600);
console.log(`onboard: wrote ${cfgPath} (mode 600, outside the repo)`);

// Verify with the product, not with the API: a read is what the agent will run.
if (channelName !== undefined) {
  const p = Bun.spawn(["bun", "src/bin.ts", "message", "read", "--target", channelName, "--as", agent], {
    env: { ...process.env, SCRAMBLE_BACKEND: "slack" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  const lines = out.split("\n").filter((l) => l.startsWith("{")).length;
  console.log(`onboard: verify read exit ${code}, ${lines} line(s)${err.trim() ? `, stderr: ${err.trim().split("\n")[0]}` : ""}`);
  if (code !== 0) {
    console.log(
      `onboard: the read is refused until the invite lands, which is expected. Run it\n` +
        `         again after the /invite above to confirm.`,
    );
  }
}
console.log(
  `onboard: done. ${agent} can now run:\n` +
    `  SCRAMBLE_BACKEND=slack scramble message send --target ${channelName ?? "<channel>"} --as ${agent}`,
);
