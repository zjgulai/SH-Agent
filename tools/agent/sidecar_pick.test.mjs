#!/usr/bin/env node
/**
 * sidecar_pick.test.mjs —— 旁挂「按单挑」的判据（同群并行 · 第 1 批）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 它守的是什么（一句话）
 * ══════════════════════════════════════════════════════════════════════════
 * 知识库那条链的输出是**两个固定单文件**（`kb/.work/last_review_result.json` /
 * `last_engine_out.json`），每条链跑完**整份覆盖**。两条链并行时，后写的盖掉先写的
 * ⇒ 守衡这边读到别人的读数 ⇒ 「四把锁」拒收 ⇒ **本单降级**（图片单直接 NEEDS_INPUT）。
 *
 * 第 1 批的修法分两半，缺一半都不成立：
 *   ① 写侧（`kb/l8/review_run.sh` 的 `mirror_sidecar`）：**原文件照旧写**，另存一份
 *      `kb/.work/sidecars/<标签>-<BASE>-<pid>.json`（判据在那边：跑一次链看目录）；
 *   ② 读侧（本文件守的）：**先扫副本、固定文件兜底**，判据仍是同一个 `identityVerdict`。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 硬约束：**单条跑时读到的内容必须与改动前逐字相同**
 * ══════════════════════════════════════════════════════════════════════════
 * 副本是固定文件的字节副本 ⇒ 两份都能过同一套锁 ⇒ 谁先命中都不影响返回内容。
 * 反过来也必须验：**「扫到副本」不许变成「放宽判据」** —— 所以下面有一组
 * 「指纹相符但不新鲜」的反向对照：它必须照样被拒（那正是 10-15 串单的形状）。
 *
 * 跑法：`node tools/agent/sidecar_pick.test.mjs`
 *   （与 `tools/agent/*.test.mjs` 同风格：独立可跑，不依赖网络、不写任何真实产物）
 */
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  pickOwnSidecar, listSidecarFiles, SIDECAR_SCAN_LIMIT,
} from './tools.mjs';

let pass = 0;
let fail = 0;
let skip = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name}\n       ${e?.message ?? e}`); }
};

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const FRESH = iso(60_000);            // 1 分钟前：算新鲜
const STALE = iso(3 * 3600_000);      // 3 小时前：不新鲜
const SINCE = NOW - 5 * 60_000;       // 本单起链时刻（5 分钟前）

/* 三份「真实形状」的旁挂（字段名逐字取自 kb/.work/last_review_result.json） */
const MINE = { at: FRESH, base: '20261022-1013', text_sha8: 'aaaa1111',
  review_token: '/tmp/shouheng-material-aaaa1111-x.txt', content_id: 'AD-1', state: 'REVIEW' };
const OTHERS = { at: FRESH, base: '20261022-1012', text_sha8: 'bbbb2222',
  review_token: '/tmp/shouheng-material-bbbb2222-y.txt', content_id: 'AD-2', state: 'PASS' };
const MINE_BUT_OLD = { at: STALE, base: '20261020-0900', text_sha8: 'aaaa1111',
  review_token: '/tmp/shouheng-material-aaaa1111-x.txt', content_id: 'AD-1' };

const WANT = { sinceMs: SINCE, token: MINE.review_token, sha8: MINE.text_sha8, cid: MINE.content_id };

console.log('═══ 1. 挑「本单那份」═══');

await t('1a 副本里有两份（他单在前、本单在后）⇒ 必须挑到本单那份，而不是第一份', () => {
  const pick = pickOwnSidecar([
    { source: 'sidecars/review-20261022-1012-111.json', j: OTHERS },
    { source: 'sidecars/review-20261022-1013-222.json', j: MINE },
  ], WANT);
  assert.ok(pick.hit, '两份里有一份是本单的，却一份都没挑到');
  assert.strictEqual(pick.hit.j.base, '20261022-1013', `挑到了别人的那份（base=${pick.hit.j.base}）`);
  assert.strictEqual(pick.level, '令牌', '应该靠令牌那把锁认下来');
});

await t('1b 固定文件兜底：副本目录为空时，靠 `last_review_result.json` 认下来（改动前的老路）', () => {
  const pick = pickOwnSidecar([
    { source: 'last_review_result.json', j: MINE },
  ], WANT);
  assert.ok(pick.hit, '固定文件明明是本单的，却没认下来 —— 老路被改坏了');
  assert.strictEqual(pick.hit.source, 'last_review_result.json');
});

await t('1c 只有他单 ⇒ 必须一份都不收（hit:null），且给出原因', () => {
  const pick = pickOwnSidecar([
    { source: 'sidecars/review-20261022-1012-111.json', j: OTHERS },
    { source: 'last_review_result.json', j: OTHERS },
  ], WANT);
  assert.strictEqual(pick.hit, null, '他单的读数被当成本单的了 —— 这就是串单');
  assert.strictEqual(pick.rejects.length, 2, `拒收原因条数不对（${pick.rejects.length}）`);
  assert.ok(/四把锁全不成立/.test(pick.rejects[0].why), `原因不像话：${pick.rejects[0].why}`);
});

await t('1d 空候选 ⇒ hit:null（不是抛异常）', () => {
  const pick = pickOwnSidecar([], WANT);
  assert.strictEqual(pick.hit, null);
  assert.deepStrictEqual(pick.rejects, []);
});

console.log('═══ 2. 反向对照：扫到副本不许变成放宽判据 ═══');

await t('2a 指纹相符但**不新鲜** ⇒ 必须照拒（# 10-15 串单的形状：内容对、时间不对）', () => {
  const pick = pickOwnSidecar([
    { source: 'sidecars/review-20261020-0900-333.json', j: MINE_BUT_OLD },
  ], WANT);
  assert.strictEqual(pick.hit, null, '陈旧的本单读数被收了 —— 「新鲜」这把锁被放宽了');
  assert.ok(/不新鲜/.test(pick.rejects[0].why), `原因不对：${pick.rejects[0].why}`);
});

await t('2b 陈旧的那份在前、新鲜的那份在后 ⇒ 必须跳过陈旧的挑新鲜的（不是「第一份达标就收」）', () => {
  const pick = pickOwnSidecar([
    { source: 'sidecars/review-20261020-0900-333.json', j: MINE_BUT_OLD },
    { source: 'sidecars/review-20261022-1013-222.json', j: MINE },
  ], WANT);
  assert.ok(pick.hit, '新鲜的那份没挑到');
  assert.strictEqual(pick.hit.source, 'sidecars/review-20261022-1013-222.json');
});

await t('2c 坏副本（不是对象）⇒ 跳过它，不影响后面的候选', () => {
  const pick = pickOwnSidecar([
    { source: 'sidecars/review-broken-1.json', j: 'not-an-object' },
    { source: 'last_review_result.json', j: MINE },
  ], WANT);
  assert.ok(pick.hit, '坏副本把后面的好候选挡住了');
  assert.strictEqual(pick.hit.source, 'last_review_result.json');
});

console.log('═══ 3. 单条等价（本次改动的硬约束）═══');

await t('3a 同一份内容，当「副本」与当「固定文件」返回的对象逐字相同', () => {
  const asMirror = pickOwnSidecar([{ source: 'sidecars/review-20261022-1013-222.json', j: MINE }], WANT);
  const asFixed = pickOwnSidecar([{ source: 'last_review_result.json', j: MINE }], WANT);
  assert.ok(asMirror.hit && asFixed.hit);
  assert.strictEqual(JSON.stringify(asMirror.hit.j), JSON.stringify(asFixed.hit.j),
    '同一份字节，两条路读出来的对象不一样 —— 「单条行为不变」不成立');
});

console.log('═══ 4. 两种形状（旁挂 / 引擎 JSON）各验一次 ═══');

await t('4a 引擎 JSON 形状（content_version 全值 + content_id）必须认下来', () => {
  const full = 'f'.repeat(64);
  const gotOf = (jj) => {
    const dec = (jj && typeof jj.decision === 'object') ? jj.decision : {};
    return {
      full: dec?.content_version ?? jj?.content_version ?? (jj?.input_manifest?.sha256) ?? '',
      cid: dec?.content_id ?? jj?.content_id,
    };
  };
  const pick = pickOwnSidecar([
    { source: 'sidecars/engine-20261022-1013-222.json', mtimeMs: NOW - 60_000,
      j: { decision: { content_version: full, content_id: 'AD-1' } } },
  ], { sinceMs: SINCE, full, cid: 'AD-1', gotOf });
  assert.ok(pick.hit, '引擎 JSON 形状没认下来 —— 那这一单的逐条依据会退回从回答里抠');
});

await t('4b 引擎 JSON 没有 `at` 字段 ⇒ 用文件 mtime 当新鲜度（与改动前同一口径）', () => {
  const full = 'e'.repeat(64);
  const gotOf = (jj) => ({ full: jj?.content_version ?? '', cid: jj?.content_id });
  // mtime 很早 ⇒ 必须拒（证明「mtime 口径」确实在起作用，不是恒真）
  const stalePick = pickOwnSidecar([
    { source: 'sidecars/engine-old.json', mtimeMs: NOW - 3 * 3600_000,
      j: { content_version: full, content_id: 'AD-1' } },
  ], { sinceMs: SINCE, full, cid: 'AD-1', gotOf });
  assert.strictEqual(stalePick.hit, null, 'mtime 很旧却收了 —— 新鲜度判据没接上');
  // 同一份内容，mtime 新 ⇒ 必须收（反向对照）
  const freshPick = pickOwnSidecar([
    { source: 'sidecars/engine-new.json', mtimeMs: NOW - 60_000,
      j: { content_version: full, content_id: 'AD-1' } },
  ], { sinceMs: SINCE, full, cid: 'AD-1', gotOf });
  assert.ok(freshPick.hit, 'mtime 新鲜却没收到 —— 反向对照失败（说明拒收不是「新鲜度」拦的）');
});

console.log('═══ 5. 目录扫描（真读盘，用临时目录）═══');

await t('5a 只取 `<prefix>-*.json`，按 mtime 倒序，limit 生效', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shouheng-sidecar-scan-'));
  try {
    const mk = (name, ageMs) => {
      const f = path.join(dir, name);
      fs.writeFileSync(f, '{}');
      const when = new Date(NOW - ageMs);
      fs.utimesSync(f, when, when);
      return f;
    };
    mk('review-oldest.json', 300_000);
    mk('review-newest.json', 10_000);
    mk('review-middle.json', 100_000);
    mk('engine-ignore.json', 5_000);        // 前缀不对：不许进来
    mk('review-notjson.txt', 1_000);        // 扩展名不对：不许进来
    const got = listSidecarFiles(dir, 'review');
    assert.deepStrictEqual(got.map((x) => x.name),
      ['review-newest.json', 'review-middle.json', 'review-oldest.json'],
      `扫描结果不对：${got.map((x) => x.name).join(', ')}`);
    const limited = listSidecarFiles(dir, 'review', 1);
    assert.strictEqual(limited.length, 1);
    assert.strictEqual(limited[0].name, 'review-newest.json', 'limit 没取到最新的那个');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await t('5b 目录不存在 ⇒ 空数组（旧库没这个目录时，行为必须与改动前一致）', () => {
  assert.deepStrictEqual(listSidecarFiles('/nonexistent-sidecars-dir-xyz', 'review'), []);
});

await t('5c 默认上限是个正整数（`SIDECAR_SCAN_LIMIT` 被改坏会变成「全读」）', () => {
  assert.ok(Number.isInteger(SIDECAR_SCAN_LIMIT) && SIDECAR_SCAN_LIMIT > 0 && SIDECAR_SCAN_LIMIT <= 200,
    `SIDECAR_SCAN_LIMIT=${SIDECAR_SCAN_LIMIT} —— 要么不是整数，要么大得没有意义`);
});

console.log('═══ 6. 接线（知识库仓那三处写入点）═══');

await t('6a `review_run.sh` 的三个输出写入点都真的调了 `mirror_sidecar`（不是只定义了）', () => {
  const KB = process.env.SHOUHENG_KB_ROOT
    || '/Users/lute/Documents/skill-test/执行skills/执行skills/skills-回归测试/知识库/内容治理';
  const f = path.join(KB, 'kb/l8/review_run.sh');
  if (!fs.existsSync(f)) {
    // ★ 取不到就说**未测**，不许当成通过（AGENTS.md §2.4.1 旁边那条纪律）
    skip++;
    console.log('       ⚠ 未测：本机没有知识库仓（路径不存在）—— 这一项「没跑」，不是「过了」');
    return;
  }
  const s = fs.readFileSync(f, 'utf8');
  const calls = (s.match(/^\s*mirror_sidecar\s+"/gm) || []).length;
  assert.ok(calls >= 3,
    `mirror_sidecar 只被调用 ${calls} 次 —— 三个写入点（拒答旁挂 / 正常旁挂 / 引擎 JSON）一个都不能少`);
  assert.ok(/mirror_sidecar\(\)\s*\{/.test(s), '函数定义不在：那就只剩调用，运行时 command not found');
  assert.ok(/SIDECAR_KEEP=\d+/.test(s), '清理上限不在 —— 副本目录会无限增长');
  // 反向对照：副本名必须带 pid（同一分钟两单 BASE 相同，只靠 BASE 会互相覆盖）
  assert.ok(/\$\$\.json/.test(s), '副本名里没有 pid —— 同一分钟两单会写同一个文件名，等于没修');
});

console.log(`\n═══ 合计：通过 ${pass} / 失败 ${fail}${skip ? ` / 未测 ${skip}` : ''} ═══`);
process.exit(fail ? 1 : 0);
