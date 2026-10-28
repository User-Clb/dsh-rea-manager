/**
 * Mirror registry.
 *
 * Mainland networks frequently cannot reach github.com directly, so every
 * network operation in this plugin goes through an ordered chain of mirrors and
 * falls back to the next one on failure. The chain is data, not code: users can
 * append entries in config.json without touching the plugin.
 *
 * Three independent chains exist:
 *   - git  : repository transport (tags, clone, fetch) — full repo mirrors and
 *            GitHub accelerators that proxy `https://github.com/<owner>/<repo>`;
 *   - npm  : package tarballs and registry metadata;
 *   - node : Node.js binary distributions, used only when no local runtime
 *            satisfies REA's `engines` field.
 */
import { UPSTREAM_REPO, NPM_PACKAGE } from './paths.js';

/** GitHub accelerator templates: `{url}` receives the full upstream URL. */
const GIT_ACCELERATORS = [
  ['gh-proxy', 'https://gh-proxy.com/{url}'],
  ['ghfast', 'https://ghfast.top/{url}'],
  ['gh-proxy-hk', 'https://hk.gh-proxy.com/{url}'],
  ['gh-proxy-org', 'https://gh-proxy.org/{url}'],
  ['ghproxy-imciel', 'https://ghproxy.imciel.com/{url}'],
  ['ghproxy-icu', 'https://ghproxy.icu/{url}'],
  ['gh-llkk', 'https://gh.llkk.cc/{url}'],
  ['ghproxy-net', 'https://ghproxy.net/{url}'],
  ['ghproxy-cc', 'https://ghproxy.cc/{url}'],
  ['ghproxy-homeboyc', 'https://ghproxy.homeboyc.cn/{url}'],
  ['ghproxy-moeyy', 'https://github.moeyy.xyz/{url}'],
  ['gh-xxooo', 'https://gh.xxooo.cf/{url}'],
  ['gh-proxy-net', 'https://gh-proxy.net/{url}'],
  ['gh-proxy-top', 'https://gh-proxy.top/{url}'],
  ['gh-proxy-ru', 'https://gh-proxy.ru/{url}'],
  ['ghp-ci', 'https://ghp.ci/{url}'],
  ['ghp-li', 'https://ghp.li/{url}'],
  ['ghps-cc', 'https://ghps.cc/{url}'],
  ['ghproxy-cn', 'https://ghproxy.cn/{url}'],
  ['ghproxy-link', 'https://ghproxy.link/{url}'],
  ['gh-7cs', 'https://gh.7cs.cn/{url}'],
  ['gh-8ok', 'https://gh.8ok.cn/{url}'],
  ['gh-imbm', 'https://gh.imbm.cn/{url}'],
  ['gh-acg', 'https://gh.acg.cf/{url}'],
  ['gh-zzzw', 'https://gh.zzzw.xyz/{url}'],
  ['gh-20041027', 'https://gh.20041027.xyz/{url}'],
  ['gh-h233', 'https://gh.h233.eu.org/{url}'],
  ['gh-6yit', 'https://gh.6yit.com/{url}'],
  ['gh-proxy-llycloud', 'https://gh-proxy.llycloud.com/{url}'],
  ['gh-proxy-mba', 'https://gh-proxy.mba/{url}'],
  ['ghproxy-1888866', 'https://ghproxy.1888866.xyz/{url}'],
  ['hub-whtrys', 'https://hub.whtrys.space/{url}'],
  ['mirror-ghproxy', 'https://mirror.ghproxy.com/{url}'],
  ['gh-medy', 'https://gh.medy.xyz/{url}'],
  ['gh-fly', 'https://gh.fly.dev/{url}'],
  ['cdn-moran233', 'https://cdn.moran233.xyz/{url}'],
  ['gitmirror', 'https://gitmirror.com/{url}'],
  ['gitclone', 'https://gitclone.com/github.com/morluto/rea.git'],
  ['kkgithub', 'https://kkgithub.com/morluto/rea.git'],
  ['hub-nuaa', 'https://hub.nuaa.cf/morluto/rea.git'],
  ['4git', 'https://4git.cn/{url}'],
  ['gitdl', 'https://gitdl.cn/{url}'],
];

const NPM_REGISTRIES = [
  ['npmmirror', 'https://registry.npmmirror.com'],
  ['cnpmjs', 'https://r.cnpmjs.org'],
  ['tencent', 'https://mirrors.cloud.tencent.com/npm'],
  ['npmjs', 'https://registry.npmjs.org'],
  ['ustc', 'https://npmreg.proxy.ustclug.org'],
  ['yarnpkg', 'https://registry.yarnpkg.com'],
];

const NODE_BINARIES = [
  ['npmmirror-cdn', 'https://cdn.npmmirror.com/binaries/node'],
  ['npmmirror-binary', 'https://registry.npmmirror.com/-/binary/node'],
  ['npmmirror-mirrors', 'https://npmmirror.com/mirrors/node'],
  ['nodejs-org', 'https://nodejs.org/dist'],
  ['nodejs-cn', 'https://npmmirror.com/mirrors/node'],
];

/** Build the default ordered git mirror chain. */
export function defaultGitMirrors() {
  const mirrors = [
    {
      id: 'github',
      label: 'GitHub 直连',
      kind: 'git',
      url: UPSTREAM_REPO,
      priority: 10,
    },
    {
      id: 'gitee-mirror',
      label: 'Gitee 镜像仓库',
      kind: 'git',
      url: 'https://gitee.com/mirrors/rea.git',
      priority: 20,
    },
  ];
  GIT_ACCELERATORS.forEach(([id, template], index) => {
    mirrors.push({
      id,
      label: `GitHub 加速 ${id}`,
      kind: 'git',
      url: template.replace('{url}', UPSTREAM_REPO),
      template,
      priority: 30 + index,
    });
  });
  return mirrors;
}

export function defaultNpmMirrors() {
  return NPM_REGISTRIES.map(([id, url], index) => ({
    id,
    label: `npm 镜像 ${id}`,
    kind: 'npm',
    url,
    priority: 10 + index,
  }));
}

export function defaultNodeMirrors() {
  return NODE_BINARIES.map(([id, url], index) => ({
    id,
    label: `Node 二进制 ${id}`,
    kind: 'node',
    url,
    priority: 10 + index,
  }));
}

export function defaultMirrors() {
  return [...defaultGitMirrors(), ...defaultNpmMirrors(), ...defaultNodeMirrors()];
}

/** Merge user mirror overrides on top of the defaults, keeping order stable. */
export function mergeMirrors(overrides) {
  const base = defaultMirrors();
  if (!Array.isArray(overrides) || overrides.length === 0) return base;
  const byId = new Map(base.map((mirror) => [mirror.id, { ...mirror }]));
  for (const entry of overrides) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') continue;
    if (entry.disabled === true) {
      byId.delete(entry.id);
      continue;
    }
    const previous = byId.get(entry.id);
    const kind = entry.kind ?? previous?.kind ?? 'git';
    const url = entry.url ?? previous?.url;
    if (typeof url !== 'string' || url.length === 0) continue;
    byId.set(entry.id, {
      ...(previous ?? { priority: 500 }),
      ...entry,
      kind,
      url,
      label: entry.label ?? previous?.label ?? entry.id,
    });
  }
  return [...byId.values()].sort((left, right) => (left.priority ?? 500) - (right.priority ?? 500));
}

export function mirrorsOfKind(mirrors, kind) {
  return mirrors.filter((mirror) => mirror.kind === kind).sort((a, b) => (a.priority ?? 500) - (b.priority ?? 500));
}

/** Expand a mirror URL template for one concrete upstream URL. */
export function expandMirror(mirror, upstreamUrl) {
  if (mirror.template) return mirror.template.replace('{url}', upstreamUrl);
  if (mirror.url.includes('{url}')) return mirror.url.replace('{url}', upstreamUrl);
  return mirror.url;
}

/** Registry base for one npm mirror. */
export function npmRegistryUrl(mirror) {
  return mirror.url.replace(/\/+$/u, '');
}

/** Tarball URL for one package version on one npm mirror. */
export function npmTarballUrl(mirror, name = NPM_PACKAGE, version = '') {
  return `${npmRegistryUrl(mirror)}/${name}/-/${name}-${version}.tgz`;
}

/* ------------------------------------------------------------------ admin -- */

/** Mirror id shape: stable, filesystem-free, usable as a config key. */
export const MIRROR_ID_PATTERN = /^[A-Za-z0-9_-]{1,48}$/u;

/** Kinds a mirror row may declare. */
export const MIRROR_KINDS = ['git', 'npm', 'node'];

/**
 * Validate one mirror row supplied by a user or the model.
 *
 * @param {{ id?: string, kind?: string, url?: string, label?: string, priority?: number }} row
 * @param {{ existingIds?: Iterable<string> }} options
 * @returns {string[]} problems; empty means the row is acceptable
 */
export function validateMirrorRow(row, options = {}) {
  const problems = [];
  const id = typeof row?.id === 'string' ? row.id.trim() : '';
  if (!id) problems.push('id is required');
  else if (!MIRROR_ID_PATTERN.test(id)) problems.push('id must match [A-Za-z0-9_-]{1,48}');
  else if (options.existingIds && new Set(options.existingIds).has(id) && options.allowExisting !== true) {
    problems.push(`mirror id "${id}" already exists`);
  }
  const kind = typeof row?.kind === 'string' ? row.kind.trim() : '';
  if (!kind) problems.push('kind is required');
  else if (!MIRROR_KINDS.includes(kind)) problems.push(`kind must be one of ${MIRROR_KINDS.join(', ')}`);
  const url = typeof row?.url === 'string' ? row.url.trim() : '';
  if (!url) problems.push('url is required');
  else if (!/^https?:\/\//iu.test(url)) problems.push('url must start with http:// or https://');
  else if (kind === 'git' && url.includes('{url}') && !url.endsWith('{url}')) {
    problems.push('a git template must end with {url}');
  }
  if (row?.priority !== undefined && row.priority !== null) {
    const priority = Number(row.priority);
    if (!Number.isFinite(priority)) problems.push('priority must be a number');
  }
  return problems;
}

/**
 * Project the override list into a management view: every effective mirror with
 * its origin, plus the built-in rows the user removed (so they can be restored).
 *
 * @param {Array<object>} overrides - `config.mirrors`
 */
export function mirrorAdminView(overrides) {
  const defaults = defaultMirrors();
  const defaultIds = new Set(defaults.map((mirror) => mirror.id));
  const overrideById = new Map();
  const removed = [];
  for (const entry of Array.isArray(overrides) ? overrides : []) {
    if (!entry || typeof entry.id !== 'string') continue;
    overrideById.set(entry.id, entry);
    if (entry.disabled === true && defaultIds.has(entry.id)) removed.push(entry.id);
  }
  const mirrors = mergeMirrors(overrides).map((mirror) => ({
    id: mirror.id,
    kind: mirror.kind,
    url: mirror.url,
    label: mirror.label ?? mirror.id,
    priority: mirror.priority ?? 500,
    template: mirror.template ?? '',
    origin: defaultIds.has(mirror.id)
      ? (overrideById.has(mirror.id) ? 'modified' : 'builtin')
      : 'custom',
  }));
  return {
    mirrors,
    removed,
    defaults: defaults.map((mirror) => ({
      id: mirror.id,
      kind: mirror.kind,
      url: mirror.url,
      label: mirror.label,
      priority: mirror.priority,
    })),
    counts: {
      total: mirrors.length,
      git: mirrors.filter((mirror) => mirror.kind === 'git').length,
      npm: mirrors.filter((mirror) => mirror.kind === 'npm').length,
      node: mirrors.filter((mirror) => mirror.kind === 'node').length,
      custom: mirrors.filter((mirror) => mirror.origin === 'custom').length,
      removed: removed.length,
    },
  };
}

/** Drop every override row for one id, keeping unrelated rows untouched. */
function withoutId(overrides, id) {
  return (Array.isArray(overrides) ? overrides : []).filter((entry) => entry && entry.id !== id);
}

/**
 * Add one mirror. A built-in id that was removed is re-enabled instead of
 * duplicated, so the same id never appears twice in the override list.
 *
 * @returns {{ mirrors: Array<object> }} the new override list
 */
export function addMirror(overrides, row) {
  const next = withoutId(overrides, row.id);
  const defaults = defaultMirrors();
  const builtin = defaults.find((mirror) => mirror.id === row.id);
  next.push({
    id: row.id,
    kind: row.kind ?? builtin?.kind ?? 'git',
    url: row.url ?? builtin?.url,
    label: row.label ?? builtin?.label ?? row.id,
    priority: Number.isFinite(Number(row.priority)) ? Number(row.priority) : (builtin?.priority ?? 500),
  });
  return { mirrors: next };
}

/**
 * Remove one mirror. Built-in rows are recorded as `disabled` so a later reset
 * can restore them; custom rows are simply dropped.
 */
export function removeMirror(overrides, id) {
  const defaults = defaultMirrors();
  const builtin = defaults.find((mirror) => mirror.id === id);
  const next = withoutId(overrides, id);
  if (builtin) next.push({ id, disabled: true });
  return { mirrors: next };
}

/** Edit one mirror row in place (url / label / priority / kind). */
export function updateMirror(overrides, id, patch = {}) {
  const defaults = defaultMirrors();
  const builtin = defaults.find((mirror) => mirror.id === id);
  const current = (Array.isArray(overrides) ? overrides : []).find((entry) => entry && entry.id === id);
  const base = {
    ...(builtin ?? {}),
    ...(current && current.disabled !== true ? current : {}),
  };
  if (!builtin && (!current || current.disabled === true)) {
    throw new Error(`unknown mirror "${id}"`);
  }
  const next = withoutId(overrides, id);
  next.push({
    id,
    kind: patch.kind ?? base.kind ?? 'git',
    url: patch.url ?? base.url,
    label: patch.label ?? base.label ?? id,
    priority: Number.isFinite(Number(patch.priority ?? base.priority)) ? Number(patch.priority ?? base.priority) : 500,
  });
  return { mirrors: next };
}

/** Restore the built-in chain and drop every custom row. */
export function resetMirrors() {
  return { mirrors: [] };
}

export { NPM_PACKAGE };
