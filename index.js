/**
 * dsh-rea-manager — REA (Reverse Engineer Anything) for DeepSeek Harness.
 *
 * Host half. Registers:
 *   - the REA tool surface (`rea_status`, `rea_versions`, `rea_install`,
 *     `rea_update`, `rea_rollback`, `rea_tools`, `rea_tool_schema`, `rea_call`,
 *     `rea_mirrors`, `rea_config`, `rea_uninstall`);
 *   - one system-prompt section describing the workflow;
 *   - a plugin RPC route so a client half can drive the same operations.
 *
 * The plugin owns its own installation store (`<DSH_HOME>/dsh-rea-manager`), so REA
 * updates and rollbacks never touch the harness profile's dependency tree.
 */
import { registerTools, requireRuntime } from './lib/tools.js';
import { loadActive, loadConfig } from './lib/config.js';
import { buildCatalog } from './lib/catalog.js';
import { installVersion, activateRuntime, listInstalled, inspectRuntime, removeInstalledVersion } from './lib/install.js';
import { ensureNodeRuntime } from './lib/node-runtime.js';
import { closeSession, getSession, sessionState } from './lib/mcp-client.js';
import { probeMirrors } from './lib/health.js';
import { mcpStatus, restartMcp, startMcp, stopMcp } from './lib/mcp-control.js';
import { listTools, resetTools, setToolEnabled, setToolsEnabled, toolSchema } from './lib/tool-admin.js';
import {
  createMirror,
  deleteMirror,
  editMirror,
  listMirrors,
  reorderMirrors,
  restoreMirrors,
  testAllMirrors,
  testMirror,
} from './lib/mirror-admin.js';
import { storeRoot } from './lib/paths.js';

export const name = 'dsh-rea-manager';
export const inject = ['tools', 'systemPrompt'];

const RPC_PATH = '/api/plugin-rpc/dsh-rea-manager';
const RPC_METHOD = 'plugin-rpc/dsh-rea-manager';

const PROMPT_SECTION = `REA (Reverse Engineer Anything) is available through dsh-rea-manager. Workflow:
- rea_status — active version, installed versions, Node runtime, MCP session.
- rea_versions — the complete release list (git tags + npm), newest first.
- rea_install {"version":"6.8.0"} — install + activate one version; "latest" or a unique prefix works.
- rea_update — move to the newest release; the old version stays installed.
- rea_rollback {"version":"6.5.0"} — return to a specific historical version.
- rea_tools {"query":"apk"} — search REA's 200+ analysis tools; rea_tool_schema for exact arguments.
- rea_call {"tool":"inspect_android_package","args":{...}} — run one REA tool.
- rea_mirrors — probe every git / npm / node mirror and report which are reachable.
All network access goes through a mirror chain (GitHub accelerators, Gitee mirror, npm registries, Node binary mirrors) and falls back automatically.`;

export function apply(ctx) {
  const disposeTools = registerTools(ctx);

  ctx.systemPrompt?.section?.({
    name: 'plugin:dsh-rea-manager',
    order: 300,
    text: PROMPT_SECTION,
  });

  // Warm the catalog in the background so the first model call is instant.
  setTimeout(() => {
    buildCatalog({}).catch(() => {});
  }, 2500).unref?.();

  let disposeRpc;
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => {
      disposeRpc = scope.connection.fetch.register({
        path: RPC_PATH,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => handleRpc(request, ctx),
      });
      ctx.logger?.info?.(`[dsh-rea-manager] RPC registered: ${RPC_PATH}`);
      return () => disposeRpc?.();
    }, 'dsh-rea-manager: RPC route');
  });

  ctx.logger?.info?.(`[dsh-rea-manager] store=${storeRoot()} active=${loadActive()?.version ?? 'none'}`);

  return async () => {
    disposeTools?.();
    await closeSession().catch(() => {});
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function success(rpcId, value) {
  return jsonResponse({ type: 'server-response', rpcId, result: { ok: true, value } });
}

function failure(rpcId, code, message) {
  return jsonResponse({ type: 'server-response', rpcId, result: { ok: false, error: { code, message, details: {} } } });
}

async function handleRpc(request, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('invalid JSON request body', { status: 400 });
  }
  if (body === null || typeof body !== 'object' || body.type !== 'client-request'
    || typeof body.rpcId !== 'string' || body.method !== RPC_METHOD) {
    return new Response('invalid client-request envelope', { status: 400 });
  }
  const wrapped = body.payload;
  if (!wrapped || typeof wrapped !== 'object' || typeof wrapped.endpoint !== 'string') {
    return failure(body.rpcId, 'invalid-request', 'payload must be { endpoint, payload }');
  }
  try {
    switch (wrapped.endpoint) {
      case 'status': {
        const active = loadActive();
        const config = loadConfig();
        let session = sessionState();
        if (active?.entry) {
          try {
            const runtime = await requireRuntime();
            if (runtime) {
              await getSession(runtime);
              session = sessionState();
            }
          } catch (error) {
            session = { ...session, error: String(error?.message ?? error) };
          }
        }
        return success(body.rpcId, {
          active,
          installed: listInstalled().map((entry) => ({ version: entry.version, channel: entry.channel, installedAt: entry.installedAt })),
          session,
          config,
          store: storeRoot(),
        });
      }
      case 'versions': {
        const catalog = await buildCatalog({ refresh: wrapped.payload?.refresh === true });
        const active = loadActive();
        const installed = new Set(listInstalled().map((entry) => entry.version));
        return success(body.rpcId, {
          generatedAt: catalog.generatedAt,
          latest: catalog.latest,
          active: active?.version ?? '',
          versions: catalog.versions.map((entry) => ({
            version: entry.version,
            date: entry.date ?? '',
            sources: entry.sources ?? [],
            installed: installed.has(entry.version),
            active: entry.version === active?.version,
            deprecated: entry.deprecated === true,
          })),
        });
      }
      case 'install':
      case 'update':
      case 'rollback': {
        const target = wrapped.payload?.version;
        // Row-level "install" installs only: activation is a separate, explicit
        // action so the list can offer 安装 / 启用 as mutually exclusive buttons.
        const activateAfter = wrapped.payload?.activate !== false;
        if (activateAfter) await closeSession();
        const record = typeof target === 'string' && target.trim()
          ? await installVersion(target.trim(), { force: wrapped.payload?.force === true })
          : await installVersion((await buildCatalog({ refresh: true })).latest, {});
        if (!activateAfter) {
          return success(body.rpcId, { version: record.version, channel: record.channel, activated: false });
        }
        const node = await ensureNodeRuntime();
        activateRuntime({ ...record, nodePath: node.path, nodeVersion: node.version });
        const runtime = await requireRuntime();
        let session = { running: false, tools: 0 };
        try {
          await getSession(runtime);
          session = sessionState();
        } catch (error) {
          session = { running: false, tools: 0, error: String(error?.message ?? error) };
        }
        return success(body.rpcId, { version: record.version, channel: record.channel, activated: true, session });
      }
      case 'remove': {
        const version = String(wrapped.payload?.version ?? '').trim();
        const value = removeInstalledVersion(version);
        // Return the refreshed view so the panel updates install badges at once.
        const active = loadActive();
        const installed = new Set(listInstalled().map((entry) => entry.version));
        return success(body.rpcId, {
          removed: value,
          active: active?.version ?? '',
          installed: [...installed],
        });
      }
      case 'activate': {
        const version = String(wrapped.payload?.version ?? '').trim();
        const record = inspectRuntime(version);
        if (!record) return failure(body.rpcId, 'not-installed', `REA ${version} is not installed`);
        await closeSession();
        const node = await ensureNodeRuntime();
        const active = activateRuntime({ ...record, nodePath: node.path, nodeVersion: node.version });
        return success(body.rpcId, { active });
      }
      case 'mirrors':
        return success(body.rpcId, await probeMirrors({ kind: wrapped.payload?.kind }));
      /* -------- mirror site management (persisted on every mutation) ------- */
      case 'mirrorList':
        return success(body.rpcId, listMirrors());
      case 'mirrorTest': {
        const payload = wrapped.payload ?? {};
        return success(body.rpcId, await testMirror({
          id: typeof payload.id === 'string' ? payload.id : undefined,
          candidate: payload.row && typeof payload.row === 'object' ? payload.row : undefined,
          timeoutMs: Number.isInteger(payload.timeoutMs) ? payload.timeoutMs : undefined,
        }));
      }
      case 'mirrorTestAll': {
        const payload = wrapped.payload ?? {};
        const results = await testAllMirrors({
          kind: typeof payload.kind === 'string' ? payload.kind : undefined,
          timeoutMs: Number.isInteger(payload.timeoutMs) ? payload.timeoutMs : undefined,
        });
        return success(body.rpcId, { results, ...listMirrors() });
      }
      case 'mirrorAdd':
        return success(body.rpcId, createMirror(wrapped.payload?.row ?? {}));
      case 'mirrorRemove':
        return success(body.rpcId, deleteMirror(String(wrapped.payload?.id ?? '').trim()));
      case 'mirrorUpdate':
        return success(body.rpcId, editMirror(
          String(wrapped.payload?.id ?? '').trim(),
          wrapped.payload?.patch ?? {},
        ));
      case 'mirrorReset':
        return success(body.rpcId, restoreMirrors());
      case 'mirrorReorder':
        return success(body.rpcId, reorderMirrors(Array.isArray(wrapped.payload?.ids) ? wrapped.payload.ids : []));
      /* ------------------------- MCP process control ----------------------- */
      case 'mcpStatus':
        return success(body.rpcId, mcpStatus());
      case 'mcpStart':
        return success(body.rpcId, await startMcp());
      case 'mcpStop':
        return success(body.rpcId, await stopMcp());
      case 'mcpRestart':
        return success(body.rpcId, await restartMcp());
      /* ------------------------- MCP tool catalog -------------------------- */
      case 'toolList': {
        const payload = wrapped.payload ?? {};
        return success(body.rpcId, await listTools({
          query: typeof payload.query === 'string' ? payload.query : undefined,
          group: typeof payload.group === 'string' ? payload.group : undefined,
          enabled: typeof payload.enabled === 'boolean' ? payload.enabled : undefined,
          limit: Number.isInteger(payload.limit) ? payload.limit : undefined,
          offset: Number.isInteger(payload.offset) ? payload.offset : undefined,
        }));
      }
      case 'toolSet': {
        const payload = wrapped.payload ?? {};
        return success(body.rpcId, await setToolEnabled(payload.tool, payload.enabled === true));
      }
      case 'toolBulk': {
        const payload = wrapped.payload ?? {};
        return success(body.rpcId, await setToolsEnabled({
          query: typeof payload.query === 'string' ? payload.query : undefined,
          group: typeof payload.group === 'string' ? payload.group : undefined,
          enabled: payload.enabled !== false,
        }));
      }
      case 'toolReset':
        return success(body.rpcId, resetTools());
      case 'toolSchema':
        return success(body.rpcId, await toolSchema(wrapped.payload?.tool));
      case 'config':
        return success(body.rpcId, loadConfig());
      default:
        return failure(body.rpcId, 'unknown-endpoint', `unknown endpoint ${wrapped.endpoint}`);
    }
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-rea-manager] rpc ${wrapped.endpoint} failed: ${String(error?.message ?? error)}`);
    return failure(body.rpcId, 'dsh-rea-manager-failed', String(error?.message ?? error));
  }
}
