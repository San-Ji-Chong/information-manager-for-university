import { openDb } from './db.js';
import { runYuqueSync } from './yuque-sync.js';

const force = process.argv.includes('--force');
try {
  const r = await runYuqueSync(openDb(), { force, onLog: console.log });
  console.log(`\n扫描 ${r.scanned} 篇「鼓：」文档 → 新增 ${r.added}、更新 ${r.updated}、跳过 ${r.skipped}、失败 ${r.errors.length}`);
  console.log(`重算:${r.extracted.events} 个活动、${r.extracted.tasks} 条待办`);
  if (r.errors.length) console.log(`失败明细:\n${r.errors.map((e) => `  - ${e}`).join('\n')}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
