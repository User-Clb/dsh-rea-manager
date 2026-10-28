/**
 * Persistent configuration + activation state.
 *
 * Every write is atomic (temp file + rename) and Windows-safe: an existing file
 * is removed first because `rename` cannot overwrite on this platform.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { activePath, catalogPath, configPath, healthPath, storeRoot, versionsDir, gitCacheDir, logsDir } from './paths.js';
import { mergeMirrors, defaultMirrors } from './mirrors.js';

export const DEFAULTS = Object.freeze({
  /** `auto` prefers the npm tarball (prebuilt dist), then git source builds. */
  source: 'auto',
  /** Preferred npm package version; empty means "latest published". */
  pinnedVersion: '',
  /** Node binary used to run the REA MCP server; empty means auto-detect. */
  nodePath: '',
  /** Extra mirror rows merged over the built-in chain. */
  mirrors: [],
  /** Per-request network timeout for git / http operations. */
  networkTimeoutMs: 120000,
  /** Probe budget per mirror during `mirrors` health checks. */
  probeTimeoutMs: 12000,
  /** MCP child-process startup budget. */
  mcpStartupTimeoutMs: 60000,
  /** Per-tool-call MCP timeout. */
  mcpToolTimeoutMs: 180000,
  /** Reconnect the MCP child automatically after a crash. */
  mcpAutoReconnect: true,
  /** REA MCP schema profiles (compact keeps the tool list inside model budgets). */
  inputSchemaProfile: 'compact',
  outputSchemaProfile: 'off',
  /** Extra environment for the REA child process. */
  env: {},
  /** Keep at most this many installed versions; 0 disables pruning. */
  keepVersions: 6,
  /** Download an official Node build when no local one satisfies REA's engines. */
  autoDownloadNode: true,
  /** Master switch for the MCP child: `false` means "stopped on purpose". */
  mcpEnabled: true,
  /** Start the MCP child lazily on first use instead of at activation. */
  mcpAutoStart: true,
  /** Tool names hidden from `rea_tools` and rejected by `rea_call`. */
  disabledTools: [],
});

function ensureDirs() {
  for (const dir of [storeRoot(), versionsDir(), gitCacheDir(), logsDir()]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function atomicWriteJson(file, value) {
  ensureDirs();
  mkdirSync(path.dirname(file), { recursive: true });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, serialized, 'utf8');
  try {
    renameSync(temporary, file);
  } catch {
    try {
      rmSync(file, { force: true });
    } catch {
      /* ignore */
    }
    try {
      renameSync(temporary, file);
    } catch {
      writeFileSync(file, serialized, 'utf8');
      try {
        rmSync(temporary, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
  } catch {
    return fallback;
  }
}

function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function normalizeConfig(input = {}) {
  const merged = { ...DEFAULTS, ...(input ?? {}) };
  return {
    source: ['auto', 'npm', 'git'].includes(merged.source) ? merged.source : DEFAULTS.source,
    pinnedVersion: typeof merged.pinnedVersion === 'string' ? merged.pinnedVersion.trim() : '',
    nodePath: typeof merged.nodePath === 'string' ? merged.nodePath.trim() : '',
    mirrors: Array.isArray(merged.mirrors) ? merged.mirrors : [],
    networkTimeoutMs: clampInt(merged.networkTimeoutMs, 5000, 900000, DEFAULTS.networkTimeoutMs),
    probeTimeoutMs: clampInt(merged.probeTimeoutMs, 2000, 120000, DEFAULTS.probeTimeoutMs),
    mcpStartupTimeoutMs: clampInt(merged.mcpStartupTimeoutMs, 5000, 600000, DEFAULTS.mcpStartupTimeoutMs),
    mcpToolTimeoutMs: clampInt(merged.mcpToolTimeoutMs, 5000, 3600000, DEFAULTS.mcpToolTimeoutMs),
    mcpAutoReconnect: merged.mcpAutoReconnect !== false,
    inputSchemaProfile: ['compact', 'full'].includes(merged.inputSchemaProfile)
      ? merged.inputSchemaProfile
      : DEFAULTS.inputSchemaProfile,
    outputSchemaProfile: ['compact', 'off', 'full'].includes(merged.outputSchemaProfile)
      ? merged.outputSchemaProfile
      : DEFAULTS.outputSchemaProfile,
    env: merged.env && typeof merged.env === 'object' ? merged.env : {},
    keepVersions: clampInt(merged.keepVersions, 0, 100, DEFAULTS.keepVersions),
    autoDownloadNode: merged.autoDownloadNode !== false,
    mcpEnabled: merged.mcpEnabled !== false,
    mcpAutoStart: merged.mcpAutoStart !== false,
    disabledTools: Array.isArray(merged.disabledTools)
      ? [...new Set(merged.disabledTools.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim()))].sort()
      : [],
  };
}

let cachedConfig;

export function loadConfig() {
  if (cachedConfig) return cachedConfig;
  cachedConfig = normalizeConfig(readJson(configPath(), {}));
  return cachedConfig;
}

export function saveConfig(patch = {}) {
  const next = normalizeConfig({ ...loadConfig(), ...patch });
  atomicWriteJson(configPath(), next);
  cachedConfig = next;
  return next;
}

export function resetConfig() {
  atomicWriteJson(configPath(), DEFAULTS);
  cachedConfig = { ...DEFAULTS };
  return cachedConfig;
}

export function effectiveMirrors(config = loadConfig()) {
  return mergeMirrors(config.mirrors);
}

export function loadActive() {
  const value = readJson(activePath(), null);
  if (!value || typeof value !== 'object' || typeof value.version !== 'string') return null;
  return value;
}

export function saveActive(record) {
  atomicWriteJson(activePath(), record);
  return record;
}

export function clearActive() {
  try {
    rmSync(activePath(), { force: true });
  } catch {
    /* ignore */
  }
}

export function loadCatalogCache() {
  return readJson(catalogPath(), null);
}

export function saveCatalogCache(value) {
  atomicWriteJson(catalogPath(), value);
  return value;
}

export function loadHealth() {
  const value = readJson(healthPath(), {});
  return value && typeof value === 'object' ? value : {};
}

export function saveHealth(value) {
  atomicWriteJson(healthPath(), value);
  return value;
}

export { defaultMirrors, ensureDirs };
