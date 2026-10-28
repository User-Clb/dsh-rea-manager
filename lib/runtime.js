/**
 * Runtime resolution shared by the tool surface and the management modules.
 *
 * Kept in its own module so `tools.js`, `tool-admin.js` and `mcp-control.js`
 * can all use it without importing each other in a cycle.
 */
import { loadActive } from './config.js';
import { inspectRuntime } from './install.js';
import { ensureNodeRuntime } from './node-runtime.js';

/**
 * Resolve the active, on-disk runtime plus the Node binary that must launch it.
 *
 * @returns {Promise<null | { version: string, dir: string, entry: string, channel: string, nodePath: string, nodeVersion: string, active: true }>}
 */
export async function requireRuntime(signal) {
  const active = loadActive();
  if (!active?.entry) return null;
  const inspected = inspectRuntime(active.version);
  if (!inspected) return null;
  const node = await ensureNodeRuntime({ signal });
  return { ...inspected, nodePath: node.path, nodeVersion: node.version, active: true };
}
