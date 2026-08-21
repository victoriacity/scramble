// src/attachments.ts — the file/image implementation shared by the backends.
// Keeps the file-specific logic OUT of src/slack-backend.ts and src/cli.ts so
// those two files change as little as the feature requires and a concurrent
// merge rebases cleanly. Every byte of network IO goes through the injected
// `fetch` seam, so tests need no token and no network.

import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

/** raft's attachment size cap, mirrored so the two tools refuse the same file. */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** How many redirect hops a file download re-issues WITH the auth header. */
const MAX_DOWNLOAD_HOPS = 3;

/** One file carried on a message line (the shape Message.files is built from). */
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size?: number;
  path?: string;
}

/** One Slack file event (a subset: the fields the download maps). */
export interface SlackFileMeta {
  id?: string;
  name?: string;
  url_private?: string;
  mimetype?: string;
  size?: number;
}

/** The result of pulling one download. ok:false carries a REPORTABLE error. */
export type DownloadResult = { ok: true; path: string } | { ok: false; error: string };

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
};

/** Strip everything that would break or escape a filesystem path from a file
 *  name, so `<file id>-<name>` never path-escapes `filesDir`. */
export function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "");
  return cleaned === "" ? "attachment" : cleaned;
}

/** Guess a mime type from a filename's extension (octet-stream fallback). */
export function guessMime(path: string): string {
  const m = /(\.[A-Za-z0-9]+)$/.exec(path);
  return m ? MIME_BY_EXT[m[1]!.toLowerCase()] ?? "application/octet-stream" : "application/octet-stream";
}

/** A NEW unique id, derived from time + entropy (js id, no dependency). */
export function newAttachmentId(): string {
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The first KB sniffed from a Slack byte response. An unauthenticated GET to
 *  a file's url_private returns an HTML error page, so the size guard would be
 *  caught here (byte length small) and the HTML check catches the real signal. */
function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder()
    .decode(bytes.slice(0, 512))
    .trimStart()
    .toLowerCase();
  return (
    head.startsWith("<html") ||
    head.startsWith("<!doctype html") ||
    head.startsWith("<!doctype") ||
    head.startsWith("<head")
  );
}

/** A file's byte size on disk, for the 50MB guard. */
export function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

/** Assertion used on an inbound download: a Slack url_private fetched WITHOUT
 *  the bot token (plain GET) returns an HTML error page, never bytes. So a
 *  download that answers HTML is REPORTED, never written as attachments. */
export function isHtmlResponse(res: Response, bytes: Uint8Array): boolean {
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  if (ct.includes("text/html")) return true;
  return looksLikeHtml(bytes);
}

/** Download one Slack file to `<dir>/<id>-<sanitized name>` and REPORT (via the
 *  error) instead of silently writing when the response is HTML or too big. */
export async function downloadFile(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
  url: string,
  token: string,
  dir: string,
  fileId: string,
  name: string,
): Promise<DownloadResult> {
  // FOLLOW THE REDIRECT BY HAND. Slack answers a file url_private with a 302 to
  // files-origin.slack.com, and both fetch and curl -L DROP the Authorization
  // header on a cross-host redirect, so the followed request arrives
  // unauthenticated and Slack serves its sign-in page: 200, text/html, 69KB.
  // That is what the HTML guard below was catching. Re-issuing the request to
  // the Location WITH the header is the only way the bytes can arrive.
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "manual",
    });
    let hops = 0;
    while (res.status >= 300 && res.status < 400 && hops < MAX_DOWNLOAD_HOPS) {
      const next = res.headers.get("location");
      if (next === null || next === "") break;
      res = await fetch(new URL(next, url).toString(), {
        headers: { authorization: `Bearer ${token}` },
        redirect: "manual",
      });
      hops += 1;
    }
    if (res.status >= 300 && res.status < 400) {
      return {
        ok: false,
        error: `file download from ${url} still redirecting after ${MAX_DOWNLOAD_HOPS} hops`,
      };
    }
  } catch {
    return { ok: false, error: `file download failed for ${url}` };
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    return { ok: false, error: `file download returned no bytes for ${url}` };
  }
  if (isHtmlResponse(res, bytes)) {
    // PRINT WHAT ARRIVED, not the classification. "returned HTML" sent me
    // hunting for an auth problem while the body said `Error serving file.` in
    // 19 bytes, which is a different failure entirely: the token was accepted
    // and the origin would not serve the bytes.
    const head = new TextDecoder().decode(bytes.slice(0, 200)).replace(/\s+/g, " ").trim();
    return {
      ok: false,
      error:
        `file download from ${url} answered ${res.status} ` +
        `${res.headers.get("content-type") ?? "(no content-type)"}, ${bytes.length} bytes, ` +
        `not the file: ${head}`,
    };
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: `file over 50MB (${bytes.length} bytes)` };
  }
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${fileId}-${sanitizeName(name)}`);
  writeFileSync(path, bytes);
  return { ok: true, path };
}

// --- Slack upload: the modern three-step flow ---------------------------

export interface SlackUploadResult {
  /** the real Slack file id, so callers reference it in the sent message. */
  id: string;
  name: string;
  mime: string;
  size: number;
  /** Slack's own link to the file. Putting this in a message's TEXT is what
   *  attaches the file to that message: Slack unfurls it, the message then
   *  carries the file, and `files.info` records the share. Verified live, and it
   *  is the ONE mechanism that attaches, which is why the upload no longer asks
   *  completeUploadExternal to share (see uploadToSlack). */
  permalink: string;
}

const GET_UPLOAD_URL = "https://slack.com/api/files.getUploadURLExternal";
const COMPLETE_UPLOAD_URL = "https://slack.com/api/files.completeUploadExternal";

/** Upload one file to a Slack target (a Slack channel id) with the three-step
 *  flow — getUploadURLExternal -> PUT bytes -> completeUploadExternal — and
 *  return the file id. `--mime-type` overrides the guess. */
export async function uploadToSlack(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
  token: string,
  path: string,
  slackChannelId: string,
  mimeOverride?: string,
  // The message text rides WITH the file. Completing an upload posts its own
  // message, so a separately posted line leaves the words and the file as two
  // messages in the channel, which reads as two things happening.
  initialComment?: string,
  threadTs?: string,
): Promise<{ ok: true; out: SlackUploadResult } | { ok: false; error: string }> {
  const size = sizeOf(path);
  if (size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: `file over 50MB (${size} bytes)` };
  }
  const name = basename(path);
  const mime = mimeOverride ?? guessMime(path);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(path));
  } catch {
    return { ok: false, error: `cannot read ${path}` };
  }
  const get = await readSlack(fetch, GET_UPLOAD_URL, token, {
    filename: name,
    length: bytes.length,
  });
  if (!get.ok) return { ok: false, error: get.error };
  const uploadUrl = get.data.upload_url as string;
  const fileId = get.data.file_id as string;
  // MULTIPART POST, never a raw PUT. Slack answers 200 to a PUT and stores a file
  // that cannot be read: completeUploadExternal then shares it with nothing, the
  // bytes come back as a 69KB sign-in page, and nothing anywhere fails. Measured
  // side by side on 2026-08-22: the same bytes as a multipart POST share into the
  // channel and download as themselves. That silent-200 is why this looked like
  // an org-wide file block for an hour.
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: mime }), name);
  let put: Response;
  try {
    put = await fetch(uploadUrl, { method: "POST", body: form });
  } catch {
    return { ok: false, error: `upload POST to ${uploadUrl} failed` };
  }
  if (put.status < 200 || put.status >= 300) {
    const text = await put.text().catch(() => "");
    return {
      ok: false,
      error: `upload POST to ${uploadUrl} answered ${put.status}${text ? `: ${text}` : ""}`,
    };
  }
  // channel_id IS sent: with the bytes uploaded correctly it produces a REAL
  // share, which is what makes the file readable by the channel. It looked
  // useless while the upload was a raw PUT, because a file Slack could not read
  // was a file it would not share.
  const complete = await readSlack(fetch, COMPLETE_UPLOAD_URL, token, {
    files: [{ id: fileId, title: name }],
    channel_id: slackChannelId,
    ...(initialComment !== undefined && initialComment !== "" ? { initial_comment: initialComment } : {}),
    ...(threadTs !== undefined && threadTs !== "" ? { thread_ts: threadTs } : {}),
  });
  if (!complete.ok) return { ok: false, error: complete.error };
  const permalink = filePermalink(complete.data);
  if (permalink === undefined) {
    return {
      ok: false,
      error:
        `slack accepted the upload of ${name} and returned no permalink, so nothing can ` +
        `attach it to a message: ${JSON.stringify(complete.data).slice(0, 400)}`,
    };
  }
  return { ok: true, out: { id: fileId, name, mime, size, permalink } };
}

/** The permalink of the first file in a completeUploadExternal reply, or
 *  undefined when the reply carries no file or no link. Undefined is a FAILURE
 *  for the caller: without the link there is no way to attach the stored file to
 *  a message, so an upload that returns one is an orphan in Slack's storage. */
function filePermalink(data: Record<string, unknown>): string | undefined {
  const files = data.files;
  if (!Array.isArray(files) || files.length === 0) return undefined;
  const link = (files[0] as Record<string, unknown>).permalink;
  return typeof link === "string" && link.length > 0 ? link : undefined;
}


/** Encode an object as an `application/x-www-form-urlencoded` body. Arrays and
 *  objects become ONE JSON-encoded field value (a form field cannot hold an
 *  array), so `files`/`channels` travel as `[...]` in a single value. */
function urlForm(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    const val = v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(val)}`);
  }
  return parts.join("&");
}

/** Build a REPORTABLE error from a Slack ok:false reply: Slack puts the real
 *  reason in `response_metadata.messages` while `error` alone often says only
 *  `invalid_arguments`. Carry both so the next failure names itself. */
function slackError(rec: Record<string, unknown>): string {
  const code = (rec.error as string) ?? "slack request failed";
  const meta = rec["response_metadata"];
  if (meta && typeof meta === "object") {
    const arr = (meta as Record<string, unknown>).messages;
    if (Array.isArray(arr) && arr.length > 0) {
      return `${code}: ${arr.join("; ")}`;
    }
  }
  return code;
}

/** POST one Slack REST call as FORM ENCODING (the file endpoints read no JSON
 *  fields) and readOk the JSON. ok:false carries `error` plus any
 *  `response_metadata.messages`; status:false is a FAILURE, never a success. */
async function readSlack(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
  url: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        authorization: `Bearer ${token}`,
      },
      body: urlForm(body),
    });
  } catch {
    return { ok: false, error: `slack request failed: ${url}` };
  }
  let j: unknown;
  try {
    j = await res.json();
  } catch {
    return { ok: false, error: `slack answered non-JSON to ${url}` };
  }
  if (typeof j !== "object" || j === null) return { ok: false, error: `slack answered non-object to ${url}` };
  const rec = j as Record<string, unknown>;
  if (rec.ok !== true) return { ok: false, error: slackError(rec) };
  return { ok: true, data: rec };
}

// --- the local backend's file ledger ------------------------------
// `filesDir` holds the copied bytes as `<id>-<sanitized name>`, plus an
// `index.json` mapping the id to { name, mime, size, path }. `attachment view`
// reads the ledger to hand a caller the path.

export interface LocalFileRecord {
  id: string;
  name: string;
  mime: string;
  size: number;
  path: string;
}

/** Where the local copy lives under filesDir. */
export function localPath(dir: string, id: string, name: string): string {
  return join(dir, `${id}-${sanitizeName(name)}`);
}

/** Read the index ledger (an object id -> record). A missing/absent ledger is
 *  an empty map, never an error. */
export function readIndex(dir: string): Record<string, LocalFileRecord> {
  try {
    const j = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as Record<string, LocalFileRecord>;
    return j;
  } catch {
    return {};
  }
}

/** Persist one record into the ledger. */
export function writeIndex(dir: string, record: LocalFileRecord): void {
  mkdirSync(dir, { recursive: true });
  const index = readIndex(dir);
  index[record.id] = record;
  writeFileSync(join(dir, "index.json"), JSON.stringify(index));
}

/** Copy a source file into filesDir and record it, for the local backend's
 *  `attachment upload`. Refuses an over-50MB file with the size it saw. Returns
 *  the recorded id for the stdout line. */
export function recordLocalUpload(
  dir: string,
  sourcePath: string,
  mimeOverride?: string,
): { ok: true; record: LocalFileRecord } | { ok: false; error: string } {
  const size = sizeOf(sourcePath);
  if (size < 0) return { ok: false, error: `cannot read ${sourcePath}` };
  if (size > MAX_ATTACHMENT_BYTES) {
    return { ok: false, error: `file over 50MB (${size} bytes)` };
  }
  mkdirSync(dir, { recursive: true });
  const id = newAttachmentId();
  const name = basename(sourcePath);
  const mime = mimeOverride ?? guessMime(sourcePath);
  const path = localPath(dir, id, name);
  copyFileSync(sourcePath, path);
  const record: LocalFileRecord = { id, name, mime, size, path };
  writeIndex(dir, record);
  return { ok: true, record };
}

/** Resolve an uploaded file by id: the ledger wins, then a `<id>-*` file
 *  orphaned in filesDir (e.g. an inbound Slack download under that id). Null
 *  when nothing is recorded. */
export function findLocalRecord(dir: string, id: string): LocalFileRecord | null {
  const rec = readIndex(dir)[id];
  if (rec) return rec;
  // A `<id>-<sanitized>` orphan (no ledger entry): stat the file. Inbound Slack
  // downloads land there under the file id with no ledger entry, so `view`
  // finds that bytes-by-id path. A missing filesDir reads empty, never errors.
  let hits: string[];
  try {
    hits = readdirSync(dir).filter((ent) => ent.startsWith(`${id}-`));
  } catch {
    return null;
  }
  if (hits.length === 0) return null;
  const name = hits[0]!.slice(id.length + 1);
  const path = join(dir, hits[0]!);
  return { id, name, mime: guessMime(name), size: sizeOf(path), path };
}