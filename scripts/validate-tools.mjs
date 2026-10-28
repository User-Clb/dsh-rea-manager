// Validate every tool schema against the real dsh-tools JSON-schema subset,
// using the same assertSupportedJsonSchema the registry calls.
const toolsPath = 'file:///C:/Users/Revision-Extra/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools/lib/index.js';

const { assertSupportedJsonSchema } = await import(toolsPath);
const registered = [];
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  systemPrompt: { section() {} },
  tools: {
    register(definition) {
      registered.push(definition);
      return () => {};
    },
    guard() { return () => {}; },
  },
  attachments: { async saveImage() { return { id: 'x' }; } },
  inject() {},
  effect() {},
};

const mod = await import('file:///G:/laboratory/dsh-rea-manager/index.js');
const dispose = mod.apply(ctx);
await new Promise((resolve) => setTimeout(resolve, 200));
console.log(`registered ${registered.length} tools: ${registered.map((t) => t.name).join(', ')}`);

let failures = 0;
for (const tool of registered) {
  try {
    assertSupportedJsonSchema(tool.parameters);
    assertSupportedJsonSchema(tool.output.schema);
    if (typeof tool.output.render !== 'function') throw new Error('missing output.render');
    if (typeof tool.execute !== 'function') throw new Error('missing execute');
    console.log(`ok   ${tool.name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${tool.name}: ${String(error?.message ?? error)}`);
  }
}
if (typeof dispose === 'function') await dispose();
console.log(failures === 0 ? 'ALL SCHEMAS OK' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
