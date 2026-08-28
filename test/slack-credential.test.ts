import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  credentialsPath,
  firstCredential,
  freshCliToken,
  rotatedFrom,
  stillGood,
  withRotated,
} from "../src/slack-credential";

function scratch(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `scramble-cred-${name}-`));
  mkdirSync(join(d, ".slack"), { recursive: true });
  return d;
}

const FILE = JSON.stringify(
  {
    E01EXAMPLE1: {
      token: "xoxe.xoxp-old",
      refresh_token: "xoxe-refresh-old",
      exp: 1787402756,
      team_id: "E01EXAMPLE1",
      user_id: "U01EXAMPLE01",
      team_domain: "examplecorp",
    },
  },
  null,
  2,
);

describe("the Slack app-config credential", () => {
  test("the first entry with a token is the one used, with its key and expiry", () => {
    const got = firstCredential(FILE);
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.cred.key).toBe("E01EXAMPLE1");
      expect(got.cred.exp).toBe(1787402756);
      expect(got.cred.refreshToken).toBe("xoxe-refresh-old");
    }
    // An entry without a token is skipped. An empty return would name it as usable.
    const skipped = firstCredential(JSON.stringify({ A: { token: "" }, B: { token: "t" } }));
    expect(skipped.ok && skipped.cred.key).toBe("B");
    expect(firstCredential("not json").ok).toBe(false);
    expect(firstCredential("[1,2]").ok).toBe(false);
    expect(firstCredential("{}").ok).toBe(false);
  });

  test("a token inside its last minute counts as spent, and one with no expiry counts as live", () => {
    const cred = { key: "K", token: "t", refreshToken: "r", exp: 1000 };
    expect(stillGood(cred, 800)).toBe(true);
    expect(stillGood(cred, 960)).toBe(false);
    expect(stillGood(cred, 2000)).toBe(false);
    // No `exp` at all: the file predates the field and a rotation would spend a
    // refresh token for nothing.
    expect(stillGood({ ...cred, exp: 0 }, 99999)).toBe(true);
  });

  test("a rotation keeps every other field and every other entry", () => {
    const two = JSON.stringify({ A: { token: "a", keep: 1 }, B: { token: "b" } });
    const out = JSON.parse(withRotated(two, "A", { token: "a2", refreshToken: "r2", exp: 9 }, "STAMP"));
    expect(out.A).toEqual({ token: "a2", keep: 1, refresh_token: "r2", exp: 9, last_updated: "STAMP" });
    expect(out.B).toEqual({ token: "b" });
  });

  test("rotatedFrom reads Slack's answer defensively", () => {
    expect(rotatedFrom({ ok: true, token: "t", refresh_token: "r", exp: 5 })).toEqual({
      token: "t",
      refreshToken: "r",
      exp: 5,
    });
    expect(rotatedFrom({ ok: true, token: "t", refresh_token: "r" })?.exp).toBe(0);
    expect(rotatedFrom({ ok: false, error: "invalid_refresh_token" })).toBeUndefined();
    expect(rotatedFrom({ ok: true, token: "t" })).toBeUndefined();
    expect(rotatedFrom("nope")).toBeUndefined();
    expect(rotatedFrom(null)).toBeUndefined();
  });

  test("a live token is returned untouched, and no call is made", async () => {
    const home = scratch("live");
    const path = credentialsPath(home);
    writeFileSync(path, FILE);
    let called = false;
    const got = await freshCliToken(
      FILE,
      path,
      async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
      1787402000,
      "STAMP",
    );
    expect(got).toEqual({ ok: true, token: "xoxe.xoxp-old", rotated: false });
    expect(called).toBe(false);
  });

  test("a spent token is rotated and the new pair reaches disk before it is used", async () => {
    // Slack retires the old refresh token the moment it issues a new pair, so a
    // rotation whose result is never written destroys the credential.
    const home = scratch("rotate");
    const path = credentialsPath(home);
    writeFileSync(path, FILE);
    let asked = "";
    const got = await freshCliToken(
      FILE,
      path,
      async (u) => {
        asked = u;
        return new Response(
          JSON.stringify({ ok: true, token: "xoxe.xoxp-new", refresh_token: "xoxe-refresh-new", exp: 1787500000 }),
          { status: 200 },
        );
      },
      1787999999,
      "STAMP",
    );
    expect(got).toEqual({ ok: true, token: "xoxe.xoxp-new", rotated: true });
    expect(asked).toContain("tooling.tokens.rotate");
    expect(asked).toContain("xoxe-refresh-old");
    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    expect(onDisk.E01EXAMPLE1.token).toBe("xoxe.xoxp-new");
    expect(onDisk.E01EXAMPLE1.refresh_token).toBe("xoxe-refresh-new");
    expect(onDisk.E01EXAMPLE1.exp).toBe(1787500000);
    // The fields the Slack CLI put there are still there.
    expect(onDisk.E01EXAMPLE1.team_domain).toBe("examplecorp");
  });

  test("every failure names the entry, the file, and who has to act", async () => {
    const home = scratch("sad");
    const path = credentialsPath(home);
    writeFileSync(path, FILE);
    const at = 1787999999;

    const noRefresh = await freshCliToken(
      JSON.stringify({ K: { token: "t", exp: 1 } }),
      path,
      async () => new Response("{}", { status: 200 }),
      at,
      "STAMP",
    );
    expect(noRefresh.ok).toBe(false);
    expect(noRefresh.ok === false && noRefresh.why).toContain("no refresh_token");
    expect(noRefresh.ok === false && noRefresh.why).toContain("slack login");

    const netDown = await freshCliToken(
      FILE,
      path,
      async () => {
        throw new Error("net down");
      },
      at,
      "STAMP",
    );
    expect(netDown.ok === false && netDown.why).toContain("did not reach Slack");

    const notJson = await freshCliToken(FILE, path, async () => new Response("nope", { status: 200 }), at, "STAMP");
    expect(notJson.ok === false && notJson.why).toContain("other than JSON");

    const refused = await freshCliToken(
      FILE,
      path,
      async () => new Response(JSON.stringify({ ok: false, error: "invalid_refresh_token" }), { status: 200 }),
      at,
      "STAMP",
    );
    expect(refused.ok === false && refused.why).toContain("invalid_refresh_token");
    expect(refused.ok === false && refused.why).toContain("E01EXAMPLE1");

    const badFile = await freshCliToken("{}", path, async () => new Response("{}", { status: 200 }), at, "STAMP");
    expect(badFile.ok === false && badFile.why).toContain("no entry");

    // The write failing is the dangerous case: the old refresh token is dead by
    // then, and the report has to say so.
    const unwritable = await freshCliToken(
      FILE,
      join(home, "no-such-dir", "credentials.json"),
      async () =>
        new Response(JSON.stringify({ ok: true, token: "t2", refresh_token: "r2", exp: 9 }), { status: 200 }),
      at,
      "STAMP",
    );
    expect(unwritable.ok).toBe(false);
    expect(unwritable.ok === false && unwritable.why).toContain("COULD NOT BE WRITTEN");
    expect(unwritable.ok === false && unwritable.why).toContain("old refresh token is now dead");
  });
});
