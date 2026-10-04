// 语雀思训知识库 → 本地系统 同步脚本(在浏览器控制台手动运行)
// 用法:
//   1. 浏览器打开思训知识库首页(已登录状态)
//   2. F12 打开控制台,把本文件全部内容粘贴进去,回车
//   3. 按提示选择要同步的分组,确认后即可在 http://localhost:8787 看到
// 说明:脚本只读取你有权查看的文档正文,发送到本机 localhost,不提取任何凭证。
(async () => {
  const book = window.appData && window.appData.book;
  if (!book || !book.toc) {
    console.error('请在思训知识库首页运行(需要 window.appData.book.toc)');
    return;
  }
  const toc = book.toc;
  const groups = toc.filter((n) => n.type === 'TITLE');
  console.log('book_id =', book.id, '| 分组:', groups.map((g) => g.title).join(' / '));

  const want = prompt('要同步哪个分组?(复制上面某个分组名)',
    groups.length ? groups[groups.length - 1].title : '');
  if (!want) return;
  const group = groups.find((g) => g.title === want);
  if (!group) { console.error('没找到该分组:', want); return; }

  const byUuid = new Map(toc.map((n) => [n.uuid, n]));
  const inGroup = (n) => {
    let p = byUuid.get(n.parent_uuid);
    while (p) { if (p.uuid === group.uuid) return true; p = byUuid.get(p.parent_uuid); }
    return false;
  };
  const isPersonName = (t) => {
    const s = t.trim();
    if (s.length < 2 || s.length > 4) return false;
    for (const ch of s) { const c = ch.codePointAt(0); if (c < 0x4e00 || c > 0x9fa5) return false; }
    return true;
  };

  const docs = toc.filter((n) => n.type === 'DOC' && inGroup(n) && !isPersonName(n.title));
  console.log('分组「' + want + '」下活动文档 ' + docs.length + ' 篇:');
  docs.forEach((d) => console.log('  -', d.title));
  if (!confirm('同步这 ' + docs.length + ' 篇到本地系统?')) return;

  const login = (book.user && book.user.login) || '你的语雀团队login';
  const out = [];
  for (const d of docs) {
    const slug = d.url || d.slug;
    const r = await fetch('/api/docs/' + slug + '?book_id=' + book.id + '&merge_dynamic_data=false&mode=markdown');
    if (!r.ok) { console.warn('跳过', d.title, r.status); continue; }
    const j = await r.json();
    out.push({
      slug,
      title: d.title,
      body: j.data.sourcecode || '',
      url: location.origin + '/' + login + '/' + book.slug + '/' + slug,
      updated_at: j.data.updated_at || null,
    });
    console.log('  已取 ' + out.length + '/' + docs.length + ': ' + d.title + ' (' + (j.data.sourcecode || '').length + ' 字)');
    await new Promise((r2) => setTimeout(r2, 300));
  }
  if (!out.length) { console.error('一篇都没取到,把上面的报错发给我'); return; }

  const payload = JSON.stringify({ book_id: book.id, group: want, docs: out });
  try {
    const res = await fetch('http://localhost:8787/api/ingest/yuque', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    console.log('✅ 本地入库结果:', await res.json());
  } catch (e) {
    console.warn('直连 localhost 失败(' + e.message + '),改为下载 JSON 文件');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    a.download = 'yuque-' + book.id + '-' + out.length + '.json';
    a.click();
    console.log('✅ 已下载 ' + a.download + ',把这个文件的路径发给我');
  }
})();
