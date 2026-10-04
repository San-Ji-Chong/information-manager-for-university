function isCjk(ch) {
  if (!ch) return false;
  const c = ch.codePointAt(0);
  return (c >= 0x3400 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef);
}

export function stripCjkSpaces(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ' ') {
      const prev = s[i - 1];
      const next = s[i + 1];
      if (prev && next && (isCjk(prev) || isCjk(next))) continue;
    }
    out += s[i];
  }
  return out;
}

export function fixPunct(s) {
  return s
    .replace(/(\d)℃(\d)/g, '$1.$2')
    .replace(/(\d{4})一(\d{1,2})一(\d{1,2})/g, '$1-$2-$3')
    .replace(/一一/g, '——')
    .replace(/：/g, ':')
    .replace(/，/g, ',')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/。/g, '·')
    .replace(/\s*\/\s*/g, '/')
    .replace(/·+/g, '·')
    .trim();
}

export const normalizeLine = (s) => fixPunct(stripCjkSpaces(s));
