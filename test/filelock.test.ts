// test/filelock.test.ts: the lock every rewritten ledger holds.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../src/filelock";

const scratch = (): string => mkdtempSync(join(tmpdir(), "scramble-lock-"));

describe("withFileLock", () => {
  test("it returns the callback's value and releases the lock", () => {
    const f = join(scratch(), "deep", "ledger.json");
    expect(withFileLock(f, () => 42)).toBe(42);
    expect(existsSync(`${f}.lock`)).toBe(false);
    // The directory is created, so a fresh workspace does not spend the whole
    // wait failing to make a lock inside a missing directory.
    expect(existsSync(join(f, ".."))).toBe(true);
  });

  test("a callback that throws still releases the lock", () => {
    const f = join(scratch(), "ledger.json");
    expect(() => withFileLock(f, () => {
      throw new Error("boom");
    })).toThrow("boom");
    expect(existsSync(`${f}.lock`)).toBe(false);
  });

  test("a lock left behind by a dead process is BROKEN, and reported", () => {
    // A process killed while holding it must not freeze the file forever, and
    // breaking one silently would hide a wedged process.
    const f = join(scratch(), "ledger.json");
    mkdirSync(`${f}.lock`, { recursive: true });
    const notes: string[] = [];
    expect(withFileLock(f, () => "ran", (n) => notes.push(n))).toBe("ran");
    expect(notes.join(" ")).toContain("was held for 1s, breaking it");
    expect(existsSync(`${f}.lock`)).toBe(false);
  });
});
