import { analyzeAll, transcript } from './analyze.js';
import { normalizeMessages } from './onebot.js';

const stamp = (t) => (t ? new Date(t * 1000).toLocaleString('zh-CN') : '');

export function readState(db) {
  const row = db.prepare(`SELECT config FROM sources WHERE type='qq'`).get();
  const s = row ? JSON.parse(row.config) : {};
  if (!s.seq || typeof s.seq !== 'object') s.seq = {};
  return s;
}

export function writeState(db, state) {
  db.prepare(`INSERT INTO sources(type, config, last_sync_at) VALUES('qq', ?, datetime('now','localtime'))
              ON CONFLICT(type) DO UPDATE SET config=excluded.config, last_sync_at=excluded.last_sync_at`)
    .run(JSON.stringify(state));
}

export function patchState(db, patch) {
  const s = { ...readState(db), ...patch };
  writeState(db, s);
  return s;
}

export function storeMsg(db, m, groupName = '') {
  const gid = Number(m.group_id) || 0;
  const mid = String(m.message_id ?? '').trim() || `${gid}:${m.seq ?? 0}:${m.time ?? 0}`;
  const r = db.prepare(`INSERT INTO qq_msgs(group_id, group_name, message_id, seq, user_id, sender, text, time)
                        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(message_id) DO NOTHING`)
    .run(gid, groupName || null, mid, Number(m.seq) || null, Number(m.user_id) || null,
      String(m.sender ?? ''), String(m.text ?? ''), Number(m.time) || null);
  return r.changes > 0;
}

export function storeMsgs(db, list, groupName = '') {
  let n = 0;
  db.exec('BEGIN');
  try {
    for (const m of list) if (storeMsg(db, m, groupName)) n++;
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return n;
}

export function setGroupName(db, gid, name) {
  if (!name) return 0;
  return db.prepare(`UPDATE qq_msgs SET group_name=? WHERE group_id=? AND COALESCE(group_name,'')<>?`)
    .run(name, Number(gid), name).changes;
}

export function pendingGroups(db) {
  return db.prepare(`SELECT group_id, MAX(COALESCE(group_name,'')) AS group_name, COUNT(*) AS n,
                            MIN(COALESCE(time,0)) AS from_time, MAX(COALESCE(time,0)) AS to_time
                     FROM qq_msgs WHERE batch_id IS NULL
                     GROUP BY group_id ORDER BY n DESC, group_id`).all();
}

export function pendingTotal(db) {
  return db.prepare(`SELECT COUNT(*) AS n FROM qq_msgs WHERE batch_id IS NULL`).get().n;
}

/** 把还没归入批次的消息按群打包:分析 → 写一行 raw_items 批次 → 回填 batch_id。 */
export async function rollup(db, { config = {}, groups = null, chunk = 60, origin = 'live', dry = false } = {}) {
  const ids = (groups ?? []).map(Number).filter(Number.isInteger);
  const rows = db.prepare(`SELECT * FROM qq_msgs WHERE batch_id IS NULL
      ${ids.length ? `AND group_id IN (${ids.map(() => '?').join(',')})` : ''}
      ORDER BY group_id, COALESCE(time,0), COALESCE(seq,0), id`).all(...ids);

  const buckets = new Map();
  for (const r of rows) {
    if (!buckets.has(r.group_id)) buckets.set(r.group_id, []);
    buckets.get(r.group_id).push(r);
  }

  const out = [];
  for (const [gid, list] of buckets) {
    const msgs = list.map((r) => ({
      seq: r.seq ?? 0, message_id: r.message_id, group_id: gid,
      user_id: r.user_id, time: r.time ?? 0, sender: r.sender ?? '', text: r.text ?? '',
    }));
    const { engine, tasks, llmError } = await analyzeAll(msgs, { config, chunk });
    const name = list.find((r) => r.group_name)?.group_name ?? '';
    const first = msgs[0];
    const last = msgs[msgs.length - 1];
    const res = { group_id: gid, group_name: name, count: msgs.length, engine, tasks, llmError };
    if (dry) { out.push(res); continue; }

    const meta = {
      group_id: gid, group_name: name, count: msgs.length, engine, origin,
      ...(llmError ? { llm_error: llmError } : {}),
      from_seq: first?.seq || null, to_seq: last?.seq || null,
      from_time: first?.time ?? null, to_time: last?.time ?? null,
      from_label: stamp(first?.time), to_label: stamp(last?.time),
    };
    const info = db.prepare(`INSERT INTO raw_items(source, kind, content, meta, candidates, status)
                             VALUES('qq','qq_group',?,?,?,'new')`)
      .run(transcript(msgs), JSON.stringify(meta), JSON.stringify(tasks));
    const bid = Number(info.lastInsertRowid);
    db.prepare(`UPDATE qq_msgs SET batch_id=? WHERE id IN (${list.map(() => '?').join(',')})`)
      .run(bid, ...list.map((r) => r.id));
    out.push({ ...res, batch_id: bid });
  }
  return out;
}

/** napcat 反向 HTTP POST 推来的事件。只认群消息和心跳,其余静默忽略。 */
export function handleOnebotEvent(db, ev) {
  if (!ev || typeof ev !== 'object') return { ok: false, error: '空事件' };

  if (ev.post_type === 'meta_event') {
    patchState(db, {
      alive: { type: ev.meta_event_type ?? '?', at: Math.floor(Date.now() / 1000), self_id: ev.self_id ?? null },
    });
    return { ok: true, meta_event: ev.meta_event_type };
  }
  if (ev.post_type !== 'message') return { ok: true, ignored: ev.post_type ?? '?' };
  if (ev.message_type !== 'group') return { ok: true, ignored: ev.message_type ?? '?' };

  const [m] = normalizeMessages([ev]);
  if (!m?.text) return { ok: true, skipped: 'empty' };
  const stored = storeMsg(db, { ...m, group_id: ev.group_id }, ev.group_name ?? '');
  return { ok: true, stored, group_id: Number(ev.group_id), pending: pendingTotal(db) };
}

export function qqStatus(db, config = {}) {
  const state = readState(db);
  const pending = pendingGroups(db);
  return {
    watched: (config.qq?.groups ?? []).map(String),
    pending,
    pending_total: pending.reduce((s, g) => s + g.n, 0),
    stored_total: db.prepare(`SELECT COUNT(*) AS n FROM qq_msgs`).get().n,
    batches: db.prepare(`SELECT COUNT(*) AS n FROM raw_items WHERE source='qq' AND status='new'`).get().n,
    alive: state.alive ?? null,
    seq: state.seq ?? {},
    llm: Boolean(config.llm?.api_key && config.llm?.base_url && config.llm?.model && config.llm?.enabled !== false),
  };
}
