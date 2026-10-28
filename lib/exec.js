/**
 * Process + HTTP primitives.
 *
 * Every network-touching operation in this plugin funnels through here so the
 * mirror chain, timeouts and logging behave identically for git, npm and Node
 * binary downloads.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { logsDir } from './paths.js';

/** Run a command, capture stdout/stderr, never throw on a non-zero exit. */
export function run(command, args, options = {}) {
  const {
    cwd,
    env,
    timeoutMs = 120000,
    signal,
    input,
  } = options;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: { ...process.env, ...(env ?? {}) },
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error), error });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish({ code: -2, stdout, stderr: `${stderr}\n[timeout after ${timeoutMs} ms]` });
    }, timeoutMs);
    if (timer.unref) timer.unref();
    const onAbort = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish({ code: -3, stdout, stderr: `${stderr}\n[aborted]` });
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 8 * 1024 * 1024) stdout = stdout.slice(-4 * 1024 * 1024);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 4 * 1024 * 1024) stderr = stderr.slice(-2 * 1024 * 1024);
    });
    child.on('error', (error) => finish({ code: -1, stdout, stderr: `${stderr}\n${String(error?.message ?? error)}`, error }));
    child.on('close', (code) => finish({ code: code ?? 0, stdout, stderr }));
    if (input !== undefined && child.stdin) {
      try {
        child.stdin.end(input);
      } catch {
        /* ignore */
      }
    } else {
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
    }
  });
}

/** Append one line to the plugin log; logging never breaks an operation. */
export function log(line) {
  try {
    mkdirSync(logsDir(), { recursive: true });
    const stamp = new Date().toISOString();
    appendFileSync(path.join(logsDir(), 'dsh-rea-manager.log'), `${stamp} ${line}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

/** Fetch a URL with a hard timeout; returns `{ ok, status, body, headers }`. */
export async function httpGet(url, options = {}) {
  const { timeoutMs = 60000, headers = {}, method = 'GET', signal } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  if (timer.unref) timer.unref();
  const onAbort = () => controller.abort(new Error('aborted'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await fetch(url, {
      method,
      headers: { 'user-agent': 'dsh-rea-manager/0.1 (+deepseek-harness)', ...headers },
      signal: controller.signal,
      redirect: 'follow',
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch JSON with a timeout, throwing a compact diagnostic on failure. */
export async function httpJson(url, options = {}) {
  const response = await httpGet(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return await response.json();
}

/** Fetch a binary body with a size ceiling. */
export async function httpBuffer(url, options = {}) {
  const { maxBytes = 512 * 1024 * 1024 } = options;
  const response = await httpGet(url, options);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
  return buffer;
}

/** Time-box a promise; resolves `{ timedOut, value }` instead of throwing. */
export async function withTimeout(promise, timeoutMs, label = 'operation') {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true, value: undefined }), timeoutMs);
    if (timer.unref) timer.unref();
  });
  try {
    const value = await Promise.race([promise, timeout]);
    if (value && typeof value === 'object' && 'timedOut' in value) return value;
    return { timedOut: false, value };
  } catch (error) {
    return { timedOut: false, value: undefined, error: error instanceof Error ? error : new Error(`${label}: ${String(error)}`) };
  } finally {
    clearTimeout(timer);
  }
}
