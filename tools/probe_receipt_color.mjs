/**
 * probe_receipt_color.mjs —— 「回执卡该是什么颜色」的**人眼探针**
 *
 * ── 为什么必须发出来看 ──────────────────────────────────────────────────
 * 2026-10-06 实测过一个反例：飞书 `header.template` **接受任何字符串**——
 * `turquoise` / `pink` / `carmine-50` / `red-50` / `carmine-100` / `default`
 * 六个全部 `code=0` 发出成功（每张发完立刻撤回）。所以
 * **「发得出去」不是「渲染成那样」** —— 未知取值被静默忽略、回落成默认色，
 * 而接口不会告诉你。颜色这件事**没有离线判据**，只能发到群里用人眼看。
 *
 * ── 参照色从哪来 ────────────────────────────────────────────────────────
 * 不是猜的。委托方给的参照站 `https://momcozy.com/` 的 CSS 自定义属性里直接写着：
 *
 *     --brand-color            = #9B626C   ← 品牌主色（灰调玫粉 = 「淡暗粉」）
 *     --sale-price-color       = #9B626C
 *     --pri-cl                 = #6b2c3b   ← 加深
 *     --product-vendors-color  = #b97c83   ← 减淡
 *     --t4s-bg-color           = #d5c4ca / #fbeae5
 *
 * 复现：`curl -sL https://momcozy.com/ | grep -o -- '--brand-color:[^;]*'`
 *
 * ── 这张探针在问什么 ────────────────────────────────────────────────────
 * 枚举里**没有粉色**（13 个取值：blue wathet turquoise green yellow orange
 * red carmine violet purple indigo grey default），所以粉色只能来自两条路：
 *   ① `header.template` 里**最接近粉**的 `carmine`；
 *   ② 元素级 `background_style` —— 它吃色阶后缀（`-50`…`-900`）**和自定义 RGBA**，
 *      而表头不吃。
 * 探针把这两条路（单独 / 组合）各发一张，让委托方挑。
 *
 * 用法：
 *   node tools/probe_receipt_color.mjs                 # 只打印将要发的卡，不发送
 *   node tools/probe_receipt_color.mjs --send          # 真发到测试群（**不撤回**）
 *   node tools/probe_receipt_color.mjs --send --chat=oc_xxx
 */
import { client } from './agent/feishu.mjs';

/** 参照站实测取回的 momcozy 品牌色 */
export const BRAND_PINK = '#9B626C';

/**
 * 探针默认落点：**委托方的私聊**。
 *
 * ★ 2026-10-06 改。原来默认是机器人自己的测试群
 *   （`oc_49a7cf…`，与 2026-09-18 那 10 张探针卡同一个群），发完第一轮被委托方否掉：
 *   **「不要发群里，私聊给我」**。理由是他不会去看那个群 —— 发在那里等于没发。
 *   这类「人眼才能判」的探针，落点必须是**人会看的那一处**，不是流程上惯用的那一处。
 *   要发别处就显式带 `--chat=`。
 */
const DEFAULT_CHAT = process.env.SHOUHENG_PROBE_CHAT
  || 'oc_TEST_P2P';   // p2p 私聊（mode=p2p）

const md = (content) => ({ tag: 'markdown', content: String(content) });

/** 一条色带 —— 用它把「元素级背景色」这件事单独摆出来看 */
const band = (content, backgroundStyle) => ({
  tag: 'column_set',
  flex_mode: 'none',
  ...(backgroundStyle ? { background_style: backgroundStyle } : {}),
  columns: [{ tag: 'column', width: 'weighted', weight: 1, elements: [md(content)] }],
});

/**
 * 五个候选。每张**自带编号与名字**，这样委托方可以直接说「第 3 张」。
 * @param {string} title 回执卡真实标题（守衡发的那句）
 */
export function candidates(title = '正在处理，请稍等，马上给你结果。') {
  const receiptBody = (extra = []) => [
    md('收到，正在处理。'),
    ...extra,
  ];

  return [
    {
      id: 'A-baseline',
      name: '现状 · 灰色（对照）',
      asks: '这是现在线上那张，用来当尺子 —— 委托方说的「灰色」就是它。',
      card: {
        schema: '2.0',
        config: { update_multi: true },
        header: { title: { tag: 'plain_text', content: `A · 现状灰 · ${title}` }, template: 'grey' },
        body: { elements: receiptBody() },
      },
    },
    {
      id: 'B-carmine-header',
      name: 'carmine 表头（枚举里唯一偏粉的）',
      asks: '表头能不能单独扛起「淡暗粉」？风险：`alert`（我这侧坏了）当前也是 carmine。',
      card: {
        schema: '2.0',
        config: { update_multi: true },
        header: { title: { tag: 'plain_text', content: `B · carmine 表头 · ${title}` }, template: 'carmine' },
        body: { elements: receiptBody() },
      },
    },
    {
      id: 'C-default-header+carmine-50-band',
      name: '中性表头 + carmine-50 淡粉色带',
      asks: '表头不抢色（`default`），粉色只出现在正文色带里 —— 色阶后缀表头不吃、元素吃。',
      card: {
        schema: '2.0',
        config: { update_multi: true },
        header: { title: { tag: 'plain_text', content: `C · 中性表头+淡粉色带 · ${title}` }, template: 'default' },
        body: { elements: receiptBody([band('↑ 这一条色带的底色 = `carmine-50`', 'carmine-50')]) },
      },
    },
    {
      id: 'D-carmine-header+carmine-50-band',
      name: 'carmine 表头 + carmine-50 色带（最接近「整卡粉」）',
      asks: '两条路叠起来。如果 C 太淡、B 太艳，多半是这张。',
      card: {
        schema: '2.0',
        config: { update_multi: true },
        header: { title: { tag: 'plain_text', content: `D · carmine 表头+淡粉色带 · ${title}` }, template: 'carmine' },
        body: { elements: receiptBody([band('↑ 这一条色带的底色 = `carmine-50`', 'carmine-50')]) },
      },
    },
    {
      id: 'E-brand-rgba-band',
      name: `品牌色直给 · 中性表头 + rgba 色带 (${BRAND_PINK})`,
      asks: `元素级到底吃不吃自定义 RGBA？色带底色取参照站实测的 --brand-color ${BRAND_PINK} 的 12% 淡色。若这张渲染出粉，它就是**最贴 momcozy** 的那条路。`,
      card: {
        schema: '2.0',
        config: { update_multi: true },
        header: { title: { tag: 'plain_text', content: `E · 品牌色 ${BRAND_PINK} · ${title}` }, template: 'default' },
        body: {
          elements: receiptBody([
            band(`↑ 这一条色带的底色 = \`rgba(155,98,108,0.12)\`（= ${BRAND_PINK} 12%）`, 'rgba(155,98,108,0.12)'),
          ]),
        },
      },
    },
    {
      id: 'F-brand-rgba-solid-band',
      name: `品牌色直给 · 不透明 (${BRAND_PINK})`,
      asks: '同上，但底色完全不透明 —— 用来区分「RGBA 被接受了」与「只是浅到看不出」。',
      card: {
        schema: '2.0',
        config: { update_multi: true },
        header: { title: { tag: 'plain_text', content: `F · 品牌色不透明 ${BRAND_PINK} · ${title}` }, template: 'default' },
        body: {
          elements: receiptBody([
            band(`↑ 这一条色带的底色 = \`rgba(155,98,108,1)\`（= ${BRAND_PINK} 实色）`, 'rgba(155,98,108,1)'),
          ]),
        },
      },
    },
  ];
}

async function main() {
  const send = process.argv.includes('--send');
  const chatArg = process.argv.find((a) => a.startsWith('--chat='));
  const chat = chatArg ? chatArg.slice('--chat='.length) : DEFAULT_CHAT;
  const list = candidates();

  console.log(`momcozy 品牌色（参照站 CSS 实测）：${BRAND_PINK}`);
  console.log(`候选 ${list.length} 张${send ? ` → 发往 ${chat}（**不撤回**）` : '（干跑，加 --send 才真发）'}\n`);

  for (const c of list) {
    if (!send) {
      console.log(`── ${c.id} · ${c.name}`);
      console.log(`   表头 template = ${JSON.stringify(c.card.header.template)}`);
      const bandEl = c.card.body.elements.find((e) => e.tag === 'column_set');
      console.log(`   正文色带 background_style = ${bandEl ? JSON.stringify(bandEl.background_style) : '（无）'}`);
      console.log(`   在问：${c.asks}\n`);
      continue;
    }
    try {
      const r = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chat, msg_type: 'interactive', content: JSON.stringify(c.card) },
      });
      const ok = r?.code === 0 || r?.data?.message_id;
      console.log(`${ok ? '✅' : '❌'} ${c.id}  ${ok ? `message_id=${r?.data?.message_id}` : JSON.stringify(r)}`);
    } catch (e) {
      const d = e?.response?.data;
      console.log(`❌ ${c.id}  发卡被拒 ${d ? `code=${d.code} ${String(d.msg ?? '').slice(0, 200)}` : e?.message}`);
    }
  }

  if (send) {
    console.log('\n★ 这六张**没有撤回** —— 请到测试群里用人眼看一下，然后告诉我要哪一张。');
    console.log('★ 「发得出去」不等于「渲染成那样」：未知取值会被服务端静默忽略（本文件顶部有实测记录）。');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('探针异常：', e); process.exit(1); });
}
