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

export { NPM_PACKAGE };
