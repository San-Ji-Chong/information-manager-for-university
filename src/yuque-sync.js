import { loadConfig } from './config.js';
import { syncYuque, yuqueCfg } from './importers/yuque.js';
import { extractAllDocs } from './extract-docs.js';

const NO_CONFIG = `未配置语雀 Token,拿不到就只能在浏览器控制台跑 tools/yuque-sync-snippet.js。
1. 浏览器打开 https://你的语雀域名/settings/tokens → 新建(只读权限即可)
2. 写进 data/config.json 的 yuque 段:{ "base_url": "https://你的语雀域名/api/v2", "namespace": "团队/知识库", "token": "…" }`;

/** 同步「鼓：」活动文档,并对变更的文档重跑活动/DDL 提取。CLI 和服务端共用这一份。 */
export async function runYuqueSync(db, { force = false, onLog } = {}) {
  const cfg = yuqueCfg(loadConfig());
  if (!cfg) throw new Error(NO_CONFIG);

  const r = await syncYuque(db, cfg, { force, onLog });
  const ids = r.slugs.length
    ? db.prepare(`SELECT id FROM docs WHERE source='yuque' AND slug IN (${r.slugs.map(() => '?').join(',')})`)
      .all(...r.slugs).map((x) => x.id)
    : [];
  const ex = ids.length ? extractAllDocs(db, ids) : { docs: 0, events: 0, tasks: 0 };

  db.prepare(`INSERT INTO sources(type) VALUES('yuque') ON CONFLICT(type) DO NOTHING`).run();
  db.prepare(`UPDATE sources SET last_sync_at=datetime('now','localtime') WHERE type='yuque'`).run();
  return { ...r, ids, extracted: ex };
}

export function yuqueStatus(db) {
  const cfg = yuqueCfg(loadConfig());
  const row = db.prepare(`SELECT last_sync_at FROM sources WHERE type='yuque'`).get();
  const c = db.prepare(`SELECT COUNT(*) AS n FROM docs WHERE source='yuque'`).get().n;
  const act = db.prepare(`SELECT COUNT(*) AS n FROM docs WHERE source='yuque' AND kind='activity' AND hidden=0`).get().n;
  return { configured: !!cfg, namespace: cfg?.namespace ?? null, last_sync_at: row?.last_sync_at ?? null, docs: c, activities: act };
}
