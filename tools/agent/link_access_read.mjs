/** Readability confirmation uses the existing policy-aware reader, without an LLM
 * or review tools. Returned document text is not treated as instructions or saved. */
export const MAX_ACCESS_LINKS = 3;

const TYPES = Object.freeze({
  'feishu/docx': '飞书文档', 'feishu/doc': '飞书旧版文档',
  'feishu/bitable': '飞书多维表格', 'feishu/sheet': '飞书电子表格',
  'feishu/wiki': '飞书知识库节点', 'text/html': '网页', 'text/plain': '文本',
});

// Metadata is displayed as text, not interpreted as a reply-card block.
const display = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ')
  .replaceAll('[[', '［［').replaceAll(']]', '］］').trim();

export async function readLinkAccess(gate, reader) {
  if (gate?.guard === 'link-access-skip') {
    return { ok: false, results: [], reply: '按你的要求，这次没有读取链接，也没有启动审核。' };
  }
  if (gate?.guard === 'link-access-clarify') {
    return { ok: false, results: [], reply: '这条消息的处理范围还不明确。请确认：只检查能否读取（推荐），还是读取后开始审核？' };
  }
  const links = gate?.links ?? [];
  if (!links.length || links.length > MAX_ACCESS_LINKS) {
    return { ok: false, results: [], reply: links.length
      ? `这次有 ${links.length} 个链接，超过一次读取 ${MAX_ACCESS_LINKS} 个的上限；本次还没有读取，请拆分发送。`
      : '没有提取到可读取的链接，请重新发送链接。' };
  }
  const results = [];
  const replies = [];
  for (const url of links) {
    const label = links.length > 1 ? `链接 ${results.length + 1}：` : '';
    try {
      const page = await reader(url);
      if (typeof page?.text !== 'string' || !page.text.trim()) {
        throw new Error('读取接口没有返回有效正文，尚不能确认内容可读');
      }
      const title = display(page.title);
      const type = TYPES[page.contentType] ?? '链接内容';
      const chars = [...page.text].length;
      const hasSelection = /[?&](?:table|view|sheet)=/.test(url);
      const scope = hasSelection
        ? '读取范围是本次接口返回的内容；链接指定表/视图的完整性尚未核验。'
        : '读取范围是本次读取器返回的内容；完整性与上游版本尚未核验。';
      results.push({ url, ok: true, title: title || null, contentType: page.contentType ?? null, chars });
      replies.push(`${label}这次读到了${title ? `《${title}》` : '内容'}（${type}，返回 ${chars} 字）。\n${scope}`);
    } catch (error) {
      const title = display(error?.linkTitle);
      const detail = display(error?.message) || '读取器没有提供失败原因';
      results.push({ url, ok: false, title: title || null, detail });
      replies.push(`${label}这次没有读到${title ? `《${title}》的` : ''}正文。原因：${detail}`);
    }
  }
  return { ok: results.every((r) => r.ok), results, reply: replies.join('\n\n') };
}
