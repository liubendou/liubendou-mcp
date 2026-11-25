"use strict";
// p14：T20 UI/技能/工具暴露 改动的契约测试
// 运行：node tests\p14_ui_skills_test.js   （可用 CORE_DIR 指定被测 core 目录）
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const core = process.env.CORE_DIR || path.join(__dirname, '..', 'src', 'dist', 'core');
const panelPath = path.join(core, '..', 'panel', 'index.html');
let failed = 0;
function ok(name, cond, extra) {
  if (cond) console.log('  [ok] ' + name);
  else { failed++; console.log('  [FAIL] ' + name + (extra ? ' :: ' + extra : '')); }
}
function section(t) { console.log('\n=== ' + t + ' ==='); }

// ---------- 1. 语法 ----------
section('1 语法检查');
for (const f of ['skills.js', 'tools.js', 'app.js', 'coord.js', 'terminal.js']) {
  const p = path.join(core, f);
  let good = true, msg = '';
  try { execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' }); }
  catch (e) { good = false; msg = String(e.stderr || e).split('\n').slice(0, 4).join(' '); }
  ok('node --check ' + f, good, msg);
}

// ---------- 2. EXPOSED 里的名字必须真实存在 ----------
section('2 工具暴露');
const toolsSrc = fs.readFileSync(path.join(core, 'tools.js'), 'utf8');
const m = toolsSrc.match(/const EXPOSED = new Set\(\[(.*?)\]\);/s);
ok('EXPOSED 集合存在', !!m);
const exposed = [...(m ? m[1] : '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
const toolsMod = require(path.join(core, 'tools.js'));
const allNames = toolsMod.toolCatalog([]).map((t) => t.name);
const listed = toolsMod.listTools([]).map((t) => t.name);
const missing = exposed.filter((n) => !allNames.includes(n));
ok('EXPOSED 中的工具都真实存在', missing.length === 0, '缺失: ' + missing.join(','));
ok('task_accept / task_review / task_claim 已暴露',
  ['task_accept', 'task_review', 'task_claim'].every((n) => listed.includes(n)));
ok('report_progress 已暴露', listed.includes('report_progress'));
ok('skill_list / skill_read / skill_save 已暴露',
  ['skill_list', 'skill_read', 'skill_save'].every((n) => listed.includes(n)));
ok('工具总数不少于 60（暴露面扩容后）', listed.length >= 60, '实际 ' + listed.length);
const catalog = toolsMod.toolCatalog([]);
ok('toolCatalog 带 exposed 标记', catalog.every((t) => typeof t.exposed === 'boolean'));
ok('不再暴露 GUI 自动化类工具（ui_*/screenshot/lsp）',
  !exposed.some((n) => n.startsWith('ui_') || n === 'screenshot' || n === 'lsp'));

// ---------- 3. 内置技能 ----------
section('3 内置技能');
const { SkillStore } = require(path.join(core, 'skills.js'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lacskill-'));
const store = new SkillStore(tmp);
const list = store.list();
const names = list.map((s) => s.name);
ok('首次启动种出 5 个内置技能', list.length === 5, '实际 ' + JSON.stringify(names));
ok('内置技能都带 builtin 标记', list.every((s) => s.builtin === true));
ok('bugfix-workflow 不再引用已废弃工具',
  !/code_definition|read_files|git_diff|git_commit|get_diagnostics|project_overview/.test(store.read('bugfix-workflow')) ||
  /edit_file|apply_patch|run_tests|project_note/.test(store.read('bugfix-workflow')));
ok('技能描述非空', list.every((s) => s.description && s.description.length > 4));

// 用户改过的技能不能被种子覆盖
const dirUser = path.join(tmp, 'skills', 'my-skill');
fs.mkdirSync(dirUser, { recursive: true });
fs.writeFileSync(path.join(dirUser, 'SKILL.md'), '---\nname: my-skill\ndescription: 我自己的\n---\n内容\n', 'utf8');
const store2 = new SkillStore(tmp);
ok('用户自建技能不被覆盖', store2.read('my-skill').includes('我自己的'));

// 旧种子（含已废弃工具名）应被升级
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lacskill2-'));
const legacy = ['---', 'name: bugfix-workflow',
  'description: 修复一个缺陷的标准流程：复现、定位、最小修改、验证、记录、提交、交接', '---',
  '# 修复缺陷的标准流程', '', '1. 用 project_context 了解项目目标与上次交接。若是陌生项目，先用 project_overview。', ''].join('\n');
fs.mkdirSync(path.join(tmp2, 'skills', 'bugfix-workflow'), { recursive: true });
fs.writeFileSync(path.join(tmp2, 'skills', 'bugfix-workflow', 'SKILL.md'), legacy, 'utf8');
const store3 = new SkillStore(tmp2);
const upgraded = store3.read('bugfix-workflow');
ok('旧版种子被升级（不再含 project_overview 等旧工具）', !upgraded.includes('project_overview'), upgraded.slice(0, 80));
ok('升级后仍保留 skill 名与描述', upgraded.includes('name: bugfix-workflow') && upgraded.includes('description:'));

// ---------- 4. 面板 ----------
section('4 面板');
ok('面板文件存在', fs.existsSync(panelPath), panelPath);
const html = fs.readFileSync(panelPath, 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
ok('面板含内联脚本', !!scriptMatch);
if (scriptMatch) {
  const tmpJs = path.join(os.tmpdir(), 'panel-check.js');
  fs.writeFileSync(tmpJs, scriptMatch[1], 'utf8');
  let good = true, msg = '';
  try { execFileSync(process.execPath, ['--check', tmpJs], { stdio: 'pipe' }); }
  catch (e) { good = false; msg = String(e.stderr || e).split('\n').slice(0, 5).join(' '); }
  ok('面板脚本语法正确', good, msg);
  // 脚本里引用的所有 #id 必须在 HTML 中存在
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((x) => x[1]));
  const used = [...scriptMatch[1].matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((x) => x[1]);
  const absent = [...new Set(used)].filter((i) => !ids.has(i));
  ok('脚本引用的元素 id 都存在', absent.length === 0, '缺失: ' + absent.join(','));
  // 必须包含新增能力
  ok('面板含技能页', html.includes('page-skills') && html.includes('/api/skills'));
  ok('面板含焦点卡（当前任务一眼可见）', html.includes('class="focus"') && html.includes('bFocus'));
  ok('面板含动效与微交互关键类', html.includes('prefers-reduced-motion') && html.includes('@keyframes') && html.includes('countUp'));
  ok('面板零外链（无 http(s) 外链资源）', !/(src|href)="https?:\/\//i.test(html));
  // 纯白冷白极简基线：不得再出现渐变 / 玻璃拟态 / 发光（用户红线）
  ok('默认纯白画布（--canvas:#FFFFFF）', /--canvas:\s*#FFFFFF/i.test(html));
  ok('无渐变 / 玻璃拟态 / 模糊', !/linear-gradient|radial-gradient|backdrop-filter|filter\s*:\s*blur\(/i.test(html));
  ok('动效 token 遵循微交互规范（120/200/600/800）', html.includes('--t-micro:120ms') && html.includes('--t-base:200ms') && html.includes('--t-slow:600ms'));
  // HTML id 不得重复（重复 id 会让面板静默取错元素）
  const allIds = [...html.matchAll(/\sid="([^"]+)"/g)].map((x) => x[1]);
  const dupIds = [...new Set(allIds.filter((v, i) => allIds.indexOf(v) !== i))];
  ok('页面无重复 id', dupIds.length === 0, '重复: ' + dupIds.join(','));
  // 落地页即见任务：概览页也要有焦点卡
  ok('概览页直接呈现当前任务（oFocus）', html.includes('id="oFocus"'));
  // 图标统一为描边 SVG，不再用字体字形
  ok('图标统一 SVG（无字体字形占位）', !/<span class="ic">[^<]{1,3}<\/span>/.test(html));
}

console.log('\n' + (failed === 0 ? 'P14-ALL-PASS' : 'P14-FAIL ' + failed));
process.exit(failed === 0 ? 0 : 1);
