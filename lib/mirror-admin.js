/**
 * Mirror site administration.
 *
 * One module serves both faces — the model-facing `rea_mirror_admin` tool and
 * the GUI panel behind the plugin RPC route — so the two can never diverge.
 * Every mutation writes `config.mirrors` through the atomic config writer, so a
 * change survives a harness restart without a separate "save" step.
 */
import { effectiveMirrors, loadConfig, saveConfig } from './config.js';
import {
  addMirror,
  mirrorAdminView,
  removeMirror,
  resetMirrors,
  updateMirror,
  validateMirrorRow,
} from './mirrors.js';
import { probeCache, probeMirrors, probeOne } from './health.js';
import { loadHealth, saveHealth } from './config.js';
import { log } from './exec.js';

/** Compose the list payload the panel renders. */
export function listMirrors() {
  const config = loadConfig();
  const view = mirrorAdminView(config.mirrors);
  const health = loadHealth();
  // Persisted probes win; in-memory probes fill in rows tested since startup.
  const probed = new Map();
  for (const [id, entry] of Object.entries(probeCache())) if (entry && entry.id) probed.set(id, entry);
  for (const entry of Array.isArray(health.results) ? health.results : []) {
    if (entry && entry.id) probed.set(entry.id, entry);
  }
  return {
    ...view,
    mirrors: view.mirrors.map((mirror) => ({
      ...mirror,
      last: probed.get(mirror.id) ?? null,
    })),
    probedAt: health.probedAt ?? '',
  };
}

/** Probe one stored mirror (or an unsaved candidate row) and persist the result. */
export async function testMirror(options = {}) {
  const { id, candidate, timeoutMs, signal } = options;
  let row;
  if (candidate) {
    const problems = validateMirrorRow(candidate, { allowExisting: true });
    if (problems.length > 0) {
      const error = new Error(`invalid mirror row: ${problems.join('; ')}`);
      error.problems = problems;
      throw error;
    }
    row = {
      id: candidate.id,
      kind: candidate.kind,
      url: candidate.url,
      priority: Number(candidate.priority ?? 500),
      template: String(candidate.url ?? '').includes('{url}') ? candidate.url : undefined,
    };
  } else {
    row = effectiveMirrors(loadConfig()).find((mirror) => mirror.id === id);
    if (!row) throw new Error(`unknown mirror "${id}"`);
  }
  const result = await probeOne(row, { timeoutMs, signal });
  if (!candidate) {
    const health = loadHealth();
    const results = (Array.isArray(health.results) ? health.results : []).filter((entry) => entry.id !== result.id);
    results.push(result);
    saveHealth({ probedAt: new Date().toISOString(), results });
  }
  return result;
}

/** Probe every mirror and persist the whole result set. */
export async function testAllMirrors(options = {}) {
  const results = await probeMirrors({ kind: options.kind, timeoutMs: options.timeoutMs, signal: options.signal });
  saveHealth({ probedAt: new Date().toISOString(), results });
  return results;
}

/** Add a mirror row and persist it immediately. */
export function createMirror(row) {
  const config = loadConfig();
  const existingIds = effectiveMirrors(config).map((mirror) => mirror.id);
  const problems = validateMirrorRow(row, { existingIds });
  if (problems.length > 0) {
    const error = new Error(`invalid mirror row: ${problems.join('; ')}`);
    error.problems = problems;
    throw error;
  }
  const { mirrors } = addMirror(config.mirrors, {
    id: row.id.trim(),
    kind: row.kind.trim(),
    url: row.url.trim(),
    label: typeof row.label === 'string' && row.label.trim() ? row.label.trim() : row.id.trim(),
    priority: row.priority,
  });
  saveConfig({ mirrors });
  log(`mirror added: ${row.id.trim()} (${row.kind.trim()}) ${row.url.trim()}`);
  return listMirrors();
}

/** Remove a mirror (built-in rows become restorable "removed" entries). */
export function deleteMirror(id) {
  const config = loadConfig();
  const exists = effectiveMirrors(config).some((mirror) => mirror.id === id);
  if (!exists) throw new Error(`unknown mirror "${id}"`);
  const { mirrors } = removeMirror(config.mirrors, id);
  saveConfig({ mirrors });
  log(`mirror removed: ${id}`);
  return listMirrors();
}

/** Edit one mirror row in place. */
export function editMirror(id, patch = {}) {
  const config = loadConfig();
  const next = updateMirror(config.mirrors, id, patch);
  saveConfig({ mirrors: next.mirrors });
  log(`mirror updated: ${id}`);
  return listMirrors();
}

/** Restore every built-in mirror and drop custom rows. */
export function restoreMirrors() {
  const { mirrors } = resetMirrors();
  saveConfig({ mirrors });
  log('mirrors reset to built-ins');
  return listMirrors();
}

/** Reorder by explicit priority values (index order wins). */
export function reorderMirrors(ids) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('ids must be a non-empty array');
  const config = loadConfig();
  const overrides = Array.isArray(config.mirrors) ? [...config.mirrors] : [];
  const current = effectiveMirrors(config);
  const byId = new Map(current.map((mirror) => [mirror.id, mirror]));
  const next = [];
  let priority = 10;
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue;
    const previous = overrides.find((entry) => entry && entry.id === id);
    next.push({
      ...(previous && previous.disabled !== true ? previous : {}),
      id,
      kind: row.kind,
      url: row.url,
      label: row.label ?? id,
      priority,
    });
    priority += 10;
  }
  for (const row of current) {
    if (ids.includes(row.id)) continue;
    next.push({ id: row.id, kind: row.kind, url: row.url, label: row.label ?? row.id, priority });
    priority += 10;
  }
  saveConfig({ mirrors: next });
  return listMirrors();
}
