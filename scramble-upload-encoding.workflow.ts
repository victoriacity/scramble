export const meta = {
  name: 'scramble-upload-encoding',
  description: 'Slack file upload rejects a JSON body; send the form encoding it requires',
  phases: [{ title: 'upload' }],
}

phase('upload')
const out = await agent(`You are fixing a defect in "scramble", the repo you are running in,
found by a live test against a real Slack workspace. Read src/attachments.ts first. Work
ONLY in src/attachments.ts and its test file: other units are editing the other sources
right now, and a second file in your diff will collide with them.

THE DEFECT, measured live. \`scramble message send --target team --as akari --attach <file>\`
prints \`invalid_arguments\` and exits 1. No file has ever reached Slack through scramble.

THE CAUSE, proven by two probes with the same token against the real endpoint.
\`readSlack\` in src/attachments.ts sends \`content-type: application/json\` with a
JSON.stringify body. Sent that way, files.getUploadURLExternal answers:

    {"ok":false,"error":"invalid_arguments","response_metadata":{"messages":[
      "[ERROR] missing required field: length","[ERROR] missing required field: filename"]}}

so Slack does not read JSON fields on this endpoint at all. The same call form-encoded
(\`content-type: application/x-www-form-urlencoded\`, \`filename=…&length=…\`) answers
\`{"ok":true,"upload_url":"https://files.slack.com/upload/v1/…","file_id":"F0EXAMPLE011"}\`.
chat.postMessage does accept JSON, which is why sending TEXT has always worked and only the
upload path was dead.

DELIVER:

1. The two file endpoints send form encoding. files.getUploadURLExternal takes
   \`filename\` and \`length\`. files.completeUploadExternal takes \`channels\` and \`files\`,
   where \`files\` is a JSON-encoded STRING of the array (a form field cannot hold an
   array), so \`files=[{"id":"F…","title":"…"}]\` goes over the wire as one urlencoded
   value. Set an explicit charset on the content type: the probe returned a
   \`missing_charset\` warning.
2. A FAILING UPLOAD KEEPS ITS DETAIL. Slack put the actual reason in
   \`response_metadata.messages\` while \`error\` said only \`invalid_arguments\`, which is why
   this took a live probe to diagnose. When Slack answers ok:false, the returned error text
   must carry \`error\` AND those messages, so the next failure names itself.
3. The PUT of the bytes currently swallows every outcome: \`catch { putBytes = new
   Uint8Array(0) }\` then \`void putBytes\`, so a rejected upload still proceeds to
   completeUploadExternal and can report success for a file that never landed. Check the
   PUT: a non-2xx response or a thrown request is a FAILURE returned to the caller with the
   status and the body text, not a discarded value.

TESTS, behavioral, with an injected fetch, each failing before the change:
- getUploadURLExternal receives \`application/x-www-form-urlencoded\` and a body parsing to
  exactly \`filename\` and \`length\`, and NOT a JSON body;
- completeUploadExternal receives the form encoding with \`files\` as a JSON string that
  parses back to one entry holding the file id and title;
- a Slack ok:false carrying \`response_metadata.messages\` produces an error containing both
  the error code and those messages;
- a PUT answering 400 fails the upload, and completeUploadExternal is never called;
- a successful three-step run returns the file id.

INVARIANTS: TypeScript on bun, strict, ZERO runtime dependencies. Keep the public signature
of \`uploadToSlack\` and the inbound download path as they are. The FULL gate must be green:
run \`bash scripts/gate.sh\` and paste its summary lines plus the coverage table. GATE GREEN
at 100% coverage is the definition of done.`)
return { out }
