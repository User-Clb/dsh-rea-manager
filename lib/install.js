/**
 * REA runtime installation.
 *
 * A "runtime" is one installed copy of REA plus the Node binary used to launch
 * it. Runtimes are immutable directories under `versions/<version>/`, so
 * rollback is a pointer swap in `active.json` rather than a reinstall.
 *
 * Two acquisition channels, tried in the configured order:
 *   npm — `npm install rea-agents@<version>` on a registry mirror. The package
 *         ships a prebuilt `dist/`, so this needs no toolchain.
 *   git — shallow clone of the release tag on a repository mirror, then a local
 *         build. Only used for tags that npm never published.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { gitCacheDir, logsDir, versionsDir, NPM_PACKAGE, UPSTREAM_REPO } from './paths.js';
import { effectiveMirrors, loadConfig, saveActive, loadActive } from './config.js';
import { expandMirror, mirrorsOfKind, npmRegistryUrl } from './mirrors.js';
import { sortVersionsDescending, tagForVersion, compareVersions } from './semver.js';
import { httpGet, log, run } from './exec.js';
import { ensureNodeRuntime } from './node-runtime.js';

/** Relative entry script inside an installed REA package. */
export const REA_ENTRY = path.join('node_modules', NPM_PACKAGE, 'scripts', 'rea.mjs');
/** Relative entry inside a git source build. */
export const REA_SOURCE_ENTRY = path.join('scripts', 'rea.mjs');

function dirForVersion(version) {
  return path.join(versionsDir(), version);
}

function rmrf(target) {
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    log(`rmrf failed ${target}: ${String(error?.message ?? error)}`);
  }
}

/** Locate the npm CLI that belongs to one Node binary. */
function npmCliFor(nodePath) {
  const candidates = [];
  const nodeDir = path.dirname(nodePath);
  candidates.push(path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  candidates.push(path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  if (process.env.npm_execpath) candidates.push(process.env.npm_execpath);
  candidates.push(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  for (const candidate of candidates) {
    try {
      if (candidate && existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Inspect one installed runtime directory. */
export function inspectRuntime(version) {
  const dir = dirForVersion(version);
  if (!existsSync(dir)) return null;
  const npmEntry = path.join(dir, REA_ENTRY);
  const sourceEntry = path.join(dir, REA_SOURCE_ENTRY);
  if (existsSync(npmEntry)) {
    return { version, dir, entry: npmEntry, channel: 'npm' };
  }
  if (existsSync(sourceEntry) && existsSync(path.join(dir, 'dist'))) {
    return { version, dir, entry: sourceEntry, channel: 'git' };
  }
  return null;
}

/** Every runtime currently present on disk. */
export function listInstalled() {
  const root = versionsDir();
  if (!existsSync(root)) return [];
  const found = [];
  for (const name of readdirSync(root)) {
    const runtime = inspectRuntime(name);
    if (runtime) {
      try {
        runtime.installedAt = statSync(runtime.dir).mtime.toISOString();
      } catch {
        runtime.installedAt = '';
      }
      found.push(runtime);
    }
  }
  return sortVersionsDescending(found.map((entry) => entry.version)).map((version) => found.find((entry) => entry.version === version));
}

async function installFromNpm(version, options) {
  const { signal, nodePath, attempts } = options;
  const config = loadConfig();
  const finalDir = dirForVersion(version);
  const npmCli = npmCliFor(nodePath);
  if (!npmCli) {
    attempts.push({ channel: 'npm', id: 'local', ok: false, reason: 'npm CLI not found next to the selected Node binary' });
    return null;
  }
  const registries = mirrorsOfKind(effectiveMirrors(config), 'npm');
  for (const mirror of registries) {
    const registry = npmRegistryUrl(mirror);
    const staging = `${finalDir}.staging-${Date.now()}`;
    mkdirSync(staging, { recursive: true });
    const started = Date.now();
    const result = await run(nodePath, [
      npmCli,
      'install',
      '--prefix', staging,
      '--registry', registry,
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      '--ignore-scripts=false',
      `${NPM_PACKAGE}@${version}`,
    ], {
      timeoutMs: Math.max(config.networkTimeoutMs, 600000),
      signal,
      env: { npm_config_registry: registry, NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
    });
    const installedEntry = path.join(staging, REA_ENTRY);
    if (result.code === 0 && existsSync(installedEntry)) {
      rmrf(finalDir);
      try {
        renameSync(staging, finalDir);
      } catch (error) {
        attempts.push({ channel: 'npm', id: mirror.id, ok: false, ms: Date.now() - started, reason: String(error?.message ?? error) });
        rmrf(staging);
        continue;
      }
      attempts.push({ channel: 'npm', id: mirror.id, ok: true, ms: Date.now() - started });
      log(`install npm ${version} via ${mirror.id} in ${Date.now() - started} ms`);
      return { version, dir: finalDir, entry: path.join(finalDir, REA_ENTRY), channel: 'npm', mirror: mirror.id };
    }
    const reason = (result.stderr || result.stdout || `exit ${result.code}`).trim().split('\n').filter(Boolean).slice(-3).join(' | ');
    attempts.push({ channel: 'npm', id: mirror.id, ok: false, ms: Date.now() - started, reason: reason.slice(0, 400) });
    log(`install npm ${version} via ${mirror.id} failed: ${reason.slice(0, 300)}`);
    rmrf(staging);
  }
  return null;
}

/** Ensure the partial clone exists and contains the requested tag. */
async function ensureGitCache(config, signal) {
  const dir = gitCacheDir();
  const git = ['-c', 'credential.interactive=never'];
  if (existsSync(path.join(dir, '.git'))) {
    return { ok: true, dir };
  }
  mkdirSync(path.dirname(dir), { recursive: true });
  const mirrors = mirrorsOfKind(effectiveMirrors(config), 'git');
  for (const mirror of mirrors) {
    const url = expandMirror(mirror, UPSTREAM_REPO);
    const result = await run('git', [...git, 'clone', '--filter=blob:none', '--no-checkout', url, dir], {
      timeoutMs: config.networkTimeoutMs,
      signal,
    });
    if (result.code === 0 && existsSync(path.join(dir, '.git'))) return { ok: true, dir, mirror: mirror.id };
    rmrf(dir);
  }
  return { ok: false, dir };
}

async function installFromGit(version, options) {
  const { signal, nodePath, attempts } = options;
  const config = loadConfig();
  const tag = tagForVersion(version);
  const started = Date.now();
  const staging = `${dirForVersion(version)}.staging-${Date.now()}`;
  mkdirSync(staging, { recursive: true });

  // Preferred path: the release archive over an accelerator mirror. A partial
  // clone has to re-fetch every blob at checkout time, which is far slower than
  // one tarball for a repository this size.
  const archives = [];
  for (const mirror of mirrorsOfKind(effectiveMirrors(config), 'git')) {
    if (mirror.template) {
      archives.push({
        id: mirror.id,
        url: mirror.template.replace('{url}', `https://github.com/morluto/rea/archive/refs/tags/${tag}.tar.gz`),
      });
    }
  }
  archives.push({ id: 'codeload', url: `https://codeload.github.com/morluto/rea/tar.gz/refs/tags/${tag}` });
  archives.push({ id: 'gitee-archive', url: `https://gitee.com/mirrors/rea/repository/archive/${tag}.tar.gz` });

  let unpacked = false;
  for (const archive of archives) {
    const archivePath = path.join(staging, '..', `${version}-${archive.id}.tar.gz`);
    try {
      const response = await httpGet(archive.url, { timeoutMs: config.networkTimeoutMs, signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength < 1024) throw new Error(`suspiciously small archive (${buffer.byteLength} bytes)`);
      writeFileSync(archivePath, buffer);
      const extract = await run('tar', ['-xzf', archivePath, '-C', staging, '--strip-components=1'], {
        timeoutMs: Math.max(config.networkTimeoutMs, 600000),
        signal,
      });
      if (extract.code !== 0) throw new Error((extract.stderr || 'tar failed').slice(-200));
      if (!existsSync(path.join(staging, 'package.json'))) throw new Error('archive did not contain package.json');
      attempts.push({ channel: 'git', id: `archive-${archive.id}`, ok: true, ms: Date.now() - started });
      unpacked = true;
      break;
    } catch (error) {
      attempts.push({ channel: 'git', id: `archive-${archive.id}`, ok: false, reason: String(error?.message ?? error).slice(0, 200) });
    } finally {
      try {
        rmSync(archivePath, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  if (!unpacked) {
    // Fallback: partial clone + checkout of the tag.
    const cache = await ensureGitCache(config, signal);
    if (!cache.ok) {
      attempts.push({ channel: 'git', id: 'clone', ok: false, reason: 'no mirror served the partial clone' });
      rmrf(staging);
      return null;
    }
    const fetch = await run('git', ['-C', cache.dir, 'fetch', '--depth', '1', 'origin', `refs/tags/${tag}:refs/tags/${tag}`], {
      timeoutMs: config.networkTimeoutMs,
      signal,
    });
    if (fetch.code !== 0) {
      attempts.push({ channel: 'git', id: cache.mirror ?? 'cache', ok: false, reason: (fetch.stderr || '').slice(-300) });
      rmrf(staging);
      return null;
    }
    const checkout = await run('git', ['-C', cache.dir, '--work-tree', staging, 'checkout', '--force', tag, '--', '.'], {
      timeoutMs: Math.max(config.networkTimeoutMs, 900000),
      signal,
    });
    if (checkout.code !== 0) {
      attempts.push({ channel: 'git', id: 'checkout', ok: false, reason: (checkout.stderr || '').slice(-300) });
      rmrf(staging);
      return null;
    }
  }

  const npmCli = npmCliFor(nodePath);
  if (!npmCli) {
    attempts.push({ channel: 'git', id: 'npm', ok: false, reason: 'npm CLI not found for dependency install' });
    rmrf(staging);
    return null;
  }
  const registries = mirrorsOfKind(effectiveMirrors(config), 'npm');
  let depsOk = false;
  for (const mirror of registries) {
    const registry = npmRegistryUrl(mirror);
    const result = await run(nodePath, [npmCli, 'install', '--prefix', staging, '--registry', registry, '--no-audit', '--no-fund', '--loglevel=error'], {
      timeoutMs: Math.max(config.networkTimeoutMs, 1800000),
      signal,
      env: { npm_config_registry: registry, NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
    });
    if (result.code === 0) {
      depsOk = true;
      break;
    }
    attempts.push({ channel: 'git', id: `deps-${mirror.id}`, ok: false, reason: (result.stderr || '').slice(-300) });
  }
  if (!depsOk) {
    rmrf(staging);
    return null;
  }
  const build = await run(nodePath, [npmCli, 'run', 'build:cached'], {
    cwd: staging,
    timeoutMs: Math.max(config.networkTimeoutMs, 3600000),
    signal,
  });
  if (build.code !== 0) {
    attempts.push({ channel: 'git', id: 'build', ok: false, reason: (build.stderr || build.stdout || '').slice(-400) });
    rmrf(staging);
    return null;
  }
  const finalDir = dirForVersion(version);
  rmrf(finalDir);
  try {
    renameSync(staging, finalDir);
  } catch (error) {
    attempts.push({ channel: 'git', id: 'rename', ok: false, reason: String(error?.message ?? error) });
    rmrf(staging);
    return null;
  }
  attempts.push({ channel: 'git', id: tag, ok: true, ms: Date.now() - started });
  return { version, dir: finalDir, entry: path.join(finalDir, REA_SOURCE_ENTRY), channel: 'git', mirror: 'archive' };
}

/**
 * Install one version, reusing an existing directory when possible.
 *
 * @param {string} version bare version such as `6.8.0`
 * @param {{ signal?: AbortSignal, force?: boolean }} options
 */
export async function installVersion(version, options = {}) {
  const { signal, force = false } = options;
  const config = loadConfig();
  const existing = inspectRuntime(version);
  if (existing && !force) {
    const node = await ensureNodeRuntime({ signal });
    return { ...existing, nodePath: node.path, nodeVersion: node.version, reused: true, attempts: [] };
  }
  const node = await ensureNodeRuntime({ signal });
  const attempts = [];
  const order = config.source === 'git'
    ? ['git', 'npm']
    : config.source === 'npm'
      ? ['npm']
      : ['npm', 'git'];
  for (const channel of order) {
    const installed = channel === 'npm'
      ? await installFromNpm(version, { signal, nodePath: node.path, attempts })
      : await installFromGit(version, { signal, nodePath: node.path, attempts });
    if (installed) {
      const record = { ...installed, nodePath: node.path, nodeVersion: node.version, installedAt: new Date().toISOString(), attempts };
      pruneVersions(version);
      return record;
    }
  }
  const error = new Error(`no mirror could install ${NPM_PACKAGE}@${version}`);
  error.attempts = attempts;
  throw error;
}

/** Activate an installed runtime by writing the pointer file. */
export function activateRuntime(record) {
  const active = {
    version: record.version,
    dir: record.dir,
    entry: record.entry,
    channel: record.channel,
    mirror: record.mirror ?? '',
    nodePath: record.nodePath,
    nodeVersion: record.nodeVersion ?? '',
    activatedAt: new Date().toISOString(),
  };
  saveActive(active);
  log(`activated ${active.version} (${active.channel}) node=${active.nodeVersion}`);
  return active;
}

/** Deactivate and forget the current pointer (installed files stay). */
export function deactivate() {
  saveActive({});
  try {
    rmSync(path.join(versionsDir(), '..', 'active.json'), { force: true });
  } catch {
    /* ignore */
  }
  return loadActive();
}

/** Remove old runtimes beyond `keepVersions`, never touching the active one. */
export function pruneVersions(protectedVersion) {
  const config = loadConfig();
  if (!config.keepVersions) return [];
  const active = loadActive();
  const installed = listInstalled();
  const keep = new Set(installed.slice(0, config.keepVersions).map((entry) => entry.version));
  if (active?.version) keep.add(active.version);
  if (protectedVersion) keep.add(protectedVersion);
  const removed = [];
  for (const entry of installed) {
    if (keep.has(entry.version)) continue;
    rmrf(entry.dir);
    removed.push(entry.version);
  }
  if (removed.length > 0) log(`pruned ${removed.join(', ')}`);
  return removed;
}

export { dirForVersion, npmCliFor, compareVersions };
