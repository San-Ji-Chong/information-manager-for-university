import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { extractActivity } from './extract-activity.js';

export function extractAllDocs(db, docIds = null) {
  const rows = docIds
    ? db.prepare(`SELECT * FROM docs WHERE id IN (${docIds.map(() => '?').join(',')})`).all(...docIds)
    : db.prepare('SELECT * FROM docs').all();

  const insEvent = db.prepare(`INSERT INTO events(title, organizer, campus, start_at, end_at, due_at, location,
    capacity, tags, doc_id, source_url, source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insTask = db.prepare(`INSERT INTO tasks(title, due_at, priority, status, rank, meta, doc_id, source_url, source)
    VALUES (?,?,?,?,?,?,?,?,?)`);

  // 重新抽取时按标题接回用户改过的状态、手排的顺序和出处;标题/时间/优先级仍以文档为准
  const kept = new Map(db.prepare('SELECT title, status, rank, meta FROM tasks WHERE doc_id IS NOT NULL').all()
    .map((t) => [t.title, t]));

  let events = 0;
  const pending = [];
  for (const d of rows) {
    db.prepare('DELETE FROM events WHERE doc_id=?').run(d.id);
    db.prepare('DELETE FROM tasks WHERE doc_id=?').run(d.id);
    if (d.hidden) continue;

    const a = extractActivity(d.title, d.body ?? '');
    db.prepare('UPDATE docs SET kind=?, doc_date=COALESCE(?, doc_date) WHERE id=?')
      .run(a.isActivity ? 'activity' : 'note', a.start_at?.slice(0, 10) ?? null, d.id);

    if (a.isActivity) {
      insEvent.run(d.title, a.organizer, a.campus, a.start_at, a.end_at, a.due_at, a.location, a.capacity,
        JSON.stringify(['思训', ...(a.note ? [a.note] : [])]), d.id, d.url, 'yuque');
      events++;
    }
    pending.push({ doc: d, tasks: a.tasks });
  }

  const seen = new Set();
  let tasks = 0;
  for (const { doc, tasks: list } of pending) {
    for (const t of list) {
      const key = `${t.title}|${t.due_at ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const prev = kept.get(t.title);
      insTask.run(t.title, t.due_at, t.priority, prev?.status ?? 'todo', prev?.rank ?? null, prev?.meta ?? null,
        doc.id, doc.url, 'yuque');
      tasks++;
    }
  }
  return { docs: rows.length, events, tasks };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(extractAllDocs(openDb()));
}
