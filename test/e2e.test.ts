import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// E2E smoke over the REAL entrypoint (src/bin.ts) exactly the way an operator
// runs it: spawn the daemon with a --bind on an ephemeral port and a temp
// --data dir, then drive the real CLI (src/bin.ts) as child processes against
// it. Spawned processes' files are not loaded by bun's coverage, so this test
// keeps the 100% numbers intact.

const repoRoot = process.cwd();
const binPath = join(repoRoot, "src", "bin.ts");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a CLI command to completion and return stdout/stderr/exit code. */
function runCli(args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = Bun.spawn({
      cmd: [process.execPath, binPath, ...args],
      cwd,
      // THESE ARE THE LOCAL BACKEND'S e2e, said out loud. With neither a flag
      // nor this variable, scramble follows the config on disk, and the machine
      // running these tests is usually an agent's own machine with a real
      // ~/.config/scramble/slack.json, so the suite would spawn a CLI that talks
      // to a live Slack workspace while these tests start a daemon of their own.
      env: { ...process.env, SCRAMBLE_BACKEND: "local" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const dec = new TextDecoder();
    (async () => {
      const out = proc.stdout!.getReader();
      while (true) {
        const { done, value } = await out.read();
        if (done) break;
        stdout += dec.decode(value);
      }
    })();
    (async () => {
      const err = proc.stderr!.getReader();
      while (true) {
        const { done, value } = await err.read();
        if (done) break;
        stderr += dec.decode(value);
      }
    })();
    proc.exited.then((code) => resolve({ code, stdout, stderr }));
  });
}

/** A still-running child (for `listen`) that streams output into buffers. */
interface Follower {
  stdout(): string;
  stderr(): string;
  exited: Promise<number>;
  stop(): Promise<void>;
}

function spawnFollow(args: string[], cwd: string): Follower {
  let stdout = "";
  let stderr = "";
  const proc = Bun.spawn({
    cmd: [process.execPath, binPath, ...args],
    cwd,
    // The local backend, said out loud, for the same reason runCli says it: the
    // backend follows the config on disk when nothing names one, and this
    // machine has a real slack config.
    env: { ...process.env, SCRAMBLE_BACKEND: "local" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const dec = new TextDecoder();
  (async () => {
    const out = proc.stdout!.getReader();
    while (true) {
      const { done, value } = await out.read();
      if (done) break;
      stdout += dec.decode(value);
    }
  })();
  (async () => {
    const err = proc.stderr!.getReader();
    while (true) {
      const { done, value } = await err.read();
      if (done) break;
      stderr += dec.decode(value);
    }
  })();
  const exited = proc.exited.then((c) => c as number).catch(() => -1);
  return {
    stdout: () => stdout,
    stderr: () => stderr,
    exited,
    stop: async () => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
      await proc.exited.catch(() => {});
    },
  };
}

/** Reserve a free TCP port by binding an ephemeral socket and releasing it. */
function freePort(): number {
  const srv = Bun.serve({ port: 0, fetch: () => new Response("x") });
  const port = srv.port as number;
  srv.stop();
  return port;
}

/** Poll the daemon until it accepts a connection (never a blind sleep). */
async function waitReady(url: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch (err) {
      lastErr = err;
    }
    await Bun.sleep(50);
  }
  throw new Error(`daemon did not accept connections within ${ms}ms: ${lastErr}`);
}

/** Poll until a predicate holds true (never a blind sleep). */
async function until(fn: () => Promise<boolean>, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await Bun.sleep(50);
  }
  throw new Error("condition not met within deadline");
}

function parseLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("e2e over the real bin.ts entrypoint", () => {
  let baseUrl: string;
  let dataDir: string;
  let work: string;
  let daemonProc: ReturnType<typeof Bun.spawn>;

  beforeAll(async () => {
    const port = freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    dataDir = mkdtempSync(join(tmpdir(), "scramble-e2e-data-"));
    work = mkdtempSync(join(tmpdir(), "scramble-e2e-work-"));
    daemonProc = Bun.spawn({
      cmd: [
        process.execPath,
        binPath,
        "serve",
        "--bind",
        `127.0.0.1:${port}`,
        "--data",
        dataDir,
      ],
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitReady(baseUrl);
  });

  afterAll(async () => {
    try {
      daemonProc.kill();
    } catch {
      /* already gone */
    }
    await daemonProc.exited.catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  test("the --bind port passed at spawn is the port actually listened on", async () => {
    // The daemon was launched with `--bind 127.0.0.1:<port>` and came up there.
    // If the port ever strayed (pre-fix it kept 7737 and used the whole string
    // as the hostname), this fetch against the --bind port could never succeed.
    const res = await fetch(`${baseUrl}/channels`);
    expect(res.status).toBe(200);
  }, 30000);

  test("join registers a name+persona that GET /agents reports", async () => {
    const r = await runCli(
      ["join", "general", "--as", "beta", "--persona", "acts on things", "--url", baseUrl],
      work,
    );
    expect(r.code).toBe(0);
    const res = await fetch(`${baseUrl}/agents`);
    const agents = (await res.json()) as { name: string; persona: string }[];
    const beta = agents.find((a) => a.name === "beta");
    expect(beta?.persona).toBe("acts on things");
  }, 30000);

  test("post computes mentions and a second poster's crossings include the first message", async () => {
    const first = await runCli(
      ["post", "crosschannel", "@beta hi from ana", "--as", "ana", "--url", baseUrl],
      work,
    );
    expect(first.code).toBe(0);
    // First poster in an empty channel: nothing to cross.
    expect(parseLines(first.stdout)).toHaveLength(0);

    const second = await runCli(
      ["post", "crosschannel", "answer from charlie", "--as", "charlie", "--url", baseUrl],
      work,
    );
    expect(second.code).toBe(0);
    const crossings = parseLines(second.stdout);
    expect(crossings.length).toBe(1);
    expect(crossings[0]).toMatchObject({ from: "ana", text: "@beta hi from ana" });
  }, 30000);

  test("next --as <name> --timeout N returns the pending message and exits 0", async () => {
    // eve must be a member of a channel that already holds a message.
    await runCli(["join", "queue", "--as", "eve", "--url", baseUrl], work);
    await runCli(["post", "queue", "wake up eve", "--as", "op", "--url", baseUrl], work);
    const r = await runCli(
      ["next", "--as", "eve", "--timeout", "5", "--url", baseUrl],
      work,
    );
    expect(r.code).toBe(0);
    const line = parseLines(r.stdout);
    expect(line.length).toBe(1);
    expect(line[0]).toMatchObject({ from: "op", text: "wake up eve" });
  }, 30000);

  test("next exits 64 when nothing arrives before the timeout", async () => {
    // A fresh agent in a fresh, empty channel with a short timeout.
    await runCli(["join", "quiet", "--as", "q", "--url", baseUrl], work);
    const r = await runCli(["next", "--as", "q", "--timeout", "0", "--url", baseUrl], work);
    expect(r.code).toBe(64);
    expect(r.stdout.trim()).toBe("");
  }, 30000);

  test("listen prints a message posted while it is streaming", async () => {
    await runCli(["join", "live-channel", "--as", "leo", "--url", baseUrl], work);
    const listener = spawnFollow(
      ["listen", "--as", "leo", "--url", baseUrl],
      work,
    );
    try {
      // Prove the listener's stream is open by having it print a first ping
      // that was posted, THEN post the real message while it is streaming.
      const ping = await runCli(
        ["post", "live-channel", "@leo first ping", "--as", "mara", "--url", baseUrl],
        work,
      );
      expect(ping.code).toBe(0);
      await until(async () => listener.stdout().includes("first ping"));

      const post = await runCli(
        ["post", "live-channel", "@leo incoming while streaming", "--as", "mara", "--url", baseUrl],
        work,
      );
      expect(post.code).toBe(0);
      await until(async () => listener.stdout().includes("incoming while streaming"));
      const lines = parseLines(listener.stdout());
      expect(lines.some((l) => l.text === "@leo incoming while streaming")).toBe(true);
    } finally {
      await listener.stop();
    }
  }, 30000);
});