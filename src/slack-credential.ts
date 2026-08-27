// src/slack-credential.ts: THE SLACK CLI'S APP-CONFIG CREDENTIAL, kept fresh.
//
// `doctor` reads an app's manifest to check its scopes and its subscribed
// events, and that call takes the `xoxe.xoxp` app-config token the Slack CLI
// writes to ~/.slack/credentials.json. The token lives TWELVE HOURS.
//
// Nothing on either host rotated it, so doctor lost the manifest check twice a
// day on every machine, and the fix on offer was a person running `slack login`
// again. An agent read the expiry out of the file and named the real root: the
// entry carries a `refresh_token`, and `tooling.tokens.rotate` exchanges it for
// a fresh pair. A login writes a credential that dies tonight; rotation keeps
// it alive without anybody.

import { renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROTATE_URL = "https://slack.com/api/tooling.tokens.rotate";

/** Seconds of remaining life below which the token is treated as spent. Slack
 *  gives 12 hours; a minute of slack covers a call that starts just before the
 *  boundary and reaches Slack just after it. */
const MIN_LIFE_SECONDS = 60;

export interface CliCredential {
  /** The credentials.json key, which is the team or enterprise id. Named in
   *  every failure so a person knows which entry to look at, and never the
   *  token itself. */
  key: string;
  token: string;
  refreshToken: string;
  /** Unix seconds. 0 when the file carries no expiry. */
  exp: number;
}

/** The first entry carrying a token, which is the entry `declaredManifest` has
 *  always used. */
export function firstCredential(fileText: string): { ok: true; cred: CliCredential } | { ok: false; why: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileText);
  } catch {
    return { ok: false, why: "the credentials file is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, why: "the credentials file is not an object" };
  for (const [key, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) continue;
    const row = v as { token?: unknown; refresh_token?: unknown; exp?: unknown };
    if (typeof row.token !== "string" || row.token === "") continue;
    return {
      ok: true,
      cred: {
        key,
        token: row.token,
        refreshToken: typeof row.refresh_token === "string" ? row.refresh_token : "",
        exp: typeof row.exp === "number" ? row.exp : 0,
      },
    };
  }
  return { ok: false, why: "no entry in the credentials file carries a token" };
}

/** Has this credential got useful life left? An entry with no `exp` is taken at
 *  face value: the file predates the field, and a rotation attempt on a live
 *  token would spend a refresh token for nothing. */
export function stillGood(cred: CliCredential, nowSeconds: number): boolean {
  return cred.exp === 0 || cred.exp - nowSeconds > MIN_LIFE_SECONDS;
}

/** The file text with ONE entry's token, refresh token and expiry replaced.
 *
 *  Every other field of that entry and every other entry survive untouched:
 *  this file belongs to the Slack CLI, it holds credentials for whatever else
 *  the login owns, and a rewrite that dropped a key would take those with it. */
export function withRotated(
  fileText: string,
  key: string,
  fresh: { token: string; refreshToken: string; exp: number },
  stampedAt: string,
): string {
  const parsed = JSON.parse(fileText) as Record<string, Record<string, unknown>>;
  const row = parsed[key] ?? {};
  parsed[key] = {
    ...row,
    token: fresh.token,
    refresh_token: fresh.refreshToken,
    exp: fresh.exp,
    last_updated: stampedAt,
  };
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/** What Slack returned for a rotate call, read defensively. */
export function rotatedFrom(body: unknown): { token: string; refreshToken: string; exp: number } | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as { ok?: unknown; token?: unknown; refresh_token?: unknown; exp?: unknown };
  if (b.ok !== true || typeof b.token !== "string" || typeof b.refresh_token !== "string") return undefined;
  return { token: b.token, refreshToken: b.refresh_token, exp: typeof b.exp === "number" ? b.exp : 0 };
}

export function credentialsPath(home: string): string {
  return join(home, ".slack", "credentials.json");
}

/** A usable app-config token, rotating it first when the stored one is spent.
 *
 *  THE WRITE IS ATOMIC AND IT HAPPENS BEFORE THE TOKEN IS USED. Slack retires
 *  the old refresh token the moment it issues a new pair, so a rotation whose
 *  result never reaches disk destroys the credential. Written to a temporary
 *  file in the same directory and renamed over the original, so a reader sees
 *  the old file or the new one. */
export async function freshCliToken(
  fileText: string,
  path: string,
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
  nowSeconds: number,
  stampedAt: string,
): Promise<{ ok: true; token: string; rotated: boolean } | { ok: false; why: string }> {
  const found = firstCredential(fileText);
  if (!found.ok) return { ok: false, why: `${found.why} (${path})` };
  const cred = found.cred;
  if (stillGood(cred, nowSeconds)) return { ok: true, token: cred.token, rotated: false };
  const expired = cred.exp === 0 ? "unknown" : new Date(cred.exp * 1000).toISOString();
  if (cred.refreshToken === "") {
    return {
      ok: false,
      why:
        `the app-config token for ${cred.key} in ${path} expired at ${expired} and the entry carries ` +
        `no refresh_token, so it cannot be rotated. Someone with the Slack app login runs \`slack login\` ` +
        `on this host.`,
    };
  }
  let res: Response;
  try {
    res = await fetch(`${ROTATE_URL}?refresh_token=${encodeURIComponent(cred.refreshToken)}`, { method: "POST" });
  } catch {
    return { ok: false, why: `the rotate call for ${cred.key} did not reach Slack, and the token expired at ${expired}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, why: `Slack answered the rotate call for ${cred.key} with something other than JSON` };
  }
  const fresh = rotatedFrom(body);
  if (fresh === undefined) {
    const err = (body as { error?: unknown }).error;
    return {
      ok: false,
      why:
        `Slack refused to rotate the token for ${cred.key} (${typeof err === "string" ? err : "no error named"}), ` +
        `and the stored one expired at ${expired}. Someone with the Slack app login runs \`slack login\` on this host.`,
    };
  }
  try {
    const tmp = `${path}.rotating`;
    writeFileSync(tmp, withRotated(fileText, cred.key, fresh, stampedAt), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    // THE NEW PAIR EXISTS AND THE OLD ONE IS DEAD. Saying so is the whole job of
    // this branch: a caller that reads "rotated" here and loses the write would
    // find the credential gone on the next run with nothing explaining it.
    return {
      ok: false,
      why:
        `the token for ${cred.key} was rotated and the new pair COULD NOT BE WRITTEN to ${path} ` +
        `(${String(e)}), so the old refresh token is now dead and this host needs \`slack login\`. ` +
        `The directory is ${dirname(path)}.`,
    };
  }
  return { ok: true, token: fresh.token, rotated: true };
}
