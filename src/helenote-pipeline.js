import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeLine } from './normalize.js';
import { parseHelenote } from './parse-helenote.js';

const PS1 = fileURLToPath(new URL('../tools/ocr.ps1', import.meta.url));
const DATE_ANCHOR = /\d{4}.\d{1,2}.\d{1,2}\s\d{1,2}:\d{2}/;

function pickColumn(ocr) {
  const lines = ocr.lines.map((l) => ({ ...l, cx: l.x + l.w / 2 }));
  const centers = [...new Set(lines.map((l) => Math.round(l.cx)))].sort((a, b) => a - b);
  let bestGap = 0;
  let splitAt = null;
  for (let i = 1; i < centers.length; i++) {
    const g = centers[i] - centers[i - 1];
    if (g > bestGap) { bestGap = g; splitAt = (centers[i - 1] + centers[i]) / 2; }
  }
  let col = lines;
  if (bestGap > ocr.width * 0.10) {
    const left = lines.filter((l) => l.cx < splitAt);
    const right = lines.filter((l) => l.cx >= splitAt);
    const has = (ls) => ls.some((l) => DATE_ANCHOR.test(normalizeLine(l.text)));
    if (has(left) && !has(right)) col = left;
    else if (has(right) && !has(left)) col = right;
    else col = left.length >= right.length ? left : right;
  }
  return col.sort((a, b) => a.y - b.y);
}

export function ocrImage(imagePath) {
  const out = join(tmpdir(), `helenote-ocr-${Date.now()}.json`);
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, imagePath, out], { stdio: 'pipe' });
  const ocr = JSON.parse(readFileSync(out, 'utf8'));
  rmSync(out, { force: true });
  return ocr;
}

export function importFromImage(db, imagePath) {
  const norm = pickColumn(ocrImage(imagePath)).map((l) => normalizeLine(l.text));
  const events = parseHelenote(norm);
  const raw = db.prepare('INSERT INTO raw_items(source, kind, image_path, content) VALUES (?,?,?,?)')
    .run('helenote', 'image', imagePath, norm.join('\n'));
  const ins = db.prepare(`INSERT INTO events(title, organizer, campus, start_at, due_at, location, capacity, tags, source, raw_item_id)
                          VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (const e of events) {
    ins.run(e.title, e.organizer ?? null, e.campus ?? null, e.start_at, e.due_at ?? null,
      e.location, e.capacity ?? null, JSON.stringify(e.tags), 'helenote', raw.lastInsertRowid);
  }
  return events;
}
