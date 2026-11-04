#!/usr/bin/env node
/**
 * secret_path.test.mjs —— 「凭据路径一律不许读」这条约束的**执行点**。
 *
 * ── 为什么要有它（`AGENTS.md` §2.4：写进文档的约束必须指得出哪一行在拦它）
 *
 * 2026-09-22，守衡对外说过一句话：
 *   「我读得到那个凭据文件但不输出其内容 —— **这是策略边界，不是能力边界**。」
 * 诚实，也正是问题：白名单放行 `cat`，`cat ~/.dsh/credentials/*.json`
 * **没有任何一行代码在拦**。这句话之前是一条**声明**，不是一条**约束**。
 *
 * ── 它验四件事，缺一件这条约束就还是半条
 *
 *   A. **判据本身**（纯函数）：指得出对象的路径必须命中；仓内正常文件必须不命中。
 *   B. **四条读取通道各自被采过**：`read_text_file` / `list_files` /
 *      `search_workspace` / `run_readonly_command` —— 一条活着**不给另一条作证**
 *      （§2.4.1 第 4 行）。实测结论：三个已被 `REPO_ROOT` 前缀断言挡住，
 *      真正需要这道闸门的只有 `run_readonly_command` 一条 —— 而这句话
 *      **是采出来的，不是读代码读出来的**。
 *   C. **反向对照**（§2.1.1：会误报的检查器比没有检查器更糟）：
 *      ① 仓内正常路径必须**照读不误**；② 那条**已知的误报陷阱**
 *      `research/governance/_evidence/R2/_tools/pylibs/pycparser/ply/ctokens.py`
 *      （含 `token`）必须**不被拦** —— 第一版判据就是模糊匹配 `token`，被它否掉的。
 *   D. **正样本**：白名单内、不涉凭据的普通命令必须仍然跑得通
 *      （否则这道闸门把守衡的日常读能力一起关了）。
 *
 * 全部离线、不联网、**不读任何真凭据**：只断言「拒绝」这个动作，
 * 从不断言凭据内容（跑这个测试的人也不该看到它）。
 *
 * 用法：node tools/agent/secret_path.test.mjs
 * 退出码：0 全过 ｜ 1 有红
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { REPO_ROOT } from './config.mjs';
import { secretPathHit, executeTool, toolNames } from './tools.mjs';

const res = [];
const T = (name, ok, detail) => res.push({ name, ok, detail });
const HOME = os.homedir();

const CRED = path.join(HOME, '.dsh', 'credentials', 'shouheng-lark.json');
const CRED2 = path.join(HOME, '.dsh', 'credentials', 'tencent-cloud-zhoujian-secretkey.csv');
const YAML = path.join(HOME, '.dsh', '.credentials.yaml');

/* ── A 判据本身（纯函数）──────────────────────────────────────────────── */
T('A1 飞书应用密钥 → 命中', secretPathHit(CRED) !== null, String(secretPathHit(CRED)));
T('A2 腾讯云密钥 → 命中', secretPathHit(CRED2) !== null, String(secretPathHit(CRED2)));
T('A3 DSH 凭据 yaml → 命中', secretPathHit(YAML) !== null, String(secretPathHit(YAML)));
T('A4 `~` 写法 → 命中', secretPathHit('~/.dsh/credentials/x.json') !== null, '');
T('A5 **凭据目录本身**（ls 它）→ 命中', secretPathHit('~/.dsh/credentials') !== null, '');
T('A6 `..` 绕行 → 命中',
  secretPathHit(path.join(HOME, '.dsh', 'credentials', '..', 'credentials', 'x.json')) !== null, '');
T('A7 通配符 `~/.dsh/cred*/*` → 命中（静态前缀也算）',
  secretPathHit('~/.dsh/cred*/*') !== null, '');
T('A8 `~/.ssh/id_rsa` → 命中', secretPathHit('~/.ssh/id_rsa') !== null, '');
T('A9 仓内一条真文件 → **不**命中', secretPathHit('PMO/守衡-架构说明.md') === null, '');
T('A10 工作区内的相对路径 → **不**命中', secretPathHit('./tools/agent/tools.mjs') === null, '');

/* ── C② 已知的误报陷阱：模糊匹配 `token` 就会在这里红 ──────────────────── */
const CTOKENS = 'research/governance/_evidence/R2/_tools/pylibs/pycparser/ply/ctokens.py';
T('C2 ★ pycparser 的 `ctokens.py`（含 token）→ **不许**命中（第一版判据死在这）',
  secretPathHit(CTOKENS) === null, String(secretPathHit(CTOKENS)));
T('C3 ★ 仓内一批 `.env.example`（是样例不是凭据）→ **不许**命中',
  secretPathHit('research/repos/contract_audit/.env.example') === null, '');
T('C4 ★ 但**真** `.env` → 必须命中（按文件名拦）',
  secretPathHit('research/governance/_evidence/R3/repos/Piccolo/.env') !== null, '');

/* ── B 四条通道各采一遍：谁拒绝、谁放行 ───────────────────────────────── */
const call = async (name, args) => {
  try {
    const r = await executeTool(name, args);
    return r.ok ? r.result : { error: r.error };   // 工具内部返回的 { error } 也是拒绝
  } catch (e) { return { error: String(e?.message ?? e) }; }
};
const isRejected = (r) => !!r && (r.status === 'rejected' || typeof r.error === 'string');

const rRead = await call('read_text_file', { rel_path: '../../.dsh/credentials/shouheng-lark.json' });
T('B1 read_text_file 读仓外凭据 → 拒', isRejected(rRead), JSON.stringify(rRead).slice(0, 120));

const rList = await call('list_files', { pattern: 'json', sub_dir: '../../.dsh/credentials' });
T('B2 list_files 列仓外凭据目录 → 拒', isRejected(rList), JSON.stringify(rList).slice(0, 120));

const rSearch = await call('search_workspace', { keyword: 'wbk_', sub_dir: '../../.dsh/credentials' });
T('B3 search_workspace 搜仓外凭据目录 → 拒', isRejected(rSearch), JSON.stringify(rSearch).slice(0, 120));

const rCmd = await call('run_readonly_command', { command: `cat ${CRED}` });
T('B4 ★ run_readonly_command `cat <凭据>` → 拒（这道闸门真正要拦的那一条）',
  isRejected(rCmd) && /凭据/.test(String(rCmd.error ?? '')), String(rCmd.error ?? '').slice(0, 140));

/* ── B 的变体：换几条命令形状，别只证一种写法 ─────────────────────────── */
for (const [i, cmd] of [
  `head -5 ${CRED}`,
  `ls ${path.dirname(CRED)}`,
  `wc -l ${CRED2}`,
  `grep -rn key ${path.dirname(CRED)}`,
  'cat ~/.dsh/.credentials.yaml',
  'cat ~/.dsh/cred*/*',
  'find ~/.ssh -maxdepth 2 -name id_rsa',
].entries()) {
  const r = await call('run_readonly_command', { command: cmd });
  T(`B5.${i + 1} 换一种写法也拦得住：\`${cmd.replace(HOME, '~')}\``,
    isRejected(r) && /凭据/.test(String(r.error ?? '')), String(r.error ?? '').slice(0, 100));
}

/* ── C① / D 反向对照：不涉凭据的东西必须**照旧能用** ───────────────────── */
const rOk = await call('run_readonly_command', { command: 'ls tools/agent' });
T('C1 ★ 反向对照：仓内普通命令必须**照常执行**（否则闸门把日常读能力一起关了）',
  rOk?.status === 'ok' && String(rOk.stdout ?? '').includes('tools.mjs'), JSON.stringify(rOk).slice(0, 120));

const rReadOk = await call('read_text_file', { rel_path: 'tools/agent/tools.mjs', max_bytes: 200 });
T('C5 ★ 反向对照：仓内普通文件必须**照常读**',
  typeof rReadOk?.content === 'string' && rReadOk.content.length > 0, JSON.stringify(rReadOk).slice(0, 100));

const rCt = await call('run_readonly_command', { command: `head -2 ${CTOKENS}` });
T('C6 ★ 反向对照：`ctokens.py` 必须**照常读**（它就是那个误报陷阱）',
  rCt?.status === 'ok', JSON.stringify(rCt).slice(0, 120));

/* ── 出口 ───────────────────────────────────────────────────────────── */
const nFail = res.filter((x) => !x.ok).length;
for (const x of res) console.log(`  ${x.ok ? '✅' : '❌'} ${x.name}${x.ok || !x.detail ? '' : `  ← ${x.detail}`}`);
console.log(`\n${nFail ? '❌' : '✅'} secret_path 自证 ${res.length - nFail}/${res.length} 项通过`);
console.log(`   （工具层共 ${toolNames().length} 个工具；本测试只碰读通道，不写任何文件）`);
process.exit(nFail ? 1 : 0);
