import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export function normalizeOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Use a full Sophy URL, such as https://sophy.in.'); }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('The Sophy URL must be an origin without credentials, a path, a query, or a fragment.');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Sophy requires HTTPS. HTTP is allowed only for localhost, 127.0.0.1, or [::1].');
  }
  return url.origin;
}

export function configDirectory(env = process.env) {
  return resolve(env.SOPHY_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'sophy'));
}

async function secureDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The Sophy config directory must be a real directory, not a symbolic link.');
  await chmod(directory, 0o700);
}

export async function loadConfig(directory) {
  // Do not follow a config-directory symlink when reading a session either.
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The Sophy config directory must be a real directory, not a symbolic link.');
    const handle = await open(join(directory, 'config.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('The Sophy config file is invalid.');
      // Repair overly broad permissions before reading a previously saved token.
      await chmod(directory, 0o700);
      await handle.chmod(0o600);
      const config = JSON.parse(await handle.readFile('utf8'));
      if (config.version !== 1 || !config.sessions || typeof config.sessions !== 'object' || Array.isArray(config.sessions) || !config.challenges || typeof config.challenges !== 'object' || Array.isArray(config.challenges)) {
        throw new Error('The Sophy config file has an unsupported format.');
      }
      if (config.revocations === undefined) config.revocations = {};
      if (!config.revocations || typeof config.revocations !== 'object' || Array.isArray(config.revocations)
        || Object.values(config.revocations).some((tokens) => !Array.isArray(tokens) || tokens.some((token) => typeof token !== 'string'))) {
        throw new Error('The Sophy config file has an unsupported format.');
      }
      return config;
    } finally { await handle.close(); }
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, sessions: {}, challenges: {}, revocations: {} };
    if (error instanceof SyntaxError) throw new Error('The Sophy config file is not valid JSON.');
    if (error.code === 'ELOOP') throw new Error('The Sophy config file must not be a symbolic link.');
    throw error;
  }
}

async function writeConfig(directory, config) {
  await secureDirectory(directory);
  const temporary = join(directory, `.config-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`); }
    finally { await handle.close(); }
    await rename(temporary, join(directory, 'config.json'));
  } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function abandonedLock(lock) {
  try {
    const info = await lstat(lock);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The Sophy config lock must be a real directory.');
    try {
      const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
      return Number.isInteger(owner.pid) && owner.pid > 0 ? !processExists(owner.pid) : Date.now() - (info.birthtimeMs || info.mtimeMs) > 30_000;
    } catch (error) {
      // An owner can be between mkdir and writeFile. Give that step time to finish.
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return Date.now() - (info.birthtimeMs || info.mtimeMs) > 30_000;
      throw error;
    }
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function recoverAbandonedLock(lock) {
  if (!(await abandonedLock(lock))) return;
  const recovery = join(lock, 'recovery');
  try { await mkdir(recovery, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    if (error.code !== 'EEXIST') throw error;
    // A recovery process can also die. Its own owner record uses the same test.
    if (await abandonedLock(recovery)) await rm(recovery, { recursive: true, force: true });
    return;
  }
  let removed = false;
  try {
    await writeFile(join(recovery, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    // The recovery directory serializes reclaimers. Re-read the parent owner
    // so a new lock acquired since the first check is never removed.
    if (await abandonedLock(lock)) {
      await rm(lock, { recursive: true, force: true });
      removed = true;
    }
  } finally { if (!removed) await rm(recovery, { recursive: true, force: true }); }
}

async function withConfigLock(directory, fn) {
  await secureDirectory(directory);
  const lock = join(directory, '.config.lock');
  const owner = { pid: process.pid, nonce: randomUUID() };
  const deadline = Date.now() + 5000;
  while (true) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await recoverAbandonedLock(lock);
      if (Date.now() >= deadline) throw new Error('Another Sophy command is updating your session. Try again after it finishes.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    await writeFile(join(lock, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
    return await fn();
  } finally {
    const currentOwner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8').catch(() => '{}'));
    if (currentOwner.nonce === owner.nonce) await rm(lock, { recursive: true, force: true });
  }
}

/** Lock only the local read/modify/write, never a prompt or network request. */
export async function updateConfig(directory, mutate) {
  return withConfigLock(directory, async () => {
    const config = await loadConfig(directory);
    const result = mutate(config);
    await writeConfig(directory, config);
    return result;
  });
}

/** Primarily for initialization and tests. Command mutations use updateConfig. */
export async function saveConfig(directory, config) {
  await withConfigLock(directory, () => writeConfig(directory, config));
}

export function requireSession(config, origin) {
  const session = config.sessions[origin];
  if (!session || typeof session.token !== 'string' || !session.token || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= Date.now()) {
    throw new Error(`Sign in first with sophy login${origin === 'https://sophy.in' ? '' : ` --url ${origin}`}.`);
  }
  return session;
}
