#!/usr/bin/env node
/**
 * cli.mjs —— 卡片模版的命令行
 *
 * 三个用途，按危险程度排序：
 *   1. 看     list / show / sample / validate —— 纯本地，不碰网络
 *   2. 试     self-test —— 往**自己的私聊**发一条，验证卡片真能渲染
 *   3. 发群   send / send-all —— 往测试群发。**必须带 --confirm**，否则只打印不发送
 *
 * 为什么发送要单独加一道闸：卡片被拒的表现是「消息凭空不见」，
 * 而守衡在真实群里答错一次，代价是对方以为它又坏了。所以默认不发送。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { REGISTRY, BY_KIND, build, validateCard, renderText, shapeOf, sampleCards, lintCopy } =
  await import(path.join(HERE, 'index.mjs'));

const argv = process.argv.slice(2);
const cmd = argv[0];
const args = argv.slice(1);
const flag = (n) => args.includes(`--${n}`);
const val = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const positional = args.filter((a) => !a.startsWith('--'));

const DEFAULT_CHAT = process.env.PROBE_CHAT_ID || 'oc_TEST_GROUP';
const CHAT = val('chat', DEFAULT_CHAT);

function usage() {
  console.log(`守衡卡片模版 CLI

  看（本地，不联网）
    list                              列出全部类型
    show <kind>                       看一个类型：判据 / 字段 / 样例文本 / 形状
    sample <kind> [--json]            出样例卡（默认文本形态，--json 出原始卡片 JSON）
    validate <file|->                 校验一张卡（- 表示从 stdin 读）
    lint <file|->                     只跑去 AI 味的内容级检查

  试（发一条，验渲染）
    self-test                         往 --chat 指定的会话发 1 张最小卡

  发（默认只打印，不发送）
    send <kind> --confirm             发一张样例卡
    send-all --confirm                发全部十一张样例卡

  公共参数
    --chat=<chat_id>                  目标会话（默认取 $PROBE_CHAT_ID 或测试群）
`);
}

const readInput = (p) => (p === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(p, 'utf8'));

function printHits(hits, indent = '    ') {
  if (!hits.length) { console.log(`${indent}✅ 内容级检查干净`); return; }
  for (const h of hits) {
    const mark = h.level === 'error' ? '❌' : '⚠️ ';
    console.log(`${indent}${mark} ${h.id}（×${h.count}）${h.sample}  —— ${h.why}`);
  }
}

/* ─────────────────────── 看 ─────────────────────── */

function doList() {
  console.log(`守衡群回复卡片 · ${REGISTRY.length} 个类型\n`);
  const samples = sampleCards();
  for (const r of REGISTRY) {
    const c = samples[r.kind];
    console.log(`  ${r.kind.padEnd(20)} ${r.zh}   配色 ${String(c.header.template).padEnd(9)} ${shapeOf(c)}`);
  }
  console.log(`\n判据与字段：node ${path.relative(process.cwd(), path.join(HERE, 'cli.mjs'))} show <kind>`);
  console.log(`完整契约：tools/reply-cards/contract.md`);
}

function doShow(kind) {
  const r = BY_KIND.get(kind);
  if (!r) { console.error(`未知类型：${kind}\n可选：${REGISTRY.map((x) => x.kind).join(', ')}`); process.exit(1); }
  const c = build(kind, r.sample);
  console.log(`\n【${kind}】${r.zh}\n`);
  console.log(`什么时候用\n  ${r.when}\n`);
  console.log(`字段（${Object.keys(r.fields).length} 个）`);
  for (const [k, v] of Object.entries(r.fields)) console.log(`  ${k.padEnd(10)} ${v}`);
  console.log(`\n形状\n  ${shapeOf(c)}`);
  console.log(`\n配色\n  ${c.header.template}（${kind === 'correction' || kind === 'alert' ? '要停下看的' : '常规'}）`);
  console.log(`\n纯文本降级形态\n${renderText(c).split('\n').map((l) => '  ' + l).join('\n')}`);
  const lint = lintCopy(renderText(c));
  console.log(`\n去 AI 味内容级检查`);
  printHits(lint);
  console.log('');
}

function doSample(kind, json) {
  const r = BY_KIND.get(kind);
  if (!r) { console.error(`未知类型：${kind}`); process.exit(1); }
  const c = build(kind, r.sample);
  console.log(json ? JSON.stringify(c, null, 2) : renderText(c));
}

function doValidate(p) {
  let c;
  try { c = JSON.parse(readInput(p)); }
  catch (e) { console.error(`❌ 不是合法 JSON：${e.message}`); process.exitCode = 1; return; }
  const v = validateCard(c);
  if (v.ok) console.log(`✅ 通过本地校验（${shapeOf(c) || '无可见元素'}）`);
  else {
    console.log(`❌ ${v.errors.length} 处不合格：`);
    for (const e of v.errors) console.log(`   ${e.path}: ${e.msg}`);
  }
  if (v.warnings.length) {
    console.log(`\n⚠️  ${v.warnings.length} 条提醒：`);
    for (const w of v.warnings) console.log(`   ${w.path}: ${w.msg}`);
  }
  // 用 exitCode 而不是 process.exit()：process.exit 会在 stdout 还没 flush 时
  // 就把进程干掉，管道里（如 `... | node cli.mjs validate -`）输出会整个丢失。
  process.exitCode = v.ok ? 0 : 1;
}

function doLint(p) {
  const text = readInput(p);
  console.log('去 AI 味 · 内容级检查（只查机械可判的几条，风格仍要人读）\n');
  printHits(lintCopy(text), '  ');
  process.exit(0);
}

/* ─────────────────────── 试 ─────────────────────── */

async function sendOne(kind, chatId) {
  const { sendCard } = await import(path.join(HERE, 'index.mjs'));
  const r = await sendCard(chatId, kind, BY_KIND.get(kind).sample);
  const mark = r.ok ? (r.mode === 'card' ? '✅' : '⚠️ ') : '❌';
  console.log(`${mark} ${kind.padEnd(20)} mode=${r.mode.padEnd(14)} ${r.error ?? r.messageId ?? ''}`);
  return r;
}

async function doSend(kind, confirm) {
  if (!confirm) {
    console.log('（未加 --confirm，只打印不发送）\n');
    console.log(JSON.stringify(build(kind, BY_KIND.get(kind).sample), null, 2));
    console.log(`\n要真发到 ${CHAT}，加 --confirm。`);
    return;
  }
  await sendOne(kind, CHAT);
}

async function doSendAll(confirm) {
  if (!confirm) {
    console.log(`（未加 --confirm，只打印清单不发送）\n目标会话：${CHAT}\n`);
    for (const r of REGISTRY) console.log(`  ${r.kind.padEnd(20)} ${r.zh}`);
    console.log(`\n要真的发这 ${REGISTRY.length} 张，加 --confirm。`);
    return;
  }
  console.log(`往 ${CHAT} 发 ${REGISTRY.length} 张样例卡…\n`);
  let okCount = 0;
  for (const r of REGISTRY) {
    const res = await sendOne(r.kind, CHAT);
    if (res.ok) okCount++;
    await new Promise((s) => setTimeout(s, 600));
  }
  console.log(`\n发出 ${okCount}/${REGISTRY.length} 条。被拒的看上面 code。`);
}

/* ─────────────────────── 入口 ─────────────────────── */

const main = async () => {
  switch (cmd) {
    case 'list': return doList();
    case 'show': return doShow(positional[0]);
    case 'sample': return doSample(positional[0], flag('json'));
    case 'validate': return doValidate(positional[0]);
    case 'lint': return doLint(positional[0]);
    case 'self-test': {
      console.log(`最小卡片 → ${CHAT}`);
      const { sendCard } = await import(path.join(HERE, 'index.mjs'));
      const r = await sendCard(CHAT, 'receipt', { title: '渲染自检', verdict: '这张卡只为确认卡片真的能渲染出来，可忽略。' });
      console.log(r.ok ? `✅ mode=${r.mode} ${r.messageId ?? ''}` : `❌ ${r.error}`);
      return;
    }
    case 'send': return doSend(positional[0], flag('confirm'));
    case 'send-all': return doSendAll(flag('confirm'));
    default: return usage();
  }
};
main().catch((e) => { console.error(e); process.exit(1); });
