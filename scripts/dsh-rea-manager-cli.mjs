#!/usr/bin/env node
/**
 * dsh-rea-manager CLI — drive the plugin without the harness.
 *
 *   node scripts/dsh-rea-manager-cli.mjs status
 *   node scripts/dsh-rea-manager-cli.mjs versions [--refresh] [--query 6.]
 *   node scripts/dsh-rea-manager-cli.mjs install [version]
 *   node scripts/dsh-rea-manager-cli.mjs update [version]
 *   node scripts/dsh-rea-manager-cli.mjs rollback [version]
 *   node scripts/dsh-rea-manager-cli.mjs mirrors [--kind git]
 *   node scripts/dsh-rea-manager-cli.mjs call <tool> ['{"json":"args"}']
 */
import process from 'node:process';

import { loadActive, loadConfig } from '../lib/config.js';
import { buildCatalog, resolveVersion } from '../lib/catalog.js';
import { activateRuntime, deactivate, installVersion, listInstalled, inspectRuntime } from '../lib/install.js';
import { ensureNodeRuntime } from '../lib/node-runtime.js';
import { probeMirrors } from '../lib/health.js';
import { closeSession, flattenResult, getSession, sessionState } from '../lib/mcp-client.js';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'status';

function flags(list) {
  const result = { _: [] };
  for (let index = 0; index < list.length; index += 1) {
    const token = list[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = list[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        result[key] = next;
        index += 1;
      } else {
        result[key] = true;
      }
    } else {
      result._.push(token);
    }
  }
  return result;
}

const options = flags(argv.slice(1));

async function resolveRuntime() {
  const active = loadActive();
  if (!active?.entry) return null;
  const inspected = inspectRuntime(active.version);
  if (!inspected) return null;
  const node = await ensureNodeRuntime();
  return { ...inspected, nodePath: node.path, nodeVersion: node.version };
}

async function main() {
  switch (command) {
    case 'status': {
      const active = loadActive();
      const installed = listInstalled();
      const node = await ensureNodeRuntime();
      const config = loadConfig();
      console.log(`store        ${config ? '' : ''}${active?.dir ? active.dir.replace(/versions.*/u, '') : ''}`);
      console.log(`active       ${active?.version ?? 'none'}${active?.channel ? ` (${active.channel})` : ''}`);
      console.log(`installed    ${installed.map((entry) => `${entry.version}[${entry.channel}]`).join(', ') || 'none'}`);
      console.log(`node         ${node.version} ${node.satisfies === true ? '(ok)' : '(outside REA engines)'} ${node.path}`);
      console.log(`source       ${config.source}  keep=${config.keepVersions}`);
      const runtime = await resolveRuntime();
      if (runtime) {
        try {
          await getSession(runtime);
          const session = sessionState();
          console.log(`mcp          running, ${session.tools} tools, server ${session.serverInfo?.name ?? '?'} ${session.serverInfo?.version ?? '?'}`);
          await closeSession();
        } catch (error) {
          console.log(`mcp          failed: ${String(error?.message ?? error)}`);
        }
      } else {
        console.log('mcp          not available (no active runtime)');
      }
      return;
    }
    case 'versions': {
      const catalog = await buildCatalog({ refresh: options.refresh === true });
      const active = loadActive();
      const installed = new Set(listInstalled().map((entry) => entry.version));
      const query = typeof options.query === 'string' ? options.query.toLowerCase() : '';
      const rows = catalog.versions.filter((entry) => (query ? entry.version.toLowerCase().includes(query) : true));
      console.log(`# ${rows.length} releases (npm mirror ${catalog.npmMirror ?? 'none'}, git mirror ${catalog.gitMirror ?? 'none'})`);
      for (const [index, entry] of rows.entries()) {
        const marks = [];
        if (entry.version === active?.version) marks.push('ACTIVE');
        if (installed.has(entry.version)) marks.push('installed');
        if (entry.deprecated) marks.push('deprecated');
        console.log(`${String(index + 1).padStart(4, ' ')}. ${entry.version.padEnd(10, ' ')} ${(entry.date || '').slice(0, 10).padEnd(10, ' ')} ${(entry.sources ?? []).join('+').padEnd(8, ' ')} ${marks.join(' ')}`);
      }
      return;
    }
    case 'install':
    case 'update': {
      const catalog = await buildCatalog({ refresh: true });
      catalog.activeVersion = loadActive()?.version;
      const requested = options._[0] ?? 'latest';
      const version = resolveVersion(catalog, requested);
      if (!version) throw new Error(`unknown version ${requested}`);
      await closeSession();
      const record = await installVersion(version, { force: options.force === true });
      const node = await ensureNodeRuntime();
      activateRuntime({ ...record, nodePath: node.path, nodeVersion: node.version });
      console.log(`installed ${version} via ${record.channel}${record.mirror ? ` (${record.mirror})` : ''}${record.reused ? ' [reused]' : ''}`);
      console.log(`node ${node.version}`);
      if (Array.isArray(record.attempts) && record.attempts.length > 0) {
        for (const attempt of record.attempts) {
          console.log(`  attempt ${attempt.channel}/${attempt.id}: ${attempt.ok ? 'ok' : 'fail'} ${attempt.ms ?? ''}ms ${attempt.reason ?? ''}`);
        }
      }
      return;
    }
    case 'rollback': {
      const active = loadActive();
      const requested = options._[0];
      let version = requested;
      if (!version) {
        const candidates = listInstalled().map((entry) => entry.version).filter((entry) => entry !== active?.version);
        if (candidates.length === 0) throw new Error('nothing to roll back to; pass a version');
        version = candidates.sort((left, right) => (left < right ? 1 : -1))[0];
      }
      let record = inspectRuntime(version);
      if (!record) {
        const catalog = await buildCatalog({});
        catalog.activeVersion = active?.version;
        const resolved = resolveVersion(catalog, version);
        if (!resolved) throw new Error(`unknown version ${version}`);
        record = await installVersion(resolved, {});
        version = resolved;
      }
      await closeSession();
      const node = await ensureNodeRuntime();
      activateRuntime({ ...record, nodePath: node.path, nodeVersion: node.version });
      console.log(`rolled back ${active?.version ?? 'none'} -> ${version} (${record.channel})`);
      return;
    }
    case 'activate': {
      const version = options._[0];
      const record = inspectRuntime(version);
      if (!record) throw new Error(`REA ${version} is not installed`);
      await closeSession();
      const node = await ensureNodeRuntime();
      activateRuntime({ ...record, nodePath: node.path, nodeVersion: node.version });
      console.log(`activated ${version}`);
      return;
    }
    case 'deactivate':
      deactivate();
      console.log('deactivated');
      return;
    case 'mirrors': {
      const results = await probeMirrors({ kind: typeof options.kind === 'string' ? options.kind : undefined });
      for (const entry of results.sort((left, right) => Number(right.ok) - Number(left.ok) || left.ms - right.ms)) {
        console.log(`${entry.ok ? 'OK  ' : 'FAIL'} ${String(entry.ms).padStart(6, ' ')}ms ${entry.kind.padEnd(5, ' ')} ${entry.id.padEnd(20, ' ')} ${entry.reason ?? ''}`);
      }
      console.log(`# ${results.filter((entry) => entry.ok).length}/${results.length} reachable`);
      return;
    }
    case 'tools': {
      const runtime = await resolveRuntime();
      if (!runtime) throw new Error('no active runtime');
      const session = await getSession(runtime);
      const query = typeof options.query === 'string' ? options.query.toLowerCase() : '';
      const matched = session.listTools().filter((tool) => (query
        ? tool.name.toLowerCase().includes(query) || String(tool.description ?? '').toLowerCase().includes(query)
        : true));
      for (const tool of matched) console.log(`${tool.name}\t${String(tool.description ?? '').split('\n')[0].slice(0, 120)}`);
      console.log(`# ${matched.length}/${session.listTools().length}`);
      await closeSession();
      return;
    }
    case 'call': {
      const tool = options._[0];
      if (!tool) throw new Error('usage: call <tool> [json-args]');
      const rawArgs = options._[1] ?? '{}';
      const args = JSON.parse(rawArgs);
      const runtime = await resolveRuntime();
      if (!runtime) throw new Error('no active runtime');
      const session = await getSession(runtime);
      const result = flattenResult(await session.callTool(tool, args));
      console.log(result.text);
      if (result.structured) console.log(JSON.stringify(result.structured, null, 2).slice(0, 40000));
      await closeSession();
      return;
    }
    default:
      console.log('commands: status | versions | install | update | rollback | activate | deactivate | mirrors | tools | call');
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`dsh-rea-manager: ${String(error?.message ?? error)}`);
  if (Array.isArray(error?.attempts)) {
    for (const attempt of error.attempts) {
      console.error(`  ${attempt.channel}/${attempt.id}: ${attempt.ok ? 'ok' : 'fail'} ${attempt.reason ?? ''}`);
    }
  }
  process.exitCode = 1;
});
