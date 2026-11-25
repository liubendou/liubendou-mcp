"use strict";
// Isolated verification of the three patched fixes, against the LIVE core on the target machine.
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = process.argv[2] || process.env.CORE_DIR || path.join(__dirname, '..', 'src', 'dist', 'core');
const toolsMod = require(path.join(core, 'tools.js'));
const coord = require(path.join(core, 'coord.js'));
const termMod = require(path.join(core, 'terminal.js'));

const results = [];
function check(id, pass, detail) {
  results.push({ id, pass, detail: String(detail) });
  console.log((pass ? 'PASS ' : 'FAIL ') + id + ' :: ' + detail);
}
(async () => {
  // ---------- A: command_cancel advertised in tools/list ----------
  const names = toolsMod.listTools().map((t) => t.name);
  check('A1_command_cancel_listed', names.includes('command_cancel'), 'tool count=' + names.length);
  let cat = toolsMod.toolCatalog;
  if (typeof cat === 'function') cat = cat([]);
  let arr = [];
  if (Array.isArray(cat)) arr = cat;
  else if (cat && typeof cat.values === 'function') arr = Array.from(cat.values());
  else if (cat && typeof cat === 'object') arr = Object.values(cat);
  console.log('   catalog_type=' + (Array.isArray(cat) ? 'array' : typeof cat) + ' entries=' + arr.length);
  const listed = toolsMod.listTools([]);
  const pick = (n) => listed.find((t) => t && t.name === n);
  const wf = pick('write_file');
  const wfProps = Object.keys((wf && wf.inputSchema && wf.inputSchema.properties) || {});
  check('A2_write_file_has_agent_id', wfProps.includes('agent_id'), 'props=' + wfProps.join(','));
  const ap = pick('apply_patch');
  check('A4_apply_patch_has_agent_id', Object.keys((ap && ap.inputSchema && ap.inputSchema.properties) || {}).includes('agent_id'), 'ok');
  // edit_file is not in the exposed catalog -> verify its schema block straight from the source
  const src = fs.readFileSync(path.join(core, 'tools.js'), 'utf8');
  const ei = src.indexOf("name: 'edit_file'");
  const es = src.indexOf('inputSchema: obj({', ei);
  const ee = src.indexOf('handler:', es);
  const eblock = src.slice(es, ee);
  check('A3_edit_file_has_agent_id', eblock.indexOf('agent_id') >= 0, 'edit_file schema block=' + eblock.replace(/\s+/g, ' ').slice(0, 160));

  // ---------- B: reservation guard actually bites ----------
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laccoord-'));
  coord.init(dataDir);
  const byName = {};
  for (const t of coord.makeTools()) byName[t.name] = t;
  const ctx = { dataDir, promptVersion: 'test', cfg: { get: () => ({ workspaceRoots: [dataDir] }) } };
  const regA = await byName.agent_register.handler({ name: 'A1', role: 'worker' }, ctx);
  const regB = await byName.agent_register.handler({ name: 'B1', role: 'worker' }, ctx);
  const a1 = String(regA).match(/ag_[a-z0-9]+/)[0];
  const b1 = String(regB).match(/ag_[a-z0-9]+/)[0];
  const reserved = path.join(dataDir, 'reserved.txt');
  const other = path.join(dataDir, 'other.txt');
  fs.writeFileSync(reserved, 'hello');
  fs.writeFileSync(other, 'hello');

  const rt = byName.reserve_files;
  const rprops = rt.inputSchema.properties || {};
  const pkey = Object.keys(rprops).find((k) => /path|file/i.test(k));
  const isArr = String(rprops[pkey].type).indexOf('array') >= 0;
  const rargs = { agent_id: a1 };
  rargs[pkey] = isArr ? [reserved] : reserved;
  const rres = await rt.handler(rargs, ctx);
  console.log('   reserve_files(' + pkey + ') -> ' + String(rres).slice(0, 160).replace(/\n/g, ' | '));

  function guardExpect(name, input, shouldThrow, label) {
    let threw = false, msg = '';
    try { coord.guardWrite(name, input, ctx); } catch (e) { threw = true; msg = String(e.message).slice(0, 120).replace(/\n/g, ' | '); }
    check(label, threw === shouldThrow, 'threw=' + threw + ' expect=' + shouldThrow + ' ' + msg);
  }
  guardExpect('write_file', { path: reserved }, true, 'B1_no_agent_id_blocked');
  guardExpect('write_file', { path: reserved, agent_id: b1 }, true, 'B2_other_agent_blocked');
  guardExpect('write_file', { path: reserved, agent_id: a1 }, false, 'B3_owner_allowed');
  guardExpect('write_file', { path: other }, false, 'B4_unreserved_allowed');
  guardExpect('read_file', { path: reserved }, false, 'B5_read_not_blocked');

  // ---------- C: native exit code fidelity ----------
  function mkCmds() {
    let n = 0;
    return {
      createJob(command, cwd) {
        const job = { id: 'j' + (++n), command, cwd, output: '', status: 'running', exitCode: null };
        job.done = new Promise((r) => { job._r = r; });
        return job;
      },
      appendOutput(job, t) { job.output += t; },
      finishJob(job, status, code) { job.status = status; job.exitCode = code; if (job._r) job._r(job); },
    };
  }
  const term = new termMod.PersistentTerminal(mkCmds(), () => dataDir);
  const isWin = process.platform === 'win32';
  const cases = isWin
    ? [['cmd /c exit 5', 5], ['cmd /c exit 0', 0], ['cmd /c exit 42', 42], ['Write-Output hello', 0]]
    : [['exit 5', 5], ['exit 0', 0], ['exit 42', 42], ['echo hello', 0]];
  for (const [cmd, want] of cases) {
    const job = await term.exec(cmd, undefined, 20000);
    check('C_' + cmd.replace(/\W+/g, '_') + '=' + want, job.exitCode === want,
      'status=' + job.status + ' exit=' + job.exitCode + ' want=' + want + ' out=' + JSON.stringify(job.output.slice(0, 60)));
  }
  term.stop();

  const bad = results.filter((r) => !r.pass);
  console.log('SUMMARY total=' + results.length + ' failed=' + bad.length);
  console.log(bad.length ? 'VERIFY_FAILED' : 'VERIFY_ALL_PASS');
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('VERIFY_ERROR ' + (e && e.stack ? e.stack : e)); process.exit(2); });
