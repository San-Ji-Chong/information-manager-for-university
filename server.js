import { createServer } from 'node:http';
import { mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './src/db.js';
import { loadConfig } from './src/config.js';
import { onebotClient, pullHistory } from './src/onebot.js';
import { handleOnebotEvent, patchState, qqStatus, readState, rollup, setGroupName, storeMsgs } from './src/qq-store.js';
import { importFromImage } from './src/helenote-pipeline.js';
import { upsertDocs } from './src/importers/yuque.js';
import { runYuqueSync, yuqueStatus } from './src/yuque-sync.js';
import { extractTasks } from './src/extract-tasks.js';
import { extractAllDocs } from './src/extract-docs.js';

const PORT = 8787;
const WEB = fileURLToPath(new URL('./web/', import.meta.url));
const INBOX = fileURLToPath(new URL('./data/inbox/', import.meta.url));
mkdirSync(INBOX, { recursive: true });
const db = openDb();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Private-Network': 'true',
};

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const EVENTS_IN_RANGE = `SELECT * FROM events WHERE date(start_at) BETWEEN ? AND ? ORDER BY start_at`;
const TASKS_IN_RANGE = `SELECT * FROM tasks WHERE date(due_at) BETWEEN ? AND ? ORDER BY due_at`;

// Host 头是客户端自己写的,不能信;只有真从本机 TCP 连进来的请求才允许碰磁盘和接收推送
const LOCAL_ADDR = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;
const fromLocal = (req) => LOCAL_ADDR.test(req.socket.remoteAddress ?? '');

const RES_FIELDS = ['title', 'url', 'path', 'kind', 'course', 'note'];
const cleanTags = (v) => [...new Set((Array.isArray(v) ? v : String(v ?? '').split(/[,，;；\n]/))
  .map((s) => String(s).trim().replace(/^#/, ''))
  .filter(Boolean))].slice(0, 20);
const resOut = (r) => ({ ...r, tags: JSON.parse(r.tags), exists: r.path ? existsSync(r.path) : null });
/** 待办的出处(原话/群名/说话人),只留白名单字段并限长,免得前端塞任意 JSON 进库。 */
const TASK_META = { quote: 400, group: 80, sender: 40, at: 24, engine: 12 };
function cleanTaskMeta(v) {
  if (!v || typeof v !== 'object') return null;
  const out = {};
  for (const [k, max] of Object.entries(TASK_META)) {
    if (typeof v[k] === 'string' && v[k].trim()) out[k] = v[k].trim().slice(0, max);
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}
function resPatch(body) {
  const out = {};
  for (const f of RES_FIELDS) if (f in body) out[f] = body[f] == null || body[f] === '' ? null : String(body[f]).trim();
  if ('tags' in body) out.tags = JSON.stringify(cleanTags(body.tags));
  return out;
}
function writeRes(id, patch) {
  const sets = Object.keys(patch);
  if (sets.length) {
    db.prepare(`UPDATE resources SET ${sets.map((f) => `${f}=?`).join(',')} WHERE id=?`)
      .run(...sets.map((f) => patch[f]), id);
  }
}

const drives = () => [...'CDEFGHIJKLMNOPQRSTUVWXYZ'].map((c) => `${c}:\\`)
  .filter((d) => { try { return statSync(d).isDirectory(); } catch { return false; } });
const byName = (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true });
function listDir(dir) {
  const dirs = [];
  const files = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('$')) continue;
    (e.isDirectory() ? dirs : files).push({ name: e.name, path: join(dir, e.name) });
  }
  const cap = (a) => a.sort(byName).slice(0, 400);
  return { dirs: cap(dirs), files: cap(files) };
}

// ── QQ 实时捕获:定时轮询 napcat 的「HTTP服务器」,新消息进 qq_msgs 缓冲表 ──
let pollTimer = null;
let pollBusy = false;
let pollError = '';

const qqConfig = () => loadConfig().qq ?? {};

async function pollOnce() {
  if (pollBusy) return { ok: false, reason: '上一轮还在跑' };
  pollBusy = true;
  try {
    const cfg = qqConfig();
    const groups = (cfg.groups ?? []).map(String);
    if (!groups.length) return { ok: true, groups: 0, stored: 0, per: [] };
    const client = onebotClient({
      url: cfg.url ?? 'http://127.0.0.1:3000', token: cfg.token ?? '', timeoutMs: Number(cfg.timeout_ms ?? 10000),
    });
    let names = new Map();
    try {
      for (const g of await client.groupList()) names.set(String(g.group_id), g.group_name ?? '');
    } catch { /* 群名拿不到不影响入库 */ }

    const state = readState(db);
    let stored = 0;
    let advanced = false;
    const per = [];
    for (const gid of groups) {
      const sinceSeq = Number(state.seq?.[gid] ?? 0);
      try {
        const r = await pullHistory(client, gid, {
          sinceSeq, limit: Number(cfg.limit ?? 200), pageSize: Number(cfg.page_size ?? 40), delayMs: 0,
        });
        const name = names.get(gid) ?? '';
        if (r.messages.length) {
          stored += storeMsgs(db, r.messages, name);
          if (name) setGroupName(db, gid, name);
        }
        if (r.maxSeq > sinceSeq) { state.seq[gid] = r.maxSeq; advanced = true; }
        per.push({ group_id: Number(gid), group_name: name, new: r.messages.length });
      } catch (e) {
        per.push({ group_id: Number(gid), error: e.message });
        pollError = e.message;
      }
    }
    if (advanced) patchState(db, { seq: state.seq });
    if (!per.some((x) => x.error)) pollError = '';
    return { ok: true, groups: groups.length, stored, per, error: pollError || null };
  } finally {
    pollBusy = false;
  }
}

function startPoller() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  const cfg = qqConfig();
  if (cfg.poll === false) return;
  const ms = Math.max(5000, Number(cfg.poll_ms ?? 30000));
  pollTimer = setInterval(() => { pollOnce().catch((e) => { pollError = e.message; }); }, ms);
  pollTimer.unref?.();
}

let yuqueBusy = false;
let yuqueResult = null;
let yuqueError = '';

/** 一次同步要十几个请求,别让它并发跑;结果留在内存里给前端轮询。 */
async function yuqueSync(force = false) {
  if (yuqueBusy) return { busy: true };
  yuqueBusy = true;
  yuqueError = '';
  try {
    const r = await runYuqueSync(db, { force, onLog: (s) => console.log(`语雀 ${s}`) });
    yuqueResult = { ...r, at: new Date().toLocaleString('zh-CN', { hour12: false }) };
    console.log(`语雀同步完成:扫描 ${r.scanned}、新增 ${r.added}、更新 ${r.updated}、跳过 ${r.skipped}、失败 ${r.errors.length}`
      + ` → ${r.extracted.events} 个活动 / ${r.extracted.tasks} 条待办`);
    return yuqueResult;
  } catch (e) {
    yuqueError = e.message;
    console.error('语雀同步失败:', e.message);
    return { error: e.message };
  } finally {
    yuqueBusy = false;
  }
}

async function api(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  if (req.method === 'GET' && p === '/api/calendar') {
    return json(res, 200, {
      events: db.prepare(EVENTS_IN_RANGE).all(q.get('from'), q.get('to')),
      tasks: db.prepare(TASKS_IN_RANGE).all(q.get('from'), q.get('to')),
    });
  }

  if (req.method === 'GET' && p === '/api/day') {
    const d = q.get('date');
    // 带上 doc_title,前端「出处」才能写清是哪篇语雀文档,而不只是"语雀"
    const cols = 't.*, d.title AS doc_title';
    const from = 'FROM tasks t LEFT JOIN docs d ON d.id = t.doc_id';
    return json(res, 200, {
      events: db.prepare('SELECT * FROM events WHERE date(start_at)=? ORDER BY start_at').all(d),
      tasks: db.prepare(`SELECT ${cols} ${from} WHERE date(t.due_at)=? ORDER BY t.due_at`).all(d),
      undated: db.prepare(`SELECT ${cols} ${from} WHERE t.due_at IS NULL AND t.status='todo' ORDER BY t.id`).all(),
    });
  }

  let m;
  if ((m = p.match(/^\/api\/events\/(\d+)$/)) && req.method === 'PATCH') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const fields = ['title', 'organizer', 'campus', 'start_at', 'due_at', 'location', 'capacity'];
    const sets = fields.filter((f) => f in body);
    if (sets.length) {
      db.prepare(`UPDATE events SET ${sets.map((f) => `${f}=?`).join(',')} WHERE id=?`)
        .run(...sets.map((f) => body[f]), Number(m[1]));
    }
    return json(res, 200, db.prepare('SELECT * FROM events WHERE id=?').get(Number(m[1])));
  }

  if ((m = p.match(/^\/api\/events\/(\d+)$/)) && req.method === 'DELETE') {
    const ev = db.prepare('SELECT doc_id FROM events WHERE id=?').get(Number(m[1]));
    if (!ev) return json(res, 404, { error: 'not found' });
    if (ev.doc_id) {
      db.prepare('UPDATE docs SET hidden=1 WHERE id=?').run(ev.doc_id);
      extractAllDocs(db);
    } else {
      db.prepare('DELETE FROM events WHERE id=?').run(Number(m[1]));
    }
    return json(res, 200, { ok: true });
  }

  if ((m = p.match(/^\/api\/tasks\/(\d+)$/)) && req.method === 'PATCH') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const fields = ['title', 'due_at', 'priority', 'status'];
    const sets = fields.filter((f) => f in body);
    if (sets.length) {
      db.prepare(`UPDATE tasks SET ${sets.map((f) => `${f}=?`).join(',')} WHERE id=?`)
        .run(...sets.map((f) => body[f]), Number(m[1]));
    }
    return json(res, 200, db.prepare('SELECT * FROM tasks WHERE id=?').get(Number(m[1])));
  }

  if (req.method === 'GET' && p === '/api/tasks') {
    const status = q.get('status') ?? 'todo';
    const rows = db.prepare(`SELECT t.*, d.title AS doc_title FROM tasks t LEFT JOIN docs d ON d.id = t.doc_id
      WHERE t.status=?
      ORDER BY t.rank IS NULL, t.rank, CASE t.priority WHEN 'must' THEN 0 WHEN 'optional' THEN 1 ELSE 2 END,
               COALESCE(t.due_at, '9999'), t.id`).all(status);
    return json(res, 200, rows.map((t) => ({ ...t, meta: JSON.parse(t.meta ?? 'null') })));
  }

  /** 拖拽排序:传来的 id 顺序就是新的优先级顺序。 */
  if (req.method === 'POST' && p === '/api/tasks/reorder') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const ids = (body.ids ?? []).map(Number).filter(Number.isInteger);
    const upd = db.prepare('UPDATE tasks SET rank=? WHERE id=?');
    db.exec('BEGIN');
    try {
      ids.forEach((id, i) => upd.run(i + 1, id));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return json(res, 200, { ordered: ids.length });
  }

  if (req.method === 'GET' && p === '/api/docs') {
    return json(res, 200, db.prepare(`SELECT id, slug, title, kind, hidden, doc_date, url, updated_at,
      (SELECT COUNT(*) FROM tasks t WHERE t.doc_id=docs.id) AS task_count
      FROM docs ORDER BY hidden, kind DESC, doc_date DESC, id DESC`).all());
  }

  if (req.method === 'POST' && p === '/api/docs/hidden') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const ids = (body.ids ?? []).map(Number).filter((n) => Number.isInteger(n));
    const hidden = body.hidden ? 1 : 0;
    if (ids.length) {
      db.prepare(`UPDATE docs SET hidden=? WHERE id IN (${ids.map(() => '?').join(',')})`).run(hidden, ...ids);
    }
    return json(res, 200, { hidden, ids: ids.length, ...extractAllDocs(db) });
  }

  if ((m = p.match(/^\/api\/docs\/(\d+)$/)) && req.method === 'GET') {
    const doc = db.prepare('SELECT * FROM docs WHERE id=?').get(Number(m[1]));
    if (!doc) return json(res, 404, { error: 'not found' });
    doc.events = db.prepare(`SELECT * FROM events WHERE doc_id=?
      OR (doc_id IS NULL AND ? IS NOT NULL AND date(start_at)=?) ORDER BY doc_id IS NULL, start_at`)
      .all(doc.id, doc.doc_date, doc.doc_date);
    doc.tasks = db.prepare('SELECT * FROM tasks WHERE doc_id=? ORDER BY due_at, id').all(doc.id);
    return json(res, 200, doc);
  }

  if (req.method === 'POST' && p === '/api/ingest/yuque') {
    const body = JSON.parse((await readBody(req)).toString('utf8'));
    const imported = upsertDocs(db, body.docs);
    return json(res, 200, { imported, ...extractAllDocs(db) });
  }

  /** 团队 Token 走 OpenAPI 同步,不用再在浏览器控制台粘脚本。force=true 忽略 updated_at 全部重拉。 */
  if (req.method === 'POST' && p === '/api/yuque/sync') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const r = await yuqueSync(!!body.force);
    if (r?.error) return json(res, 502, r);
    const { slugs, ids, ...summary } = r;
    return json(res, 200, summary);
  }

  if (req.method === 'GET' && p === '/api/yuque/status') {
    const { slugs, ids, ...summary } = yuqueResult ?? {};
    return json(res, 200, { ...yuqueStatus(db), busy: yuqueBusy, error: yuqueError || null, last: yuqueResult ? summary : null });
  }

  if (req.method === 'POST' && p === '/api/extract') {
    return json(res, 200, extractAllDocs(db));
  }

  if (req.method === 'POST' && p === '/api/inbox') {
    const body = JSON.parse((await readBody(req)).toString('utf8'));
    const r = db.prepare('INSERT INTO raw_items(source, kind, content) VALUES (?,?,?)')
      .run(body.source ?? 'manual', 'text', body.content ?? '');
    return json(res, 200, { id: Number(r.lastInsertRowid), candidates: extractTasks(body.content ?? '') });
  }

  if (req.method === 'POST' && p === '/api/tasks') {
    const body = JSON.parse((await readBody(req)).toString('utf8'));
    const ins = db.prepare(`INSERT INTO tasks(title, due_at, priority, status, source, raw_item_id)
                            VALUES (?,?,?,?,?,?)`);
    let n = 0;
    for (const t of body.tasks ?? []) {
      if (!t.title?.trim()) continue;
      ins.run(t.title.trim(), t.due_at || null, ['must', 'optional', 'unknown'].includes(t.priority) ? t.priority : 'unknown',
        'todo', body.source ?? 'message', body.raw_item_id ?? null);
      n++;
    }
    return json(res, 200, { saved: n });
  }
  if (req.method === 'GET' && p === '/api/resources') {
    const rows = db.prepare('SELECT * FROM resources ORDER BY id DESC').all().map(resOut);
    const kw = (q.get('q') ?? '').trim().toLowerCase();
    const tag = q.get('tag');
    const kind = q.get('kind');
    const course = q.get('course');
    const items = rows.filter((r) => (!kind || r.kind === kind)
      && (!course || r.course === course)
      && (tag === '__none__' ? !r.tags.length : !tag || r.tags.includes(tag))
      && (!kw || [r.title, r.note, r.course, r.kind, r.url, r.path, ...r.tags]
        .some((s) => (s ?? '').toLowerCase().includes(kw))));
    const tally = (pick) => {
      const m2 = new Map();
      for (const r of rows) for (const k of pick(r)) if (k) m2.set(k, (m2.get(k) ?? 0) + 1);
      return [...m2].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || byName(a, b));
    };
    return json(res, 200, {
      items,
      kinds: tally((r) => [r.kind]),
      courses: tally((r) => [r.course]),
      tags: tally((r) => r.tags),
      untagged: rows.filter((r) => !r.tags.length).length,
      total: rows.length,
    });
  }

  if (req.method === 'POST' && p === '/api/resources') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const patch = resPatch(body);
    if (!patch.title) return json(res, 400, { error: '标题不能为空' });
    const r = db.prepare(`INSERT INTO resources(title, url, path, kind, course, tags, note) VALUES (?,?,?,?,?,?,?)`)
      .run(patch.title, patch.url ?? null, patch.path ?? null, patch.kind ?? null,
        patch.course ?? null, patch.tags ?? '[]', patch.note ?? null);
    return json(res, 200, resOut(db.prepare('SELECT * FROM resources WHERE id=?').get(Number(r.lastInsertRowid))));
  }

  if (req.method === 'POST' && p === '/api/resources/tag') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const ids = (body.ids ?? []).map(Number).filter(Number.isInteger);
    const add = cleanTags(body.add);
    const remove = cleanTags(body.remove);
    const get = db.prepare('SELECT tags FROM resources WHERE id=?');
    let n = 0;
    for (const id of ids) {
      const row = get.get(id);
      if (!row) continue;
      const tags = JSON.parse(row.tags);
      for (const t of add) if (!tags.includes(t)) tags.push(t);
      writeRes(id, { tags: JSON.stringify(tags.filter((t) => !remove.includes(t))) });
      n++;
    }
    return json(res, 200, { updated: n });
  }

  if (req.method === 'POST' && p === '/api/resources/delete') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const ids = (body.ids ?? []).map(Number).filter(Number.isInteger);
    if (ids.length) db.prepare(`DELETE FROM resources WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    return json(res, 200, { deleted: ids.length });
  }

  if (req.method === 'POST' && p === '/api/resources/from-docs') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const want = body.kind === 'activity' ? 'activity' : 'note';
    const have = new Set(db.prepare('SELECT doc_id FROM resources WHERE doc_id IS NOT NULL').all().map((r) => r.doc_id));
    const rows = db.prepare(`SELECT * FROM docs WHERE hidden=0 AND COALESCE(kind,'note')=? ORDER BY id`).all(want);
    const ins = db.prepare('INSERT INTO resources(title, url, kind, course, tags, doc_id) VALUES (?,?,?,?,?,?)');
    const tags = JSON.stringify(cleanTags(body.tags ?? ['学长笔记']));
    let n = 0;
    for (const d of rows) {
      if (have.has(d.id)) continue;
      ins.run(d.title, d.url, '笔记', body.course ?? '思维训练营', tags, d.id);
      n++;
    }
    return json(res, 200, { imported: n, skipped: rows.length - n });
  }

  if ((m = p.match(/^\/api\/resources\/(\d+)\/open$/)) && req.method === 'POST') {
    if (!fromLocal(req)) return json(res, 403, { error: '只能从本机调用' });
    const row = db.prepare('SELECT path FROM resources WHERE id=?').get(Number(m[1]));
    if (!row?.path) return json(res, 404, { error: '这条没有本地路径' });
    if (!existsSync(row.path)) return json(res, 404, { error: '文件不在了(可能被移动或重命名)' });
    spawn('explorer.exe', [row.path], { detached: true, stdio: 'ignore' }).unref();
    return json(res, 200, { ok: true, path: row.path });
  }

  if ((m = p.match(/^\/api\/resources\/(\d+)$/)) && req.method === 'PATCH') {
    const id = Number(m[1]);
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (!db.prepare('SELECT 1 FROM resources WHERE id=?').get(id)) return json(res, 404, { error: 'not found' });
    writeRes(id, resPatch(body));
    return json(res, 200, resOut(db.prepare('SELECT * FROM resources WHERE id=?').get(id)));
  }

  if ((m = p.match(/^\/api\/resources\/(\d+)$/)) && req.method === 'DELETE') {
    db.prepare('DELETE FROM resources WHERE id=?').run(Number(m[1]));
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && p === '/api/fs') {
    if (!fromLocal(req)) return json(res, 403, { error: '只能从本机调用' });
    const empty = { dir: '', parent: null, drives: drives(), dirs: [], files: [] };
    const dir = (q.get('dir') ?? '').trim();
    if (!dir) return json(res, 200, empty);
    let st = null;
    try { st = statSync(dir); } catch { return json(res, 404, { ...empty, error: `打不开 ${dir}` }); }
    const target = st.isDirectory() ? dir : dirname(dir);
    let listed = null;
    try { listed = listDir(target); } catch { return json(res, 404, { ...empty, error: `读不了 ${target}` }); }
    const parent = dirname(target);
    return json(res, 200, {
      ...empty, dir: target, parent: parent === target ? null : parent,
      picked: st.isFile() ? dir : null, ...listed,
    });
  }

  if (req.method === 'POST' && p === '/api/onebot') {
    if (!fromLocal(req)) return json(res, 403, { error: '只能从本机调用' });
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    return json(res, 200, { status: 'ok', retcode: 0, data: handleOnebotEvent(db, body) });
  }

  if (req.method === 'GET' && p === '/api/qq/status') {
    const cfg = qqConfig();
    return json(res, 200, {
      ...qqStatus(db, loadConfig()),
      polling: Boolean(pollTimer),
      poll_ms: cfg.poll_ms ?? 30000,
      poll_error: pollError || null,
      url: cfg.url ?? 'http://127.0.0.1:3000',
    });
  }

  if (req.method === 'POST' && p === '/api/qq/poll') return json(res, 200, await pollOnce());

  if (req.method === 'POST' && p === '/api/qq/rollup') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const groups = Array.isArray(body.groups) ? body.groups.map(Number).filter(Number.isInteger) : null;
    const batches = await rollup(db, { config: loadConfig(), groups, origin: 'live' });
    return json(res, 200, { batches });
  }

  if (req.method === 'GET' && p === '/api/inbox/qq') {
    const rows = db.prepare(`SELECT id, meta, candidates, status, created_at FROM raw_items
                             WHERE source='qq' ORDER BY id DESC LIMIT 200`).all();
    return json(res, 200, rows.map((r) => ({
      ...r, meta: JSON.parse(r.meta ?? '{}'), candidates: JSON.parse(r.candidates ?? '[]'),
    })));
  }

  if ((m = p.match(/^\/api\/inbox\/qq\/(\d+)$/)) && req.method === 'GET') {
    const r = db.prepare(`SELECT * FROM raw_items WHERE id=? AND source='qq'`).get(Number(m[1]));
    if (!r) return json(res, 404, { error: 'not found' });
    return json(res, 200, { ...r, meta: JSON.parse(r.meta ?? '{}'), candidates: JSON.parse(r.candidates ?? '[]') });
  }

  if ((m = p.match(/^\/api\/inbox\/qq\/(\d+)\/confirm$/)) && req.method === 'POST') {
    const id = Number(m[1]);
    const batch = db.prepare(`SELECT meta FROM raw_items WHERE id=? AND source='qq'`).get(id);
    if (!batch) return json(res, 404, { error: 'not found' });
    const bm = JSON.parse(batch.meta ?? '{}');
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const ins = db.prepare(`INSERT INTO tasks(title, due_at, priority, status, source, raw_item_id, meta)
                            VALUES (?,?,?,?,?,?,?)`);
    let n = 0;
    for (const t of body.tasks ?? []) {
      if (!t.title?.trim()) continue;
      ins.run(String(t.title).trim(), t.due_at || null,
        ['must', 'optional', 'unknown'].includes(t.priority) ? t.priority : 'unknown', 'todo', 'qq', id,
        cleanTaskMeta({ ...t.meta, group: bm.group_name, engine: bm.engine }));
      n++;
    }
    db.prepare(`UPDATE raw_items SET status='done' WHERE id=?`).run(id);
    return json(res, 200, { saved: n });
  }

  if ((m = p.match(/^\/api\/inbox\/qq\/(\d+)\/dismiss$/)) && req.method === 'POST') {
    db.prepare(`UPDATE raw_items SET status='dismissed' WHERE id=? AND source='qq'`).run(Number(m[1]));
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && p === '/api/import/helenote') {
    const buf = await readBody(req);
    const file = join(INBOX, `helenote-${Date.now()}.png`);
    await writeFile(file, buf);
    const events = importFromImage(db, file);
    return json(res, 200, { events });
  }

  return json(res, 404, { error: 'not found' });
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const fp = join(WEB, normalize(rel));
    if (!fp.startsWith(WEB)) { res.writeHead(403); return res.end(); }
    const body = await readFile(fp);
    // 本地开发:改完前端刷新就该看到,别让浏览器拿缓存的旧 css/js
    res.writeHead(200, { 'Content-Type': MIME[extname(fp)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch (e) {
    console.error(`${req.method} ${url.pathname} →`, e.message);
    res.writeHead(404);
    res.end('not found');
  }
}).listen(PORT, () => {
  console.log(`大学信息集成系统 → http://localhost:${PORT}`);
  startPoller();
  const cfg = qqConfig();
  console.log(cfg.groups?.length
    ? `QQ 实时捕获:每 ${cfg.poll_ms ?? 30000}ms 轮询群 ${cfg.groups.join(', ')}`
    : 'QQ 实时捕获:未配置群(跑 node src/qq-sync.js --groups … 或改 data/config.json)');
  // 语雀同步要十几个请求,放后台跑,不挡服务启动
  if (yuqueStatus(db).configured) {
    console.log('语雀:后台同步「鼓：」活动文档…');
    yuqueSync();
  } else {
    console.log('语雀:未配置 Token(改 data/config.json 的 yuque 段,或手动跑浏览器控制台脚本)');
  }
});
