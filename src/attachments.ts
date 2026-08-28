// `src/attachments.ts` provides the file and image implementation shared across
// backends. This module isolates file-specific logic from `src/slack-backend.ts`
// and `src/cli.ts`, so those two files change as little as the feature requires
// and concurrent merges rebase cleanly. Every byte of network I/O passes through
// the injected `fetch` seam, so tests need no token and no network.

import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

/**
 *  The tool mirrors raft's attachment size cap so the two tools refuse the same
 *  file.
 */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/**
 *  The number of redirect hops across which a file download re-issues the
 *  authorization header.
 */
const MAX_DOWNLOAD_HOPS = 3;

/**
 *  This structure represents one file carried on a message line, which is the
 *  shape that Message.files is built from.
 */
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size?: number;
  path?: string;
}

/**
 *  This example represents one Slack file event, showing the subset of fields
 *  that the download maps.
 */
export interface SlackFileMeta {
  id?: string;
  name?: string;
  url_private?: string;
  mimetype?: string;
  size?: number;
}

/**
 *  The response contains the result of pulling one download. An `ok:false` status
 *  carries a reportable error.
 */
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

/**
 *  The system strips all characters that would break or escape a filesystem
 *  path from a file name, so `<file id>-<name>` never escapes `filesDir`.
 */
export function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "");
  return cleaned === "" ? "attachment" : cleaned;
}

/**
 *  The function guesses a MIME type from a filename's extension, with an
 *  octet-stream fallback.
 */
export function guessMime(path: string): string {
  const m = /(\.[A-Za-z0-9]+)$/.exec(path);
  return m ? MIME_BY_EXT[m[1]!.toLowerCase()] ?? "application/octet-stream" : "application/octet-stream";
}

/**
 *  A new unique identifier is derived from time and entropy in JavaScript with no
 *  dependencies.
 */
export function newAttachmentId(): string {
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 *  The function inspects the first 1 KB of bytes from a Slack response. An
 *  unauthenticated `GET` request to a file's `url_private` returns an HTML error
 *  page, so the small byte length triggers the size guard here and the HTML check
 *  catches the real signal.
 */
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

/**
 *  The 50MB guard checks a file's byte size on disk.
 */
export function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

/**
 *  An inbound download validates an assertion. Fetching a Slack `url_private`
 *  through a plain GET request without the bot token returns an HTML error page.
 *  The system reports any download that returns HTML and drops the bytes.
 */
export function isHtmlResponse(res: Response, bytes: Uint8Array): boolean {
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  if (ct.includes("text/html")) return true;
  return looksLikeHtml(bytes);
}

/**
 *  The command downloads one Slack file to `<dir>/<id>-<sanitized name>`. If a
 *  response is HTML or is too big, the operation reports an error and writes
 *  nothing.
 */
export async function downloadFile(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
  url: string,
  token: string,
  dir: string,
  fileId: string,
  name: string,
): Promise<DownloadResult> {
  // Follow the redirect manually. Slack answers a file `url_private` with a `302` to
  // `files-origin.slack.com`, and both `fetch` and `curl -L` drop the
  // `Authorization` header on a cross-host redirect, so the followed request
  // arrives unauthenticated and Slack serves its sign-in page with a `200` status,
  // `text/html`, and `69KB`. The HTML guard below was catching this response.
  // Re-issuing the request to the `Location` with the `Authorization` header is the
  // only way the bytes can arrive.
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
    // Print the received payload, followed by its classification. The message
    // "returned HTML" directs investigation toward an authentication problem while the
    // body contains `Error serving file.` in 19 bytes, which is a different failure:
    // the token was accepted and the origin would not serve the bytes.
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

// # Slack upload: the modern three-step flow

export interface SlackUploadResult {
  /**
   *  The response provides the Slack file ID, so callers reference it in the sent
   *  message.
   */
  id: string;
  /**
   *  When Slack reports a share, it provides the timestamp of the message posted by
   *  the completed upload. The send path needs this timestamp for everything it does
   *  after posting.
   */
  ts?: string;
  name: string;
  mime: string;
  size: number;
  /**
   *  This is Slack's link to the file. Including this link in a message's text
   *  attaches the file to that message: Slack unfurls it, the message carries the
   *  file, and `files.info` records the share. Live testing verified that this is
   *  the single mechanism that attaches the file, which is why the upload no longer
   *  requests completeUploadExternal to share (see uploadToSlack).
   */
  permalink: string;
}

const GET_UPLOAD_URL = "https://slack.com/api/files.getUploadURLExternal";
const COMPLETE_UPLOAD_URL = "https://slack.com/api/files.completeUploadExternal";

/**
 *  The command uploads a file to a Slack channel ID using a three-step upload flow
 *  (`getUploadURLExternal`, a PUT request with the raw bytes, and
 *  `completeUploadExternal`), then returns the uploaded file ID. The `--mime-type`
 *  flag overrides the guessed MIME type.
 */
export async function uploadToSlack(
  fetch: (input: string, init?: RequestInit) => Promise<Response>,
  token: string,
  path: string,
  slackChannelId: string,
  mimeOverride?: string,
  // Attach the message text directly to the file upload. Completing an upload
  // posts its own message, so posting text separately leaves the words and the file
  // as two messages in the channel, which reads as two separate events.
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
  // Use a multipart POST for file uploads. Slack returns a 200 response to a raw PUT
  // and stores an unreadable file. The completeUploadExternal method then shares the
  // file with nothing, downloaded bytes return as a 69KB sign-in page, and nothing
  // fails anywhere. In side-by-side measurements, sending the same bytes through a
  // multipart POST shares the file into the channel and downloads the original
  // bytes. This silent 200 response is why the failure looked like an
  // organization-wide file block for an hour.
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
  // The client sends `channel_id`. Correctly uploading the bytes produces a real
  // share, which makes the file readable by the channel. It looked useless while
  // the upload was a raw PUT, because Slack would not share a file it could not
  // read.
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
  return { ok: true, out: { id: fileId, name, mime, size, permalink, ts: shareTs(complete.data) } };
}

/**
 *  The timestamp comes from the message that `completeUploadExternal` posted, which
 *  the handler reads from the file's shares. Completing an upload posts its own
 *  message carrying the text, so that message has a timestamp like any other. The
 *  send path requires this timestamp for all subsequent actions: closing what the
 *  reply answers, remembering what this agent said, and reporting what it raced
 *  with.
 *
 *  The timestamp is absent when Slack returns no shares, which happens when an
 *  upload targets no channel. The caller treats that result as having no timestamp
 *  and reports it.
 */
function shareTs(data: Record<string, unknown>): string | undefined {
  const files = data.files;
  if (!Array.isArray(files) || files.length === 0) return undefined;
  const shares = (files[0] as { shares?: unknown }).shares;
  if (typeof shares !== "object" || shares === null) return undefined;
  for (const scope of Object.values(shares as Record<string, unknown>)) {
    if (typeof scope !== "object" || scope === null) continue;
    for (const entries of Object.values(scope as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue;
      for (const e of entries) {
        const ts = (e as { ts?: unknown }).ts;
        if (typeof ts === "string" && ts !== "") return ts;
      }
    }
  }
  return undefined;
}

/**
 *  The output contains the permalink of the first file in a completeUploadExternal
 *  reply, or undefined when the reply carries no file or no link. An undefined
 *  result is a failure for the caller. Without the link, the caller cannot attach
 *  the stored file to a message, so an upload that returns undefined is an orphan
 *  in Slack's storage.
 */
function filePermalink(data: Record<string, unknown>): string | undefined {
  const files = data.files;
  if (!Array.isArray(files) || files.length === 0) return undefined;
  const link = (files[0] as Record<string, unknown>).permalink;
  return typeof link === "string" && link.length > 0 ? link : undefined;
}


/**
 *  Encode an object as an `application/x-www-form-urlencoded` body. Because a form
 *  field cannot hold an array, arrays and objects become a single JSON-encoded
 *  field value, so `files` and `channels` travel as `[...]` in a single value.
 */
function urlForm(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    const val = v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(val)}`);
  }
  return parts.join("&");
}

/**
 *  Construct a reportable error from a Slack ok:false reply. Slack places the
 *  specific reason in `response_metadata.messages`, while `error` alone often
 *  states only `invalid_arguments`. Include both fields so the next failure
 *  names itself.
 */
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

/**
 *  Send a Slack REST POST request using form encoding, because the file endpoints
 *  do not read JSON fields, and parse the resulting JSON response. When `ok` is
 *  false, the response carries `error` and any `response_metadata.messages`. A
 *  `status` of false indicates a failure.
 */
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
// `filesDir` stores copied file bytes as `<id>-<sanitized name>` alongside an
// `index.json` file that maps the id to `{ name, mime, size, path }`. The
// `attachment view` command reads the ledger to return the path to a caller.

export interface LocalFileRecord {
  id: string;
  name: string;
  mime: string;
  size: number;
  path: string;
}

/**
 *  The local copy lives under `filesDir`.
 */
export function localPath(dir: string, id: string, name: string): string {
  return join(dir, `${id}-${sanitizeName(name)}`);
}

/**
 *  The system reads the index ledger, which maps an object ID to its record. If the
 *  ledger is missing, it reads as an empty map.
 */
export function readIndex(dir: string): Record<string, LocalFileRecord> {
  try {
    const j = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as Record<string, LocalFileRecord>;
    return j;
  } catch {
    return {};
  }
}

/**
 *  Write one record to the ledger.
 */
export function writeIndex(dir: string, record: LocalFileRecord): void {
  mkdirSync(dir, { recursive: true });
  const index = readIndex(dir);
  index[record.id] = record;
  writeFileSync(join(dir, "index.json"), JSON.stringify(index));
}

/**
 *  The local backend's `attachment upload` copies a source file into `filesDir`
 *  and records it. The command refuses an over-50MB file and reports the size it
 *  saw. It returns the recorded id on the stdout line.
 */
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

/**
 *  To resolve an uploaded file by ID, the system checks the ledger first. If the
 *  ledger has no match, the system searches for an orphaned `<id>-*` file in
 *  filesDir (such as an inbound Slack download saved under that ID). The lookup
 *  returns null when nothing is recorded.
 */
export function findLocalRecord(dir: string, id: string): LocalFileRecord | null {
  const rec = readIndex(dir)[id];
  if (rec) return rec;
  // If an orphaned `<id>-<sanitized>` file has no ledger entry, stat the file.
  // Inbound Slack downloads arrive there under the file id with no ledger entry, so
  // `view` finds that bytes-by-id path. A missing filesDir reads as empty.
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
