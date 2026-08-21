export const meta = {
  name: 'scramble-attachments',
  description: 'Images and files both ways, mirroring raft attachment upload and view',
  phases: [{ title: 'attachments' }],
}

phase('attachments')
const out = await agent(`You are adding IMAGE AND FILE support to "scramble", the repo you
are running in. Read src/types.ts, src/slack.ts, src/slack-backend.ts, src/raft.ts,
src/cli.ts, PLAN.md ("The raft-mirrored surface") and skills/scramble/SKILL.md first.

WHY: a human drops a screenshot in Slack and the agent gets nothing. The Slack event
carries a \`files\` array, and the app already holds \`files:read\` and \`files:write\`, so
the data and the permissions are there and scramble ignores both.

MIRROR THE RAFT GRAMMAR, which is already installed on this host. Verified with --help:
- \`raft attachment upload --path <file> --target <target> [--mime-type <type>]\`
- \`raft attachment view <attachmentId> [--path <out>]\`
So scramble gets \`scramble attachment upload --path <file> --target <channel>\` and
\`scramble attachment view <id> [--path <out>]\`.

DELIVER:

1. \`src/types.ts\`: \`Message\` gains an OPTIONAL
   \`files?: { id: string; name: string; mime: string; size?: number; path?: string }[]\`.
   Absent when a message carries no file, so every existing line shape is unchanged.

2. INBOUND, in src/slack.ts and src/slack-backend.ts. When a Slack message event carries
   \`files\`, download each one and put it on the line:
   - fetch the file's \`url_private\` with the bot token in an Authorization header, which
     is what \`files:read\` grants; a plain unauthenticated GET returns HTML, not bytes,
     so assert the response is not HTML and REPORT when it is.
   - save under a directory the config names (\`filesDir\`, default
     \`~/.config/scramble/files\`), as \`<file id>-<sanitized name>\`, and put that absolute
     path in \`path\`.
   - a download failure REPORTS the Slack error and still delivers the message with the
     file's metadata and no \`path\`, so the agent learns a file exists and that fetching
     it failed. Never drop the message because a file failed.
   The local path is the point: it is what lets a session read an image the human posted.

3. OUTBOUND: \`scramble attachment upload --path <file> --target <channel>\` uploads to
   Slack with the modern three-step flow, since \`files.upload\` is retired:
   \`files.getUploadURLExternal\` for the upload url and file id, a PUT of the bytes to
   that url, then \`files.completeUploadExternal\` with the target channel. Print the file
   id on stdout as one JSON line. \`--mime-type\` overrides the guess. In the raft backend
   shell out to \`raft attachment upload\`; in the local backend copy the file into
   \`filesDir\` and record it.

4. \`scramble attachment view <id> [--path <out>]\` writes a stored or remote file to disk
   and prints the path it wrote, mirroring \`raft attachment view\`.

5. \`scramble message send\` gains \`--attach <path>\` (repeatable), which uploads then
   sends so the message and its files arrive together.

6. skills/scramble/SKILL.md: a short section saying a line may carry \`files\`, that each
   entry's \`path\` is a local file the session can read, and how to attach one when
   sending. Re-lint with
   \`python3 skills/scramble/lint_language.py skills/scramble/SKILL.md\` until 0 hits.

TESTS, behavioral, with every network seam injected so no token and no network are
needed:
- an inbound message with one file lands with \`files[0].path\` pointing at a written
  file whose bytes match what the fake returned;
- an inbound download that returns HTML is REPORTED and the message still arrives with
  metadata and no path;
- a message with no files carries no \`files\` field at all;
- the upload flow calls getUploadURLExternal, then PUTs the bytes, then
  completeUploadExternal with the right channel, in that order;
- \`--attach\` uploads before sending, and the sent message references the file id;
- \`attachment view\` writes to the given path and prints it.

INVARIANTS: TypeScript on bun, strict, ZERO runtime dependencies. Size guard: refuse a
file over 50MB with the size it saw, matching raft's limit. The FULL gate must be green:
run \`bash scripts/gate.sh\` and paste its summary lines plus the coverage table. GATE
GREEN at 100% coverage is the definition of done.`)
return { out }
