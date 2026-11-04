#!/usr/bin/env node
/**
 * 复现 2026-10-15 17:20 那张 PASS 卡（台账 `ws_outbound.jsonl` 第 1073 行，
 * 行 `MC-US-AMZ-B0G647K9TN`，message `om_x100b623de32b9c84cebb3cd965d312f`）。
 *
 * 喂进去的是**模型自己给的那张 `query-answer` 卡**（逐字取自 `batch-review.json`
 * 的 `reply_head` 与台账正文），调用方已声明 `machineAnswer: true`。
 * 期望：公开卡面上**只剩权威结论行**，内部读数一行都不许有。
 */
import fs from 'node:fs';
import { toCardOrText } from './reply-cards/envelope.mjs';
import { renderText } from './reply-cards/index.mjs';

const LEDGER = new URL('../PMO/logs/ws_outbound.jsonl', import.meta.url);
const rows = fs.readFileSync(LEDGER, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const hit = rows.find((r) => (r.message_ids ?? []).includes('om_x100b623de32b9c84cebb3cd965d312f'));
if (!hit) { console.error('找不到那张卡'); process.exit(2); }

// 台账正文＝卡抬头 ＋ 卡面（折叠区只留一行注记）⇒ 去掉抬头即卡面正文
const line53 = '【审查结论：PASS】未发现已知底线风险，可转交 @sign-off 责任人（未配置） 进行 sign-off。';
const body = hit.text.split('\n').slice(1).join('\n').trim();

// 模型那一轮的原文＝一张 `query-answer` 卡（title/verdict/reasoning 三格）
const raw = '[[card:query-answer]]\n'
  + JSON.stringify({
    title: 'M5 Smart（Quill Gray）listing：链侧 PASS/0 —— 但本单没收到合并稿',
    verdict: '链侧 PASS/0（未发现已知底线风险）；本单未收到双轨合并块',
    reasoning: body,
  });

const verdict53 = { state: 'PASS', line: line53, from: 'chain', block: null };
const r = toCardOrText(raw, { verdict53, machineAnswer: true });

const whole = JSON.stringify(r.card ?? r.text ?? '');
const LEAKS = ['引擎结论', '回读=', '（未填）', 'risk_items', 'heuristic_not_calibrated',
               '问题数 0 ｜', 'record_id', '--content-type', 'source_sha256', '链路',
               '四道审计', '预演落章', 'feishu_publish'];
const leaked = LEAKS.filter((k) => whole.includes(k));
const dupLine = (whole.match(/【审查结论：PASS】/g) ?? []).length;

console.log('mode =', r.mode, '｜ kind =', r.kind ?? '(无)');
console.log('卡面文本（renderText 视角）：');
console.log('─'.repeat(70));
console.log(r.text ?? '(无)');
console.log('─'.repeat(70));
console.log('结论行出现次数 =', dupLine, '（应为 1）');
console.log('漏出的内部读数 =', leaked.length ? leaked.join(' / ') : '（无）');

const ledgerView = (r.mode === 'card' && r.card) ? renderText(r.card) : (r.text ?? '');
const ledgerLeaks = LEAKS.filter((k) => ledgerView.includes(k));
console.log('台账视角漏出的内部读数 =', ledgerLeaks.length ? ledgerLeaks.join(' / ') : '（无）');
const bad = leaked.length || dupLine !== 1 || ledgerLeaks.length;
console.log(bad ? '\n❌ 复现：这张卡的卡面/台账里仍是内部读数' : '\n✅ 卡面干净');
process.exit(bad ? 1 : 0);
