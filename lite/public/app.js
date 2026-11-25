'use strict';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => {
  const shapes = {copy:'<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4"/>',edit:'<path d="m16 3 5 5-12 12-6 1 1-6zM13 6l5 5"/>',arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>',plus:'<path d="M12 5v14M5 12h14"/>',export:'<path d="M12 3v12m-4-4 4 4 4-4M5 15v5h14v-5"/>',link:'<path d="m10 13 4-4m-6 6-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m-1 3 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(2 1)"/>'};
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[name] || shapes.arrow}</svg>`;
};
const kinds = {note:'笔记',decision:'关键决定',gotcha:'踩坑记录',convention:'约定',requirement:'用户要求'};
const statuses = {active:'进行中',paused:'已暂停',done:'已完成',archived:'已归档'};
const state = {tasks:[],id:localStorage.getItem('lbd-task') || '',context:null,view:'overview',status:null,memories:[],tools:[],events:[],archived:false};
let toastTimer;
let memoryRequest=0;
let renderRequest=0;
const nativeRequests=new Map();
const hasNativeBridge=()=>Boolean(window.chrome?.webview||window.webkit?.messageHandlers?.liubendou);
function nativeResponse(data){const item=nativeRequests.get(data.id);if(!item)return;nativeRequests.delete(data.id);clearTimeout(item.timer);if(data.error)item.reject(new Error(data.error));else item.resolve(data.result);}
if(window.chrome?.webview)window.chrome.webview.addEventListener('message',event=>nativeResponse(event.data));
window.liubendouNativeResponse=nativeResponse;
function nativeRequest(type,payload={}) {
  return new Promise((resolve,reject)=>{
    const id=crypto.randomUUID();const timer=setTimeout(()=>{nativeRequests.delete(id);reject(new Error('桌面操作没有响应，请重试。'));},['pick-folder','license'].includes(type)?3600000:10000);
    if(!hasNativeBridge()){clearTimeout(timer);reject(new Error('当前窗口没有桌面连接。'));return;}
    nativeRequests.set(id,{resolve,reject,timer});
    if(window.chrome?.webview)window.chrome.webview.postMessage({id,type,...payload});else window.webkit.messageHandlers.liubendou.postMessage({id,type,...payload});
  });
}
const date = value => new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
const age = value => {
  const minutes=Math.max(0,Math.floor((Date.now()-new Date(value))/60000));
  return minutes<1?'刚刚更新':minutes<60?`${minutes} 分钟前更新`:minutes<1440?`${Math.floor(minutes/60)} 小时前更新`:`${Math.floor(minutes/1440)} 天前更新`;
};
function toast(message) { clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').classList.add('visible');toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3200); }
async function api(route,method='GET',data) {
  const response=await fetch(route,{method,headers:method==='GET'?{}:{'content-type':'application/json','x-lbd-panel':'1'},body:data===undefined?undefined:JSON.stringify(data)});
  const result=await response.json();if(!response.ok)throw new Error(result.error || '请求失败');return result;
}
function taskApi(action='') { return `/api/tasks/${state.id}${action?'/'+action:''}`; }
function setModal(html) { $('#modal-content').innerHTML=html; if(!$('#modal').open)$('#modal').showModal(); }
function modalHead(title) {return `<div class="modal-header"><h2>${title}</h2><button class="ghost" data-action="close-modal" aria-label="关闭弹窗">×</button></div>`;}
async function copy(text,label='已复制，可以发给 Agent 了') {
  try {
    if(hasNativeBridge())await nativeRequest('clipboard',{text});
    else if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(text);
    else {
      const textarea=document.createElement('textarea');textarea.value=text;textarea.style.position='fixed';textarea.style.opacity='0';document.body.append(textarea);textarea.select();const success=document.execCommand('copy');textarea.remove();if(!success)throw new Error('clipboard');
    }
    toast(label);return true;
  }catch{
    setModal(modalHead('请手动复制')+`<div class="modal-body"><p class="modal-note">浏览器没有允许自动复制，请选中下方全文复制。</p><div class="field"><textarea class="prompt-preview" readonly aria-label="待复制的全文">${esc(text)}</textarea></div></div>`);
    $('#modal textarea').focus();$('#modal textarea').select();return false;
  }
}
function renderTasks() {
  const query=$('#task-filter').value.toLowerCase();
  const tasks=state.tasks.filter(t=>t.title.toLowerCase().includes(query));
  $('#task-count').textContent=String(state.tasks.length);
  $('#task-list').innerHTML=tasks.map(task=>`<button class="task-button ${task.id===state.id?'active':''}" data-action="select-task" data-id="${esc(task.id)}" aria-current="${task.id===state.id?'page':'false'}"><span class="task-dot ${esc(task.status)}"></span><span class="task-text"><strong>${esc(task.title)}</strong><small>${statuses[task.status]} · ${age(task.updated_at)}</small></span></button>`).join('') || '<div class="loading">还没有匹配的任务</div>';
  $('.nav-button').classList.toggle('active',state.view==='connection');
}
async function refreshTasks() {state.tasks=await api('/api/tasks'+(state.archived?'?archived=1':''));renderTasks();}
async function openTask(id,view='overview') {
  const request=++renderRequest;state.id=id;state.view=view;localStorage.setItem('lbd-task',id);renderTasks();
  const context=await api(taskApi());if(request!==renderRequest)return;state.context=context;await render();
}
function header() {
  const {task,pending,memory_count,overview}=state.context;
  return `<div class="eyebrow">TASK MEMORY <span class="subtle">/ ${esc(task.id.slice(0,8))}</span></div><div class="title-row"><h1>${esc(task.title)}</h1><div class="title-actions"><button class="ghost" data-action="edit-task" title="编辑任务" aria-label="编辑任务">${icon('edit')}</button><button class="secondary" data-action="preview-prompt">预览提示词</button><button class="primary" data-action="copy-agent">${icon('copy')}复制给 Agent</button></div></div><p class="goal">${esc(task.goal || '为这个任务写下目标，让下一次接手更清楚。')}</p><div class="meta-row"><span class="status-pill ${esc(task.status)}">● ${statuses[task.status]}</span><span class="meta-path" title="${esc(task.workspace)}">${esc(task.workspace)}</span>${task.demo?'<span class="demo-tag">示例任务</span>':''}</div><div class="overview-strip"><div class="strip-left"><span class="check-circle ${pending||!overview?'pending':''}">${pending||!overview?'↻':'✓'}</span><div><div class="strip-title">${pending?`${pending} 项关键变化，等待更新概况`:overview?'任务概况已覆盖当前记录':'还没有提交任务概况'}</div><div class="strip-sub">${pending?'原始记录已保存，接手时会一起带上。':overview?'下次接手，先从这份概况开始。':'工具活动会自动记录，关键结论可以单独保存。'}</div></div></div><div class="strip-right">${memory_count} 条记忆 · 本机保存</div></div><nav class="tabs" aria-label="任务内容">${[['overview','任务概况'],['memories','长期记忆'],['events','执行记录'],['tools','工具']].map(([key,label])=>`<button class="tab ${state.view===key?'active':''}" data-action="tab" data-view="${key}">${label}${key==='memories'?`<span class="tab-count">${memory_count}</span>`:''}</button>`).join('')}<button class="tab ${state.view==='connection'?'active':''}" data-action="connection">接入与提示词</button></nav>`;
}
function overviewView() {
  const {overview,memories,events,task}=state.context;
  const pinned=memories.filter(m=>m.pinned||m.kind==='decision'||m.kind==='requirement').slice(0,2);
  return `<div class="content-grid"><div><section class="card"><div class="card-header"><h2>这件事，做到哪里了</h2><button class="ghost" data-action="edit-overview">${icon('edit')}编辑概况</button></div><div class="card-body summary-body">${esc(overview?.summary || '尚未填写语义概况。任务目标和执行事实已经保存，可在右上角复制交接资料，交给 Agent 继续概括。')}</div><div class="summary-footer"><span>${overview?`最近概括于 ${date(overview.created_at)}`:'每个任务维护一份当前概况'} · 修订 ${overview?.covered_revision ?? 0}</span><button class="text-button" data-action="history">查看历史版本 ↗</button></div></section><div class="facts">${pinned.length?pinned.map(m=>`<div class="fact-card"><div class="fact-label">${kinds[m.kind]} · ${esc(m.key)}</div><div class="fact-value">${esc(m.value)}</div></div>`).join(''):`<div class="fact-card"><div class="fact-label">最近活动</div><div class="fact-value">${esc(events[0]?.detail || '还没有工具执行记录。')}</div></div>`}</div></div><div class="side-stack"><section class="card next-card"><div class="card-header"><h3>下一步</h3><span class="tiny-label">↗</span></div><div class="card-body">${esc(overview?.next || '先明确目标，再开始处理这个任务。')}</div></section><section class="card"><div class="card-header"><h3>阻塞与待确认</h3></div><div class="card-body fact-value">${esc(overview?.risks || '尚未记录。')}</div></section><div class="hint-card"><div class="hint-title">交给下一位 Agent</div>提示词会带上当前任务、概况和关键记忆。沿用你指定的授权连接与 curl 操作格式。<br><button class="text-button" data-action="copy-agent">复制交接提示词 →</button></div></div></div><div class="archive-row"><button class="text-button" data-action="export">导出此任务</button><span class="subtle">　·　</span><button class="text-button" data-action="archive">${task.status==='archived'?'恢复任务':'归档任务'}</button></div>`;
}
function memoryCards(items) {
  if(!items.length)return '<div class="empty full-width"><strong>给未来的自己留一点线索</strong>保存关键要求、决定和踩过的坑，下次接手就能找到。</div>';
  return items.map(m=>`<article class="memory-card"><div class="memory-top"><span class="kind ${esc(m.kind)}">${kinds[m.kind]||'笔记'}</span>${m.pinned?'<span class="pin">已置顶</span>':''}</div><h3>${esc(m.key)}</h3><div class="memory-value">${esc(m.value)}</div><div class="memory-bottom"><span>${date(m.updated_at)} · 第 ${m.version} 版</span><span class="memory-actions"><button class="text-button" data-action="edit-memory" data-key="${esc(m.key)}">编辑</button><button class="text-button" data-action="delete-memory" data-key="${esc(m.key)}">移除</button></span></div></article>`).join('');
}
function memoriesView() {return `<div class="section-row"><input class="search" id="memory-search" placeholder="搜索这个任务的记忆…" aria-label="搜索长期记忆"><button class="primary" data-action="new-memory">${icon('plus')}添加记忆</button></div><div id="memory-grid" class="memory-grid">${memoryCards(state.memories)}</div><div class="section-row"><span class="section-description">默认显示最近 50 条；输入关键词可以检索全部记忆。</span></div>`;}
function relayBanner(){
  const relay=state.status?.relay;
  return `<div id="relay-banner" class="relay-banner"><span><i class="${relay?.publicMcpUp?'online':'pending'}"></i>${relay?.publicMcpUp?'云端 Agent 可以连接这台电脑':esc(relay?.message||'正在读取连接状态')}</span><button class="text-button" data-action="connection">${relay?.configured?'连接详情 ↗':'激活云端连接 →'}</button></div>`;
}
function relayChecks(){const relay=state.status?.relay;return `<div class="relay-checks"><span>✓ 本机服务</span><span>${relay?.connected?'✓':'○'} 中转连接</span><span>${relay?.publicMcpUp?'✓':'○'} 公网 MCP 握手</span></div><p class="section-description">${esc(relay?.message||'尚未激活')}</p>`;}
function activationCard(){
  const relay=state.status?.relay;
  return `<section class="card top-spaced"><div class="card-header"><h2>${relay?.configured?'这台电脑的云端连接':'激活这台电脑'}</h2><span class="result-label">独立设备 · 独立凭据</span></div><div class="card-body">${relay?.configured?`<div class="settings-text">设备：${esc(relay.deviceName)}。云端链接固定，断线后自动重连。</div><div id="relay-checks">${relayChecks()}</div><div class="button-row"><button class="secondary" data-action="check-relay">检查公网连接</button><button class="secondary" data-action="reconnect-relay">重新连接</button></div>`:`<p class="settings-text">每个人用一个邀请码激活自己的电脑。工具执行、任务和记忆都保存在本机。</p><form id="activation-form"><div class="field"><label for="device-name">电脑名称</label><input id="device-name" name="name" value="我的电脑" required maxlength="80"></div><div class="field"><label for="activation-code">邀请码</label><input id="activation-code" name="code" type="password" placeholder="粘贴管理员提供的 lbd1. 开头的邀请码" required autocomplete="off"></div><div class="form-error"></div><button class="primary" type="submit">激活并连接</button></form>`}${relay?.canInvite?'<div class="button-row top-spaced"><button class="primary" data-action="invite">生成分享邀请码</button></div><p class="section-description">每个邀请码只能使用一次，24 小时内有效。也可以先给本机生成一个邀请码。</p>':''}</div></section>`;
}
function activityItems(items) {return items.map(e=>`<article class="activity-item"><span class="activity-icon ${e.ok?'':'error'}">${e.ok?'✓':'!'}</span><div><div class="activity-title">${e.ok?'已记录':'执行失败'} <code>${esc(e.tool)}</code></div><div class="activity-detail">${esc(e.detail)}</div></div><span class="activity-time">${date(e.created_at).replace(' ','<br>')}</span></article>`).join('');}
function eventsView() {return `<div class="section-row"><span class="section-description">自动保存工具执行结果。执行成功和任务完成分别记录。</span><button class="secondary" data-action="refresh-events">刷新记录</button></div><div class="activity-list" id="activity-list">${state.events.length?activityItems(state.events):'<div class="empty">还没有执行记录，在「工具」页试一次文件读取吧。</div>'}</div>${state.events.length===40?'<div class="section-row"><button class="secondary" data-action="more-events">加载更早记录</button></div>':''}`;}
function toolExample(name) {
  const revision=state.context.task.revision;
  const examples={read_file:{path:'欢迎.md'},project_context:{},memory_search:{query:'任务'},memory_get:{},memory_set:{key:'重要决定',value:'在这里写下要保存的信息',kind:'decision'},project_checkpoint:{summary:'请填写任务概括',next:'下一步要做什么',risks:'需要确认的事项',expected_revision:revision},run_command:{command:'Get-Date -Format o',why:'查看当前时间'},write_file:{path:'体验.txt',content:'这是一条工具调用写入的内容。',why:'体验本地文件写入'},list_dir:{path:'.'},find_files:{pattern:'*.md'},search_content:{pattern:'任务'},project_note:{kind:'note',text:'在这里写下笔记'}};
  return examples[name]||{};
}
function toolsView() {return `<div class="section-row"><span class="section-description">直接体验一次真实调用。也可以粘贴 Agent 给出的工具调用 JSON，执行后复制结果给它。</span></div><div class="tools-grid"><section class="card"><div class="card-header"><h2>调用工具</h2><span class="result-label">${state.tools.length} 个可用接口</span></div><div class="card-body"><div class="field"><label for="tool-select">选择工具</label><select id="tool-select">${state.tools.map(t=>`<option value="${esc(t.name)}" ${t.name==='read_file'?'selected':''}>${esc(t.title)} · ${esc(t.name)}</option>`).join('')}</select></div><div class="tool-description" id="tool-description"></div><div class="field"><label for="tool-args">参数 JSON / mcp-call 代码块</label><textarea id="tool-args" class="code-area" spellcheck="false">${esc(JSON.stringify(toolExample('read_file'),null,2))}</textarea></div><button class="primary full-width" data-action="run-tool">${icon('arrow')}执行工具</button><details class="detail-toggle"><summary>查看参数说明</summary><pre class="default-prompt" id="tool-schema"></pre></details></div></section><section class="card"><div class="card-header"><h2>真实执行结果</h2><button class="text-button" data-action="copy-result">复制给 Agent ↗</button></div><div class="card-body"><pre id="tool-result" class="tool-result">执行后，结果会显示在这里。</pre></div></section></div>`;}
async function connectionView() {
  const [prompts,connection]=await Promise.all([api('/api/prompts'),api(taskApi('connection'))]);
  const workspace=state.context.task.workspace;
  return `<div class="settings-stack"><section class="card"><div class="card-header"><h2>一键交给 Agent</h2><span class="result-label">本地 MCP</span></div><div class="card-body"><div class="settings-text">复制的是你指定的「授权连接地址 + curl 初始化流程」格式，并附上当前任务记忆。直接发给云端 Agent，它就可以按流程连接这台电脑。</div><div class="connection-url">${esc(connection.url)} <span class="subtle">（复制时自动附带连接凭据）</span></div><div class="button-row"><button class="primary" data-action="copy-agent">${icon('copy')}复制给 Agent</button><button class="secondary" data-action="preview-prompt">预览提示词</button></div><p class="section-description top-spaced">激活后使用固定的公网地址，云端 Agent 无需安装 SSH。支持原生 MCP 的客户端也可以使用下方配置。</p><div class="button-row"><button class="secondary" data-action="copy-http">复制 HTTP 配置</button><button class="secondary" data-action="copy-stdio">复制 stdio 配置</button></div></div></section><section class="card"><div class="card-header"><h2>发给 Agent 的提示词格式</h2><span class="prompt-status">授权说明 · curl · Streamable HTTP</span></div><div class="card-body"><p class="settings-text">保留 <span class="inline-code">{{MCP_URL}}</span>，复制时会填入当前任务的完整接入地址。操作范围以你的当前指令为准，桌面等位置可以直接指定。任务概况和关键记忆会自动附在模板后面。</p><form id="prompts-form"><div class="field"><label for="prompt-template">连接提示词模板</label><textarea id="prompt-template" name="connectionTemplate" rows="18" spellcheck="false">${esc(prompts.connectionTemplate)}</textarea></div><div class="form-error"></div><div class="button-row"><button class="primary" type="submit">保存提示词格式</button></div></form></div></section></div>`;
}
async function render() {
  renderTasks();$('#breadcrumb').textContent=state.view==='connection'?'接入与提示词':'任务记忆';
  if(!state.context){$('#workspace').innerHTML='<div class="empty"><strong>从一个任务开始</strong>创建任务后，就可以保存记忆和复制 Agent 提示词。<br><button class="primary" data-action="new-task">新建任务</button></div>';return;}
  let content='';const requestedId=state.id,view=state.view;
  if(view==='overview')content=overviewView();
  else if(view==='memories'){state.memories=await api(taskApi('memories'));content=memoriesView();}
  else if(view==='events'){state.events=await api(taskApi('events'));content=eventsView();}
  else if(view==='tools'){state.tools=await api(taskApi('tools'));content=toolsView();}
  else if(view==='connection')content=await connectionView();
  if(requestedId!==state.id||view!==state.view)return;
  $('#workspace').innerHTML=header()+relayBanner()+(view==='connection'?activationCard():'')+content;
  if(view==='tools')updateToolDescription();
}
async function reloadCurrent() {await refreshTasks();state.context=await api(taskApi());await render();}
function updateToolDescription() {
  const def=state.tools.find(t=>t.name===$('#tool-select').value);if(!def)return;
  $('#tool-description').textContent=def.description;$('#tool-schema').textContent=JSON.stringify(def.schema,null,2);
}
function taskModal(edit=false) {
  const task=edit?state.context.task:null;
  setModal(modalHead(edit?'编辑任务':'开始一个新任务')+`<div class="modal-body"><p class="modal-note">为任务留一个名字和目标，记忆会一直跟着它保存。</p><form id="task-form" data-edit="${edit?'1':'0'}"><div class="field"><label for="task-title">任务名称</label><input id="task-title" name="title" required maxlength="100" placeholder="例如：重做项目首页" value="${esc(task?.title||'')}"></div><div class="field"><label for="task-goal">任务目标</label><textarea id="task-goal" name="goal" rows="3" maxlength="12000" placeholder="希望完成什么，有哪些要求？">${esc(task?.goal||'')}</textarea></div>${edit?`<div class="field"><label for="task-status">任务状态</label><select id="task-status" name="status">${['active','paused','done'].map(s=>`<option value="${s}" ${task.status===s?'selected':''}>${statuses[s]}</option>`).join('')}</select></div>`:`<div class="field"><label for="task-workspace">工作区路径</label><input id="task-workspace" name="workspace" required value="${esc(state.status?.default_workspace||'')}"><small>填写一个已存在的文件夹，作为任务默认起点。Agent 可按你的指令访问桌面等其他位置。</small></div>`}<div class="form-error"></div><div class="modal-actions"><button class="secondary" type="button" data-action="close-modal">取消</button><button class="primary" type="submit">${edit?'保存修改':'创建任务'}</button></div></form></div>`);
  $('#task-title').focus();
  if(!edit&&hasNativeBridge()){const choose=document.createElement('button');choose.type='button';choose.className='secondary choose-folder';choose.dataset.action='pick-workspace';choose.textContent='选择文件夹…';$('#task-workspace').after(choose);}
}
function memoryModal(key) {
  const memory=key?state.memories.find(m=>m.key===key):null;
  setModal(modalHead(memory?'编辑长期记忆':'留下一条记忆')+`<div class="modal-body"><p class="modal-note">保存关键要求和结论。更新会保留历史版本。</p><form id="memory-form" data-version="${memory?.version??0}"><div class="field"><label for="memory-key">记忆名称</label><input id="memory-key" name="key" required maxlength="200" value="${esc(memory?.key||'')}" ${memory?'readonly':''} placeholder="例如：登录方式的决定"></div><div class="field"><label for="memory-value">记住什么</label><textarea id="memory-value" name="value" required maxlength="20000" rows="5" placeholder="写下结论，以及为什么这样决定。">${esc(memory?.value||'')}</textarea></div><div class="field-row"><div class="field"><label for="memory-kind">类型</label><select id="memory-kind" name="kind">${Object.entries(kinds).map(([value,label])=>`<option value="${value}" ${memory?.kind===value?'selected':''}>${label}</option>`).join('')}</select></div><div class="field"><label>接手时优先看到</label><label class="checkbox-label"><input name="pinned" type="checkbox" ${memory?.pinned?'checked':''}> 置顶这条记忆</label></div></div><div class="form-error"></div><div class="modal-actions"><button class="secondary" type="button" data-action="close-modal">取消</button><button class="primary" type="submit">保存记忆</button></div></form></div>`);
  $('#memory-key').focus();
}
function overviewModal() {
  const {overview,task}=state.context;
  setModal(modalHead('更新任务概况')+`<div class="modal-body"><p class="modal-note">用一份简短交接说清进展。原始记忆和历史概况会继续保留。</p><form id="overview-form" data-revision="${task.revision}"><div class="field"><label for="overview-summary">任务概括</label><textarea id="overview-summary" name="summary" required maxlength="12000" rows="5" placeholder="目前完成了什么，有什么重要结论？">${esc(overview?.summary||'')}</textarea></div><div class="field"><label for="overview-next">下一步</label><textarea id="overview-next" name="next" rows="2" maxlength="6000" placeholder="接下来该做什么？">${esc(overview?.next||'')}</textarea></div><div class="field"><label for="overview-risks">阻塞与待确认</label><textarea id="overview-risks" name="risks" rows="2" maxlength="6000" placeholder="哪些还没有验证，需要注意什么？">${esc(overview?.risks||'')}</textarea></div><div class="form-error"></div><div class="modal-actions"><button class="secondary" type="button" data-action="close-modal">取消</button><button class="primary" type="submit">保存概况</button></div></form></div>`);
}
async function previewPrompt() {
  const result=await api(taskApi('prompt'));
  setModal(modalHead('发给 Agent 的提示词')+`<div class="modal-body"><p class="modal-note">按你指定的授权连接和 curl 流程生成，再附上本任务资料。预览隐藏连接凭据，复制时会包含完整可用地址。</p><div class="field"><textarea class="prompt-preview" readonly aria-label="Agent 提示词全文">${esc(result.preview)}</textarea></div><div class="char-count">共 ${result.text.length.toLocaleString()} 字符 · 地址凭据已在预览中隐藏</div><div class="modal-actions"><button class="secondary" data-action="close-modal">关闭</button><button class="primary" data-action="copy-agent">${icon('copy')}一键复制全文</button></div></div>`);
}
async function runTool(button) {
  button.disabled=true;button.textContent='正在执行…';
  try {
    const raw=$('#tool-args').value.trim().replace(/^```(?:mcp-call|json)?\s*/,'').replace(/\s*```$/,'');let args=JSON.parse(raw);let name=$('#tool-select').value;
    if(args.name){name=args.name;args=args.arguments||{};}
    const result=await api(taskApi('call'),'POST',{name,arguments:args});
    const output=result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
    $('#tool-result').textContent=output;$('#tool-result').classList.toggle('failed',!!result.isError);$('#tool-result').dataset.executed='1';
    state.context=await api(taskApi());await refreshTasks();toast(result.isError?'执行失败，真实错误已显示':'调用完成，执行记录已保存');
  }catch(error){$('#tool-result').textContent=error.message;$('#tool-result').classList.add('failed');}
  finally{button.disabled=false;button.innerHTML=icon('arrow')+'执行工具';}
}
document.addEventListener('click',async event=>{
  const button=event.target.closest('[data-action]');if(!button)return;
  const action=button.dataset.action;
  try {
    if(action==='close-modal')$('#modal').close();
    else if(action==='new-task')taskModal();
    else if(action==='edit-task')taskModal(true);
    else if(action==='license'){await nativeRequest('license');}
    else if(action==='pick-workspace'){const selected=await nativeRequest('pick-folder',{path:$('#task-workspace').value});if(selected)$('#task-workspace').value=selected;}
    else if(action==='select-task')await openTask(button.dataset.id);
    else if(action==='toggle-archived'){state.archived=!state.archived;button.textContent=state.archived?'隐藏已归档任务':'查看已归档任务';await refreshTasks();}
    else if(action==='tab'){state.view=button.dataset.view;await render();}
    else if(action==='connection'){if(state.id){state.view='connection';await render();}else taskModal();}
    else if(action==='copy-agent'){
      if(!state.status?.relay?.configured){toast('先激活云端连接，再复制给云端 Agent。');state.view='connection';await render();return;}
      button.disabled=true;try{const result=await api(taskApi('prompt'));await copy(result.text);}finally{button.disabled=false;}
    }
    else if(action==='check-relay'){button.disabled=true;try{await api('/api/relay/check','POST',{});await heartbeat();toast(state.status.relay.message);}finally{button.disabled=false;}}
    else if(action==='reconnect-relay'){await api('/api/relay/reconnect','POST',{});await heartbeat();toast('正在重新连接服务器');}
    else if(action==='invite'){
      button.disabled=true;try{const result=await api('/api/relay/invites','POST',{count:1});setModal(modalHead('邀请别人连接自己的电脑')+`<div class="modal-body"><p class="modal-note">把邀请码发给对方，让对方在自己的客户端激活。每个码仅使用一次，有效期 24 小时，不会让对方控制你的电脑。</p><div class="field"><textarea id="invite-value" class="code-area" readonly aria-label="分享邀请码">${esc(result.codes[0].code)}</textarea></div><div class="modal-actions"><button class="primary" data-action="copy-invite">复制邀请码</button></div></div>`);}finally{button.disabled=false;}
    }
    else if(action==='copy-invite')await copy($('#invite-value').value,'邀请码已复制，可发给另一位用户');
    else if(action==='preview-prompt')await previewPrompt();
    else if(action==='edit-overview'){state.context=await api(taskApi());overviewModal();}
    else if(action==='new-memory')memoryModal();
    else if(action==='edit-memory')memoryModal(button.dataset.key);
    else if(action==='delete-memory'){
      setModal(modalHead('移除这条记忆？')+`<div class="modal-body"><p class="modal-note">「${esc(button.dataset.key)}」将从当前记忆移除，历史版本仍会保留。</p><div class="modal-actions"><button class="secondary" data-action="close-modal">取消</button><button class="danger-button" data-action="confirm-delete-memory" data-key="${esc(button.dataset.key)}">移除记忆</button></div></div>`);
    }
    else if(action==='confirm-delete-memory'){await api(taskApi('memory-delete'),'POST',{key:button.dataset.key});$('#modal').close();await reloadCurrent();toast('已移除当前记忆，历史版本保留');}
    else if(action==='history'){
      const versions=await api(taskApi('history'));setModal(modalHead('概况的历史版本')+`<div class="modal-body history-wrap">${versions.length?versions.map(v=>`<article class="history-item"><div class="history-time">${date(v.created_at)} · 覆盖修订 ${v.covered_revision}</div><div class="history-text">${esc(v.summary)}</div><div class="history-text top-spaced">下一步：${esc(v.next||'未填写')}<br>待确认：${esc(v.risks||'未填写')}</div></article>`).join(''):'<div class="empty">还没有历史概况。</div>'}</div>`);
    }
    else if(action==='refresh-events'){state.context=await api(taskApi());await render();}
    else if(action==='more-events'){
      const earlier=await api(taskApi('events')+'?before='+state.events.at(-1).id);state.events.push(...earlier);$('#activity-list').innerHTML=activityItems(state.events);if(earlier.length<40)button.remove();
    }
    else if(action==='run-tool')await runTool(button);
    else if(action==='copy-result'){
      if(!$('#tool-result').dataset.executed){toast('先执行一次工具，再复制真实结果。');return;}
      await copy('```mcp-result\n'+$('#tool-result').textContent+'\n```','已复制真实执行结果');
    }
    else if(action==='copy-http'||action==='copy-stdio'){
      const result=await api(taskApi('connection'));await copy(JSON.stringify(action==='copy-http'?result.http:result.stdio,null,2),'已复制当前任务的 MCP 配置');
    }
    else if(action==='export'){const anchor=document.createElement('a');anchor.href=taskApi('export');anchor.download='task.json';anchor.click();toast('正在导出此任务的记忆与记录');}
    else if(action==='archive'){
      const status=state.context.task.status==='archived'?'active':'archived';await api(taskApi(),'PATCH',{status});await refreshTasks();
      if(status==='archived'){state.id=state.tasks[0]?.id||'';state.context=null;if(state.id)await openTask(state.id);else await render();}else await reloadCurrent();toast(status==='archived'?'任务已归档，记忆仍然保留':'任务已恢复');
    }
  }catch(error){toast(error.message);}
});
document.addEventListener('submit',async event=>{
  event.preventDefault();const form=event.target;const submit=form.querySelector('[type="submit"]');const values=Object.fromEntries(new FormData(form));submit.disabled=true;
  try {
    if(form.id==='activation-form'){
      await api('/api/relay/activate','POST',values);await heartbeat();await render();toast('这台电脑已激活，正在连接云端');
    }else if(form.id==='task-form'){
      if(form.dataset.edit==='1'){await api(taskApi(),'PATCH',values);$('#modal').close();await reloadCurrent();toast('任务已更新');}
      else{const task=await api('/api/tasks','POST',values);$('#modal').close();await refreshTasks();await openTask(task.id);toast('新任务已创建，记忆单独保存');}
    }else if(form.id==='memory-form'){
      await api(taskApi('memories'),'POST',{...values,pinned:values.pinned==='on',expected_version:Number(form.dataset.version)});$('#modal').close();await reloadCurrent();toast('记忆已保存');
    }else if(form.id==='overview-form'){
      await api(taskApi('checkpoint'),'POST',{...values,expected_revision:Number(form.dataset.revision)});$('#modal').close();await reloadCurrent();toast('概况已更新，历史版本已保留');
    }else if(form.id==='prompts-form'){
      await api('/api/prompts','POST',{...values,workspace:state.context.task.workspace});toast('提示词已保存');
    }
  }catch(error){form.querySelector('.form-error').textContent=error.message;}
  finally{submit.disabled=false;}
});
document.addEventListener('input',async event=>{
  if(event.target.id==='task-filter')renderTasks();
  if(event.target.id==='memory-search'){
    const request=++memoryRequest;const id=state.id;const query=event.target.value;
    try{const items=await api(taskApi('memories')+'?q='+encodeURIComponent(query));if(request!==memoryRequest||id!==state.id||state.view!=='memories')return;state.memories=items;$('#memory-grid').innerHTML=memoryCards(items);}catch(error){toast(error.message);}
  }
});
document.addEventListener('change',event=>{if(event.target.id==='tool-select'){updateToolDescription();$('#tool-args').value=JSON.stringify(toolExample(event.target.value),null,2);}});
$('#modal').addEventListener('click',event=>{if(event.target===$('#modal')){const rect=$('#modal').getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)$('#modal').close();}});
async function heartbeat() {
  try {
    state.status=await api('/api/status');const relay=state.status.relay;
    $('#service-status').innerHTML='<i></i> '+(relay?.publicMcpUp?'云端可连接':relay?.configured?'云端连接中':'本机就绪 · 未激活');$('#service-status').classList.toggle('offline',!!relay?.configured&&!relay.connected);
    if($('#relay-banner'))$('#relay-banner').outerHTML=relayBanner();if($('#relay-checks'))$('#relay-checks').innerHTML=relayChecks();
    $('#license-button').hidden=!state.status.license||!hasNativeBridge();
    const inviteButton=$('#invite-button');if(inviteButton)inviteButton.hidden=!state.status.relay?.canInvite;
    const license=state.status.license;
    $('#runtime-status').textContent=`本地保存 · ${state.status.memory_mb} MB 运行内存`+(license?license.permanent?' · 永久授权':` · 授权至 ${new Date(license.expiresUtc).toLocaleDateString()}`:'');
    if(state.id&&!$('#modal').open&&['overview','events'].includes(state.view)){
      const fresh=await api(taskApi());if(fresh.task.revision!==state.context?.task.revision){state.context=fresh;await refreshTasks();await render();}
    }
  }catch{$('#service-status').innerHTML='<i></i> 本地服务已断开';$('#service-status').classList.add('offline');}
}
async function init() {
  try {
    await heartbeat();await refreshTasks();if(!state.tasks.some(t=>t.id===state.id))state.id=state.tasks[0]?.id||'';
    if(state.id)await openTask(state.id);else await render();
    setInterval(heartbeat,5000);
  }catch(error){$('#workspace').innerHTML=`<div class="empty"><strong>暂时无法读取任务</strong>${esc(error.message)}<br>请确认本地服务已启动，然后刷新页面。</div>`;}
}
void init();
