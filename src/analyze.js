import { extractTasks } from './extract-tasks.js';

const pad = (n) => String(n).padStart(2, '0');
const stamp = (t) => {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const dayStamp = (t) => stamp(t).slice(0, 10);

export function transcript(messages) {
  return messages
    .filter((m) => m.text)
    .map((m) => `${m.sender} ${stamp(m.time)}\n${m.text}`)
    .join('\n\n');
}

export function llmConfig(config = {}) {
  const saved = config.llm ?? {};
  const cfg = {
    base_url: process.env.LLM_BASE_URL || saved.base_url || '',
    model: process.env.LLM_MODEL || saved.model || '',
    api_key: process.env.LLM_API_KEY || saved.api_key || '',
    timeout_ms: Number(process.env.LLM_TIMEOUT_MS || saved.timeout_ms || 90000),
  };
  if (saved.enabled === false) return null;
  return cfg.api_key && cfg.base_url && cfg.model ? cfg : null;
}

const SYSTEM = `你是大学群聊的任务提取器。用户给你一个 QQ 群的历史消息记录,请只挑出**对用户本人有约束力或值得记的事**。

判定规则:
- must(必做):明确要求所有人/每人完成,或带截止时间的提交、报名、签到、填表、开会、集合、考试、交作业。
- optional(选做):写明选做、自愿、欢迎参加、建议、感兴趣的同学。
- 不要输出:闲聊、接龙回复("收到""+1")、别人的私人事务、纯转发无要求的内容、红包、系统消息、"欢迎 XX 加入本群"、宿管/节日问候。
- 语雀机器人的"某某 更新了《文档名》(知识库:…)"推送:只有当变更内容里出现明确的 DDL、报名截止或活动时间地点时才提取,而且标题要写成用户该做的事(如"9月18日前提交 Astra 前置任务"),不要写成"某某更新了文档"。
- 同一条通知在群里被重复转发或用不同措辞说过多次时,只输出一条。

时间处理(重要):
- 每条消息前面带它自己的发送时间。**相对日期一律以那条消息的发送时间为基准**换算,例如某条 2026-09-28 的消息说"明天交",due_at 就是 2026-09-29。
- due_at 格式为 "YYYY-MM-DD" 或 "YYYY-MM-DD HH:MM",必须是绝对日期,禁止输出"明天""下周三"。
- 消息里确实没有任何时间线索时,due_at 用 null。

输出:严格 JSON,不要任何解释文字或 markdown 代码块。结构为
{"tasks":[{"title":"不超过40字的祈使句","due_at":"YYYY-MM-DD HH:MM 或 null","priority":"must 或 optional","quote":"原文中最关键的一句,不超过60字"}]}
如果整段记录里没有值得记的事,输出 {"tasks":[]}`;

/** 连着给十几个群打请求很容易撞限流,429/5xx/超时退避重试;4xx 是配置错,重试没意义。 */
async function chatCompletions(cfg, body, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    if (i) await new Promise((r) => setTimeout(r, 1500 * 2 ** (i - 1)));
    try {
      const res = await fetch(`${String(cfg.base_url).replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeout_ms),
      });
      const raw = await res.text();
      if (res.status === 429 || res.status >= 500) { last = new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`);
      return JSON.parse(raw);
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError' || e.name === 'TypeError') { last = e; continue; }
      throw e;
    }
  }
  throw last;
}

/** LLM 只回 quote,说话人和时间得按 quote 反查原始消息补上,否则待办详情里看不到出处。 */
const normQuote = (s) => String(s ?? '').replace(/[\s，。、；：""''「」『』（）()\[\]【】!！?？~·…—\-]/g, '');
const bigrams = (s) => { const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; };

export function attachSource(tasks, messages) {
  const pool = messages.filter((m) => m.text).map((m) => {
    const n = normQuote(m.text);
    return { m, n, g: bigrams(n) };
  });
  for (const t of tasks) {
    if (t.sender || !pool.length) continue;
    const q = normQuote(t.quote) || normQuote(t.title);
    if (!q) continue;
    let hit = q.length >= 6 ? pool.find((c) => c.n.includes(q)) : null;
    if (!hit) {
      const qg = bigrams(q);
      let best = 0;
      if (qg.size) {
        for (const c of pool) {
          let same = 0;
          for (const b of qg) if (c.g.has(b)) same++;
          const score = same / qg.size;
          if (score > best) { best = score; hit = c; }
        }
      }
      if (best < 0.5) hit = null;
    }
    if (!hit) continue;
    t.sender = hit.m.sender;
    t.at = stamp(hit.m.time);
    t.day = dayStamp(hit.m.time);
    if (!t.quote) t.quote = hit.m.text.slice(0, 160);
  }
  return tasks;
}

/**
 * 模型常把群消息里的英文引号原样塞进 JSON 字符串,导致整批退回规则引擎。
 * 扫一遍:字符串里遇到的 " 只有后面紧跟 , : } ] 时才算收尾,否则转义成内容。
 */
function repairJson(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!inStr) {
      if (c === '"') inStr = true;
      out += c;
      continue;
    }
    if (c === '\\') { out += c + (text[i + 1] ?? ''); i++; continue; }
    if (c === '"') {
      if (/^\s*[,:}\]]|^\s*$/.test(text.slice(i + 1))) { inStr = false; out += c; } else { out += '\\"'; }
      continue;
    }
    out += c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : c;
  }
  return out;
}

function parseModelJson(text) {
  const body = String(text ?? '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim();
  try {
    return JSON.parse(body);
  } catch (e) {
    try {
      return JSON.parse(repairJson(body));
    } catch {
      throw new Error(`模型返回的不是合法 JSON(${e.message}),开头是「${body.slice(0, 100)}」`);
    }
  }
}

async function llmExtract(messages, cfg) {
  const body = {
    model: cfg.model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `现在时间 ${stamp(Math.floor(Date.now() / 1000))}\n\n${transcript(messages)}` },
    ],
  };
  const json = await chatCompletions(cfg, body);
  const text = json?.choices?.[0]?.message?.content;
  if (!text) throw new Error('模型没有返回内容');
  const parsed = parseModelJson(text);
  const list = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
  const out = [];
  for (const t of list) {
    const title = String(t?.title ?? '').trim();
    if (!title) continue;
    const due = String(t?.due_at ?? '').trim();
    out.push({
      title: title.slice(0, 120),
      due_at: /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?$/.test(due) ? due.replace('T', ' ') : null,
      priority: t?.priority === 'optional' ? 'optional' : t?.priority === 'must' ? 'must' : 'unknown',
      quote: String(t?.quote ?? '').slice(0, 200),
    });
  }
  return attachSource(out, messages);
}

export function rulesExtract(messages) {
  const seen = new Set();
  const out = [];
  for (const m of messages) {
    if (!m.text) continue;
    // 每条消息单独送进规则引擎,并把 now 设成该消息自己的时间,
    // 这样"明天/下周三"按发消息当天换算,而不是按运行脚本的今天。
    for (const t of extractTasks(m.text, new Date(m.time * 1000))) {
      const key = `${t.title}|${t.due_at ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...t, quote: m.text.slice(0, 160), at: stamp(m.time), day: dayStamp(m.time), sender: m.sender });
    }
  }
  return out;
}

export async function analyzeMessages(messages, { config = {}, onWarn = console.warn } = {}) {
  const cfg = llmConfig(config);
  if (!cfg) return { engine: 'rules', tasks: rulesExtract(messages) };
  try {
    const tasks = await llmExtract(messages, cfg);
    return { engine: 'llm', tasks };
  } catch (e) {
    onWarn(`LLM 归纳失败,已退回规则引擎: ${e.message}`);
    return { engine: 'rules', tasks: rulesExtract(messages), llm_error: e.message };
  }
}

/** 分块跑,避免一次性把几百条消息塞进一个 prompt;跨块再按 title+due_at 去一次重。 */
export async function analyzeAll(messages, { config = {}, chunk = 60, onWarn } = {}) {
  const out = [];
  const seen = new Set();
  let engine = 'rules';
  let llmError = '';
  for (let i = 0; i < messages.length; i += chunk) {
    const r = await analyzeMessages(messages.slice(i, i + chunk), { config, onWarn });
    if (r.engine === 'llm') engine = 'llm';
    if (r.llm_error) llmError = r.llm_error;
    for (const t of r.tasks) {
      const k = `${t.title}|${t.due_at ?? ''}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
  }
  return { engine, tasks: out, llmError };
}
