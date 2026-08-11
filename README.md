# @pingroom/cli

Send PingRoom pings — and ask a human a question and block for their answer —
from CI, scripts, and agents. Delivered as push straight to your phone.

One dependency (`qrcode-terminal`, used only to draw the pairing QR). Works
anywhere Node ≥ 20 runs.

> **Release status:** npm currently serves 0.6.0. The automatic verified-phone
> activation flow and `pingroom activate` documented below are in the tested
> 0.6.1 release candidate on `main`; the public GitHub Action remains pinned to
> 0.6.0 until 0.6.1 is published and clean-install verified.

## Install and first run

Install globally, then connect:

```bash
npm install --global @pingroom/cli
pingroom
```

Or use it without a global install:

```bash
npx --yes @pingroom/cli
```

Either command starts the same connection prompt. QR pairing stores the selected
account, credential, and delivery room in `~/.pingroom`; later commands reuse
them, so a local invocation needs neither `PINGROOM_TOKEN` nor `PINGROOM_ROOM`.
The email fallback stores the credential only. Setting
`pingroom config set default_room <invite-code>` enables room-addressed commands,
but private Agent Inbox and Handoff delivery require a connection approved with
a delivery room. Use QR pairing for the complete flow.

```bash
pingroom ping -m "Deploy succeeded ✅"
# or: npx --yes @pingroom/cli ping -m "Deploy succeeded ✅"
```

Commands: `ping` (send), `ask` (ask a human), `watch` (block on an existing
question), `list`, `cancel`, `handoff` (hand a decision to a specific human),
`handoffs` (list open or recent Handoffs), `live` (lock-screen progress card),
`hook` (Claude Code), `mcp` (client setup), `activate` (retry the Agent Inbox
test), `config`, and `logout`.
Run `pingroom --help` for the full reference.

## Connecting

Run `pingroom` (global install) or `npx --yes @pingroom/cli` (no install) with no
arguments. It prints a QR code — scan it with the PingRoom app and pick both the
account and the room the agent delivers to — or take the emailed-code fallback.

```
$ pingroom
  Not connected. How do you want to connect?
    1) Scan a QR code with the PingRoom app
    2) Email me a code
  Choose [1]:

  [QR]
  Or open: https://pingroom.io/app/agents/pair?token=…
  Waiting for approval… ✓ Connected as @agt_ab12cd34ef → #Project X
  Sending a test question to PingRoom…
  Answer “PingRoom connected. Can you answer this?” on your phone.
✓ Test question answered (Yes). Agent Inbox is ready.
```

After QR approval, the CLI saves the active credential first, then sends one
idempotent onboarding Question and observes it through the Handoff wait API.
Short network and server failures are retried, and `Retry-After` is honored for
rate limits within the two-minute overall deadline. An answer alone is not
reported as success: the terminal response must also carry the server's exact
`activation_completed: true` stamp. On supporting server and mobile builds,
that stamp means the native phone returned the opaque proof carried in the push
before the human answer, and this CLI then observed the result. An answered
response whose stamp is false or missing is incomplete and is not retried as if
history could be rewritten. If the Question is still pending when the local
deadline elapses, or activation cannot start, the CLI prints the recovery
command and exits with the connection still saved and usable. A terminal test
without the stamp requires a current PingRoom app and a fresh numbered attempt;
run `pingroom activate` again with the saved connection.

Resume an open idempotent check with the saved QR credential:

```bash
pingroom activate
```

An incomplete explicit retry exits `1`; it never deletes or replaces the saved
credential. The command does not fall back to `PINGROOM_TOKEN`, an email-only
credential, or a credential without `pingroom:handoffs:create` and a
QR-selected delivery room. Email-code and other non-interactive credential
flows do not run the phone-response loop automatically.

There is deliberately no `login` command: being unconnected is a state the tool
resolves, not one you have to discover. Once connected, bare `pingroom` prints
that status line followed by the usual help.

The credential lands in `~/.pingroom/credentials.json` (mode `0600`, inside a
`0700` directory). `PINGROOM_HOME` moves that directory; `pingroom logout`
clears it.

**CI is unaffected.** `PINGROOM_TOKEN` in the environment always outranks the
stored credential, and a non-interactive shell never prompts and never draws a
QR — a command that needs a credential and has none fails with exit `2` pointing
at `PINGROOM_TOKEN`.

### Local settings

```bash
pingroom config set default_room ab12cd     # fallback for --room
pingroom config set api_url https://api.pingroom.io
pingroom config get default_room
pingroom config list
pingroom config set api_url ""              # an empty value clears the key
```

Precedence, highest first:

```
explicit flag  >  env var  >  ~/.pingroom/config.json  >  built-in default
```

So `--room` beats `PINGROOM_ROOM` beats `default_room` (and, last of all, the
room the credential was paired to); `--api` beats `PINGROOM_API_URL` beats
`api_url`.

A stored paired credential is bound to the API origin that issued it. An API
override can change the path on that origin, but the CLI refuses to send the
stored bearer to a different origin. For an intentional custom-host override,
provide that host's token explicitly with `--token` or `PINGROOM_TOKEN`.

## Getting a webhook URL

In the PingRoom app, open a room → **Connections → Incoming webhooks → Add**. Copy the
URL (it embeds its own secret — treat it like a password and store it as a CI secret).

## Usage

```
pingroom ping [options]

  -m, --message <text>   Ping body text (required)
  -t, --title <text>     Ping title (<= 40 chars)
  -a, --action <1-4>     Quick-action slot to attribute the ping to
  -d, --data <json>      Extra JSON data, e.g. '{"commit":"abc123"}'
      --url <https-url>  Make the ping a tappable link (absolute http(s) URL)
      --button-label <t> Link button text (<= 26 chars; requires --url)
      --require-ack      Keep the ping open until an eligible recipient acknowledges it
      --ack-timeout <s>  Ack deadline in seconds (requires --require-ack)
      --attach <path>    Attach a file; repeat for up to 4 (requires --token)
  -w, --webhook <url>    Room webhook URL (or env PINGROOM_WEBHOOK_URL)
      --token <token>    Agent access token (or env PINGROOM_TOKEN)
      --room <code>      Room invite code (used with --token)
      --api <url>        API base URL (env PINGROOM_API_URL)
      --json             Print the raw JSON response
```

To make the ping actionable, add `--require-ack`. The first eligible recipient to
acknowledge it wins; `--ack-timeout` optionally expires it if nobody responds:

```bash
pingroom ping -w "$PINGROOM_WEBHOOK_URL" -m "Production health check failed" \
  --require-ack --ack-timeout 300
```

Webhook timeouts accept 1–86400 seconds. Agent-token room pings accept
60–86400 seconds.

To attach a tappable link button (a "link ping"), add `--url` and optionally
`--button-label`. They fold into the structured `data` object as
`{"url": ..., "button_label": ...}` — the same convention accepted raw via
`--data`:

```bash
pingroom ping -w "$PINGROOM_WEBHOOK_URL" -m "Build 512 ready" \
  --url https://ci.example.com/builds/512 --button-label "Open build"
```

The URL must be absolute http(s) (≤ 2048 chars); the label caps at 26 chars.

To send the file itself rather than a link to it, use `--attach`. Each file is
uploaded separately and only the resulting ids ride the ping; recipients open
them from the ping, authenticated:

```bash
pingroom ping --token "$PINGROOM_TOKEN" --room AB12 -m "Nightly report" \
  --attach ./report.pdf --attach ./summary.md
```

Accepted types are `md`, `pdf`, `html`, `txt`, `jpg`, `jpeg`, `png`, up to
5 MiB each and at most 4 per Ping. `--attach` needs an agent token — a webhook ping
has no uploader identity to bind private files to — and the bound account must
hold Pro (otherwise the upload fails with `pro_required`). An upload that never
reaches a ping expires by itself after 24 hours.

Exit codes: `0` success · `1` delivery failed · `2` bad usage. So CI fails loudly if a
ping doesn't land.

## Live Activities (`pingroom live`)

A **live-status stream** is one long-running thing shown as a self-updating card
on the Lock Screen (iOS Live Activity / Dynamic Island, Android live update, and
a full inline card in the app). `start` opens it with one alert, `update` moves
it **silently**, `end` closes it with one completion alert.

```
pingroom live <start|update|end|get> [options]

  -c, --correlation-id <id>  The stream key — reuse it for every ping (required)
      --template <name>      start only: status | steps | progress | metrics |
                             countdown | question | matchup (fixed at creation)
      --steps <a,b,c>        start only: 2-8 comma-separated step labels
  -m, --message <text>       The card's live message line
      --progress <0..1>      Progress bar / Dynamic Island gauge
      --step <n>             Current step index (steps template)
      --metric <label:value> Repeatable, up to 3 (metrics template)
      --deadline-at <epoch>  Countdown target (countdown template)
      --eta-at <epoch>       Live ETA (status/progress templates)
      --prompt <text>        The ask (question template)
      --option <value:label> Repeatable, up to 4 (question template)
      --left <label:value>   Left side (matchup template)
      --right <label:value>  Right side (matchup template)
      --center <text>        Center score/clock, <= 40 (matchup template)
      --accent-override <#rrggbb>  Semantic accent for this frame
      --failed               end only: finish as failed instead of done
  -t, --title <text>         Card title (<= 40 chars)
  -a, --action <1-4>         Quick-action slot supplying the icon and sound
      --require-ack          Add an Acknowledge button
      --ack-timeout <s>      Ack deadline in seconds
  -w, --webhook <url>        Room webhook URL instead of a token
      --token <token>        Agent access token (or env PINGROOM_TOKEN)
      --room <code>          Room invite code (used with --token)
```

Works with either an agent token (`--token`, needs the `pingroom:live:write`
scope) or a room's incoming webhook (`--webhook`, Pro) — both speak the same
`live_status` contract.

```bash
# Track a deploy end to end.
pingroom live start  -c deploy-42 --template steps \
  --steps "Build,Test,Deploy,Verify" -t "Release 1.4.0"
pingroom live update -c deploy-42 --step 2 -m "Deploying to prod"
pingroom live end    -c deploy-42 -m "Shipped 1.4.0"     # add --failed to fail it
```

All 7 templates are expressible:

```bash
# question — up to 4 options. A bare token is both value and label.
pingroom live start -c q1 --template question \
  --prompt "Deploy where?" --option prod:Production --option staging:Staging

# matchup — two sides plus a center score/clock.
pingroom live start -c game-3 --template matchup \
  --left ARS:2 --right CHE:1 --center "68'"

# metrics — up to 3 counters.
pingroom live start -c host-1 --template metrics --metric "CPU:45%" --metric "RPS:1.2k"

# countdown — a large live timer.
pingroom live start -c win-9 --template countdown --deadline-at 1750003600
```

`--accent-override` takes `#rrggbb` **or** a bare `rrggbb` (case-insensitive;
it is normalized to lowercase with the `#` before it is sent). Pass it bare, or
quote it — an *unquoted* `#` starts a comment in `sh`, `bash` and `zsh`, which
eats the hex and the rest of the line, and the CLI then exits `2` with
`option --accent-override needs a value`:

```bash
pingroom live update -c deploy-42 --accent-override e33122      # ok
pingroom live update -c deploy-42 --accent-override '#e33122'   # ok
pingroom live update -c deploy-42 --accent-override #e33122     # shell eats it
```

**Always `end` a stream.** Terminal `done`/`failed` pings are never rate-limited
or quota-blocked, precisely so a card can't be metered into hanging open on
someone's Lock Screen. Abandoned streams are swept after ~15 minutes.

`--template` and `--steps` are fixed when the stream is created; passing them to
`update`/`end` is a usage error rather than a silent no-op. `pingroom live get`
(agent token only) reads a stream back — every stored field — so a restarted
producer reconciles instead of opening a duplicate.

Full protocol: <https://pingroom.io/liveactivities.md>

## GitHub Actions

```yaml
# Notify on deploy
- uses: pingroom/cli@v0
  with:
    webhook-url: ${{ secrets.PINGROOM_WEBHOOK_URL }}
    title: 'Deploy'
    message: '🚀 ${{ github.repository }} deployed (${{ github.sha }})'
    data: '{"ref":"${{ github.ref_name }}","run":"${{ github.run_id }}"}'

# Notify only on failure
- if: failure()
  uses: pingroom/cli@v0
  with:
    webhook-url: ${{ secrets.PINGROOM_WEBHOOK_URL }}
    title: 'CI failed'
    message: '❌ ${{ github.workflow }} failed on ${{ github.ref_name }}'
    action: '2'
    require-ack: 'true'
    ack-timeout: '300'

# Gate a job on a human handoff — the step fails (non-zero) on expiry, so the
# job stops unless someone answers. Read the decision from the step outputs.
- id: gate
  uses: pingroom/cli@v0
  with:
    token: ${{ secrets.PINGROOM_TOKEN }}
    message: 'Ship ${{ github.sha }} to production?'
    handoff: 'true'
    question: 'true'
    options: 'deploy:Deploy,hold:Hold'
    idempotency-key: 'deploy-${{ github.run_id }}'
    wait: 'true'
- if: steps.gate.outputs.answer == 'deploy'
  run: ./deploy-prod.sh
```

The handoff action exposes outputs `handoff-id`, `state`, `acknowledged-by`,
`answer`, and `delivery-state`.

## GitLab CI

```yaml
notify:
  stage: .post
  image: node:20-alpine
  script:
    - npx --yes @pingroom/cli ping -t "Deploy" -m "🚀 $CI_PROJECT_NAME @ $CI_COMMIT_SHORT_SHA"
  variables:
    PINGROOM_WEBHOOK_URL: $PINGROOM_WEBHOOK_URL   # set as a masked CI/CD variable
```

## Plain shell / curl

The webhook is just an HTTP POST, so you don't even need this CLI:

```bash
curl -fsS -X POST "$PINGROOM_WEBHOOK_URL" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Deploy","message":"🚀 shipped"}'
```

## Agent token mode

For an agent acting as a user (e.g. an OAuth/auth.md credential), send to a room the
agent belongs to instead of a webhook:

```bash
pingroom ping --token "$PINGROOM_TOKEN" --room ab12cd -m "Release shipped" \
  -d '{"version":"1.4.0"}'
```

## Ask a human (Questions)

Turn a human decision into a shell gate. `ask --wait` blocks until someone taps
an answer on their phone, prints the chosen option **value** to stdout, and
encodes the outcome in the exit code — `0` answered, `3` expired, `4` cancelled.
Needs an agent token and a room.

```bash
# Gate a production deploy on a lock-screen tap (Approve/Deny is the default):
if [ "$(pingroom ask --token "$PINGROOM_TOKEN" --room ab12cd --wait \
      -p 'Deploy 1.4.0 to production?')" = approve ]; then
  ./deploy-prod.sh
fi

# A multi-option question, answerable by anyone in the room:
pingroom ask --token "$PINGROOM_TOKEN" --room ab12cd --scope room --wait \
  -p 'Which environment?' -o prod:Production -o staging:Staging -o cancel:Cancel

# Fire-and-forget (prints the question id), then watch it later:
ID=$(pingroom ask --token "$PINGROOM_TOKEN" --room ab12cd -p 'Merge PR #42?' --ttl 1800)
pingroom watch --token "$PINGROOM_TOKEN" "$ID"

pingroom list   --token "$PINGROOM_TOKEN" --state pending
pingroom cancel --token "$PINGROOM_TOKEN" "$ID"
```

Options are `value:label` pairs (repeat `-o` for 2–4). Omit them for the binary
Approve/Deny default — two options is the lock-screen fast path. `--ttl` sets the
expiry in seconds (default 1h; 30–86400). `--scope room` lets any eligible member
answer (first tap wins); the default `direct` asks your bound user.

## Handoffs (agent → human)

`handoff` hands a single decision to a specific human — either a simple
**acknowledge** ("ack to proceed") or a **question** with options. It needs an
agent token whose consent grants `pingroom:handoffs:create`. Unlike `ask`, a
handoff targets a user directly (default `me`, the bound user) rather than a
room, and prints machine-readable `key=value` lines.

```bash
# Ack handoff — block until the human acknowledges (exit 0), or it expires (3):
pingroom handoff --token "$PINGROOM_TOKEN" -m "Prod deploy 1.4.0 — ack to proceed" --wait

# Question handoff, blocking, branch in CI on the exit code:
pingroom handoff --token "$PINGROOM_TOKEN" --wait \
  -m "Ship 1.4.0 to production?" --question -o deploy:Deploy -o hold:Hold
# exit 0 = answered (ANY value, incl. 'hold' — a negative human decision is not a failure)
# exit 3 = expired    exit 4 = cancelled / recipient not ready    exit 1 = error
```

Flags: `--question` (or any `-o value:label`, 2–4) makes it a question, else it's
an ack. `--target me|<uuid>` picks the recipient. `--expires-in <s>` (120–86400,
default 900). `--urgency active|passive`. `--idempotency-key <key>` is sent as
the `Idempotency-Key` header so network retries collapse to one handoff (the
server 409s on a key reused with a different payload). `--correlation-id` /
`--reply-to` / `-d '{...}'` are echoed back. Add `--wait` to long-poll to a
terminal state; without it the command prints the created handoff and returns 0.

List unresolved Handoffs or bounded recent history without changing the legacy
question-only `list` command:

```bash
pingroom handoffs --token "$PINGROOM_TOKEN"                 # open only
pingroom handoffs --token "$PINGROOM_TOKEN" --state all     # recent, up to 200 per kind
```

A negative answer (`hold`, `deny`, …) is a **successful** `answered` state and
exits `0` — branch on the printed `answer=` line, not on the exit code.

## Claude Code integration (get pinged by your agent)

Wire PingRoom into [Claude Code](https://claude.com/claude-code) hooks so your
agent pings your phone when it finishes — and asks for your approval, on your
lock screen, before it runs a command. Approve or Deny with a tap; the agent
waits for your answer and continues.

Print a ready-to-paste config:

```bash
pingroom hook --print-config
# no global install: npx --yes @pingroom/cli hook --print-config
```

If you have not connected yet, run `pingroom` (or `npx --yes @pingroom/cli`) and
scan the QR first. The hook reads the stored credential and the room selected
during pairing automatically. No environment variables are needed for a normal
local setup; merge the printed `hooks` block into `~/.claude/settings.json`.

Environment variables remain available for CI and other headless shells, and
take precedence over the paired values:

```bash
export PINGROOM_TOKEN="<your agent token>"
export PINGROOM_ROOM="<room invite code>"
```

`pingroom hook` reads the Claude Code hook event on stdin and reacts by event:

| Hook event | What happens |
| --- | --- |
| `Stop` / `SubagentStop` | Pings the room with the agent's last message (“Claude finished”). |
| `Notification` | Pings when the agent is idle or waiting for input (permission prompts are skipped — the `PreToolUse` question already covers those). |
| `SessionEnd` | Pings when a session ends (except `/clear`). |
| `PreToolUse` | Asks a PingRoom **question** and gates the tool call on your Approve/Deny tap. Which tools are gated is the settings.json `matcher` (default `Bash`) — not the CLI. |

**It always fails open.** If PingRoom is unreachable, the token/room is missing,
or the question expires, the hook defers to the normal local prompt
(`permissionDecision: "ask"`) and exits 0. It never auto-approves and never
blocks the agent. Because the `PreToolUse` hook holds the tool call open while it
waits for you, give it a generous `timeout` (the printed config uses 960s) and
tune the approval-question expiry with `--ttl <seconds>` (default 900).

## MCP client setup

Print the canonical remote endpoint, a copy-ready Claude Code command, Cursor
JSON, and the Claude Desktop custom-connector steps:

```bash
pingroom mcp
# no global install: npx --yes @pingroom/cli mcp
```

`pingroom mcp add claude-code` prints the exact `claude mcp add` command but does
not execute it or modify client configuration. After adding the server, use the
client's MCP controls to authenticate in the browser; no PingRoom API key is
pasted into its config.

For a fully typed client, use [`@pingroom/sdk`](https://www.npmjs.com/package/@pingroom/sdk).
See <https://pingroom.io/connect-mcp.md> for the complete MCP and OAuth guide.

## License

MIT
