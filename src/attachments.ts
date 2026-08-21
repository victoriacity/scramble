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
  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
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
    return {
      ok: false,
      error: `file download returned HTML (text/html) from ${url}`,
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
  let putBytes: Uint8Array;
  try {
    const put = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "content-type": mime },
      body: bytes,
    });
    putBytes = new Uint8Array(await put.arrayBuffer());
  } catch {
    putBytes = new Uint8Array(0);
  }
  void putBytes;
  const complete = await readSlack(fetch, COMPLETE_UPLOAD_URL, token, {
    files: [{ id: fileId, title: name }],
    channels: [slackChannelId],
  });
  if (!complete.ok) return { ok: false, error: complete.error };
  return { ok: true, out: { id: fileId, name, mime, size } };
}

/** CRUD one Slack REST POST and readOk the JSON, same error discipline as the
 *  backend: ok:false with Slack's error text is a FAILURE, never a success. */
async function readSlack(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
  url: string,
  token: string,
  body: unknown,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
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
  if (rec.ok !== true) return { ok: false, error: (rec.error as string) ?? "slack upload failed" };
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