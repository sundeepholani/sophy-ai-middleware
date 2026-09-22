import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadConfig, normalizeOrigin, saveConfig } from '../src/config.mjs';

const binary = fileURLToPath(new URL('../bin/sophy.mjs', import.meta.url));
const token = 'synthetic-cli-token-never-print';
const user = { id: 'user-1', email: 'tester@example.com' };
const future = () => new Date(Date.now() + 60_000).toISOString();

async function fixture(t, handler) {
  const directory = await mkdtemp(join(tmpdir(), 'sophy-cli-test-'));
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const json = req.headers['content-type']?.includes('application/json') ? JSON.parse(raw || '{}') : null;
    const call = { path: req.url, headers: req.headers, raw, json };
    calls.push(call);
    const result = await handler?.(call, res);
    if (res.writableEnded) return;
    res.setHeader('content-type', 'application/json');
    if (result) { res.end(JSON.stringify(result)); return; }
    if (req.url === '/api/admin/login') { res.end(JSON.stringify({ ok: true, challengeId: 'challenge-1' })); return; }
    if (req.url === '/api/admin/login/verify') { res.end(JSON.stringify({ ok: true, token, expiresAt: future(), user })); return; }
    res.end(JSON.stringify({ ok: true, data: { operation: json?.operation ?? 'upload', received: json?.input } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { directory, origin, calls, async session(extra = {}) { await saveConfig(directory, { version: 1, sessions: { [origin]: { token, expiresAt: future(), user, ...extra } }, challenges: {} }); } };
}

function cli(f, args, stdin = '', extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binary, ...args], {
      env: { ...process.env, SOPHY_CONFIG_DIR: f.directory, SOPHY_URL: f.origin, SOPHY_PROJECT: '', ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

function success(result) {
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('login requests and verifies an OTP, persists a private session, and never prints the token', async (t) => {
  const f = await fixture(t);
  const result = await cli(f, ['login', '--email', user.email, '--json'], '123456\n');
  assert.equal(success(result).user.email, user.email);
  assert.equal(result.stdout.includes(token), false);
  assert.equal(result.stderr.includes('123456'), false);
  assert.deepEqual(f.calls.map((call) => [call.path, call.json]), [
    ['/api/admin/login', { email: user.email }],
    ['/api/admin/login/verify', { challengeId: 'challenge-1', code: '123456', client: 'cli' }],
  ]);
  assert.equal(f.calls.some((call) => call.headers.authorization), false);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.directory, 'config.json'))).mode & 0o777, 0o600);
  const config = await loadConfig(f.directory);
  assert.equal(config.sessions[f.origin].token, token);
  assert.deepEqual(config.challenges, {});
});

test('split authentication retains its challenge after a rejected code and supports retry', async (t) => {
  const f = await fixture(t, (call, res) => {
    if (call.path.endsWith('/verify') && call.json.code === '000000') {
      res.statusCode = 401;
      return { error: 'invalid_or_expired_code' };
    }
  });
  success(await cli(f, ['auth', 'request', '--email', user.email]));
  const rejected = await cli(f, ['auth', 'verify', '--json'], '000000');
  assert.equal(rejected.code, 1);
  assert.equal(JSON.parse(rejected.stderr).error.code, 'invalid_or_expired_code');
  assert.match(JSON.parse(rejected.stderr).error.message, /request a new code/);
  assert.equal((await loadConfig(f.directory)).challenges[f.origin].challengeId, 'challenge-1');
  success(await cli(f, ['auth', 'verify'], '123456'));
  const forbidden = await cli(f, ['auth', 'verify', '--code', '123456']);
  assert.equal(forbidden.code, 1);
  assert.match(forbidden.stderr, /Unknown option --code/);
});

test('nested key configuration and partial updates reach the management API unchanged', async (t) => {
  const f = await fixture(t);
  await f.session();
  const payload = { name: 'Support', model: 'vendor/model', params: { temperature: 0.3, allowClientPrompt: true }, outputSchema: { type: 'object', properties: { answer: { type: 'string' } } }, ownerUserId: null, monthlyCostCapUsd: null };
  const file = join(f.directory, 'key.json');
  await writeFile(file, JSON.stringify(payload));
  success(await cli(f, ['keys', 'create', '--project', 'project-1', '--data', `@${file}`, '--json']));
  assert.deepEqual(f.calls[0].json, { operation: 'keys.create', projectId: 'project-1', input: payload });
  assert.equal(f.calls[0].headers.authorization, `Bearer ${token}`);
  success(await cli(f, ['keys', 'update', 'key-1', '--project', 'project-1', '--data', '-'], '{"systemPrompt":null,"logContent":false}'));
  assert.deepEqual(f.calls[1].json.input, { id: 'key-1', systemPrompt: null, logContent: false });
  const invalid = await cli(f, ['keys', 'create', '--project', 'project-1', '--data', '{"name":"A","model":"m","rpmLimit":"5"}']);
  assert.equal(invalid.code, 1);
  assert.equal(f.calls.length, 2);
});

test('management commands map IDs and named flags to the server contract', async (t) => {
  const f = await fixture(t);
  await f.session({ projectId: 'project-1' });
  const cases = [
    [['whoami'], 'identity.get', {}, false],
    [['projects', 'list'], 'projects.list', {}, false],
    [['gateway', 'status'], 'gateway.status', {}],
    [['keys', 'get', 'key-1'], 'keys.get', { id: 'key-1' }],
    [['evals', 'get', 'run-1'], 'evals.get', { runId: 'run-1' }],
    [['evals', 'start', 'key-1', '--challenger-model', 'vendor/model'], 'evals.start', { apiKeyId: 'key-1', challengerModel: 'vendor/model', targetN: 100 }],
    [['members', 'role', 'user-2', '--role', 'editor', '--yes'], 'members.role', { userId: 'user-2', role: 'editor' }],
    [['members', 'status', 'user-2', '--active=false', '--yes'], 'members.status', { userId: 'user-2', active: false }],
    [['invitations', 'revoke', 'invite-1', '--yes'], 'invitations.revoke', { invitationId: 'invite-1' }],
    [['knowledgebases', 'documents', 'kb-1'], 'knowledgebases.documents', { kbId: 'kb-1' }],
    [['usage', '--since-days', '7', '--key-id', 'key-1'], 'usage.get', { sinceDays: 7, keyId: 'key-1' }],
    [['logs', 'list', '--source', 'processor', '--limit', '8'], 'logs.list', { source: 'processor', limit: 8 }],
    [['settings', 'update', '--judge-model', 'vendor/judge', '--notify-email', 'null'], 'settings.update', { judgeModel: 'vendor/judge', notifyEmail: null }],
  ];
  for (const [args, operation, input, project] of cases) {
    success(await cli(f, args));
    assert.deepEqual(f.calls.at(-1).json, { operation, ...(project === false ? {} : { projectId: 'project-1' }), input });
  }
});

test('destructive commands and explicit evaluation stops require confirmation before a request', async (t) => {
  const f = await fixture(t);
  await f.session({ projectId: 'project-1' });
  for (const args of [
    ['keys', 'rotate', 'key-1'],
    ['keys', 'revoke', 'key-1'],
    ['keys', 'update', 'key-1', '--stop-running-eval'],
    ['evals', 'bulk-start', '--data', '{"ids":["key-1"],"challengerModel":"model","stopEvalIds":["key-1"]}'],
    ['gateway', 'disconnect'],
  ]) {
    const result = await cli(f, args);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--yes/);
  }
  assert.equal(f.calls.length, 0);
  success(await cli(f, ['keys', 'rotate', 'key-1', '--yes']));
  assert.equal(f.calls.at(-1).json.operation, 'keys.rotate');
});

test('sessions and pending challenges cannot cross server origins', async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  await first.session();
  const result = await cli(first, ['projects', 'list', '--url', second.origin]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Sign in first/);
  assert.equal(second.calls.length, 0);
  success(await cli(first, ['auth', 'request', '--email', user.email]));
  const verify = await cli(first, ['auth', 'verify', '--url', second.origin], '123456');
  assert.equal(verify.code, 1);
  assert.match(verify.stderr, /Request a code first/);
  assert.equal(second.calls.length, 0);
  await first.session({ expiresAt: '2000-01-01T00:00:00Z' });
  assert.equal((await cli(first, ['projects', 'list'])).code, 1);
  assert.equal(first.calls.length, 1);
});

test('redirects never forward a bearer token or OTP', async (t) => {
  const destination = await fixture(t);
  const source = await fixture(t, (_call, res) => {
    res.statusCode = 307;
    res.setHeader('location', `${destination.origin}/collect`);
    res.end();
  });
  await source.session();
  const management = await cli(source, ['projects', 'list']);
  assert.equal(management.code, 1);
  assert.match(management.stderr, /redirects are not accepted/);
  assert.equal(management.stderr.includes(token), false);
  const login = await cli(source, ['login', '--email', user.email], '123456');
  assert.equal(login.code, 1);
  assert.equal(destination.calls.length, 0);
});

test('server permissions remain authoritative and API errors are machine readable', async (t) => {
  const f = await fixture(t, (_call, res) => {
    res.statusCode = 403;
    return { error: { code: 'forbidden', message: 'Project admin access is required.' } };
  });
  await f.session();
  const result = await cli(f, ['members', 'list', '--project', 'not-my-project', '--json']);
  assert.equal(result.code, 1);
  assert.deepEqual(JSON.parse(result.stderr), { error: { code: 'forbidden', message: 'Project admin access is required.' } });
  assert.equal(result.stdout, '');
});

test('local project selection checks current membership and persists separately from web default', async (t) => {
  const f = await fixture(t, (call) => call.json?.operation === 'projects.list' ? { ok: true, data: [{ id: 'project-1', role: 'editor' }] } : undefined);
  await f.session();
  assert.equal((await cli(f, ['projects', 'use', 'project-2'])).code, 1);
  assert.equal((await loadConfig(f.directory)).sessions[f.origin].projectId, undefined);
  success(await cli(f, ['projects', 'use', 'project-1']));
  success(await cli(f, ['keys', 'list']));
  assert.equal(f.calls.at(-1).json.projectId, 'project-1');
  assert.equal(f.calls.some((call) => call.json.operation === 'projects.default'), false);
});

test('upload sends a real multipart file and rejects oversized or unsupported files locally', async (t) => {
  const f = await fixture(t);
  await f.session({ projectId: 'project-1' });
  const file = join(f.directory, 'guide.md');
  await writeFile(file, '# Product guide\n');
  success(await cli(f, ['knowledgebases', 'upload', 'kb-1', '--file', file]));
  const call = f.calls[0];
  assert.match(call.headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.match(call.raw, /name="operation"\r\n\r\nknowledgebases\.upload/);
  assert.match(call.raw, /name="projectId"\r\n\r\nproject-1/);
  assert.match(call.raw, /name="kbId"\r\n\r\nkb-1/);
  assert.match(call.raw, /filename="guide.md"/);
  assert.match(call.raw, /Content-Type: text\/markdown/);
  assert.match(call.raw, /# Product guide/);
  await writeFile(file, Buffer.alloc(4 * 1024 * 1024 + 1));
  const tooLarge = await cli(f, ['knowledgebases', 'upload', 'kb-1', '--file', file]);
  assert.equal(tooLarge.code, 1);
  assert.match(tooLarge.stderr, /4 MB/);
  assert.equal(f.calls.length, 1);
});

test('gateway credentials must come from a file or stdin, never an inline flag', async (t) => {
  const f = await fixture(t);
  await f.session({ projectId: 'project-1' });
  const inline = await cli(f, ['gateway', 'connect', '--data', '{"apiKey":"synthetic-secret"}']);
  assert.equal(inline.code, 1);
  assert.equal(inline.stderr.includes('synthetic-secret'), false);
  const flag = await cli(f, ['gateway', 'connect', '--api-key', 'synthetic-secret']);
  assert.equal(flag.code, 1);
  assert.equal(f.calls.length, 0);
  success(await cli(f, ['gateway', 'connect', '--data', '-'], '{"apiKey":"synthetic-secret"}'));
  assert.equal(f.calls[0].json.input.apiKey, 'synthetic-secret');
});

test('logout revokes the current token before removing its local session', async (t) => {
  const f = await fixture(t);
  await f.session();
  success(await cli(f, ['logout']));
  assert.equal(f.calls[0].path, '/api/admin/cli/logout');
  assert.equal(f.calls[0].headers.authorization, `Bearer ${token}`);
  assert.equal((await loadConfig(f.directory)).sessions[f.origin], undefined);
  assert.equal((await cli(f, ['keys', 'list', '--project', 'project-1'])).code, 1);
});

test('partial action results exit nonzero while preserving their reviewable JSON', async (t) => {
  const f = await fixture(t, () => ({ ok: true, data: { done: 1, skipped: [{ id: 'key-2', reason: 'forbidden' }] } }));
  await f.session({ projectId: 'project-1' });
  const result = await cli(f, ['keys', 'bulk-model', '--data', '{"ids":["key-1","key-2"],"model":"model"}', '--yes']);
  assert.equal(result.code, 2);
  assert.equal(JSON.parse(result.stdout).skipped[0].id, 'key-2');
});

test('a null result remains null rather than turning into a different success payload', async (t) => {
  const f = await fixture(t, () => ({ ok: true, data: null }));
  await f.session({ projectId: 'project-1' });
  const result = await cli(f, ['evals', 'refresh', 'key-1', '--json']);
  assert.equal(success(result), null);
});

test('HTTP is restricted to loopback and malformed origins are rejected', () => {
  assert.equal(normalizeOrigin('https://sophy.in/'), 'https://sophy.in');
  assert.equal(normalizeOrigin('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(normalizeOrigin('http://[::1]:3000'), 'http://[::1]:3000');
  for (const url of ['http://sophy.in', 'https://sophy.in/path', 'https://name:secret@sophy.in', 'https://sophy.in?x=1', 'https://sophy.in#token', 'file:///tmp/sophy']) assert.throws(() => normalizeOrigin(url));
});

test('config file symlinks are rejected and help works without authentication', async (t) => {
  const f = await fixture(t);
  const target = join(f.directory, 'elsewhere.json');
  await writeFile(target, '{}');
  await symlink(target, join(f.directory, 'config.json'));
  await assert.rejects(loadConfig(f.directory), /symbolic link/);
  const result = await cli(f, ['keys', 'update', '--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /supplied params replace all params/);
  assert.match(result.stdout, /--output-schema/);
  assert.equal(f.calls.length, 0);
});

test('concurrent authentication on different origins preserves both challenges and sessions', async (t) => {
  const barrier = deferred();
  let reached = 0;
  const handler = async (call) => {
    if (call.path === '/api/admin/login') {
      if (++reached === 2) barrier.resolve();
      await barrier.promise;
    }
  };
  const first = await fixture(t, handler);
  const second = await fixture(t, handler);
  const shared = { SOPHY_CONFIG_DIR: first.directory };
  const requests = await Promise.all([
    cli(first, ['auth', 'request', '--email', user.email]),
    cli(second, ['auth', 'request', '--email', user.email], '', shared),
  ]);
  requests.forEach(success);
  const pending = await loadConfig(first.directory);
  assert.ok(pending.challenges[first.origin]);
  assert.ok(pending.challenges[second.origin]);
  const verified = await Promise.all([
    cli(first, ['auth', 'verify'], '123456'),
    cli(second, ['auth', 'verify'], '123456', shared),
  ]);
  verified.forEach(success);
  const config = await loadConfig(first.directory);
  assert.equal(config.sessions[first.origin].token, token);
  assert.equal(config.sessions[second.origin].token, token);
  assert.deepEqual(config.challenges, {});
});

test('a stale project selection cannot restore a session after logout', async (t) => {
  const reached = deferred();
  const release = deferred();
  const f = await fixture(t, async (call) => {
    if (call.json?.operation === 'projects.list') {
      reached.resolve();
      await release.promise;
      return { ok: true, data: [{ id: 'project-1' }] };
    }
  });
  await f.session();
  const selecting = cli(f, ['projects', 'use', 'project-1']);
  await reached.promise;
  success(await cli(f, ['logout']));
  release.resolve();
  const result = await selecting;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /session changed/);
  assert.equal((await loadConfig(f.directory)).sessions[f.origin], undefined);
});

test('re-login revokes the previous session after saving the replacement', async (t) => {
  const replacement = 'synthetic-replacement-token';
  const f = await fixture(t, async (call) => {
    if (call.path.endsWith('/verify')) return { ok: true, token: replacement, expiresAt: future(), user };
    if (call.path.endsWith('/logout')) {
      assert.equal((await loadConfig(f.directory)).sessions[f.origin].token, replacement);
    }
  });
  await f.session();
  success(await cli(f, ['login', '--email', user.email], '123456'));
  assert.ok(f.calls.some((call) => call.path.endsWith('/logout') && call.headers.authorization === `Bearer ${token}`));
  const config = await loadConfig(f.directory);
  assert.equal(config.sessions[f.origin].token, replacement);
  assert.deepEqual(config.revocations, {});
});

test('failed previous-session revocation remains retryable without losing the new session', async (t) => {
  const replacement = 'synthetic-replacement-token';
  let failRevocation = true;
  const f = await fixture(t, (call, res) => {
    if (call.path.endsWith('/verify')) return { ok: true, token: replacement, expiresAt: future(), user };
    if (call.path.endsWith('/logout') && call.headers.authorization === `Bearer ${token}` && failRevocation) {
      res.statusCode = 503;
      return { error: { code: 'unavailable', message: 'Temporary service error.' } };
    }
  });
  await f.session();
  const login = await cli(f, ['login', '--email', user.email], '123456');
  success(login);
  assert.match(login.stderr, /previous session awaits revocation/);
  const config = await loadConfig(f.directory);
  assert.equal(config.sessions[f.origin].token, replacement);
  assert.deepEqual(config.revocations[f.origin], [token]);
  failRevocation = false;
  success(await cli(f, ['logout']));
  const cleared = await loadConfig(f.directory);
  assert.equal(cleared.sessions[f.origin], undefined);
  assert.deepEqual(cleared.revocations, {});
  assert.ok(f.calls.some((call) => call.path.endsWith('/logout') && call.headers.authorization === `Bearer ${replacement}`));
});

test('concurrent sign-ins on one origin retain one session and revoke the losing token', async (t) => {
  const barrier = deferred();
  let verifications = 0;
  const f = await fixture(t, async (call) => {
    if (call.path.endsWith('/verify')) {
      if (++verifications === 2) barrier.resolve();
      await barrier.promise;
      return { ok: true, token: `session-${call.json.code}`, expiresAt: future(), user };
    }
  });
  const results = await Promise.all([
    cli(f, ['login', '--email', user.email], '111111'),
    cli(f, ['login', '--email', user.email], '222222'),
  ]);
  assert.deepEqual(results.map((result) => result.code).sort(), [0, 1]);
  const config = await loadConfig(f.directory);
  const winner = config.sessions[f.origin].token;
  const loser = winner === 'session-111111' ? 'session-222222' : 'session-111111';
  assert.ok(f.calls.some((call) => call.path.endsWith('/logout') && call.headers.authorization === `Bearer ${loser}`));
  assert.equal(f.calls.some((call) => call.path.endsWith('/logout') && call.headers.authorization === `Bearer ${winner}`), false);
});

test('an old logout cannot delete a newer sign-in session', async (t) => {
  const reached = deferred();
  const release = deferred();
  let logoutCalls = 0;
  const replacement = 'synthetic-new-session';
  const f = await fixture(t, async (call) => {
    if (call.path.endsWith('/verify')) return { ok: true, token: replacement, expiresAt: future(), user };
    if (call.path.endsWith('/logout') && ++logoutCalls === 1) {
      reached.resolve();
      await release.promise;
    }
  });
  await f.session();
  const oldLogout = cli(f, ['logout']);
  await reached.promise;
  success(await cli(f, ['login', '--email', user.email], '123456'));
  release.resolve();
  const result = await oldLogout;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /signed in during logout/);
  assert.equal((await loadConfig(f.directory)).sessions[f.origin].token, replacement);
});

test('a lock abandoned by an exited process is recovered', async (t) => {
  const f = await fixture(t);
  const lock = join(f.directory, '.config.lock');
  await mkdir(lock);
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, nonce: 'abandoned' }));
  success(await cli(f, ['auth', 'request', '--email', user.email]));
  assert.equal((await loadConfig(f.directory)).challenges[f.origin].challengeId, 'challenge-1');
  await assert.rejects(stat(lock), { code: 'ENOENT' });
});
