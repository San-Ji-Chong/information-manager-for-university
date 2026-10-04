const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const safeUrl = (u) => (/^(https?:|\/|#|mailto:)/i.test(u) ? u : '#');

const link = (text, url) => `<a href="${safeUrl(url)}" target="_blank" rel="noopener">${text}</a>`;

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (m, t, u) => link(t || u, u));
}

function cells(line) {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => inline(esc(c.trim())));
}

export function mdToHtml(src) {
  const cleaned = String(src ?? '')
    .replace(/<a name="[^"]*">\s*<\/a>/g, '')
    .replace(/<\/?(?:font|span|u|s|mark|strong|em|b|i)\b[^>]*>/gi, '')
    .replace(/<(?:br|\/div|\/p)\s*\/?>\s*/gi, '\n')
    .replace(/<img[^>]*?src="([^"]+)"[^>]*>/g, (m, u) => `[图片](${u})`)
    .replace(/^:::.*$/gm, '');
  const lines = cleaned.split(/\r?\n/);
  const out = [];
  let i = 0;
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      closeList();
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      closeList();
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const sep = rows.length > 1 && /^\s*\|[\s:|-]+\|?\s*$/.test(rows[1]);
      const body = sep ? [rows[0], ...rows.slice(2)] : rows;
      out.push('<table>' + body.map((r, n) => {
        const tag = sep && n === 0 ? 'th' : 'td';
        return `<tr>${cells(r).map((c) => `<${tag}>${c}</${tag}>`).join('')}</tr>`;
      }).join('') + '</table>');
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      closeList();
      out.push(`<h${m[1].length + 2}>${inline(esc(m[2].trim()))}</h${m[1].length + 2}>`);
      i++; continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) { closeList(); out.push('<hr>'); i++; continue; }
    if ((m = line.match(/^\s*>\s?(.*)$/))) {
      closeList();
      const buf = [];
      while (i < lines.length && (m = lines[i].match(/^\s*>\s?(.*)$/))) { buf.push(m[1]); i++; }
      out.push(`<blockquote>${mdToHtml(buf.join('\n'))}</blockquote>`);
      continue;
    }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(esc(m[1]))}</li>`);
      i++; continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(esc(m[1]))}</li>`);
      i++; continue;
    }
    if (!line.trim()) { closeList(); i++; continue; }

    closeList();
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|```|\|)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(esc(buf.join('\n').trim()))}</p>`);
  }
  closeList();
  return out.join('\n');
}
