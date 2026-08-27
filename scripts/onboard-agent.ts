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

// The scopes and events the app declares live in src/app-manifest.ts, which
// `doctor` reads too. They were duplicated here once and the two copies drifted.
import { SCOPES, SCOPE_NAMES, BOT_EVENT_NAMES } from "../src/app-manifest";

/** Slack's own constraint, measured: a `long_description` under 175 characters
 *  is rejected with
 *  `failed_constraint … min_length expected 175`, so a short one is padded out
 *  by the caller rather than silently dropped. */
const LONG_DESCRIPTION_MIN = 175;

/** The name Slack shows BESIDE MESSAGES, which has to convert to a username.
 *
 * Slack refuses a manifest whose `features.bot_user.display_name` is not
 * convertible: `bad_username`, "The display_name cannot be converted to a
 * username". An agent measured it creating an app with a CJK name, and the
 * failure named neither the field nor the reason, because --app-name was
 * written into BOTH display_information.name and this one.
 *
 *  A name can also never be fixed afterwards: `users.profile:write` is not a
 *  valid bot scope and users.profile.set answers not_allowed_token_type, so the
 *  agent cannot set its own display name after install.
 *
 *  So the app NAME keeps whatever was asked for, and this falls back to the
 *  agent's own name, which is ASCII by construction.
 *
 *  CONFIRMED AGAINST A LIVE APP IN THAT STATE, which a fresh create cannot show:
 *  the same agent set a CJK app name with apps.manifest.update after creating,
 *  then reinstalled, and the app name did NOT propagate to the bot user;
 *  users.info still answered real_name xingyu-bot with an empty display_name.
 *  The split is what Slack DOES, and it survives a reinstall. */
function botDisplayName(appName: string, agentName: string): string {
  return /^[\x20-\x7E]+$/.test(appName) ? appName : agentName;
}

function manifestFor(
  name: string,
  description?: string,
  longDescription?: string,
  agentName?: string,
): Record<string, unknown> {
  return {
    display_information: {
      name,
      ...(description !== undefined && description !== "" ? { description } : {}),
      ...(longDescription !== undefined && longDescription.length >= LONG_DESCRIPTION_MIN
        ? { long_description: longDescription }
        : {}),
    },
    features: { bot_user: { display_name: botDisplayName(name, agentName ?? name), always_online: false } },
    oauth_config: { scopes: { bot: SCOPE_NAMES } },
    settings: {
      event_subscriptions: { bot_events: BOT_EVENT_NAMES },
      socket_mode_enabled: true,
      token_rotation_enabled: false,
      // TRUE, and this field decides whether the agent's inbox works at all.
      // `apps.developerInstall` with an org-level credential produces an
      // ENTERPRISE install (auth.test: is_enterprise_install true) whatever
      // team_id is passed. An app installed that way while declaring
      // org_deploy_enabled:false is a contradiction Slack ACCEPTS in silence:
      // the tokens work, every REST call works, the socket opens and says
      // hello, and no event is ever delivered. Measured by flipping this one
      // field on a live app: messages began arriving on the socket seconds
      // later, from a bot and from a human.
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
        `  2. run \`slack login\` INTERACTIVELY and paste the /slackauthticket command\n` +
        `     it prints into Slack, then give it the code Slack shows.\n` +
        `     NOT \`slack login --no-prompt\`: that prints a ticket and exits, and the\n` +
        `     ticket expires faster than a person can paste it and read the code back.\n` +
        `     A remote agent hit this three times in a row. Interactive\n` +
        `     login holds the process open and has no such window.`,
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
    if (err === "no_permission" && method === "apps.manifest.export") {
      die(
        `this login cannot read app ${String(body.app_id)}, so scramble cannot check or repair\n` +
          `its scopes and events. That app was created by someone else, and onboarding an agent\n` +
          `onto a foreign app leaves the two things delivery needs outside anyone's reach here:\n` +
          `the four bot events (message.channels, message.groups, message.im,\n` +
          `member_joined_channel) and the scope list. A fourth agent hit exactly this\n` +
          `: reads worked, 14 lines came back, and no message could ever arrive.\n` +
          `Either have the app's owner add them, or let this script create an app for the\n` +
          `agent by removing its entry from the config and running again.`,
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
  console.log(JSON.stringify(manifestFor(appName ?? agent ?? "scramble-agent", undefined, undefined, agent), null, 2));
  process.exit(0);
}
if (agent === undefined || appName === undefined) {
  die(
    "usage: bun scripts/onboard-agent.ts <agent-name> [--app-name <name>] " +
      "[--channel <name|id>] [--team <T…>]",
  );
}

// ADOPTING AN APP YOU ALREADY HOLD A TOKEN FOR.
//
//   bun scripts/onboard-agent.ts <agent> --adopt <xoxb-token> [--app-token <xapp-token>]
//
// There was no way to do this. The update-or-create branch reads the config
// entry alone, so an agent handed credentials for an existing app had to
// hand-write four fields into the config: token, appToken, appId and handle. A
// fourth agent did exactly that and reported it, including the trap: "a wrong
// handle fails silently, since the handle is what mention detection keys on".
// Every one of those four is knowable from the token, so none of them should be
// typed by anyone.
const adoptToken = flag("adopt");
if (adoptToken !== undefined && adoptToken !== "") {
  const who = await get(adoptToken, "auth.test");
  if (who.ok !== true) die(`--adopt token is not usable: auth.test answered ${String(who.error)}`);
  const handleFor = String(who.user);
  const userId = String(who.user_id);
  const info = await get(adoptToken, `users.info?user=${encodeURIComponent(userId)}`);
  const appId =
    info.ok === true
      ? String((info.user as { profile?: { api_app_id?: string } } | undefined)?.profile?.api_app_id ?? "")
      : "";
  if (appId === "") {
    die(
      `the --adopt token works and belongs to @${handleFor}, and users.info did not give an\n` +
        `api_app_id for it, so this agent cannot name its own app. Without an app id nothing\n` +
        `here can check or repair the scopes and events that decide whether delivery works.`,
    );
  }
  const cfgPath2 =
    process.env.SCRAMBLE_SLACK_CONFIG ?? join(process.env.HOME ?? ".", ".config", "scramble", "slack.json");
  const existing2 = existsSync(cfgPath2)
    ? (JSON.parse(readFileSync(cfgPath2, "utf8")) as Record<string, unknown>)
    : {};
  const agents2 = (existing2.agents ?? {}) as Record<string, Record<string, unknown>>;
  const appTok = flag("app-token");
  agents2[agent] = {
    ...(agents2[agent] ?? {}),
    token: adoptToken,
    ...(appTok !== undefined && appTok !== "" ? { appToken: appTok } : {}),
    appId,
    // READ FROM SLACK, never typed. The handle is what mention detection keys on,
    // and a wrong one fails silently.
    handle: handleFor,
  };
  existing2.agents = agents2;
  const roster2 = (existing2.roster ?? {}) as Record<string, string>;
  roster2[userId] = handleFor;
  existing2.roster = roster2;
  mkdirSync(dirname(cfgPath2), { recursive: true });
  writeFileSync(cfgPath2, `${JSON.stringify(existing2, null, 2)}\n`);
  chmodSync(cfgPath2, 0o600);
  console.log(`onboard: adopted app ${appId} for "${agent}" as @${handleFor}, config written`);
  if (appTok === undefined || appTok === "") {
    console.log(
      `onboard: no --app-token given, so this agent has NO socket credential and its\n` +
        `         listener cannot run. Reads and sends work; nothing will wake it.`,
    );
  }
  console.log(
    `onboard: whether delivery works depends on that app's events and scopes, which are the\n` +
      `         app owner's to set. Run: scramble doctor --as ${agent} --wake <channel>`,
  );
  process.exit(0);
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
const existingCfg: { agents?: Record<string, { appId?: string; token?: string }> } = existsSync(
  process.env.SCRAMBLE_SLACK_CONFIG ?? join(process.env.HOME ?? ".", ".config", "scramble", "slack.json"),
)
  ? (JSON.parse(
      readFileSync(
        process.env.SCRAMBLE_SLACK_CONFIG ?? join(process.env.HOME ?? ".", ".config", "scramble", "slack.json"),
        "utf8",
      ),
    ) as { agents?: Record<string, { appId?: string; token?: string }> })
  : {};

/** The app behind a bot TOKEN. auth.test names the bot's user, and that user's
 *  profile carries `api_app_id`, so an agent whose config predates the appId
 *  field can still find its own app instead of being read as a new agent.
 *
 *  THIS EXISTS BECAUSE THE ABSENCE OF ONE FIELD MEANT "CREATE". Two agents in
 *  this config were made by hand before appId was recorded, and running onboard
 *  on them built two NEW Slack apps: `akari` became @akari2, a bot in no
 *  channel, and the config's copy of the working token was overwritten with the
 *  new one. Everything was recoverable — the original apps still existed and
 *  users.info gave their ids back — but nothing about the run said a second app
 *  was about to be born. A missing record is a question to answer, not a licence
 *  to create. */
async function appIdBehindToken(botToken: string): Promise<string> {
  const who = await get(botToken, "auth.test");
  if (who.ok !== true) return "";
  const info = await get(botToken, `users.info?user=${encodeURIComponent(String(who.user_id))}`);
  if (info.ok !== true) return "";
  const profile = (info.user as { profile?: { api_app_id?: string } } | undefined)?.profile;
  return typeof profile?.api_app_id === "string" ? profile.api_app_id : "";
}

const recordedAppId = existingCfg.agents?.[agent]?.appId;
const recordedToken = existingCfg.agents?.[agent]?.token;
let existingAppId = recordedAppId;
if ((existingAppId === undefined || existingAppId === "") && recordedToken !== undefined && recordedToken !== "") {
  const found = await appIdBehindToken(recordedToken);
  if (found === "") {
    die(
      `agent "${agent}" already has a bot token in the config but no appId, and the app behind\n` +
        `that token could not be read (auth.test or users.info refused it). Creating an app now\n` +
        `would make a SECOND bot under this name and overwrite the working token, so nothing was\n` +
        `done. Either fix the token, or remove the "${agent}" entry to start it fresh.`,
    );
  }
  console.log(`onboard: agent "${agent}" had no appId recorded; its token belongs to ${found}, updating that`);
  existingAppId = found;
}
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

  // THE WHOLE DECLARATION IS RECONCILED EVERY RUN, with no flag: scopes, events
  // and org deployment, compared against src/app-manifest.ts in ONE pass. An app
  // created before any of them was added is behind, and its owner cannot tell
  // from the outside — a missing scope shows up as a one-word error from an
  // unrelated call, and a missing EVENT shows up as nothing at all. This was
  // three separate branches and the third was never written, which is how
  // member_joined_channel reached the manifest that CREATES an app while every
  // app that already existed stayed subscribed to three events.
  const exported = await api(token, "apps.manifest.export", { app_id: existingAppId });
  const cur = (exported.manifest ?? {}) as Record<string, unknown>;
  const oauthNow = (cur.oauth_config ?? {}) as Record<string, unknown>;
  const settingsNow = (cur.settings ?? {}) as Record<string, unknown>;
  const subsNow = (settingsNow.event_subscriptions ?? {}) as Record<string, unknown>;
  const curScopes = new Set(((oauthNow.scopes as Record<string, unknown> | undefined)?.bot as string[]) ?? []);
  const curEvents = new Set((subsNow.bot_events as string[] | undefined) ?? []);
  const want = SCOPE_NAMES;

  const drift: string[] = [];
  const missing = want.filter((sc) => !curScopes.has(sc));
  if (missing.length > 0) drift.push(`missing ${missing.length} scope(s): ${missing.join(", ")}`);
  const missingEvents = BOT_EVENT_NAMES.filter((e) => !curEvents.has(e));
  if (missingEvents.length > 0) {
    drift.push(
      `not subscribed to ${missingEvents.join(", ")}. Slack sends NOTHING for an event an app ` +
        `does not subscribe to, so the socket opens, says hello, and stays quiet`,
    );
  }
  if (settingsNow.org_deploy_enabled !== true) {
    drift.push("declares org_deploy_enabled:false, which silently kills its event delivery");
  }

  // ADD, NEVER REPLACE. This list is what scramble needs, not the whole of what
  // the app is allowed to be: an app can hold scopes for features scramble knows
  // nothing about, and sending `want` as the entire list REMOVES them. Measured:
  // reconciling an older app whose manifest declares slash commands was rejected
  // outright, `requires_commands_bot_scope … pointer /features/slash_commands`,
  // because the replacement dropped `commands`. Slack caught that one; a scope
  // with no manifest feature behind it would have been dropped in silence.
  const unionScopes = [...new Set([...curScopes, ...want])];
  const unionEvents = [...new Set([...curEvents, ...BOT_EVENT_NAMES])];

  if (drift.length > 0) {
    for (const d of drift) console.log(`onboard: this app ${d}`);
    // ONE update carrying every repair. apps.manifest.update REPLACES the
    // manifest, so `cur` is spread and only the drifted fields are overwritten.
    await api(token, "apps.manifest.update", {
      app_id: existingAppId,
      manifest: {
        ...cur,
        oauth_config: {
          ...oauthNow,
          scopes: { ...((oauthNow.scopes ?? {}) as Record<string, unknown>), bot: unionScopes },
        },
        settings: {
          ...settingsNow,
          org_deploy_enabled: true,
          event_subscriptions: { ...subsNow, bot_events: unionEvents },
        },
      },
    });
    const re = await api(token, "apps.developerInstall", {
      app_id: existingAppId,
      bot_scopes: unionScopes,
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
    drift.length === 0
  ) {
    console.log(
      "onboard: nothing to change. Scopes, events and org deployment already match, and no --description or --icon was passed.",
    );
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
// NEITHER NAME CAN BE A USERNAME. Refused here, before the call, because Slack's
// own answer is `bad_username` with nothing pointing at which field, and there is
// no repair afterwards: users.profile:write is not a valid bot scope.
if (!/^[\x20-\x7E]+$/.test(agent) && !/^[\x20-\x7E]+$/.test(appName)) {
  die(
    `neither "${appName}" nor the agent name "${agent}" can be the name beside messages:\n` +
      `Slack requires a display name that converts to a username, and answers bad_username\n` +
      `for one that does not, without naming the field. Give the agent an ASCII name with\n` +
      `--as-style naming and keep the one you want in --app-name, which has no such limit.`,
  );
}
if (botDisplayName(appName, agent) !== appName) {
  console.log(
    `onboard: Slack cannot use "${appName}" as the name beside messages, since a display name\n` +
      `         must convert to a username and that one does not. The APP is named\n` +
      `         "${appName}" and messages will show "${agent}". Nothing can change that later:\n` +
      `         users.profile:write is not a valid bot scope.`,
  );
}
const created = await api(token, "apps.manifest.create", {
  manifest: manifestFor(appName, description, longDescription, agent),
  team_id: team,
});
const appId = String(created.app_id);
console.log(`onboard: app ${appId} created`);

const installed = await api(token, "apps.developerInstall", {
  app_id: appId,
  bot_scopes: SCOPE_NAMES,
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

/** Run a scramble verb and hand back everything it said. */
async function verb(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", "src/bin.ts", ...args], {
    env: { ...process.env, SCRAMBLE_BACKEND: "slack" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [o, e] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: o, err: e };
}

// VERIFY THE WAKE PATH, NOT THE READ PATH.
//
// This ended on a `message read` and called that verification. A fourth agent
// onboarded, got 14 lines from a read, reported success, and could receive
// nothing: its app subscribed to app_mention and to none of the four events
// delivery needs. Their words: "onboarding verifies the read path and never the
// wake path, so an agent can finish JOIN.md, report success, and receive
// nothing." They asked whether onboarding should end on `doctor --wake`. It
// should, and it does.
//
// A read proves the token and the invite. It says nothing about whether a
// message will ever arrive, and those are the two halves an agent needs.
if (channelName !== undefined) {
  const read = await verb(["message", "read", "--target", channelName, "--as", agent]);
  const lines = read.out.split("\n").filter((l) => l.startsWith("{")).length;
  console.log(`onboard: read ${read.code === 0 ? "works" : `refused (exit ${read.code})`}, ${lines} line(s)`);
  if (read.code !== 0) {
    console.log(
      `onboard: the read is refused until the invite lands, which is expected.\n` +
        `         Run this script again after the /invite above.`,
    );
  } else {
    const wake = await verb(["doctor", "--as", agent, "--wake", channelName]);
    if (wake.code === 0 && wake.out.includes('"doctor":"wake"')) {
      console.log(`onboard: the wake path DELIVERS. This agent will receive what is sent to it.`);
    } else {
      console.log(
        `onboard: THE WAKE PATH DID NOT DELIVER, and a read working says nothing about it.\n` +
          `         This agent can send and read, and a message addressed to it may never\n` +
          `         arrive. What the check said:\n` +
          (wake.err.trim() === "" ? "         (nothing on stderr)" : `         ${wake.err.trim().split("\n").join("\n         ")}`),
      );
    }
  }
}
console.log(
  `onboard: done. ${agent} can now run:\n` +
    `  SCRAMBLE_BACKEND=slack scramble message send --target ${channelName ?? "<channel>"} --as ${agent}`,
);
