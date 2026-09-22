import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));
const rootManifest = JSON.parse(await readFile(join(packageDirectory, '..', 'package.json'), 'utf8'));
const expectedFiles = [
  'LICENSE', 'README.md', 'bin/sophy.mjs', 'operations.json', 'package.json',
  'src/cli.mjs', 'src/config.mjs', 'src/transport.mjs',
].sort();
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'sophy-package-'));
const cache = join(temporaryDirectory, 'cache');
const prefix = join(temporaryDirectory, 'installed');
const outsideDirectory = join(temporaryDirectory, 'outside');
const environment = { ...process.env, SOPHY_CONFIG_DIR: join(temporaryDirectory, 'config') };

function execute(command, args, cwd = outsideDirectory) {
  const result = spawnSync(command, args, {
    cwd, env: environment, encoding: 'utf8', timeout: 120_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

function npm(args, cwd) {
  // npm supplies its own entry point, including when Node is installed outside PATH.
  return process.env.npm_execpath
    ? execute(process.execPath, [process.env.npm_execpath, '--cache', cache, ...args], cwd)
    : execute('npm', ['--cache', cache, ...args], cwd);
}

try {
  await mkdir(outsideDirectory);
  assert.equal(rootManifest.private, true, 'The Sophy server must stay private.');
  assert.notEqual(manifest.private, true, 'The CLI must be publishable.');
  assert.equal(manifest.publishConfig.access, 'public');
  assert.equal(manifest.publishConfig.registry, 'https://registry.npmjs.org/');
  assert.equal(manifest.license, 'MIT');
  assert.deepEqual(manifest.bin, { sophy: 'bin/sophy.mjs' });
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies']) {
    assert.equal(Object.keys(manifest[field] ?? {}).length, 0, `Review new ${field} before release.`);
  }
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(manifest.scripts?.[hook], undefined, `Unexpected installation hook: ${hook}`);
  }

  const packed = JSON.parse(npm([
    'pack', '--json', '--ignore-scripts', '--pack-destination', temporaryDirectory,
  ], packageDirectory));
  // npm 11 returns an array; npm 12 returns an object keyed by package name.
  const packages = Array.isArray(packed) ? packed : Object.values(packed);
  assert.equal(packages.length, 1);
  const artifact = packages[0];
  assert.deepEqual(artifact.files.map((file) => file.path).sort(), expectedFiles,
    'The public package must contain only the reviewed CLI files.');
  assert.ok(artifact.files.find((file) => file.path === 'bin/sophy.mjs').mode & 0o111,
    'The CLI entry point must be executable.');
  assert.equal(artifact.name, manifest.name);
  assert.equal(artifact.version, manifest.version);
  const tarball = join(temporaryDirectory, artifact.filename);

  npm(['install', '--global', '--prefix', prefix, '--offline', '--ignore-scripts',
    '--no-audit', '--no-fund', tarball]);
  const installedRoot = process.platform === 'win32'
    ? join(prefix, 'node_modules', manifest.name)
    : join(prefix, 'lib', 'node_modules', manifest.name);
  const installedEntry = join(installedRoot, manifest.bin.sophy);
  const installedManifest = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'));
  assert.equal(installedManifest.version, manifest.version);
  assert.equal(await readFile(join(installedRoot, 'LICENSE'), 'utf8'),
    await readFile(join(dirname(packageDirectory), 'LICENSE'), 'utf8'));
  assert.ok((await readFile(installedEntry, 'utf8')).startsWith('#!/usr/bin/env node\n'));
  assert.equal(execute(process.execPath, [installedEntry, '--version']).trim(), manifest.version);
  assert.match(execute(process.execPath, [installedEntry, '--help']), /Usage: sophy <command>/);
  assert.match(execute(process.execPath, [installedEntry, 'keys', 'update', '--help']), /sophy keys update/);
  if (process.platform !== 'win32') {
    assert.equal(execute(join(prefix, 'bin', 'sophy'), ['--version']).trim(), manifest.version);
  }

  // npm exec is the execution path used by npx. Use the tarball, with no registry access.
  assert.equal(npm(['exec', '--offline', '--yes', '--ignore-scripts', '--package', tarball,
    '--', 'sophy', '--version']).trim(), manifest.version);
  process.stdout.write(`Verified ${manifest.name}@${manifest.version}: ${expectedFiles.length} public files, offline global install, and npx execution outside the checkout.\n`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
