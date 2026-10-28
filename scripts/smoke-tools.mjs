// Functional smoke test: drive every registered tool through the same ctx the
// harness would provide, and check the canonical values against output.schema.
const toolsPath = 'file:///C:/Users/Revision-Extra/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(toolsPath);

const registered = new Map();
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  systemPrompt: { section() {} },
  tools: {
    register(definition) {
      registered.set(definition.name, definition);
      return () => registered.delete(definition.name);
    },
    guard() { return () => {}; },
  },
  attachments: { async saveImage() { return { id: 'img' }; } },
  inject() {},
  effect() {},
};

const mod = await import('file:///G:/laboratory/dsh-rea-manager/index.js');
mod.apply(ctx);
await new Promise((resolve) => setTimeout(resolve, 100));

const only = process.argv[2];
const signal = AbortSignal.timeout(600000);

async function call(name, args) {
  const tool = registered.get(name);
  if (!tool) throw new Error(`no such tool ${name}`);
  const started = Date.now();
  try {
    const value = await tool.execute(args ?? {}, { signal, arguments: args ?? {}, name });
    const problems = validateJsonSchemaValue(tool.output.schema, value);
    const summary = typeof value?.summary === 'string' ? value.summary.split('\n').slice(0, 8).join('\n') : '';
    console.log(`\n=== ${name} (${Date.now() - started} ms) ${problems.length === 0 ? 'schema OK' : `SCHEMA FAIL: ${problems.join('; ')}`}`);
    console.log(summary.slice(0, 1600));
    return value;
  } catch (error) {
    console.log(`\n=== ${name} THREW after ${Date.now() - started} ms: ${String(error?.message ?? error).slice(0, 600)}`);
    return null;
  }
}

const plan = only ? [only] : ['rea_status', 'rea_versions', 'rea_tools', 'rea_tool_schema', 'rea_call', 'rea_mirrors', 'rea_config', 'rea_rollback', 'rea_update', 'rea_uninstall', 'rea_install'];

for (const name of plan) {
  if (name === 'rea_tool_schema') await call(name, { tool: 'binary_session' });
  else if (name === 'rea_call') await call(name, { tool: 'inspect_analysis_settings', args: {} });
  else if (name === 'rea_tools') await call(name, { query: 'apk', limit: 5 });
  else if (name === 'rea_versions') await call(name, { query: '6.', limit: 8 });
  else if (name === 'rea_config') await call(name, { get: true });
  else await call(name, {});
}
console.log('\nDONE');
// The MCP child keeps the loop alive; the smoke test is finished here.
setTimeout(() => process.exit(0), 50).unref?.();
process.exit(0);
