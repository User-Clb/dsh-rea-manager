/**
 * Node runtime selection.
 *
 * REA declares `engines: ^22.23.4 || ^24.22.1 || >=26.12.1`. The harness ships
 * its own Node under `~/.dsh/dsh-runtimes/...`, and a machine may have several
 * others on PATH, so the plugin resolves a concrete binary once and records it:
 *
 *   1. `config.nodePath` when the user pinned one;
 *   2. the Node bundled with the DSH runtime (stable across harness updates);
 *   3. `process.execPath` and every `node` on PATH;
 *   4. a downloaded official build, unpacked under `<store>/node/<version>/`.
 *
 * A candidate is accepted when it satisfies REA's range; otherwise the newest
 * available candidate is used with a recorded warning, because REA still runs on
 * slightly older releases and failing hard would block the whole plugin.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { dshHome, storePath } from './paths.js';
import { effectiveMirrors, loadConfig, saveConfig } from './config.js';
import { mirrorsOfKind } from './mirrors.js';
import { compareVersions, nodeSatisfiesRea, parseVersion } from './semver.js';
import { httpBuffer, log, run } from './exec.js';

const NODE_DIR = () => storePath('node');

/** Ask one binary for its version; `null` when it is not a usable Node. */
async function probeNode(binary) {
  if (!binary || !existsSync(binary)) return null;
  const result = await run(binary, ['-e', 'process.stdout.write(process.versions.node)'], { timeoutMs: 15000 });
  if (result.code !== 0) return null;
  const version = result.stdout.trim();
  return parseVersion(version) ? { path: binary, version } : null;
}

/** Candidate binaries, best-known first. */
function candidateBinaries() {
  const list = [];
  const config = loadConfig();
  if (config.nodePath) list.push(config.nodePath);
  const runtimeRoot = path.join(dshHome(), 'dsh-runtimes');
  try {
    if (existsSync(runtimeRoot)) {
      for (const runtime of readdirSync(runtimeRoot)) {
        for (const rel of [
          path.join('dependencies', 'node', 'bin', 'node.exe'),
          path.join('dependencies', 'node', 'bin', 'node'),
          path.join('dependencies', 'node', 'node.exe'),
        ]) {
          list.push(path.join(runtimeRoot, runtime, rel));
        }
      }
    }
  } catch {
    /* ignore */
  }
  list.push(process.execPath);
  const pathEntries = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter);
  for (const entry of pathEntries) {
    if (!entry) continue;
    list.push(path.join(entry, process.platform === 'win32' ? 'node.exe' : 'node'));
  }
  try {
    if (existsSync(NODE_DIR())) {
      for (const version of readdirSync(NODE_DIR())) {
        list.push(path.join(NODE_DIR(), version, process.platform === 'win32' ? 'node.exe' : 'bin/node'));
      }
    }
  } catch {
    /* ignore */
  }
  return [...new Set(list.filter(Boolean))];
}

/** Download and unpack one official Node build from a binary mirror. */
async function downloadNode(version, signal) {
  const config = loadConfig();
  const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'x86' : 'x64';
  const file = `node-v${version}-${platform}-${arch}.${platform === 'win' ? 'zip' : 'tar.gz'}`;
  const mirrors = mirrorsOfKind(effectiveMirrors(config), 'node');
  for (const mirror of mirrors) {
    const url = `${mirror.url.replace(/\/+$/u, '')}/v${version}/${file}`;
    const started = Date.now();
    try {
      const buffer = await httpBuffer(url, { timeoutMs: Math.max(config.networkTimeoutMs, 300000), maxBytes: 200 * 1024 * 1024, signal });
      const target = path.join(NODE_DIR(), version);
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      const archive = path.join(NODE_DIR(), file);
      writeFileSync(archive, buffer);
      const extract = await run('tar', ['-xf', archive, '-C', target, '--strip-components=1'], { timeoutMs: 300000 });
      if (extract.code !== 0) {
        const ps = await run('powershell.exe', [
          '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
          `Expand-Archive -LiteralPath '${archive.replace(/'/gu, "''")}' -DestinationPath '${target.replace(/'/gu, "''")}' -Force`,
        ], { timeoutMs: 300000 });
        if (ps.code !== 0) throw new Error((extract.stderr || ps.stderr || 'extract failed').slice(-200));
        // Expand-Archive keeps the top-level folder: flatten it.
        const inner = readdirSync(target).map((name) => path.join(target, name)).find((entry) => {
          try {
            return existsSync(path.join(entry, process.platform === 'win32' ? 'node.exe' : 'bin'));
          } catch {
            return false;
          }
        });
        if (inner) {
          for (const name of readdirSync(inner)) {
            const from = path.join(inner, name);
            const to = path.join(target, name);
            if (from === to) continue;
            try {
              renameSync(from, to);
            } catch {
              /* ignore */
            }
          }
          try {
            rmSync(inner, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        }
      }
      try {
        rmSync(archive, { force: true });
      } catch {
        /* ignore */
      }
      const binary = process.platform === 'win32' ? path.join(target, 'node.exe') : path.join(target, 'bin', 'node');
      const probed = await probeNode(binary);
      if (probed) {
        log(`node ${version} installed from ${mirror.id} in ${Date.now() - started} ms`);
        return probed;
      }
    } catch (error) {
      log(`node ${version} via ${mirror.id} failed: ${String(error?.message ?? error).slice(0, 200)}`);
    }
  }
  return null;
}

/** Resolve the Node binary for REA, installing one when nothing fits. */
export async function ensureNodeRuntime(options = {}) {
  const { signal, refresh = false } = options;
  const cacheKey = 'nodeRuntime';
  if (!refresh && globalThis[cacheKey]) return globalThis[cacheKey];

  const probed = [];
  for (const binary of candidateBinaries()) {
    const result = await probeNode(binary);
    if (result) probed.push(result);
  }
  const satisfying = probed
    .filter((entry) => nodeSatisfiesRea(entry.version))
    .sort((left, right) => compareVersions(right.version, left.version));
  if (satisfying.length > 0) {
    const chosen = { ...satisfying[0], satisfies: true };
    globalThis[cacheKey] = chosen;
    return chosen;
  }
  const newest = probed.sort((left, right) => compareVersions(right.version, left.version))[0];

  // No local Node satisfies REA's range: fetch an official build from a binary
  // mirror so the child process runs inside the declared engines window.
  if (loadConfig().autoDownloadNode !== false) {
    for (const version of ['24.22.1', '22.23.4', '26.12.1']) {
      const downloaded = await downloadNode(version, signal);
      if (downloaded) {
        const chosen = { ...downloaded, satisfies: nodeSatisfiesRea(downloaded.version) };
        globalThis[cacheKey] = chosen;
        return chosen;
      }
    }
  }
  if (newest) {
    const chosen = { ...newest, satisfies: false, warning: `node ${newest.version} is outside REA engines (^22.23.4 || ^24.22.1 || >=26.12.1)` };
    globalThis[cacheKey] = chosen;
    log(`node fallback: ${chosen.warning}`);
    return chosen;
  }
  throw new Error('no usable Node runtime: pin one with rea_config {"nodePath":"..."}');
}

/** Persist an explicit Node choice. */
export function pinNode(binary) {
  saveConfig({ nodePath: binary });
  globalThis.nodeRuntime = undefined;
  return loadConfig().nodePath;
}

export { probeNode, NODE_DIR, os };
