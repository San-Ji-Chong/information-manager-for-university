const stripTags = (s) => s.replace(/<[^>]*>/g, '');
const clean = (s) => stripTags(s).replace(/\*\*/g, '').replace(/^\s*[+*•-]\s*/, '').replace(/\s+/g, ' ').trim();

const LABELS = {
  organizer: ['活动组织者', '组织者'],
  campus: ['活动校区', '校区'],
  start: ['线下活动时间', '活动时间', '时间'],
  end: ['活动结束时间', '结束时间'],
  location: ['活动具体地点教室', '活动地点', '地点', '地址', '教室'],
  capacity: ['限制报名人数', '报名人数', '活动人数', '人数'],
  signupDue: ['报名截止时间', '报名截止'],
  taskDue: ['前置任务截止时间', '前置任务DDL', '前置任务 DDL'],
  special: ['特殊要求', '备注'],
};
const FIELD_LINE = new RegExp(`^(${[...new Set(Object.values(LABELS).flat())]
  .concat(['课程内容', '活动主题', '活动形式', '长期活动', '活动地点', '活动时间'])
  .sort((a, b) => b.length - a.length).join('|')})\\s*[:：]`);
const UNSET = /待定|看小程序|后续通知|另行通知|暂无|TBD/;
const pad = (n) => String(n).padStart(2, '0');

function findField(lines, names) {
  let pending = null;
  for (const name of names) {
    const re = new RegExp(`^${name}\\s*[:：]\\s*(.*)$`);
    for (const l of lines) {
      const m = clean(l).match(re);
      if (!m) continue;
      const v = m[1].trim();
      if (!v) continue;
      if (UNSET.test(v)) { pending ??= v; continue; }
      return { value: v, pending: null };
    }
  }
  return { value: null, pending };
}

function yearOf(month, day, now) {
  const y = now.getFullYear();
  const past = (new Date(y, now.getMonth(), now.getDate()) - new Date(y, month - 1, day)) / 864e5;
  return past > 150 ? y + 1 : y;
}

const valid = (mo, d) => mo >= 1 && mo <= 12 && d >= 1 && d <= 31;

function parseDay(text, now) {
  const t = text.replace(/\s+(?=[月日号])/g, '').replace(/(?<=[月日号])\s+/g, '');
  let m = t.match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})/);
  if (m) return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]) };
  if ((m = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/)) && valid(+m[1], +m[2])) {
    return { y: yearOf(+m[1], +m[2], now), mo: +m[1], d: +m[2] };
  }
  if ((m = t.match(/(?<![\d.])(\d{1,2})\s*[./]\s*(\d{1,2})(?!\d)/)) && valid(+m[1], +m[2])) {
    return { y: yearOf(+m[1], +m[2], now), mo: +m[1], d: +m[2] };
  }
  return null;
}

function parseClock(text, from = 0) {
  const m = text.slice(from).match(/(凌晨|早上|上午|中午|下午|傍晚|晚上)?\s*(\d{1,2})\s*[:：点时]\s*(\d{1,2})?\s*分?/);
  if (!m) return null;
  const at = from + m.index + m[0].length;
  let h = Number(m[2]);
  const min = Number(m[3] ?? 0);
  if (h === 24 && min === 0) return { clock: '23:59', at };
  if (/下午|晚上|傍晚/.test(m[1] ?? '') && h < 12) h += 12;
  if (h > 23 || min > 59) return null;
  return { clock: `${pad(h)}:${pad(min)}`, at };
}

export function parseWhen(value, now = new Date()) {
  if (!value) return null;
  const day = parseDay(value, now);
  const start = parseClock(value);
  const end = start ? parseClock(value, start.at) : null;
  if (!day && !start) return null;
  const date = day ? `${day.y}-${pad(day.mo)}-${pad(day.d)}` : null;
  return {
    date,
    start_at: date && start ? `${date} ${start.clock}` : date,
    end_at: date && end ? `${date} ${end.clock}` : null,
  };
}

const CAMPUS = { 鼓: '鼓楼', 仙: '仙林', 苏: '苏州' };
const bare = (title) => title.replace(/^[鼓仙苏]\s*[：:]\s*/, '');

function ddlTasks(value, title, now) {
  const out = [];
  const re = /([^，。,；;：:\n]{2,26}?)\s*DDL\s*为?\s*([0-9]{1,4}\s*[月./-]\s*[0-9]{1,2}\s*[日号]?\s*(?:[0-9]{1,2}\s*[:：点时]\s*[0-9]{1,2}\s*分?|[0-9]{1,2}\s*[:：]\s*[0-9]{1,2}(?::[0-9]{1,2})?)?)/g;
  let m;
  while ((m = re.exec(value ?? ''))) {
    const w = parseWhen(m[2], now);
    if (w?.start_at) out.push({ title: `${clean(m[1])} DDL`, due_at: w.start_at, priority: 'must' });
  }
  if (out.length) return out;
  const w = parseWhen(value ?? '', now);
  if (w?.start_at) out.push({ title: `${bare(title)} 前置任务 DDL`, due_at: w.start_at, priority: 'must' });
  return out;
}

const isPrepHead = (line) => {
  const c = clean(line);
  if (/^#{1,6}\s/.test(line.trim())) return c.includes('前置任务');
  if (!c.startsWith('前置任务')) return false;
  return !/^[:：]\s*\S{4,}/.test(c.replace(/^前置任务\s*/, ''));
};

function prepTasks(lines, fallbackDue, now) {
  const start = lines.findIndex(isPrepHead);
  if (start < 0) return [];
  const head = clean(lines[start]).replace(/^#*\s*/, '');
  const due = parseWhen(head.replace(/^前置任务\s*/, ''), now)?.start_at
    ?? parseWhen(head.match(/[（(]([^）)]*)[）)]/)?.[1] ?? '', now)?.start_at
    ?? fallbackDue;
  const out = [];
  for (let i = start + 1; i < lines.length && out.length < 8; i++) {
    if (/^#{1,6}\s/.test(lines[i].trim())) break;
    const m = lines[i].match(/^\s{0,3}(?:\d+[.)]|[+*-])\s+(.*)$/);
    if (!m) continue;
    const text = clean(m[1]).replace(/^[A-Za-z]\s*/, '');
    if (!text || text.length < 4 || FIELD_LINE.test(text) || UNSET.test(text)) continue;
    out.push({ title: `前置任务:${text.length > 46 ? text.slice(0, 46) + '…' : text}`, due_at: due, priority: 'must' });
  }
  return out;
}

export function extractActivity(title, body, now = new Date()) {
  const lines = String(body ?? '').split(/\r?\n/);
  const f = {};
  for (const [key, names] of Object.entries(LABELS)) f[key] = findField(lines, names);

  const prefix = title.match(/^([鼓仙苏])\s*[：:]/);
  const campus = f.campus.value?.replace(/校区$/, '') ?? (prefix ? CAMPUS[prefix[1]] : null);
  const when = parseWhen(f.start.value, now);
  const capacityRaw = f.capacity.value ? clean(f.capacity.value) : null;
  const signupDue = parseWhen(f.signupDue.value ?? '', now)?.start_at ?? null;
  const taskDue = parseWhen(f.taskDue.value ?? '', now)?.start_at ?? null;

  const fields = [campus, f.organizer.value, f.location.value, when?.start_at, capacityRaw].filter(Boolean).length;
  const pending = [f.start.pending && `时间${clean(f.start.pending)}`, f.location.pending && `地点${clean(f.location.pending)}`,
    f.special.value && clean(f.special.value)].filter(Boolean).join(' · ');

  return {
    isActivity: Boolean(prefix) || fields >= 2,
    campus,
    organizer: f.organizer.value ? clean(f.organizer.value) : null,
    start_at: when?.start_at ?? null,
    end_at: when?.end_at ?? null,
    due_at: signupDue,
    location: f.location.value ? clean(f.location.value) : null,
    capacity: capacityRaw && /\d/.test(capacityRaw) && capacityRaw.length <= 12
      ? capacityRaw.replace(/(\d+)\s*[人个名]\s*$/, '$1') : null,
    note: pending || null,
    tasks: (() => {
      const out = [];
      if (signupDue) out.push({ title: `报名截止:${bare(title)}`, due_at: signupDue, priority: 'must' });
      out.push(...ddlTasks(f.taskDue.value, title, now));
      out.push(...prepTasks(lines, taskDue ?? when?.start_at ?? null, now));
      const seen = new Set();
      return out.filter((t) => (seen.has(t.title + t.due_at) ? false : seen.add(t.title + t.due_at)));
    })(),
  };
}
