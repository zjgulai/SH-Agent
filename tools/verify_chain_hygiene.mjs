#!/usr/bin/env node
/**
 * verify_chain_hygiene.mjs —— **审查链「慢」的机器判据**（2026-10-26 立）
 *
 * ── 为什么要有它 ─────────────────────────────────────────────────────────
 * 2026-10-26 Owner 报「10/21、10/22 审图 5 分钟出结论，现在 10 多分钟」。拆开三段量：
 *
 *   | 日期   | 单数 | 总时长中位 | ① 链前 | ② 知识库 | ③ 链后 |
 *   | 10-22  |  17  |  4.0 min   | 0.8    | 0.4      | 2.9    |
 *   | 10-23  |   4  |  5.1 min   | 1.1    | 0.3      | 3.7    |
 *   | 10-26  |   3  | 13.0 min   | 3.2    | 0.4      | 8.0    |
 *
 * ⇒ **知识库那一段三天恒定 0.4 min（四层前置实测 24 秒）**，慢的是链自己。
 *   再读链的转写（`~/.dsh/sessions/…/session.jsonl.zstd`）：10-22 的图片链是
 *   「skill×5 + bash 2–12 次、最多 24 步」；10-26 有 3 条链到了 **48–67 步 / bash 49–61 次**，
 *   它们在做三件不该它做的事（逐条都有实测代价，见 tools.mjs 的「禁止越权」）：
 *     ① 自造 `.mjs` / `.swift` 脚本重跑画面与 OCR（5 个脚本，≈6 min）；
 *     ② 链返回后又用 `lark-cli` 去写飞书表（11 次，≈4 min）——
 *        而 `review_run.sh` 的输出里逐字写着「你不要再写一次飞书表」；
 *     ③ 同一单起**两次**链（91 s）。
 *
 * ── 为什么不是「看提示词里有没有那句话」 ──────────────────────────────────
 *   提示词里早就写过「不得重复起链」，它照样起了第二次。**名字出现过 ≠ 它拦得住**。
 *   所以这把尺子不看代码、不看提示词，**只读链自己的行为记录**：调了几次工具、
 *   有没有 `lark-cli` 写、有没有自造脚本、`review_run.sh` 起了几次。
 *
 * ── 口径（照实写，别外推）────────────────────────────────────────────────
 *   · **只判「切点之后」开始的链**（切点 = `tools/agent/tools.mjs` 的 mtime，即提示词生效时刻）。
 *     切点之前的链**只报基线、不判红** —— 否则一装就是一片红，红的意义就没了。
 *   · 阈值来自实测分布，不是拍的：10-22 的 30 条图片链最多 **28 次工具 / 12 次 bash**；
 *     10-26 的三条病链是 **65–67 次工具 / 49–61 次 bash**。取 35 / 25 把两边分开。
 *   · `lark-cli` 只把**写**算红线（`+record-update` / `+record-batch-update` / `docs +update` …）；
 *     读（`+record-get` / `+field-list`）只报数不判红 —— 读一次不慢，也不越权。
 *   · 自造脚本只认**写到 /tmp、/private/tmp 的 `.mjs` / `.swift` / `.py`**：
 *     这是「重跑画面/OCR」的形状；`cat > kb/...` 之类不算。
 *
 * 用法：
 *   node tools/verify_chain_hygiene.mjs            # 判切点之后的链；红了退 3
 *   node tools/verify_chain_hygiene.mjs --all      # 连基线一起判（诊断用，会红）
 *   node tools/verify_chain_hygiene.mjs --selftest # 反向对照：喂合成分辨好坏样本
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/* ── 阈值（出处见文件头实测分布）────────────────────────────────────── */
export const LIMITS = { tools: 35, bash: 25, reviewRuns: 1 };

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 解出一个会话的全部记录。
 *
 * ⚠️ 这个文件是**多帧 zstd 拼接**（实测 1.0 MB / 2504 帧）。
 *   `zstdDecompressSync(整块)` 与 `createZstdDecompress()` **都只解第一帧**
 *   —— 只拿到一条 `{"type":"session"}`，看着像「会话是空的」。
 *   所以按帧头魔数逐个解、再按内容去重（重叠扫描会重复解出同一帧）。
 */
export function decodeSession(file) {
  const buf = fs.readFileSync(file);
  const seen = new Set();
  const recs = [];
  let off = 0;
  for (;;) {
    const i = buf.indexOf(MAGIC, off);
    if (i < 0) break;
    off = i + 4;
    let out;
    try { out = zlib.zstdDecompressSync(buf.subarray(i)); } catch { continue; }
    for (const line of out.toString('utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const h = `${t.length}:${t.slice(0, 80)}`;
      if (seen.has(h)) continue;
      seen.add(h);
      recs.push(t);
    }
  }
  return recs.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

const WRITE_TOKENS = ['+record-update', '+record-batch-update', '+record-create',
  'docs +update', 'docs +create', '+record-upsert'];
const LARK_TOKENS = ['lark-cli'];
// 只认**写**：`cat > /tmp/x.mjs`、`tee`、`>>`、`printf … > `/tmp/x.swift`。
// ⚠️ 不能只匹配「命令里出现了 /tmp/xxx.mjs」—— 实测会误报：好链也会 `ls /tmp`、`cat /tmp/x.mjs`
//   去**看**（aab94695 只跑 2.0 min、21 次工具，却被记成「自造脚本 4 次」）。
//   误报比漏报更坏：它会让「红」失去意义，真问题混在噪声里。
const SELF_SCRIPT_RE = /(?:>>?|tee\s+-a?|\bcat\s*>)\s*\/?(?:private\/)?tmp\/[\w.\-/]+\.(?:mjs|js|swift|py)\b/;
// 起链次数：任何 `review_run.sh` 的非 `--help` 调用都算一次（不带 `--base` 也算）。
const REVIEW_RUN_RE = /review_run\.sh(?!\s+--help)/;

/** 从一条 `tool/call` 里取出人类可读的「它在干什么」。 */
function callText(rec) {
  const d = rec?.data ?? {};
  let a = {};
  try { a = JSON.parse(d.arguments || '{}'); } catch { /* 非 JSON 参数：按原样看 */ }
  return String(a.command || a.file_path || a.pattern || a.name || d.arguments || '');
}

/**
 * **纯函数**：把一份会话记录压成「这单干了什么」。
 * 抽成纯函数是为了能被 `--selftest` 用合成样本反复喂（不碰任何真链会话）。
 */
export function classify(recs) {
  const calls = recs.filter((r) => r?.type === 'tool/call');
  const byName = {};
  for (const c of calls) {
    const n = c?.data?.name ?? '?';
    byName[n] = (byName[n] ?? 0) + 1;
  }
  const texts = calls.map(callText);
  const bashTexts = calls.filter((c) => c?.data?.name === 'bash').map(callText);

  const larkWrites = bashTexts.filter((t) => LARK_TOKENS.some((k) => t.includes(k))
    && WRITE_TOKENS.some((k) => t.includes(k)));
  const larkReads = bashTexts.filter((t) => LARK_TOKENS.some((k) => t.includes(k)))
    .filter((t) => !WRITE_TOKENS.some((k) => t.includes(k)));
  const selfScripts = texts.filter((t) => SELF_SCRIPT_RE.test(t));
  const reviewRuns = bashTexts.filter((t) => REVIEW_RUN_RE.test(t)).length;

  const first = (recs.filter((r) => r?.type === 'user/message')
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))[0]?.data?.content ?? [])
    .map((c) => c?.text ?? '').join('');
  const isImageChain = first.includes('本单是图片单');

  const times = recs.map((r) => r?.time).filter((v) => typeof v === 'number');
  const minutes = times.length > 1
    ? (Math.max(...times) - Math.min(...times)) / 60000 : null;

  // ★ 正向读数（2026-10-26 Owner：「你的修复不能影响知识库的工作流，完整执行图片审查 skill，
  //   包括视觉分析与 OCR、L4–L7 层 skill 运行」）—— **只拦「做太多」是不够的**：
  //   「禁止越权」有可能被读成「少做检查」，做残了没有任何东西会红。
  //   所以同一把尺子要有正面：真加载 skill、真看图、真跑且只跑一次链。
  const skillsLoaded = byName.skill ?? 0;
  const imagesRead = byName.read_image ?? 0;

  return {
    isImageChain, minutes, tools: calls.length, bash: byName.bash ?? 0, byName,
    larkWrites: larkWrites.length, larkReads: larkReads.length,
    selfScripts: selfScripts.length, reviewRuns,
    skillsLoaded, imagesRead,
  };
}

/** 一条链的判决：`ok` / `bad`（附原因）。阈值见 LIMITS。 */
export function judge(m) {
  const why = [];
  if (m.tools > LIMITS.tools) why.push(`工具 ${m.tools} 次 > ${LIMITS.tools}`);
  if (m.bash > LIMITS.bash) why.push(`bash ${m.bash} 次 > ${LIMITS.bash}`);
  if (m.larkWrites > 0) why.push(`越权写飞书 ${m.larkWrites} 次`);
  if (m.selfScripts > 0) why.push(`自造脚本 ${m.selfScripts} 次（重跑画面/OCR）`);
  if (m.reviewRuns > LIMITS.reviewRuns) why.push(`起链 ${m.reviewRuns} 次 > ${LIMITS.reviewRuns}`);
  // ── 正向：这几样**必须有**，缺了就是把流程做残（不是「省了时间」）──────────────
  //   `review_run.sh` 一次就把 L4→L5→L6→L7 四层前置 ＋ 引擎 ＋ 发布全跑完 ⇒ 它跑 0 次
  //   等于**层 skill 一次都没跑**；`read_image` 0 次等于**没看过图**就说图没问题。
  if (m.reviewRuns < 1) why.push('链跑 0 次（L4–L7 层前置与引擎都没跑）');
  if (m.skillsLoaded < 1) why.push('一次 skill 都没加载（判定主体未加载）');
  if (m.isImageChain && m.imagesRead < 1) why.push('图单却 0 次 read_image（视觉分析缺失）');
  return { ok: why.length === 0, why };
}

/* ── 扫会话 ──────────────────────────────────────────────────────────── */
const SESSION_ROOT = path.join(os.homedir(), '.dsh', 'sessions');
const TOOLS_MTIME = (() => {
  try { return fs.statSync(new URL('./agent/tools.mjs', import.meta.url)).mtimeMs; }
  catch { return 0; }
})();

export function* sessionFiles(root = SESSION_ROOT) {
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return; }
  for (const d of dirs) {
    // 只扫**知识库工作目录**那一族会话：链的 cwd 就是 KB_ROOT。
    if (!d.includes('~5185~5BB9~6CBB~7406')) continue;   // = 「内容治理」的转义
    const base = path.join(root, d);
    let subs = [];
    try { subs = fs.readdirSync(base); } catch { continue; }
    for (const s of subs) {
      if (!s.startsWith('session-')) continue;
      const sessionDir = path.join(base, s);
      try {
        // 迁移后旧文件可能仍在；每个会话只选最高版本，不能漏 v4 或重复计数。
        const files = fs.readdirSync(sessionDir).flatMap((name) => {
          const match = /^session(?:\.v(\d+))?\.jsonl\.zstd$/.exec(name);
          const file = path.join(sessionDir, name);
          return match && fs.statSync(file).isFile() ? [{ file, version: Number(match[1] || 0) }] : [];
        }).sort((a, b) => b.version - a.version);
        if (files.length) yield files[0].file;
      } catch { /* 没转写就不算一条链 */ }
    }
  }
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return selftest();

  const all = argv.includes('--all');
  const rows = [];
  for (const f of sessionFiles()) {
    let recs;
    try { recs = decodeSession(f); } catch { continue; }
    const m = classify(recs);
    if (!m.isImageChain) continue;                      // 只判图片链（这次的问题面）
    // 切点按**会话开始**判，不按文件 mtime：mtime 是「写到最后一条」的时刻，
    // 用它会把「切点前开始、切点后写完」的链误判成「切点之后」（实测 1ec32e1e 就差点被误判）。
    const times = recs.map((r) => r?.time).filter((v) => typeof v === 'number');
    const startedAt = times.length ? Math.min(...times) : 0;
    rows.push({ id: path.basename(path.dirname(f)).slice(8, 16), ...m,
      after: startedAt > TOOLS_MTIME });
  }

  const judged = all ? rows : rows.filter((r) => r.after);
  const base = rows.filter((r) => !r.after);

  console.log('审查链卫生体检 —— 只读链自己的行为记录（工具次数 / 越权 / 自造脚本 / 起链次数）');
  console.log(`  切点（tools.mjs 生效时刻）: ${new Date(TOOLS_MTIME).toLocaleString('zh-CN')}`);
  console.log(`  切点之后的图片链 ${judged.length} 条；切点之前（只报基线，不判红）${base.length} 条`);
  const stat = (v) => {
    const a = v.map((x) => x.tools).sort((x, y) => x - y);
    return a.length ? `工具中位 ${a[Math.floor(a.length / 2)]} 次，最多 ${a[a.length - 1]} 次` : '—';
  };
  console.log(`  基线：${stat(base)}`);
  console.log('');

  let red = 0;
  for (const r of judged) {
    const v = judge(r);
    if (!v.ok) red++;
    console.log(`  ${v.ok ? '✅' : '❌'} ${r.id}  ${r.minutes ? r.minutes.toFixed(1) + ' min' : '?'}`
      + ` 工具${r.tools} bash${r.bash} 起链${r.reviewRuns} 写飞书${r.larkWrites}`
      + ` 自造脚本${r.selfScripts} skill${r.skillsLoaded} 看图${r.imagesRead}`
      + (v.ok ? '' : `  ← ${v.why.join('；')}`));
  }
  if (!judged.length) {
    console.log('  （切点之后还没有新的图片链 —— **未测**，不是通过）');
    console.log('\n判据状态：未测');
    return 2;
  }
  console.log('');
  if (red) {
    console.log(`判据状态：有红（${red}/${judged.length} 条链在浪费）`);
    return 3;
  }
  console.log(`判据状态：全过（${judged.length} 条链，0 红）`);
  return 0;
}

/* ── 反向对照：合成样本，不碰任何真链 ────────────────────────────────── */
function selftest() {
  const mk = (cmds, prompt = '【★ 本单是图片单 —— 执行前置') => {
    const recs = [{
      type: 'user/message', seq: 1, time: 1000,
      data: { content: [{ type: 'text', text: prompt }] },
    }];
    cmds.forEach((c, i) => recs.push({
      type: 'tool/call', seq: 2 + i, time: 1000 + i * 1000,
      data: { name: c.startsWith('read_image:') ? 'read_image'
        : (c.startsWith('skill:') ? 'skill' : 'bash'),
        arguments: JSON.stringify(c.startsWith('read_image:') ? { file_path: c.slice(11) }
          : (c.startsWith('skill:') ? { name: c.slice(6) } : { command: c })) },
    }));
    return recs;
  };
  const cases = [
    ['好的链：skill＋看图＋起链 1 次＋不写飞书', mk([
      'skill:图片安全审查',
      'bash kb/l8/review_run.sh \\ --base x',
      'read_image:/tmp/a.jpg', 'cat kb/l7/reports/x.review.md',
      'echo done',
    ]), true],
    ['做残的链：一次链都没跑（L4–L7 缺失）', mk([
      'skill:图片安全审查', 'read_image:/tmp/a.jpg', 'echo 直接下结论',
    ]), false],
    ['做残的链：一次 skill 都没加载', mk([
      'bash kb/l8/review_run.sh \\ --base x', 'read_image:/tmp/a.jpg',
    ]), false],
    ['做残的链：图单一张图都没看', mk([
      'skill:图片安全审查', 'bash kb/l8/review_run.sh \\ --base x',
    ]), false],
    ['差的链：越权写飞书', mk([
      'bash kb/l8/review_run.sh \\ --base x',
      'export PATH=$HOME/.dsh/bin:$PATH; lark-cli base +record-batch-update --base-token X',
    ]), false],
    ['差的链：自造脚本重跑画面', mk([
      'bash kb/l8/review_run.sh \\ --base x',
      "cat > /private/tmp/posture_runs.mjs <<'EOF' ...",
    ]), false],
    ['差的链：起链两次', mk([
      'bash kb/l8/review_run.sh \\ --base x',
      'bash kb/l8/review_run.sh \\ --base y',
    ]), false],
    ['差一点的链：工具次数超阈（40 次）', mk([
      'bash kb/l8/review_run.sh \\ --base x',
      ...Array.from({ length: 39 }, (_, i) => `echo ${i}`),
    ]), false],
    // ⚠️ 这两条只测**一个轴**（误报轴），所以必须把正向前置配齐（skill＋看图＋起链）——
    //   否则它俩会被「缺 skill / 缺看图」判红，测的就不是它们本来要测的东西了。
    //   （这一版第一次跑就撞到了：两条自证自己红了，正好说明正向判据真的在生效。）
    ['只**读** /tmp 下的脚本不算红（ls/cat/node 执行都不算「自造」）', mk([
      'skill:图片安全审查', 'read_image:/tmp/a.jpg',
      'bash kb/l8/review_run.sh \\ --base x',
      'cat /private/tmp/scene_read.mjs; node /private/tmp/scene_run.mjs',
    ]), true],
    ['只读飞书**不算**红（+record-get）', mk([
      'skill:图片安全审查', 'read_image:/tmp/a.jpg',
      'bash kb/l8/review_run.sh \\ --base x',
      'lark-cli base +record-get --base-token X --record-id Y',
    ]), true],
  ];

  let bad = 0;
  const results = [];
  for (const [name, recs, wantOk] of cases) {
    const m = classify(recs);
    const v = judge(m);
    const ok = v.ok === wantOk;
    if (!ok) bad++;
    results.push([ok, name, v.ok ? 'ok' : v.why.join('；')]);
  }
  // 文件发现也是执行链的一部分：新版文件不能被扫漏，同一会话的迁移副本不能算两条。
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-hygiene-formats-'));
  try {
    const cwd = path.join(fixtureRoot, 'fixture-~5185~5BB9~6CBB~7406');
    const good = mk(['skill:图片安全审查', 'read_image:/tmp/a.jpg', 'bash kb/l8/review_run.sh --base x']);
    const write = (id, name, recs = good) => {
      const dir = path.join(cwd, id); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), Buffer.concat(recs.map((r) =>
        zlib.zstdCompressSync(Buffer.from(JSON.stringify(r) + '\n')))));
    };
    write('session-old', 'session.jsonl.zstd');
    write('session-new', 'session.v4.jsonl.zstd');
    write('session-both', 'session.jsonl.zstd', mk(['skill:图片安全审查']));
    write('session-both', 'session.v4.jsonl.zstd');
    const files = [...sessionFiles(fixtureRoot)];
    const found = files.map((f) => path.basename(path.dirname(f))).sort();
    const discoveryOk = JSON.stringify(found) === JSON.stringify(['session-both', 'session-new', 'session-old']);
    if (!discoveryOk) bad++;
    results.push([discoveryOk, '旧版与 v4 会话均发现，每个 session 只计一次', `发现 ${files.length} 条`]);
    const both = files.find((f) => path.basename(path.dirname(f)) === 'session-both');
    const latestOk = both && path.basename(both) === 'session.v4.jsonl.zstd' && judge(classify(decodeSession(both))).ok;
    if (!latestOk) bad++;
    results.push([!!latestOk, '迁移目录使用新版完整记录，不误读旧版残留', both ? path.basename(both) : '未找到']);
    const sample = path.join(cwd, 'session-new', 'session.v4.jsonl.zstd');
    const decoded = decodeSession(sample);
    const decodeOk = decoded.length === good.length && classify(decoded).tools === 3;
    if (!decodeOk) bad++;
    results.push([decodeOk, '多帧 zstd 解码不是只解第一帧', `合成 ${good.length} 帧，解出 ${decoded.length} 条记录`]);
  } finally { fs.rmSync(fixtureRoot, { recursive: true, force: true }); }

  console.log('反向对照（全合成样本，一条真链都没碰）');
  for (const [ok, name, detail] of results) console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? `  ← ${detail}` : ''}`);
  console.log('');
  console.log(bad ? `判据状态：有红（${bad} 条自证不成立）` : '判据状态：全过');
  return bad ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
