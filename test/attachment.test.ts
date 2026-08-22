// test/attachment.test.ts — the attachment verbs against injected seams:
// the slack three-step upload flow ORDER, message send --attach, local
// upload + view, plus the pure attachments helpers. No token and no network:
// the slack `fetch` seam is a fake and file writes go to real temp dirs.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChannelStore } from "../src/store";
import { createStore } from "../src/store";
import { createHandler } from "../src/server";
import { main, type Io } from "../src/cli";
import {
  MAX_ATTACHMENT_BYTES,
  recordLocalUpload,
  findLocalRecord,
  sanitizeName,
  guessMime,
  downloadFile,
  uploadToSlack,
  newAttachmentId,
  isHtmlResponse,
  localPath,
  readIndex,
  writeIndex,
  sizeOf,
} from "../src/attachments";

function scratchDir(name: string): string {
  const d = join(tmpdir(), `att-${name}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}

function writeSlackCfg(cwd: string, filesDir: string): void {
  mkdirSync(join(cwd, ".scramble"), { recursive: true });
  writeFileSync(join(cwd, ".scramble", "slack.json"), JSON.stringify({
    token: "xoxb-app",
    appToken: "xapp-1",
    channels: { general: "C1" },
    agents: { alice: { token: "T_A" }, bob: {} },
    roster: {},
    dmChannels: {},
    filesDir,
  }));
}

type FetchSig = (input: string, init?: RequestInit) => Promise<Response>;

/** An io whose fetch is a fake slack fetcher and whose cwd holds a slack cfg. */
function slackIo(cwd: string, fetch: FetchSig): { io: Io; writes: string[]; errs: string[] } {
  const writes: string[] = [];
  const errs: string[] = [];
  const io: Io = {
    write: (l) => writes.push(l),
    writeErr: (l) => errs.push(l),
    fetch: (input, init) => Promise.resolve(fetch(String(input), init)),
    env: () => undefined,
    cwd: () => cwd,
    sleep: async () => {},
    serve: async () => 0,
    createSocket: () => ({ send: () => {}, close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }),
  };
  return { io, writes, errs };
}

/** An io for the LOCAL backend whose HOME is the given dir, and whose /
 *  SCRAMBLE_SLACK_CONFIG points at the workspace's <.scramble/slack.json>, so a
 *  file-backed verb (attachment upload / view) resolves attachmentsDirFor from
 *  the config's filesDir. */
function localIoExact(cwd: string): { io: Io; writes: string[]; errs: string[] } {
  const writes: string[] = [];
  const errs: string[] = [];
  const io: Io = {
    write: (l) => writes.push(l),
    writeErr: (l) => errs.push(l),
    fetch: async () => new Response("[]", { status: 200 }),
    env: (n) =>
      n === "HOME" ? cwd
      : n === "SCRAMBLE_SLACK_CONFIG" ? join(cwd, ".scramble", "slack.json")
      : undefined,
    cwd: () => cwd,
    sleep: async () => {},
    serve: async () => 0,
  };
  return { io, writes, errs };
}

// --- pure helper functions -----------------------------------------------

describe("attachments helpers", () => {
  test("sanitizeName strips path-unsafe characters and never returns empty", () => {
    expect(sanitizeName("my cat screenshot.png")).toBe("my_cat_screenshot.png");
    expect(sanitizeName("../../evil")).toBe("evil");
    expect(sanitizeName("...")).toBe("attachment");
  });

  test("guessMime maps known extensions and falls back to octet-stream", () => {
    expect(guessMime("/a/b.png")).toBe("image/png");
    expect(guessMime("/a/b.jpg")).toBe("image/jpeg");
    expect(guessMime("/a/b.pdf")).toBe("application/pdf");
    expect(guessMime("/a/b.unknownxyz")).toBe("application/octet-stream");
    expect(guessMime("/no-ext")).toBe("application/octet-stream");
  });

  test("sizeOf reports a file's byte size and -1 for a missing file", () => {
    const d = scratchDir("size");
    const f = join(d, "f.bin");
    writeFileSync(f, "abc");
    expect(sizeOf(f)).toBe(3);
    expect(sizeOf(join(d, "nope"))).toBe(-1);
  });

  test("MAX_ATTACHMENT_BYTES mirrors raft's 50MB cap", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(50 * 1024 * 1024);
  });

  test("isHtmlResponse flags a text/html header and HTML-looking bytes", () => {
    const res = new Response("<html>hi</html>", { headers: { "content-type": "text/html" } });
    expect(isHtmlResponse(res, new TextEncoder().encode("<html>hi</html>"))).toBe(true);
    const not = new Response("PNG", { headers: { "content-type": "image/png" } });
    expect(isHtmlResponse(not, new TextEncoder().encode("PNG"))).toBe(false);
    // an HTML-looking body even without the header is still caught
    const sniffed = new Response("", { headers: { "content-type": "application/octet-stream" } });
    expect(isHtmlResponse(sniffed, new TextEncoder().encode("<!doctype html><html>"))).toBe(true);
    // a `<head>`-prefixed body is caught too
    expect(isHtmlResponse(new Response("", { headers: { "content-type": "application/octet-stream" } }), new TextEncoder().encode("<head></head>"))).toBe(true);
    // a fully binary body is NOT html
    expect(isHtmlResponse(new Response("", { headers: { "content-type": "image/png" } }), new TextEncoder().encode("\x89PNG\r\n"))).toBe(false);
  });
});

// --- the local/uploads ledger ---------------------------------------------

describe("the local attachment ledger", () => {
  test("recordLocalUpload copies the file, records it, and findLocalRecord finds it", () => {
    const dir = scratchDir("ledger");
    const src = join(dir, "photo.png");
    writeFileSync(src, "PNG-DATA");
    const rec = recordLocalUpload(dir, src);
    expect(rec.ok).toBe(true);
    if (rec.ok) {
      expect(existsSync(rec.record.path)).toBe(true);
      expect(readFileSync(rec.record.path, "utf8")).toBe("PNG-DATA");
      expect(rec.record.mime).toBe("image/png");
      const found = findLocalRecord(dir, rec.record.id);
      expect(found?.id).toBe(rec.record.id);
      expect(found?.path).toBe(rec.record.path);
      // localPath builds the same dest the ledger recorded
      expect(localPath(dir, rec.record.id, rec.record.name)).toBe(rec.record.path);
      // the index round-trips
      const index = readIndex(dir);
      expect(index[rec.record.id]).toBeDefined();
      writeIndex(dir, rec.record);
    }
  });

  test("a missing source is refused", () => {
    const dir = scratchDir("ledger-bad");
    const bad = recordLocalUpload(dir, join(dir, "nope.bin"));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("cannot read");
  });

  test("an over-50MB source is refused with its size", () => {
    const dir = scratchDir("ledger-big");
    const big = join(dir, "big.bin");
    const buf = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    buf.fill(1);
    writeFileSync(big, buf);
    const bad = recordLocalUpload(dir, big);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("50MB");
  });

  test("findLocalRecord returns null when nothing is recorded", () => {
    const dir = scratchDir("ledger-none");
    expect(findLocalRecord(dir, "zz")).toBeNull();
  });

  test("readIndex returns empty for an absent ledger", () => {
    expect(readIndex(scratchDir("ledger-missing"))).toEqual({});
  });
});

// --- the slack three-step upload flow -------------------------------------

describe("attachment upload through the slack backend", () => {
  test("gets an upload url, POSTs the bytes as multipart, then completes WITH the channel, in that order", async () => {
    const cwd = scratchDir("up-slack");
    const filesDir = scratchDir("up-files");
    writeSlackCfg(cwd, filesDir);
    const src = join(cwd, "upload.txt");
    writeFileSync(src, "hello upload bytes");
    const order: string[] = [];
    const { io, writes } = slackIo(cwd, async (url, init) => {
      if (url.includes("getUploadURLExternal")) {
        order.push("get");
        return new Response(JSON.stringify({ ok: true, upload_url: "https://upload.example/x", file_id: "UPLOAD1" }), { status: 200 });
      }
      if (url === "https://upload.example/x") {
        order.push("put");
        // MULTIPART POST, never a raw PUT: Slack answers 200 to a PUT and stores
        // a file it will not share and cannot serve, with nothing failing.
        expect(init?.method).toBe("POST");
        expect(init?.body).toBeInstanceOf(FormData);
        expect(String((init?.body as FormData).get("file"))).not.toBe("");
        return new Response("", { status: 200 });
      }
      if (url.includes("completeUploadExternal")) {
        order.push("complete");
        const form = new URLSearchParams(String(init?.body ?? ""));
        // The channel travels as a BARE id under `channel_id`. Slack answers
        // channel_not_found to `channels=["C1"]`, so a JSON-array channel value
        // is the defect this asserts against, not an accepted alternative.
        // channel_id IS sent: with the bytes uploaded correctly it makes a REAL
        // share, which is what lets the channel read the file.
        expect(form.get("channel_id")).toBe("C1");
        expect(form.get("channels")).toBeNull();
        expect(JSON.parse(form.get("files")!)).toEqual([{ id: "UPLOAD1", title: "upload.txt" }]);
        return new Response(JSON.stringify({ ok: true, files: [{ id: "UPLOAD1", permalink: "https://x.slack.com/files/U1/UPLOAD1/f.txt" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const code = await main(["attachment", "upload", "--path", src, "--target", "general", "--backend", "slack"], io);
    expect(code).toBe(0);
    expect(order).toEqual(["get", "put", "complete"]);
    expect(writes).toContain(JSON.stringify({ id: "UPLOAD1" }));
  });

  test("--mime-type overrides the guess on the uploaded blob", async () => {
    const cwd = scratchDir("up-mime");
    const filesDir = scratchDir("up-mime-files");
    writeSlackCfg(cwd, filesDir);
    const src = join(cwd, "data.bin");
    writeFileSync(src, "bytes");
    let putMime = "";
    const { io } = slackIo(cwd, async (url, init) => {
      if (url.includes("getUploadURLExternal")) return new Response(JSON.stringify({ ok: true, upload_url: "https://u/x", file_id: "F" }), { status: 200 });
      if (url === "https://u/x") { putMime = ((init?.body as FormData).get("file") as Blob).type; return new Response("", { status: 200 }); }
      if (url.includes("completeUploadExternal")) return new Response(JSON.stringify({ ok: true, files: [{ id: "F", permalink: "https://x.slack.com/files/U1/F/f.txt" }] }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const code = await main(["attachment", "upload", "--path", src, "--target", "general", "--backend", "slack", "--mime-type", "text/custom"], io);
    expect(code).toBe(0);
    expect(putMime).toBe("text/custom");
  });

  test("a slack upload failure exits 1 with the error on stderr", async () => {
    const cwd = scratchDir("up-fail");
    const filesDir = scratchDir("up-fail-files");
    writeSlackCfg(cwd, filesDir);
    const src = join(cwd, "x.txt");
    writeFileSync(src, "x");
    const { io, errs } = slackIo(cwd, async (url) => {
      if (url.includes("getUploadURLExternal")) return new Response(JSON.stringify({ ok: false, error: "no_permission" }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const code = await main(["attachment", "upload", "--path", src, "--target", "general", "--backend", "slack"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("no_permission");
  });

  test("a slack upload to an unknown channel is rejected", async () => {
    const cwd = scratchDir("up-nochan");
    const filesDir = scratchDir("up-nochan-files");
    writeSlackCfg(cwd, filesDir);
    const src = join(cwd, "x.txt");
    writeFileSync(src, "x");
    const { io, errs } = slackIo(cwd, async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const code = await main(["attachment", "upload", "--path", src, "--target", "nope", "--backend", "slack"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("no Slack channel");
  });
});

// --- message send --attach (local) ----------------------------------------

describe("message send --attach", () => {
  test("uploads the file, then sends: the stored message carries the file id and the local path", async () => {
    const cwd = scratchDir("attach-send");
    const store = createStore(scratchDir("attach-store"));
    const filesDir = join(cwd, ".config", "scramble", "files");
    const handler = createHandler(store);
    const writes: string[] = [];
    const io: Io = {
      write: (l) => writes.push(l),
      writeErr: () => {},
      fetch: async (input, init) => handler(new Request(String(input), init)),
      env: (n) => (n === "HOME" ? cwd : undefined),
      cwd: () => cwd,
      sleep: async () => {},
      serve: async () => 0,
      readStdin: async () => "see this file",
    };
    const src = join(cwd, "report.txt");
    writeFileSync(src, "the report bytes");
    const code = await main(["message", "send", "--target", "general", "--attach", src], io);
    expect(code).toBe(0);
    const msgs = store.read("general");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.files).toHaveLength(1);
    expect(msgs[0]!.files![0]!.path).toBe(src);
    expect(msgs[0]!.files![0]!.name).toBe("report.txt");
    // the local upload copied the bytes into filesDir
    const found = findLocalRecord(filesDir, msgs[0]!.files![0]!.id);
    expect(found).not.toBeNull();
    expect(readFileSync(found!.path, "utf8")).toBe("the report bytes");
  });
});

// --- attachment view -------------------------------------------------------

describe("attachment view", () => {
  // A local io whose HOME=cwd and whose cwd carries a slack config with an
  // explicit filesDir, so both the record and view resolve the same directory.
  function viewCfg(cwd: string, filesDir: string): { io: Io; writes: string[]; errs: string[] } {
    writeSlackCfg(cwd, filesDir);
    return localIoExact(cwd);
  }

  test("a file NOT on disk is fetched from Slack, which is what makes skipping the download safe", async () => {
    // Delivery stopped pulling the bytes of every file passing through a
    // channel, so the id on the line has to be enough to get them later. Three
    // agents in one room each downloaded the same 41MB archive addressed to one
    // of them, inside the delivery path, on a filesystem at 99%.
    const cwd = scratchDir("view-fetch");
    const dir = join(cwd, ".viewfiles");
    writeSlackCfg(cwd, dir);
    const bytes = new TextEncoder().encode("FETCHED-ON-DEMAND");
    const writes: string[] = [];
    const errs: string[] = [];
    const io: Io = {
      ...localIoExact(cwd).io,
      write: (l) => writes.push(l),
      writeErr: (l) => errs.push(l),
      fetch: async (url) => {
        const u = String(url);
        if (u.includes("files.info")) {
          return new Response(
            JSON.stringify({ ok: true, file: { url_private_download: "https://files.slack.com/d/F9", name: "late.bin" } }),
            { status: 200 },
          );
        }
        if (u.includes("files.slack.com")) {
          return new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream" } });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    };
    expect(await main(["attachment", "view", "F9", "--backend", "slack"], io)).toBe(0);
    const got = JSON.parse(writes[0]!) as { path: string };
    expect(readFileSync(got.path).toString()).toBe("FETCHED-ON-DEMAND");
  });

  test("a fetch Slack refuses names the id and what Slack said", async () => {
    const cwd = scratchDir("view-refused");
    const dir = join(cwd, ".viewfiles");
    writeSlackCfg(cwd, dir);
    const errs: string[] = [];
    const io: Io = {
      ...localIoExact(cwd).io,
      writeErr: (l) => errs.push(l),
      fetch: async () => new Response(JSON.stringify({ ok: false, error: "file_not_found" }), { status: 200 }),
    };
    expect(await main(["attachment", "view", "FX", "--backend", "slack"], io)).toBe(1);
    expect(errs.join(" ")).toContain("FX");
    expect(errs.join(" ")).toContain("file_not_found");
  });

  test("a file Slack knows but will not serve a url for is reported as such", async () => {
    const cwd = scratchDir("view-nourl");
    const dir = join(cwd, ".viewfiles");
    writeSlackCfg(cwd, dir);
    const errs: string[] = [];
    const io: Io = {
      ...localIoExact(cwd).io,
      writeErr: (l) => errs.push(l),
      fetch: async () => new Response(JSON.stringify({ ok: true, file: { name: "no-url.bin" } }), { status: 200 }),
    };
    expect(await main(["attachment", "view", "FY", "--backend", "slack"], io)).toBe(1);
    expect(errs.join(" ")).toContain("no download url");
  });

  test("writes to the given path and prints it", async () => {
    const cwd = scratchDir("view");
    const filesDir = join(cwd, ".viewfiles");
    const src = join(cwd, "orig.png");
    writeFileSync(src, "PNG-DATA");
    const rec = recordLocalUpload(filesDir, src);
    expect(rec.ok).toBe(true);
    if (rec.ok) {
      const out = join(cwd, "out.png");
      const { io, writes } = viewCfg(cwd, filesDir);
      const code = await main(["attachment", "view", rec.record.id, "--path", out], io);
      expect(code).toBe(0);
      expect(readFileSync(out, "utf8")).toBe("PNG-DATA");
      expect(JSON.parse(writes[0]!)).toEqual({ path: out });
    }
  });

  test("views the stored path when no --path is given", async () => {
    const cwd = scratchDir("view-stored");
    const filesDir = join(cwd, ".viewfiles");
    const src = join(cwd, "stored.txt");
    writeFileSync(src, "stored");
    const rec = recordLocalUpload(filesDir, src);
    expect(rec.ok).toBe(true);
    if (rec.ok) {
      const { io, writes } = viewCfg(cwd, filesDir);
      const code = await main(["attachment", "view", rec.record.id], io);
      expect(code).toBe(0);
      expect(existsSync(rec.record.path)).toBe(true);
      expect(JSON.parse(writes[0]!)).toEqual({ path: rec.record.path });
    }
  });

  test("an unknown attachment id is reported", async () => {
    const cwd = scratchDir("view-missing");
    const filesDir = join(cwd, ".viewfiles");
    const { io, errs } = viewCfg(cwd, filesDir);
    const code = await main(["attachment", "view", "nope"], io);
    expect(code).toBe(1);
    // Not on disk is no longer the end of it: view asks Slack, so the failure
    // that reaches the agent is Slack's own answer about that id.
    expect(errs[0]).toContain("nope");
    expect(errs[0]).toContain("not on disk");
  });
});
// --- direct units on the shared download/upload functions -----------------

describe("downloadFile (shared)", () => {
  test("a fetch exception is reported, not thrown", async () => {
    const d = scratchDir("dl-throw");
    const r = await downloadFile(async () => { throw new Error("net"); }, "https://files/x", "tok", d, "I1", "a.bin");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("download failed");
  });

  test("a response whose body errors when read is reported", async () => {
    const d = scratchDir("dl-nobytes");
    const r = await downloadFile(async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.error(new Error("broken body")); } })), "https://u/x", "tok", d, "I2", "b.bin");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no bytes");
  });

  test("an over-50MB download is refused with its size", async () => {
    const d = scratchDir("dl-big");
    const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    big.fill(7);
    const r = await downloadFile(async () => new Response(big, { headers: { "content-type": "application/octet-stream" } }), "https://u/x", "tok", d, "I3", "big.bin");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("50MB");
  });

  test("a successful download writes the path with the file id and sanitized name", async () => {
    const d = scratchDir("dl-ok");
    const r = await downloadFile(async () => new Response("BYTES", { headers: { "content-type": "application/octet-stream" } }), "https://u/x", "tok", d, "F1", "my cat.png");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path).toContain("F1-my_cat.png");
      expect(readFileSync(r.path, "utf8")).toBe("BYTES");
    }
  });

  test("an HTML download is reported with its url", async () => {
    const d = scratchDir("dl-html");
    const r = await downloadFile(async () => new Response("<html>no auth</html>", { headers: { "content-type": "text/html" } }), "https://files/x", "tok", d, "F5", "x.html");
    expect(r.ok).toBe(false);
    // The error names WHAT ARRIVED: the status, the content type, the byte
    // count and the body's head, because "returned HTML" hid a 19-byte
    // `Error serving file.` from the origin and cost a wrong diagnosis.
    if (!r.ok) {
      expect(r.error).toContain("not the file");
      expect(r.error).toContain("text/html");
    }
  });
});

describe("uploadToSlack failure branches", () => {
  // A fetcher that answers get/put/complete ok; used where the size/read guard
  // returns before any network call is made.
  const ok = async (url: string): Promise<Response> => {
    if (String(url).includes("getUploadURLExternal")) return new Response(JSON.stringify({ ok: true, upload_url: "https://u/x", file_id: "F" }), { status: 200 });
    if (String(url).startsWith("https://u/")) return new Response("", { status: 200 });
    return new Response(JSON.stringify({ ok: true, files: [{ id: "F" }] }), { status: 200 });
  };

  test("an over-50MB local file is refused up-front", async () => {
    const d = scratchDir("up-big");
    const big = join(d, "big.bin");
    const buf = new Uint8Array(MAX_ATTACHMENT_BYTES + 1).fill(1);
    // write the big file once, synchronously
    const { writeFileSync: w } = await import("node:fs");
    w(big, buf);
    const r = await uploadToSlack(ok, "tok", big, "C1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("50MB");
  });

  test("a file that cannot be read (missing) is refused", async () => {
    const d = scratchDir("up-read");
    const r = await uploadToSlack(ok, "tok", join(d, "nope.bin"), "C1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("cannot read");
  });

  test("a failed upload POST is reported and completeUploadExternal is never called", async () => {
    const d = scratchDir("up-put");
    const f = join(d, "x.txt");
    writeFileSync(f, "hello");
    let completes = 0;
    const r = await uploadToSlack(async (url, init) => {
      if (url.includes("getUploadURLExternal")) return new Response(JSON.stringify({ ok: true, upload_url: "https://pt/", file_id: "F" }), { status: 200 });
      if (url.startsWith("https://pt/")) throw new Error("put down");
      if (url.includes("completeUploadExternal")) { completes++; }
      return new Response(JSON.stringify({ ok: true, files: [{ id: "F1", permalink: "https://x.slack.com/files/U1/F1/f.txt" }] }), { status: 200 });
    }, "tok", f, "C1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("upload POST");
    expect(completes).toBe(0);
  });

  test("a non-JSON completeUploadExternal answer is reported", async () => {
    const d = scratchDir("up-nonjson");
    const f = join(d, "x.txt");
    writeFileSync(f, "hello");
    let round = 0;
    const r = await uploadToSlack(async (url) => {
      round++;
      if (String(url).includes("getUploadURLExternal")) return new Response(JSON.stringify({ ok: true, upload_url: "https://pt/", file_id: "F" }), { status: 200 });
      if (String(url).startsWith("https://pt/")) return new Response("", { status: 200 });
      return new Response("not json", { status: 200 });
    }, "tok", f, "C1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("non-JSON");
  });

  test("a non-object complete response is rejected", async () => {
    const d = scratchDir("up-nonobj");
    const f = join(d, "x.txt");
    writeFileSync(f, "hello");
    const r = await uploadToSlack(async (url) => {
      if (String(url).includes("getUploadURLExternal")) return new Response(JSON.stringify({ ok: true, upload_url: "https://pt/", file_id: "F" }), { status: 200 });
      if (String(url).startsWith("https://pt/")) return new Response("", { status: 200 });
      return new Response(JSON.stringify("just a string"), { status: 200 });
    }, "tok", f, "C1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("non-object");
  });
});

// --- the file endpoints send FORM ENCODING with detail kept ----------------

describe("slack upload form encoding and detail", () => {
  /** Parse an x-www-form-urlencoded body into its decoded field values. */
  function parseForm(body: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(body)) out[k] = v;
    return out;
  }

  test("getUploadURLExternal receives form encoding with exactly filename and length, not JSON", async () => {
    const d = scratchDir("form-get");
    const f = join(d, "data.txt");
    writeFileSync(f, "0123456789");
    let contentType = "";
    let body = "";
    await uploadToSlack(async (url, init) => {
      if (url.includes("getUploadURLExternal")) {
        contentType = String(init?.headers && "content-type" in init.headers ? (init.headers as Record<string, string>)["content-type"] : "");
        body = String(init?.body);
        return new Response(JSON.stringify({ ok: true, upload_url: "https://pt/", file_id: "F" }), { status: 200 });
      }
      if (url.startsWith("https://pt/")) return new Response("", { status: 200 });
      return new Response(JSON.stringify({ ok: true, files: [{ id: "F" }] }), { status: 200 });
    }, "tok", f, "C1");
    expect(contentType).toContain("application/x-www-form-urlencoded");
    expect(contentType.toLowerCase()).not.toContain("application/json");
    const form = parseForm(body);
    expect(Object.keys(form)).toEqual(["filename", "length"]);
    expect(form["filename"]).toBe("data.txt");
    expect(form["length"]).toBe("10");
  });

  test("completeUploadExternal receives the form encoding with files as one JSON string", async () => {
    const d = scratchDir("form-complete");
    const f = join(d, "data.txt");
    writeFileSync(f, "hello");
    let body = "";
    await uploadToSlack(async (url, init) => {
      if (url.includes("getUploadURLExternal")) return new Response(JSON.stringify({ ok: true, upload_url: "https://pt/", file_id: "F1" }), { status: 200 });
      if (url.startsWith("https://pt/")) return new Response("", { status: 200 });
      if (url.includes("completeUploadExternal")) {
        body = String(init?.body);
        return new Response(JSON.stringify({ ok: true, files: [{ id: "F1", permalink: "https://x.slack.com/files/U1/F1/f.txt" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, files: [{ id: "F1", permalink: "https://x.slack.com/files/U1/F1/f.txt" }] }), { status: 200 });
    }, "tok", f, "C1");
    const form = parseForm(body);
    expect(Object.keys(form).sort()).toEqual(["channel_id", "files"]);
    const files = JSON.parse(form["files"]!) as Array<{ id: string; title: string }>;
    expect(files).toHaveLength(1);
    expect(files[0]!.id).toBe("F1");
    expect(files[0]!.title).toBe("data.txt");
  });

  test("an ok:false carrying response_metadata.messages reports both code and messages", async () => {
    const d = scratchDir("detail-meta");
    const f = join(d, "x.txt");
    writeFileSync(f, "hello");
    const r = await uploadToSlack(async (url) => {
      if (url.includes("getUploadURLExternal")) return new Response(JSON.stringify({ ok: false, error: "invalid_arguments", response_metadata: { messages: ["[ERROR] missing required field: length", "[ERROR] missing required field: filename"] } }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, files: [{ id: "F1", permalink: "https://x.slack.com/files/U1/F1/f.txt" }] }), { status: 200 });
    }, "tok", f, "C1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("invalid_arguments");
      expect(r.error).toContain("missing required field: length");
      expect(r.error).toContain("missing required field: filename");
    }
  });

  test("an ok:false with no error field falls back to a generic failure", async () => {
    const d = scratchDir("detail-noerr");
    const f = join(d, "x.txt");
    writeFileSync(f, "hello");
    const r = await uploadToSlack(async (url) => {
      if (url.includes("getUploadURLExternal")) return new Response(JSON.stringify({ ok: false }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, files: [{ id: "F1", permalink: "https://x.slack.com/files/U1/F1/f.txt" }] }), { status: 200 });
    }, "tok", f, "C1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("slack request failed");
  });

  test("an ok:false with a messages-bearing metadata but empty error list", async () => {
    const d = scratchDir("detail-emptymeta");
    const f = join(d, "x.txt");
    writeFileSync(f, "hello");
    const r = await uploadToSlack(async (url) => {
      if (url.includes("getUploadURLExternal")) return new Response(JSON.stringify({ ok: false, error: "bad", response_metadata: { messages: [] } }), { status: 200 });
      return new Response(JSON.stringify({ ok: true, files: [{ id: "F1", permalink: "https://x.slack.com/files/U1/F1/f.txt" }] }), { status: 200 });
    }, "tok", f, "C1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("bad");
  });

  test("a PUT answering 400 fails the upload and completeUploadExternal is never called", async () => {
    const d = scratchDir("form-put400");
    const f = join(d, "x.txt");
    writeFileSync(f, "hello");
    let completes = 0;
    const r = await uploadToSlack(async (url) => {
      if (url.includes("getUploadURLExternal")) return new Response(JSON.stringify({ ok: true, upload_url: "https://pt/", file_id: "F" }), { status: 200 });
      if (url.startsWith("https://pt/")) return new Response("gone", { status: 400 });
      if (url.includes("completeUploadExternal")) completes++;
      return new Response(JSON.stringify({ ok: true, files: [{ id: "F1", permalink: "https://x.slack.com/files/U1/F1/f.txt" }] }), { status: 200 });
    }, "tok", f, "C1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("400");
      expect(r.error).toContain("gone");
    }
    expect(completes).toBe(0);
  });

  test("a PUT whose 400 body cannot be read still fails the upload", async () => {
    const d = scratchDir("form-put400-notext");
    const f = join(d, "x.txt");
    writeFileSync(f, "hello");
    let completes = 0;
    const unreadable = {
      status: 400,
      text: async (): Promise<string> => { throw new Error("body read failed"); },
    } as unknown as Response;
    const r = await uploadToSlack(async (url) => {
      if (url.includes("getUploadURLExternal")) return new Response(JSON.stringify({ ok: true, upload_url: "https://pt/", file_id: "F" }), { status: 200 });
      if (url.startsWith("https://pt/")) return unreadable;
      if (url.includes("completeUploadExternal")) completes++;
      return new Response(JSON.stringify({ ok: true, files: [{ id: "F1", permalink: "https://x.slack.com/files/U1/F1/f.txt" }] }), { status: 200 });
    }, "tok", f, "C1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("answered 400");
    expect(completes).toBe(0);
  });

  test("a successful three-step run returns the file id", async () => {
    const d = scratchDir("form-ok");
    const f = join(d, "x.txt");
    writeFileSync(f, "hello");
    const bytes = new Uint8Array([1, 2, 3]);
    const r = await uploadToSlack(async (url) => {
      if (url.includes("getUploadURLExternal")) return new Response(JSON.stringify({ ok: true, upload_url: "https://pt/", file_id: "F456" }), { status: 200 });
      if (url.startsWith("https://pt/")) return new Response(bytes, { status: 200 });
      return new Response(JSON.stringify({ ok: true, files: [{ id: "F456", permalink: "https://x.slack.com/files/U1/F456/f.txt" }] }), { status: 200 });
    }, "tok", f, "C1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.out.id).toBe("F456");
  });
});

// --- the remaining cli branches ----------------------------------------------

describe("attachment verb edge cases", () => {
  test("upload with no --path is reported", async () => {
    const cwd = scratchDir("edge-nopath");
    const { io, errs } = localIoExact(cwd);
    const code = await main(["attachment", "upload", "--target", "general"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("--path");
  });

  test("view with no id is reported", async () => {
    const cwd = scratchDir("edge-noid");
    const { io, errs } = localIoExact(cwd);
    const code = await main(["attachment", "view"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("attachmentId");
  });

  test("an unknown attachment verb is reported", async () => {
    const cwd = scratchDir("edge-verb");
    const { io, errs } = localIoExact(cwd);
    const code = await main(["attachment", "frob"], io);
    expect(code).toBe(1);
    expect(errs[0]).toContain("frob");
  });

  test("--attach=path equals form is collected and sent", async () => {
    const cwd = scratchDir("edge-attach-eq");
    const store = createStore(scratchDir("edge-attach-eq-store"));
    const handler = createHandler(store);
    const src = join(cwd, "eq.txt");
    writeFileSync(src, "eq bytes");
    const io: Io = {
      write: () => {},
      writeErr: () => {},
      fetch: async (input, init) => handler(new Request(String(input), init)),
      env: (n) => (n === "HOME" ? cwd : undefined),
      cwd: () => cwd,
      sleep: async () => {},
      serve: async () => 0,
      readStdin: async () => "text",
    };
    const code = await main(["message", "send", "--target", "general", `--attach=${src}`], io);
    expect(code).toBe(0);
    const msgs = store.read("general");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.files).toHaveLength(1);
  });

  test("an --attach upload failure aborts the send before any post", async () => {
    const cwd = scratchDir("edge-attach-fail");
    const store = createStore(scratchDir("edge-attach-fail-store"));
    const handler = createHandler(store);
    let posts = 0;
    const io: Io = {
      write: () => {},
      writeErr: () => {},
      fetch: async (input, init) => {
        if (String(input).includes("/channels/")) { posts++; }
        return handler(new Request(String(input), init));
      },
      env: (n) => (n === "HOME" ? cwd : undefined),
      cwd: () => cwd,
      sleep: async () => {},
      serve: async () => 0,
      readStdin: async () => "text",
    };
    // a missing attach file -> local upload reports cannot read
    const code = await main(["message", "send", "--target", "general", "--attach", join(cwd, "missing.bin")], io);
    expect(code).toBe(1);
    expect(posts).toBe(0);
    expect(store.read("general")).toHaveLength(0);
  });
});

// --- raft attachment backend ------------------------------------------------

describe("findLocalRecord / readIndex behaviour", () => {
  test("an orphaned <id>-* file in filesDir is resolved with a path even without a ledger entry", () => {
    const dir = scratchDir("orphan");
    const id = newAttachmentId();
    writeFileSync(join(dir, `${id}-orphan.png`), "ORPHAN");
    const rec = findLocalRecord(dir, id);
    expect(rec).not.toBeNull();
    if (rec) {
      expect(rec.name).toBe("orphan.png");
      expect(rec.path).toBe(join(dir, `${id}-orphan.png`));
      expect(rec.mime).toBe("image/png");
    }
  });

  test("a '<id>-*' file prefix when the dir is unreadable returns null", () => {
    const dir = join(tmpdir(), `att-never-${process.pid}`);
    rmSync(dir, { recursive: true, force: true }); // ensure it does not exist
    expect(findLocalRecord(dir, "zz")).toBeNull();
  });
});

// --- a fetch exception inside a Slack REST call -----------------------------

describe("uploadToSlack network failure", () => {
  test("a getUploadURLExternal network failure is reported", async () => {
    const d = scratchDir("up-net");
    const f = join(d, "x.txt");
    writeFileSync(f, "hello");
    const r = await uploadToSlack(async () => { throw new Error("net down"); }, "tok", f, "C1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("request failed");
  });
});

describe("an upload is attachable or it is a failure", () => {
  test("the permalink comes back on the result, since it is what attaches the file", async () => {
    const d = scratchDir("perma-ok");
    const f = join(d, "x.txt");
    writeFileSync(f, "hello");
    const r = await uploadToSlack(async (url) => {
      if (url.includes("getUploadURLExternal")) return new Response(JSON.stringify({ ok: true, upload_url: "https://pt/", file_id: "F9" }), { status: 200 });
      if (url.startsWith("https://pt/")) return new Response("", { status: 200 });
      return new Response(JSON.stringify({ ok: true, files: [{ id: "F9", permalink: "https://x.slack.com/files/U1/F9/x.txt" }] }), { status: 200 });
    }, "tok", f, "C1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.out.permalink).toBe("https://x.slack.com/files/U1/F9/x.txt");
  });

  test("ok:true with no permalink is reported, not returned as success", async () => {
    const d = scratchDir("perma-none");
    const f = join(d, "x.txt");
    writeFileSync(f, "hello");
    const r = await uploadToSlack(async (url) => {
      if (url.includes("getUploadURLExternal")) return new Response(JSON.stringify({ ok: true, upload_url: "https://pt/", file_id: "F9" }), { status: 200 });
      if (url.startsWith("https://pt/")) return new Response("", { status: 200 });
      return new Response(JSON.stringify({ ok: true, files: [{ id: "F9" }] }), { status: 200 });
    }, "tok", f, "C1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no permalink");
  });

  test("an accepted upload that returns no file at all is reported", async () => {
    const d = scratchDir("no-file");
    const f = join(d, "x.txt");
    writeFileSync(f, "hello");
    const r = await uploadToSlack(async (url) => {
      if (url.includes("getUploadURLExternal")) return new Response(JSON.stringify({ ok: true, upload_url: "https://pt/", file_id: "F11" }), { status: 200 });
      if (url.startsWith("https://pt/")) return new Response("", { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }, "tok", f, "C1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no permalink");
  });
});

describe("a file download re-sends the auth header across a redirect", () => {
  test("a 302 is followed by hand WITH the token, so the bytes arrive", async () => {
    const d = scratchDir("dl-redirect");
    const seen: Array<{ url: string; auth: string }> = [];
    const r = await downloadFile(async (url, init) => {
      seen.push({ url: String(url), auth: String((init?.headers as Record<string, string>)?.["authorization"] ?? "") });
      if (String(url).includes("files-pri")) {
        return new Response("", { status: 302, headers: { location: "https://files-origin.slack.com/x/f.txt" } });
      }
      return new Response("REAL-BYTES", { status: 200, headers: { "content-type": "text/plain" } });
    }, "https://files.slack.com/files-pri/T1-F1/f.txt", "tok", d, "F1", "f.txt");
    expect(r.ok).toBe(true);
    if (r.ok) expect(readFileSync(r.path, "utf8")).toBe("REAL-BYTES");
    // BOTH requests carry the token: dropping it on the second is the defect,
    // because Slack then serves its sign-in page as a 200 text/html body.
    expect(seen).toHaveLength(2);
    expect(seen[0]!.auth).toBe("Bearer tok");
    expect(seen[1]!.auth).toBe("Bearer tok");
    expect(seen[1]!.url).toBe("https://files-origin.slack.com/x/f.txt");
  });

  test("a redirect with no location stops rather than looping", async () => {
    const d = scratchDir("dl-noloc");
    const r = await downloadFile(async () => new Response("", { status: 302 }), "https://files.slack.com/a", "tok", d, "F1", "f.txt");
    expect(r.ok).toBe(false);
  });

  test("an endless redirect chain is bounded and reported", async () => {
    const d = scratchDir("dl-loop");
    let n = 0;
    const r = await downloadFile(async () => {
      n += 1;
      return new Response("", { status: 302, headers: { location: `https://files-origin.slack.com/${n}` } });
    }, "https://files.slack.com/a", "tok", d, "F1", "f.txt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("still redirecting");
    expect(n).toBe(4);
  });
});

describe("message send --attach on the slack backend", () => {
  test("the text rides ON the upload, so the words and the file are ONE message", async () => {
    const cwd = scratchDir("attach-one");
    const filesDir = scratchDir("attach-one-files");
    writeSlackCfg(cwd, filesDir);
    const src = join(cwd, "shot.png");
    writeFileSync(src, "PNGDATA");
    let completeBody = "";
    let posts = 0;
    const { io } = slackIo(cwd, async (url, init) => {
      if (url.includes("getUploadURLExternal")) return new Response(JSON.stringify({ ok: true, upload_url: "https://pt/", file_id: "F77" }), { status: 200 });
      if (url.startsWith("https://pt/")) return new Response("", { status: 200 });
      if (url.includes("completeUploadExternal")) {
        completeBody = String(init?.body);
        return new Response(JSON.stringify({ ok: true, files: [{ id: "F77", permalink: "https://x/F77" }] }), { status: 200 });
      }
      if (url.includes("chat.postMessage")) posts += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    io.readStdin = async () => "here is the mockup";
    expect(await main(["message", "send", "--target", "general", "--as", "alice", "--attach", src, "--backend", "slack"], io)).toBe(0);
    const form = new URLSearchParams(completeBody);
    // The words travel WITH the file, and no separate message is posted, or the
    // channel shows the sentence and the file as two separate things.
    expect(form.get("initial_comment")).toBe("here is the mockup");
    expect(form.get("channel_id")).toBe("C1");
    expect(posts).toBe(0);
  });

  test("the upload uses the SENDING agent's own token, not the default app token", async () => {
    const cwd = scratchDir("attach-token");
    const filesDir = scratchDir("attach-token-files");
    writeSlackCfg(cwd, filesDir);
    const src = join(cwd, "f.txt");
    writeFileSync(src, "bytes");
    let uploadAuth = "";
    const { io } = slackIo(cwd, async (url, init) => {
      if (url.includes("getUploadURLExternal")) {
        uploadAuth = String((init?.headers as Record<string, string>)["authorization"]);
        return new Response(JSON.stringify({ ok: true, upload_url: "https://pt/", file_id: "F78" }), { status: 200 });
      }
      if (url.startsWith("https://pt/")) return new Response("", { status: 200 });
      if (url.includes("completeUploadExternal")) return new Response(JSON.stringify({ ok: true, files: [{ id: "F78", permalink: "https://x/F78" }] }), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    io.readStdin = async () => "with a file";
    // alice has her own token in the config; a file she sends must be her file.
    const code = await main(["message", "send", "--target", "general", "--as", "alice", "--attach", src, "--backend", "slack"], io);
    expect(code).toBe(0);
    expect(uploadAuth).toBe("Bearer T_A");
  });

  test("with no attachment the text is sent unchanged", async () => {
    const cwd = scratchDir("attach-none");
    const filesDir = scratchDir("attach-none-files");
    writeSlackCfg(cwd, filesDir);
    let postedText = "";
    const { io } = slackIo(cwd, async (url, init) => {
      if (url.includes("chat.postMessage")) {
        postedText = JSON.parse(String(init?.body)).text as string;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    io.readStdin = async () => "just words";
    expect(await main(["message", "send", "--target", "general", "--as", "alice", "--backend", "slack"], io)).toBe(0);
    expect(postedText).toBe("just words");
  });

  test("an unusable slack config REFUSES the upload, and says which", async () => {
    // The upload goes through the backend now, so it reports the backend's own
    // reason. It used to check `cfg === null || !cfg.token` itself, which is one
    // of the two things this consolidation removed.
    const cwd = scratchDir("attach-nocfg");
    mkdirSync(join(cwd, ".scramble"), { recursive: true });
    writeFileSync(join(cwd, ".scramble", "slack.json"), "not json at all");
    const src = join(cwd, "a.png");
    writeFileSync(src, "bytes");
    const { io, errs } = slackIo(cwd, async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    io.readStdin = async () => "with a file";
    expect(await main(["message", "send", "--target", "general", "--as", "alice", "--attach", src, "--backend", "slack"], io)).toBe(1);
    expect(errs.join(" ")).toContain("slack.json");
  });
});
