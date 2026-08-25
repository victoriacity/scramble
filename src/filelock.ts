// ONE LOCK, FOR EVERY FILE SEVERAL PROCESSES REWRITE.
//
// A ledger that is read, changed and written back loses writes the moment two
// processes do it at once, and scramble runs several: a listener, a send, an
// expiry sweep, a sweep on a timer, and one of each per agent sharing a host.
//
// Measured, twice:
//   status.json  eight processes adding one channel each kept TWO of eight.
//   inbox/*.jsonl  eight processes closing one item each left TWO still open,
//                  which nags an agent about questions it has answered.
//
// A directory is the lock: creating one is atomic on every filesystem this runs
// on and needs no library. The wait is SYNCHRONOUS so callers that are not async
// keep working, and the read must happen inside the callback, since a caller
// that read first would still be deciding from a stale copy.
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

/** Tries and interval, so a wedged lock costs a second and never a session. */
const TRIES = 100;
const WAIT_MS = 10;

/** Hold the lock for `file`, run `change`, release. `onBroken` is called when the
 *  lock had to be broken, so the caller can report it on its own diagnostic
 *  channel: a process killed while holding a lock must not freeze the file
 *  forever, and breaking one silently would hide a wedged process. */
export function withFileLock<T>(file: string, change: () => T, onBroken?: (note: string) => void): T {
  const lock = `${file}.lock`;
  // The directory may not exist on a fresh workspace, and mkdir of the lock
  // inside a missing directory fails every try, burning the whole wait before a
  // write that would have worked.
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
      /* another process broke it first; proceed without holding it */
    }
  }
  try {
    return change();
  } finally {
    try {
      rmSync(lock, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
}
