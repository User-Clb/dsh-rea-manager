/**
 * Version catalog.
 *
 * Two independent release channels feed one merged list:
 *   - git tags (`rea-agents-X.Y.Z`) from the upstream repository, reached through
 *     the mirror chain — this is the complete release history, including any
 *     version never published to npm;
 *   - npm versions of `rea-agents` — these ship a prebuilt `dist/`, so they are
 *     the preferred install source.
 *
 * The catalog is cached on disk so a model call never blocks on the network
 * when the cache is fresh.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import { gitCacheDir, UPSTREAM_REPO, NPM_PACKAGE } from './paths.js';
import { effectiveMirrors, loadConfig, loadCatalogCache, saveCatalogCache } from './config.js';
import { expandMirror, mirrorsOfKind, npmRegistryUrl } from './mirrors.js';
import { compareVersions, isVersion, sortVersionsDescending, versionFromTag } from './semver.js';
import { httpJson, log, run } from './exec.js';

const CACHE_TTL_MS = 10 * 60 * 1000;

function gitArgs(config) {
  const seconds = Math.max(5, Math.round(config.networkTimeoutMs / 1000));
  return [
    '-c', 'http.lowSpeedLimit=1000',
    '-c', `http.lowSpeedTime=${seconds}`,
    '-c', 'credential.interactive=never',
    '-c', 'advice.detachedHead=false',
  ];
}

/** List every tag through one mirror via `git ls-remote --tags`. */
async function listTagsViaMirror(mirror, config, signal) {
  const url = expandMirror(mirror, UPSTREAM_REPO);
  const result = await run('git', [...gitArgs(config), 'ls-remote', '--tags', url], {
    timeoutMs: config.probeTimeoutMs * 2,
    signal,
  });
  if (result.code !== 0) {
    const reason = (result.stderr || result.stdout || '').trim().split('\n').filter(Boolean).slice(-1)[0] ?? `exit ${result.code}`;
    return { ok: false, reason: reason.slice(0, 300), tags: [] };
  }
  const tags = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^([0-9a-f]{40})\s+refs\/tags\/(.+?)(\^\{\})?$/u.exec(line.trim());
    if (!match) continue;
    const version = versionFromTag(match[2]);
    if (!version) continue;
    tags.push({ tag: match[2], version, sha: match[1], peeled: Boolean(match[3]) });
  }
  return { ok: true, tags, url };
}

/** List every published version on one npm mirror. */
async function listNpmViaMirror(mirror, config, signal) {
  const url = `${npmRegistryUrl(mirror)}/${NPM_PACKAGE}`;
  const body = await httpJson(url, {
    timeoutMs: config.probeTimeoutMs * 2,
    signal,
    headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
  });
  const versions = Object.keys(body?.versions ?? {}).filter(isVersion);
  return {
    ok: true,
    url,
    versions: versions.map((version) => ({
      version,
      date: body?.time?.[version] ?? '',
      deprecated: Boolean(body?.versions?.[version]?.deprecated),
      tarball: body?.versions?.[version]?.dist?.tarball ?? '',
    })),
    latest: typeof body?.['dist-tags']?.latest === 'string' ? body['dist-tags'].latest : '',
  };
}

/** Walk the git mirror chain until one answers. */
async function collectGit(config, signal) {
  const mirrors = mirrorsOfKind(effectiveMirrors(config), 'git');
  const attempts = [];
  for (const mirror of mirrors) {
    const started = Date.now();
    try {
      const result = await listTagsViaMirror(mirror, config, signal);
      attempts.push({ id: mirror.id, ok: result.ok, ms: Date.now() - started, reason: result.reason ?? '' });
      if (result.ok && result.tags.length > 0) {
        return { mirror: mirror.id, url: result.url, tags: result.tags, attempts };
      }
    } catch (error) {
      attempts.push({ id: mirror.id, ok: false, ms: Date.now() - started, reason: String(error?.message ?? error).slice(0, 200) });
    }
  }
  return { mirror: null, tags: [], attempts };
}

/** Walk the npm mirror chain until one answers. */
async function collectNpm(config, signal) {
  const mirrors = mirrorsOfKind(effectiveMirrors(config), 'npm');
  const attempts = [];
  for (const mirror of mirrors) {
    const started = Date.now();
    try {
      const result = await listNpmViaMirror(mirror, config, signal);
      attempts.push({ id: mirror.id, ok: true, ms: Date.now() - started });
      if (result.versions.length > 0) {
        return { mirror: mirror.id, ...result, attempts };
      }
    } catch (error) {
      attempts.push({ id: mirror.id, ok: false, ms: Date.now() - started, reason: String(error?.message ?? error).slice(0, 200) });
    }
  }
  return { versions: [], latest: '', attempts };
}

/** Local tag dates from the partial git cache (cheap, offline). */
async function localTagDates(config) {
  const dir = gitCacheDir();
  if (!existsSync(path.join(dir, '.git'))) return {};
  const result = await run('git', ['-C', dir, 'for-each-ref', '--sort=-creatordate', '--format=%(refname:short)%09%(creatordate:iso-strict)', 'refs/tags'], {
    timeoutMs: 30000,
  });
  if (result.code !== 0) return {};
  const dates = {};
  for (const line of result.stdout.split('\n')) {
    const [tag, date] = line.split('\t');
    if (!tag || !date) continue;
    const version = versionFromTag(tag);
    if (version) dates[version] = date.trim();
  }
  return dates;
}

/**
 * Merge git tags and npm versions into one ordered catalog.
 *
 * @param {{ refresh?: boolean, signal?: AbortSignal, allowStale?: boolean }} options
 */
export async function buildCatalog(options = {}) {
  const { refresh = false, signal, allowStale = true } = options;
  const config = loadConfig();
  const cached = loadCatalogCache();
  const age = cached?.generatedAt ? Date.now() - Date.parse(cached.generatedAt) : Number.POSITIVE_INFINITY;
  if (!refresh && cached && age < CACHE_TTL_MS) return { ...cached, cached: true };

  const [git, npm] = await Promise.all([collectGit(config, signal), collectNpm(config, signal)]);
  const dates = await localTagDates(config);
  const byVersion = new Map();

  for (const tag of git.tags) {
    byVersion.set(tag.version, {
      version: tag.version,
      git: true,
      tag: tag.tag,
      sha: tag.sha,
      npm: false,
      date: dates[tag.version] ?? '',
      tarball: '',
      deprecated: false,
    });
  }
  for (const entry of npm.versions) {
    const previous = byVersion.get(entry.version) ?? { version: entry.version, git: false, tag: '', sha: '', npm: false, date: '', tarball: '', deprecated: false };
    byVersion.set(entry.version, {
      ...previous,
      npm: true,
      date: previous.date || entry.date,
      tarball: entry.tarball,
      deprecated: entry.deprecated,
    });
  }

  if (byVersion.size === 0 && cached && allowStale) {
    return { ...cached, cached: true, stale: true, attempts: { git: git.attempts, npm: npm.attempts } };
  }

  const versions = sortVersionsDescending([...byVersion.values()].map((entry) => entry.version))
    .map((version) => byVersion.get(version))
    .map((entry) => ({
      ...entry,
      sources: [entry.npm ? 'npm' : null, entry.git ? 'git' : null].filter(Boolean),
    }));

  const catalog = {
    generatedAt: new Date().toISOString(),
    package: NPM_PACKAGE,
    upstream: UPSTREAM_REPO,
    latest: versions.find((entry) => entry.npm && !entry.deprecated)?.version ?? versions[0]?.version ?? '',
    npmLatest: npm.latest,
    gitMirror: git.mirror,
    npmMirror: npm.mirror,
    versions,
    attempts: { git: git.attempts, npm: npm.attempts },
  };
  if (versions.length > 0) saveCatalogCache(catalog);
  log(`catalog: ${versions.length} versions (git mirror ${git.mirror ?? 'none'}, npm mirror ${npm.mirror ?? 'none'})`);
  return catalog;
}

/** Resolve one requested version string against a catalog. */
export function resolveVersion(catalog, requested) {
  const want = String(requested ?? '').trim();
  const newestInstallable = () => catalog.versions.find((entry) => entry.npm && !entry.deprecated)?.version
    ?? catalog.versions[0]?.version
    ?? '';
  if (want === '' || want === 'latest' || want === 'newest') {
    return newestInstallable();
  }
  if (want === 'previous') {
    const current = catalog.activeVersion;
    const ordered = sortVersionsDescending(catalog.versions.map((entry) => entry.version));
    if (!current) return ordered[0] ?? '';
    return ordered.find((version) => compareVersions(version, current) < 0) ?? '';
  }
  const bare = want.replace(/^v/u, '');
  const exact = catalog.versions.find((entry) => entry.version === bare);
  if (exact) return exact.version;
  const matching = catalog.versions.filter((entry) => entry.version.startsWith(bare));
  if (matching.length === 1) return matching[0].version;
  return '';
}

export { CACHE_TTL_MS };
