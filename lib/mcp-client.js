/**
 * MCP stdio client for the REA server.
 *
 * REA advertises ~229 tools whose combined schema is ~300 KB (compact profile)
 * to ~3.5 MB (full profile). Bridging all of them as native DSH tools would
 * consume the model's entire tool budget, so this client exposes a small,
 * stable facade instead:
 *
 *   rea_tools        list / search REA's tool catalog
 *   rea_tool_schema  read one tool's full input schema on demand
 *   rea_call         invoke one REA tool with JSON arguments
 *
 * The wire protocol is JSON-RPC 2.0 over newline-delimited JSON on stdin/stdout,
 * implemented here directly so the plugin has no runtime dependency beyond Node
 * itself. The child is supervised: one lazy start, a request timeout per call,
 * and automatic restart after a crash.
 */
import { spawn } from 'node:child_process';

import { loadConfig } from './config.js';
import { log } from './exec.js';

const PROTOCOL_VERSION = '2025-06-18';

class ReaSession {
  constructor({ nodePath, entry, cwd, env }) {
    this.nodePath = nodePath;
    this.entry = entry;
    this.cwd = cwd;
    this.env = env;
    this.child = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.tools = null;
    this.starting = null;
    this.closed = false;
    this.serverInfo = null;
  }

  async ensureStarted() {
    if (this.tools) return this;
    if (this.starting) return await this.starting;
    this.starting = this.#start();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async #start() {
    const config = loadConfig();
    const env = {
      ...process.env,
      ...config.env,
      REA_MCP_INPUT_SCHEMA_PROFILE: config.inputSchemaProfile,
      REA_MCP_OUTPUT_SCHEMA_PROFILE: config.outputSchemaProfile,
      REA_LOG_LEVEL: process.env.REA_LOG_LEVEL ?? 'warn',
    };
    let child;
    try {
      child = spawn(this.nodePath, [this.entry, 'mcp'], {
        cwd: this.cwd,
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(`cannot start REA MCP server: ${String(error?.message ?? error)}`);
    }
    this.child = child;
    // A missing runtime (deleted store, moved install) surfaces as an async
    // 'error' event. Without this listener Node raises it as an uncaught
    // exception and takes the whole harness host down.
    child.on('error', (error) => {
      const reason = `cannot start REA MCP server (${String(error?.code ?? 'error')}): ${String(error?.message ?? error)}`;
      log(reason);
      this.tools = null;
      this.child = null;
      this.serverInfo = null;
      for (const [, waiter] of this.pending) waiter.reject(new Error(reason));
      this.pending.clear();
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) log(`[rea stderr] ${text.slice(-2000)}`);
    });
    child.on('exit', (code, signal) => {
      const reason = `REA MCP server exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`;
      log(reason);
      this.tools = null;
      this.child = null;
      this.serverInfo = null;
      for (const [, waiter] of this.pending) {
        waiter.reject(new Error(reason));
      }
      this.pending.clear();
      if (!this.closed && loadConfig().mcpAutoReconnect) {
        setTimeout(() => {
          this.ensureStarted().catch((error) => log(`reconnect failed: ${String(error?.message ?? error)}`));
        }, 1500).unref?.();
      }
    });

    const started = Date.now();
    const init = await this.#request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dsh-rea-manager', version: '0.1.0' },
    }, config.mcpStartupTimeoutMs);
    this.serverInfo = init?.serverInfo ?? null;
    this.#notify('notifications/initialized', {});
    const list = await this.#request('tools/list', {}, config.mcpStartupTimeoutMs);
    this.tools = Array.isArray(list?.tools) ? list.tools : [];
    log(`REA MCP ready in ${Date.now() - started} ms: ${this.tools.length} tools, server ${this.serverInfo?.name ?? '?'} ${this.serverInfo?.version ?? '?'}`);
    return this;
  }

  #onData(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 32 * 1024 * 1024) this.buffer = this.buffer.slice(-8 * 1024 * 1024);
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        log(`[rea] non-JSON stdout: ${line.slice(0, 200)}`);
        continue;
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) {
          const error = new Error(`REA ${waiter.method} failed: ${message.error.message ?? 'unknown error'}`);
          error.code = message.error.code;
          error.data = message.error.data;
          waiter.reject(error);
        } else {
          waiter.resolve(message.result);
        }
      }
    }
  }

  #write(payload) {
    if (!this.child?.stdin?.writable) throw new Error('REA MCP server is not running');
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  #notify(method, params) {
    try {
      this.#write({ jsonrpc: '2.0', method, params });
    } catch (error) {
      log(`notify ${method} failed: ${String(error?.message ?? error)}`);
    }
  }

  #request(method, params, timeoutMs, signal) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`REA ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`REA ${method} aborted`));
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.pending.set(id, {
        method,
        resolve: (value) => {
          signal?.removeEventListener?.('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener?.('abort', onAbort);
          reject(error);
        },
        timer,
      });
      try {
        this.#write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async callTool(name, args, options = {}) {
    await this.ensureStarted();
    const config = loadConfig();
    const timeoutMs = options.timeoutMs ?? config.mcpToolTimeoutMs;
    return await this.#request('tools/call', { name, arguments: args ?? {} }, timeoutMs, options.signal);
  }

  listTools() {
    return this.tools ?? [];
  }

  async close() {
    this.closed = true;
    const child = this.child;
    this.child = null;
    this.tools = null;
    if (!child) return;
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve();
      }, 4000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}

let session = null;

/** Current session, or a freshly started one. */
export async function getSession(runtime) {
  if (session) {
    if (runtime && session.entry !== runtime.entry) {
      await session.close();
      session = null;
    } else {
      return session;
    }
  }
  if (!runtime) throw new Error('no active REA runtime: run rea_install or rea_activate first');
  session = new ReaSession({
    nodePath: runtime.nodePath,
    entry: runtime.entry,
    cwd: runtime.dir,
    env: {},
  });
  await session.ensureStarted();
  return session;
}

export async function closeSession() {
  if (!session) return;
  const current = session;
  session = null;
  await current.close();
}

export function sessionState() {
  if (!session) return { running: false, tools: 0, serverInfo: null };
  return {
    running: session.child !== null && session.tools !== null,
    tools: session.listTools().length,
    serverInfo: session.serverInfo,
  };
}

/** Flatten an MCP tool result into text plus the raw blocks. */
export function flattenResult(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const texts = [];
  const images = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block.type === 'image') images.push({ mimeType: block.mimeType ?? 'image/png', bytes: block.data ?? '' });
    else if (block.type === 'resource' && block.resource) texts.push(`[resource] ${block.resource.uri ?? ''}`);
    else texts.push(JSON.stringify(block));
  }
  return {
    text: texts.join('\n\n'),
    images,
    structured: result?.structuredContent ?? null,
    isError: result?.isError === true,
  };
}

export { ReaSession };
