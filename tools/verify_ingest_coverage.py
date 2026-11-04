#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verify_ingest_coverage.py —— **改了东西，落库了吗**（AGENTS.md §2.1 那条规矩的读数）。

    python3 tools/verify_ingest_coverage.py            # 报告（恒退 0）
    python3 tools/verify_ingest_coverage.py --strict    # 有未覆盖就退 1
    python3 tools/verify_ingest_coverage.py --hours 72  # 看更长的窗口

── 它治的是哪一件事（Owner 2026-10-16 原话）

    「你的修复验证后要落库，不要我每次提醒」—— 此前那条规矩只活在对话里，
    于是**每一条都要人再说一次**。本仓对这类事情的既有结论很硬：
    **散文没有失败信号；判据才有**（见 §2.4 那一串变体）。
    所以这条规矩的落点有两半：AGENTS.md §2.1 写着它，**这里是它的读数**。

── 口径（宁可吵一声，不可漏一个；但也**不许把噪声当红**）

    · **左边**：「今天动过的 PMO 留底件」= `PMO/*.md`（只看顶层，不看 `state/` `logs/` 子目录）
      里 mtime 落在窗口内的。
    · **右边**：「今天入库的条目」= 知识库账本 `_meta/ledger.ndjson` 里
      `action=ingest` 且 `ts` 落在窗口内的行，取它们的 `source_ref`。
    · **判据**：成功账本对应的条目必须真实可读、在索引里、来源指纹相符，
      然后检查每个左边文件是否被这些有效条目的 source/provenance/正文引用。
    · **时不取 UTC 日历**：账本写的是 UTC，人在东八区 —— 用 UTC 会把**早上 8 点前**
      的入库记到"昨天"（本仓栽过一次同日不同日的坑，见 §2.4.3 那个 `--today`）。

── 边界（**这是读数，不是闸门**；理由要说清）

    一个 PMO 文件今天被动过，**不等于**它必须有一条 KB 条目：
    索引件（`已修问题索引.md`）、规程件、以及只是被追加了一行的台账，
    都不该逼着人入库。所以默认**恒退 0**，把差距**摆出来**让人 5 秒判断；
    要它当闸门用（CI）再加 `--strict`。

    ⚠️ 账本不能代替条目。直接追加 action=ingest/stage=ok 而没有实际条目，
    不计覆盖；历史不符记录单独展示，不删除账本，也不冒充今天的实际入库。
"""

import argparse
import datetime as dt
import json
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PMO = REPO / 'PMO'
#: 知识库账本（`kb` 是指向权威库的软链；`view/_meta` 是宿主这一侧读得到的那一份）
LEDGER = Path(os.path.expanduser('~/.dsh/Momcozy知识库/kb/view/_meta/ledger.ndjson'))
BEIJING = dt.timezone(dt.timedelta(hours=8))


def readable_entries(view):
    """Read actual KB entries through its native parser; a ledger is not evidence of existence."""
    script = r'''
import {pathToFileURL} from 'node:url';
import os from 'node:os';
import path from 'node:path';
const kb = await import(pathToFileURL(path.join(os.homedir(), '.dsh/plugins/dsh-kb/lib/kb.js')));
const root = process.argv[1];
const manifest = kb.readManifest(root);
if (!manifest || manifest.__parseError) throw new Error('KB manifest unreadable');
const entries = {};
for (const e of kb.loadAll(root)) {
  if (!e.meta?.id || e.meta.__parseError) continue;
  const m = manifest.entries[e.meta.id];
  entries[e.meta.id] = {source:e.meta.source, body:e.body, provenance:e.meta.provenance,
    manifest_ok:!!m && m.file === e.file && m.bhash === kb.bodyHash(e.body)};
}
process.stdout.write(JSON.stringify(entries));
'''
    result = subprocess.run(['node', '--input-type=module', '-e', script, str(view)],
                            capture_output=True, text=True, timeout=30, check=True)
    return json.loads(result.stdout)


def verified_ingest(record, entries):
    """Success requires readable, indexed entries with the recorded source fingerprint."""
    ids = record.get('targets')
    if (record.get('action') != 'ingest' or record.get('stage') != 'ok'
            or not isinstance(ids, list) or not ids or not record.get('source_fingerprint')):
        return False
    for entry_id in ids:
        entry = entries.get(entry_id) or {}
        source = entry.get('source') or {}
        if (not entry.get('manifest_ok') or not str(entry.get('body') or '').strip()
                or source.get('ref') != record.get('source_ref')
                or source.get('fingerprint') != record.get('source_fingerprint')):
            return False
    return True

#: 不要求入库的（索引/台账/规程这一类的落点）—— **逐个点名，不用模糊匹配**（§2.6 第 3 条同一条纪律）
SKIP_NAMES = {
    '已修问题索引.md',
    '守衡-回复卡片模版与语域规程.md',
    '填充态-环境特性-实测史.md',      # §2.1 搬过去的那一份，早就在册
}


def beijing_day(ts_iso):
    """账本里的 `ts` 是 UTC ISO；返回**北京日历日**。读不出回 None（不猜）。"""
    try:
        t = dt.datetime.fromisoformat(str(ts_iso).replace('Z', '+00:00'))
    except Exception:
        return None
    return t.astimezone(BEIJING).date()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--hours', type=float, default=24.0)
    ap.add_argument('--strict', action='store_true')
    a = ap.parse_args()

    now = dt.datetime.now(dt.timezone.utc)
    since = now - dt.timedelta(hours=a.hours)

    # ── 右边：窗口内的入库（**只认 action=ingest**；被拒的不算）
    ingests, rejected = [], 0
    if not LEDGER.exists():
        print(f'⚠️ 读不到账本：{LEDGER} —— **未测**（不是"都覆盖了"）')
        return 2
    for line in LEDGER.read_text(encoding='utf-8').splitlines():
        if not line.strip():
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        t = None
        try:
            t = dt.datetime.fromisoformat(str(d.get('ts', '')).replace('Z', '+00:00'))
        except Exception:
            pass
        if not t or t < since:
            continue
        if d.get('action') == 'ingest':
            ingests.append(d)
        else:
            rejected += 1
    try:
        entries = readable_entries(LEDGER.parent.parent)
    except Exception as exc:
        print(f'⚠️ 知识库实际条目回读失败 —— 未测：{exc}')
        return 2
    verified = [x for x in ingests if verified_ingest(x, entries)]
    invalid = [x for x in ingests if not verified_ingest(x, entries)]
    refs = {str(x.get('source_ref') or '') for x in verified}

    # ── 右边之二：**条目正文里点到它**也算覆盖
    #   为什么需要这一条（2026-10-16 首次运行就撞上）：像 `守衡-误答登记-*.md` 这种**登记件**，
    #   它自己是别的条目的**锚点**（`provenance.anchor` 指回它），而账本只记 `source_ref`
    #   ⇒ 只看账本会把一个**已经被引用**的文件报成未覆盖 —— **误报比不报更糟**（§2.1.1）。
    # Only actual, indexed entries from verified ingests may provide secondary anchors.
    # Scanning every markdown file lets backups and unregistered files fake coverage.
    entry_texts = [entries[i]['body'] + '\n' + json.dumps(entries[i].get('provenance') or {}, ensure_ascii=False)
                   for item in verified for i in item['targets']]
    mentioned = '\n'.join(entry_texts)

    # ── 左边：窗口内动过的 PMO 留底件
    touched = []
    for p in sorted(PMO.glob('*.md')):
        if p.name in SKIP_NAMES:
            continue
        m = dt.datetime.fromtimestamp(p.stat().st_mtime, dt.timezone.utc)
        if m >= since:
            touched.append((p, m))

    print(f'窗口：最近 {a.hours:g} 小时（{since.astimezone(BEIJING):%Y-%m-%d %H:%M} 起，北京时间）')
    print(f'账本：{LEDGER}')
    print(f'  实际入库 **{len(verified)}** 条｜账本声称成功但回读不符 {len(invalid)} 行｜被拒 {rejected} 行｜动过的留底件 **{len(touched)}** 个\n')
    for item in invalid:
        print(f"  ⚠️ 入库记录回读不符：{item.get('targets')}（条目、索引或来源指纹不一致）")

    covered, missing = [], []
    for p, m in touched:
        hit = next((r for r in refs if r and str(p) == r), None)
        if not hit and p.name in mentioned:
            hit = '（被窗口内的条目正文/锚点引用）'
        (covered if hit else missing).append((p, m, hit))

    for p, m, _ in covered:
        print(f'  ✅ {p.name}  ←  {m.astimezone(BEIJING):%m-%d %H:%M}')
    for p, m, _ in missing:
        print(f'  ⚠️ {p.name}  ←  {m.astimezone(BEIJING):%m-%d %H:%M}  **窗口内没有条目指向它**')

    if not touched:
        print('  （窗口内没有动过留底件）')
    if missing:
        print(f'\n⚠️ {len(missing)} 个留底件在窗口内没有对应条目 —— '
              f'要么补 `kb_ingest`，要么它本来就不需要入库（索引/规程/台账）。')
        print('   ★ 这是**读数**不是判决：本脚本默认恒退 0，`--strict` 才把它当闸门。')
    if ingests and not touched:
        print('\n（有入库、没有动过留底件 —— 那是对的：条目也可以只引代码与实测。）')

    # This command gates PMO coverage, not the whole historical ledger. A valid
    # corrective entry may cover a file whose earlier success record was false.
    return 1 if (a.strict and missing) else 0


if __name__ == '__main__':
    sys.exit(main())
