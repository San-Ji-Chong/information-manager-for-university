import { pathToFileURL } from 'node:url';
import { openDb } from './db.js';
import { loadConfig, saveConfig } from './config.js';
import { OneBotError, historyMessages, normalizeMessages, onebotClient, pullHistory } from './onebot.js';
import { analyzeAll } from './analyze.js';
import { patchState, pendingGroups, readState, rollup, setGroupName, storeMsgs } from './qq-store.js';

export const DEFAULTS = {
  url: 'http://127.0.0.1:3000',
  token: '',
  groups: [],
  limit: 200,
  days: 7,
  page_size: 40,
  delay_ms: 400,
  timeout_ms: 15000,
  chunk: 60,
};

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

export function toGroups(v) {
  if (v == null || v === true || v === '') return [];
  const arr = Array.isArray(v) ? v : String(v).split(/[,，\s]+/);
  return [...new Set(arr.map((s) => String(s).trim().replace(/^[[\]'"“”]|[[\]'"“”]$/g, '')).filter((s) => /^\d+$/.test(s)))];
}

const USAGE = `QQ 群消息 → 收件箱

  node src/qq-sync.js [选项]

  --url <地址>      OneBot HTTP 接口,默认 http://127.0.0.1:3000(napcat 的「HTTP服务器」)
  --token <token>   该接口配置的 Token(留空表示没设)
  --groups <群号>   要盯的群,逗号分隔。决定拉哪些群的历史、归纳哪些群的消息
  --limit <n>       单次每群最多取多少条新消息,默认 200
  --days <n>        首次运行(无水位线)只回溯 n 天,默认 7;0 = 不限
  --reset           忽略水位线,当作首次运行重新回溯
  --no-pull         不连 OneBot 接口,只归纳已经实时捕获到的消息
                    (napcat 只配了「反向 HTTP POST」没配「HTTP服务器」时用这个)
  --probe [群号]    只测连通性:打印登录信息、群列表;给了群号就再抓 5 条最新消息看看
  --dry-run         跑完整流程但不写库
  --page_size <n>   每页条数,默认 40   --delay_ms <n> 翻页间隔,默认 400
  --timeout <ms>    单个请求超时,默认 15000

环境变量 ONEBOT_URL / ONEBOT_TOKEN / QQ_GROUPS 优先级低于命令行、高于 config.json。

两步:①拉历史存进消息缓冲表 qq_msgs ②把缓冲表里还没归纳的消息按群打包分析,
写进收件箱 raw_items(status=new),等你在网页上确认。实时捕获(server 的 /api/onebot)
走的是同一张缓冲表,所以两条路不会重复计数。`;

function printBatch(label, count, engine, tasks, llmError, tail = '') {
  console.log(`  ${label}:${count} 条 → 候选 ${tasks.length} 条(引擎 ${engine}${llmError ? ',LLM 失败已降级' : ''})${tail}`);
  for (const t of tasks.slice(0, 10)) {
    const tag = t.priority === 'optional' ? '选做' : t.priority === 'must' ? '必做' : '待定';
    console.log(`    [${tag}] ${t.title}${t.due_at ? `  ← ${t.due_at}` : ''}`);
  }
  if (tasks.length > 10) console.log(`    …另有 ${tasks.length - 10} 条`);
}

function showPending(db, stream = console.error) {
  const p = pendingGroups(db);
  if (!p.length) return;
  stream(`\n实时捕获到、还没归纳的消息(可以拿来当选群参考):`);
  for (const g of p) stream(`  ${g.group_id}  ${g.group_name || '(群名未知)'}  ${g.n} 条`);
}

async function probe(client, gid) {
  const me = await client.loginInfo();
  console.log(`已登录:${me?.nickname ?? '?'}(${me?.user_id ?? '?'})`);
  const list = await client.groupList();
  console.log(`\n共 ${list.length} 个群:`);
  for (const g of list) console.log(`  ${g.group_id}  ${g.group_name ?? ''}`);
  if (!gid) return 0;
  let msgs;
  try {
    msgs = normalizeMessages(historyMessages(await client.groupHistory(gid, 0, 5)));
  } catch (e) {
    console.log(`\n群 ${gid} 拉取失败:${e.message}`);
    if (e.hint) console.log(e.hint);
    return 2;
  }
  console.log(`\n群 ${gid} 最新 ${msgs.length} 条:`);
  for (const m of msgs) console.log(`  [seq ${m.seq}] ${m.sender}: ${m.text.slice(0, 100) || '(无文本)'}`);
  if (!msgs.length) console.log('  (这个群拉不到历史,可能是没加群 / napcat 没缓存 / 接口不支持)');
  return 0;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h) { console.log(USAGE); return 0; }

  const file = loadConfig().qq ?? {};
  const pick = (k, envKey) => flags[k] ?? (envKey ? process.env[envKey] : undefined) ?? file[k] ?? DEFAULTS[k];
  const cfg = {
    url: String(pick('url', 'ONEBOT_URL')).replace(/\/+$/, ''),
    token: String(pick('token', 'ONEBOT_TOKEN') ?? ''),
    groups: toGroups(pick('groups', 'QQ_GROUPS')),
    limit: Number(pick('limit')),
    days: Number(pick('days')),
    pageSize: Number(pick('page_size')),
    delayMs: Number(pick('delay_ms')),
    timeoutMs: Number(flags.timeout ?? pick('timeout_ms')),
    chunk: Number(pick('chunk')),
  };
  const dry = Boolean(flags['dry-run']);
  const client = onebotClient({ url: cfg.url, token: cfg.token, timeoutMs: cfg.timeoutMs });

  if (flags.probe) return probe(client, flags.probe === true ? null : String(flags.probe));

  const db = openDb();
  const config = loadConfig();
  const state = readState(db);
  if (flags.reset) state.seq = {};

  const touched = ['url', 'token', 'groups', 'limit', 'days', 'page_size', 'delay_ms'].some((k) => k in flags);
  if (touched && !dry) {
    saveConfig({ ...loadConfig(), qq: { ...file, url: cfg.url, token: cfg.token, groups: cfg.groups, limit: cfg.limit, days: cfg.days, page_size: cfg.pageSize, delay_ms: cfg.delayMs } });
    console.log(`配置已写入 data/config.json(盯的群:${cfg.groups.join(', ') || '无'})`);
  }

  let rc = 0;
  let totalPulled = 0;
  let totalTasks = 0;

  if (!cfg.groups.length) {
    console.error('还没指定要盯哪个群。');
    try {
      const list = await client.groupList();
      console.error(`\n当前 QQ 号下有 ${list.length} 个群:`);
      for (const g of list) console.error(`  ${g.group_id}  ${g.group_name ?? ''}`);
    } catch (e) {
      console.error(`\n拿不到群列表:${e.message}`);
      if (e.hint) console.error(e.hint.split('\n').map((l) => `  ${l}`).join('\n'));
    }
    showPending(db);
    console.error(`\n选好后运行:node src/qq-sync.js --groups 群号1,群号2`);
    return 3;
  }

  // ── 第一步:补历史。需要 napcat 的「HTTP服务器」;只有反向 POST 时用 --no-pull 跳过 ──
  if (flags['no-pull']) {
    console.log('(--no-pull:跳过拉历史,只归纳已捕获的消息)');
  } else {
    let names = new Map();
    try {
      for (const g of await client.groupList()) names.set(String(g.group_id), g.group_name ?? '');
    } catch (e) {
      console.warn(`(拿不到群列表,群名留空:${e.message})`);
    }
    const nowSec = Math.floor(Date.now() / 1000);
    for (const gid of cfg.groups) {
      const name = names.get(gid) ?? '';
      const label = `${name || '群'} ${gid}`;
      const sinceSeq = Number(state.seq?.[gid] ?? 0);
      const firstRun = !sinceSeq;
      const sinceTs = firstRun && cfg.days > 0 ? nowSec - cfg.days * 86400 : 0;

      let r;
      try {
        r = await pullHistory(client, gid, { sinceSeq, sinceTs, limit: cfg.limit, pageSize: cfg.pageSize, delayMs: cfg.delayMs });
      } catch (e) {
        rc = e instanceof OneBotError ? 2 : 1;
        console.error(`✗ ${label}:${e.message}`);
        if (e.hint) console.error(`  ${e.hint.split('\n').join('\n  ')}`);
        continue;
      }

      const from = r.messages[0];
      const to = r.messages[r.messages.length - 1];
      console.log(`${firstRun ? '首次' : '增量'} ${label}:翻 ${r.pages} 页,取到 ${r.messages.length} 条新消息`
        + (sinceTs ? `(回溯 ${cfg.days} 天内)` : sinceSeq ? `(seq > ${sinceSeq})` : '')
        + (r.skipped ? `,跳过 ${r.skipped} 条旧的` : ''));
      if (from && to) console.log(`  区间 seq ${from.seq}→${to.seq}  时间 ${new Date(from.time * 1000).toLocaleString('zh-CN')} → ${new Date(to.time * 1000).toLocaleString('zh-CN')}`);
      if (r.maxSeq > sinceSeq) state.seq[gid] = r.maxSeq;
      if (!r.messages.length) { console.log('  没有新消息。'); continue; }

      if (dry) {
        const { engine, tasks, llmError } = await analyzeAll(r.messages, { config, chunk: cfg.chunk });
        printBatch(label, r.messages.length, engine, tasks, llmError, '  [--dry-run 未写库]');
        totalTasks += tasks.length;
        continue;
      }
      const added = storeMsgs(db, r.messages, name);
      if (name) setGroupName(db, gid, name);
      totalPulled += added;
      console.log(`  → 消息缓冲表新增 ${added} 条`);
    }
  }

  // ── 第二步:把缓冲表里还没打包的消息按群归纳进收件箱。拉历史失败也要跑,实时捕获的还等着入库 ──
  const pending = pendingGroups(db);
  const watched = cfg.groups.map(Number);
  const scope = pending.filter((g) => watched.includes(Number(g.group_id)));
  if (!scope.length) {
    const others = pending.filter((g) => !watched.includes(Number(g.group_id)));
    console.log(others.length
      ? `\n待归纳的消息都在没盯的群里:${others.map((g) => `${g.group_name || '群'}${g.group_id}(${g.n} 条)`).join('、')}。要的话用 --groups 加进来。`
      : '\n没有待归纳的新消息。');
  } else {
    console.log(`\n归纳 ${scope.length} 个群、共 ${scope.reduce((s, g) => s + g.n, 0)} 条消息…`);
    const results = await rollup(db, { config, groups: scope.map((g) => g.group_id), chunk: cfg.chunk, origin: 'sync', dry });
    for (const r of results) {
      printBatch(`${r.group_name || '群'} ${r.group_id}`, r.count, r.engine, r.tasks, r.llmError,
        dry ? '  [--dry-run 未写库]' : `  → 收件箱批次 #${r.batch_id}`);
      totalTasks += r.tasks.length;
    }
  }

  if (!dry) patchState(db, { seq: state.seq });
  if (rc === 0) console.log(`\n完成:新增 ${totalPulled} 条消息,${totalTasks} 条候选待确认。`);
  return rc;
}

function fail(e) {
  console.error(e.message);
  if (e.hint) console.error(`\n${e.hint}`);
  return e instanceof OneBotError ? 2 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code ?? 0; }, (e) => { process.exitCode = fail(e); });
}
