/**
 * MCP session control: start / stop / restart / status.
 *
 * The REA MCP child is normally started lazily on the first tool call. These
 * helpers give the model and the settings panel explicit control, and persist
 * the on/off intent so a deliberate stop survives until someone starts it
 * again — it must not silently resurrect on the next call.
 */
import { loadConfig, saveConfig } from './config.js';
import { closeSession, getSession, sessionState } from './mcp-client.js';
import { requireRuntime } from './runtime.js';
import { log } from './exec.js';

/** Current session status plus the persisted intent. */
export function mcpStatus() {
  const config = loadConfig();
  const session = sessionState();
  return {
    enabled: config.mcpEnabled !== false,
    autoStart: config.mcpAutoStart !== false,
    running: session.running,
    tools: session.tools,
    serverInfo: session.serverInfo ?? null,
    startupTimeoutMs: config.mcpStartupTimeoutMs,
    toolTimeoutMs: config.mcpToolTimeoutMs,
    autoReconnect: config.mcpAutoReconnect !== false,
  };
}

/** Start (or reuse) the MCP child and return the refreshed status. */
export async function startMcp(options = {}) {
  const config = loadConfig();
  if (config.mcpEnabled === false) saveConfig({ mcpEnabled: true });
  const runtime = await requireRuntime(options.signal);
  if (!runtime) throw new Error('尚未安装 REA 运行时：请先安装一个版本');
  await getSession(runtime);
  log('mcp started by request');
  return mcpStatus();
}

/** Stop the MCP child and remember that it was stopped on purpose. */
export async function stopMcp() {
  saveConfig({ mcpEnabled: false });
  await closeSession();
  log('mcp stopped by request');
  return mcpStatus();
}

/** Restart the MCP child with the current runtime. */
export async function restartMcp(options = {}) {
  saveConfig({ mcpEnabled: true });
  await closeSession();
  return startMcp(options);
}
