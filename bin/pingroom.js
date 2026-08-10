#!/usr/bin/env node
// @pingroom/cli — pings and human-in-the-loop questions for CI, scripts, agents.
// Node's built-in fetch (Node >= 20) plus one optional dependency,
// `qrcode-terminal`, used only to draw the pairing QR. Its absence degrades to
// printing the pair URL, so every non-interactive path stays dependency-free.
//
// Run bare (`pingroom`) it resolves its own auth: connected -> a status line and
// this help; not connected -> the pairing picker. There is deliberately no
// `login` subcommand.
//
// Commands:
//   ping     Send a ping to a room. Webhook mode (a room URL carries its own
//            secret — best for CI) or agent-token mode (Bearer + room code).
//   ask      Ask a human a question in a room and, with --wait, block until they
//            tap an answer — turning a human decision into a shell gate.
//   watch    Block until a question resolves and print the outcome.
//   list     List the agent's questions by state.
//   cancel   Withdraw a pending question.
//   handoff  Hand a decision to a specific human (ack or question) and, with
//            --wait, block until they acknowledge / answer.
//   handoffs List the agent's open handoffs or bounded recent history.
//   live     Drive a live progress card (iOS Live Activity / Android live
//            update) on the room members' lock screen: start / update / end.
//   mcp      Print the canonical remote MCP endpoint and client setup snippets.
//   activate Retry Agent Inbox activation with the saved QR-paired credential.
//   config   Read/write ~/.pingroom/config.json (default_room, api_url).
//   logout   Forget the credential in ~/.pingroom/credentials.json.
//
// Exit codes: 0 success/answered/acked · 1 error · 2 bad usage · 3 expired ·
// 4 cancelled/recipient-not-ready.

import { randomBytes } from 'node:crypto';
import {
  appendFileSync, chmodSync, closeSync, fchmodSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Kept in lockstep with package.json / package-lock.json. The GitHub Action is
// pinned independently to the latest version already published on npm; a test
// makes that release gate explicit. `hook --print-config` emits this candidate.
const VERSION = '0.6.1';

const BUILTIN_API = 'https://api.pingroom.io';
const MCP_ENDPOINT = `${BUILTIN_API}/api/agent/mcp`;
const DEFAULT_API = process.env.PINGROOM_API_URL || BUILTIN_API;

const HELP = `pingroom — send a ping, or ask a human a question, from CI/scripts/agents

Usage:
  pingroom <command> [options]

Commands:
  ping     Send a ping to a room (webhook URL, or agent token + room)
  ask      Ask a human a question; with --wait, block until they answer
  watch    Block until a question resolves and print the outcome
  list     List the agent's questions by state
  cancel   Withdraw a pending question
  handoff  Hand a decision (ack or question) to a specific human; with --wait,
           block until they acknowledge or answer
  handoffs List the agent's open handoffs or bounded recent history
  live     Drive a live progress card on the lock screen (Live Activity)
  hook     Claude Code hook: ping on Stop/Notification, and route tool
           permission prompts to a PingRoom question you answer from your phone
  mcp      Print the remote MCP endpoint and setup for Claude Code, Cursor, and
           Claude Desktop
  activate Retry Agent Inbox activation with the saved QR-paired credential
  config   Read/write local settings (config list | get <key> | set <key> <val>)
  logout   Forget the stored credential

ping options:
  -m, --message <text>   Ping body text (required)
  -t, --title <text>     Ping title (<= 40 chars)
  -a, --action <1-4>     Quick-action slot to attribute the ping to
  -d, --data <json>      Extra JSON data object, e.g. '{"commit":"abc123"}'
      --url <https-url>  Make the ping a tappable link (absolute http(s) URL)
      --button-label <t> Link button text (<= 26 chars; requires --url)
      --require-ack      Keep the ping open until an eligible recipient acknowledges it
      --ack-timeout <s>  Ack deadline in seconds (requires --require-ack)
      --attach <path>    Attach a file (md/pdf/html/txt/jpg/jpeg/png, <= 20 MiB);
                         repeat for up to 10. Requires --token and a Pro account
  -w, --webhook <url>    Room webhook URL (or env PINGROOM_WEBHOOK_URL)
      --token <token>    Agent access token (or env PINGROOM_TOKEN)
      --room <code>      Room invite code (used with --token)

ask options (agent token required):
  -p, --prompt <text>    The question a human reads (required)
  -o, --option <v:label[:style]>
                         An answer option (style: primary|danger|default);
                         repeat for 2–4. Omit for Approve/Deny
  -c, --context <text>   Secondary line, e.g. a build number (<= 40 chars)
      --scope <s>        Who answers: 'direct' (default) or 'room'
      --target <uuid>    For --scope direct: a specific room member
      --ttl <seconds>    Expiry; omit for the server default (1h; 30..86400)
      --text-input <ph>  Invite a short typed answer; <ph> is the placeholder
      --text-max <n>     Max typed-answer length (1..60)
      --wait             Block until answered/expired/cancelled
      --timeout <sec>    Per long-poll hold with --wait/watch (0–30, default 25)
  -d, --data <json>      Structured data object echoed back on the answer
      --correlation-id <id>  Opaque id echoed on every read of this question
      --reply-to <id>    Id of the ping this question replies to
      --room <code>      Room invite code (required for ask)

list options:
      --state <s>        pending | answered | expired | cancelled | all

handoff options (agent token required; consent scope pingroom:handoffs:create):
  -m, --message <text>   The prompt a human reads (required)
      --question         Make it a question (else a simple acknowledge). Also
                         implied whenever one or more --option is given.
  -o, --option <v:label> A question option; repeat for 2–4. Requires --question.
      --target <id>      Recipient: 'me' (default) or a specific user uuid
      --expires-in <s>   Expiry in seconds (120..86400, default 900)
      --urgency <u>      'active' (default) or 'passive'
      --idempotency-key <key>  Dedupe key; retries reuse it (Idempotency-Key)
      --correlation-id <id>    Opaque id echoed on every read of this handoff
      --reply-to <id>    Opaque reply-to id echoed back
  -d, --data <json>      Structured data object echoed on the handoff
      --wait             Block until acked / answered / expired / cancelled
      --timeout <sec>    Per long-poll hold with --wait (0–20, server caps 25)
      --github-output <path>  Safely append handoff outputs for GitHub Actions

handoffs options (agent token required; consent scope pingroom:handoffs:create):
      --state <s>        open | all (default open)

live <start|update|end|get> options (agent token, or a room webhook):
  -c, --correlation-id <id>  The stream key — reuse it for every ping (required)
      --template <name>      start only: status | steps | progress | metrics |
                             countdown | question | matchup (fixed at creation)
      --category <name>      start only: status | steps | alert. Legacy, but
                             'alert' has no template equivalent and is the only
                             way to start time-sensitive without --require-ack
      --steps <a,b,c>        start only: 2-8 comma-separated step labels
  -m, --message <text>       The card's live message line
      --progress <0..1>      Progress bar / Dynamic Island gauge
      --step <n>             Current step index (steps template)
      --metric <label:value> Repeatable, up to 3 (metrics template)
      --deadline-at <epoch>  Countdown target (countdown template)
      --eta-at <epoch>       Live ETA (status/progress templates)
      --prompt <text>        The ask (question template)
      --option <value:label> Repeatable, up to 4 (question template). A bare
                             token is both value and label
      --left <label:value>   Left side (matchup template)
      --right <label:value>  Right side (matchup template)
      --center <text>        Center score/clock, <= 40 (matchup template)
      --accent-override <#rrggbb>  Semantic accent for this frame
      --failed               end only: finish as failed instead of done
  -t, --title <text>         Card title (<= 40 chars)
  -a, --action <1-4>         Quick-action slot supplying the icon and sound
      --require-ack          Add an Acknowledge button
      --ack-timeout <s>      Ack deadline in seconds
      --room <code>          Room invite code (used with --token)
  -w, --webhook <url>        Room webhook URL instead of a token

hook options (reads a Claude Code event; defaults to stored credentials/config):
      --room <code>      Room invite code (or env/config/paired room)
      --ttl <seconds>    Approval-question expiry for PreToolUse (default 900)
      --quiet            Suppress the informational stderr lines
      --print-config     Print a ready-to-paste ~/.claude/settings.json block

mcp:
  pingroom mcp                     Print the endpoint and client setup snippets
  pingroom mcp add claude-code     Print the Claude Code setup command
                                   (output-only; does not change client config)

activate:
  pingroom activate                Replay or create the next Agent Inbox test using
                                   the saved QR-paired credential

config options:
  pingroom config list              Print the stored settings
  pingroom config get <key>         Print one setting
  pingroom config set <key> <val>   Store a setting (an empty value clears it)
  Keys: default_room, api_url

Shared:
      --token <token>    Agent access token (or env PINGROOM_TOKEN)
      --api <url>        API base URL (default ${DEFAULT_API}; env PINGROOM_API_URL)
      --json             Print the raw JSON response
  -h, --help             Show this help
  -v, --version          Show the CLI version

Connecting:
  Install globally, then run with no arguments:
    npm install --global @pingroom/cli
    pingroom

  Or connect without installing globally:
    npx --yes @pingroom/cli

  It prints a QR code you scan with the PingRoom app — you pick the account and
  delivery room there. Once paired, it saves the credential, sends one test
  Question, and waits briefly for the server to confirm the completed phone
  round-trip; an answer alone is not treated as activation, and a setup problem
  never discards the usable connection. Run "pingroom activate" to retry that
  test later. The emailed-code fallback stores no server-side delivery room.
  "config set default_room" enables room-addressed commands, but private
  Inbox/Handoff delivery requires QR pairing.
  There is no "login" command: being unconnected is a state the tool resolves,
  not one you have to discover.

  The credential is written to ~/.pingroom/credentials.json (mode 0600, in a
  0700 directory). PINGROOM_HOME overrides that directory. PINGROOM_TOKEN in the
  environment ALWAYS wins over the stored credential, so CI is unaffected.
  "pingroom logout" forgets it.

  Settings precedence, highest first:
    explicit flag  >  env var  >  ~/.pingroom/config.json  >  the paired
    credential  >  built-in default
  So --room beats PINGROOM_ROOM beats "config set default_room", and --api beats
  PINGROOM_API_URL beats "config set api_url" beats the host you paired against,
  beats ${BUILTIN_API}. A stored credential is bound to the origin it was paired
  against: an API override may change the path on that origin, but a different
  origin is refused before the token is sent. To target another origin
  intentionally, provide that host's token with --token or PINGROOM_TOKEN.

  Non-interactive shells (CI, pipes) never prompt and never draw a QR: set
  PINGROOM_TOKEN there instead.

Examples:
  pingroom ping -w "$PINGROOM_WEBHOOK_URL" -m "Deploy succeeded ✅"
  pingroom ping --token "$PINGROOM_TOKEN" --room ab12cd -m "Release shipped"

  # Link ping — a tappable button that opens a URL:
  pingroom ping -w "$PINGROOM_WEBHOOK_URL" -m "Build 512 ready" \\
    --url https://ci.example.com/builds/512 --button-label "Open build"

  # Gate a deploy on a human tap — the chosen value prints to stdout:
  if [ "$(pingroom ask --token "$T" --room ab12cd --wait \\
        -p 'Deploy 1.4.0 to production?')" = approve ]; then ./deploy.sh; fi

  # Multi-option question, blocking:
  pingroom ask --token "$T" --room ab12cd --scope room --wait \\
    -p 'Which environment?' -o prod:Production -o staging:Staging

  pingroom list --token "$T" --state pending
  pingroom watch --token "$T" q_01H...   # block on an existing question
  pingroom cancel --token "$T" q_01H...

  # Hand a deploy decision to yourself and block on the acknowledgement:
  pingroom handoff --token "$T" -m "Prod deploy 1.4.0 — ack to proceed" --wait

  # A blocking question handed to a specific human; branch in CI on exit code:
  pingroom handoff --token "$T" -m "Ship 1.4.0?" --question \\
    -o deploy:Deploy -o hold:Hold --wait
  # -> exit 0 (answered, any value incl. 'hold'); 3 expired; 4 recipient-not-ready

  pingroom handoffs --token "$T" --state all   # recent history (up to 200/kind)

  # A live deploy card on everyone's lock screen — one stream, three calls:
  pingroom live start --token "$T" --room ab12cd -c "deploy-$GITHUB_RUN_ID" \\
    --template steps --steps "Build,Test,Stage,Ship" -t "Deploy 2.1.0"
  pingroom live update --token "$T" --room ab12cd -c "deploy-$GITHUB_RUN_ID" \\
    --step 2 -m "Smoke tests green"
  pingroom live end --token "$T" --room ab12cd -c "deploy-$GITHUB_RUN_ID" \\
    -m "Live on production"
  # ...or end it as a failure, which still delivers one completion alert:
  #   pingroom live end ... --failed -m "Rollback triggered"

  # Connect Claude Code hooks to your paired credential (no env vars needed):
  pingroom hook --print-config

  # Connect an MCP client through browser OAuth (no API key needed):
  pingroom mcp

Security:
  Prefer the env vars (PINGROOM_WEBHOOK_URL / PINGROOM_TOKEN) over passing
  secrets as --webhook / --token flags: argv is visible to other users via the
  process table (ps) and may be captured in shell history. URLs must use https
  (loopback http is allowed for local dev).

  A paired credential is only sent to its recorded API origin. --api,
  PINGROOM_API_URL and config.api_url cannot redirect that stored bearer to a
  different origin; provide an explicit --token or PINGROOM_TOKEN to override.

Exit codes: 0 on success (answered / acked), 1 on error (network/auth/5xx),
2 on bad usage, 3 when a handoff or question expired, 4 when it was cancelled
or the recipient was not ready (409 recipient_not_ready). A question answered
with ANY value — including a negative one like 'hold' or 'deny' — exits 0: a
human decision is not an infrastructure failure.`;

const EXIT = { OK: 0, ERROR: 1, USAGE: 2, EXPIRED: 3, CANCELLED: 4 };

function fail(message, code = EXIT.ERROR) {
  process.stderr.write(`pingroom: ${message}\n`);
  process.exit(code);
}

// --- local state (~/.pingroom) ---------------------------------------------
//
// Two files, both under a 0700 directory:
//   credentials.json  the agent credential this machine paired (mode 0600)
//   config.json       user settings: default_room, api_url
//
// PINGROOM_HOME relocates the directory (tests, sandboxes, multi-account
// shells). Every lookup is layered: explicit flag > env var > config file >
// the paired credential > built-in default. PINGROOM_TOKEN is the one env var
// that also outranks the stored credential, which is what keeps CI working
// untouched.

function pingroomHome() {
  return process.env.PINGROOM_HOME || join(homedir(), '.pingroom');
}

function credentialsPath() { return join(pingroomHome(), 'credentials.json'); }
function configPath() { return join(pingroomHome(), 'config.json'); }

// Read a JSON object, or null for anything unreadable/corrupt. Local state must
// never be able to crash a ping: a hand-edited file degrades to "not set".
function readJsonFile(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return null; }
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

// Write JSON with restrictive permissions, atomically.
//
// Writing in place truncates first, so a crash or a full disk between truncate
// and write leaves a half-written file — and readJsonFile() degrades anything
// unparseable to {}, so the *next* `config set` would silently drop every other
// setting. Writing a sibling temp file and renaming over the target means a
// reader only ever sees the old file or the new one, never a torn one.
//
// The temp file is opened 'wx' with mode 0600 and fchmod'd before a single byte
// is written: `mode` on an existing file is ignored and a post-write chmod
// leaves a window where the credential is world-readable. rename() carries the
// 0600 over the target, so a pre-existing loose file is tightened too.
//
// mkdirSync(recursive) returns the first path it created, or undefined when the
// directory already existed. chmod'ing only on the former keeps this from
// narrowing a directory the user deliberately created at 0755.
function writeJsonFile(path, value) {
  const dir = pingroomHome();
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  let fd;
  try {
    const created = mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (created !== undefined) chmodSync(dir, 0o700);

    fd = openSync(tmp, 'wx', 0o600);
    fchmodSync(fd, 0o600); // defeat a permissive umask masking the open mode
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already gone */ } }
    try { unlinkSync(tmp); } catch { /* never created */ }
    fail(`could not write ${path}: ${err.message}`);
  }
}

function readStoredCredential() {
  const cred = readJsonFile(credentialsPath());
  if (!cred || typeof cred.token !== 'string' || cred.token === '') return null;
  return cred;
}

function readConfigFile() {
  return readJsonFile(configPath()) || {};
}

/** Agent token: --token > PINGROOM_TOKEN > the paired credential. */
function resolveToken(args) {
  return args.token || process.env.PINGROOM_TOKEN || readStoredCredential()?.token || undefined;
}

/**
 * API base: --api > PINGROOM_API_URL > config.api_url > the host the credential
 * was paired against > built-in, no trailing slash.
 *
 * The credential layer is not optional. saveCredential() records `api_url`, and
 * a token minted by a self-hosted / staging server is only valid there; without
 * this layer the next command would present that bearer to api.pingroom.io —
 * leaking it to a host it was never issued for. resolveRoom() already consults
 * the credential last, so the two layerings now agree.
 *
 * It is also an issuer boundary when resolveToken() falls through to the stored
 * credential. Overrides may change the path on the same origin, but
 * requireStoredCredentialOrigin() refuses a different origin unless the caller
 * supplies an explicit --token or PINGROOM_TOKEN for that host.
 */
function resolveApiBase(args) {
  const raw = args.api
    || process.env.PINGROOM_API_URL
    || readConfigFile().api_url
    || readStoredCredential()?.api_url
    || BUILTIN_API;
  return String(raw).replace(/\/$/, '');
}

/**
 * A paired bearer belongs to the API origin that minted it. API settings still
 * resolve independently so callers can select a path or an intentional custom
 * host, but a stored token may only follow them within its recorded origin.
 * Supplying --token / PINGROOM_TOKEN makes the token source explicit and opts
 * out of this stored-credential binding.
 */
function storedCredentialOriginError(args, apiBase) {
  if (args.token || process.env.PINGROOM_TOKEN) return null;

  const credential = readStoredCredential();
  if (!credential || typeof credential.api_url !== 'string' || credential.api_url === '') return null;

  let credentialOrigin;
  let targetOrigin;
  try {
    credentialOrigin = new URL(credential.api_url).origin;
    targetOrigin = new URL(apiBase).origin;
  } catch {
    // URL validation owns malformed values. This guard only compares origins.
    return null;
  }

  if (credentialOrigin === targetOrigin) return null;
  return `stored credential is bound to ${credentialOrigin}; refusing to send it to ${targetOrigin}. Provide --token or PINGROOM_TOKEN for an intentional API origin override`;
}

function requireStoredCredentialOrigin(args, apiBase) {
  const error = storedCredentialOriginError(args, apiBase);
  if (error) fail(error, EXIT.USAGE);
}

/**
 * Room invite code: --room > PINGROOM_ROOM > config.default_room > the room the
 * credential was paired to. The paired room is last because it is the weakest
 * signal — it is where the agent was told to deliver, not necessarily where
 * this invocation means to.
 */
function resolveRoom(args) {
  return args.room
    || process.env.PINGROOM_ROOM
    || readConfigFile().default_room
    || readStoredCredential()?.room?.invite_code
    || undefined;
}

/**
 * True when it is safe to prompt / draw a QR. Both streams must be a TTY: a
 * piped stdin cannot answer a prompt and a piped stdout would capture the QR as
 * garbage.
 *
 * The override is deliberately double-locked (internal-looking name AND
 * NODE_ENV=test) and not documented in --help. A single well-known env var
 * shipping in the published binary is one stray `export` away from making a CI
 * job prompt into the void and poll for the full 15-minute pairing window
 * instead of failing in a second.
 */
function isInteractive() {
  if (process.env.PINGROOM_INTERNAL_TEST_TTY === '1' && process.env.NODE_ENV === 'test') return true;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// Drop C0/C1 control characters before echoing server-supplied text to the
// terminal. Without this an attacker-controlled API base can smuggle ANSI
// escapes into the output and repaint, erase or overwrite the lines around them.
function stripControlChars(value) {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
}

// --- ping (unchanged wire behaviour) ---------------------------------------

function parseArgs(argv) {
  const args = { _: [] };
  const alias = {
    '-m': 'message', '--message': 'message',
    '-t': 'title', '--title': 'title',
    '-a': 'action', '--action': 'action',
    '-d': 'data', '--data': 'data',
    '-w': 'webhook', '--webhook': 'webhook',
    '--url': 'url',
    '--button-label': 'button_label',
    '--require-ack': 'require_ack',
    '--ack-timeout': 'ack_timeout',
    '--attach': 'attach',
    '--token': 'token',
    '--room': 'room',
    '--api': 'api',
    '--json': 'json',
    '-h': 'help', '--help': 'help',
  };
  const booleans = new Set(['require_ack', 'json', 'help']);
  const repeatable = new Set(['attach']);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    // Object.hasOwn, not alias[token]: a bare lookup walks the prototype chain,
    // so `constructor` / `toString` / `__proto__` in flag position resolve to a
    // truthy inherited value, get treated as an option, and swallow the next
    // argument instead of failing as an unknown flag.
    const key = Object.hasOwn(alias, token) ? alias[token] : undefined;
    if (key && booleans.has(key)) {
      args[key] = true;
    } else if (key) {
      const value = argv[++i];
      if (value === undefined) {
        fail(`option ${token} needs a value`, EXIT.USAGE);
      }
      if (repeatable.has(key)) (args[key] ||= []).push(value);
      else args[key] = value;
    } else if (token.startsWith('-')) {
      fail(`Unknown option: ${token}`, EXIT.USAGE);
    } else {
      args._.push(token);
    }
  }
  return args;
}

// Parser for the question commands: supports repeatable --option and a trailing
// positional (a question id). Unknown flags fail like the ping parser.
function parseQArgs(argv) {
  const args = { _: [] };
  const alias = {
    '-p': 'prompt', '--prompt': 'prompt',
    '-o': 'option', '--option': 'option',
    '-c': 'context', '--context': 'context',
    '--scope': 'scope',
    '--target': 'target',
    '--ttl': 'ttl',
    '-d': 'data', '--data': 'data',
    '--correlation-id': 'correlation_id',
    '--reply-to': 'reply_to',
    '--text-input': 'text_input',
    '--text-max': 'text_max',
    '--timeout': 'timeout',
    '--state': 'state',
    '--token': 'token',
    '--room': 'room',
    '--api': 'api',
    '--wait': 'wait',
    '--json': 'json',
    '-h': 'help', '--help': 'help',
  };
  const booleans = new Set(['wait', 'json', 'help']);
  const multi = new Set(['option']);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    // hasOwn, not a bare lookup — see parseArgs: an inherited key would swallow args.
    const key = Object.hasOwn(alias, token) ? alias[token] : undefined;
    if (key && booleans.has(key)) {
      args[key] = true;
    } else if (key) {
      const value = argv[++i];
      if (value === undefined) {
        fail(`option ${token} needs a value`, EXIT.USAGE);
      }
      if (multi.has(key)) {
        (args[key] ||= []).push(value);
      } else {
        args[key] = value;
      }
    } else if (token.startsWith('-') && token !== '-') {
      fail(`Unknown option: ${token}`, EXIT.USAGE);
    } else {
      args._.push(token);
    }
  }
  return args;
}

// Parser for `handoff`: --message plus repeatable --option, boolean --question,
// and the handoff-specific flags. Unknown flags fail like the other parsers.
function parseHandoffArgs(argv) {
  const args = { _: [] };
  const alias = {
    '-m': 'message', '--message': 'message',
    '--question': 'question',
    '-o': 'option', '--option': 'option',
    '--target': 'target',
    '--expires-in': 'expires_in',
    '--urgency': 'urgency',
    '--idempotency-key': 'idempotency_key',
    '--correlation-id': 'correlation_id',
    '--reply-to': 'reply_to',
    '-d': 'data', '--data': 'data',
    '--timeout': 'timeout',
    '--github-output': 'github_output',
    '--token': 'token',
    '--api': 'api',
    '--wait': 'wait',
    '--json': 'json',
    '-h': 'help', '--help': 'help',
  };
  const booleans = new Set(['question', 'wait', 'json', 'help']);
  const multi = new Set(['option']);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    // hasOwn, not a bare lookup — see parseArgs: an inherited key would swallow args.
    const key = Object.hasOwn(alias, token) ? alias[token] : undefined;
    if (key && booleans.has(key)) {
      args[key] = true;
    } else if (key) {
      const value = argv[++i];
      if (value === undefined) {
        fail(`option ${token} needs a value`, EXIT.USAGE);
      }
      if (multi.has(key)) {
        (args[key] ||= []).push(value);
      } else {
        args[key] = value;
      }
    } else if (token.startsWith('-') && token !== '-') {
      fail(`Unknown option: ${token}`, EXIT.USAGE);
    } else {
      args._.push(token);
    }
  }
  return args;
}

// True when a URL is safe to attach a bearer token or webhook secret to: https,
// or http on loopback so local dev against http://localhost still works.
// Split out of requireSafeUrl for the `hook` command, which must apply the same
// rule but fails open (it defers instead of exiting — see hook()).
function isSafeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const isLoopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  return u.protocol === 'https:' || (u.protocol === 'http:' && isLoopback);
}

// Refuse to send a bearer token or webhook secret over cleartext http. A
// loopback host is allowed so local dev against http://localhost still works.
function requireSafeUrl(kind, raw) {
  try {
    new URL(raw);
  } catch {
    fail(`${kind} is not a valid URL`, EXIT.USAGE);
  }
  if (!isSafeUrl(raw)) {
    fail(`${kind} must use https (refusing to send credentials over cleartext)`, EXIT.USAGE);
  }
  return raw;
}

function parseDataObject(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    fail('--data must be valid JSON', EXIT.USAGE);
  }
  if (typeof data !== 'object' || Array.isArray(data) || data === null) {
    fail('--data must be a JSON object', EXIT.USAGE);
  }
  return data;
}

// `soft: true` returns { error } instead of exiting on a transport failure. The
// bounded pairing and activation loops use it so a single DNS blip or dropped
// connection does not discard an otherwise recoverable human workflow. Every
// other caller keeps the hard exit.
async function httpJson(method, url, { body, headers = {}, soft = false, signal } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (soft) return { res: null, text: '', json: null, error: err };
    fail(`network error: ${err.message}`);
  }

  let text;
  try {
    text = await res.text();
  } catch (err) {
    // A connection dropped mid-body throws here, not at fetch().
    if (soft) return { res: null, text: '', json: null, error: err };
    fail(`network error: ${err.message}`);
  }
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON response */ }

  return { res, text, json };
}

// The extensions the attachment endpoint accepts. Mirrored here so a typo is a
// local usage error instead of a 422 after the bytes have already been sent.
// Keep in lockstep with laravel config/attachments.php `allowed_extensions`.
const ATTACHMENT_EXTENSIONS = ['md', 'pdf', 'html', 'txt', 'jpg', 'jpeg', 'png'];
const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const ATTACHMENT_MAX_COUNT = 10;
const ATTACHMENT_MIME = {
  md: 'text/markdown',
  pdf: 'application/pdf',
  html: 'text/html',
  txt: 'text/plain',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

/**
 * Upload each --attach path and return the ids in flag order. Bytes go up as
 * multipart; only the resulting ids ride the ping body. An id we never manage
 * to attach expires server-side after 24h, so a mid-run failure leaks nothing
 * permanent.
 */
async function uploadAttachments(paths, apiBase, token) {
  if (paths.length > ATTACHMENT_MAX_COUNT) {
    fail(`--attach accepts at most ${ATTACHMENT_MAX_COUNT} files`, EXIT.USAGE);
  }

  const { readFile, stat } = await import('node:fs/promises');
  const { basename, extname } = await import('node:path');
  const ids = [];

  for (const path of paths) {
    const name = basename(path);
    const ext = extname(name).slice(1).toLowerCase();
    if (!ATTACHMENT_EXTENSIONS.includes(ext)) {
      fail(`--attach ${name}: only ${ATTACHMENT_EXTENSIONS.join(', ')} files are supported`, EXIT.USAGE);
    }

    let info;
    try {
      info = await stat(path);
    } catch {
      fail(`--attach ${path}: file not found`, EXIT.USAGE);
    }
    if (!info.isFile()) fail(`--attach ${path}: not a file`, EXIT.USAGE);
    if (info.size < 1) fail(`--attach ${name}: file is empty`, EXIT.USAGE);
    if (info.size > ATTACHMENT_MAX_BYTES) {
      fail(`--attach ${name}: file exceeds the 20 MiB limit`, EXIT.USAGE);
    }

    const body = new FormData();
    body.append('file', new Blob([await readFile(path)], { type: ATTACHMENT_MIME[ext] }), name);

    let res;
    try {
      // Not httpJson: that helper JSON-encodes the body and would strip the
      // multipart boundary the runtime generates for us.
      res = await fetch(`${apiBase}/api/agent/attachments`, {
        method: 'POST',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        body,
      });
    } catch (err) {
      fail(`network error uploading ${name}: ${err.message}`);
    }

    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON response */ }

    if (res.status === 402) {
      fail(`--attach ${name}: ping attachments are a Pro feature`, EXIT.USAGE);
    }
    if (!res.ok || !json?.attachment?.id) {
      const detail = json?.message || json?.error || `HTTP ${res.status}`;
      fail(`upload failed for ${name}: ${detail}`);
    }

    ids.push(json.attachment.id);
  }

  return ids;
}

async function ping(args) {
  if (args.help) { process.stdout.write(`${HELP}\n`); return EXIT.OK; }

  const message = args.message;
  if (!message) fail('a --message is required', EXIT.USAGE);

  if (args.action !== undefined && !/^[1-4]$/.test(String(args.action))) {
    fail('--action must be an integer 1–4', EXIT.USAGE);
  }

  let ackTimeout;
  if (args.ack_timeout !== undefined) {
    if (!args.require_ack) {
      fail('--ack-timeout requires --require-ack', EXIT.USAGE);
    }
    if (!/^\d+$/.test(String(args.ack_timeout))) {
      fail('--ack-timeout must be an integer number of seconds', EXIT.USAGE);
    }
    ackTimeout = Number(args.ack_timeout);
  }

  let data;
  if (args.data !== undefined) {
    data = parseDataObject(args.data);
  }

  // Link ping: --url/--button-label fold into the structured data object
  // (server contract: data.url = absolute http(s) <= 2048, data.button_label <= 26).
  if (args.button_label !== undefined && args.url === undefined) {
    fail('--button-label requires --url', EXIT.USAGE);
  }
  if (args.url !== undefined) {
    let linkUrl;
    try {
      linkUrl = new URL(args.url);
    } catch {
      fail('--url is not a valid URL', EXIT.USAGE);
    }
    if (linkUrl.protocol !== 'https:' && linkUrl.protocol !== 'http:') {
      fail('--url must be an absolute http(s) URL', EXIT.USAGE);
    }
    if (args.url.length > 2048) {
      fail('--url must be at most 2048 characters', EXIT.USAGE);
    }
    if (args.button_label !== undefined && args.button_label.length > 26) {
      fail('--button-label must be at most 26 characters', EXIT.USAGE);
    }
    data = { ...(data || {}), url: args.url };
    if (args.button_label !== undefined) data.button_label = args.button_label;
  }

  const webhook = args.webhook || process.env.PINGROOM_WEBHOOK_URL;
  const token = resolveToken(args);
  const apiBase = resolveApiBase(args);
  const room = resolveRoom(args);

  let result;

  // Attachments exist only on the agent-token path: an incoming webhook has no
  // uploader identity to bind private files to, so the API takes no ids there.
  const attachPaths = args.attach ?? [];
  if (attachPaths.length && (webhook || !token)) {
    fail('--attach requires an agent token (--token / PINGROOM_TOKEN), not a webhook ping', EXIT.USAGE);
  }

  if (webhook) {
    if (ackTimeout !== undefined && (ackTimeout < 1 || ackTimeout > 86_400)) {
      fail('--ack-timeout must be between 1 and 86400 seconds for a webhook ping', EXIT.USAGE);
    }
    requireSafeUrl('--webhook', webhook);
    const body = { message };
    if (args.title) body.title = args.title;
    if (args.action !== undefined) body.action = Number(args.action);
    if (data) body.data = data;
    if (args.require_ack) body.requires_ack = true;
    if (ackTimeout !== undefined) body.ack_timeout_seconds = ackTimeout;
    result = await httpJson('POST', webhook, { body });
  } else if (token) {
    requireStoredCredentialOrigin(args, apiBase);
    if (!room) fail('--room is required when using --token (or set one with "pingroom config set default_room <code>")', EXIT.USAGE);
    if (ackTimeout !== undefined && (ackTimeout < 60 || ackTimeout > 86_400)) {
      fail('--ack-timeout must be between 60 and 86400 seconds for an agent room ping', EXIT.USAGE);
    }
    requireSafeUrl('--api', apiBase);
    const url = `${apiBase}/api/agent/rooms/${encodeURIComponent(room)}/notifications`;
    const body = { message };
    if (args.title) body.title = args.title;
    if (args.action !== undefined) body.action_number = Number(args.action);
    if (data) body.data = data;
    if (args.require_ack) body.requires_ack = true;
    if (ackTimeout !== undefined) body.ack_timeout_seconds = ackTimeout;
    if (attachPaths.length) {
      body.attachment_ids = await uploadAttachments(attachPaths, apiBase, token);
    }
    result = await httpJson('POST', url, { body, headers: { Authorization: `Bearer ${token}` } });
  } else {
    fail('provide a webhook (--webhook / PINGROOM_WEBHOOK_URL) or an agent token (--token / PINGROOM_TOKEN, or run "pingroom" to connect)', EXIT.USAGE);
  }

  const { res, text, json } = result;

  if (args.json) {
    process.stdout.write(`${text || '{}'}\n`);
  }

  const ok = res.ok && !(json && json.success === false);

  if (!ok) {
    const detail = (json && (json.message || json.error)) || `HTTP ${res.status}`;
    fail(`delivery failed: ${detail}`);
  }

  if (!args.json) process.stdout.write('ping sent ✅\n');
  return EXIT.OK;
}

// --- live status -----------------------------------------------------------

// The templates the server accepts on `live start`. Mirrored here so a typo is
// a local usage error instead of a 422 from the API. Keep in lockstep with the
// --template line in HELP and with LIVE_ACTIVITY_TEMPLATES.md.
const LIVE_TEMPLATES = ['status', 'steps', 'progress', 'metrics', 'countdown', 'question', 'matchup'];

// Parser for `live`: a leading subcommand (start|update|end|get) plus the
// live-status flags. Unknown flags fail like the other parsers.
function parseLiveArgs(argv) {
  const args = { _: [] };
  const alias = {
    '-c': 'correlation_id', '--correlation-id': 'correlation_id',
    '-t': 'title', '--title': 'title',
    '-m': 'message', '--message': 'message',
    '--template': 'template',
    '--category': 'category',
    '--progress': 'progress',
    '--step': 'step',
    '--steps': 'steps',
    '--metric': 'metric',
    '--deadline-at': 'deadline_at',
    '--eta-at': 'eta_at',
    '--prompt': 'prompt',
    '--option': 'option',
    '--left': 'left',
    '--right': 'right',
    '--center': 'center',
    '--accent-override': 'accent_override',
    '--failed': 'failed',
    '-a': 'action', '--action': 'action',
    '-d': 'data', '--data': 'data',
    '--require-ack': 'require_ack',
    '--ack-timeout': 'ack_timeout',
    '-w': 'webhook', '--webhook': 'webhook',
    '--token': 'token',
    '--room': 'room',
    '--api': 'api',
    '--json': 'json',
    '-h': 'help', '--help': 'help',
  };
  const booleans = new Set(['require_ack', 'json', 'help', 'failed']);
  const repeatable = new Set(['metric', 'option']);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    // hasOwn, not a bare lookup — see parseArgs: an inherited key would swallow args.
    const key = Object.hasOwn(alias, token) ? alias[token] : undefined;
    if (key && booleans.has(key)) {
      args[key] = true;
    } else if (key) {
      const value = argv[++i];
      if (value === undefined) fail(`option ${token} needs a value`, EXIT.USAGE);
      if (repeatable.has(key)) (args[key] ||= []).push(value);
      else args[key] = value;
    } else if (token.startsWith('-')) {
      fail(`Unknown option: ${token}`, EXIT.USAGE);
    } else {
      args._.push(token);
    }
  }
  return args;
}

// "label:value" -> {label, value}. Only the first colon splits.
function buildMetrics(list) {
  if (!list || list.length === 0) return undefined;
  return list.map((spec) => {
    const idx = spec.indexOf(':');
    if (idx <= 0) fail(`--metric must be "label:value" (got "${spec}")`, EXIT.USAGE);
    return { label: spec.slice(0, idx), value: spec.slice(idx + 1) };
  });
}

// "value:label" -> {value, label}; a bare token is both. Matches the `ask`
// command's option syntax minus `style`, which live_status options don't carry.
function buildLiveOptions(list) {
  if (!list || list.length === 0) return undefined;
  return list.map((spec) => {
    const idx = spec.indexOf(':');
    if (idx < 0) return { value: spec, label: spec };
    if (idx === 0) fail(`--option needs a value before the colon (got "${spec}")`, EXIT.USAGE);
    return { value: spec.slice(0, idx), label: spec.slice(idx + 1) };
  });
}

// "label:value" -> {label, value}, for --left / --right on the matchup template.
function buildSide(spec, flag) {
  if (spec === undefined) return undefined;
  const idx = spec.indexOf(':');
  if (idx <= 0) fail(`${flag} must be "label:value" (got "${spec}")`, EXIT.USAGE);
  return { label: spec.slice(0, idx), value: spec.slice(idx + 1) };
}

// The server accepts #rrggbb with or without the leading #; normalize to one
// form so a shell that ate the # (unquoted) still produces a valid payload.
function normalizeAccent(raw) {
  if (raw === undefined) return undefined;
  const hex = raw.trim().replace(/^#/, '');
  if (!/^[0-9A-Fa-f]{6}$/.test(hex)) {
    fail(`--accent-override must be a 6-digit hex color (got "${raw}")`, EXIT.USAGE);
  }
  return `#${hex.toLowerCase()}`;
}

function numberOption(raw, flag, { min, max, integer = false } = {}) {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) fail(`${flag} must be a number`, EXIT.USAGE);
  if (integer && !Number.isInteger(value)) fail(`${flag} must be an integer`, EXIT.USAGE);
  if (min !== undefined && value < min) fail(`${flag} must be at least ${min}`, EXIT.USAGE);
  if (max !== undefined && value > max) fail(`${flag} must be at most ${max}`, EXIT.USAGE);
  return value;
}

/**
 * Drive a live progress card on the room members' lock screen.
 *
 * One correlation id = one stream: `start` opens it (one alert), `update` moves
 * it silently, `end` closes it with one completion alert. Works with either an
 * agent token (--token, needs pingroom:live:write) or a room's incoming webhook
 * (--webhook), which speak the same `live_status` contract.
 */
async function live(args) {
  const sub = args._[0];
  const known = ['start', 'update', 'end', 'get'];
  if (!sub || !known.includes(sub)) {
    fail(`live needs a subcommand: ${known.join(' | ')}`, EXIT.USAGE);
  }

  const correlationId = args.correlation_id;
  if (!correlationId) fail('--correlation-id is required', EXIT.USAGE);

  const webhook = args.webhook || process.env.PINGROOM_WEBHOOK_URL;
  const token = resolveToken(args);
  const apiBase = resolveApiBase(args);
  const room = resolveRoom(args);

  if (sub === 'get') {
    if (!token) fail('live get requires an agent token (--token or PINGROOM_TOKEN)', EXIT.USAGE);
    requireStoredCredentialOrigin(args, apiBase);
    if (!room) fail('--room is required', EXIT.USAGE);
    requireSafeUrl('--api', apiBase);
    const url = `${apiBase}/api/agent/rooms/${encodeURIComponent(room)}/live/${encodeURIComponent(correlationId)}`;
    const { res, text, json } = await httpJson('GET', url, { headers: { Authorization: `Bearer ${token}` } });
    if (args.json) process.stdout.write(`${text || '{}'}\n`);
    if (!res.ok) {
      fail(`read failed: ${(json && (json.message || json.code)) || `HTTP ${res.status}`}`);
    }
    if (!args.json) process.stdout.write(`${(json && json.state) || 'unknown'}\n`);
    return EXIT.OK;
  }

  const liveStatus = {
    state: sub === 'end' ? (args.failed ? 'failed' : 'done') : 'running',
  };

  if (args.message !== undefined) liveStatus.message = args.message;
  if (args.prompt !== undefined) liveStatus.prompt = args.prompt;

  const progress = numberOption(args.progress, '--progress', { min: 0, max: 1 });
  if (progress !== undefined) liveStatus.progress = progress;

  const step = numberOption(args.step, '--step', { min: 0, max: 8, integer: true });
  if (step !== undefined) liveStatus.current_step = step;

  const deadlineAt = numberOption(args.deadline_at, '--deadline-at', { min: 0, integer: true });
  if (deadlineAt !== undefined) liveStatus.deadline_at = deadlineAt;

  const etaAt = numberOption(args.eta_at, '--eta-at', { min: 0, integer: true });
  if (etaAt !== undefined) liveStatus.eta_at = etaAt;

  const metrics = buildMetrics(args.metric);
  if (metrics) liveStatus.metrics = metrics;

  const options = buildLiveOptions(args.option);
  if (options) {
    if (options.length > 4) fail('--option accepts at most 4 choices', EXIT.USAGE);
    liveStatus.options = options;
  }

  const left = buildSide(args.left, '--left');
  if (left) liveStatus.left = left;
  const right = buildSide(args.right, '--right');
  if (right) liveStatus.right = right;
  if (args.center !== undefined) liveStatus.center = args.center;

  const accent = normalizeAccent(args.accent_override);
  if (accent) liveStatus.accent_override = accent;

  // Template, category and step labels are fixed when the stream is created;
  // sending them on an update is a no-op server-side, so only `start` takes them.
  if (sub === 'start') {
    // Validated locally for the same reason --category is: a typo'd name is a
    // usage error, and letting it reach the server turns it into a 422 round
    // trip that reads like an outage.
    if (args.template) {
      if (!LIVE_TEMPLATES.includes(args.template)) {
        fail(`--template must be one of: ${LIVE_TEMPLATES.join(', ')}`, EXIT.USAGE);
      }
      liveStatus.template = args.template;
    }
    // `alert` has no template equivalent and is the only way to start a stream
    // time-sensitive (breaking through Focus) without also demanding an ack.
    if (args.category) {
      if (!['status', 'steps', 'alert'].includes(args.category)) {
        fail('--category must be status, steps or alert', EXIT.USAGE);
      }
      liveStatus.category = args.category;
    }
    if (args.steps) {
      const labels = args.steps.split(',').map((s) => s.trim()).filter(Boolean);
      if (labels.length < 2 || labels.length > 8) {
        fail('--steps needs between 2 and 8 comma-separated labels', EXIT.USAGE);
      }
      liveStatus.steps = labels;
    }
  } else if (args.template || args.steps || args.category) {
    fail('--template, --category and --steps are fixed at stream creation; pass them to "live start"', EXIT.USAGE);
  }

  const body = { correlation_id: correlationId, live_status: liveStatus };
  if (args.title) body.title = args.title;
  if (args.action !== undefined) body.action = Number(args.action);
  // Same object-shape guard ping/ask/handoff use. A bare JSON.parse also accepts
  // an array, which the server then rejects — a wasted round trip for what is a
  // local usage error.
  // `!== undefined`, not truthiness: `-d ''` is a malformed value, and a
  // truthiness test drops it on the floor and ships the ping without the data
  // the caller believed they attached. ping/ask/handoff all reject it loudly.
  if (args.data !== undefined) body.data = parseDataObject(args.data);
  if (args.require_ack) body.requires_ack = true;
  const ackTimeout = numberOption(args.ack_timeout, '--ack-timeout', { min: 1, max: 86_400, integer: true });
  if (ackTimeout !== undefined) body.ack_timeout_seconds = ackTimeout;

  let result;
  if (webhook) {
    requireSafeUrl('--webhook', webhook);
    result = await httpJson('POST', webhook, { body });
  } else if (token) {
    requireStoredCredentialOrigin(args, apiBase);
    if (!room) fail('--room is required when using --token (or set one with "pingroom config set default_room <code>")', EXIT.USAGE);
    requireSafeUrl('--api', apiBase);
    const url = `${apiBase}/api/agent/rooms/${encodeURIComponent(room)}/live`;
    result = await httpJson('POST', url, { body, headers: { Authorization: `Bearer ${token}` } });
  } else {
    fail('provide a webhook (--webhook / PINGROOM_WEBHOOK_URL) or an agent token (--token / PINGROOM_TOKEN, or run "pingroom" to connect)', EXIT.USAGE);
  }

  const { res, text, json } = result;
  if (args.json) process.stdout.write(`${text || '{}'}\n`);

  if (!res.ok || (json && json.success === false)) {
    const detail = (json && (json.message || json.error || json.code)) || `HTTP ${res.status}`;
    fail(`live ${sub} failed: ${detail}`);
  }

  if (!args.json) {
    const state = (json && (json.state || (json.live_status && json.live_status.state))) || sub;
    process.stdout.write(`live ${sub} → ${state} ✅\n`);
  }
  return EXIT.OK;
}

// --- questions -------------------------------------------------------------

// Resolve the credential + endpoint a token-only command needs. When nothing is
// available this is a usage error pointing at PINGROOM_TOKEN — never a prompt,
// so a CI job fails in a second instead of hanging on an invisible question.
function agentContext(args, { needRoom = false } = {}) {
  const token = resolveToken(args);
  if (!token) {
    fail(
      'an agent token is required (--token or PINGROOM_TOKEN). Run "pingroom" in an interactive terminal to connect this machine; in CI set PINGROOM_TOKEN.',
      EXIT.USAGE,
    );
  }
  const apiBase = resolveApiBase(args);
  requireStoredCredentialOrigin(args, apiBase);
  requireSafeUrl('--api', apiBase);
  const room = resolveRoom(args);
  if (needRoom && !room) {
    fail('--room is required (or set one with "pingroom config set default_room <code>")', EXIT.USAGE);
  }
  return { token, apiBase, room };
}

// value:label -> {value, label}. Labels may contain colons (only the first
// splits). A bare token is both value and label. Omit all for Approve/Deny.
function buildOptions(list) {
  if (!list || list.length === 0) return undefined;
  return list.map((spec) => {
    const idx = spec.indexOf(':');
    const value = idx === -1 ? spec : spec.slice(0, idx);
    let label = idx === -1 ? spec : spec.slice(idx + 1);
    if (!value) fail(`--option must be "value", "value:label" or "value:label:style" (got "${spec}")`, EXIT.USAGE);
    // A trailing :primary|:danger|:default segment styles the button; any other
    // trailing segment stays part of the label (labels may contain colons).
    let style;
    const lastColon = label.lastIndexOf(':');
    if (lastColon !== -1) {
      const candidate = label.slice(lastColon + 1);
      if (candidate === 'primary' || candidate === 'danger' || candidate === 'default') {
        style = candidate;
        label = label.slice(0, lastColon);
      }
    }
    return style ? { value, label, style } : { value, label };
  });
}

function exitForState(state) {
  switch (state) {
    case 'answered': return EXIT.OK;
    case 'expired': return EXIT.EXPIRED;
    case 'cancelled': return EXIT.CANCELLED;
    default: return EXIT.ERROR;
  }
}

// Print the outcome. On `answered`, the chosen value (or typed text) goes to
// stdout so `$(pingroom ask --wait ...)` captures it; other outcomes report to
// stderr and leave stdout empty.
function printResolution(q) {
  if (q.state === 'answered') {
    const out = q.answer && (q.answer.text || q.answer.value) || '';
    process.stdout.write(`${out}\n`);
  } else {
    process.stderr.write(`pingroom: question ${q.state}\n`);
  }
}

// Long-poll the wait endpoint until the question leaves `pending`, then print
// and return the state's exit code. The server expires it at its ttl, so this
// always terminates.
async function waitForResolution(id, args, { token, apiBase }) {
  let hold = args.timeout !== undefined ? Number(args.timeout) : 25;
  if (!Number.isFinite(hold) || hold < 0) fail('--timeout must be a non-negative integer', EXIT.USAGE);
  hold = Math.min(hold, 30);

  for (;;) {
    const url = `${apiBase}/api/agent/questions/${encodeURIComponent(id)}/wait?timeout=${hold}`;
    const { res, text, json } = await httpJson('GET', url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const detail = (json && (json.message || json.code)) || `HTTP ${res.status}`;
      fail(`wait failed: ${detail}`);
    }
    if (json && json.state && json.state !== 'pending') {
      if (args.json) process.stdout.write(`${text}\n`);
      else printResolution(json);
      return exitForState(json.state);
    }
    // Still pending at the hold timeout — poll again.
  }
}

async function ask(args) {
  if (args.help) { process.stdout.write(`${HELP}\n`); return EXIT.OK; }

  const prompt = args.prompt;
  if (!prompt) fail('a --prompt is required', EXIT.USAGE);

  const { token, apiBase, room } = agentContext(args, { needRoom: true });

  const body = { prompt };
  const options = buildOptions(args.option);
  if (options) body.options = options;
  if (args.context) body.context = args.context;
  if (args.scope !== undefined) {
    if (args.scope !== 'direct' && args.scope !== 'room') fail("--scope must be 'direct' or 'room'", EXIT.USAGE);
    body.responder_scope = args.scope;
  }
  if (args.target !== undefined) body.target_user_id = args.target;
  if (args.ttl !== undefined) {
    if (!/^\d+$/.test(String(args.ttl))) fail('--ttl must be an integer number of seconds', EXIT.USAGE);
    body.ttl = Number(args.ttl);
  }
  if (args.correlation_id !== undefined) body.correlation_id = args.correlation_id;
  if (args.reply_to !== undefined) body.reply_to = args.reply_to;
  if (args.text_input !== undefined || args.text_max !== undefined) {
    const textInput = {};
    if (args.text_input) textInput.placeholder = String(args.text_input).slice(0, 60);
    if (args.text_max !== undefined) {
      const n = Number(args.text_max);
      if (!/^\d+$/.test(String(args.text_max)) || n < 1 || n > 60) {
        fail('--text-max must be an integer between 1 and 60', EXIT.USAGE);
      }
      textInput.max_length = n;
    }
    body.text_input = textInput;
  }
  if (args.data !== undefined) body.data = parseDataObject(args.data);

  const url = `${apiBase}/api/agent/rooms/${encodeURIComponent(room)}/questions`;
  const { res, text, json } = await httpJson('POST', url, { body, headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const detail = (json && (json.message || json.code)) || `HTTP ${res.status}`;
    fail(`ask failed: ${detail}`);
  }

  if (!args.wait) {
    if (args.json) process.stdout.write(`${text}\n`);
    else process.stdout.write(`${json.id}\n`);
    return EXIT.OK;
  }

  return waitForResolution(json.id, args, { token, apiBase });
}

async function watch(args) {
  if (args.help) { process.stdout.write(`${HELP}\n`); return EXIT.OK; }
  const id = args._[0];
  if (!id) fail('a question id is required (pingroom watch <id>)', EXIT.USAGE);
  const { token, apiBase } = agentContext(args);
  return waitForResolution(id, args, { token, apiBase });
}

async function cancel(args) {
  if (args.help) { process.stdout.write(`${HELP}\n`); return EXIT.OK; }
  const id = args._[0];
  if (!id) fail('a question id is required (pingroom cancel <id>)', EXIT.USAGE);
  const { token, apiBase } = agentContext(args);
  const url = `${apiBase}/api/agent/questions/${encodeURIComponent(id)}/cancel`;
  const { res, text, json } = await httpJson('POST', url, { body: {}, headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const detail = (json && (json.message || json.code)) || `HTTP ${res.status}`;
    fail(`cancel failed: ${detail}`);
  }
  if (args.json) process.stdout.write(`${text}\n`);
  else process.stdout.write(`cancelled (${json && json.state})\n`);
  return EXIT.OK;
}

async function list(args) {
  if (args.help) { process.stdout.write(`${HELP}\n`); return EXIT.OK; }
  const { token, apiBase } = agentContext(args);
  const qs = args.state ? `?state=${encodeURIComponent(args.state)}` : '';
  const url = `${apiBase}/api/agent/questions${qs}`;
  const { res, text, json } = await httpJson('GET', url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const detail = (json && (json.message || json.code)) || `HTTP ${res.status}`;
    fail(`list failed: ${detail}`);
  }
  if (args.json) { process.stdout.write(`${text}\n`); return EXIT.OK; }

  const questions = (json && json.questions) || [];
  if (questions.length === 0) { process.stdout.write('no questions\n'); return EXIT.OK; }
  for (const q of questions) {
    const answer = q.answer && q.answer.value ? ` → ${q.answer.value}` : '';
    process.stdout.write(`${q.id}  ${String(q.state).padEnd(9)}  ${q.prompt}${answer}\n`);
  }
  return EXIT.OK;
}

async function listHandoffs(args) {
  if (args.help) { process.stdout.write(`${HELP}\n`); return EXIT.OK; }
  const { token, apiBase } = agentContext(args);
  const state = args.state || 'open';
  if (state !== 'open' && state !== 'all') {
    fail("--state must be 'open' or 'all' for handoffs", EXIT.USAGE);
  }

  const url = `${apiBase}/api/agent/handoffs?state=${encodeURIComponent(state)}`;
  const { res, text, json } = await httpJson('GET', url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const detail = (json && (json.message || json.code)) || `HTTP ${res.status}`;
    fail(`handoffs list failed: ${detail}`);
  }
  if (args.json) { process.stdout.write(`${text}\n`); return EXIT.OK; }

  const handoffs = (json && json.handoffs) || [];
  if (handoffs.length === 0) { process.stdout.write('no handoffs\n'); return EXIT.OK; }
  for (const h of handoffs) {
    const answer = h.answer && (h.answer.value ?? h.answer.text);
    const outcome = answer !== undefined && answer !== null ? ` → ${answer}` : '';
    process.stdout.write(
      `${h.id}  ${String(h.kind || '').padEnd(8)}  ${String(h.state || '').padEnd(9)}  ${h.prompt || ''}${outcome}\n`,
    );
  }
  return EXIT.OK;
}

// --- handoff ---------------------------------------------------------------

// Terminal wire states across both kinds. ack: open→acked|expired.
// question: pending→answered|expired|cancelled. `open`/`pending` are the only
// non-terminal states, so a wait loop against these always terminates.
const HANDOFF_PENDING = new Set(['open', 'pending']);

// Map a terminal handoff state to an exit code. A `question` answered with ANY
// value is a success (0) — a negative human decision ('hold'/'deny') is NOT an
// infra failure. `acked` is likewise 0. `expired` is a distinct 3 so CI can
// branch; `cancelled` shares 4 with recipient_not_ready.
function exitForHandoffState(state) {
  switch (state) {
    case 'acked': return EXIT.OK;
    case 'answered': return EXIT.OK;
    case 'expired': return EXIT.EXPIRED;
    case 'cancelled': return EXIT.CANCELLED;
    default: return EXIT.ERROR;
  }
}

// Print a machine-readable summary of a handoff: id, state, delivery-state, and
// the answer value / acked-by when present, one `key=value` per line to stdout.
function printHandoff(h) {
  const lines = [`id=${h.id ?? ''}`, `state=${h.state ?? ''}`];
  if (h.delivery_state != null) lines.push(`delivery-state=${h.delivery_state}`);
  if (h.correlation_id) lines.push(`correlation-id=${h.correlation_id}`);
  if (h.state === 'answered') {
    const value = h.answer && (h.answer.value ?? h.answer.text) || '';
    lines.push(`answer=${value}`);
  }
  if (h.state === 'acked') {
    // The Handoff API returns a privacy-aware actor object. Only expose its id
    // in the machine-readable CLI/GitHub Action output; a redacted actor yields
    // an empty value instead of the unhelpful "[object Object]" string.
    const ackerId = h.acked_by && typeof h.acked_by === 'object'
      ? h.acked_by.id
      : h.acked_by;
    lines.push(`acked-by=${ackerId ?? ''}`);
    if (h.acked_at) lines.push(`acked-at=${h.acked_at}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * Append the composite Action's declared outputs without interpreting stdout.
 * Values use GitHub's multiline protocol with a fresh random delimiter. Output
 * names are a fixed allowlist; untrusted answer text can never create a key.
 */
function writeGitHubHandoffOutputs(path, h) {
  if (typeof path !== 'string' || path.length === 0) {
    fail('--github-output must be a non-empty path', EXIT.USAGE);
  }

  const ackerId = h.acked_by && typeof h.acked_by === 'object'
    ? h.acked_by.id
    : h.acked_by;
  const fields = [
    ['handoff-id', h.id ?? ''],
    ['state', h.state ?? ''],
  ];
  if (h.delivery_state != null) fields.push(['delivery-state', h.delivery_state]);
  if (h.state === 'answered') {
    fields.push(['answer', h.answer && (h.answer.value ?? h.answer.text) || '']);
  }
  if (h.state === 'acked') fields.push(['acknowledged-by', ackerId ?? '']);

  const blocks = fields.map(([name, rawValue]) => {
    const value = String(rawValue ?? '');
    let delimiter;
    do {
      delimiter = `pingroom_${randomBytes(24).toString('hex')}`;
    } while (value.includes(delimiter));
    // Keep the collision check next to serialization: a delimiter must never
    // occur in an untrusted value, even though a 192-bit collision is remote.
    if (value.includes(delimiter)) {
      fail('could not create a safe GitHub output delimiter');
    }
    return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
  });

  try {
    appendFileSync(path, blocks.join(''), { encoding: 'utf8' });
  } catch {
    fail('could not write GitHub outputs');
  }
}

// Long-poll GET /handoffs/{id}/wait until the handoff leaves open/pending, then
// print it and return the state's exit code. Reuses the shared bounded hold.
async function waitForHandoff(id, args, { token, apiBase }, initialDeliveryState) {
  let hold = args.timeout !== undefined ? Number(args.timeout) : 20;
  if (!Number.isFinite(hold) || hold < 0) fail('--timeout must be a non-negative integer', EXIT.USAGE);
  hold = Math.min(hold, 25);

  for (;;) {
    const url = `${apiBase}/api/agent/handoffs/${encodeURIComponent(id)}/wait?timeout=${hold}`;
    const { res, text, json } = await httpJson('GET', url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const detail = (json && (json.message || json.code)) || `HTTP ${res.status}`;
      fail(`wait failed: ${detail}`);
    }
    if (json && json.state && !HANDOFF_PENDING.has(json.state)) {
      // Read/wait responses intentionally carry delivery_state=null. Preserve
      // the create response's durable delivery result so --wait callers and
      // the GitHub Action do not lose it at the terminal read boundary.
      const resolved = json.delivery_state == null && initialDeliveryState != null
        ? { ...json, delivery_state: initialDeliveryState }
        : json;
      if (args.github_output !== undefined) writeGitHubHandoffOutputs(args.github_output, resolved);
      if (args.json) process.stdout.write(`${text}\n`);
      else printHandoff(resolved);
      return exitForHandoffState(resolved.state);
    }
    // Still open/pending at the hold timeout — poll again.
  }
}

async function handoff(args) {
  if (args.help) { process.stdout.write(`${HELP}\n`); return EXIT.OK; }

  const message = args.message;
  if (!message) fail('a --message is required', EXIT.USAGE);

  const { token, apiBase } = agentContext(args);

  const options = buildOptions(args.option);
  // Any --option (or an explicit --question) makes this a question handoff.
  const isQuestion = Boolean(args.question) || Boolean(options);
  if (isQuestion && (!options || options.length < 2)) {
    fail('a question handoff needs at least 2 --option values', EXIT.USAGE);
  }
  if (isQuestion && options && options.length > 4) {
    fail('a question handoff accepts at most 4 --option values', EXIT.USAGE);
  }
  if (!isQuestion && options) {
    fail('--option requires --question', EXIT.USAGE);
  }

  const body = { kind: isQuestion ? 'question' : 'ack', prompt: message };

  const target = args.target || 'me';
  body.audience = { type: 'direct', user_id: target };

  if (options) body.options = options;

  if (args.expires_in !== undefined) {
    if (!/^\d+$/.test(String(args.expires_in))) fail('--expires-in must be an integer number of seconds', EXIT.USAGE);
    const secs = Number(args.expires_in);
    if (secs < 120 || secs > 86_400) fail('--expires-in must be between 120 and 86400 seconds', EXIT.USAGE);
    body.expires_in = secs;
  }
  if (args.urgency !== undefined) {
    if (args.urgency !== 'active' && args.urgency !== 'passive') fail("--urgency must be 'active' or 'passive'", EXIT.USAGE);
    body.urgency = args.urgency;
  }
  if (args.correlation_id !== undefined) body.correlation_id = args.correlation_id;
  if (args.reply_to !== undefined) body.reply_to = args.reply_to;
  if (args.data !== undefined) body.data = parseDataObject(args.data);

  const headers = { Authorization: `Bearer ${token}` };
  // A stable Idempotency-Key lets network retries collapse to one resource; the
  // server returns the same handoff for a matching key+hash (409 on conflict).
  if (args.idempotency_key !== undefined) {
    if (!args.idempotency_key) fail('--idempotency-key must be non-empty', EXIT.USAGE);
    headers['Idempotency-Key'] = args.idempotency_key;
  }

  const url = `${apiBase}/api/agent/handoffs`;
  const { res, text, json } = await httpJson('POST', url, { body, headers });
  if (!res.ok) {
    const code = json && json.code;
    const detail = (json && (json.message || code)) || `HTTP ${res.status}`;
    // A recipient who isn't reachable yet is a distinct, retriable outcome (4),
    // not a generic error — CI may want to wait and retry rather than fail hard.
    if (res.status === 409 && code === 'recipient_not_ready') {
      if (args.json) process.stdout.write(`${text}\n`);
      else process.stderr.write(`pingroom: recipient not ready\n`);
      return EXIT.CANCELLED;
    }
    fail(`handoff failed: ${detail}`);
  }

  if (!args.wait) {
    if (args.github_output !== undefined) writeGitHubHandoffOutputs(args.github_output, json);
    if (args.json) process.stdout.write(`${text}\n`);
    else printHandoff(json);
    return EXIT.OK;
  }

  return waitForHandoff(json.id, args, { token, apiBase }, json.delivery_state);
}

// --- hook (Claude Code integration) ----------------------------------------
//
// A single command wired into several Claude Code hook events. It reads the
// hook's JSON payload on stdin and switches on `hook_event_name`:
//   Stop / SubagentStop / SessionEnd  -> ping the room ("Claude finished")
//   Notification                      -> ping the room (idle / needs-input)
//   PreToolUse                        -> ask a PingRoom question and gate the
//                                        tool call on the phone's Approve/Deny.
//
// Safety: the hook FAILS OPEN. It never blocks the agent and never
// auto-approves. Any missing config / network error / non-answer defers to the
// normal local prompt (PreToolUse -> permissionDecision "ask") and exits 0. It
// must not call fail() (a non-zero exit — 2 especially — would break the run).

function parseHookArgs(argv) {
  const args = { _: [] };
  const alias = {
    '--room': 'room',
    '--ttl': 'ttl',
    '--quiet': 'quiet',
    '--print-config': 'print_config',
    '--token': 'token',
    '--api': 'api',
    '--json': 'json',
    '-h': 'help', '--help': 'help',
  };
  const booleans = new Set(['quiet', 'print_config', 'json', 'help']);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    // hasOwn, not a bare lookup — see parseArgs: an inherited key would swallow args.
    const key = Object.hasOwn(alias, token) ? alias[token] : undefined;
    if (key && booleans.has(key)) {
      args[key] = true;
    } else if (key) {
      const value = argv[++i];
      if (value === undefined) fail(`option ${token} needs a value`, EXIT.USAGE);
      args[key] = value;
    } else if (token.startsWith('-') && token !== '-') {
      fail(`Unknown option: ${token}`, EXIT.USAGE);
    } else {
      args._.push(token);
    }
  }
  return args;
}

// Read all of stdin as a string. Resolves '' when nothing is piped (TTY), so a
// stray `pingroom hook` in a terminal is a silent no-op rather than a hang.
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function truncate(value, max) {
  const str = String(value ?? '');
  return str.length <= max ? str : `${str.slice(0, max - 1)}…`;
}

// A minimal HTTP helper for the hook path that THROWS instead of calling fail(),
// so every failure funnels into a fail-open decision. Mirrors httpJson's header
// handling but leaves control flow to the caller.
async function hookFetch(method, url, { body, token } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON response */ }
  if (!res.ok) {
    throw new Error((json && (json.message || json.code)) || `HTTP ${res.status}`);
  }
  return json;
}

// Pull the readable text out of a Claude transcript message's content, which is
// either a plain string or an array of typed blocks.
function extractAssistantText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ');
  }
  return '';
}

// Tail a Claude Code transcript (JSONL) and return the last assistant message as
// a single truncated line. Best-effort: any read/parse failure yields ''.
function summarizeTranscript(path) {
  if (!path || typeof path !== 'string') return '';
  let content;
  try { content = readFileSync(path, 'utf8'); } catch { return ''; }
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const msg = entry && entry.message;
    if (!msg || msg.role !== 'assistant') continue;
    const text = extractAssistantText(msg.content).replace(/\s+/g, ' ').trim();
    if (text) return truncate(text, 500);
  }
  return '';
}

// A short, single-line description of the tool call for the question prompt.
// Never emits more than a truncated line, and strips whitespace/newlines so an
// untrusted command can't reshape the message.
function summarizeToolInput(input) {
  if (!input || typeof input !== 'object') return '';
  let raw = '';
  if (typeof input.command === 'string') raw = input.command;          // Bash
  else if (typeof input.file_path === 'string') raw = input.file_path; // Read/Write/Edit
  else if (typeof input.path === 'string') raw = input.path;
  else if (typeof input.url === 'string') raw = input.url;             // WebFetch
  else if (typeof input.pattern === 'string') raw = input.pattern;     // Grep/Glob
  else { try { raw = JSON.stringify(input); } catch { raw = ''; } }
  return truncate(String(raw).replace(/\s+/g, ' ').trim(), 160);
}

function emitPreToolUseDecision(decision, reason) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  })}\n`);
}

// Long-poll the wait endpoint until the question leaves `pending`. The server
// expires it at its ttl, so this always terminates; a mid-poll throw propagates
// to the caller's fail-open handler.
async function hookWaitForAnswer(id, { token, apiBase }) {
  for (;;) {
    const url = `${apiBase}/api/agent/questions/${encodeURIComponent(id)}/wait?timeout=25`;
    const json = await hookFetch('GET', url, { token });
    if (json && json.state && json.state !== 'pending') return json;
  }
}

async function hookPreToolUse(event, { token, room, apiBase, args }) {
  if (!token || !room) {
    emitPreToolUseDecision('ask', 'PingRoom not configured (pair by QR, or configure both a token and room)');
    return EXIT.OK;
  }

  const toolName = event.tool_name || 'a tool';
  const summary = summarizeToolInput(event.tool_input);
  const prompt = truncate(`Run ${toolName}${summary ? `: ${summary}` : ''}?`, 500);

  let ttl = 900;
  if (args.ttl !== undefined && /^\d+$/.test(String(args.ttl))) ttl = Number(args.ttl);

  let questionId;
  let cancelled = false;
  const cancelQuestion = async () => {
    if (!questionId || cancelled) return;
    cancelled = true;
    try {
      await hookFetch('POST', `${apiBase}/api/agent/questions/${encodeURIComponent(questionId)}/cancel`, { body: {}, token });
    } catch { /* best-effort — a leftover question expires on its own ttl */ }
  };
  // If the agent aborts the tool call, withdraw the question so it doesn't linger
  // on the phone. Exit 0 so the abort itself isn't reported as a hook failure.
  const onSignal = () => { cancelQuestion().finally(() => process.exit(EXIT.OK)); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const data = { tool_name: String(toolName) };
    if (event.cwd) data.cwd = String(event.cwd);
    const created = await hookFetch('POST', `${apiBase}/api/agent/rooms/${encodeURIComponent(room)}/questions`, {
      token,
      body: {
        prompt,
        context: 'Claude Code',
        options: [
          { value: 'allow', label: 'Approve', style: 'primary' },
          { value: 'deny', label: 'Deny', style: 'danger' },
        ],
        ttl,
        data,
        ...(event.session_id ? { correlation_id: String(event.session_id) } : {}),
      },
    });
    questionId = created && created.id;
    if (!questionId) {
      emitPreToolUseDecision('ask', 'PingRoom did not return a question — deferring to local prompt');
      return EXIT.OK;
    }

    const resolved = await hookWaitForAnswer(questionId, { token, apiBase });
    if (resolved.state === 'answered') {
      const value = resolved.answer && (resolved.answer.value || resolved.answer.text);
      if (value === 'allow') { emitPreToolUseDecision('allow', 'Approved via PingRoom'); return EXIT.OK; }
      if (value === 'deny') { emitPreToolUseDecision('deny', 'Denied via PingRoom'); return EXIT.OK; }
      emitPreToolUseDecision('ask', `PingRoom answer "${value}" — deferring to local prompt`);
      return EXIT.OK;
    }
    emitPreToolUseDecision('ask', `PingRoom question ${resolved.state} — deferring to local prompt`);
    return EXIT.OK;
  } catch (err) {
    emitPreToolUseDecision('ask', `PingRoom unavailable (${err.message}) — deferring to local prompt`);
    return EXIT.OK;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

async function hookNotify(event, name, { token, room, apiBase, args }) {
  if (!token || !room) {
    if (!args.quiet) process.stderr.write('pingroom: hook skipped (pair by QR, or configure both a token and room)\n');
    return EXIT.OK;
  }

  let title;
  let message;
  if (name === 'Stop' || name === 'SubagentStop') {
    title = 'Claude finished';
    message = summarizeTranscript(event.transcript_path) || 'Session finished — waiting for you.';
  } else if (name === 'Notification') {
    message = truncate(event.message || 'Claude is waiting for your input.', 500);
    // A PreToolUse hook already turns permission prompts into a question; skip
    // the duplicate "needs your permission" Notification so you aren't paged twice.
    if (/permission/i.test(message)) return EXIT.OK;
    title = 'Claude needs you';
  } else if (name === 'SessionEnd') {
    if (event.reason === 'clear') return EXIT.OK; // /clear isn't worth a ping
    title = 'Session ended';
    message = `Claude Code session ended (${event.reason || 'unknown'}).`;
  } else {
    return EXIT.OK; // unknown event — stay silent rather than send noise
  }

  const data = { event: name };
  if (event.session_id) data.session_id = String(event.session_id);
  if (event.cwd) data.cwd = String(event.cwd);

  try {
    await hookFetch('POST', `${apiBase}/api/agent/rooms/${encodeURIComponent(room)}/notifications`, {
      token,
      body: {
        message,
        title,
        data,
        ...(event.session_id ? { correlation_id: String(event.session_id) } : {}),
      },
    });
    if (!args.quiet) process.stderr.write('pingroom: pinged ✅\n');
  } catch (err) {
    // A broken ping must never break the agent — report to stderr and exit 0.
    if (!args.quiet) process.stderr.write(`pingroom: hook ping failed (${err.message})\n`);
  }
  return EXIT.OK;
}

function printHookConfig() {
  const command = `npx --yes @pingroom/cli@${VERSION} hook`;
  const config = {
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command }] }],
      Notification: [{ hooks: [{ type: 'command', command }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command, timeout: 960 }] }],
    },
  };
  process.stdout.write(
`# PingRoom × Claude Code — merge this into ~/.claude/settings.json
#
# 1. Connect once and choose a delivery room when you scan the QR:
#      npm install --global @pingroom/cli && pingroom
#    Or, without a global install:
#      npx --yes @pingroom/cli@${VERSION}
#    The hook reads that stored credential and paired room automatically; you do
#    not need to export PINGROOM_TOKEN or PINGROOM_ROOM for a local setup.
#
# 2. Merge the "hooks" block below into ~/.claude/settings.json.
#      Stop / Notification  -> ping your phone.
#      PreToolUse (Bash)     -> ask a question you Approve/Deny from the lock
#                               screen before the command runs. Add or change the
#                               matcher to gate other tools.
#
# If PingRoom is unreachable the hook defers to the normal local prompt — it
# never auto-approves and never blocks the agent.
# PINGROOM_TOKEN / PINGROOM_ROOM remain supported for CI and headless shells.

${JSON.stringify(config, null, 2)}
`);
}

async function hook(args) {
  if (args.help) { process.stdout.write(`${HELP}\n`); return EXIT.OK; }
  if (args.print_config) { printHookConfig(); return EXIT.OK; }

  let event = {};
  const raw = await readStdin();
  if (raw) { try { event = JSON.parse(raw); } catch { event = {}; } }
  const name = event.hook_event_name || '';

  // The hook fails open, so it reads the same layered config as everything else
  // but never complains about a missing piece — it just defers.
  const token = resolveToken(args);
  const room = resolveRoom(args);
  const apiBase = resolveApiBase(args);

  const originError = storedCredentialOriginError(args, apiBase);
  if (originError) {
    if (name === 'PreToolUse') {
      emitPreToolUseDecision('ask', `${originError}; deferring to local prompt`);
    } else if (!args.quiet) {
      process.stderr.write(`pingroom: hook skipped (${originError})\n`);
    }
    return EXIT.OK;
  }

  // Every other command that attaches a bearer gates its base through
  // requireSafeUrl first; the hook was the one that didn't, so a config or env
  // pointing at plain http shipped `Authorization: Bearer …` in the clear with
  // nothing on screen. Same rule here — but enforced by deferring, not by
  // exiting: the hook's whole contract is that it never blocks the agent, so a
  // hard failure would trade a credential leak for a broken session.
  if (!isSafeUrl(apiBase)) {
    const why = `${apiBase} is not https — refusing to send credentials over cleartext`;
    if (name === 'PreToolUse') {
      emitPreToolUseDecision('ask', `PingRoom API base ${why}; deferring to local prompt`);
    } else if (!args.quiet) {
      process.stderr.write(`pingroom: hook skipped (API base ${why})\n`);
    }
    return EXIT.OK;
  }

  if (name === 'PreToolUse') {
    return hookPreToolUse(event, { token, room, apiBase, args });
  }
  return hookNotify(event, name, { token, room, apiBase, args });
}

// --- MCP client setup ------------------------------------------------------

function mcp(rest) {
  const claudeCommand = `claude mcp add --transport http pingroom ${MCP_ENDPOINT}`;

  if (rest.length === 0 || (rest.length === 1 && (rest[0] === '-h' || rest[0] === '--help'))) {
    const config = {
      mcpServers: {
        pingroom: { url: MCP_ENDPOINT },
      },
    };
    process.stdout.write(
`PingRoom MCP endpoint:
  ${MCP_ENDPOINT}

Claude Code:
  ${claudeCommand}

Cursor JSON (~/.cursor/mcp.json):
${JSON.stringify(config, null, 2)}

Claude Desktop:
  Customize > Connectors > Add custom connector
  Name: PingRoom
  URL:  ${MCP_ENDPOINT}

After adding the server, use your client's MCP controls to authenticate in the
browser. No API key is needed.
This command only prints setup instructions and does not modify client config.
`);
    return EXIT.OK;
  }

  if (rest.length === 2 && rest[0] === 'add' && rest[1] === 'claude-code') {
    process.stdout.write(
`No client configuration was changed. Copy and run:
  ${claudeCommand}
`);
    return EXIT.OK;
  }

  fail('usage: pingroom mcp [add claude-code]', EXIT.USAGE);
}

// --- connecting (pairing + email fallback) ---------------------------------
//
// Wire contract: AGENT_PAIRING_SPEC.md. The shape is deliberately one gesture —
// scanning the QR is where the human picks BOTH the account and the delivery
// room, so an agent can never end up connected with nobody's say-so about where
// it pings. There is no `login` subcommand: `pingroom` resolves the state.

// The scopes this CLI can actually use, one per command surface. Requested at
// registration so the approval screen shows exactly what it is granting; the
// server intersects, so asking for less is always safe and asking for more than
// the human approves is impossible.
const CLI_SCOPES = [
  'pingroom:rooms:read',        // resolve/display the connected room
  'pingroom:broadcast:send',    // ping
  'pingroom:questions:ask',     // ask / watch / cancel / list, and the hook
  'pingroom:handoffs:create',   // handoff / handoffs
  'pingroom:live:write',        // live start/update/end/get
];

const AGENT_LABEL = 'pingroom-cli';
// A connect command should prove the phone round-trip, but it must not hold a
// terminal for the onboarding Question's full 24-hour server TTL. The Question
// remains answerable after this local deadline and the credential is already
// durable before the wait begins.
const ACTIVATION_MAX_WAIT_MS = 2 * 60 * 1000;
// The wait route is limited to 30 requests/minute. Keep immediate pending or
// answered-without-completion observations safely below that ceiling while a
// mixed-version or commit-propagation race is still being reconciled.
const ACTIVATION_MIN_POLL_INTERVAL_MS = 2100;

function activationMaxWaitMs() {
  // Keep production fixed at two minutes. The guarded override lets the real
  // subprocess tests exercise deadline behavior without holding the suite for
  // two minutes; it is ignored outside NODE_ENV=test.
  if (process.env.NODE_ENV === 'test') {
    const testValue = Number(process.env.PINGROOM_INTERNAL_ACTIVATION_TIMEOUT_MS);
    if (Number.isInteger(testValue) && testValue > 0 && testValue <= ACTIVATION_MAX_WAIT_MS) {
      return testValue;
    }
  }
  return ACTIVATION_MAX_WAIT_MS;
}

// Widest QR we render (compact half-block form of a ~110-char pair URL is 39
// columns). Anything narrower would wrap and become unscannable, so we print
// the URL alone instead of a broken QR.
const QR_MIN_COLUMNS = 41;

/**
 * Draw the pair URL as a scannable QR. Returns false when it could not — a too
 * narrow terminal, or the optional dependency being absent (someone vendored
 * just bin/) — and the caller falls back to the printed URL, which always works.
 */
async function renderQr(url) {
  // A real terminal reports its width on the stream; COLUMNS covers the rest.
  // Unknown width is treated as wide enough — the URL is printed either way.
  const columns = Number(process.stdout.columns || process.env.COLUMNS || 0);
  if (columns > 0 && columns < QR_MIN_COLUMNS) return false;

  let qr;
  try {
    const mod = await import('qrcode-terminal');
    qr = mod.default || mod;
  } catch { return false; }
  if (!qr || typeof qr.generate !== 'function') return false;

  try {
    let art = '';
    // Call it as a method: qrcode-terminal reads its error-correction level off
    // `this`, so a detached `generate` reference silently builds a version-1
    // code and throws on anything longer than a few characters.
    // `small` is the half-block form: two module rows per text row, so the code
    // stays square-ish and fits an 80-column terminal.
    qr.generate(url, { small: true }, (rendered) => { art = rendered; });
    if (!art) return false;
    process.stdout.write(`\n${art}\n`);
    return true;
  } catch { return false; }
}

/**
 * A line-at-a-time reader over stdin.
 *
 * Deliberately not node:readline: its Interface keeps consuming while we are
 * awaiting an HTTP round trip between two questions and drops the lines nobody
 * is listening for, which silently loses piped answers. This queues every line
 * instead, so the answers can arrive in one blob or one keystroke at a time.
 *
 * ask() resolves `null` — never a string — once the input is closed, so it can
 * never be confused with a real empty line. That distinction is load-bearing:
 * callers treat an empty line as "take the default", and a caller that reads EOF
 * as an empty line will take that default again on the next question, and the
 * next, forever, because nothing will ever arrive to change its mind. Callers
 * that genuinely want the empty-line behaviour opt in with `?? ''`.
 */
function createPrompter() {
  const queued = [];
  const waiting = [];
  let buffer = '';
  let closed = false;

  const deliver = (line) => {
    const waiter = waiting.shift();
    if (waiter) waiter(line);
    else queued.push(line);
  };
  const onData = (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      deliver(buffer.slice(0, idx).replace(/\r$/, ''));
      buffer = buffer.slice(idx + 1);
    }
  };
  const onEnd = () => {
    if (closed) return;
    closed = true;
    if (buffer) { deliver(buffer); buffer = ''; }
    while (waiting.length) waiting.shift()(null);
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', onData);
  process.stdin.once('end', onEnd);
  process.stdin.resume();

  return {
    ask(question) {
      process.stdout.write(question);
      if (queued.length > 0) return Promise.resolve(queued.shift());
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => { waiting.push(resolve); });
    },
    close() {
      process.stdin.off('data', onData);
      process.stdin.off('end', onEnd);
      process.stdin.pause();
    },
  };
}

/** POST /api/agent/auth — anonymous registration, yields the pre-claim credential. */
async function registerAnonymous(apiBase) {
  const { res, json } = await httpJson('POST', `${apiBase}/api/agent/auth`, {
    body: { type: 'anonymous', agent_label: AGENT_LABEL, scopes: CLI_SCOPES },
  });
  if (!res.ok || !json || typeof json.credential !== 'string') {
    const detail = (json && (json.message || json.error || json.code)) || `HTTP ${res.status}`;
    fail(`could not start a connection: ${detail}`);
  }
  return json.credential;
}

/** Persist the active credential plus the bits the status line prints. */
function saveCredential({ token, handle, room, account, scopes, apiBase }) {
  writeJsonFile(credentialsPath(), {
    version: 1,
    token,
    handle: handle || null,
    room: room || null,
    account: account || null,
    scopes: scopes || [],
    api_url: apiBase,
    created_at: new Date().toISOString(),
  });
}

/** "✓ Connected as @agt_ab12 → #Project X" — the room half is omitted if unknown. */
function connectedLine(cred) {
  const who = cred.handle ? `@${cred.handle}` : 'this machine';
  const room = cred.room && (cred.room.name || cred.room.invite_code);
  return `✓ Connected as ${who}${room ? ` → #${room}` : ''}`;
}

function activationFailureDetail(result) {
  if (result.error) return result.error.message;
  const status = result.res ? `HTTP ${result.res.status}` : 'request failed';
  return (result.json && (result.json.message || result.json.error || result.json.code)) || status;
}

function isJsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isNullableString(value) {
  return value === null || typeof value === 'string';
}

function validateActivationEnsure(json) {
  const room = json?.room;
  const question = json?.question;
  const validState = question?.state === 'pending'
    || question?.state === 'answered'
    || question?.state === 'expired'
    || question?.state === 'cancelled';
  if (
    !isJsonObject(json)
    || json.onboarded !== true
    || typeof json.replayed !== 'boolean'
    || !isJsonObject(room)
    || !isNonEmptyString(room.id)
    || typeof room.name !== 'string'
    || !isNonEmptyString(room.invite_code)
    || typeof room.is_agent_inbox !== 'boolean'
    || !isJsonObject(question)
    || !isNonEmptyString(question.id)
    || question.kind !== 'question'
    || !isNonEmptyString(question.prompt)
    || !Array.isArray(question.options)
    || question.options.some((option) => (
      !isJsonObject(option)
      || !isNonEmptyString(option.value)
      || !isNonEmptyString(option.label)
    ))
    || !validState
    || !isNullableString(question.expires_at)
    || !isNullableString(question.created_at)
  ) {
    return { error: 'PingRoom returned an incomplete Agent Inbox ensure response' };
  }
  return { question };
}

function validateActivationWait(json, questionId) {
  const state = json?.state;
  const validState = state === 'pending' || state === 'answered' || state === 'expired' || state === 'cancelled';
  if (
    !isJsonObject(json)
    || !isNonEmptyString(json.id)
    || json.id !== questionId
    || json.kind !== 'question'
    || !validState
    || (json.activation_completed !== undefined && typeof json.activation_completed !== 'boolean')
    || (state !== 'answered' && json.activation_completed === true)
  ) {
    return { error: 'PingRoom returned a mismatched Agent Inbox wait response' };
  }

  if (state === 'answered') {
    const answer = json.answer;
    const responder = answer?.responder;
    if (
      !isJsonObject(answer)
      || !isNullableString(answer.value)
      || !isNullableString(answer.label)
      || !isNullableString(answer.text)
      || (!isNonEmptyString(answer.value) && !isNonEmptyString(answer.text))
      || !isNullableString(answer.answered_at)
      || (responder !== null && !isJsonObject(responder))
      || (isJsonObject(responder)
        && (!isNullableString(responder.id) || !isNullableString(responder.display_name)))
    ) {
      return { error: 'PingRoom returned an answered activation without a valid answer' };
    }
  } else if (json.answer !== undefined && json.answer !== null) {
    return { error: 'PingRoom returned an answer for an unresolved activation' };
  }

  return { value: json };
}

function retryAfterMs(response) {
  const raw = response?.headers?.get('retry-after')?.trim();
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

function activationRetryDelay(result, transientRun, deadline) {
  const fromHeader = result.res?.status === 429 ? retryAfterMs(result.res) : null;
  const fallback = Math.min(1000 * 2 ** Math.max(0, transientRun - 1), 10_000);
  return Math.max(0, Math.min(fromHeader ?? fallback, deadline - Date.now()));
}

function activationIncomplete(detail, instruction = 'Run "pingroom activate" to retry with this saved connection.') {
  const safeDetail = detail ? `: ${stripControlChars(detail)}` : '';
  process.stdout.write(`  Agent Inbox activation is not complete${safeDetail}\n`);
  process.stdout.write('  Your connection is saved and usable.\n');
  process.stdout.write(`  ${instruction}\n`);
}

/**
 * Prove the freshly paired credential can complete a human round-trip. This is
 * intentionally best-effort: saveCredential() has already committed the active
 * bearer atomically, so no activation outage can roll back or corrupt it.
 */
async function activateInboxAfterPairing(cred) {
  const headers = { Authorization: `Bearer ${cred.token}` };
  const overallDeadline = Date.now() + activationMaxWaitMs();
  process.stdout.write('  Sending a test question to PingRoom…\n');

  let ensured;
  let ensureTransientRun = 0;
  while (Date.now() < overallDeadline) {
    ensured = await httpJson('POST', `${cred.apiBase}/api/agent/inbox/ensure`, {
      body: {},
      headers,
      soft: true,
      signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, overallDeadline - Date.now()))),
    });
    const transient = ensured.error || ensured.res?.status === 429 || ensured.res?.status >= 500;
    if (!transient) break;
    ensureTransientRun += 1;
    await sleep(activationRetryDelay(ensured, ensureTransientRun, overallDeadline));
  }

  if (!ensured.res?.ok) {
    const detail = Date.now() >= overallDeadline
      ? 'the two-minute activation deadline elapsed while PingRoom was unavailable'
      : activationFailureDetail(ensured);
    activationIncomplete(detail);
    return false;
  }

  const ensureEnvelope = validateActivationEnsure(ensured.json);
  if (ensureEnvelope.error) {
    activationIncomplete(ensureEnvelope.error);
    return false;
  }
  const { question } = ensureEnvelope;

  process.stdout.write('  Answer “PingRoom connected. Can you answer this?” on your phone.\n');
  // The server stamp, not the terminal state by itself, is the activation
  // authority. A terminal answer without the stamp cannot become a valid
  // receipt-before-answer sequence later, so fail clearly instead of polling a
  // state the server intentionally will not rewrite.
  const deadline = overallDeadline;
  let transientRun = 0;

  while (Date.now() < deadline) {
    const pollStartedAt = Date.now();
    const remainingSeconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const hold = Math.min(20, remainingSeconds);
    const waited = await httpJson(
      'GET',
      `${cred.apiBase}/api/agent/handoffs/${encodeURIComponent(question.id)}/wait?timeout=${hold}`,
      {
        headers,
        soft: true,
        signal: AbortSignal.timeout(Math.max(1, Math.min(
          hold * 1000 + 10_000,
          deadline - Date.now(),
        ))),
      },
    );

    const transient = waited.error || waited.res?.status === 429 || waited.res?.status >= 500;
    if (transient) {
      transientRun += 1;
      const retryDelay = activationRetryDelay(waited, transientRun, deadline);
      const cadenceDelay = ACTIVATION_MIN_POLL_INTERVAL_MS - (Date.now() - pollStartedAt);
      await sleep(Math.max(0, Math.min(Math.max(retryDelay, cadenceDelay), deadline - Date.now())));
      continue;
    }
    transientRun = 0;

    if (!waited.res?.ok) {
      activationIncomplete(activationFailureDetail(waited));
      return false;
    }

    const waitEnvelope = validateActivationWait(waited.json, question.id);
    if (waitEnvelope.error) {
      activationIncomplete(waitEnvelope.error);
      return false;
    }
    const resolved = waitEnvelope.value;
    const state = resolved.state;
    if (state === 'answered') {
      if (resolved.activation_completed !== true) {
        activationIncomplete(
          'the test question was answered without verified phone receipt before the answer',
          'Update the PingRoom app if needed, then run "pingroom activate" to send a fresh test with this saved connection.',
        );
        return false;
      }
      const answer = resolved.answer.text || resolved.answer.label || resolved.answer.value;
      process.stdout.write(`✓ Test question answered (${stripControlChars(answer)}). Agent Inbox is ready.\n`);
      return true;
    }
    if (state === 'expired' || state === 'cancelled') {
      activationIncomplete(
        `the test question ${state}`,
        'Run "pingroom activate" to send a fresh test with this saved connection.',
      );
      return false;
    }
    // `pending` at the bounded hold timeout — continue at a throttle-safe
    // cadence until the local/server deadline.
    const cadenceDelay = ACTIVATION_MIN_POLL_INTERVAL_MS - (Date.now() - pollStartedAt);
    await sleep(Math.max(0, Math.min(cadenceDelay, deadline - Date.now())));
  }

  activationIncomplete(
    'still waiting for the test answer at the activation deadline',
  );
  return false;
}

/** Retry activation only for the durable credential created by QR pairing. */
async function activateStoredInbox(args) {
  if (args.help) { process.stdout.write(`${HELP}\n`); return EXIT.OK; }
  if (args._.length > 0) fail('usage: pingroom activate', EXIT.USAGE);
  if (args.token !== undefined) {
    fail('pingroom activate uses the saved QR-paired credential; remove --token', EXIT.USAGE);
  }
  const unsupported = Object.keys(args).filter((key) => !['_', 'help', 'api', 'token'].includes(key));
  if (unsupported.length > 0) {
    fail('usage: pingroom activate [--api <url>]', EXIT.USAGE);
  }

  const credential = readStoredCredential();
  if (!credential) {
    fail('no saved QR-paired credential; run "pingroom" in an interactive terminal first', EXIT.USAGE);
  }
  if (!credential.room || !isNonEmptyString(credential.room.invite_code)) {
    fail('the saved credential has no QR-selected delivery room; reconnect with QR pairing before running "pingroom activate"', EXIT.USAGE);
  }
  if (!Array.isArray(credential.scopes) || !credential.scopes.includes('pingroom:handoffs:create')) {
    fail('the saved credential lacks pingroom:handoffs:create; reconnect with QR pairing before running "pingroom activate"', EXIT.USAGE);
  }

  const apiBase = resolveApiBase(args);
  requireSafeUrl('--api', apiBase);
  if (!isNonEmptyString(credential.api_url)) {
    fail('the saved QR-paired credential has no trusted API origin; pair again before running "pingroom activate"', EXIT.USAGE);
  }
  let credentialOrigin;
  let targetOrigin;
  try {
    credentialOrigin = new URL(credential.api_url).origin;
    targetOrigin = new URL(apiBase).origin;
  } catch {
    fail('the saved QR-paired credential has an invalid API origin; pair again', EXIT.USAGE);
  }
  if (credentialOrigin !== targetOrigin) {
    fail(`stored credential is bound to ${credentialOrigin}; refusing to send it to ${targetOrigin}`, EXIT.USAGE);
  }
  process.stdout.write(`${connectedLine(credential)}\n`);

  const completed = await activateInboxAfterPairing({
    ...credential,
    apiBase,
  });
  return completed ? EXIT.OK : EXIT.ERROR;
}

/**
 * The QR path. Mints a pre-claim credential, asks the server for a pairing
 * token, renders it, then polls until the human approves. Returns a credential
 * object, or null when the pairing lapsed and the user declined a fresh one.
 */
async function connectByPairing(apiBase, ask) {
  for (;;) {
    const preClaim = await registerAnonymous(apiBase);
    const headers = { Authorization: `Bearer ${preClaim}` };

    const start = await httpJson('POST', `${apiBase}/api/agent/auth/pair/start`, {
      body: { scopes: CLI_SCOPES },
      headers,
    });
    if (!start.res.ok || !start.json || typeof start.json.pair_url !== 'string') {
      const detail = (start.json && (start.json.message || start.json.error || start.json.code))
        || `HTTP ${start.res.status}`;
      fail(`could not start pairing: ${detail}`);
    }

    // The URL is server-controlled and goes straight to the terminal, so strip
    // C0/C1 controls: an --api / config api_url pointing at a hostile host could
    // otherwise emit ANSI escapes that repaint or hide the line the user is
    // about to trust with their account.
    const pairUrl = stripControlChars(start.json.pair_url);
    // 900s is the server's pre-claim lifetime; never poll past it, and clamp the
    // server's suggested interval so a bad value can't busy-loop or stall.
    // The 1000ms floor is not cosmetic: AGENT_PAIRING_SPEC.md throttles
    // pair/status at `60,1`, so a faster floor spends the pairing window
    // collecting 429s instead of the approval.
    const lifetimeMs = Math.max(1, Number(start.json.expires_in) || 900) * 1000;
    const intervalMs = Math.min(Math.max(Number(start.json.poll_interval_ms) || 1500, 1000), 10_000);
    const deadline = Date.now() + lifetimeMs;

    const drew = await renderQr(pairUrl);
    process.stdout.write(`${drew ? '  Or open' : '  Open'}: ${pairUrl}\n`);
    process.stdout.write('  Waiting for approval… ');

    // A transient failure must not end a wait the human is mid-way through.
    // Network errors, 5xx and 429 are the load balancer / rate limiter talking,
    // not the pairing being over; hard-failing on the first one throws away the
    // whole 15 minutes over a single blip. 401/403/404 still exit immediately —
    // those say the pre-claim is gone, and retrying can only spin.
    // The `Date.now() < deadline` bound is what keeps a *persistent* outage from
    // retrying forever: it ends at the same moment a clean poll would have.
    let transientRun = 0;
    let lastTransient = null;
    let warnedTransient = false;

    while (Date.now() < deadline) {
      const { res, json, error } = await httpJson(
        'GET', `${apiBase}/api/agent/auth/pair/status`, { headers, soft: true },
      );

      if (error || res.status >= 500 || res.status === 429) {
        transientRun += 1;
        lastTransient = error
          ? error.message
          : `HTTP ${res.status}`;
        // Say something rather than sitting mute: a user watching a QR with no
        // output cannot tell a slow approval from a broken endpoint.
        if (transientRun === 3 && !warnedTransient) {
          warnedTransient = true;
          process.stdout.write(`\n  (still trying — ${lastTransient}) `);
        }
        // Ride out a short blip at the normal cadence, then back off
        // geometrically so a real outage is not also a thundering herd. Never
        // sleep past the deadline this loop is bounded by.
        const backoff = Math.min(intervalMs * 2 ** Math.max(0, transientRun - 3), 30_000);
        await sleep(Math.max(0, Math.min(backoff, deadline - Date.now())));
        continue;
      }

      transientRun = 0;

      if (!res.ok) {
        process.stdout.write('\n');
        const detail = (json && (json.message || json.error || json.code)) || `HTTP ${res.status}`;
        fail(`pairing failed: ${detail}`);
      }
      const status = json && json.status;
      if (status === 'active') {
        // A server that says "active" with no credential has not paired us.
        // Without this, `token: undefined` is written to credentials.json and
        // every later command reads a credential file that exists but cannot
        // authenticate — a far more confusing failure than stopping here.
        if (typeof json.credential !== 'string' || json.credential === '') {
          process.stdout.write('\n');
          fail('pairing succeeded but the server returned no credential');
        }
        const cred = {
          token: json.credential,
          handle: json.handle,
          room: json.room,
          account: json.account,
          scopes: json.scopes,
          apiBase,
        };
        saveCredential(cred);
        process.stdout.write(`${connectedLine(cred)}\n`);
        await activateInboxAfterPairing(cred);
        return cred;
      }
      if (status === 'expired') break;
      // `pending` (or anything unrecognized) — keep waiting.
      await sleep(intervalMs);
    }

    if (transientRun > 0) {
      process.stdout.write(`\n  Gave up waiting — the server kept failing (last: ${lastTransient}).\n`);
    } else {
      process.stdout.write(`\n  That code expired.\n`);
    }

    // `null` means the input is closed, and that is the whole point of this
    // guard. Reading EOF as "" would fall through the y/yes test below (empty
    // means "take the default: yes"), restart the for(;;), mint another
    // anonymous registration, and do it again — a Ctrl-D or a piped stdin turns
    // a single pairing attempt into thousands of registrations against the API.
    const again = await ask('  Show a fresh QR code? [Y/n]: ');
    if (again === null) { process.stdout.write('\n'); return null; }
    const answer = again.trim().toLowerCase();
    if (answer && answer !== 'y' && answer !== 'yes') return null;
  }
}

/**
 * The email fallback, over the unchanged claim/* endpoints: the server mails a
 * link, the web page shows a 6-digit code, the user reads it back here.
 */
async function connectByEmail(apiBase, ask) {
  const preClaim = await registerAnonymous(apiBase);
  const headers = { Authorization: `Bearer ${preClaim}` };

  // `?? ''` preserves the old EOF behaviour deliberately: ask() now returns null
  // at EOF, and without the coalesce this would throw a TypeError on `.trim()`
  // instead of reaching the "this is required" error the user should see.
  const email = (await ask('  Your PingRoom email: ') ?? '').trim();
  if (!email) fail('an email address is required', EXIT.USAGE);

  const start = await httpJson('POST', `${apiBase}/api/agent/auth/claim/start`, {
    body: { email },
    headers,
  });
  if (!start.res.ok) {
    const detail = (start.json && (start.json.message || start.json.error || start.json.code))
      || `HTTP ${start.res.status}`;
    fail(`could not send the email: ${detail}`);
  }

  process.stdout.write('  Sent. Open the link in that email — the page shows a 6-digit code.\n');

  // A mistyped code is the common case, so allow a few tries before giving up.
  // The server locks the registration out after its own attempt cap anyway.
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Same reason as the email prompt: EOF stays an empty answer, which the
    // server rejects, rather than a TypeError on null.
    const otp = (await ask('  Code: ') ?? '').trim();
    const done = await httpJson('POST', `${apiBase}/api/agent/auth/claim/complete`, {
      body: { email, otp },
      headers,
    });
    if (done.res.ok && done.json && typeof done.json.credential === 'string') {
      const cred = {
        token: done.json.credential,
        handle: done.json.handle,
        // claim/complete carries no room — the email flow does not choose one.
        room: done.json.room,
        account: done.json.account,
        scopes: done.json.scopes,
        apiBase,
      };
      saveCredential(cred);
      process.stdout.write(`${connectedLine(cred)}\n`);
      if (!cred.room) {
        process.stdout.write('  For room commands: pingroom config set default_room <invite code>\n');
        process.stdout.write('  For private Inbox/Handoff delivery, reconnect with QR pairing.\n');
      }
      return cred;
    }
    const detail = (done.json && (done.json.message || done.json.error || done.json.code))
      || `HTTP ${done.res.status}`;
    if (attempt === 3) fail(`could not connect: ${detail}`);
    process.stderr.write(`pingroom: ${detail}\n`);
  }
  return null;
}

/**
 * Resolve the unconnected state interactively. Refuses outright when there is no
 * TTY — a hung prompt in CI is worse than a clean failure, and the fix there is
 * PINGROOM_TOKEN, not a QR nobody can scan.
 */
async function connect(args) {
  if (!isInteractive()) {
    fail(
      'not connected, and this is not an interactive terminal. Set PINGROOM_TOKEN (CI, pipes), or run "pingroom" from a terminal to pair.',
      EXIT.USAGE,
    );
  }

  const apiBase = resolveApiBase(args);
  requireSafeUrl('--api', apiBase);

  const prompter = createPrompter();
  const ask = (question) => prompter.ask(question);
  try {
    process.stdout.write('  Not connected. How do you want to connect?\n');
    process.stdout.write('    1) Scan a QR code with the PingRoom app\n');
    process.stdout.write('    2) Email me a code\n');
    // EOF here means "no answer", which is what the default already covers, so
    // coalesce rather than crash on null — the pairing branch below is the one
    // that must distinguish EOF, and it does.
    const choice = (await ask('  Choose [1]: ') ?? '').trim();
    if (choice && choice !== '1' && choice !== '2') {
      process.stderr.write('pingroom: choose 1 or 2\n');
      return EXIT.USAGE;
    }

    const cred = choice === '2'
      ? await connectByEmail(apiBase, ask)
      : await connectByPairing(apiBase, ask);

    return cred ? EXIT.OK : EXIT.EXPIRED;
  } finally {
    prompter.close();
  }
}

// --- status / bare invocation ----------------------------------------------

/**
 * `pingroom` with no arguments. Connected -> one status line then the usual
 * help. Not connected -> pair (interactive) or, in a pipe/CI, say so on stderr
 * and still print the help rather than prompting into the void.
 */
async function bare(args) {
  const envToken = process.env.PINGROOM_TOKEN;
  const stored = readStoredCredential();

  if (envToken) {
    process.stdout.write('Using the agent token from PINGROOM_TOKEN.\n');
    if (stored) process.stdout.write(`(the stored credential in ${credentialsPath()} is ignored while it is set)\n`);
    const room = resolveRoom(args);
    if (room) process.stdout.write(`Default room: ${room}\n`);
    process.stdout.write(`\n${HELP}\n`);
    return EXIT.OK;
  }

  if (stored) {
    process.stdout.write(`${connectedLine(stored)}\n`);
    const room = resolveRoom(args);
    if (room) process.stdout.write(`Default room: ${room}\n`);
    process.stdout.write(`\n${HELP}\n`);
    return EXIT.OK;
  }

  if (!isInteractive()) {
    process.stderr.write('pingroom: not connected. Set PINGROOM_TOKEN, or run "pingroom" from an interactive terminal to pair.\n');
    process.stdout.write(`${HELP}\n`);
    return EXIT.OK;
  }

  return connect(args);
}

// --- config ----------------------------------------------------------------

// Only these keys are storable. An unknown key is a usage error rather than a
// silently-ignored setting the user then blames the tool for not honouring.
const CONFIG_KEYS = {
  default_room: {
    describe: 'Room invite code used when --room / PINGROOM_ROOM is absent',
    validate: (value) => {
      if (/\s/.test(value) || value.length > 64) return 'default_room must be an invite code (no spaces, <= 64 chars)';
      return null;
    },
  },
  api_url: {
    describe: `API base URL (default ${BUILTIN_API})`,
    validate: (value) => {
      let u;
      try { u = new URL(value); } catch { return 'api_url must be a valid URL'; }
      const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
        return 'api_url must use https (refusing to send credentials over cleartext)';
      }
      return null;
    },
  },
};

async function config(args) {
  if (args.help) { process.stdout.write(`${HELP}\n`); return EXIT.OK; }

  const sub = args._[0];
  const known = ['list', 'get', 'set'];
  if (!sub || !known.includes(sub)) {
    fail(`config needs a subcommand: ${known.join(' | ')}`, EXIT.USAGE);
  }

  const stored = readConfigFile();

  if (sub === 'list') {
    if (args.json) { process.stdout.write(`${JSON.stringify(stored)}\n`); return EXIT.OK; }
    const keys = Object.keys(CONFIG_KEYS).filter((k) => stored[k] !== undefined && stored[k] !== '');
    if (keys.length === 0) {
      process.stdout.write(`no settings stored in ${configPath()}\n`);
      return EXIT.OK;
    }
    for (const key of keys) process.stdout.write(`${key}=${stored[key]}\n`);
    return EXIT.OK;
  }

  const key = args._[1];
  if (!key) fail(`config ${sub} needs a key (${Object.keys(CONFIG_KEYS).join(', ')})`, EXIT.USAGE);
  if (!Object.hasOwn(CONFIG_KEYS, key)) {
    fail(`unknown config key: ${key} (known keys: ${Object.keys(CONFIG_KEYS).join(', ')})`, EXIT.USAGE);
  }

  if (sub === 'get') {
    const value = stored[key];
    if (value === undefined || value === '') return EXIT.OK; // unset: print nothing, exit 0
    process.stdout.write(`${value}\n`);
    return EXIT.OK;
  }

  // set
  const raw = args._[2];
  if (raw === undefined) fail(`config set needs a value (pass "" to clear ${key})`, EXIT.USAGE);
  const value = String(raw).trim();

  if (value === '') {
    delete stored[key];
    writeJsonFile(configPath(), stored);
    process.stdout.write(`${key} cleared\n`);
    return EXIT.OK;
  }

  const problem = CONFIG_KEYS[key].validate(value);
  if (problem) fail(problem, EXIT.USAGE);

  stored[key] = value;
  writeJsonFile(configPath(), stored);
  process.stdout.write(`${key}=${value}\n`);
  return EXIT.OK;
}

// --- logout ----------------------------------------------------------------

async function logout(args) {
  if (args.help) { process.stdout.write(`${HELP}\n`); return EXIT.OK; }

  const path = credentialsPath();
  const stored = readStoredCredential();
  try {
    unlinkSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') {
      process.stdout.write('not connected — there was no stored credential to clear\n');
      return EXIT.OK;
    }
    fail(`could not clear ${path}: ${err.message}`);
  }

  const who = stored && stored.handle ? ` (@${stored.handle})` : '';
  process.stdout.write(`logged out${who} — cleared ${path}\n`);
  if (process.env.PINGROOM_TOKEN) {
    process.stdout.write('note: PINGROOM_TOKEN is still set in this environment and will keep being used\n');
  }
  return EXIT.OK;
}

const COMMANDS = {
  ping: (rest) => ping(parseArgs(rest)),
  ask: (rest) => ask(parseQArgs(rest)),
  watch: (rest) => waitFrom(watch, rest),
  await: (rest) => waitFrom(watch, rest),
  cancel: (rest) => cancel(parseQArgs(rest)),
  list: (rest) => list(parseQArgs(rest)),
  handoff: (rest) => handoff(parseHandoffArgs(rest)),
  handoffs: (rest) => listHandoffs(parseQArgs(rest)),
  hook: (rest) => hook(parseHookArgs(rest)),
  mcp,
  activate: (rest) => activateStoredInbox(parseQArgs(rest)),
  live: (rest) => live(parseLiveArgs(rest)),
  config: (rest) => config(parseQArgs(rest)),
  logout: (rest) => logout(parseQArgs(rest)),
};

function waitFrom(handler, rest) {
  return handler(parseQArgs(rest));
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === '-h' || command === '--help' || command === 'help') {
    process.stdout.write(`${HELP}\n`);
    process.exit(EXIT.OK);
  }

  if (command === '-v' || command === '--version') {
    process.stdout.write(`${VERSION}\n`);
    process.exit(EXIT.OK);
  }

  // Bare `pingroom` resolves the auth state instead of only printing help:
  // connected -> status + help; not connected -> pair (interactive only).
  // A leading flag with no subcommand (`pingroom --api …`) counts as bare — it
  // configures the connect attempt rather than naming a command.
  if (!command || command.startsWith('-')) {
    process.exit(await bare(parseQArgs(argv)));
  }

  const handler = COMMANDS[command];
  if (!handler) {
    fail(`unknown command: ${command}\nRun "pingroom --help".`, EXIT.USAGE);
  }

  const code = await handler(argv.slice(1));
  process.exit(code);
}

main();
