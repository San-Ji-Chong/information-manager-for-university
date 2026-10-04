import { mdToHtml } from './md.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

let cur = new Date();
cur.setDate(1);
let selDate = null;

async function loadMonth() {
  const y = cur.getFullYear();
  const m = cur.getMonth();
  const from = `${y}-${pad(m + 1)}-01`;
  const to = fmt(new Date(y, m + 1, 0));
  const { events, tasks } = await (await fetch(`/api/calendar?from=${from}&to=${to}`)).json();
  $('#label').textContent = `${y} 年 ${m + 1} 月`;

  const byDay = {};
  for (const e of events) (byDay[e.start_at?.slice(0, 10)] ??= []).push({ kind: 'ev', label: e.title });
  for (const t of tasks) {
    if (!t.due_at) continue;
    (byDay[t.due_at.slice(0, 10)] ??= []).push({ kind: t.priority === 'must' ? 'must' : 'opt', label: t.title });
  }

  const firstDow = (new Date(y, m, 1).getDay() + 6) % 7;
  const days = new Date(y, m + 1, 0).getDate();
  const today = fmt(new Date());
  let html = '';
  for (let i = 0; i < firstDow; i++) html += '<div class="cell empty"></div>';
  for (let d = 1; d <= days; d++) {
    const ds = `${y}-${pad(m + 1)}-${pad(d)}`;
    const items = (byDay[ds] ?? []).sort((a, b) => RANK[a.kind] - RANK[b.kind]);
    const shown = items.slice(0, 4);
    html += `<div class="cell${ds === today ? ' today' : ''}${ds === selDate ? ' sel' : ''}" data-date="${ds}">
      <div class="dnum">${d}</div>
      ${shown.map((it) => `<div class="chip ${it.kind}" title="${esc(it.label)}">${esc(it.label)}</div>`).join('')}
      ${items.length > 4 ? `<div class="chip more">+${items.length - 4} 更多</div>` : ''}
    </div>`;
  }
  $('#grid').innerHTML = html;
  for (const c of $('#grid').querySelectorAll('.cell[data-date]')) {
    c.onclick = () => { selDate = c.dataset.date; loadMonth(); loadDay(); };
  }
}

const PRIO = { must: ['必做', 'must'], optional: ['选做', 'opt'], unknown: ['待定', 'opt'] };
const RANK = { ev: 0, must: 1, opt: 2 };

async function loadDay() {
  const { events, tasks, undated } = await (await fetch(`/api/day?date=${selDate}`)).json();
  let html = `<h2>${selDate}</h2>`;
  for (const e of events) {
    html += `<div class="item" data-type="event" data-id="${e.id}">
      <div class="row"><span class="tag ev">活动</span><span class="ttl">${esc(e.title)}</span><button data-act="edit">改</button><button data-act="del">删</button></div>
      <div class="meta">${esc(e.start_at)}${e.end_at ? ` → ${esc(e.end_at.slice(11))}` : ''}${e.due_at ? ` · 报名截止 ${esc(e.due_at)}` : ''}</div>
      ${e.location ? `<div class="meta">${esc(e.location)}</div>` : ''}
      <div class="meta">${esc(e.organizer)}${e.campus ? ` · ${esc(e.campus)}` : ''}${e.capacity ? ` | ${e.capacity.includes('/') ? '报名' : '人数'} ${esc(e.capacity)}` : ''}${JSON.parse(e.tags).length ? ` | ${JSON.parse(e.tags).join(' / ')}` : ''}</div>
      ${e.source_url ? `<div class="meta"><a class="doclink" href="${esc(e.source_url)}" target="_blank" rel="noopener">看活动文档</a></div>` : ''}
    </div>`;
  }
  const taskItem = (t) => {
    const [label, cls] = PRIO[t.priority] ?? PRIO.unknown;
    const m = taskMeta(t);
    const where = m.group || t.doc_title || '';
    const src = where ? `${SRC_LABEL[t.source] ?? t.source} · ${where}` : (SRC_LABEL[t.source] ?? t.source ?? '');
    return `<div class="item" data-type="task" data-id="${t.id}">
      <div class="row"><span class="tag ${cls}">${label}</span><span class="ttl${t.status === 'done' ? ' done' : ''}">${esc(t.title)}</span>
      <button data-act="detail">详情</button>
      <button data-act="status">${t.status === 'todo' ? '完成' : '恢复'}</button></div>
      ${t.due_at ? `<div class="meta">截止 ${esc(t.due_at)}</div>` : ''}
      <div class="detail" hidden>
        <div class="dline"><span>优先级</span><select data-f="priority">
          <option value="must"${t.priority === 'must' ? ' selected' : ''}>必做</option>
          <option value="optional"${t.priority === 'optional' ? ' selected' : ''}>选做</option>
          <option value="unknown"${!t.priority || t.priority === 'unknown' ? ' selected' : ''}>待定</option>
        </select></div>
        <div class="dline"><span>截止</span><input data-f="due_at" value="${esc(t.due_at ?? '')}" placeholder="YYYY-MM-DD HH:MM,留空表示不设"></div>
        <div class="dline"><span>出处</span><span>${esc(src)}${m?.sender ? ` · ${esc(m.sender)}` : ''}${m?.at ? ` · ${esc(m.at)}` : ''}</span></div>
        ${t.source_url ? `<div class="dline"><span>链接</span><a class="doclink" href="${esc(t.source_url)}" target="_blank" rel="noopener">打开原文档</a></div>` : ''}
        <div class="dline"><span>状态</span><span>${t.status === 'done' ? '已完成' : '待办'} · 收录于 ${esc(t.created_at ?? '')}${m?.engine ? ` · ${m.engine === 'llm' ? 'LLM 归纳' : '规则归纳'}` : ''}</span></div>
        ${m?.quote ? `<div class="quote">原话:“${esc(m.quote)}”</div>` : ''}
      </div>
    </div>`;
  };
  for (const t of tasks) html += taskItem(t);
  if (undated?.length) {
    html += `<h2 class="sub">没写时间的待办 · ${undated.length}</h2>`;
    for (const t of undated) html += taskItem(t);
  }
  $('#panel').innerHTML = html || `<h2>${selDate}</h2><p class="hint">这天没有安排</p>`;
  bindPanel();
}

const SRC_LABEL = { qq: 'QQ 群', yuque: '语雀', wechat: '微信群(粘贴)', message: '群消息(粘贴)', manual: '手动', helenote: 'helenote' };

async function patchTask(id, body) {
  await fetch(`/api/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  loadDay(); loadMonth(); loadPrio();
}

function bindPanel() {
  for (const item of $('#panel').querySelectorAll('.item')) {
    const type = item.dataset.type;
    const id = item.dataset.id;
    item.querySelector('[data-act="edit"]')?.addEventListener('click', () => startEdit(item, type, id));
    item.querySelector('[data-act="detail"]')?.addEventListener('click', () => {
      const d = item.querySelector('.detail');
      d.hidden = !d.hidden;
    });
    const pf = item.querySelector('[data-f="priority"]');
    if (pf) pf.onchange = () => patchTask(id, { priority: pf.value });
    const df = item.querySelector('[data-f="due_at"]');
    if (df) df.onchange = () => patchTask(id, { due_at: df.value.trim() || null });
    item.querySelector('[data-act="del"]')?.addEventListener('click', async () => {
      const title = item.querySelector('.ttl').textContent;
      if (!confirm(`删掉「${title}」?\n来自语雀文档的活动会移到思训页的「已删除的活动」,可以恢复。`)) return;
      await fetch(`/api/events/${id}`, { method: 'DELETE' });
      loadDay(); loadMonth();
    });
    item.querySelector('[data-act="status"]')?.addEventListener('click', async () => {
      const done = item.querySelector('[data-act="status"]').textContent === '完成';
      await patchTask(id, { status: done ? 'done' : 'todo' });
    });
  }
}

function startEdit(item, type, id) {
  const ttl = item.querySelector('.ttl');
  const old = ttl.textContent;
  const input = document.createElement('input');
  input.value = old;
  ttl.replaceWith(input);
  input.focus();
  const save = async () => {
    if (input.value.trim() && input.value !== old) {
      await fetch(`/api/${type === 'event' ? 'events' : 'tasks'}/${id}`,
        { method: 'PATCH', body: JSON.stringify({ title: input.value.trim() }) });
    }
    loadDay(); loadMonth(); loadPrio();
  };
  input.addEventListener('blur', save);
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') input.blur(); });
}

$('#prev').onclick = () => { cur.setMonth(cur.getMonth() - 1); loadMonth(); };
$('#next').onclick = () => { cur.setMonth(cur.getMonth() + 1); loadMonth(); };
$('#today').onclick = () => { cur = new Date(); cur.setDate(1); selDate = fmt(new Date()); loadMonth(); loadDay(); };
$('#import').onchange = async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const label = document.querySelector('.import');
  label.firstChild.textContent = '识别中… ';
  const r = await fetch('/api/import/helenote', { method: 'POST', body: await file.arrayBuffer() });
  const { events } = await r.json();
  label.firstChild.textContent = '导入 helenote 截图 ';
  ev.target.value = '';
  alert(`导入 ${events.length} 条活动`);
  loadMonth();
};

selDate = fmt(new Date());
loadMonth();
loadDay();

/* ───────────── 优先级待办:与日期无关,拖拽排序 ───────────── */
const taskMeta = (t) => (typeof t.meta === 'string' ? JSON.parse(t.meta || 'null') : t.meta) ?? {};
let prioTasks = [];
let dragRow = null;

async function loadPrio() {
  prioTasks = await (await fetch('/api/tasks?status=todo')).json();
  renderPrio();
}

function renderPrio() {
  const today = fmt(new Date());
  $('#priocnt').textContent = `${prioTasks.length} 条待办`;
  if (!prioTasks.length) {
    $('#prioitems').innerHTML = '<p class="hint">还没有待办。在收件箱把 QQ 群消息的候选存成待办,或从思训文档提取的 DDL,都会排到这里。</p>';
    return;
  }
  $('#prioitems').innerHTML = prioTasks.map((t, i) => {
    const [label, cls] = PRIO[t.priority] ?? PRIO.unknown;
    const due = t.due_at ? t.due_at.slice(5, 16) : '';
    const src = taskMeta(t).group || t.doc_title || SRC_LABEL[t.source] || '';
    return `<div class="prio" draggable="true" data-id="${t.id}">
      <span class="ord">${i + 1}</span><span class="grip">⠿</span>
      <span class="tag ${cls}">${label}</span>
      <span class="pttl" title="${esc(t.title)}">${esc(t.title)}</span>
      ${due ? `<span class="pdue${t.due_at.slice(0, 10) <= today ? ' soon' : ''}">${esc(due)}</span>` : ''}
      ${src ? `<span class="psrc" title="${esc(src)}">${esc(src)}</span>` : ''}
      <button data-act="done">完成</button></div>`;
  }).join('');
  bindPrio();
}

function bindPrio() {
  for (const row of $('#prioitems').querySelectorAll('.prio')) {
    row.addEventListener('dragstart', () => { dragRow = row; row.classList.add('dragging'); });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); dragRow = null; savePrioOrder(); });
    row.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      if (!dragRow || dragRow === row) return;
      const r = row.getBoundingClientRect();
      row.parentNode.insertBefore(dragRow, ev.clientY > r.top + r.height / 2 ? row.nextSibling : row);
    });
    row.querySelector('[data-act="done"]').onclick = () => patchTask(row.dataset.id, { status: 'done' });
  }
}

async function savePrioOrder() {
  const ids = [...$('#prioitems').querySelectorAll('.prio')].map((r) => Number(r.dataset.id));
  await fetch('/api/tasks/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
  loadPrio();
}

loadPrio();

// 优先级列表固定占一块高度,嫌它挤日历就收起来;状态记在 localStorage,下次打开保持
$('#priotoggle').onclick = () => {
  const collapsed = $('#priolist').classList.toggle('collapsed');
  localStorage.setItem('prioCollapsed', collapsed ? '1' : '');
  $('#priotoggle').textContent = collapsed ? '展开' : '收起';
};
if (localStorage.getItem('prioCollapsed') === '1') {
  $('#priolist').classList.add('collapsed');
  $('#priotoggle').textContent = '展开';
}

let docs = [];
let curDocId = null;

const VIEWS = { cal: '#calview', train: '#trainview', res: '#resview', inbox: '#inboxview' };

for (const b of document.querySelectorAll('.tabs button')) {
  b.onclick = () => {
    for (const x of document.querySelectorAll('.tabs button')) x.classList.toggle('on', x === b);
    for (const [k, sel] of Object.entries(VIEWS)) $(sel).hidden = k !== b.dataset.view;
    $('#calnav').style.display = b.dataset.view === 'cal' ? '' : 'none';
    if (b.dataset.view === 'train') refreshYuqueStatus().then(loadDocs);
    if (b.dataset.view === 'res') loadRes();
    if (b.dataset.view === 'inbox') loadQQ();
  };
}

let selMode = false;
const selIds = new Set();

let yqBusy = false;
let yqStat = '';
let yqErr = false;
let yqPoll = null;

const yqBtnHtml = () => `<button class="mini" id="yqsync"${yqBusy ? ' disabled' : ''}>${yqBusy ? '同步中…' : '同步语雀'}</button>`;
const yqStatHtml = () => `<div class="yqstat${yqErr ? ' err' : ''}" id="yqstat">${esc(yqStat)}</div>`;

function paintYq() {
  const b = $('#yqsync');
  if (b) { b.disabled = yqBusy; b.textContent = yqBusy ? '同步中…' : '同步语雀'; }
  const s = $('#yqstat');
  if (s) { s.textContent = yqStat; s.classList.toggle('err', yqErr); }
}

/** 服务启动时会在后台同步一次,打开页面时可能还在跑;轮询到跑完再刷新一遍数据。 */
function scheduleYqPoll() {
  clearTimeout(yqPoll);
  if (!yqBusy) return;
  yqPoll = setTimeout(async () => {
    await refreshYuqueStatus();
    if (!yqBusy) reloadAll();
  }, 2500);
}

async function refreshYuqueStatus() {
  try {
    const s = await (await fetch('/api/yuque/status')).json();
    yqBusy = !!s.busy;
    yqErr = !s.configured || !!s.error;
    yqStat = !s.configured ? '未配置语雀 Token(改 data/config.json 的 yuque 段)'
      : s.error ? `上次同步失败:${s.error}`
        : s.busy ? '正在后台同步「鼓：」活动文档…'
          : s.last_sync_at ? `上次同步 ${s.last_sync_at.slice(5, 16)} · ${s.activities} 场活动 / ${s.docs} 篇文档`
            : '还没同步过';
  } catch (e) {
    yqErr = true;
    yqStat = `读不到同步状态:${e.message}`;
  }
  paintYq();
  scheduleYqPoll();
}

async function runYuqueSync() {
  if (yqBusy) return;
  yqBusy = true;
  yqErr = false;
  yqStat = '正在拉取「鼓：」活动文档,大概十几秒…';
  paintYq();
  try {
    const r = await fetch('/api/yuque/sync', { method: 'POST', body: '{}' });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    if (j.busy) {
      // 撞上启动时那次同步:按钮继续转,交给轮询等它结束
      yqStat = '已经有一次同步在跑了,等它结束…';
      scheduleYqPoll();
      return;
    }
    yqStat = `扫描 ${j.scanned} 篇 → 新增 ${j.added}、更新 ${j.updated}、跳过 ${j.skipped}、失败 ${j.errors.length}`
      + ` · ${j.extracted.events} 个活动 / ${j.extracted.tasks} 条待办`;
    if (j.errors.length) { yqErr = true; yqStat += ` · ${j.errors[0]}`; }
    await reloadAll();
  } catch (e) {
    yqErr = true;
    yqStat = `同步失败:${e.message}`;
  }
  yqBusy = false;
  paintYq();
}

/** 同步、删活动之后,日历/当日/优先级/文档列表都得跟着变。 */
async function reloadAll() {
  await Promise.all([loadDocs(), loadMonth(), loadPrio()]);
  if (selDate) loadDay();
}

async function loadDocs() {
  docs = await (await fetch('/api/docs')).json();
  if (!docs.length) {
    $('#doclist').innerHTML = `<div class="dlbar">${yqBtnHtml()}</div>${yqStatHtml()}
      <p class="hint">还没有文档。点「同步语雀」拉取团队知识库里「鼓：」开头的活动文档。<br>
      拿不到 Token 就在语雀思训知识库页面按 F12,粘贴 tools/yuque-sync-snippet.js 运行。</p>`;
    paintYq();
    $('#yqsync').onclick = runYuqueSync;
    return;
  }
  const visible = docs.filter((d) => !d.hidden);
  const gone = docs.filter((d) => d.hidden);
  const acts = visible.filter((d) => d.kind === 'activity');
  const notes = visible.filter((d) => d.kind !== 'activity');

  const row = (d, off) => `<div class="docrow">
    ${selMode && !off ? `<input type="checkbox" class="pick" data-id="${d.id}"${selIds.has(d.id) ? ' checked' : ''}>` : ''}
    <button class="doc${d.id === curDocId ? ' on' : ''}${off ? ' off' : ''}" data-id="${d.id}">
      ${esc(d.doc_date ? d.doc_date.slice(5) + ' ' : '')}${esc(d.title.replace(/^[鼓仙苏]\s*[：:]\s*/, ''))}
      ${d.task_count ? `<i>${d.task_count} 项待办</i>` : ''}</button>
    ${off ? `<button class="mini" data-restore="${d.id}">恢复</button>` : ''}
  </div>`;

  const byMonth = new Map();
  for (const d of acts) {
    const k = d.doc_date ? d.doc_date.slice(0, 7) : '活动 · 时间待定';
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(d);
  }
  const PENDING = '活动 · 时间待定';
  let html = `<div class="dlbar">
      ${yqBtnHtml()}
      <button class="mini" id="selmode">${selMode ? '退出多选' : '多选'}</button>
      ${selMode ? '<button class="mini danger" id="delsel">删除选中</button><button class="mini" id="keepsel">只保留选中</button>' : ''}
      <span class="cnt">${selMode ? `已选 ${selIds.size} / ${acts.length} 场` : `${acts.length} 场活动`}</span>
    </div>${yqStatHtml()}`;
  for (const [k, list] of [...byMonth].sort((a, b) => (a[0] === PENDING) - (b[0] === PENDING) || b[0].localeCompare(a[0]))) {
    html += `<div class="grp">${esc(k)} · ${list.length} 场活动</div>` + list.map((d) => row(d)).join('');
  }
  if (notes.length) html += `<div class="grp">笔记与作业 · ${notes.length} 篇</div>` + notes.map((d) => row(d)).join('');
  if (gone.length) html += `<div class="grp">已删除的活动 · ${gone.length}</div>` + gone.map((d) => row(d, true)).join('');
  $('#doclist').innerHTML = html;

  $('#yqsync').onclick = runYuqueSync;
  for (const b of $('#doclist').querySelectorAll('.doc')) b.onclick = () => openDoc(Number(b.dataset.id));
  for (const cb of $('#doclist').querySelectorAll('.pick')) {
    cb.onchange = () => {
      if (cb.checked) selIds.add(Number(cb.dataset.id)); else selIds.delete(Number(cb.dataset.id));
      $('#doclist .cnt').textContent = `已选 ${selIds.size} / ${acts.length} 场`;
    };
  }
  for (const b of $('#doclist').querySelectorAll('[data-restore]')) {
    b.onclick = async () => { await hideDocs([Number(b.dataset.restore)], false); };
  }
  $('#selmode').onclick = () => { selMode = !selMode; selIds.clear(); loadDocs(); };
  if (selMode) {
    $('#delsel').onclick = async () => {
      if (!selIds.size) return alert('先勾选活动');
      if (!confirm(`把这 ${selIds.size} 场活动从日历删掉?(会移到下方「已删除的活动」,可恢复)`)) return;
      await hideDocs([...selIds], true);
    };
    $('#keepsel').onclick = async () => {
      const drop = acts.filter((d) => !selIds.has(d.id)).map((d) => d.id);
      if (!selIds.size) return alert('先勾选要保留的活动');
      if (!drop.length) return alert('选中的就是全部活动,没有要删的');
      if (!confirm(`只保留选中的 ${selIds.size} 场,删掉其余 ${drop.length} 场活动?`)) return;
      await hideDocs(drop, true);
    };
  }
  if (curDocId == null) openDoc((acts[0] ?? docs[0]).id);
}

async function hideDocs(ids, hidden) {
  await fetch('/api/docs/hidden', { method: 'POST', body: JSON.stringify({ ids, hidden }) });
  selMode = false;
  selIds.clear();
  await reloadAll();
}

async function openDoc(id) {
  curDocId = id;
  for (const b of $('#doclist').querySelectorAll('.doc')) b.classList.toggle('on', Number(b.dataset.id) === id);
  const d = await (await fetch(`/api/docs/${id}`)).json();
  const facts = (d.events ?? []).map((e) => `<div class="f"><b>${esc(e.start_at ?? '时间待定')}</b>${e.end_at ? ' → ' + esc(e.end_at.slice(11)) : ''} ${esc(e.location ?? '')}`
    + `${e.organizer ? ' · ' + esc(e.organizer) : ''}${e.campus ? ' · ' + esc(e.campus) : ''}`
    + `${e.capacity ? ' · 人数 ' + esc(e.capacity) : ''}${e.due_at ? ' · 报名截止 ' + esc(e.due_at) : ''}</div>`).join('')
    || '<div class="none">没提取到时间地点(可能写在 helenote 里)——导入当天截图后会显示在这里。</div>';
  const tasks = (d.tasks ?? []).map((t) => `<label class="dtask${t.status === 'done' ? ' done' : ''}">
      <input type="checkbox" data-id="${t.id}"${t.status === 'done' ? ' checked' : ''}>
      <span>${esc(t.title.replace(/^前置任务:/, ''))}</span><em>${esc(t.due_at ?? '未定时间')}</em></label>`).join('');
  $('#reader').innerHTML = `<h2>${esc(d.title)}</h2>
    <div class="src">${esc(d.doc_date ?? '')}${d.url ? ` · <a href="${esc(d.url)}" target="_blank" rel="noopener">语雀原文</a>` : ''}</div>
    <div class="facts">${facts}${tasks ? `<div class="dtasks">${tasks}</div>` : ''}</div>
    <div class="md">${mdToHtml(d.body)}</div>`;
  for (const cb of $('#reader').querySelectorAll('.dtask input')) {
    cb.onchange = async () => {
      await fetch(`/api/tasks/${cb.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ status: cb.checked ? 'done' : 'todo' }) });
      cb.closest('.dtask').classList.toggle('done', cb.checked);
      loadMonth();
    };
  }
  $('#reader').scrollTop = 0;
}

let rawId = null;

$('#parse').onclick = async () => {
  const content = $('#paste').value.trim();
  if (!content) return;
  const src = $('#srcsel').value;
  const r = await (await fetch('/api/inbox', { method: 'POST', body: JSON.stringify({ source: src, content }) })).json();
  rawId = r.id;
  renderCands(r.candidates, src);
};

const PRIO_LABEL = { must: '必做', optional: '选做', unknown: '待定' };

function renderCands(list, src) {
  if (!list.length) {
    $('#cands').innerHTML = '<p class="head">没解析出待办(原文已存进收件箱)。可以把消息改写得直白些再试,或直接在日历里手填。</p>';
    return;
  }
  $('#cands').innerHTML = `<div class="head">解析出 ${list.length} 条,逐条确认后再保存</div>`
    + list.map((c) => `<div class="cand">
        <input class="cttl" value="${esc(c.title)}">
        <select class="cprio">${Object.entries(PRIO_LABEL).map(([v, l]) =>
          `<option value="${v}"${v === c.priority ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <input class="cdue" value="${esc(c.due_at ?? '')}" placeholder="2026-10-05 23:59">
        <button class="drop">删掉</button>
      </div>`).join('')
    + '<div id="savebar"><button class="btn primary" id="savecands">保存到日历</button>'
    + '<span class="tip">时间格式 2026-10-05 23:59,只写日期也行;留空表示没有截止</span></div>';

  for (const el of $('#cands').querySelectorAll('.drop')) el.onclick = () => el.closest('.cand').remove();

  $('#savecands').onclick = async () => {
    const rows = [...$('#cands').querySelectorAll('.cand')];
    const tasks = [];
    for (const el of rows) {
      const title = el.querySelector('.cttl').value.trim();
      const due = el.querySelector('.cdue').value.trim();
      if (!title) continue;
      if (due && !/^\d{4}-\d{2}-\d{2}/.test(due)) {
        el.querySelector('.cdue').focus();
        alert(`时间格式不对:${due}\n请写成 2026-10-05 23:59 或 2026-10-05,也可以留空。`);
        return;
      }
      tasks.push({ title, priority: el.querySelector('.cprio').value, due_at: due || null });
    }
    if (!tasks.length) { $('#cands').innerHTML = '<p class="head">没有要保存的条目</p>'; return; }
    const r = await (await fetch('/api/tasks', {
      method: 'POST', body: JSON.stringify({ source: src, raw_item_id: rawId, tasks }),
    })).json();
    $('#paste').value = '';
    $('#cands').innerHTML = `<p class="head">已保存 ${r.saved} 条待办,切到「日历」就能看到</p>`;
    loadMonth();
  };
}

const KINDS = ['录音', '笔记', '考点', '课件', '作业', '题库', '工具', '其他'];
const safeUrl = (u) => (/^https?:\/\//i.test(u ?? '') ? u : null);
const NOTAG = '__none__';

let resData = null;
let resFilter = { q: '', tag: '', kind: '', course: '' };
let resSel = false;
const resSelIds = new Set();
let editId = null;

async function loadRes() {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(resFilter)) if (v) qs.set(k, v);
  resData = await (await fetch(`/api/resources?${qs}`)).json();
  if (dropStaleFilter()) return loadRes();
  renderTagbar();
  renderRes();
}

function dropStaleFilter() {
  const d = resData;
  const facets = [['kind', d.kinds], ['course', d.courses], ['tag', d.tags]];
  let stale = false;
  for (const [key, list] of facets) {
    const v = resFilter[key];
    if (v && v !== NOTAG && !list.some((t) => t.name === v)) { resFilter[key] = ''; stale = true; }
  }
  if (resFilter.tag === NOTAG && !d.untagged) { resFilter.tag = ''; stale = true; }
  return stale;
}

function renderTagbar() {
  const d = resData;
  const chip = (name, n, key, on) =>
    `<button class="tg${on ? ' on' : ''}" data-key="${key}" data-name="${esc(name)}">${esc(name)}<i>${n}</i></button>`;
  const group = (title, list, key, cur) => (list.length
    ? `<div class="grp">${title}</div><div class="tgwrap">${list.map((t) => chip(t.name, t.n, key, cur === t.name)).join('')}</div>`
    : '');
  $('#tagbar').innerHTML = group('类型', d.kinds, 'kind', resFilter.kind)
    + group('课程', d.courses, 'course', resFilter.course)
    + group('标签', d.tags, 'tag', resFilter.tag)
    + (d.untagged ? `<div class="grp">其他</div><div class="tgwrap">
        <button class="tg${resFilter.tag === NOTAG ? ' on' : ''}" data-key="tag" data-name="${NOTAG}">没打标签<i>${d.untagged}</i></button></div>` : '')
    + (d.total ? '<button class="mini" id="resclear">清除筛选</button>' : '');

  for (const b of $('#tagbar').querySelectorAll('.tg')) {
    b.onclick = () => {
      const { key, name } = b.dataset;
      resFilter[key] = resFilter[key] === name ? '' : name;
      loadRes();
    };
  }
  const clear = $('#resclear');
  if (clear) clear.onclick = () => { resFilter = { q: '', tag: '', kind: '', course: '' }; $('#resq').value = ''; loadRes(); };
}

const card = (r) => {
  const url = safeUrl(r.url);
  return `<div class="res${r.exists === false ? ' gone' : ''}" data-id="${r.id}">
    ${resSel ? `<input type="checkbox" class="pick" data-id="${r.id}"${resSelIds.has(r.id) ? ' checked' : ''}>` : ''}
    <div class="rbody">
      <div class="rrow">
        ${r.kind ? `<span class="kind">${esc(r.kind)}</span>` : ''}
        <b class="rtitle">${esc(r.title)}</b>
        <button class="mini" data-act="edit">改</button>
        <button class="mini danger" data-act="del">删</button>
      </div>
      <div class="rmeta">${esc(r.course ?? '未归课程')} · 记于 ${esc((r.created_at ?? '').slice(0, 10))}${r.doc_id ? ' · 来自语雀' : ''}</div>
      ${r.tags.length ? `<div class="rtags">${r.tags.map((t) => `<button class="tg" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : ''}
      <div class="rlinks">
        ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">打开网页 ↗</a>` : ''}
        ${r.path ? `<button class="mini" data-act="open">${r.exists === false ? '路径失效' : '打开本地文件'}</button><code class="path" title="${esc(r.path)}">${esc(r.path)}</code>` : ''}
        ${!url && !r.path ? '<span class="nolink">只有记录,没有链接或路径</span>' : ''}
      </div>
      ${r.note ? `<div class="rnote">${esc(r.note)}</div>` : ''}
    </div>
  </div>`;
};

function renderRes() {
  const d = resData;
  const n = d.items.length;
  let html = `<div class="rlbar">
      <button class="btn primary" id="resnew">+ 新建资料</button>
      <button class="mini" id="resfromdoc">从语雀笔记导入</button>
      <button class="mini" id="ressel">${resSel ? '退出多选' : '多选'}</button>
      ${resSel ? `<input id="tagdraft" placeholder="标签名"><button class="mini" id="tagadd">加标签</button>
        <button class="mini" id="tagrm">去标签</button><button class="mini danger" id="resbulkdel">删除选中</button>` : ''}
      <span class="cnt">${resSel ? `已选 ${resSelIds.size} / ${n} 条`
    : `共 ${d.total} 条${n === d.total ? '' : `,筛出 ${n} 条`}`}</span>
    </div>`;
  html += n ? d.items.map(card).join('')
    : `<p class="hint">${d.total ? '没有符合筛选条件的资料。'
      : '还没有资料。点「新建资料」把网盘链接或本地文件路径记下来,用标签归类;学长的思训笔记可以一键导入。'}</p>`;
  $('#reslist').innerHTML = html;

  $('#resnew').onclick = () => openForm(null);
  $('#resfromdoc').onclick = async () => {
    const r = await (await fetch('/api/resources/from-docs', { method: 'POST', body: '{}' })).json();
    alert(r.imported ? `导入 ${r.imported} 篇学长笔记,已打上「学长笔记」标签、归到「思维训练营」。\n重复点不会重复导入。`
      : '语雀笔记已经都导入过了。');
    loadRes();
  };
  $('#ressel').onclick = () => { resSel = !resSel; resSelIds.clear(); renderRes(); };
  if (resSel) {
    $('#tagadd').onclick = () => bulkTag('add');
    $('#tagrm').onclick = () => bulkTag('remove');
    $('#resbulkdel').onclick = async () => {
      if (!resSelIds.size) return alert('先勾选资料');
      if (!confirm(`删掉这 ${resSelIds.size} 条资料记录?(只删记录,不动网盘和本地文件)`)) return;
      await fetch('/api/resources/delete', { method: 'POST', body: JSON.stringify({ ids: [...resSelIds] }) });
      resSel = false;
      resSelIds.clear();
      loadRes();
    };
  }
  for (const cb of $('#reslist').querySelectorAll('.pick')) {
    cb.onchange = () => {
      if (cb.checked) resSelIds.add(Number(cb.dataset.id)); else resSelIds.delete(Number(cb.dataset.id));
      $('#reslist .cnt').textContent = `已选 ${resSelIds.size} / ${n} 条`;
    };
  }
  for (const el of $('#reslist').querySelectorAll('.res')) {
    const id = Number(el.dataset.id);
    el.querySelector('[data-act="edit"]').onclick = () => openForm(d.items.find((r) => r.id === id));
    el.querySelector('[data-act="del"]').onclick = async () => {
      const t = el.querySelector('.rtitle').textContent;
      if (!confirm(`删掉「${t}」?(只删记录,不动网盘和本地文件)`)) return;
      await fetch(`/api/resources/${id}`, { method: 'DELETE' });
      loadRes();
    };
    const open = el.querySelector('[data-act="open"]');
    if (open) open.onclick = async () => {
      const r = await fetch(`/api/resources/${id}/open`, { method: 'POST' });
      if (!r.ok) alert((await r.json()).error ?? '打不开');
    };
  }
  for (const b of $('#reslist').querySelectorAll('.rtags .tg')) {
    b.onclick = () => { resFilter.tag = b.dataset.tag; loadRes(); };
  }
}

async function bulkTag(mode) {
  const input = $('#tagdraft');
  if (!resSelIds.size) return alert('先勾选资料');
  if (!input.value.trim()) return alert('写一个标签名');
  await fetch('/api/resources/tag', { method: 'POST', body: JSON.stringify({ ids: [...resSelIds], [mode]: input.value }) });
  resSelIds.clear();
  loadRes();
}

function openForm(r) {
  editId = r?.id ?? null;
  $('#dlgttl').textContent = r ? '编辑资料' : '新建资料';
  $('#f_title').value = r?.title ?? '';
  $('#f_url').value = r?.url ?? '';
  $('#f_path').value = r?.path ?? '';
  $('#f_course').value = r?.course ?? '';
  $('#f_kind').value = r?.kind ?? '';
  $('#f_tags').value = (r?.tags ?? []).join(', ');
  $('#f_note').value = r?.note ?? '';
  $('#f_err').textContent = '';
  $('#dl_kind').innerHTML = KINDS.map((k) => `<option value="${esc(k)}">`).join('');
  $('#dl_course').innerHTML = (resData?.courses ?? []).map((c) => `<option value="${esc(c.name)}">`).join('');
  $('#resdlg').showModal();
  $('#f_title').focus();
}

$('#f_save').onclick = async () => {
  const body = {
    title: $('#f_title').value.trim(),
    url: $('#f_url').value.trim(),
    path: $('#f_path').value.trim(),
    course: $('#f_course').value.trim(),
    kind: $('#f_kind').value.trim(),
    tags: $('#f_tags').value,
    note: $('#f_note').value.trim(),
  };
  const fail = (msg, sel) => { $('#f_err').textContent = msg; $(sel).focus(); };
  if (!body.title) return fail('标题不能为空', '#f_title');
  if (body.url && !safeUrl(body.url)) return fail('链接要以 http:// 或 https:// 开头', '#f_url');
  const r = await fetch(editId ? `/api/resources/${editId}` : '/api/resources',
    { method: editId ? 'PATCH' : 'POST', body: JSON.stringify(body) });
  if (!r.ok) { $('#f_err').textContent = (await r.json()).error ?? '保存失败'; return; }
  $('#resdlg').close();
  loadRes();
};
$('#f_cancel').onclick = () => $('#resdlg').close();

let fsDir = '';
let fsParent = null;
let fsPicked = null;

$('#f_browse').onclick = () => openFs($('#f_path').value.trim());
$('#fs_up').onclick = () => { if (fsParent) openFs(fsParent); };
$('#fs_go').onclick = () => openFs($('#fs_path').value.trim());
$('#fs_path').onkeydown = (ev) => { if (ev.key === 'Enter') openFs($('#fs_path').value.trim()); };
$('#fs_cancel').onclick = () => $('#fsdlg').close();
$('#fs_here').onclick = () => {
  if (!fsDir) return alert('先进到一个文件夹');
  $('#f_path').value = fsDir;
  $('#fsdlg').close();
};
$('#fs_ok').onclick = () => {
  if (!fsPicked) return alert('先在列表里点一个文件');
  $('#f_path').value = fsPicked;
  $('#fsdlg').close();
};

async function openFs(dir) {
  const r = await fetch(`/api/fs?dir=${encodeURIComponent(dir ?? '')}`);
  renderFs(await r.json());
  if (!$('#fsdlg').open) $('#fsdlg').showModal();
}

function renderFs(j) {
  fsDir = j.dir ?? '';
  fsParent = j.parent ?? null;
  fsPicked = j.picked ?? null;
  $('#fs_path').value = fsDir;
  $('#fs_up').disabled = !fsParent;
  $('#fs_tip').textContent = fsPicked ?? '点文件夹进去,点文件选中';
  const row = (e, isDir) => `<button class="fsrow${isDir ? ' dir' : ''}${fsPicked === e.path ? ' on' : ''}" data-path="${esc(e.path)}" data-dir="${isDir}">
      <i>${isDir ? '目录' : '文件'}</i>${esc(e.name)}</button>`;
  let html = '';
  if (j.error) html += `<p class="err">${esc(j.error)}</p>`;
  if (!fsDir) html += `<div class="grp">选择磁盘,或在上面粘贴一个完整路径</div>` + (j.drives ?? []).map((d) => row({ name: d, path: d }, true)).join('');
  else if (!(j.dirs?.length || j.files?.length)) html += '<p class="hint">这个文件夹是空的,可以点「用当前文件夹」。</p>';
  html += (j.dirs ?? []).map((e) => row(e, true)).join('') + (j.files ?? []).map((e) => row(e, false)).join('');
  $('#fs_list').innerHTML = html;
  for (const b of $('#fs_list').querySelectorAll('.fsrow')) {
    b.onclick = () => {
      if (b.dataset.dir === 'true') return openFs(b.dataset.path);
      fsPicked = b.dataset.path;
      for (const x of $('#fs_list').querySelectorAll('.fsrow')) x.classList.toggle('on', x === b);
      $('#fs_tip').textContent = fsPicked;
    };
  }
}

let resqTimer = null;
$('#resq').oninput = (ev) => {
  clearTimeout(resqTimer);
  resqTimer = setTimeout(() => { resFilter.q = ev.target.value.trim(); loadRes(); }, 250);
};

/* ───────────── QQ 消息:实时捕获 + 批次确认 ───────────── */
let qqState = null;
let qqBatches = [];
const qqOpenRaw = new Set();
let qqShowDone = false;

async function loadQQ() {
  const [st, batches] = await Promise.all([
    (await fetch('/api/qq/status')).json(),
    (await fetch('/api/inbox/qq')).json(),
  ]);
  qqState = st;
  qqBatches = batches;
  renderQQ();
}

function renderQQ() {
  const st = qqState;
  const bits = [
    st.watched.length ? `盯 <b>${st.watched.length}</b> 个群` : '<span class="err">还没选要盯的群</span>',
    st.polling ? `轮询中(每 ${Math.round(st.poll_ms / 1000)} 秒)` : '轮询未开',
    `已捕获 <b>${st.stored_total}</b> 条`,
    st.pending_total ? `待归纳 <b>${st.pending_total}</b> 条` : '无待归纳',
    `待确认 <b>${st.batches}</b> 批`,
    st.llm ? '归纳 <b>LLM</b>' : '归纳 <b>规则</b>(未配 API Key)',
  ];
  $('#qqbar').innerHTML = `<span class="st">${bits.join(' · ')}</span>`
    + (st.poll_error ? `<span class="st err">通道:${esc(st.poll_error)}</span>` : '')
    + '<span style="flex:1"></span>'
    + '<button class="mini" id="qq_poll">立即拉取</button>'
    + `<button class="mini" id="qq_rollup"${st.pending_total ? '' : ' disabled'}>归纳待处理</button>`
    + '<button class="mini" id="qq_reload">刷新</button>';
  $('#qq_poll').onclick = async (e) => { e.target.disabled = true; e.target.textContent = '拉取中…'; await fetch('/api/qq/poll', { method: 'POST' }); loadQQ(); };
  $('#qq_rollup').onclick = async (e) => { e.target.disabled = true; e.target.textContent = '归纳中…'; await fetch('/api/qq/rollup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); loadQQ(); };
  $('#qq_reload').onclick = loadQQ;

  if (!st.watched.length) {
    $('#qqpend').innerHTML = '<p class="err">还没配置要盯的群。在终端跑 <code>node src/qq-sync.js</code> 会列出你所有的群,'
      + '再 <code>node src/qq-sync.js --groups 群号1,群号2</code> 选定;选定后这里每隔几十秒自动拉一次新消息,开机脚本也会补历史。</p>';
  } else if (st.pending_total) {
    $('#qqpend').innerHTML = '<p>这些群还有没归纳成批次的消息:</p>' + st.pending.map((g) =>
      `<span class="grp">${esc(g.group_name || '群 ' + g.group_id)} <b>${g.n}</b> 条${st.watched.includes(String(g.group_id)) ? '' : ' · 没盯'}</span>`).join('');
  } else {
    $('#qqpend').innerHTML = '';
  }

  const fresh = qqBatches.filter((b) => b.status === 'new');
  const done = qqBatches.filter((b) => b.status !== 'new');
  $('#qqbatches').innerHTML =
    (fresh.length ? fresh.map(batchCard).join('')
      : '<p class="head">还没有待确认的批次。配好群之后新消息会自动进来,点「归纳待处理」就会变成这里的卡片;开机脚本补的历史也会出现在这。</p>')
    + (done.length ? `<p class="qdone"><button class="mini" id="qq_done">${qqShowDone ? '收起' : '展开'}已处理的 ${done.length} 批</button></p>`
      + (qqShowDone ? done.map(doneRow).join('') : '') : '');

  const doneBtn = $('#qq_done');
  if (doneBtn) doneBtn.onclick = () => { qqShowDone = !qqShowDone; renderQQ(); };
  for (const el of $('#qqbatches').querySelectorAll('[data-raw]')) {
    el.onclick = async () => {
      const id = Number(el.dataset.raw);
      if (qqOpenRaw.has(id)) { qqOpenRaw.delete(id); return renderQQ(); }
      const b = qqBatches.find((x) => x.id === id);
      if (b && b.content == null) Object.assign(b, await (await fetch(`/api/inbox/qq/${id}`)).json());
      qqOpenRaw.add(id);
      renderQQ();
    };
  }
  for (const el of $('#qqbatches').querySelectorAll('[data-dismiss]')) {
    el.onclick = async () => { await fetch(`/api/inbox/qq/${el.dataset.dismiss}/dismiss`, { method: 'POST' }); loadQQ(); };
  }
  for (const el of $('#qqbatches').querySelectorAll('[data-save]')) el.onclick = () => saveBatch(Number(el.dataset.save), el);
}

const qqCandRow = (t) => `<div class="cand" data-quote="${esc(t.quote ?? '')}" data-sender="${esc(t.sender ?? '')}" data-at="${esc(t.at ?? '')}">
  <input type="checkbox" class="pick" checked>
  <input class="cttl" value="${esc(t.title)}">
  <input class="cdue" value="${esc(t.due_at ?? '')}" placeholder="截止 YYYY-MM-DD HH:MM">
  <select class="cpri">
    <option value="must"${t.priority === 'must' ? ' selected' : ''}>必做</option>
    <option value="optional"${t.priority === 'optional' ? ' selected' : ''}>选做</option>
    <option value="unknown"${!t.priority || t.priority === 'unknown' ? ' selected' : ''}>待定</option>
  </select>
  ${t.quote ? `<span class="cquote">${t.sender ? `<b>${esc(t.sender)}${t.at ? ` · ${esc(t.at)}` : ''}:</b> ` : ''}“${esc(t.quote)}”</span>` : ''}
</div>`;

function batchCard(b) {
  const m = b.meta ?? {};
  const open = qqOpenRaw.has(b.id);
  return `<div class="qbatch">
    <div class="qhead">
      <span class="gname">${esc(m.group_name || '群 ' + m.group_id)}</span>
      <span class="qmeta">${m.count ?? '?'} 条消息 · ${esc(m.from_label ?? '')} → ${esc(m.to_label ?? '')} · ${esc(m.engine === 'llm' ? 'LLM 归纳' : '规则归纳')} · ${esc(m.origin === 'sync' ? '补历史' : '实时捕获')}</span>
      <button class="mini" data-raw="${b.id}">${open ? '收起原文' : '看原文'}</button>
      <button class="mini danger" data-dismiss="${b.id}">忽略这批</button>
    </div>
    ${open ? `<pre class="qraw">${esc(b.content ?? '')}</pre>` : ''}
    ${m.llm_error ? `<p class="err">这批 LLM 归纳失败,已退回规则引擎:${esc(m.llm_error)}</p>` : ''}
    ${b.candidates.length ? b.candidates.map(qqCandRow).join('') : '<p class="head">这批没解析出待办,可以直接忽略。</p>'}
    <div class="qbar"><button class="btn primary" data-save="${b.id}">保存勾选为待办</button><span class="tip">先勾选、改标题或时间,再保存;保存后这批标记为已处理</span></div>
  </div>`;
}

const doneRow = (b) => `<div class="qbatch" style="opacity:.55"><div class="qhead">
  <span class="gname">${esc(b.meta?.group_name || '群 ' + b.meta?.group_id)}</span>
  <span class="qmeta">${b.status === 'done' ? '已保存' : '已忽略'} · ${b.meta?.count ?? '?'} 条 · ${esc(b.created_at ?? '')}</span>
</div></div>`;

async function saveBatch(id, btn) {
  const card = btn.closest('.qbatch');
  const tasks = [...card.querySelectorAll('.cand')]
    .filter((c) => c.querySelector('.pick').checked)
    .map((c) => ({
      title: c.querySelector('.cttl').value.trim(),
      due_at: c.querySelector('.cdue').value.trim() || null,
      priority: c.querySelector('.cpri').value,
      meta: { quote: c.dataset.quote, sender: c.dataset.sender, at: c.dataset.at },
    }))
    .filter((t) => t.title);
  if (!tasks.length) {
    const old = btn.textContent;
    btn.textContent = '没勾选任何条目';
    setTimeout(() => { btn.textContent = old; }, 1500);
    return;
  }
  btn.disabled = true;
  const r = await (await fetch(`/api/inbox/qq/${id}/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tasks }),
  })).json();
  btn.textContent = `已保存 ${r.saved} 条`;
  setTimeout(() => { loadQQ(); loadPrio(); }, 600);
}

$('#sub_qq').onclick = () => {
  $('#sub_qq').classList.add('on'); $('#sub_paste').classList.remove('on');
  $('#qqpane').hidden = false; $('#pastepane').hidden = true;
  loadQQ();
};
$('#sub_paste').onclick = () => {
  $('#sub_paste').classList.add('on'); $('#sub_qq').classList.remove('on');
  $('#pastepane').hidden = false; $('#qqpane').hidden = true;
};
