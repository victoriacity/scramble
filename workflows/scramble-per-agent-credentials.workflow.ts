export const meta = {
  name: 'scramble-per-agent-credentials',
  description: "Every Slack call uses the acting agent's own credentials, not the config default",
  phases: [{ title: 'creds' }],
}

phase('creds')
const out = await agent(`You are fixing a defect in "scramble", the repo you are running in,
found while verifying the new self-onboarding path. Read scripts/onboard-agent.ts,
src/slack-backend.ts, src/cli.ts and docs/slack-setup.md first.

THE DESIGN THIS BREAKS. scramble is one Slack app PER AGENT: each agent has its own bot
token, and \`scripts/onboard-agent.ts\` now creates and installs that app for the agent
itself. The config holds \`agents: { <name>: { token } }\` for exactly that reason.

THE DEFECT. Only \`post\` honours it. In src/slack-backend.ts:

    line 215  const token = this.agents[as]?.token ?? this.token;   // post: correct
    line 245  { headers: { authorization: \`Bearer \${this.token}\` } }
    line 465  { headers: { authorization: \`Bearer \${this.token}\` } }
    line 496  { headers: { authorization: \`Bearer \${this.token}\` } }
    line 284  downloadFile(this.fetch, f.url_private, this.token, ...)

so every read, every threaded-reply expansion and every attachment download uses the
config's DEFAULT token, whoever the acting agent is. Measured: a freshly onboarded agent
whose own app had never been invited to a private channel ran
\`message read --target <that channel> --as <itself>\` and got 89 lines, because the read
went out as the default app. An agent reading a conversation it has no access to, through
another agent's credential, is both a wrong answer and a wrong identity.

Socket Mode has the same shape one level up: \`appToken\` is a single top-level config key,
so \`listen\` and \`next\` connect as the default app and deliver ITS event stream. With one
app per agent, two agents listening would both receive the first app's events.

DELIVER:

1. Every Slack call takes the ACTING agent's credential, with the config default as the
   fallback, the way \`post\` already does. One helper that answers "which token for this
   agent", used by every call site, rather than the expression repeated at each one.
2. Per-agent app-level tokens: \`agents: { <name>: { token, appToken } }\`. The socket
   connect uses the acting agent's \`appToken\` when present and the top-level one
   otherwise, so a single-app config keeps working unchanged.
3. The inbound attachment download uses the acting agent's token too, since file access
   follows the app.
4. A verb whose acting agent has no token and where no default exists must FAIL saying
   which agent and which config key, never fall back to silence.
5. \`scripts/onboard-agent.ts\` writes the per-agent \`appToken\` it already receives from
   apps.developerInstall (it currently stores it only as the top-level default). Keep the
   merge behavior: an existing config gains the new agent without losing the others.
6. \`docs/slack-setup.md\`: the config key table gains \`appToken\` under \`agents\`, and says
   that every call uses the acting agent's credential.

TESTS, behavioral, with injected seams:
- a read as agent B goes out with B's token, proven by asserting the Authorization header,
  and a read as an agent with no token of its own uses the default;
- a threaded-reply expansion and an attachment download both use the acting agent's token;
- the socket connect uses the acting agent's appToken when present, the top-level one when
  not;
- a verb whose agent has no token and no default available exits nonzero naming the agent
  and the key.

INVARIANTS: TypeScript on bun, strict, ZERO runtime dependencies. Do not change the config
file's existing shape beyond ADDING the optional per-agent appToken. The FULL gate must be
green: run \`bash scripts/gate.sh\` and paste its summary lines plus the coverage table.
GATE GREEN at 100% coverage is the definition of done.`)
return { out }
