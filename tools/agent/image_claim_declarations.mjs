/** Structural C declarations and strict references. Pure: no model, I/O or verdict. */
const candidate = /\bC\d+(?:[A-Za-z0-9_′″]+|[.．]\d+)*/gi;
const legal = /^C\d+$/i;
const plain = value => String(value ?? '').replace(/[*_`]/g, '').trim();

/** References are not declarations. Invalid suffixes never alias a shorter ID. */
export function extractClaimIds(text) {
  return [...new Set([...String(text ?? '').matchAll(candidate)]
    .map(match => match[0]).filter(id => legal.test(id)).map(id => id.toUpperCase()))];
}

export function rawTableCells(line) {
  return String(line).trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/);
}

/** Read a leading table/line key, rejecting C6′ and C1a instead of shortening. */
export function readClaimIdentifier(value, { exact = false } = {}) {
  const text = String(value ?? '').trim();
  const match = /^(?:\*\*|__|`)?(C\d+(?:[A-Za-z0-9_′″]+|[.．]\d+)*)(?:\*\*|__|`)?([\s\S]*)$/i.exec(text);
  if (!match) return { id: null, rest: '', error: '缺少合法 C 主张编号' };
  const token = match[1]; const rest = match[2];
  if (!legal.test(token) || (rest && !/^[\s:：（(]/.test(rest)) || (exact && rest.trim())) {
    return { id: null, rest, error: `非法 C 主张编号：${token}${exact ? rest : ''}` };
  }
  return { id: token.toUpperCase(), rest: rest.replace(/^[\s:：]+/, ''), error: null };
}

const isSeparator = line => /^\s*\|/.test(line)
  && rawTableCells(line).every(cell => /^\s*:?-+:?\s*$/.test(cell));
const declarationLine = line => {
  const stripped = String(line).replace(/^\s*(?:#{1,6}\s+)?(?:(?:[-*+])\s+|\d+[.)、]\s+)?/, '');
  if (!/^(?:\*\*|__|`)?C\d+/i.test(stripped)) return null;
  // An ordinary mapping/range at line start is still a reference, not a key.
  if (/^(?:\*\*|__|`)?C\d+(?:\*\*|__|`)?(?:[↔→–—/、，,]|\s*[-–]\s*C\d)/i.test(stripped)) return null;
  const parsed = readClaimIdentifier(stripped);
  return { ...parsed, stripped };
};

/** `text` is the declaration body; `raw` preserves its complete source block.
 * Table mapping/source columns stay in raw, never become additional keys.
 * No declarations is ok=false with empty errors, for legacy-format callers. */
export function parseClaimDeclarations(body = '') {
  const text = String(body);
  const lines = text.split(/\r?\n/);
  const offsets = []; let cursor = 0;
  for (const line of lines) {
    offsets.push(cursor); cursor += line.length;
    if (text.slice(cursor, cursor + 2) === '\r\n') cursor += 2;
    else if (text[cursor] === '\n') cursor++;
  }
  const entries = []; const errors = []; let table = null; let hasDeclarationTable = false;
  const append = entry => {
    if (!entry.text.trim()) errors.push(`${entry.id} 主张正文为空`);
    if (entries.some(previous => previous.id === entry.id)) errors.push(`第三节声明主键 ${entry.id} 重复`);
    entries.push(entry);
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*\|/.test(line)) {
      const cells = rawTableCells(line); const labels = cells.map(plain);
      if (isSeparator(line)) { if (table) table.separator = line; continue; }
      const key = labels.findIndex(label => /^(?:编号|主张编号|ID)$/i.test(label));
      const content = labels.findIndex(label => /^(?:主张|声明|主张内容|声明内容)(?:[（(].*[）)])?$/.test(label));
      if ((key >= 0 || content >= 0) && isSeparator(lines[index + 1] ?? '')) {
        hasDeclarationTable = true;
        table = { key: key >= 0 ? key : content, content: content >= 0 ? content : -1,
          exact: key >= 0, header: line, separator: '', width: cells.length };
        continue;
      }
      if (!table) {
        if (labels.some(cell => /^C\d+/i.test(cell))) errors.push(`第 ${index + 1} 行声明表缺少可定位的主键/主张表头`);
        continue;
      }
      const parsed = readClaimIdentifier(cells[table.key], { exact: table.exact });
      if (parsed.error) { errors.push(`第 ${index + 1} 行：${parsed.error}`); continue; }
      if (cells.length !== table.width) errors.push(`${parsed.id} 声明表单元格数量不完整`);
      // ★ 2026-11-03（Owner 批准 B）：缺格不再崩。
      //   病根：表头有「主张」列、某一行少写了几格 ⇒ `cells[table.content]` 是 undefined
      //   ⇒ `.trim()` 抛 TypeError（线上表现：整条图片链跑 146 秒后
      //   「审查链执行失败：Cannot read properties of undefined (reading 'trim')」，
      //   报告与旁挂全丢，最后兜成「审查未完成」）。
      //   现在：取不到那一格就退回 `parsed.rest`（主键之后那段），并记一条 errors ——
      //   仍然 `ok=false`（缺格本来就是不合格），但**是判定不是崩溃**。
      const cell = table.content >= 0 && table.content !== table.key ? cells[table.content] : undefined;
      if (table.content >= 0 && table.content !== table.key && cell === undefined) {
        errors.push(`${parsed.id} 声明表缺「主张」列（该行只有 ${cells.length} 格，表头 ${table.width} 格）`);
      }
      const declaration = cell !== undefined ? String(cell).trim() : parsed.rest.trim();
      append({ id: parsed.id, text: declaration, raw: line, line: index + 1,
        start: offsets[index], end: offsets[index] + line.length, format: 'table',
        tableHeaderRaw: table.header, tableSeparatorRaw: table.separator });
      continue;
    }
    table = null;
    // After a declaration table, plain paragraphs such as “C8 是缺失核查”
    // explain its existing keys. A new non-table declaration needs an explicit
    // list/heading marker or a colon, so prose cannot manufacture another key.
    if (hasDeclarationTable && !/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)、]\s+)/.test(line)
      && !/^\s*(?:\*\*|__|`)?C\d+[A-Za-z0-9_′″]*(?:\*\*|__|`)?\s*[:：]/i.test(line)) continue;
    const parsed = declarationLine(line);
    if (!parsed) continue;
    if (parsed.error) { errors.push(`第 ${index + 1} 行：${parsed.error}`); continue; }
    let last = index;
    while (last + 1 < lines.length && lines[last + 1].trim()
      && !/^\s*(?:\||#{1,6}\s)/.test(lines[last + 1]) && !declarationLine(lines[last + 1])) last++;
    const end = offsets[last] + lines[last].length;
    append({ id: parsed.id, text: [parsed.rest, ...lines.slice(index + 1, last + 1)].join('\n').trim(),
      raw: text.slice(offsets[index], end), line: index + 1, start: offsets[index], end, format: 'line' });
    index = last;
  }
  const ids = [...new Set(entries.map(entry => entry.id))];
  return { ok: entries.length > 0 && errors.length === 0, entries, ids, errors };
}
