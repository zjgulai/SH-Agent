/**
 * image_intent_gate.mjs —— 「看到了图，但一张都没解析出来」**不许出 PASS**（P0 · 2026-10-21 Owner 批准）
 *
 * ── 它治的那个病（实测，不是假设）────────────────────────────────────────────
 *   模态是**猜**出来的：`agent.mjs` 用 `inbound.imageCount`（= 解析成功的图数）推
 *   `--content-type`：
 *
 *       const _chainModality = (inbound?.videoCount ? null
 *         : (inbound?.imageCount ? 'image' : 'text'));
 *
 *   而 `imageCount` 只数**被解析成图片**的那几张（`feishu.imageKeysOf`）。于是这些情形
 *   全部退化成 `text`：
 *     · 图以**文件**消息发来（`msgType='file'`，`imageKeysOf` 对 file **恒返回 []**）；
 *     · `msgType='image'` 但 content 里没有 `image_key`（客户端把它拆过/改过）；
 *     · 富文本 `post` 里的图节点解析不到；
 *     · 引用一条带图的消息、**回读失败**（`parentNote.kind='parent_unreadable'`，那是**未测**）。
 *   ⇒ `--content-type text` ⇒ **「负面样本规则」那一层整层不跑** ⇒ 出 `PASS / 0 条`。
 *   代码里自己记着实测（`tools.mjs` 约 1944 行）：`10:06:48 text → PASS / 0 条`、
 *   `11:10:00 image → REVIEW / 5 条` —— **同一份图，只差这一个词**。
 *
 * ── 判据（两条，都是纯函数，可反向对照）───────────────────────────────────────
 *   ① `detectImageIntent()`：这条消息**意图上带没带图**（只看入站事实，不看正文里的字）。
 *      ⚠️ **不许**用「正文里出现了『图』字」来推测 —— 那会把大量文字单误判成图单（判据恒红）。
 *   ② `imageIntentVerdict()`：**有图意图 + 解析出 0 张** ⇒ `needInput`。
 *      这是 **fail-closed**：宁可回一张「图我没取到，请你重发」，也不许拿「零条」当「没问题」。
 *
 * ── 边界 ────────────────────────────────────────────────────────────────────
 *   · 只管**要不要拒答**，**不**碰链怎么跑、也不碰图怎么取（取图那一段一个字没改）。
 *   · 图**取到了但 OCR 空**、图**取失败**（`failed`）这些情形 `imageCount>0`，**不归本闸管** ——
 *     它们走各自已有的分支（OCR 空 → 视觉层；取失败 → 如实报）。
 *   · `videoCount>0` 的单不归本闸管（视频另有五个模态的口径，另案）。
 */

/** 图片文件后缀（小写、带点）。只用于「file 消息里塞了一张图」这一种判定。 */
const IMG_EXT_RE = /\.(jpe?g|png|webp|gif|bmp|heic|heif|tiff?)$/i;

function safeJson(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

/**
 * 这条消息**意图上**带没带图。
 *
 * @param {object} o
 * @param {string} [o.msgType]     飞书 message_type（image / post / file / text / …）
 * @param {string|object} [o.content] 飞书 content JSON（字符串或已解析对象）
 * @param {object} [o.parentNote]  引用回读的结论（`{kind:'parent_unreadable'|…}`）
 * @returns {{ hasIntent: boolean, why: string }}
 */
export function detectImageIntent({ msgType, content, parentNote } = {}) {
  const t = String(msgType ?? '').toLowerCase();
  const d = safeJson(content);

  if (t === 'image') {
    // 单图消息 —— 不管 image_key 在不在，**意图就是图片**
    // （缺 image_key 正是要拒答的那一档：看到了图、取不到）
    return { hasIntent: true, why: '消息类型是图片（msg_type=image）' };
  }

  if (t === 'post') {
    const blocks = Array.isArray(d?.content) ? d.content
      : (Array.isArray(d?.content_v2) ? d.content_v2 : []);
    let hasImgNode = false;
    for (const para of blocks) {
      if (!Array.isArray(para)) continue;
      for (const n of para) if (n && n.tag === 'img') { hasImgNode = true; break; }
      if (hasImgNode) break;
    }
    // 富文本里**有 img 节点**就算有意图（哪怕 image_key 缺了 —— 那正是要拒的）
    if (hasImgNode) return { hasIntent: true, why: '富文本里有图片节点（post/img）' };
    // 兜底：富文本里带 image_key 键但结构不认识（客户端变体）也算
    if (d && JSON.stringify(d).includes('"image_key"')) {
      return { hasIntent: true, why: '富文本里出现 image_key（结构未识别）' };
    }
    return { hasIntent: false, why: '' };
  }

  if (t === 'file' || t === 'media') {
    // ★ 这一档是**最容易踩**的：飞书里「以文件方式发送的图片」msgType 是 file，
    //   而 `feishu.imageKeysOf('file', …)` **恒返回 []** ⇒ 老实现直接当文字单跑。
    const name = String(d?.file_name ?? d?.fileName ?? d?.name ?? '');
    if (IMG_EXT_RE.test(name)) {
      return { hasIntent: true, why: `以文件形式发送的图片（file_name=${name || '无'}）` };
    }
    return { hasIntent: false, why: '' };
  }

  // 引用那条带图、但**回读失败** —— 这是「未测」，不是「没有图」
  if (parentNote?.kind === 'parent_unreadable') {
    return { hasIntent: true, why: '引用的那条消息读不到（回读失败＝未测，不是没有图）' };
  }

  return { hasIntent: false, why: '' };
}

/**
 * 有图意图 + 解析出 0 张 ⇒ 本单**不许出 PASS**（fail-closed）。
 *
 * @param {object} o
 * @param {{hasIntent:boolean,why:string}} [o.imageIntent]
 * @param {number} [o.imageCount]  解析成功的图数
 * @param {number} [o.videoCount]  视频数（>0 时本闸不介入）
 * @returns {{ needInput: boolean, reason: string }}
 */
export function imageIntentVerdict({ imageIntent, imageCount, videoCount } = {}) {
  if (Number(videoCount ?? 0) > 0) return { needInput: false, reason: '' };
  if (!imageIntent?.hasIntent) return { needInput: false, reason: '' };
  if (Number(imageCount ?? 0) > 0) return { needInput: false, reason: '' };
  return {
    needInput: true,
    reason: `这条消息带了图，但**一张都没解析出来**（${imageIntent.why || '原因未知'}）`,
  };
}

/** 自证：纯函数，不碰网络、不碰盘。`node agent/image_intent_gate.mjs --selftest` */
export function selftest() {
  const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}：期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`); };
  const cases = [];
  const chk = (name, fn) => { try { fn(); cases.push(['✅', name]); } catch (e) { cases.push(['❌', `${name} —— ${e.message}`]); } };

  chk('图消息（带 image_key）⇒ 有意图', () => eq(detectImageIntent({ msgType: 'image', content: '{"image_key":"img_v3_x"}' }).hasIntent, true, 'image'));
  chk('图消息（缺 image_key）⇒ 仍有意图（要拒的是取不到）', () => eq(detectImageIntent({ msgType: 'image', content: '{}' }).hasIntent, true, 'image 缺 key'));
  chk('file + .jpg ⇒ 有意图（最易踩的一档）', () => eq(detectImageIntent({ msgType: 'file', content: '{"file_name":"a.JPG"}' }).hasIntent, true, 'file jpg'));
  chk('file + .pdf ⇒ 无意图（反向对照，别误伤）', () => eq(detectImageIntent({ msgType: 'file', content: '{"file_name":"a.pdf"}' }).hasIntent, false, 'file pdf'));
  chk('post 有 img 节点 ⇒ 有意图', () => eq(detectImageIntent({ msgType: 'post', content: { content: [[{ tag: 'img', image_key: 'k' }]] } }).hasIntent, true, 'post img'));
  chk('post 只有文字 ⇒ 无意图', () => eq(detectImageIntent({ msgType: 'post', content: { content: [[{ tag: 'text', text: '这是一张图，请审一下' }]] } }).hasIntent, false, 'post text'));
  chk('引用回读失败 ⇒ 有意图（未测≠没有）', () => eq(detectImageIntent({ msgType: 'text', parentNote: { kind: 'parent_unreadable', error: 'x' } }).hasIntent, true, 'parent_unreadable'));
  chk('纯文字 ⇒ 无意图', () => eq(detectImageIntent({ msgType: 'text', content: '{"text":"审一下"}' }).hasIntent, false, 'text'));

  chk('有意图 + 0 张 ⇒ 必须拒答', () => eq(imageIntentVerdict({ imageIntent: { hasIntent: true, why: 'x' }, imageCount: 0 }).needInput, true, 'verdict red'));
  chk('有意图 + 1 张 ⇒ 不拒（反向对照，判据不许恒红）', () => eq(imageIntentVerdict({ imageIntent: { hasIntent: true, why: 'x' }, imageCount: 1 }).needInput, false, 'verdict green'));
  chk('无意图 ⇒ 不拒（文字单不许被误伤）', () => eq(imageIntentVerdict({ imageIntent: { hasIntent: false, why: '' }, imageCount: 0 }).needInput, false, 'verdict text'));
  chk('视频单 ⇒ 不归本闸管', () => eq(imageIntentVerdict({ imageIntent: { hasIntent: true, why: 'x' }, imageCount: 0, videoCount: 1 }).needInput, false, 'verdict video'));

  const bad = cases.filter(([s]) => s === '❌');
  for (const [s, n] of cases) console.log(`${s} ${n}`);
  console.log(`\n═══ image_intent_gate selftest：通过 ${cases.length - bad.length} / 失败 ${bad.length} ═══`);
  return bad.length === 0;
}

// 直接跑本文件时执行自证（被 import 时不跑）
if (process.argv[1] && process.argv[1].endsWith('image_intent_gate.mjs')) {
  process.exit(selftest() ? 0 : 1);
}
