/**
 * DSH tool registrations for the REA plugin.
 *
 * The model-facing surface is deliberately small and task-shaped: one tool per
 * user intent (install, update, roll back, browse versions, inspect state,
 * discover REA tools, call a REA tool, probe mirrors, edit config). REA's own
 * 229 tools are reachable through `rea_call`, so the tool budget stays flat no
 * matter how many tools upstream ships.
 */
import path from 'node:path';

import {
  loadActive,
  loadConfig,
  resetConfig,
  saveConfig,
  effectiveMirrors,
  loadHealth,
  saveHealth,
} from './config.js';
import { buildCatalog, resolveVersion } from './catalog.js';
import { activateRuntime, deactivate, installVersion, listInstalled, inspectRuntime, pruneVersions } from './install.js';
import { ensureNodeRuntime } from './node-runtime.js';
import { closeSession, flattenResult, getSession, sessionState } from './mcp-client.js';
import { probeMirrors } from './health.js';
import { log } from './exec.js';

const SOURCE_CHOICES = ['auto', 'npm', 'git'];

function text(value) {
  return { type: 'text', text: String(value ?? '') };
}

/** Build the tool-call presentation for one REA tool invocation. */
function presentCall(args) {
  return {
    card: 'generic',
    title: args?.tool ? `REA · ${String(args.tool)}` : 'REA',
    input: args ?? {},
  };
}

/** Shared output shape: a short summary plus the structured payload. */
function output(summary, payloadKey, schema) {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', payloadKey],
      properties: {
        summary: { type: 'string' },
        [payloadKey]: schema,
      },
    },
    render: (_args, value) => [text(value.summary)],
    presentationMeta: (_args, value) => ({ summary: value.summary }),
  };
}

const STRING = { type: 'string' };
const BOOLEAN = { type: 'boolean' };
const INTEGER = { type: 'integer' };
const STRING_ARRAY = { type: 'array', items: { type: 'string' } };
const ANY = {};

/** Resolve the active runtime, installing the pinned/latest version on demand. */
async function requireRuntime(signal) {
  const active = loadActive();
  if (active?.entry) {
    const inspected = inspectRuntime(active.version);
    if (inspected) {
      const node = await ensureNodeRuntime({ signal });
      return { ...inspected, nodePath: node.path, nodeVersion: node.version, active: true };
    }
  }
  return null;
}

function formatVersionRow(entry, activeVersion, installedSet, index) {
  const marks = [];
  if (entry.version === activeVersion) marks.push('当前');
  if (installedSet.has(entry.version)) marks.push('已安装');
  if (entry.deprecated) marks.push('已弃用');
  if (entry.sources?.length) marks.push(entry.sources.join('+'));
  return `${String(index + 1).padStart(3, ' ')}. ${entry.version.padEnd(10, ' ')} ${entry.date ? entry.date.slice(0, 10) : '   unknown  '} ${marks.join(' ')}`;
}

export function registerTools(ctx) {
  const disposers = [];

  /* ---------------------------------------------------------------- status */
  disposers.push(ctx.tools.register({
    name: 'rea_status',
    description: 'Report the REA plugin state: active version, installed versions, Node runtime, MCP session health and configured mirrors.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        probe: { ...BOOLEAN, description: 'Also start (or reuse) the MCP server and report its tool count. Default true.' },
      },
    },
    output: output('REA status', 'status', {
      type: 'object',
      additionalProperties: true,
      properties: {},
    }),
    timeoutMs: 120000,
    async execute(args, exec) {
      const config = loadConfig();
      const active = loadActive();
      const installed = listInstalled();
      const node = await ensureNodeRuntime({ signal: exec?.signal });
      let session = sessionState();
      if (args?.probe !== false && active?.entry) {
        try {
          const runtime = await requireRuntime(exec?.signal);
          if (runtime) {
            await getSession(runtime);
            session = sessionState();
          }
        } catch (error) {
          session = { ...session, error: String(error?.message ?? error) };
        }
      }
      const status = {
        active: active?.version ? active : null,
        installed: installed.map((entry) => ({ version: entry.version, channel: entry.channel, installedAt: entry.installedAt })),
        node: { path: node.path, version: node.version, satisfiesReaEngines: node.satisfies === true, warning: node.warning ?? '' },
        session,
        source: config.source,
        pinnedVersion: config.pinnedVersion,
        keepVersions: config.keepVersions,
        store: path.dirname(installed[0]?.dir ?? path.join('', 'versions')),
        mirrors: effectiveMirrors(config).map((mirror) => ({ id: mirror.id, kind: mirror.kind, url: mirror.url, priority: mirror.priority })),
      };
      const summary = [
        `active: ${active?.version ?? 'none'}${active?.channel ? ` (${active.channel})` : ''}`,
        `installed: ${installed.length > 0 ? installed.map((entry) => entry.version).join(', ') : 'none'}`,
        `node: ${node.version}${node.satisfies === true ? '' : ' (outside REA engines)'}`,
        `mcp: ${session.running ? `${session.tools} tools` : 'stopped'}${session.error ? ` — ${session.error}` : ''}`,
      ].join('\n');
      return { summary, status };
    },
  }));

  /* --------------------------------------------------------------- versions */
  disposers.push(ctx.tools.register({
    name: 'rea_versions',
    description: 'List every known REA release (git tags merged with npm versions), newest first, marking the active and installed ones. Use this to pick a version for rea_install or rea_rollback.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        refresh: { ...BOOLEAN, description: 'Ignore the 10-minute cache and re-query all mirrors.' },
        query: { ...STRING, description: 'Optional version substring filter, e.g. "6." or "5".' },
        limit: { ...INTEGER, description: 'Maximum rows to return (default 200).' },
      },
    },
    output: output('REA versions', 'versions', {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['version'],
        properties: {
          version: { type: 'string' },
          date: { type: 'string' },
          sources: STRING_ARRAY,
          installed: { type: 'boolean' },
          active: { type: 'boolean' },
          deprecated: { type: 'boolean' },
        },
      },
    }),
    timeoutMs: 240000,
    async execute(args, exec) {
      const catalog = await buildCatalog({ refresh: args?.refresh === true, signal: exec?.signal });
      const active = loadActive();
      const installedSet = new Set(listInstalled().map((entry) => entry.version));
      const query = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : '';
      const limit = Number.isInteger(args?.limit) && args.limit > 0 ? args.limit : 200;
      const rows = catalog.versions
        .filter((entry) => (query ? entry.version.toLowerCase().includes(query) : true))
        .slice(0, limit)
        .map((entry) => ({
          version: entry.version,
          date: entry.date ?? '',
          sources: entry.sources ?? [],
          installed: installedSet.has(entry.version),
          active: entry.version === active?.version,
          deprecated: entry.deprecated === true,
        }));
      const header = `REA releases: ${catalog.versions.length} known (${catalog.npmMirror ?? 'no npm mirror'} / ${catalog.gitMirror ?? 'no git mirror'}); showing ${rows.length}`;
      const body = rows.map((row, index) => formatVersionRow({ ...row, sources: row.sources }, active?.version, installedSet, index)).join('\n');
      return {
        summary: `${header}\n${body}\n\nInstall with rea_install {"version":"<x.y.z>"}, roll back with rea_rollback {"version":"<x.y.z>"}.`,
        versions: rows,
      };
    },
  }));

  /* ---------------------------------------------------------------- install */
  disposers.push(ctx.tools.register({
    name: 'rea_install',
    description: 'Install one REA version from the mirror chain and activate it. Accepts "latest", a bare version like "6.8.0", or a unique prefix. npm tarballs are preferred because they ship a prebuilt dist; git source builds are the fallback.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        version: { ...STRING, description: 'Version to install: "latest", "6.8.0", or a unique prefix. Defaults to the configured pinned version or latest.' },
        force: { ...BOOLEAN, description: 'Reinstall even when the version is already present.' },
        refresh: { ...BOOLEAN, description: 'Refresh the version catalog before resolving.' },
      },
    },
    output: output('REA install', 'result', {
      type: 'object',
      additionalProperties: true,
      properties: {},
    }),
    timeoutMs: 3600000,
    async execute(args, exec) {
      const config = loadConfig();
      const catalog = await buildCatalog({ refresh: args?.refresh === true, signal: exec?.signal });
      catalog.activeVersion = loadActive()?.version;
      const requested = String(args?.version ?? config.pinnedVersion ?? 'latest');
      const version = resolveVersion(catalog, requested);
      if (!version) throw new Error(`unknown REA version "${requested}" — call rea_versions for the full list`);
      await closeSession();
      const record = await installVersion(version, { signal: exec?.signal, force: args?.force === true });
      const active = activateRuntime(record);
      const runtime = await requireRuntime(exec?.signal);
      let session = { running: false, tools: 0 };
      try {
        await getSession(runtime);
        session = sessionState();
      } catch (error) {
        session = { running: false, tools: 0, error: String(error?.message ?? error) };
      }
      const result = {
        version,
        channel: record.channel,
        mirror: record.mirror ?? '',
        reused: record.reused === true,
        node: { path: record.nodePath, version: record.nodeVersion },
        active,
        mcp: session,
        attempts: record.attempts ?? [],
      };
      const summary = [
        `installed REA ${version} via ${record.channel}${record.mirror ? ` (${record.mirror})` : ''}${record.reused ? ' [reused]' : ''}`,
        `node: ${record.nodeVersion} (${record.nodePath})`,
        `mcp: ${session.running ? `${session.tools} tools ready` : `not running${session.error ? ` — ${session.error}` : ''}`}`,
      ].join('\n');
      return { summary, result };
    },
  }));

  /* ----------------------------------------------------------------- update */
  disposers.push(ctx.tools.register({
    name: 'rea_update',
    description: 'Update REA to the newest published release (or to a specific version) using the mirror chain, keeping the previous version installed so rea_rollback can return to it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        version: { ...STRING, description: 'Target version; omit for the newest release.' },
        dryRun: { ...BOOLEAN, description: 'Only report what would change.' },
      },
    },
    output: output('REA update', 'result', {
      type: 'object',
      additionalProperties: true,
      properties: {},
    }),
    timeoutMs: 3600000,
    async execute(args, exec) {
      const catalog = await buildCatalog({ refresh: true, signal: exec?.signal });
      const active = loadActive();
      catalog.activeVersion = active?.version;
      const target = resolveVersion(catalog, String(args?.version ?? 'latest'));
      if (!target) throw new Error('no installable release found on any mirror');
      const current = active?.version ?? '';
      const plan = {
        current: current || 'none',
        target,
        changed: current !== target,
        dryRun: args?.dryRun === true,
      };
      if (args?.dryRun === true) {
        return {
          summary: plan.changed
            ? `would update ${plan.current} → ${plan.target}`
            : `already on the newest release (${plan.current || 'none'})`,
          result: plan,
        };
      }
      if (!plan.changed && active?.entry) {
        return { summary: `already on ${target}; nothing to do`, result: { ...plan, installed: false } };
      }
      await closeSession();
      const record = await installVersion(target, { signal: exec?.signal, force: false });
      activateRuntime(record);
      const runtime = await requireRuntime(exec?.signal);
      let session = { running: false, tools: 0 };
      try {
        await getSession(runtime);
        session = sessionState();
      } catch (error) {
        session = { running: false, tools: 0, error: String(error?.message ?? error) };
      }
      return {
        summary: `updated ${plan.current || 'none'} → ${target} (${record.channel}); mcp ${session.running ? `${session.tools} tools` : 'not running'}`,
        result: { ...plan, channel: record.channel, mirror: record.mirror ?? '', mcp: session, attempts: record.attempts ?? [] },
      };
    },
  }));

  /* --------------------------------------------------------------- rollback */
  disposers.push(ctx.tools.register({
    name: 'rea_rollback',
    description: 'Roll REA back to a specific historical version, or to the newest version older than the active one. The target must already be installed or installable from the mirrors.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        version: { ...STRING, description: 'Exact version (or unique prefix) to return to. Omit for "one step back".' },
        install: { ...BOOLEAN, description: 'Install the target when it is not present locally. Default true.' },
      },
    },
    output: output('REA rollback', 'result', {
      type: 'object',
      additionalProperties: true,
      properties: {},
    }),
    timeoutMs: 3600000,
    async execute(args, exec) {
      const active = loadActive();
      const current = active?.version ?? '';
      let target = '';
      let record = null;
      if (typeof args?.version === 'string' && args.version.trim() !== '') {
        const catalog = await buildCatalog({ signal: exec?.signal });
        catalog.activeVersion = current;
        target = resolveVersion(catalog, args.version);
        if (!target) throw new Error(`unknown REA version "${args.version}" — call rea_versions for the full list`);
      } else {
        const installed = listInstalled().map((entry) => entry.version);
        const candidates = installed.filter((version) => version !== current);
        if (candidates.length === 0) throw new Error('no other installed version to roll back to; pass an explicit version');
        target = candidates.sort((left, right) => (left < right ? 1 : -1))[0];
      }
      record = inspectRuntime(target);
      if (!record) {
        if (args?.install === false) throw new Error(`REA ${target} is not installed locally`);
        const catalog = await buildCatalog({ signal: exec?.signal });
        catalog.activeVersion = current;
        record = await installVersion(resolveVersion(catalog, target) || target, { signal: exec?.signal });
      }
      await closeSession();
      const node = await ensureNodeRuntime({ signal: exec?.signal });
      const activated = activateRuntime({ ...record, nodePath: node.path, nodeVersion: node.version });
      const runtime = await requireRuntime(exec?.signal);
      let session = { running: false, tools: 0 };
      try {
        await getSession(runtime);
        session = sessionState();
      } catch (error) {
        session = { running: false, tools: 0, error: String(error?.message ?? error) };
      }
      return {
        summary: `rolled back ${current || 'none'} → ${target} (${record.channel}); mcp ${session.running ? `${session.tools} tools` : 'not running'}`,
        result: { from: current || null, to: target, channel: record.channel, active: activated, mcp: session },
      };
    },
  }));

  /* ------------------------------------------------------------------ tools */
  disposers.push(ctx.tools.register({
    name: 'rea_tools',
    description: 'Search or list the REA tool catalog exposed by the running MCP server (229 tools for 6.8.0). Returns names with one-line descriptions; call rea_tool_schema for a full input schema.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { ...STRING, description: 'Substring matched against tool names and descriptions, e.g. "frida", "apk", "ghidra".' },
        limit: { ...INTEGER, description: 'Maximum tools to return (default 40, max 229).' },
        offset: { ...INTEGER, description: 'Skip this many matches (paging).' },
      },
    },
    output: output('REA tools', 'tools', {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
        },
      },
    }),
    timeoutMs: 180000,
    async execute(args, exec) {
      const runtime = await requireRuntime(exec?.signal);
      if (!runtime) throw new Error('no REA runtime installed: run rea_install first');
      const session = await getSession(runtime);
      const all = session.listTools();
      const query = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : '';
      const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 500) : 40;
      const offset = Number.isInteger(args?.offset) && args.offset > 0 ? args.offset : 0;
      const matched = all
        .filter((tool) => (query
          ? tool.name.toLowerCase().includes(query) || String(tool.description ?? '').toLowerCase().includes(query)
          : true))
        .map((tool) => ({ name: tool.name, description: String(tool.description ?? '').split('\n')[0].slice(0, 200) }));
      const page = matched.slice(offset, offset + limit);
      const summary = [
        `REA ${loadActive()?.version ?? ''} — ${all.length} tools, ${matched.length} match${query ? ` for "${query}"` : ''}`,
        ...page.map((tool) => `- ${tool.name}: ${tool.description}`),
        matched.length > offset + limit ? `(${matched.length - offset - limit} more — raise limit or use offset)` : '',
      ].filter(Boolean).join('\n');
      return { summary, tools: page };
    },
  }));

  disposers.push(ctx.tools.register({
    name: 'rea_tool_schema',
    description: 'Return the full input schema of one REA tool so its arguments can be constructed precisely before calling rea_call.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['tool'],
      properties: {
        tool: { ...STRING, description: 'Exact REA tool name, e.g. "inspect_android_package".' },
      },
    },
    output: output('REA tool schema', 'schema', {
      type: 'object',
      additionalProperties: true,
      properties: {},
    }),
    timeoutMs: 180000,
    async execute(args, exec) {
      const runtime = await requireRuntime(exec?.signal);
      if (!runtime) throw new Error('no REA runtime installed: run rea_install first');
      const session = await getSession(runtime);
      const name = String(args?.tool ?? '').trim();
      const tool = session.listTools().find((entry) => entry.name === name);
      if (!tool) throw new Error(`unknown REA tool "${name}" — call rea_tools to search the catalog`);
      const schema = {
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema ?? {},
        outputSchema: tool.outputSchema ?? null,
      };
      return {
        summary: `schema for ${tool.name}\n${JSON.stringify(schema.inputSchema, null, 2)}`,
        schema,
      };
    },
  }));

  /* ------------------------------------------------------------------- call */
  disposers.push(ctx.tools.register({
    name: 'rea_call',
    description: 'Invoke one REA (Reverse Engineer Anything) tool. This is the single entry point for binary/APK/Electron/JS/firmware analysis, decompilation, Frida instrumentation, ADB work and evidence comparison. Pass the exact tool name and its JSON arguments.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['tool'],
      properties: {
        tool: { ...STRING, description: 'Exact REA tool name from rea_tools.' },
        args: { ...ANY, description: 'JSON arguments object matching the tool input schema.' },
        timeoutMs: { ...INTEGER, description: 'Override the per-call timeout (default from config).' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'result'],
        properties: {
          summary: { type: 'string' },
          result: {
            type: 'object',
            additionalProperties: true,
            properties: {},
          },
          images: {
            type: 'array',
            items: { type: 'object', additionalProperties: true, properties: {} },
          },
        },
      },
      render: (_args, value) => {
        const blocks = [text(value.summary)];
        for (const image of value.images ?? []) {
          if (image && typeof image === 'object') blocks.push({ type: 'image', attachment: image });
        }
        return blocks;
      },
      presentationMeta: (_args, value) => ({
        tool: value.result?.tool ?? '',
        ms: value.result?.ms ?? 0,
        isError: value.result?.isError === true,
      }),
    },
    timeoutMs: 3600000,
    presentCall,
    async execute(args, exec) {
      const runtime = await requireRuntime(exec?.signal);
      if (!runtime) throw new Error('no REA runtime installed: run rea_install first');
      const session = await getSession(runtime);
      const name = String(args?.tool ?? '').trim();
      if (!name) throw new Error('tool is required');
      const callArgs = args?.args && typeof args.args === 'object' ? args.args : {};
      const started = Date.now();
      const raw = await session.callTool(name, callArgs, {
        timeoutMs: Number.isInteger(args?.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : undefined,
        signal: exec?.signal,
      });
      const flat = flattenResult(raw);
      const images = [];
      if (flat.images.length > 0 && ctx.attachments?.saveImage) {
        for (const [index, image] of flat.images.entries()) {
          try {
            images.push(await ctx.attachments.saveImage({
              data: Buffer.from(image.bytes, 'base64'),
              mediaType: image.mimeType,
              name: `rea-${name}-${index + 1}.png`,
            }));
          } catch (error) {
            log(`saveImage failed: ${String(error?.message ?? error)}`);
          }
        }
      }
      const result = {
        tool: name,
        ms: Date.now() - started,
        isError: flat.isError,
        text: flat.text.slice(0, 400000),
        structured: flat.structured,
        imageCount: images.length,
      };
      return {
        summary: `REA ${name} — ${flat.isError ? 'error' : 'ok'} in ${result.ms} ms${images.length ? `, ${images.length} image(s)` : ''}\n\n${result.text.slice(0, 60000)}`,
        result,
        images,
      };
    },
  }));

  /* ---------------------------------------------------------------- mirrors */
  disposers.push(ctx.tools.register({
    name: 'rea_mirrors',
    description: 'Probe every configured git / npm / node mirror and report latency and reachability, ordered so the fastest working mirrors can be promoted. Writes the result to mirrors-health.json.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { ...STRING, description: 'Limit the probe to one kind: git, npm or node.' },
        timeoutMs: { ...INTEGER, description: 'Per-mirror probe budget in ms (default 12000).' },
      },
    },
    output: output('REA mirrors', 'mirrors', {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind', 'url', 'ok', 'ms'],
        properties: {
          id: { type: 'string' },
          kind: { type: 'string' },
          url: { type: 'string' },
          priority: { type: 'number' },
          ok: { type: 'boolean' },
          ms: { type: 'integer' },
          reason: { type: 'string' },
        },
      },
    }),
    timeoutMs: 900000,
    async execute(args, exec) {
      const config = loadConfig();
      const results = await probeMirrors({
        kind: typeof args?.kind === 'string' ? args.kind : undefined,
        timeoutMs: Number.isInteger(args?.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : config.probeTimeoutMs,
        signal: exec?.signal,
      });
      saveHealth({ probedAt: new Date().toISOString(), results });
      const healthy = results.filter((entry) => entry.ok);
      const summary = [
        `probed ${results.length} mirrors: ${healthy.length} reachable`,
        ...results
          .slice()
          .sort((left, right) => Number(right.ok) - Number(left.ok) || left.ms - right.ms)
          .map((entry) => `${entry.ok ? 'OK  ' : 'FAIL'} ${String(entry.ms).padStart(6, ' ')}ms ${entry.kind}/${entry.id}${entry.reason ? ` — ${entry.reason}` : ''}`),
      ].join('\n');
      return { summary, mirrors: results };
    },
  }));

  /* ----------------------------------------------------------------- config */
  disposers.push(ctx.tools.register({
    name: 'rea_config',
    description: 'Read or update REA plugin configuration: install source preference, pinned version, Node path, mirror rows, timeouts, MCP schema profiles, env, and version retention.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        get: { ...BOOLEAN, description: 'Return the current configuration (default when no patch is given).' },
        reset: { ...BOOLEAN, description: 'Reset every field to its default.' },
        patch: { ...ANY, description: 'Fields to merge: source, pinnedVersion, nodePath, mirrors, networkTimeoutMs, probeTimeoutMs, mcpStartupTimeoutMs, mcpToolTimeoutMs, mcpAutoReconnect, inputSchemaProfile, outputSchemaProfile, env, keepVersions.' },
      },
    },
    output: output('REA config', 'config', {
      type: 'object',
      additionalProperties: true,
      properties: {},
    }),
    timeoutMs: 60000,
    async execute(args) {
      if (args?.reset === true) {
        const config = resetConfig();
        await closeSession();
        return { summary: `configuration reset\n${JSON.stringify(config, null, 2)}`, config };
      }
      if (args?.patch && typeof args.patch === 'object') {
        const patch = { ...args.patch };
        if (patch.source !== undefined && !SOURCE_CHOICES.includes(patch.source)) {
          throw new Error(`source must be one of ${SOURCE_CHOICES.join(', ')}`);
        }
        const config = saveConfig(patch);
        if (patch.nodePath !== undefined) await closeSession();
        return { summary: `configuration updated\n${JSON.stringify(config, null, 2)}`, config };
      }
      const config = loadConfig();
      const health = loadHealth();
      return {
        summary: `configuration\n${JSON.stringify(config, null, 2)}\n\nmirror health: ${health.probedAt ? `probed ${health.probedAt}` : 'never probed'}`,
        config,
      };
    },
  }));

  /* ------------------------------------------------------------- uninstall */
  disposers.push(ctx.tools.register({
    name: 'rea_uninstall',
    description: 'Deactivate REA and optionally delete installed runtime directories. The plugin itself stays loaded; rea_install re-creates everything.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        purge: { ...BOOLEAN, description: 'Also delete every installed version directory (default false).' },
        version: { ...STRING, description: 'Delete only this version.' },
      },
    },
    output: output('REA uninstall', 'result', {
      type: 'object',
      additionalProperties: true,
      properties: {},
    }),
    timeoutMs: 300000,
    async execute(args) {
      await closeSession();
      const removed = [];
      if (args?.purge === true) {
        for (const entry of listInstalled()) {
          const result = pruneVersions('');
          removed.push(...result);
          break;
        }
      } else if (typeof args?.version === 'string' && args.version.trim()) {
        const target = inspectRuntime(args.version.trim());
        if (target) {
          const { rmSync } = await import('node:fs');
          rmSync(target.dir, { recursive: true, force: true });
          removed.push(target.version);
        }
      }
      const active = deactivate();
      return {
        summary: removed.length > 0 ? `deactivated; removed ${removed.join(', ')}` : 'deactivated',
        result: { removed, active },
      };
    },
  }));

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose?.();
      } catch {
        /* ignore */
      }
    }
  };
}

export { requireRuntime };
