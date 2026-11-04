/**
 * Narrow, pure exception to the default link-review route. A URL is required;
 * bare links and "你读一下" keep their existing submission behavior.
 * Only the user's instruction is classified, never fetched document content.
 */
const URL_RE = /https?:\/\/[^\s<>"'）)】\]，。！？；、]+/g;
const QUOTE_RE = /“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"]*"|'[^']*'|`[^`]*`/g;
// Long pasted material is not an access instruction merely because it ends in
// "能读吗". If a reading request also carries material, clarify its scope.
const MAX_ACCESS_INSTRUCTION_CHARS = 80;
const READ_ACTION_RE = /读取|读到|读出|读懂|(?:能|可以?|只|先)读|访问|打开|权限/;
const CAPABILITY_RE = /能不能|可不可以|是否|可否|能否|有没有|[吗么?？]|你有.*权限|用我的|使用我的|不许说没权限/;
const ONLY_READ_RE = /(?:只|仅)(?:需要|要)?(?:确认|检查|测试)?(?:一下)?(?:能否|是否|能不能)?(?:读|访问|打开)/;
const NO_REVIEW_RE = /(?:不要|不用|无需|不必|别|不需要)(?:启动|进行|执行|做)?(?:审|评审)|(?:审核|审查|评审)(?:先)?(?:不要|不用|不做)/;
const NO_READ_RE = /(?:不要|不需要|不用|无需|别)(?:再)?(?:读取|读|访问|打开)|^不(?:再)?(?:读取|读|访问|打开)/;
const LATER_REVIEW_RE = /(?:稍后|以后|下次|等我[^，,。；;!?！？]*?(?:确认|通知))[^，,。；;!?！？]*?(?:审|评审)/;
const REVIEW_REQUEST_RE = /(?:帮我|请|麻烦|顺便|读(?:到|完|取)后|接着|然后|执行|进行|启动)[^。！？]{0,30}(?:审核|审查|评审|送审|审一下|审下|审这|审那)|^(?:再|现在|马上|立即)?(?:审核|审查|评审|送审|审一下|审下)/;
const REVIEW_OUTCOME_RE = /(?:能不能|能否|可不可以)(?:发|用|上|过)|能(?:发|过|用|上)吗|有没有(?:问题|风险|违规)|有(?:问题|风险)吗|是否(?:合规|违规)/;
const REVIEW_NOUN_RE = /(?:审核|审查|评审)(?:记录表?|报告|规则|流程|日志)/g;

/** @returns {{intent:'read-access'|'clarify'|'skip'|null, why:string, reviewRequested?:boolean}} */
export function linkAccessIntent(text) {
  const original = String(text ?? '');
  const urls = original.match(URL_RE);
  if (!urls?.length) return { intent: null, why: '没有链接，不适用链接读取分流' };
  const body = original.replace(URL_RE, ' ').replace(/@_user_\d+|@守衡/g, ' ').trim();
  // Quoted copy can mention reading or reviewing without instructing the bot.
  const instruction = body.replace(QUOTE_RE, ' ').replace(REVIEW_NOUN_RE, ' ')
    .replace(/(?:不要|不用|别)(?:只|仅)读(?:取)?/g, ' ')
    .replace(/但是?|不过|而是/g, '；').trim();
  // Keep question marks on their clause. A bare "可以读取？" has no 吗 to fall back on.
  const clauses = (instruction.match(/[^，,。；;！？!?\n]+[！？!?]?/g) ?? [])
    .map((part) => part.trim()).filter(Boolean);
  const readOnly = clauses.some((part) => ONLY_READ_RE.test(part) || NO_REVIEW_RE.test(part));
  const accessQuestion = clauses.some((part) => READ_ACTION_RE.test(part) && CAPABILITY_RE.test(part));
  const noRead = clauses.some((part) => NO_READ_RE.test(part));
  if (!readOnly && !accessQuestion && !noRead) return { intent: null, why: '没有明确的读取能力、权限或只读要求' };

  const reviewNow = clauses.some((part) => !NO_REVIEW_RE.test(part) && !LATER_REVIEW_RE.test(part)
    && (REVIEW_REQUEST_RE.test(part) || REVIEW_OUTCOME_RE.test(part)));
  if (noRead) {
    return reviewNow
      ? { intent: 'clarify', why: '同时禁止读取并要求立即审查，需要先确认本次范围' }
      : { intent: 'skip', why: '明确要求不读取链接，本次不读取也不启动审核' };
  }
  if (reviewNow) {
    return readOnly
      ? { intent: 'clarify', why: '同时要求只读和立即审查，需要先确认本次范围' }
      : { intent: null, why: '本次还明确要求审查，保留送审流程', reviewRequested: true };
  }
  if ([...body].length > MAX_ACCESS_INSTRUCTION_CHARS) {
    return { intent: 'clarify', why: '读取要求同时附有较长正文，需要先确认本次范围' };
  }
  const unexplainedClause = clauses.some((part) => !READ_ACTION_RE.test(part)
    && !NO_REVIEW_RE.test(part) && !LATER_REVIEW_RE.test(part)
    && !/^(?:守衡|你好|谢谢|不用下载|不下载|\[\]\(\s*\))$/.test(part));
  if (/(?:文案|正文|原文|素材)\s*[:：]/.test(body) || unexplainedClause) {
    return { intent: 'clarify', why: '读取询问同时附有素材正文，需要先确认本次范围' };
  }
  return { intent: 'read-access', why: '只询问链接能否读取、读取权限，或明确要求只读' };
}
