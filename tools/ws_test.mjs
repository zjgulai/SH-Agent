#!/usr/bin/env node
/**
 * ws_test.mjs —— 守衡 · 长连接（WebSocket）事件回调打通测试
 *
 * 目的：证明「飞书 → 守衡」这条反向链路是活的。
 *   之前的测试只证明了「守衡 → 飞书」（发消息）。
 *   本脚本建立长连接、订阅事件，并把收到的事件原样打印出来。
 *
 * 用法：
 *   node tools/ws_test.mjs                 # 保持连接 60 秒
 *   node tools/ws_test.mjs --seconds 120
 *   node tools/ws_test.mjs --reply         # 收到消息后自动回一条（验证闭环）
 *
 * 凭据：~/.dsh/credentials/shouheng-lark.json（0600）
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const credPath = path.join(os.homedir(), '.dsh', 'credentials', 'shouheng-lark.json');
const cred = JSON.parse(fs.readFileSync(credPath, 'utf8'));

const argv = process.argv.slice(2);
const secIdx = argv.indexOf('--seconds');
const SECONDS = secIdx >= 0 ? Number(argv[secIdx + 1]) : 60;
const REPLY = argv.includes('--reply');

const stamp = () => new Date().toTimeString().slice(0, 8);

const baseConfig = {
  appId: cred.app_id,
  appSecret: cred.app_secret,
  loggerLevel: Lark.LoggerLevel.info,
};

const client = new Lark.Client(baseConfig);

const dispatcher = new Lark.EventDispatcher({}).register({
  // ---- 消息事件：机器人被 @ 或收到单聊消息
  'im.message.receive_v1': async (data) => {
    const m = data.message ?? {};
    let text = '';
    try { text = JSON.parse(m.content ?? '{}').text ?? ''; } catch { /* 非文本消息 */ }
    console.log(`[${stamp()}] ★ im.message.receive_v1`);
    console.log(`         chat_id    = ${m.chat_id}`);
    console.log(`         message_id = ${m.message_id}`);
    console.log(`         chat_type  = ${m.chat_type}   msg_type = ${m.message_type}`);
    console.log(`         sender     = ${data.sender?.sender_id?.open_id}  (${data.sender?.sender_type})`);
    console.log(`         text       = ${JSON.stringify(text).slice(0, 200)}`);

    if (REPLY) {
      try {
        const r = await client.im.message.reply({
          path: { message_id: m.message_id },
          data: { msg_type: 'text', content: JSON.stringify({ text: '〔守衡〕长连接已收到你的消息，闭环正常。' }) },
        });
        console.log(`[${stamp()}] ✓ 已回复 message_id=${r?.data?.message_id}`);
      } catch (e) {
        console.log(`[${stamp()}] ✗ 回复失败: ${e?.response?.data ? JSON.stringify(e.response.data) : e.message}`);
      }
    }
  },

  // ---- 机器人进群 / 退群
  'im.chat.member.bot.added_v1': async (data) => {
    console.log(`[${stamp()}] ★ im.chat.member.bot.added_v1  chat_id=${data.chat_id}`);
  },
  'im.chat.member.bot.deleted_v1': async (data) => {
    console.log(`[${stamp()}] ★ im.chat.member.bot.deleted_v1  chat_id=${data.chat_id}`);
  },

  // ---- 卡片按钮回调（schema 2.0 的 button 走这里）
  'card.action.trigger': async (data) => {
    console.log(`[${stamp()}] ★ card.action.trigger  ${JSON.stringify(data).slice(0, 300)}`);
  },
});

const ws = new Lark.WSClient({ ...baseConfig, loggerLevel: Lark.LoggerLevel.info });

console.log('='.repeat(78));
console.log('守衡 · 长连接测试');
console.log('='.repeat(78));
console.log(`  app_id   = ${cred.app_id}`);
console.log(`  app_name = ${cred.app_name ?? '守衡'}`);
console.log(`  时长     = ${SECONDS}s${REPLY ? '  (自动回复已开启)' : ''}`);
console.log('  等待事件中…（在群里 @机器人 或私聊它，事件会立刻打印在这里）');
console.log('');

let eventCount = 0;
const origRegister = dispatcher.register.bind(dispatcher);
dispatcher.register = (handlers) => {
  const wrapped = {};
  for (const [k, v] of Object.entries(handlers)) {
    wrapped[k] = async (data) => { eventCount++; return v(data); };
  }
  return origRegister(wrapped);
};

const main = async () => {
  try {
    await ws.start({ eventDispatcher: dispatcher });
    console.log(`[${stamp()}] ✓ 长连接已建立（WebSocket）`);
    console.log(`[${stamp()}]   未报错 = 应用已开启「长连接」订阅模式`);
  } catch (e) {
    console.log(`[${stamp()}] ✗ 长连接建立失败：${e?.message ?? e}`);
    console.log('        常见原因：控制台事件订阅方式仍为「请求地址」而非「长连接」。');
    process.exit(1);
  }

  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  console.log('');
  console.log('='.repeat(78));
  console.log(`  测试结束：连接存活 ${SECONDS}s，收到事件 ${eventCount} 个`);
  if (eventCount === 0) {
    console.log('  ⚠ 0 事件 ≠ 链路坏了 —— 只是这段时间内没人给机器人发消息。');
    console.log('    再跑一次，边跑边在群里 @守衡 即可看到事件。');
  }
  console.log('='.repeat(78));
  process.exit(0);
};

main();
