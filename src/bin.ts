#!/usr/bin/env bun
// src/bin.ts: the ONLY entrypoint. Binds ports, reads process.argv, and binds
// the real socket factory here so no test imports this file, which keeps every
// line of it out of the coverage report. Everything else is delegated to
// src/cli.ts and its main(argv, io).
import { createStore, type ChannelStore } from "./store";
import { serve, type ServeOptions } from "./server";
import type { SlackSocket } from "./slack-transport";
import { main } from "./cli";
import { hostname } from "node:os";

// Adapt bun's WebSocket onto the SlackSocket surface that the slack BACKEND
// uses for its Socket Mode stream. Kept at the edge so no test needs a socket.
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
  envNames(): string[] {
    return Object.keys(process.env);
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
  moduleDir(): string {
    return import.meta.dir;
  },
  hostname(): string {
    return hostname();
  },
  serve(store: ChannelStore, opts: ServeOptions): Promise<number> {
    const srv = serve(store, opts);
    return new Promise(() => {});
  },
  createSocket: realSocket,
};

if (import.meta.main) {
  main(process.argv.slice(2), io).then((code) => process.exit(code));
}