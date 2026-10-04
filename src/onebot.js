const SEG_NAME = {
  face: '表情', image: '图片', record: '语音', video: '视频', file: '文件',
  dice: '骰子', rps: '猜拳', share: '链接', contact: '名片', location: '位置',
  poke: '戳一戳', node: '合并转发', json: '卡片', xml: '卡片',
};

function segText(seg) {
  const d = seg?.data ?? {};
  if (seg?.type === 'text') return d.text ?? '';
  if (seg?.type === 'at') return d.qq === 'all' ? '@全体成员 ' : `@${d.name ?? d.qq ?? ''} `;
  if (seg?.type === 'file') return d.name ? `[文件 ${d.name}]` : '[文件]';
  if (seg?.type === 'share') return d.title ? `[链接 ${d.title}]` : '[链接]';
  if (seg?.type === 'forward' || seg?.type === 'node') {
    const nodes = Array.isArray(d.content) ? d.content : Array.isArray(d) ? d : [];
    return nodes.map((n) => `${n.sender?.nickname ?? n.data?.name ?? ''}: ${segsText(n.content ?? n.data?.content)}`).join('\n');
  }
  const n = SEG_NAME[seg?.type] ?? seg?.type;
  return n ? `[${n}]` : '';
}

export function segsText(segs) {
  return Array.isArray(segs) ? segs.map(segText).join('') : '';
}

/** raw_message 里富媒体是 [CQ:xxx,参数] 代码,卡片类参数还是转义过的 JSON,读不出来也归纳不了。 */
export function stripCQ(text) {
  return decodeEnt(String(text ?? '')
    .replace(/\[CQ:(?:json|xml)[\s\S]*$/gi, '[卡片]')
    .replace(/\[CQ:at,qq=all[^\]]*\]/gi, '@全体成员 ')
    .replace(/\[CQ:at[^\]]*\]/gi, '')
    .replace(/\[CQ:([a-z]+)(?:,([^\]]*))?\]/gi, (_, t, args) => {
      const n = SEG_NAME[t];
      if (!n) return '';
      const name = /(?:^|,)(?:file|title|name|text)=([^,]*)/.exec(args ?? '')?.[1];
      return name ? `[${n} ${name}]` : `[${n}]`;
    })
    .replace(/\[CQ:[a-z]+[^\]]*/gi, '')
    .replace(/[ \t]{2,}/g, ' ')).trim();
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEnt(s) {
  return s.replace(/&(#[0-9]+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(parseInt(e.slice(1), e[1] === 'x' || e[1] === 'X' ? 16 : 10));
    return ENT[e.toLowerCase()] ?? m;
  });
}

/** 优先用 message 段(干净),没有段才退回 raw_message 并清洗 CQ。 */
export function msgText(m) {
  const s = segsText(m?.message);
  if (s.trim()) return s.trim();
  if (typeof m?.raw_message === 'string' && m.raw_message.trim()) return stripCQ(m.raw_message);
  if (typeof m?.message === 'string') return stripCQ(m.message);
  return '';
}

export function msgSender(m) {
  const s = m?.sender ?? {};
  return String(s.card || s.nickname || s.name || m?.user_id || '未知');
}

export function normalizeMessages(list) {
  return (Array.isArray(list) ? list : [])
    .map((m) => ({
      seq: Number(m.message_seq ?? m.seq ?? 0),
      message_id: m.message_id,
      group_id: m.group_id,
      user_id: m.user_id,
      time: Number(m.time ?? 0),
      sender: msgSender(m),
      text: msgText(m),
    }))
    .sort((a, b) => a.seq - b.seq || a.time - b.time);
}

export class OneBotError extends Error {
  constructor(message, { hint, cause, retcode, status } = {}) {
    super(message, { cause });
    this.name = 'OneBotError';
    this.hint = hint;
    this.retcode = retcode;
    this.status = status;
  }
}

const webuiHint = (base) => `连不上 ${base}。napcat 默认只开了 WebUI(6099),那不是 OneBot 接口。
请在 napcat WebUI → 网络配置 里新建一个「HTTP服务器」,监听 127.0.0.1:3000(端口要和 --url 一致),保存并重连后再跑本脚本。`;

const TOKEN_HINT = 'Token 不对。napcat WebUI → 网络配置 → HTTP服务器 里填的「Token」要用 --token 原样传进来;那里留空就不要传 --token。';

export function onebotClient({ url = 'http://127.0.0.1:3000', token = '', timeoutMs = 15000 } = {}) {
  const base = String(url).replace(/\/+$/, '');

  async function call(action, params = {}) {
    let res;
    try {
      res = await fetch(`${base}/${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const code = e?.cause?.code ?? e?.code ?? '';
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET') {
        throw new OneBotError(`连不上 OneBot 接口 ${base}/${action} (${code})`, { hint: webuiHint(base), cause: e });
      }
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        throw new OneBotError(`请求 ${action} 超时(${timeoutMs}ms)`, { hint: '用 --timeout 调大超时,或检查 napcat 是否卡死。', cause: e });
      }
      throw new OneBotError(`请求 ${action} 失败: ${e.message}`, { hint: webuiHint(base), cause: e });
    }

    const raw = await res.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      // HTTP 401/403 常常带空 body 或 HTML,先按鉴权失败解释,再退回「端口不对」
      if (res.status === 401 || res.status === 403) {
        throw new OneBotError(`${action} 被拒绝 (HTTP ${res.status})`, { status: 'failed', retcode: res.status, hint: TOKEN_HINT });
      }
      throw new OneBotError(`${action} 返回的不是 JSON (HTTP ${res.status}): ${raw.slice(0, 160)}`, { hint: webuiHint(base) });
    }
    if (body.status !== 'ok' && body.retcode !== 0) {
      const auth = body.retcode === 401 || body.retcode === 403 || res.status === 401 || res.status === 403;
      throw new OneBotError(`${action} 失败: ${body.wording ?? body.message ?? JSON.stringify(body).slice(0, 200)}`, {
        retcode: body.retcode, status: body.status,
        hint: auth ? TOKEN_HINT
          : body.retcode === 100 ? '这个 action 在当前 napcat 版本/登录状态下不可用,先用 --probe 确认接口通不通。' : '',
      });
    }
    return body.data;
  }

  return {
    url: base,
    call,
    loginInfo: () => call('get_login_info'),
    groupList: () => call('get_group_list'),
    groupHistory: (group_id, message_seq = 0, count = 20) =>
      call('get_group_msg_history', { group_id: Number(group_id), message_seq: Number(message_seq), count: Number(count) }),
    groupInfo: (group_id) => call('get_group_info', { group_id: Number(group_id) }),
  };
}

export function historyMessages(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.messages)) return data.messages;
  if (Array.isArray(data?.data?.messages)) return data.data.messages;
  return [];
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 从 message_seq 往回翻页拉群历史。
 * 游标语义按 go-cqhttp/napcat:message_seq=0 取最新,否则取该 seq 及更早的 count 条。
 * 用「本页最小 seq」当下一页游标,在「含端点」和「不含端点」两种实现下都不会漏消息(重复靠 message_id 去重)。
 */
export async function pullHistory(client, gid, {
  sinceSeq = 0, sinceTs = 0, limit = 200, pageSize = 40, delayMs = 400, maxPages = 20, onProgress,
} = {}) {
  const seen = new Set();
  let all = [];
  let cursor = 0;
  let pages = 0;
  let maxSeq = sinceSeq;
  let minSeq = Infinity;
  let skipped = 0;

  while (pages < maxPages) {
    const want = Math.max(1, Math.min(pageSize, limit - all.length));
    const batch = normalizeMessages(historyMessages(await client.groupHistory(gid, cursor, want)));
    pages++;
    if (!batch.length) break;

    const pageMin = batch[0].seq;
    const pageMax = batch[batch.length - 1].seq;
    if (pageMax > maxSeq) maxSeq = pageMax;
    if (pageMin < minSeq) minSeq = pageMin;

    for (const m of batch) {
      const key = m.message_id ?? `${gid}:${m.seq}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (sinceSeq && m.seq <= sinceSeq) { skipped++; continue; }
      if (sinceTs && m.time && m.time < sinceTs) { skipped++; continue; }
      all.push({ ...m, group_id: m.group_id ?? Number(gid) });
    }
    onProgress?.({ pages, cursor, pageMin, pageMax, kept: all.length });

    if (batch.length < want) break;
    if (all.length >= limit) break;
    if (sinceSeq && pageMin <= sinceSeq) break;
    if (sinceTs && batch.some((m) => m.time && m.time < sinceTs)) break;
    if (cursor !== 0 && pageMin >= cursor) break;
    cursor = pageMin;
    if (cursor <= 0) break;
    if (delayMs) await sleep(delayMs);
  }

  all.sort((a, b) => a.seq - b.seq || a.time - b.time);
  return { messages: all, pages, maxSeq, minSeq: Number.isFinite(minSeq) ? minSeq : 0, skipped };
}
