#!/usr/bin/env node
/**
 * _dryrun_routing.mjs —— 定向干跑：验**收尾动作行的收件人**是不是按问题方向算的。
 *
 * ## 为什么这么写
 *
 *   Owner 2026-10-14 报：PRD §5.3.2 逐字写 `建议转 @法务 @医学顾问 复核。`，
 *   而守衡发的是 `建议转 @内容治理负责人 复核。`（硬编码常量）。
 *
 *   这一件**必须用真链的一个真单来验**，不能只测模块：
 *   模块判据（`agent/routing.test.mjs` 29 项）只证明 `routing.mjs` 算得对；
 *   `test_agent.mjs` Z43 只证明 `renderMerged` 拼得对。
 *   而**真发出去的那张卡**是 `ws_daemon.replyTo → toCardOrText → applyVerdictLine`
 *   叠加出来的 —— 这一跳没有端到端判据（本仓栽过「模块测过了 ⇒ 以为链上也就对了」）。
 *
 * ## 隔离（与 `_dryrun_link.mjs` 同款）
 *
 *   · 假 sender open_id ⇒ 会话隔离，跑完删掉；
 *   · 假 message_id ⇒ 会落 seen-messages，跑完摘掉；
 *   · `chainRunner` 打桩 ⇒ **不起真链**（干跑不许真写飞书）；
 *   · 全程不往任何群里发东西。
 *
 * 用法：`node tools/_dryrun_routing.mjs [素材文字]`
 *   不给素材就用默认那条（库里没有覆盖的题材 ⇒ 走 REVIEW/覆盖缺口那一支，
 *   而**那一支恰好没有方向** ⇒ 验的是 fallback 兜底 + 收件人不为空）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { handleMessage } from './agent/agent.mjs';
import { toCardOrText } from './reply-cards/envelope.mjs';
import { renderText } from './reply-cards/index.mjs';
import { REPO_ROOT } from './agent/config.mjs';

const MATERIAL = process.argv[2]
  || '这条展会物料能不能发：M6 吸奶器附赠收纳袋与备用阀门，支持洗碗机清洗。';
const CHAT_ID = 'oc_TEST_P2P';
const FAKE_SENDER = 'ou_dryrun00000000000000000000000000';
const MSG_ID = `om_dryrun_route_${Date.now()}`;

const event = {
  message: {
    chat_id: CHAT_ID, chat_type: 'p2p',
    message_id: MSG_ID, message_type: 'text',
    content: JSON.stringify({ text: MATERIAL }),
    create_time: String(Date.now()),
  },
  sender: { sender_id: { open_id: FAKE_SENDER }, sender_type: 'user' },
};

const t0 = Date.now();
const out = await handleMessage(event, {
  chainRunner: async () => ({ error: '干跑：本该起链，但干跑不起' }),
});
console.log('═'.repeat(74));
console.log(`干跑 · 耗时 ${Date.now() - t0}ms · reason=${out.reason}`);
console.log(`素材：${MATERIAL}`);
console.log('─'.repeat(74));

const reply = out.reply ?? '';
const shaped = toCardOrText(reply);
console.log(`信封判定：kind=${shaped.cardKind ?? shaped.kind ?? '(无卡)'}`);

// 卡面/正文里那一行动作行
const all = reply + '\n' + (shaped.card ? renderText(shaped.card) : '');
const actionLines = all.split('\n').filter((l) => /建议转|请修改后重新提交/.test(l));
console.log(`\n★ 收尾动作行（${actionLines.length} 处）：`);
for (const l of actionLines) console.log(`   ${l.trim()}`);

const hasOld = /内容治理负责人/.test(all);
console.log(`\n★ 含旧常量「内容治理负责人」 = ${hasOld}`);
console.log(hasOld ? '❌ 旧常量还在' : '✅ 旧常量已消失');
if (actionLines.length) {
  const okFmt = actionLines.every((l) => /^建议转 @\S.* 复核。/.test(l.trim()) || /请修改后重新提交。/.test(l));
  console.log(okFmt ? '✅ 句式合 PRD §5.3（建议转 @… 复核。）' : '❌ 句式不合 PRD §5.3');
  const emptyWho = actionLines.some((l) => /建议转\s{2,}复核/.test(l));
  console.log(emptyWho ? '❌ 出现空收件人' : '✅ 没有空收件人');
}

// ── 清场 ──
const sf = path.join(REPO_ROOT, 'PMO', 'shouheng-state', 'sessions', `dm_${FAKE_SENDER}.json`);
if (fs.existsSync(sf)) { fs.unlinkSync(sf); console.log('\n（干跑会话已删）'); }
const seenFile = path.join(REPO_ROOT, 'PMO', 'shouheng-state', 'seen-messages.json');
if (fs.existsSync(seenFile)) {
  try {
    const seen = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
    if (Array.isArray(seen)) {
      fs.writeFileSync(seenFile, JSON.stringify(seen.filter((x) => x !== MSG_ID)));
    } else if (seen && typeof seen === 'object') {
      for (const k of Object.keys(seen)) if (seen[k] && typeof seen[k] === 'object') delete seen[k][MSG_ID];
      fs.writeFileSync(seenFile, JSON.stringify(seen));
    }
    console.log('（假 message_id 已摘掉）');
  } catch { /* 摘不掉不吞主结论 */ }
}
