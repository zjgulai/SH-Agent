#!/usr/bin/env node
/**
 * check_scene_stability.mjs —— **画面读数的稳定性判据**（2026-10-21）
 *
 * ## 为什么有它（病灶，实测）
 *   同一张母婴插画，两次画面读数**物品栏不一样**：
 *     10:46 → 「床头柜上的圆柱形小设备、浅绿色保温杯/水壶、**白色小瓶**、白色平板状设备」
 *     11:18 → 「带护栏的木制婴儿床、床铺、枕头、被子、小盆栽」   ← 床头柜那几样整个没了
 *   ⇒ 下游写「读不到」是诚实的，但**用户看到的结果就是"没审到"**。
 *   读数时有时无 = 这条视觉链路**不可用**，而此前没有任何东西会红。
 *
 * ## 判据（只判"稳不稳"，不判"对不对"）
 *   同一张图连读 `--runs` 次（默认 5），每一次都必须至少出现 **1 个容器类物件**
 *   （瓶/杯/罐/盒/壶…）。任意一次没有 ⇒ 判不可用（退出码 1），并打印每次的物品栏。
 *   ⚠️ 它**不判**"有没有倒着放" —— 那是读数模型的能力问题；本件只回答
 *      「这条读数链路稳不稳、能不能拿来当视觉源」。
 *
 * ## 用法
 *   node tools/check_scene_stability.mjs --image <图> [--runs 5] [--json]
 *
 * 退出码：0 每次都见到容器 ｜ 1 有缺失（读数不可靠）｜ 2 用法/环境错
 * 成本：每次一个视觉请求（真打网络）。默认 5 次，别在回归里跑它。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sceneRead } from './agent/scene.mjs';

const CONTAINER_RE = /瓶|杯|罐|盒|壶|容器|器皿/;

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const flag = (name) => process.argv.includes(`--${name}`);

async function main() {
  const src = arg('image');
  const runs = Number(arg('runs', '5'));
  if (!src) { console.error('用法：node tools/check_scene_stability.mjs --image <图> [--runs 5] [--json]'); return 2; }
  if (!fs.existsSync(src)) { console.error(`图不存在：${src}`); return 2; }

  // 画面层只读临时目录里的图（scene.mjs 的 assertTempPath 守着这条）⇒ 先拷到 /tmp
  const tmp = path.join(os.tmpdir(), `scene-stability-${Date.now()}${path.extname(src) || '.img'}`);
  fs.copyFileSync(src, tmp);
  if (!/^\/tmp\//.test(tmp) && !tmp.startsWith(path.resolve(os.tmpdir()))) {
    // macOS 上 os.tmpdir() 是 /var/folders/...（drwx------）；assertTempPath 认它，这里只做提示
  }

  const rows = [];
  for (let i = 1; i <= runs; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await sceneRead(tmp);
    const products = r?.ok ? (r.scene?.products ?? []) : [];
    const containers = products.filter((p) => CONTAINER_RE.test(String(p.what ?? '')));
    rows.push({
      run: i, ok: !!r?.ok, ms: r?.ms ?? null, error: r?.error ?? null,
      products: products.map((p) => p.what),
      containers: containers.map((p) => `${p.what}${p.orientation && p.orientation !== '未给' ? `(${p.orientation})` : ''}`),
    });
  }
  try { fs.unlinkSync(tmp); } catch { /* 删不掉无妨 */ }

  const missing = rows.filter((r) => r.ok && r.containers.length === 0);
  const errored = rows.filter((r) => !r.ok);
  const stable = missing.length === 0 && errored.length === 0;

  if (flag('json')) {
    console.log(JSON.stringify({ image: src, runs, stable, rows }, null, 1));
  } else {
    for (const r of rows) {
      console.log(`${r.ok ? '·' : '✗'} 第 ${r.run} 次：容器 ${r.containers.length} 个${r.containers.length ? `（${r.containers.join('、')}）` : ''}`
        + `${r.ok ? '' : `｜读数失败：${r.error}`}`);
      if (r.products.length) console.log(`     物品：${r.products.join('、')}`);
    }
    console.log(stable
      ? `✅ 稳定：${runs} 次都读到了容器类物件`
      : `❌ 不可用：${missing.length} 次没读到容器${errored.length ? `，${errored.length} 次读数失败` : ''} —— 这条链路不能当视觉源`);
  }
  return stable ? 0 : 1;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(String(e?.stack ?? e)); process.exit(2); });
