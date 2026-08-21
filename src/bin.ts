#!/usr/bin/env bun
// src/bin.ts — the ONLY entrypoint. Binds ports, reads process.argv, and
// binds the real Slack transport here so no test imports this file (keeping the
// coverage gate green). Everything else is delegated to src/cli.ts's
// main(argv, io).
import { createStore, type RoomStore } from "./store";
import { serve, type ServeOptions } from "./server";
import { createSlackTransport, type SlackSocket } from "./slack-transport";
import type { SlackConfig, SlackTransport } from "./slack";
import { main } from "./cli";

// The real raft process seam: shell out to the raft binary, piping stdin.
// Kept at the edge so no test imports it — tests inject a fake run into
// src/cli.ts's main() and need no raft binary, no network, no credential.
async function runRaft(cmd: string, args: string[], stdin: string): Promise<{ exit: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([cmd, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(new TextEncoder().encode(stdin));
  proc.stdin.end();
  const exit = await proc.exited;
  const stdout = new TextDecoder().decode(await new Response(proc.stdout).arrayBuffer());
  const stderr = new TextDecoder().decode(await new Response(proc.stderr).arrayBuffer());
  return { exit, stdout, stderr };
}

// The real WebSocket adapter: wire bun's built-in WebSocket onto the
// transport's SlackSocket surface. Kept at the edge so no test needs a socket.
function createSocket(cfg: SlackConfig): SlackTransport {
  return createSlackTransport({
    appToken: cfg.appToken ?? "",
    botToken: cfg.token,
    fetch: io.fetch,
    sleep: io.sleep,
    createSocket: realSocket,
  });
}

// Adapt bun's WebSocket onto the SlackSocket surface that both the transport
// and the slack BACKEND use.
function realSocket(url: string): SlackSocket {
  const ws = new WebSocket(url);
  const sock: SlackSocket = {
    send: (d) => ws.send(d),
    close: (code, reason) => ws.close(code, reason),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = () => sock.onopen?.();
  ws.onmessage = (e) => sock.onmessage?.(String(e.data));
  ws.onclose = (e) => sock.onclose?.(e.code, e.reason);
  ws.onerror = () => sock.onerror?.();
  return sock;
}

const io = {
  write(line: string): void {
    process.stdout.write(line + "\n");
  },
  writeErr(line: string): void {
    process.stderr.write(line + "\n");
  },
  fetch(input: string, init?: RequestInit): Promise<Response> {
    return globalThis.fetch(input, init);
  },
  env(name: string): string | undefined {
    return process.env[name];
  },
  cwd(): string {
    return process.cwd();
  },
  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
  readStdin(): Promise<string> {
    return new Response(Bun.stdin).text();
  },
  pid(): number {
    return process.pid;
  },
  alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  serve(store: RoomStore, opts: ServeOptions): Promise<number> {
    const srv = serve(store, opts);
    return new Promise(() => {});
  },
  createTransport(cfg: SlackConfig): SlackTransport {
    return createSocket(cfg);
  },
  createSocket: realSocket,
  run: runRaft,
};

if (import.meta.main) {
  main(process.argv.slice(2), io).then((code) => process.exit(code));
}