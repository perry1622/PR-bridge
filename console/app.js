const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
let state, refreshing = false, toastTimer;
const expanded = new Set(), pendingPorts = new Set();
const time = value => value ? new Date(value).toLocaleTimeString('zh-CN',{hour12:false}) : '—';
function toast(message) { $('#toast').textContent=message; $('#toast').hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('#toast').hidden=true,4500); }
async function action(action,port) {
  const response=await fetch('/api/action',{method:'POST',headers:{'content-type':'application/json','x-pr-console':'1'},body:JSON.stringify({action,port})});
  const body=await response.json();if(!response.ok)throw new Error(body.error);return body;
}
async function refresh(){
  if(refreshing)return;refreshing=true;
  try { const response=await fetch('/api/state');if(!response.ok)throw new Error('状态服务不可用');state=await response.json();render();$('#error').hidden=true;$('#sync-text').textContent=`已同步 ${time(state.updatedAt)}`; }
  catch(error){$('#error').hidden=false;$('#error').textContent='连接中断，页面信息可能已过期。'+error.message;$('#sync-text').textContent='连接中断';}
  finally{refreshing=false;}
}
const pill=(text,style='')=>`<span class="status-pill ${style}">${escape(text)}</span>`;
function fileLink(file){return file?.fileKey && /^[a-zA-Z0-9_-]+$/.test(file.fileKey) ? `<a href="https://www.figma.com/design/${encodeURIComponent(file.fileKey)}" target="_blank" rel="noreferrer">${escape(file.name)} ↗</a>` : escape(file?.name || '');}
// Combine heartbeats with actual request evidence. A past HTTP call is not a live connection.
function observedAgents(b){
  const clients=new Map();
  const ensure=id=>{
    if(!id)return null;
    if(!clients.has(id))clients.set(id,{clientId:id,name:id==='http-client'?'未标识 HTTP 客户端':id,pid:null,online:false,busy:false,queued:0,lastCall:0,heartbeat:false,uncertain:false});
    return clients.get(id);
  };
  for(const a of b.dashboard?.agents || []){
    const client=ensure(a.clientId);if(client)Object.assign(client,{name:a.name || client.name,pid:a.pid,online:!!a.online,heartbeat:true});
  }
  for(const task of b.dashboard?.history || []){
    const client=ensure(task.clientId);if(client)client.lastCall=Math.max(client.lastCall,task.finishedAt || task.startedAt || 0);
  }
  for(const task of b.dashboard?.queue || []){const client=ensure(task.clientId);if(client)client.queued++;}
  const executing=b.health?.executing;
  if(executing){const client=ensure(executing.clientId);if(client){client.busy=!executing.timedOut;client.uncertain=!!executing.timedOut;}}
  return [...clients.values()].map(a=>({...a,active:a.online || a.busy || !!a.queued,label:a.uncertain?'结果待确认':a.busy?'执行中':a.queued?'排队中':a.online?'在线空闲':a.lastCall?'最近调用':'心跳过期'})).sort((a,b)=>Number(b.active)-Number(a.active) || Number(b.uncertain)-Number(a.uncertain) || b.lastCall-a.lastCall);
}
function detail(b){
  const agents=observedAgents(b), file=b.dashboard?.file;
  const tasks=[...(b.health?.executing?[{...b.health.executing,type:'当前操作',outcome:b.health.executing.timedOut?'uncertain':'running'}]:[]),...(b.dashboard?.queue || []).map(t=>({...t,outcome:'queued'})),...(b.dashboard?.history || [])];
  const agentRows=agents.map(a=>`<tr><td>${escape(a.name)}<small>${escape(a.clientId)} · ${a.heartbeat?'有心跳记录':'请求记录，在线状态未知'}</small></td><td>${escape(a.pid || '—')}</td><td>${pill(a.label,a.active?'':'off')}${a.lastCall?`<small title="${escape(new Date(a.lastCall).toLocaleString('zh-CN'))}">调用于 ${time(a.lastCall)}</small>`:''}</td></tr>`).join('');
  return `<tr class="detail-row"><td colspan="7"><div class="details" id="details-${b.port}"><div class="detail-meta">端口 ${b.port} · ${b.managed?'控制台管理':'外部服务 / 未启动'} · PID ${escape(b.health?.pid || '—')} · ${escape(b.health?.version || '未运行')}${file?`<span>当前页面 ID：${escape(file.pageId)} · 文件信息更新于 ${time(file.updatedAt)}</span>`:''}</div><div class="detail-grid"><section><h3>Agent 会话</h3>${agents.length?`<table><thead><tr><th>名称 / 会话 ID</th><th>进程</th><th>状态</th></tr></thead><tbody>${agentRows}</tbody></table>`:`<p class="detail-empty">${b.status==='running'&&!b.dashboard?'旧进程尚未上报连接详情，请更新服务并重载 MCP。':'暂无会话'}</p>`}</section><section><h3>任务记录 <span>最近 60 条</span></h3>${tasks.length?`<table><thead><tr><th>时间</th><th>操作 / Agent</th><th>状态</th></tr></thead><tbody>${tasks.map(t=>`<tr><td>${time(t.finishedAt || t.startedAt)}</td><td>${escape(t.type)}<small>${escape(agents.find(a=>a.clientId===t.clientId)?.name || t.clientId)}</small></td><td title="${escape(t.error || '')}">${pill(({success:'完成',error:'失败',running:'执行中',queued:'等待中',uncertain:'结果待确认'})[t.outcome],t.outcome==='error'?'error':'')}</td></tr>`).join('')}</tbody></table>`:'<p class="detail-empty">暂无任务</p>'}</section></div></div></td></tr>`;
}
function row(b){
  const agents=observedAgents(b), online=agents.filter(a=>a.active), file=b.dashboard?.file;
  const unknown=b.status==='running'&&!b.dashboard;
  const stopReason=!b.managed?'外部服务只能查看，不能由此控制台停止':b.health?.executing || b.health?.pendingCommands?'有任务执行或等待，请完成后再停止':'';
  const disabled=pendingPorts.has(b.port)?'disabled':'';
  const shown=online.length?online:agents;
  const agentText=shown.length?`<strong>${shown.slice(0,2).map(a=>escape(a.name)).join('、')}${shown.length>2?` 等 ${shown.length} 个`:''}</strong><small>${escape(shown[0].label)}${!online.length && shown[0].lastCall?' · '+time(shown[0].lastCall):''}</small>`:unknown?'<span class="muted-cell">待上报</span>':'<span class="muted-cell">暂无记录</span>';
  const fileText=file?`<strong>${fileLink(file)}</strong>`:b.health?.pluginConnected?'<span>已连接，文件名待上报</span>':'<span class="muted-cell">未连接</span>';
  const taskText=b.health?.executing?pill(b.health.executing.timedOut?'结果待确认':'执行中')+'<small>'+ (b.health.queuedCommands || 0)+' 个排队</small>':b.health?.queuedCommands?`${b.health.queuedCommands} 个排队`:b.status==='running'?'<span class="muted-cell">空闲</span>':'<span class="muted-cell">—</span>';
  return `<tr class="connection-row" data-row-port="${b.port}"><th scope="row"><strong class="port-number">${b.port}</strong></th><td>${pill(b.status==='running'?'运行中':b.status==='occupied'?'端口被占用':'未启动',b.status==='running'?'':b.status==='occupied'?'error':'off')}</td><td>${agentText}</td><td>${fileText}</td><td>${escape(file?.pageName || '—')}</td><td>${taskText}</td><td class="row-actions"><button data-action="prepare" data-port="${b.port}" ${disabled}>配置</button>${b.status==='stopped'?`<button class="primary" data-action="start" data-port="${b.port}" ${disabled}>启动</button><button data-action="remove" data-port="${b.port}" ${disabled}>移除</button>`:`<button data-action="stop" data-port="${b.port}" title="${escape(stopReason)}" ${stopReason?'disabled':disabled}>停止</button>`}<button class="detail-toggle" data-expand="${b.port}" aria-expanded="${expanded.has(b.port)}" aria-controls="details-${b.port}">${expanded.has(b.port)?'收起':'详情'}</button></td></tr>${expanded.has(b.port)?detail(b):''}`;
}
function render(){
  const bridges=state.bridges,running=bridges.filter(b=>b.status==='running');
  $('#service-count').textContent=running.length;
  const total=bridges.reduce((n,b)=>n+observedAgents(b).filter(a=>a.active).length,0);
  $('#recent-agent-count').textContent=bridges.reduce((n,b)=>n+observedAgents(b).filter(a=>!a.active && a.lastCall).length,0);
  $('#agent-count').textContent=running.some(b=>!b.dashboard)?(total?total+'+':'—'):total;
  $('#file-count').textContent=bridges.filter(b=>b.health?.pluginConnected).length;
  $('#queue-count').textContent=bridges.reduce((n,b)=>n+(b.health?.queuedCommands || 0),0);
  $('#port-count').textContent=bridges.length;
  const focus=document.activeElement?.closest('[data-port],[data-expand]');
  const focusSelector=focus?.dataset.expand?`[data-expand="${focus.dataset.expand}"]`:focus?.dataset.port?`[data-action="${focus.dataset.action}"][data-port="${focus.dataset.port}"]`:null;
  $('#connection-rows').innerHTML=bridges.length?bridges.map(row).join(''):'<tr><td colspan="7" class="table-empty">还没有端口，点击“添加端口”建立连接。</td></tr>';
  if(focusSelector)document.querySelector(focusSelector)?.focus({preventScroll:true});
}
$('#refresh').onclick=refresh;
$('#add-port').onclick=()=>{$('#add-dialog').showModal();$('#port-input').focus();};
for(const button of document.querySelectorAll('[data-close]'))button.onclick=()=>button.closest('dialog').close();
$('#add-form').onsubmit=async event=>{event.preventDefault();try{await action('add',Number($('#port-input').value));$('#add-dialog').close();await refresh();toast('端口已添加');}catch(error){toast(error.message);}};
$('#connection-rows').onclick=async event=>{
  const toggle=event.target.closest('[data-expand]');
  if(toggle){const port=Number(toggle.dataset.expand);expanded.has(port)?expanded.delete(port):expanded.add(port);render();return;}
  const button=event.target.closest('[data-action]');if(!button || button.disabled)return;
  const port=Number(button.dataset.port),operation=button.dataset.action;
  pendingPorts.add(port);button.disabled=true;
  try{
    const result=await action(operation,port);
    if(operation==='prepare'){$('#setup-target').textContent=`导入同一个 PR-bridge 插件，选择端口 ${port}。`;$('#manifest-path').value=result.manifestPath;$('#mcp-config').value=JSON.stringify(result.mcpConfig,null,2);$('#setup-dialog').showModal();}
    else toast(({start:'服务已启动',stop:'服务已停止',remove:'端口已移除'})[operation]);
  }catch(error){toast(error.message);}finally{pendingPorts.delete(port);await refresh();}
};
for(const [button,input] of [['#copy-path','#manifest-path'],['#copy-config','#mcp-config']])$(button).onclick=async()=>{try{await navigator.clipboard.writeText($(input).value);toast('已复制');}catch{$(input).select();toast('请按 Ctrl+C 复制选中内容');}};
await refresh();setInterval(refresh,4000);
