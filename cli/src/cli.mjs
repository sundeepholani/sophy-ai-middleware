import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { configDirectory, loadConfig, normalizeOrigin, requireSession, updateConfig } from './config.mjs';
import { request } from './transport.mjs';

const operations = JSON.parse(await readFile(new URL('../operations.json', import.meta.url), 'utf8'));
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const booleanOptions = new Set(['json', 'yes', 'help', 'version', 'log-content', 'stop-running-eval', 'active']);
const commonOptions = new Set(['url', 'project', 'data', 'json', 'yes', 'help', 'version']);
const kebab = (value) => value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const own = (object, key) => Object.hasOwn(object, key);

export function parseArguments(argv) {
  const positionals = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('-')) { positionals.push(arg); continue; }
    if (arg === '-h') { options.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`Unknown option ${arg}. Use --help.`);
    const [name, ...equalsValue] = arg.slice(2).split('=');
    if (!name || own(options, name)) throw new Error(`Invalid or repeated option --${name}.`);
    if (booleanOptions.has(name)) {
      let value = equalsValue.length ? equalsValue.join('=') : undefined;
      if (value === undefined && ['true', 'false'].includes(argv[i + 1])) value = argv[++i];
      if (value !== undefined && value !== 'true' && value !== 'false') throw new Error(`--${name} must be true or false.`);
      options[name] = value === undefined || value === 'true';
    } else {
      const value = equalsValue.length ? equalsValue.join('=') : argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value.`);
      options[name] = value;
    }
  }
  return { positionals, options };
}

function validateOptions(options, extra = []) {
  const allowed = new Set([...commonOptions, ...extra]);
  for (const name of Object.keys(options)) if (!allowed.has(name)) throw new Error(`Unknown option --${name}. Use --help for the command's options.`);
}

function print(value, compact) {
  process.stdout.write(`${JSON.stringify(value === undefined ? { ok: true } : value, null, compact ? 0 : 2)}\n`);
}

function usage(command) {
  const suffix = command.positional ? ` <${kebab(command.positional)}>` : '';
  const fields = Object.entries(command.fields ?? {}).map(([name, type]) => {
    const required = command.required?.includes(name) ? ' (required)' : '';
    return type === 'secret' ? `  ${name}: secret${required} — JSON field through --data @file or --data -`
      : `  --${kebab(name)} ${type}${required}`;
  });
  return [`sophy ${command.command}${suffix}${command.project === false ? '' : ' --project <project-id>'}`, command.summary, ...fields, ...(command.upload ? ['  --file <path> (required)'] : []), '  --data <JSON|@file|->  Input object; - reads JSON from stdin', '  --json                Compact JSON output', ...(command.confirm ? ['  --yes                 Confirm this action without an interactive prompt'] : []), '  --url <origin>        Sophy server (default https://sophy.in)'].join('\n');
}

function showHelp(positionals = []) {
  const name = positionals.join(' ');
  const exact = operations.find((command) => command.command === name);
  if (exact) { process.stdout.write(`${usage(exact)}\n`); return; }
  const matches = operations.filter((command) => !name || command.command.startsWith(`${name} `));
  if (name && !matches.length && !['login', 'logout', 'auth', 'auth request', 'auth verify', 'projects use'].includes(name)) {
    throw new Error(`Unknown command: ${name}. Use sophy --help.`);
  }
  const lines = ['Sophy CLI — manage your projects with your console access rights.', '', 'Usage: sophy <command> [options]', ''];
  if (!name || ['login', 'logout', 'auth', 'auth request', 'auth verify'].includes(name)) {
    lines.push('  login [--email <email>]  Email a one-time code and sign in', '  auth request --email <email>  Request a code; save its challenge locally', '  auth verify             Sign in with the saved challenge and a code from prompt/stdin', '  logout                  Revoke this CLI session and clear it locally', '');
  }
  if (!name || name === 'projects' || name === 'projects use') lines.push('  projects use <project-id>  Select a verified local default project', '');
  for (const command of matches) lines.push(`  ${command.command.padEnd(31)} ${command.summary}`);
  lines.push('', 'Global: --project <id>, --url <origin>, --json, --help', 'Run sophy <command> --help for input fields. Use --data @file for nested JSON.', 'OTP codes and gateway secrets are never accepted as command-line flags.', 'Code input: hidden prompt on a terminal, otherwise a single code on stdin.', 'Environment: SOPHY_URL, SOPHY_PROJECT, SOPHY_CONFIG_DIR.', 'Default server: https://sophy.in. HTTP is limited to loopback development servers.');
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function readStdin(limit = 1024 * 1024) {
  const parts = [];
  let size = 0;
  for await (const part of process.stdin) {
    size += part.length;
    if (size > limit) throw new Error('Input is too large.');
    parts.push(part);
  }
  return Buffer.concat(parts).toString('utf8');
}

async function prompt(label, { secret = false } = {}) {
  if (!process.stdin.isTTY) throw new Error('This command needs input. Supply the documented flags or pipe the requested input on stdin.');
  // A muted terminal output keeps code entry out of terminal output/recordings.
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const output = secret ? muted : process.stderr;
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    if (secret) process.stderr.write(label);
    const value = await rl.question(secret ? '' : label);
    if (secret) process.stderr.write('\n');
    return value.trim();
  } finally { rl.close(); }
}

async function readCode() {
  const code = (process.stdin.isTTY ? await prompt('One-time code: ', { secret: true }) : await readStdin(1024)).trim();
  if (!/^\d{6}$/.test(code)) throw new Error('Enter the six-digit code from your email. Do not put it in command-line arguments.');
  return code;
}

async function inputData(option) {
  if (option === undefined) return {};
  const raw = option === '-' ? await readStdin() : option.startsWith('@') ? await readFile(option.slice(1), 'utf8') : option;
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error('--data must contain valid JSON (an object).'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('--data must contain a JSON object.');
  return data;
}

function coerceFlag(value, type, name) {
  if (type.startsWith('nullable-') && value === 'null') return null;
  if (type.endsWith('number')) {
    const number = Number(value);
    if (value === '' || !Number.isFinite(number)) throw new Error(`--${kebab(name)} needs a number.`);
    return number;
  }
  if (type === 'boolean') return value;
  if (type.endsWith('object') || type === 'array') {
    try { return JSON.parse(value); } catch { throw new Error(`--${kebab(name)} needs JSON. Use --data @file for nested input.`); }
  }
  return value;
}

function validateField(name, value, type) {
  if (value === null && type.startsWith('nullable-')) return;
  const baseType = type.replace('nullable-', '');
  const valid = baseType === 'object' ? value && typeof value === 'object' && !Array.isArray(value)
    : baseType === 'array' ? Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item.trim())
      : baseType === 'number' ? typeof value === 'number' && Number.isFinite(value)
        : baseType === 'boolean' ? typeof value === 'boolean'
          : typeof value === 'string';
  if (!valid) throw new Error(`Input ${name} must be ${type}.`);
}

async function buildInput(command, positionals, options) {
  const fields = command.fields ?? {};
  // Secret values are intentionally available only in JSON read from a file/stdin.
  const namedFields = Object.entries(fields).filter(([, type]) => type !== 'secret').map(([name]) => kebab(name));
  validateOptions(options, [...namedFields, ...(command.upload ? ['file'] : [])]);
  const data = await inputData(options.data);
  if (Object.entries(fields).some(([name, type]) => type === 'secret' && own(data, name)) && options.data !== '-' && !options.data?.startsWith('@')) {
    throw new Error('Read gateway credentials with --data @file or --data -; do not place secrets in command-line arguments.');
  }
  for (const name of Object.keys(data)) if (!own(fields, name)) throw new Error(`Unknown input field ${name}. Run sophy ${command.command} --help.`);
  const input = { ...command.defaults, ...data };
  const rest = positionals.slice(command.command.split(' ').length);
  if (rest.length > (command.positional ? 1 : 0)) throw new Error(`Unexpected arguments. Run sophy ${command.command} --help.`);
  if (rest[0] !== undefined) {
    if (own(data, command.positional)) throw new Error(`Supply ${command.positional} only once, as an argument or in --data.`);
    input[command.positional] = rest[0];
  }
  for (const [name, type] of Object.entries(fields)) {
    if (own(options, kebab(name))) {
      if (own(data, name) || (name === command.positional && rest.length)) throw new Error(`Supply ${name} only once.`);
      input[name] = coerceFlag(options[kebab(name)], type, name);
    }
    if (own(input, name)) validateField(name, input[name], type);
  }
  for (const name of command.required ?? []) if (!own(input, name) || (typeof input[name] === 'string' && !input[name].trim())) throw new Error(`Missing ${name}. Run sophy ${command.command} --help.`);
  if (input.role && !['admin', 'editor'].includes(input.role)) throw new Error('Role must be admin or editor.');
  if (command.operation === 'usage.get' && ![7, 30, 90].includes(input.sinceDays)) throw new Error('sinceDays must be 7, 30, or 90.');
  if (command.operation === 'logs.list') {
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) throw new Error('Log limit must be a whole number between 1 and 100.');
    if (input.source !== undefined && !['proxy', 'processor', 'challenger', 'judge', 'kb'].includes(input.source)) throw new Error('Log source must be proxy, processor, challenger, judge, or kb.');
  }
  return input;
}

async function confirmAction(command, input, options, projectId) {
  const stopsEvaluation = input.stopRunningEval === true || (Array.isArray(input.stopEvalIds) && input.stopEvalIds.length > 0);
  if (!command.confirm && !stopsEvaluation) return;
  if (options.yes) return;
  if (!process.stdin.isTTY) throw new Error('This action needs confirmation. Review the target and run again with --yes.');
  const target = input.id || input.runId || input.userId || input.invitationId || (Array.isArray(input.ids) ? input.ids.join(', ') : projectId);
  const warning = stopsEvaluation ? ' Running evaluations you named will stop and their samples will be removed.' : '';
  const answer = await prompt(`Confirm ${command.command} for ${target} in project ${projectId}.${warning} Type yes: `);
  if (answer !== 'yes') throw new Error('Action cancelled.');
}

async function revokeToken(origin, token) {
  try { await request(origin, '/api/admin/cli/logout', { token }); }
  catch (error) { if (error.status !== 401) throw error; }
}

function queueRevocation(config, origin, token) {
  config.revocations[origin] = [...new Set([...(config.revocations[origin] ?? []), token])];
}

async function revokeQueuedToken(directory, origin, token) {
  await revokeToken(origin, token);
  await updateConfig(directory, (config) => {
    config.revocations[origin] = (config.revocations[origin] ?? []).filter((queued) => queued !== token);
    if (!config.revocations[origin].length) delete config.revocations[origin];
  });
}

async function authenticate(kind, options, config, directory, origin) {
  validateOptions(options, ['email']);
  if (options.data !== undefined || options.project !== undefined) throw new Error('Authentication does not accept --data or --project.');
  let challenge = config.challenges[origin];
  if (kind !== 'auth verify') {
    const email = (options.email || await prompt('Email: ')).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
    const result = await request(origin, '/api/admin/login', { body: { email } });
    if (typeof result.challengeId !== 'string' || !result.challengeId) throw new Error('Sophy did not return a sign-in challenge.');
    challenge = { challengeId: result.challengeId, email, requestedAt: new Date().toISOString() };
    await updateConfig(directory, (current) => { current.challenges[origin] = challenge; });
    if (kind === 'auth request') { print({ challengeId: challenge.challengeId, message: 'Check your email, then run sophy auth verify and enter the code.' }, options.json); return; }
    process.stderr.write('Check your email for a six-digit code.\n');
  } else if (options.email) {
    throw new Error('auth verify uses the saved challenge. Use auth request --email to request a new one.');
  }
  if (!challenge?.challengeId) throw new Error('Request a code first with sophy auth request --email <email>. Use the same --url for verification.');
  const code = await readCode();
  const result = await request(origin, '/api/admin/login/verify', { body: { challengeId: challenge.challengeId, code, client: 'cli' } });
  if (typeof result.token !== 'string' || !result.token || !Number.isFinite(Date.parse(result.expiresAt)) || !result.user?.id || !result.user?.email) throw new Error('Sophy returned an invalid sign-in session.');
  let previousTokens;
  try {
    previousTokens = await updateConfig(directory, (current) => {
      if (current.sessions[origin]?.token !== config.sessions[origin]?.token) {
        throw new Error('Another command changed this session during sign-in. Run sophy whoami, then sign in again if needed.');
      }
      const previous = current.sessions[origin]?.token;
      if (previous) queueRevocation(current, origin, previous);
      current.sessions[origin] = { token: result.token, expiresAt: result.expiresAt, user: result.user };
      if (current.challenges[origin]?.challengeId === challenge.challengeId) delete current.challenges[origin];
      return [...(current.revocations[origin] ?? [])];
    });
  } catch (error) {
    // A competing sign-in won, or storage failed. Do not leave this newly
    // issued credential active without a way to revoke it.
    try { await revokeToken(origin, result.token); }
    catch {
      await updateConfig(directory, (current) => { queueRevocation(current, origin, result.token); });
      process.stderr.write('A sign-in token awaits revocation. Run sophy logout when the server is available.\n');
    }
    throw error;
  }
  for (const previousToken of previousTokens) {
    try { await revokeQueuedToken(directory, origin, previousToken); }
    catch {
      // The replacement session is already durable. Keep failed revocations
      // separate so logout can retry without losing either credential.
      process.stderr.write('Signed in, but a previous session awaits revocation. Run sophy logout to retry when the server is available.\n');
    }
  }
  print({ user: result.user, expiresAt: result.expiresAt, origin }, options.json);
}

async function uploadBody(command, input, options, projectId) {
  if (!options.file) throw new Error('Upload requires --file <path>.');
  const fileStat = await stat(options.file);
  if (!fileStat.isFile() || fileStat.size === 0 || fileStat.size > 4 * 1024 * 1024) throw new Error('Choose a non-empty file up to 4 MB.');
  const types = { '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  const type = types[extname(options.file).toLowerCase()];
  if (!type) throw new Error('Upload text, Markdown, CSV, JSON, PDF, or Word (.docx).');
  const body = new FormData();
  body.set('operation', command.operation);
  body.set('projectId', projectId);
  body.set('kbId', input.kbId);
  body.set('file', new File([await readFile(options.file)], basename(options.file), { type }));
  return body;
}

export async function run(argv = process.argv.slice(2)) {
  const { positionals, options } = parseArguments(argv);
  if (options.version) { process.stdout.write(`${version}\n`); return; }
  if (options.help || positionals.length === 0 || positionals[0] === 'help') {
    showHelp(positionals[0] === 'help' ? positionals.slice(1) : positionals);
    return;
  }
  const origin = normalizeOrigin(options.url || process.env.SOPHY_URL || 'https://sophy.in');
  const directory = configDirectory();
  const config = await loadConfig(directory);
  const name = positionals.join(' ');
  if (['login', 'auth request', 'auth verify'].includes(name)) { await authenticate(name, options, config, directory, origin); return; }
  if (name === 'logout') {
    validateOptions(options);
    const session = config.sessions[origin];
    const tokens = [...new Set([...(session?.token ? [session.token] : []), ...(config.revocations[origin] ?? [])])];
    for (const token of tokens) {
      await revokeQueuedToken(directory, origin, token);
    }
    await updateConfig(directory, (current) => {
      if (current.sessions[origin]?.token !== session?.token) {
        throw new Error('Another command signed in during logout. Run sophy logout again to revoke the new session.');
      }
      delete current.sessions[origin];
      if (current.challenges[origin]?.challengeId === config.challenges[origin]?.challengeId) delete current.challenges[origin];
    });
    print({ ok: true, message: 'Signed out.', origin }, options.json);
    return;
  }
  const session = requireSession(config, origin);
  if (positionals[0] === 'projects' && positionals[1] === 'use') {
    validateOptions(options);
    if (positionals.length !== 3 || options.project || options.data) throw new Error('Usage: sophy projects use <project-id>');
    const projectId = positionals[2];
    const result = await request(origin, '/api/admin/cli', { token: session.token, body: { operation: 'projects.list', input: {} } });
    const projects = result.data;
    if (!Array.isArray(projects) || !projects.some((project) => project.id === projectId)) throw new Error('You do not have access to that project. Run sophy projects list.');
    await updateConfig(directory, (current) => {
      if (current.sessions[origin]?.token !== session.token) throw new Error('Your session changed during project selection. Run the command again.');
      current.sessions[origin].projectId = projectId;
    });
    print({ projectId, origin }, options.json);
    return;
  }
  const command = operations.find((entry) => entry.command.split(' ').every((word, index) => positionals[index] === word));
  if (!command) throw new Error(`Unknown command: ${name}. Use sophy --help.`);
  const input = await buildInput(command, positionals, options);
  const projectId = options.project || process.env.SOPHY_PROJECT || session.projectId;
  if (command.project !== false && !projectId) throw new Error('Choose a project with --project <id> or sophy projects use <id>.');
  await confirmAction(command, input, options, projectId);
  const body = command.upload ? await uploadBody(command, input, options, projectId) : { operation: command.operation, ...(command.project === false ? {} : { projectId }), input };
  const result = await request(origin, '/api/admin/cli', { token: session.token, body, multipart: command.upload });
  print(result.data, options.json);
  // Make incomplete bulk actions and evaluation-stop requirements visible to scripts.
  if (result.data?.requiresEvalStop || (Array.isArray(result.data?.skipped) && result.data.skipped.length)) process.exitCode = 2;
}

export async function main() {
  try { await run(); }
  catch (error) {
    const compact = process.argv.includes('--json') || process.argv.includes('--json=true');
    const message = error instanceof Error ? error.message : 'The command failed.';
    process.stderr.write(compact ? `${JSON.stringify({ error: { code: error.code || 'cli_error', message } })}\n` : `Error: ${message}\n`);
    process.exitCode = 1;
  }
}
