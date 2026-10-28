/**
 * Mirror health probing.
 *
 * Each probe is the cheapest request that proves the mirror can serve real
 * bytes for the artefact we need:
 *   git  — `git ls-remote --tags` (proves transport plus repository presence);
 *   npm  — a registry metadata HEAD/GET for `rea-agents`;
 *   node — a HEAD for one known Node binary archive.
 *
 * Probes run concurrently so a chain of 40+ mirrors settles in one timeout
 * window instead of one timeout per mirror.
 */
import { effectiveMirrors, loadConfig } from './config.js';
import { expandMirror, mirrorsOfKind, npmRegistryUrl } from './mirrors.js';
import { NPM_PACKAGE, UPSTREAM_REPO } from './paths.js';
import { httpGet, log, run } from './exec.js';

/** Remember the last probe of each mirror so the management UI can show it. */
const lastProbe = new Map();

function remember(id, result) {
  lastProbe.set(id, result);
  return result;
}

/** Cached probe result for one mirror id, or undefined. */
export function lastProbeOf(id) {
  return lastProbe.get(id);
}

/** Snapshot of every cached probe result. */
export function probeCache() {
  return Object.fromEntries(lastProbe);
}

async function probeGit(mirror, timeoutMs, signal) {
  const url = expandMirror(mirror, UPSTREAM_REPO);
  const started = Date.now();
  const result = await run('git', ['-c', 'credential.interactive=never', 'ls-remote', '--tags', url], {
    timeoutMs,
    signal,
  });
  const ms = Date.now() - started;
  if (result.code !== 0) {
    const reason = (result.stderr || result.stdout || '').trim().split('\n').filter(Boolean).slice(-1)[0] ?? `exit ${result.code}`;
    return { ok: false, ms, reason: reason.slice(0, 200) };
  }
  const tags = (result.stdout.match(/refs\/tags\//gu) ?? []).length;
  return { ok: tags > 0, ms, reason: tags > 0 ? '' : 'no tags' };
}

async function probeNpm(mirror, timeoutMs, signal) {
  const url = `${npmRegistryUrl(mirror)}/${NPM_PACKAGE}`;
  const started = Date.now();
  try {
    const response = await httpGet(url, {
      timeoutMs,
      signal,
      headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    });
    const ms = Date.now() - started;
    if (!response.ok) return { ok: false, ms, reason: `HTTP ${response.status}` };
    const body = await response.json();
    const count = Object.keys(body?.versions ?? {}).length;
    return { ok: count > 0, ms, reason: count > 0 ? '' : 'no versions' };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, reason: String(error?.message ?? error).slice(0, 200) };
  }
}

async function probeNode(mirror, timeoutMs, signal) {
  const version = 'v24.22.1';
  const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const ext = platform === 'win' ? 'zip' : 'tar.gz';
  const url = `${mirror.url.replace(/\/+$/u, '')}/${version}/node-${version}-${platform}-${arch}.${ext}`;
  const started = Date.now();
  try {
    const response = await httpGet(url, { timeoutMs, signal, method: 'HEAD' });
    const ms = Date.now() - started;
    const length = response.headers.get('content-length');
    return { ok: response.ok, ms, reason: response.ok ? '' : `HTTP ${response.status}${length ? ` len=${length}` : ''}` };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, reason: String(error?.message ?? error).slice(0, 200) };
  }
}

/**
 * Probe one mirror row. Exported so the management UI can test a row before it
 * is saved (a candidate is just an ordinary row with no stored state).
 *
 * @param {object} mirror - `{ id, kind, url, template?, priority? }`
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} options
 */
export async function probeOne(mirror, options = {}) {
  const config = loadConfig();
  const timeoutMs = options.timeoutMs ?? config.probeTimeoutMs;
  const url = mirror.kind === 'git' ? expandMirror(mirror, UPSTREAM_REPO) : mirror.url;
  let outcome;
  try {
    if (mirror.kind === 'git') outcome = await probeGit(mirror, timeoutMs, options.signal);
    else if (mirror.kind === 'npm') outcome = await probeNpm(mirror, timeoutMs, options.signal);
    else outcome = await probeNode(mirror, timeoutMs, options.signal);
  } catch (error) {
    outcome = { ok: false, ms: 0, reason: String(error?.message ?? error).slice(0, 200) };
  }
  return remember(mirror.id, {
    id: mirror.id,
    kind: mirror.kind,
    url,
    priority: mirror.priority ?? 500,
    probedAt: new Date().toISOString(),
    ...outcome,
  });
}

/**
 * Probe every configured mirror of the requested kinds.
 *
 * @param {{ kind?: string, timeoutMs?: number, signal?: AbortSignal }} options
 * @returns {Promise<Array<{ id: string, kind: string, url: string, ok: boolean, ms: number, reason: string }>>}
 */
export async function probeMirrors(options = {}) {
  const config = loadConfig();
  const mirrors = effectiveMirrors(config).filter((mirror) => (options.kind ? mirror.kind === options.kind : true));
  const started = Date.now();
  const results = await Promise.all(mirrors.map((mirror) => probeOne(mirror, {
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  })));
  const healthy = results.filter((entry) => entry.ok).length;
  log(`mirror probe: ${healthy}/${results.length} reachable in ${Date.now() - started} ms`);
  return results;
}

export { mirrorsOfKind };
