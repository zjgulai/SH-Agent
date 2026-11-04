#!/usr/bin/env node
/**
 * ws_raw_trace.mjs —— 长连接「原始帧」取证器（裸连接版）
 *
 * 为什么需要它
 * ─────────────
 * 前面的排查已证明「连接建立了」，但证明不了「这条会话被飞书当作可用连接在保活」。
 * 飞书侧若把会话静默丢弃，TCP 仍会 ESTABLISHED 一段时间，而 SDK 的 debug 日志
 * 只在握手成功时打过一次 connect success，之后不会再报「连接已死」。
 *
 * 本工具绕开 SDK 的高层封装，直接：
 *   1. POST /callback/ws/endpoint 拿 ticket 与 ClientConfig（与 SDK 完全同路径）
 *   2. 用 ws 建裸连接，逐帧打印【所有】原始帧（含 ping/pong 心跳）
 *   3. 周期性报告「距上次收到帧的秒数」——静默增长即为死会话
 *
 * 判定标准
 *   ✅ 健康  ：每 ~PingInterval 秒能看到一次帧（心跳或事件）
 *   ❌ 死会话：握手后再无任何帧，静默持续增长
 *
 * 用法：node ws_raw_trace.mjs [监听秒数，默认 180]
 */
import WebSocket from 'ws';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const DURATION = Number(process.argv[2] || 180);
const cred = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'credentials', 'shouheng-lark.json'), 'utf8'));

const T0 = Date.now();
const elapsed = () => ((Date.now() - T0) / 1000).toFixed(3).padStart(7);
const log = (...a) => console.log(`[+${elapsed()}s]`, ...a);

let frameCount = 0, eventFrameCount = 0, lastFrameAt = Date.now();
const frames = [];

log('='.repeat(74));
log('守衡 · 长连接【原始帧】取证器（裸连接）');
log(`  app_id   = ${cred.app_id}`);
log(`  监听时长 = ${DURATION}s`);
log('  目的：区分「TCP 连接活着」与「飞书会话被静默丢弃」');
log('='.repeat(74));

// ── 第 1 步：拿 connect config（与 SDK 同一条路径）────────────────────
log('');
log('【1/2】POST /callback/ws/endpoint 换取 ticket …');
const resp = await fetch('https://open.feishu.cn/callback/ws/endpoint', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', locale: 'zh' },
  body: JSON.stringify({ AppID: cred.app_id, AppSecret: cred.app_secret }),
});
const j = await resp.json();
if (j.code !== 0) {
  log(`✗ 换取失败 code=${j.code} msg=${j.msg}`);
  process.exit(1);
}
const WS_URL = j.data.URL;
const CC = j.data.ClientConfig;
const u = new URL(WS_URL);
log('✓ 成功');
log(`  device_id  = ${u.searchParams.get('device_id')}`);
log(`  service_id = ${u.searchParams.get('service_id')}`);
log(`  fpid/aid   = ${u.searchParams.get('fpid')} / ${u.searchParams.get('aid')}`);
log(`  ClientConfig = ${JSON.stringify(CC)}`);
log('');
log(`  ★ 服务端要求的心跳间隔 PingInterval = ${CC.PingInterval}s`);
log(`  ★ 断线重连 ReconnectCount=${CC.ReconnectCount} Interval=${CC.ReconnectInterval}s`);

// ── 第 2 步：建裸连接，逐帧记录 ───────────────────────────────────────
log('');
log('【2/2】建立裸 WebSocket 并逐帧记录 …');
const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  log('✅ WS 握手完成 (open 事件触发)');
  lastFrameAt = Date.now();
});

ws.on('message', (data, isBinary) => {
  frameCount++;
  lastFrameAt = Date.now();
  const len = data.length ?? data.byteLength ?? 0;
  // 飞书长连接帧是 protobuf（二进制），取前 32 字节的十六进制指纹
  let head = '';
  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    head = buf.subarray(0, 32).toString('hex');
  } catch { head = '?'; }
  log(`📥 帧 #${frameCount}  len=${len}  binary=${isBinary}  head=${head}`);
  frames.push({ at: Date.now() - T0, len, head });
});

ws.on('ping', (d) => { frameCount++; lastFrameAt = Date.now(); log(`📥 PING  len=${d?.length ?? 0}`); });
ws.on('pong', (d) => { frameCount++; lastFrameAt = Date.now(); log(`📥 PONG  len=${d?.length ?? 0}`); });
ws.on('close', (code, reason) => log(`⚠ CLOSE code=${code} reason=${reason?.toString?.() ?? ''}`));
ws.on('error', (e) => log(`✗ ERROR ${e.message}`));
ws.on('unexpected-response', (_r, r) => log(`✗ unexpected-response status=${r.statusCode}`));

// ── 心跳看门狗：每 15s 报告静默时长 ──────────────────────────────────
let t = 0;
const timer = setInterval(() => {
  t += 15;
  const silent = ((Date.now() - lastFrameAt) / 1000).toFixed(1);
  const alive = ws.readyState === WebSocket.OPEN;
  log(`── [${t}s/${DURATION}s] readyState=${alive ? 'OPEN' : ws.readyState} 累计帧=${frameCount} 静默=${silent}s`);
  if (t >= DURATION) {
    clearInterval(timer);
    log('');
    log('='.repeat(74));
    log('取证结论');
    log('='.repeat(74));
    log(`  监听时长        : ${DURATION}s`);
    log(`  收到原始帧总数  : ${frameCount}`);
    log(`  其中事件帧      : ${eventFrameCount}`);
    log(`  最终静默时长    : ${((Date.now() - lastFrameAt) / 1000).toFixed(1)}s`);
    log(`  服务端心跳要求  : ${CC.PingInterval}s`);
    log('');
    if (frameCount === 0) {
      log('  ❌ 判定：握手成功后【一个帧都没有】');
      log('     → 飞书长连接前端未向本条会话派发任何数据，会话未被真正登记');
      log('     → 病灶在【控制台订阅登记】或【该连接未被识别为本应用的活跃客户端】');
      log('     → 与 scope / 应用发布 / 收信权限无关（已逐项排除）');
    } else if ((Date.now() - lastFrameAt) / 1000 > CC.PingInterval * 2.5) {
      log('  ⚠ 判定：曾有帧但心跳已停滞超过 2.5 倍心跳间隔');
      log('     → 会话疑似被静默丢弃，SDK 的存活看门狗需要复核');
    } else {
      log('  ✅ 判定：心跳正常，连接是【活会话】');
      log('     → 那问题就纯粹是「事件没被推送」，回到控制台订阅内容核对');
    }
    log('='.repeat(74));
    try { ws.close(); } catch {}
    process.exit(0);
  }
}, 15000);

process.on('SIGINT', () => { log('\nCtrl-C 退出'); try { ws.close(); } catch {} process.exit(0); });
