#!/usr/bin/env bun
// src/bin.ts — the ONLY entrypoint. Binds ports and reads process.argv here so
// no test imports this file (keeping the coverage gate green). Everything else
// is delegated to src/cli.ts's main(argv, io).
import { createStore, type RoomStore } from "./store";
import { serve, type ServeOptions } from "./server";
import { main } from "./cli";

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
  serve(store: RoomStore, opts: ServeOptions): Promise<number> {
    const srv = serve(store, opts);
    return new Promise(() => {});
  },
};

if (import.meta.main) {
  main(process.argv.slice(2), io).then((code) => process.exit(code));
}