// ONE LOCK, FOR EVERY FILE SEVERAL PROCESSES REWRITE.
//
// When multiple processes read, modify, and rewrite a ledger concurrently, the
// ledger loses writes. The scramble system runs several such processes: a
// listener, a message sender, an expiry sweep, a timed sweep, and an instance of
// each for every agent sharing a host.
//
// Two measurements demonstrated this write loss:
// - In status.json, eight processes that each added one channel preserved two of
// eight additions.
// - In inbox/*.jsonl, eight processes that each closed one item left two items
// open, which nags an agent about questions it has answered.
//
// A directory serves as the lock because directory creation is atomic on every
// filesystem this runs on and requires no external library. The wait is
// synchronous so callers that are not async continue working, and the caller must
// perform the read inside the callback, since a caller that reads first still
// decides from a stale copy.
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

/**
 *  Retry counts and intervals limit delays, so a wedged lock costs a second and
 *  never a session.
 */
const TRIES = 100;
const WAIT_MS = 10;

/**
 *  The function holds the lock for `file`, runs `change`, and releases the lock.
 *  The function calls `onBroken` when the lock had to be broken, so the caller can
 *  report it on its own diagnostic channel. A process killed while holding a lock
 *  must not freeze the file forever, and breaking a lock silently would hide a
 *  wedged process.
 */
export function withFileLock<T>(file: string, change: () => T, onBroken?: (note: string) => void): T {
  const lock = `${file}.lock`;
  // The directory may not exist on a fresh workspace. Creating the lock inside a
  // missing directory fails on every attempt, which consumes the entire wait before
  // a write that would have succeeded.
  mkdirSync(dirname(file), { recursive: true });
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let held = false;
  for (let i = 0; i < TRIES; i += 1) {
    try {
      mkdirSync(lock);
      held = true;
      break;
    } catch {
      Atomics.wait(pause, 0, 0, WAIT_MS);
    }
  }
  if (!held) {
    onBroken?.(`the lock at ${lock} was held for ${(TRIES * WAIT_MS) / 1000}s, breaking it`);
    try {
      rmSync(lock, { recursive: true, force: true });
      mkdirSync(lock);
    } catch {
      /**
       *  Another process broke it first. Proceed without holding it.
       */
    }
  }
  try {
    return change();
  } finally {
    try {
      rmSync(lock, { recursive: true, force: true });
    } catch {
      /**
       *  The item is already gone.
       */
    }
  }
}

