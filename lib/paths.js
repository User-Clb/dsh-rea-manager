/**
 * Path resolution for dsh-rea-manager.
 *
 * Everything the plugin owns lives under one store root so that install,
 * rollback and mirror health survive harness restarts:
 *
 *   <DSH_HOME>/dsh-rea-manager/
 *     config.json          user configuration (mirrors, node, source preference)
 *     active.json          currently activated REA runtime
 *     catalog.json         cached version catalog (git tags + npm versions)
 *     mirrors-health.json  last probe result per mirror
 *     versions/<v>/        one installed REA runtime per version
 *     git/                 partial clone used for tag listing and source builds
 *     logs/                install / probe logs
 */
import os from 'node:os';
import path from 'node:path';

export function dshHome() {
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
}

export function storeRoot() {
  return path.join(dshHome(), 'dsh-rea-manager');
}

export function storePath(...parts) {
  return path.join(storeRoot(), ...parts);
}

export function versionsDir() {
  return storePath('versions');
}

export function gitCacheDir() {
  return storePath('git');
}

export function logsDir() {
  return storePath('logs');
}

export function configPath() {
  return storePath('config.json');
}

export function activePath() {
  return storePath('active.json');
}

export function catalogPath() {
  return storePath('catalog.json');
}

export function healthPath() {
  return storePath('mirrors-health.json');
}

/** Canonical upstream repository (unmirrored form). */
export const UPSTREAM_REPO = 'https://github.com/morluto/rea.git';

/** NPM package that ships the same release with a prebuilt `dist/`. */
export const NPM_PACKAGE = 'rea-agents';
