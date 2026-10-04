import { readFile } from 'node:fs/promises';
import { openDb } from './db.js';
import { upsertDocs } from './importers/yuque.js';

const file = process.argv[2];
if (!file) {
  console.error('用法: node src/import-yuque-json.js <语雀同步JSON文件>');
  process.exit(1);
}

const parsed = JSON.parse(await readFile(file, 'utf8'));
const docs = Array.isArray(parsed) ? parsed : parsed.docs;
const db = openDb();
console.log(`入库 ${upsertDocs(db, docs)} 篇文档`);
