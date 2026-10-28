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
import {
  createMirror,
  deleteMirror,
  editMirror,
  listMirrors,
  reorderMirrors,
  restoreMirrors,
  testAllMirrors,
  testMirror,
} from './mirror-admin.js';
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
    description: '查看 REA 插件状态：当前版本、已安装版本、Node 运行时、MCP 会话健康度与镜像配置。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        probe: { ...BOOLEAN, description: '同时启动（或复用）MCP 服务并报告工具数量，默认 true。' },
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
    description: '列出全部已知 REA 版本（git tag 与 npm 版本合并），按新旧排序，标注当前版本与已安装版本。用于挑选 rea_install 或 rea_rollback 的目标版本。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        refresh: { ...BOOLEAN, description: '忽略 10 分钟缓存，重新向所有镜像查询。' },
        query: { ...STRING, description: '可选的版本子串过滤，如 6. 或 5。' },
        limit: { ...INTEGER, description: '最多返回多少行，默认 200。' },
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
    description: '从镜像链安装指定 REA 版本并启用。支持 latest、完整版本号（如 6.8.0）或唯一前缀。优先使用自带预编译 dist 的 npm 包，失败时回退到 git 源码构建。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        version: { ...STRING, description: '要安装的版本：latest、6.8.0 或唯一前缀；缺省用配置中的固定版本或最新版。' },
        force: { ...BOOLEAN, description: '即使该版本已存在也重新安装。' },
        refresh: { ...BOOLEAN, description: '解析前先刷新版本目录。' },
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
    description: '通过镜像链把 REA 更新到最新发布版（或指定版本），旧版本保留在磁盘上，可用 rea_rollback 回退。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        version: { ...STRING, description: '目标版本；留空表示最新发布版。' },
        dryRun: { ...BOOLEAN, description: '只报告将要发生的变更，不实际执行。' },
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
    description: '把 REA 回退到指定历史版本，或回退到比当前版本旧的最近一个版本。目标版本需已安装或可从镜像安装。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        version: { ...STRING, description: '要回退到的确切版本（或唯一前缀）；留空表示回退一档。' },
        install: { ...BOOLEAN, description: '本地没有该版本时自动安装，默认 true。' },
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
    description: '检索或列出运行中 MCP 服务提供的 REA 工具目录（6.8.0 共 229 个）。返回工具名与单行描述；需要完整入参 schema 请用 rea_tool_schema。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { ...STRING, description: '按工具名与描述匹配的子串，如 frida、apk、ghidra。' },
        limit: { ...INTEGER, description: '最多返回多少个工具，默认 40，上限 229。' },
        offset: { ...INTEGER, description: '跳过前多少个匹配（分页）。' },
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
    description: '返回单个 REA 工具的完整入参 schema，便于在调用 rea_call 前精确构造参数。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['tool'],
      properties: {
        tool: { ...STRING, description: '确切的 REA 工具名，如 inspect_android_package。' },
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
    description: '调用任意一个 REA 工具。这是二进制、APK、Electron/JS、固件分析、反编译、Frida 注入、ADB 操作与证据比对的统一入口。传入确切工具名与 JSON 参数。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['tool'],
      properties: {
        tool: { ...STRING, description: '来自 rea_tools 的确切 REA 工具名。' },
        args: { ...ANY, description: '与该工具入参 schema 匹配的 JSON 参数对象。' },
        timeoutMs: { ...INTEGER, description: '覆盖单次调用超时（默认取配置值）。' },
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
    description: '探测全部 git / npm / node 镜像，报告延迟与可达性，结果写入 mirrors-health.json，便于把最快的镜像提到前面。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { ...STRING, description: '只探测某一类：git、npm 或 node。' },
        timeoutMs: { ...INTEGER, description: '单个镜像的探测预算（毫秒），默认 12000。' },
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
    description: '读取或修改 REA 插件配置：安装源偏好、固定版本、Node 路径、镜像行、超时、MCP schema 档位、环境变量与版本保留数。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        get: { ...BOOLEAN, description: '返回当前配置（不传 patch 时的默认行为）。' },
        reset: { ...BOOLEAN, description: '把所有字段恢复默认值。' },
        patch: { ...ANY, description: '要合并的字段：source、pinnedVersion、nodePath、mirrors、networkTimeoutMs、probeTimeoutMs、mcpStartupTimeoutMs、mcpToolTimeoutMs、mcpAutoReconnect、inputSchemaProfile、outputSchemaProfile、env、keepVersions。' },
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

  /* ---------------------------------------------------------- mirror admin */
  disposers.push(ctx.tools.register({
    name: 'rea_mirror_admin',
    description: '管理 REA 的代理站点列表：列出全部镜像（含来源与最近一次探测结果）、测试单个或全部镜像、添加、移除、修改、恢复默认与排序。所有修改立即写入 config.json 持久化。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          ...STRING,
          description: 'list | test | testAll | add | remove | update | reset | reorder',
        },
        id: { ...STRING, description: '镜像 id（test / remove / update 时必填）。' },
        row: {
          ...ANY,
          description: 'add 时的镜像行：{ id, kind: git|npm|node, url, label?, priority? }；test 时可传候选行做“未保存先测试”。',
        },
        patch: { ...ANY, description: 'update 时的字段：{ url?, label?, kind?, priority? }。' },
        ids: { ...STRING_ARRAY, description: 'reorder 时的镜像 id 顺序。' },
        kind: { ...STRING, description: 'testAll 时限定种类：git / npm / node。' },
        timeoutMs: { ...INTEGER, description: '单次探测预算（毫秒）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'mirrors'],
        properties: {
          summary: { type: 'string' },
          mirrors: {
            type: 'array',
            items: { type: 'object', additionalProperties: true, properties: {} },
          },
          removed: STRING_ARRAY,
          counts: { type: 'object', additionalProperties: true, properties: {} },
          defaults: {
            type: 'array',
            items: { type: 'object', additionalProperties: true, properties: {} },
          },
          probedAt: { type: 'string' },
          result: { type: 'object', additionalProperties: true, properties: {} },
        },
      },
      render: (_args, value) => [text(value.summary)],
      presentationMeta: (_args, value) => ({ counts: value.counts ?? {} }),
    },
    timeoutMs: 900000,
    async execute(args, exec) {
      const action = String(args?.action ?? '').trim();
      const timeoutMs = Number.isInteger(args?.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : undefined;
      const summarize = (view) => {
        const rows = (view.mirrors ?? []).map((mirror) => {
          const last = mirror.last;
          const state = last ? (last.ok ? `可用 ${last.ms}ms` : `失败 ${String(last.reason ?? '').slice(0, 40)}`) : '未测试';
          return `${mirror.kind.padEnd(4, ' ')} ${mirror.id.padEnd(20, ' ')} ${mirror.origin.padEnd(8, ' ')} ${state.padEnd(18, ' ')} ${mirror.url}`;
        });
        return [
          `共 ${view.counts?.total ?? rows.length} 个镜像（git ${view.counts?.git ?? 0} / npm ${view.counts?.npm ?? 0} / node ${view.counts?.node ?? 0}，自定义 ${view.counts?.custom ?? 0}，已移除 ${view.counts?.removed ?? 0}）`,
          ...rows,
        ].join('\n');
      };

      switch (action) {
        case 'list':
        case '': {
          const view = listMirrors();
          return { summary: summarize(view), ...view };
        }
        case 'test': {
          const result = await testMirror({
            id: typeof args?.id === 'string' ? args.id : undefined,
            candidate: args?.row && typeof args.row === 'object' ? args.row : undefined,
            timeoutMs,
            signal: exec?.signal,
          });
          const view = listMirrors();
          return {
            summary: `${result.ok ? '可用' : '不可用'}：${result.kind}/${result.id} ${result.ms}ms ${result.reason ?? ''}\n${summarize(view)}`,
            ...view,
            result,
          };
        }
        case 'testAll': {
          const results = await testAllMirrors({
            kind: typeof args?.kind === 'string' ? args.kind : undefined,
            timeoutMs,
            signal: exec?.signal,
          });
          const view = listMirrors();
          const ok = results.filter((entry) => entry.ok).length;
          return {
            summary: `探测完成：${ok}/${results.length} 个镜像可达\n${summarize(view)}`,
            ...view,
            result: { probed: results.length, ok },
          };
        }
        case 'add': {
          const view = createMirror(args?.row ?? {});
          return { summary: `已添加并持久化\n${summarize(view)}`, ...view };
        }
        case 'remove': {
          const id = String(args?.id ?? '').trim();
          if (!id) throw new Error('remove 需要 id');
          const view = deleteMirror(id);
          return { summary: `已移除 ${id}（已持久化）\n${summarize(view)}`, ...view };
        }
        case 'update': {
          const id = String(args?.id ?? '').trim();
          if (!id) throw new Error('update 需要 id');
          const view = editMirror(id, args?.patch ?? {});
          return { summary: `已更新 ${id}（已持久化）\n${summarize(view)}`, ...view };
        }
        case 'reset': {
          const view = restoreMirrors();
          return { summary: `已恢复内置镜像链（已持久化）\n${summarize(view)}`, ...view };
        }
        case 'reorder': {
          const view = reorderMirrors(Array.isArray(args?.ids) ? args.ids : []);
          return { summary: `已重排（已持久化）\n${summarize(view)}`, ...view };
        }
        default:
          throw new Error(`未知 action "${action}"：list | test | testAll | add | remove | update | reset | reorder`);
      }
    },
  }));

  /* ------------------------------------------------------------- uninstall */
  disposers.push(ctx.tools.register({
    name: 'rea_uninstall',
    description: '停用 REA，并可选删除已安装的运行时目录。插件本身保持加载，rea_install 可重新创建。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        purge: { ...BOOLEAN, description: '同时删除所有已安装的版本目录，默认 false。' },
        version: { ...STRING, description: '只删除这个版本。' },
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
