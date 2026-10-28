/**
 * MCP tool catalog + per-tool management.
 *
 * REA exposes ~229 tools. Bridging all of them as native harness tools would
 * spend the model's whole tool budget, so the plugin exposes a small facade and
 * reaches REA through `rea_call`. This module is the management layer for that
 * catalog: it lists tools with grouping and health, and it persists a per-tool
 * on/off policy that `rea_tools` / `rea_call` both honour.
 *
 * Policy is stored as `disabledTools: string[]` in config.json, so it survives
 * restarts and stays editable by hand.
 */
import { loadConfig, saveConfig } from './config.js';
import { getSession } from './mcp-client.js';
import { requireRuntime } from './runtime.js';
import { log } from './exec.js';

/** Prefix → human group, ordered most-specific first. */
const GROUPS = [
  ['adb', 'Android / ADB'],
  ['android', 'Android / ADB'],
  ['apktool', 'Android / ADB'],
  ['apk', 'Android / ADB'],
  ['jeb', 'Android / ADB'],
  ['frida', 'Frida / 动态'],
  ['gdb', '调试器'],
  ['rizin', '调试器'],
  ['cutter', '调试器'],
  ['ghidra', '反编译器'],
  ['ida', '反编译器'],
  ['hopper', '反编译器'],
  ['procedure', '反编译器'],
  ['native', '原生二进制'],
  ['macho', '原生二进制'],
  ['pe', '原生二进制'],
  ['elf', '原生二进制'],
  ['binary', '原生二进制'],
  ['managed', '原生二进制'],
  ['javascript', 'JS / Electron'],
  ['electron', 'JS / Electron'],
  ['web', 'Web / 浏览器'],
  ['browser', 'Web / 浏览器'],
  ['evidence', '证据 / 比对'],
  ['compare', '证据 / 比对'],
  ['trace', '证据 / 比对'],
  ['unknown', '证据 / 比对'],
  ['firmware', '固件 / 信号'],
  ['signal', '固件 / 信号'],
  ['pcap', '固件 / 信号'],
  ['packet', '固件 / 信号'],
  ['wasm', '其他格式'],
  ['evm', '其他格式'],
  ['sqlite', '其他格式'],
  ['go', '其他格式'],
  ['rust', '其他格式'],
  ['python', '其他格式'],
  ['erlang', '其他格式'],
  ['il2cpp', '其他格式'],
  ['flutter', '其他格式'],
  ['dart', '其他格式'],
  ['model', '其他格式'],
  ['gpu', '其他格式'],
  ['analysis', '会话 / 配置'],
  ['settings', '会话 / 配置'],
  ['session', '会话 / 配置'],
  ['open', '会话 / 配置'],
  ['close', '会话 / 配置'],
];

function groupOf(name) {
  const lower = String(name ?? '').toLowerCase();
  for (const [prefix, label] of GROUPS) {
    if (lower.startsWith(prefix)) return label;
  }
  return '其他';
}

/** Load the current tool catalog from the live session. */
export async function loadToolCatalog(signal) {
  const runtime = await requireRuntime(signal);
  if (!runtime) {
    const error = new Error('尚未安装 REA 运行时：请先安装一个版本');
    error.code = 'no-runtime';
    throw error;
  }
  const session = await getSession(runtime);
  return { runtime, session, tools: session.listTools() };
}

/** Project one MCP tool into the management row shape. */
export function describeTool(tool, disabled) {
  const description = String(tool.description ?? '');
  return {
    name: tool.name,
    group: groupOf(tool.name),
    description: description.split('\n')[0].slice(0, 240),
    descriptionLength: description.length,
    propertyCount: Object.keys(tool.inputSchema?.properties ?? {}).length,
    requiredCount: Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required.length : 0,
    enabled: !disabled.has(tool.name),
  };
}

/**
 * List the catalog with filtering and the persisted on/off state.
 *
 * @param {{ query?: string, group?: string, enabled?: boolean, limit?: number, offset?: number, signal?: AbortSignal }} options
 */
export async function listTools(options = {}) {
  const config = loadConfig();
  const disabled = new Set(Array.isArray(config.disabledTools) ? config.disabledTools : []);
  const { runtime, tools } = await loadToolCatalog(options.signal);
  const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : '';
  const group = typeof options.group === 'string' ? options.group.trim() : '';
  const rows = tools
    .map((tool) => describeTool(tool, disabled))
    .filter((row) => (query
      ? row.name.toLowerCase().includes(query) || row.description.toLowerCase().includes(query)
      : true))
    .filter((row) => (group ? row.group === group : true))
    .filter((row) => (options.enabled === undefined ? true : row.enabled === options.enabled));
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : rows.length;
  const offset = Number.isInteger(options.offset) && options.offset > 0 ? options.offset : 0;
  const groups = [...new Set(tools.map((tool) => groupOf(tool.name)))].sort();
  return {
    version: runtime.version,
    total: tools.length,
    matched: rows.length,
    enabled: tools.length - disabled.size,
    disabled: disabled.size,
    groups,
    tools: rows.slice(offset, offset + limit),
  };
}

/** Enable or disable one tool; the name is validated against the live catalog. */
export async function setToolEnabled(name, enabled, signal) {
  const target = String(name ?? '').trim();
  if (!target) throw new Error('需要工具名');
  const { tools } = await loadToolCatalog(signal);
  if (!tools.some((tool) => tool.name === target)) {
    throw new Error(`未知工具 "${target}"：请先用 rea_tools 或工具列表确认名称`);
  }
  const config = loadConfig();
  const disabled = new Set(Array.isArray(config.disabledTools) ? config.disabledTools : []);
  if (enabled) disabled.delete(target);
  else disabled.add(target);
  saveConfig({ disabledTools: [...disabled].sort() });
  log(`tool ${enabled ? 'enabled' : 'disabled'}: ${target}`);
  return { name: target, enabled: Boolean(enabled), disabledCount: disabled.size };
}

/**
 * Bulk enable/disable by query or group.
 *
 * @param {{ query?: string, group?: string, enabled: boolean, signal?: AbortSignal }} options
 */
export async function setToolsEnabled(options = {}) {
  const enabled = options.enabled === true;
  const { tools } = await loadToolCatalog(options.signal);
  const config = loadConfig();
  const disabled = new Set(Array.isArray(config.disabledTools) ? config.disabledTools : []);
  const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : '';
  const group = typeof options.group === 'string' ? options.group.trim() : '';
  if (!query && !group) throw new Error('批量操作需要 query 或 group，避免误改整个目录');
  const affected = tools
    .filter((tool) => (query
      ? tool.name.toLowerCase().includes(query) || String(tool.description ?? '').toLowerCase().includes(query)
      : true))
    .filter((tool) => (group ? groupOf(tool.name) === group : true))
    .map((tool) => tool.name);
  if (affected.length === 0) throw new Error('没有匹配的工具');
  for (const name of affected) {
    if (enabled) disabled.delete(name);
    else disabled.add(name);
  }
  saveConfig({ disabledTools: [...disabled].sort() });
  log(`tools ${enabled ? 'enabled' : 'disabled'} in bulk: ${affected.length}`);
  return { changed: affected.length, enabled, disabledCount: disabled.size, names: affected };
}

/** Clear the whole policy: every tool enabled again. */
export function resetTools() {
  saveConfig({ disabledTools: [] });
  log('tool policy reset');
  return { disabledCount: 0 };
}

/** The persisted deny list, for guards and status output. */
export function disabledToolSet() {
  const config = loadConfig();
  return new Set(Array.isArray(config.disabledTools) ? config.disabledTools : []);
}

/** Full input schema of one tool, read from the live session. */
export async function toolSchema(name, signal) {
  const target = String(name ?? '').trim();
  if (!target) throw new Error('需要工具名');
  const { tools } = await loadToolCatalog(signal);
  const tool = tools.find((entry) => entry.name === target);
  if (!tool) throw new Error(`未知工具 "${target}"`);
  return {
    name: tool.name,
    group: groupOf(tool.name),
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? {},
    outputSchema: tool.outputSchema ?? null,
    enabled: !disabledToolSet().has(tool.name),
  };
}

export { groupOf };
