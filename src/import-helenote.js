import { openDb } from './db.js';
import { importFromImage } from './helenote-pipeline.js';

const img = process.argv[2];
if (!img) {
  console.error('用法: node src/import-helenote.js <截图.png>');
  process.exit(1);
}
const events = importFromImage(openDb(), img);
console.log(`\n解析出 ${events.length} 条活动:`);
for (const e of events) {
  console.log(`  - ${e.start_at}  ${e.title}`);
  console.log(`      ${e.organizer ?? '?'} · ${e.campus ?? '?'} | ${e.location} | 报名 ${e.capacity ?? '?'} | 截止 ${e.due_at ?? '?'}`);
}
