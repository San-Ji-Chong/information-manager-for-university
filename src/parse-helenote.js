const START = /^(\d{4}-\d{1,2}-\d{1,2})\s+(\d{1,2}:\d{2})\s*·\s*(.+)$/;
const DUE = /^截止\s*(\d{1,2}-\d{1,2}|\d{4}-\d{1,2}-\d{1,2})$/;
const CAP = /^已报名\s*(\d+)\/(\d+)$/;
const ORG = /^([^·\d]{1,12})·([^·]+)$/;
const GROUP = /^\d{1,2}月\d{1,2}日(周.?)?$/;
const TAGS = new Set(['思维训练营', '报名中', '已结束', '已满员', '进行中']);
const CHROME = new Set([
  '首页', '活动', '我的', '消息', '发送', '+活动', '消,0我的',
  '全部校区', '待办活动', '历史活动', '我的创建', '我的报名',
  '活动通知', '活动嗶知',
]);
const CHROME_RE = /NOT|组织者|筛选|拼音|正式/;

function countCjk(t) {
  let n = 0;
  for (const ch of t) {
    const c = ch.codePointAt(0);
    if (c >= 0x4e00 && c <= 0x9fff) n++;
  }
  return n;
}

const isChrome = (raw) => {
  const t = raw.replace(/\s/g, '');
  return CHROME.has(t) || GROUP.test(t) || CHROME_RE.test(t) || countCjk(t) < 2;
};

function buildHeader(buf) {
  const tags = [];
  let organizer = null;
  let campus = null;
  const titleParts = [];
  for (const t of buf) {
    if (TAGS.has(t)) { tags.push(t); continue; }
    if (!organizer) {
      const m = t.match(ORG);
      if (m) { organizer = m[1].trim(); campus = m[2].trim(); continue; }
    }
    if (!isChrome(t)) titleParts.push(t);
  }
  return { title: titleParts.join(''), tags, organizer, campus };
}

export function parseHelenote(lines) {
  const events = [];
  let buf = [];
  let cur = null;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    let m;
    if ((m = t.match(START))) {
      cur = { ...buildHeader(buf), start_at: `${m[1]} ${m[2]}`, location: m[3].trim(), _locCont: true };
      events.push(cur);
      buf = [];
      continue;
    }
    if (cur) {
      if ((m = t.match(DUE))) { cur.due_at = m[1].includes('-') ? m[1] : `${cur.start_at.slice(0, 4)}-${m[1]}`; cur._locCont = false; continue; }
      if ((m = t.match(CAP))) { cur.capacity = `${m[1]}/${m[2]}`; cur._locCont = false; continue; }
      if (cur._locCont && !isChrome(t)) { cur.location = (cur.location + t).trim(); cur._locCont = false; continue; }
      cur._locCont = false;
    }
    buf.push(t);
  }
  return events.filter((e) => e.title).map(({ _locCont, ...e }) => e);
}
