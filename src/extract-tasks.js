const NOISE = new Set(['收到', '好的', '好', '嗯', '嗯嗯', '谢谢', '感谢', '了解', '明白', '可以', '行',
  'ok', 'OK', 'Ok', '+1', '1', '哈哈', '哈哈哈', '没问题', '知道了', '在', '在的', '辛苦了']);

const MUST = /截止|deadline|DDL|ddl|必须|务必|一定要|必做|必到|不交|不发|不填|否则|缺勤|扣分|不计入|全员|所有人|@全体成员|每人|每个人|按时|不要晚于|最晚|记得|别忘|禁止|不得|严禁|统一|点前|之前(?:交|提交|完成|发|填|报|上传)/;
const CUE = /请|麻烦|需要|注意|及时|尽快|安排|通知|要求|各位|大家|同学/;
const ACT = /提交|上交|交|填写|填报|报名|签到|完成|参加|出席|注意|带|准备|上传|发布|通知|安排|开会|集合|上课|讲座|考试|考核|作业|问卷|投票|打卡|值日|打扫|备注|私信|答辩|面试|培训|答疑|参观|检查|填|写|读|测试|材料|表|任务|截止|之前|领|拍|改|发/;
const OPT = /选做|可选|选填|自愿|有兴趣|感兴趣|欢迎|建议|不妨|如有余力|有余力|非强制|自由参加|愿意的|需要的同学|想来的/;
const DROP = /撤回了一条消息|加入了群聊|加入本群|通过扫描二维码|以下是新消息|红包|领取成功/;
/** 别人在提问/闲聊,不是我的待办——真实群消息里这类占了一大半。 */
const QUESTION = /[?？]\s*$|(?:吗|呢)\s*[?？]?\s*$|^(?:请问|问下|问一下|请教|有人|有没有|谁知道|什么时候|哪里|哪个|怎么|怎样|咋|为什么|多少|是不是|能不能|可不可以)/;
const SELF = /^(?:我|俺|咱|本人)/;
const GREET = /^(?:亲爱的)?(?:同学们?|各位同学|各位|大家|朋友们|老师们)?[，,、:：!\s]*(?:早上|上午|中午|下午|晚上|今天)?\s*(?:好|快乐|愉快|辛苦)/;
/** 语雀机器人推送的文档更新日志:只在真的提到 DDL/时间地点时才算事。 */
const BOT_PUSH = /更新了《[^》]*》(?:（知识库：)?|主要变更如下/;
const PUSH_WORTH = /DDL|ddl|截止|前置任务|活动时间|报名(?:时间|截止)|地点[:：为]/;

const TIME_ONLY = /^\s*(?:\d{1,2}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?\s+|\d{1,2}[-/]\d{1,2}\s+)?\d{1,2}[:：]\d{2}(?::\d{2})?\s*$/;
const NAME_TIME = /^\s*([^\d。！？，,;；:：]{1,20})\s+(\d{1,2}[-/]\d{1,2}\s+)?\d{1,2}[:：]\d{2}(?::\d{2})?\s*$/;
const NOT_SENDER = /今天|明天|后天|大后天|本周|下周|上周|周[一二三四五六日天]|星期|开会|集合|截止|之前|之后|时间|日期|记得|提交|上交|报名|签到|请|要|是|在|别|务必|必须|点|分/;
const WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
const pad = (n) => String(n).padStart(2, '0');
const fmtDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function parseTime(text) {
  const m = text.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上|今晚)?\s*(\d{1,2})\s*[:：点时]\s*(\d{1,2})?\s*(分|半)?/);
  if (!m) return null;
  let h = Number(m[2]);
  let min = m[4] === '半' ? 30 : Number(m[3] ?? 0);
  const ap = m[1];
  if (ap && /下午|晚上|傍晚|今晚/.test(ap) && h < 12) h += 12;
  if (ap === '中午' && h < 11) h += 12;
  if (!ap && /晚|夜/.test(text) && h < 12) h += 12;
  if (h > 23 || min > 59) return null;
  return `${pad(h)}:${pad(min)}`;
}

function parseDate(text, now) {
  let m;
  if ((m = text.match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/))) {
    return `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
  }
  if ((m = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/))) {
    const d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]));
    if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate() - 60)) d.setFullYear(now.getFullYear() + 1);
    return fmtDay(d);
  }
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (/大后天/.test(text)) return fmtDay(new Date(base.getTime() + 3 * 864e5));
  if (/后天/.test(text)) return fmtDay(new Date(base.getTime() + 2 * 864e5));
  if (/明天|明晚|明日/.test(text)) return fmtDay(new Date(base.getTime() + 864e5));
  if (/今天|今晚|今日|今天晚上/.test(text)) return fmtDay(base);
  if ((m = text.match(/下\s*(?:个)?\s*周\s*([一二三四五六日天])/)) || (m = text.match(/下\s*([一二三四五六日天])/))) {
    const monOf = (jsDay) => ((jsDay + 6) % 7) + 1;
    const nextMon = ((8 - monOf(base.getDay())) % 7) || 7;
    return fmtDay(new Date(base.getTime() + (nextMon + monOf(WEEKDAY[m[1]]) - 1) * 864e5));
  }
  if ((m = text.match(/(?:周|星期|礼拜)\s*([一二三四五六日天])/))) {
    const wd = WEEKDAY[m[1]];
    return fmtDay(new Date(base.getTime() + ((wd - base.getDay() + 7) % 7) * 864e5));
  }
  return null;
}

function dueOf(text, now) {
  const date = parseDate(text, now);
  const time = parseTime(text);
  if (!date && !time) return null;
  return `${date ?? fmtDay(now)}${time ? ` ${time}` : ''}`;
}

function splitMessages(text) {
  const lines = text.split(/\r?\n/);
  const msgs = [];
  let cur = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const named = line.match(NAME_TIME);
    if (TIME_ONLY.test(line) || (named && !NOT_SENDER.test(named[1]))) {
      cur = { body: [] };
      msgs.push(cur);
      continue;
    }
    if (!cur) { cur = { body: [] }; msgs.push(cur); }
    cur.body.push(line.trim());
  }
  return msgs.map((m) => m.body.join(' ').trim()).filter(Boolean);
}

function titleOf(body) {
  const t = body.replace(/^@[^\s，,。]+\s*/g, '').replace(/\s+/g, ' ').trim();
  const cut = t.match(/^(.{6,90}?[。！!？?；;])/);
  const head = cut ? cut[1].replace(/[。！!？?；;]$/, '') : t;
  return head.length > 90 ? head.slice(0, 90) + '…' : head;
}

/** 机器人推送里真正带 DDL 的那一行,拿来当标题和算日期,免得被推送头部带跑。 */
function pushHit(body) {
  return body.split(/(?:\r?\n|[；;]|(?=\d+\s*[.、)）]\s))/)
    .map((s) => s.trim()).find((s) => PUSH_WORTH.test(s)) ?? '';
}

function titleOfPush(body, scope) {
  const doc = /更新了《([^》]*)》/.exec(body)?.[1];
  const head = titleOf(scope);
  return doc ? `《${doc}》${head}` : head;
}

export function extractTasks(text, now = new Date()) {
  const out = [];
  for (const body of splitMessages(text)) {
    if (DROP.test(body)) continue;
    if (NOISE.has(body.replace(/\s+/g, ''))) continue;
    if (QUESTION.test(body)) continue;
    if (GREET.test(body) && body.length <= 40) continue;
    const push = BOT_PUSH.test(body);
    if (push && !PUSH_WORTH.test(body)) continue;
    const scope = push ? (pushHit(body) || body) : body;
    const must = MUST.test(scope);
    if (SELF.test(scope) && !must) continue;
    const cue = CUE.test(scope);
    const act = ACT.test(scope);
    const opt = OPT.test(scope);
    const due = dueOf(scope, now);
    if (!must && !opt && !(cue && act) && !(due && (act || cue))) continue;
    const title = push ? titleOfPush(body, scope) : titleOf(scope);
    if (!title) continue;
    out.push({ title, due_at: due, priority: must ? 'must' : opt ? 'optional' : 'unknown' });
  }
  return out;
}
