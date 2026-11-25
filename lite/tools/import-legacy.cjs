const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const target = path.resolve(__dirname, '../legacy');
fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(path.join(target, 'package.json'), '{"type":"commonjs"}\n');
for (const name of ['security', 'fileOps', 'patch', 'commands', 'devtools']) {
  fs.copyFileSync(path.join(root, 'src/dist/core', name + '.js'), path.join(target, name + '.js'));
}
const app = fs.readFileSync(path.join(root, 'src/dist/core/app.js'), 'utf8');
const match = app.match(/const defaultHead = (\[[\s\S]*?\])\.join\('\\n'\);/);
if (!match) throw new Error('Legacy prompt not found');
const defaultPrompt = vm.runInNewContext(match[1]).join('\n');
const bridge = fs.readFileSync(path.join(root, 'src/dist/core/agentBridge.js'), 'utf8');
const bridgeFunction = bridge.slice(bridge.indexOf('function buildHandshakePrompt('), bridge.indexOf('\nfunction createAgentBridge('));
const bridgePrompt = vm.runInNewContext('(' + bridgeFunction + ')', { node_os_1: { default: require('node:os') } })({ cfg: { get: () => ({ workspaceRoots: ['__WORKSPACE__'], allowOutsideWorkspace: false }) } });
let saved = { promptMain: '', customInstructions: '', promptProject: {}, workspaceRoots: [] };
const configFile = path.join(process.env.APPDATA || '', 'LocalAIConsole/config.json');
if (fs.existsSync(configFile)) {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  saved = { promptMain: config.promptMain || '', customInstructions: config.customInstructions || '', promptProject: config.promptProject || {}, workspaceRoots: config.workspaceRoots || [] };
}
fs.writeFileSync(path.join(target, 'prompts.json'), JSON.stringify({ defaultPrompt, bridgePrompt, ...saved }, null, 2));
process.stdout.write('Copied five standalone tool modules and prompt fields; credentials excluded.\n');
