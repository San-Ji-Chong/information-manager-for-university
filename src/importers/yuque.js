const UA = 'uni-info-hub';

/** config.json 里写 base 或 base_url 都认,带不带 /api/v2 都行。 */
export function yuqueCfg(config = {}) {
  const c = config.yuque ?? {};
  const base = String(c.base_url ?? c.base ?? '').replace(/\/+$/, '').replace(/\/api\/v2$/, '');
  if (!c.token || !c.namespace || !base) return null;
  return { base, namespace: c.namespace, token: c.token, timeout_ms: Number(c.timeout_ms ?? 30000) };
}

/** 语雀限流比较敏感,429/5xx/网络抖动退避重试;4xx 是 token 或路径错,重试没意义。 */
async function get(cfg, path, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1200 * 2 ** (i - 1)));
    try {
      const res = await fetch(`${cfg.base}/api/v2${path}`, {
        headers: { 'X-Auth-Token': cfg.token, 'User-Agent': UA },
        signal: AbortSignal.timeout(cfg.timeout_ms),
      });
      const raw = await res.text();
      if (res.status === 429 || res.status >= 500) { last = new Error(`HTTP ${res.status}: ${raw.slice(0, 160)}`); continue; }
      if (!res.ok) throw new Error(`语雀接口 ${path} → ${res.status}: ${raw.slice(0, 160)}`);
      return JSON.parse(raw).data;
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError' || e.name === 'TypeError') { last = e; continue; }
      throw e;
    }
  }
  throw last;
}

/** 目录树:顶层 TITLE 节点是按周分的组,DOC 节点挂在下面。 */
export const yuqueToc = (cfg) => get(cfg, `/repos/${cfg.namespace}/toc`);

export async function yuqueGetDoc(cfg, slug) {
  return get(cfg, `/repos/${cfg.namespace}/docs/${slug}`);
}

/** 列表接口一页最多 100,知识库有八百多篇,必须翻页。只为拿 updated_at 做增量比较。 */
export async function yuqueListDocs(cfg) {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const page = await get(cfg, `/repos/${cfg.namespace}/docs?limit=100&offset=${offset}`);
    out.push(...page);
    if (page.length < 100) return out;
  }
}

/** 只同步鼓楼校区的活动文档:标题以「鼓：」或「鼓/」开头。 */
export const GULOU = /^鼓\s*[：:/]/;

export function pickGulou(toc) {
  const seen = new Set();
  const out = [];
  for (const n of toc ?? []) {
    const slug = n.slug || n.url;
    if (n.type !== 'DOC' || !slug || seen.has(slug)) continue;
    if (!GULOU.test(String(n.title ?? '').trim())) continue;
    seen.add(slug);
    out.push({ slug, title: n.title });
  }
  return out;
}

export function parseDocDate(title, year = new Date().getFullYear()) {
  const m = String(title ?? '').match(/(\d{2})(\d{2})[：:]/);
  return m ? `${year}-${m[1]}-${m[2]}` : null;
}

const UPSERT = `INSERT INTO docs(source, slug, title, doc_date, body, url, updated_at) VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(source, slug) DO UPDATE SET title=excluded.title, body=excluded.body,
    url=excluded.url, updated_at=excluded.updated_at, synced_at=datetime('now','localtime')`;

export function upsertDocs(db, docs) {
  const up = db.prepare(UPSERT);
  let n = 0;
  for (const d of docs ?? []) {
    if (!d.slug || !d.title) continue;
    up.run('yuque', d.slug, d.title, parseDocDate(d.title), d.body ?? '', d.url ?? null, d.updated_at ?? null);
    n++;
  }
  return n;
}

/**
 * 增量同步:TOC 挑出「鼓：」文档 → 列表接口比对 updated_at → 只拉有变化的正文。
 * 返回变更的 slug,交给调用方决定要不要重跑 extractAllDocs。
 */
export async function syncYuque(db, cfg, { force = false, delayMs = 250, onLog } = {}) {
  const log = onLog ?? (() => {});
  const want = pickGulou(await yuqueToc(cfg));
  const remote = new Map((await yuqueListDocs(cfg)).map((d) => [d.slug, d]));
  const local = new Map(db.prepare(`SELECT slug, updated_at, LENGTH(body) AS blen FROM docs WHERE source='yuque'`)
    .all().map((d) => [d.slug, d]));

  const up = db.prepare(UPSERT);
  const changed = [];
  const errors = [];
  let skipped = 0;
  let added = 0;
  for (const { slug, title } of want) {
    const prev = local.get(slug);
    const stamp = remote.get(slug)?.updated_at ?? null;
    // 旧记录 updated_at 是空的(控制台脚本没给),或正文是空的,都得重拉一次
    if (!force && prev && prev.blen > 0 && prev.updated_at === stamp) { skipped++; continue; }
    try {
      const full = await yuqueGetDoc(cfg, slug);
      up.run('yuque', slug, full.title ?? title, parseDocDate(full.title ?? title), full.body ?? '',
        `${cfg.base}/${cfg.namespace}/${slug}`, full.updated_at ?? stamp);
      changed.push(slug);
      if (!prev) added++;
      log(`  ${prev ? '↻' : '＋'} ${full.title ?? title} (${(full.body ?? '').length} 字)`);
    } catch (e) {
      errors.push(`${title}: ${e.message}`);
      log(`  ✗ ${title}: ${e.message}`);
    }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { scanned: want.length, fetched: changed.length, added, updated: changed.length - added, skipped, errors, slugs: changed };
}
