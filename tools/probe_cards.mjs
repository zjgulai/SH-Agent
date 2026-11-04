/**
 * probe_cards.mjs —— 飞书卡片能力探针（实测，不靠文档）
 *
 * 为什么需要它：
 *   守衡现在 42% 的回复里含数据表，而唯一的富文本转换器 mdToPostNodes 不认表格，
 *   回复又整体走 msg_type=text。要设计卡片模版，就必须先知道**飞书卡片到底支持什么**。
 *   文档读不到、检索不可用的时候，唯一的可靠答案是往群里发一张真的试试。
 *
 * 设计取舍：**一张卡只测一件事**。
 *   卡片 JSON 里任何一个元素不被接受，整张卡会被服务端整体拒绝（或整体降级），
 *   把七个元素塞进一张卡，失败时你只知道「有一处不对」，不知道是哪一处。
 *   拆成七张，每张的成败就是那个元素的读数。
 *
 * 用法：
 *   node tools/probe_cards.mjs              # 发全部探针
 *   node tools/probe_cards.mjs --dry        # 只打印将要发送的 payload，不发
 *   node tools/probe_cards.mjs --only=table # 只发某一张
 *
 * 产物：每张卡的成败与原始错误写入 PMO/logs/card_probe.jsonl
 */
import fs from 'node:fs';
import path from 'node:path';
import { client } from './agent/feishu.mjs';
import { LOG_DIR, ensureDir } from './agent/config.mjs';

/** 实测群：内容治理-守衡Agent-测试 */
const CHAT_ID = process.env.PROBE_CHAT_ID || 'oc_TEST_GROUP';

const DRY  = process.argv.includes('--dry');
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1] ?? null;

const RESULT_FILE = path.join(LOG_DIR, 'card_probe.jsonl');

/* ─────────────────────────── 探针卡定义 ─────────────────────────── */
/*
 * 每张卡只问一个问题。`asks` 写的是这张卡要回答的疑点 ——
 * 探针的价值全在这里，没有它，一周后没人记得为什么发过这条消息。
 */
const PROBES = [
  {
    id: 'header_theme',
    asks: 'header 的 template 字段接受哪些取值？turquoise 之外还有哪些？',
    card: {
      schema: '2.0',
      config: { update_multi: true },
      header: {
        title: { tag: 'plain_text', content: '探针 1/7 · header 配色' },
        subtitle: { tag: 'plain_text', content: '守衡卡片能力实测 · 可忽略' },
        template: 'turquoise',
      },
      body: {
        elements: [
          { tag: 'markdown', content: '本卡只验证 **header** 是否接受 `subtitle` 与 `template: turquoise`。\n看到绿色标题栏即为通过。' },
        ],
      },
    },
  },
  {
    id: 'markdown_element',
    asks: 'markdown 元素里，标题/列表/表格语法/引用/分割线各自渲染成什么？',
    card: {
      schema: '2.0',
      config: { update_multi: true },
      header: { title: { tag: 'plain_text', content: '探针 2/7 · markdown 元素' }, template: 'blue' },
      body: {
        elements: [
          {
            tag: 'markdown',
            content: [
              '# 一级标题',
              '## 二级标题',
              '',
              '**粗体** / *斜体* / ~~删除线~~ / `行内代码`',
              '',
              '- 无序项 A',
              '- 无序项 B',
              '',
              '1. 有序项一',
              '2. 有序项二',
              '',
              '> 引用块',
              '',
              '| 列A | 列B |',
              '|---|---|',
              '| 甲 | 乙 |',
            ].join('\n'),
          },
          { tag: 'hr' },
          { tag: 'markdown', content: '上面这条横线是 `hr` 元素（独立元素，不是 markdown 里的 `---`）。' },
        ],
      },
    },
  },
  {
    id: 'table_element',
    asks: '有没有原生 table 元素？如果有，列宽与溢出怎么办？',
    card: {
      schema: '2.0',
      config: { update_multi: true },
      header: { title: { tag: 'plain_text', content: '探针 3/7 · 原生 table' }, template: 'orange' },
      body: {
        elements: [
          { tag: 'markdown', content: '本卡只验证一件事：**原生 table 元素是否存在**。\n守衡 42% 的回复是数据表，这一项决定它们怎么画。' },
          {
            tag: 'table',
            columns: [
              { name: 'time', display_name: '时间', data_type: 'text' },
              { name: 'what', display_name: '你说的', data_type: 'text' },
            ],
            rows: [
              { time: '09-15 22:38:21', what: '你是做什么的？' },
              { time: '09-16 12:39:35', what: '我什么时候跟你说过话' },
            ],
          },
        ],
      },
    },
  },
  {
    id: 'column_set',
    asks: 'column_set 分栏可用吗？「能做 / 做不到」这类对照能不能左右排？',
    card: {
      schema: '2.0',
      config: { update_multi: true },
      header: { title: { tag: 'plain_text', content: '探针 4/7 · 分栏' }, template: 'green' },
      body: {
        elements: [
          { tag: 'markdown', content: '本卡验证 `column_set`：两栏能不能并排（群里 / 手机上）。' },
          {
            tag: 'column_set',
            flex_mode: 'none',
            columns: [
              {
                tag: 'column',
                width: 'weighted',
                weight: 1,
                elements: [{ tag: 'markdown', content: '**我能做**\n读群历史\n看群成员\n读工作区文件' }],
              },
              {
                tag: 'column',
                width: 'weighted',
                weight: 1,
                elements: [{ tag: 'markdown', content: '**我做不到**\n发文件\n读图片\n联网' }],
              },
            ],
          },
        ],
      },
    },
  },
  {
    id: 'collapsible',
    asks: '折叠面板存在吗？长证据能不能默认收起、点开才看？',
    card: {
      schema: '2.0',
      config: { update_multi: true },
      header: { title: { tag: 'plain_text', content: '探针 5/7 · 折叠面板' }, template: 'purple' },
      body: {
        elements: [
          { tag: 'markdown', content: '本卡验证折叠面板：长证据默认收起，点开才看。' },
          {
            tag: 'collapsible_panel',
            expanded: false,
            header: {
              title: { tag: 'markdown', content: '证据 · 3 条命令' },
              vertical_align: 'center',
              icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
              icon_position: 'right',
              icon_expanded_angle: -180,
            },
            elements: [
              { tag: 'markdown', content: '```bash\nls -d /Users/lute/.dsh/Momcozy知识库\ngrep -rn "岗位卡" --include=*.md .\nwc -l README.md\n```' },
            ],
          },
        ],
      },
    },
  },
  {
    id: 'note_fields',
    asks: 'footer 的 note 与字段（fields）在 JSON 2.0 里叫什么？边界声明能不能用字段排？',
    card: {
      schema: '2.0',
      config: { update_multi: true },
      header: { title: { tag: 'plain_text', content: '探针 6/7 · 字段与注脚' }, template: 'grey' },
      body: {
        elements: [
          { tag: 'markdown', content: '本卡验证 `note` 注脚元素与 `fields` 字段排布 —— 边界声明打算用这个画。' },
          {
            tag: 'note',
            elements: [
              { tag: 'plain_text', content: '注脚：本回答基于最近 50 条窗口 · 证据 3 条' },
            ],
          },
        ],
      },
    },
  },
  {
    id: 'button_callback',
    asks: '按钮有无回调？会话里 card.action.trigger 现在只记日志，能不能真的接住？',
    card: {
      schema: '2.0',
      config: { update_multi: true },
      header: { title: { tag: 'plain_text', content: '探针 7/7 · 按钮（请勿点）' }, template: 'red' },
      body: {
        elements: [
          { tag: 'markdown', content: '本卡验证按钮与回调。**请忽略这个按钮，不需要点。**' },
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '回调测试（勿点）' },
                type: 'default',
                value: { probe: 'button_callback' },
              },
            ],
          },
        ],
      },
    },
  },
];

/* ─────────────────────────── 发送与记录 ─────────────────────────── */

function record(entry) {
  ensureDir(LOG_DIR);
  fs.appendFileSync(RESULT_FILE, JSON.stringify(entry) + '\n');
}

/** 取错误里最有诊断价值的字段，而不是整坨 JSON */
function digestError(e) {
  const d = e?.response?.data;
  if (!d) return { message: e?.message ?? String(e) };
  return {
    code: d.code,
    msg: d.msg,
    // 飞书拒绝卡片时会指出具体是哪个字段/哪个元素，这个字段比 msg 有用
    error: d.error,
    detail: d.detail ?? d.details,
  };
}

async function sendProbe(p) {
  const payload = { receive_id: CHAT_ID, msg_type: 'interactive', content: JSON.stringify(p.card) };
  if (DRY) {
    console.log(`\n── ${p.id} ── ${p.asks}`);
    console.log(JSON.stringify(p.card, null, 2));
    return;
  }
  const t0 = Date.now();
  try {
    const r = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: payload,
    });
    const entry = { at: new Date().toISOString(), id: p.id, asks: p.asks, ok: true,
                    messageId: r?.data?.message_id ?? null, ms: Date.now() - t0 };
    record(entry);
    console.log(`✅ ${p.id} — 通过，message_id=${entry.messageId}（${entry.ms}ms）`);
  } catch (e) {
    const err = digestError(e);
    const entry = { at: new Date().toISOString(), id: p.id, asks: p.asks, ok: false, error: err, ms: Date.now() - t0 };
    record(entry);
    console.log(`❌ ${p.id} — 被拒：${JSON.stringify(err)}`);
  }
}

async function main() {
  const list = ONLY ? PROBES.filter((p) => p.id === ONLY) : PROBES;
  if (!list.length) {
    console.error(`没有匹配的探针：--only=${ONLY}；可选：${PROBES.map((p) => p.id).join(', ')}`);
    process.exit(1);
  }
  console.log(`目标群 ${CHAT_ID}｜探针 ${list.length} 张${DRY ? '（dry run，不发送）' : ''}\n`);
  for (const p of list) {
    await sendProbe(p);
    if (!DRY) await new Promise((r) => setTimeout(r, 600));   // 别把接口打太快
  }
  if (!DRY) console.log(`\n原始读数已写入 ${RESULT_FILE}`);
  process.exit(0);
}

main().catch((e) => { console.error('探针失败：', e); process.exit(1); });
