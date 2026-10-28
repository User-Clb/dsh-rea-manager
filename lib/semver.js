/**
 * Minimal semver helpers — enough for ordering REA releases, never a full
 * implementation. Handles `1.2.3`, `1.2.3-beta.4`, and `v` prefixes.
 */

export function parseVersion(input) {
  const text = String(input ?? '').trim().replace(/^v/u, '');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(text);
  if (!match) return null;
  return {
    raw: text,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
  };
}

export function isVersion(input) {
  return parseVersion(input) !== null;
}

/** Negative when `left < right`, 0 when equal, positive when `left > right`. */
export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === '') return 1;
  if (b.prerelease === '') return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

export function sortVersionsDescending(list) {
  return [...list].sort((left, right) => compareVersions(right, left));
}

/** Split `rea-agents-6.8.0` / `v6.8.0` / `6.8.0` into a bare version. */
export function versionFromTag(tag) {
  const text = String(tag ?? '').trim();
  const patterns = [/^rea-agents-(.+)$/u, /^rea-(.+)$/u, /^v?(.+)$/u];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && isVersion(match[1])) return match[1];
  }
  return null;
}

export function tagForVersion(version) {
  return `rea-agents-${version}`;
}

/** Node version satisfying REA's `engines` requirement (^22.23.4 || ^24.22.1 || >=26.12.1). */
export function nodeSatisfiesRea(version) {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  if (parsed.major === 22) return compareVersions(parsed.raw, '22.23.4') >= 0 && parsed.prerelease === '';
  if (parsed.major === 24) return compareVersions(parsed.raw, '24.22.1') >= 0;
  if (parsed.major >= 26) return parsed.major > 26 || compareVersions(parsed.raw, '26.12.1') >= 0;
  return false;
}
