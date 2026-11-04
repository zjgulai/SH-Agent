# 内容合规审查 · 操作规程（skill v1）

> 用途：**任何 agent（或人）按这一页就能调起一次内容合规审查**，不需要先读代码。
> 交付物是「一次判定 + 一份回执」，不是「能不能投」的结论。
>
> 自证：`python3 tools/verify_skill.py` —— 本文件里每一条 bash 命令都会被真的跑一遍。
> **规程里的命令跑不动，这一页就是装饰。**

---

## 一、什么时候用它

| 场景 | 用 |
|---|---|
| 发布前文字要过本地规则判定 | ✅ `judge`；它给规则命中与处置层，不等于飞书完整审核结论 |
| 飞书群里要对文字、图片、链接走完整预审 | ✅ 先按 `agent-skills/飞书内容审核工作流/SKILL.md` 路由，再由 `kb_review_chain` 完成审核 |
| 想知道「这条文字命中了哪些规则、落在哪一层、谁终结」 | ✅ |
| 想知道「这条文案能不能投」 | ❌ 见 §六 |
| 想了解飞书问答怎么和送审分流 | ✅ 见 `agent-skills/飞书内容审核工作流/SKILL.md` |
| 依赖本地文字引擎判图片或链接页面 | ❌ 本文件的 `judge` 只判传入文本；图片/链接走完整审核链 |

---

## 二、30 秒版

```bash
# ① 任意文案 → 判定（含边界声明与回执），人读得懂的形态
python3 base/judge_adapter.py --from-text "医院级吸奶器，母乳量提升300%，IBCLC 推荐"

# ② 同一件事的机器可读形态
python3 base/judge_adapter.py --from-text "医院级吸奶器" --json

# ③ 用存量语料里的一条：外部广告ID（291 条广告明细）
python3 base/judge_adapter.py --from-record GG-9994d5764db8 --json

# ④ 用落载体里的一条：落地页 url_key（204 个 URL）
python3 base/judge_adapter.py --from-url-key au.momcozy.com/pages/brand-new-wellness-1-warm-massage-breast-pump --json
```

**输入永远先变成 `ContentUnit`，再进 `judge(unit)`。** 不要绕过这一层直接调引擎 ——
绕过之后判定的边界声明会按「文本载体」写死，而你的输入可能不是文本。

---

## 三、判定的契约（`judge-unit-v1`）

顶层键固定为：`contract_version` · `input` · `verdict` · `hits` · `suggestion` ·
`versions` · `boundary_statement` · `receipt` · `unit`。

读一份判定时，按这个顺序看：

| 看什么 | 字段 | 为什么先看它 |
|---|---|---|
| 覆盖到没有 | `boundary_statement.coverage` | `hit` / `no_hit` / `catch_all` 三者含义完全不同 |
| 它自己承认判断不了什么 | `boundary_statement.unknowns` | **不允许为空**（ADR-0005 约束 1） |
| 谁终结 | `verdict.layer.id`（DP0–DP4）+ `can_finalize` | 见 §四 |
| 命中什么 | `verdict.rule_keys_hit` / `rules_hit` | `rule_key` 是稳定标识，`U01` 是遗留编号 |
| 边界被改过没有 | `boundary_statement.$corrections` | 订正**留痕而不静默** |
| 这次判定发生过没有 | `receipt` | ADR-0005 约束 5：**没有回执的判定不算发生过** |

---

## 四、四层处置：谁可以终结

| 层 | 谁 | 机器能终结吗 |
|---|---|---|
| `DP0` | 不进入审查（无文案 / 路由不成立） | 是 |
| `DP1` | 退回提交人（机器说「未发现拦截理由」，**不是**「通过」） | 是 |
| `DP2` | 机器独立拦截（`auto_reject`，实测 precision 0.970） | 是 |
| `DP3` | 人工复核 | 否 |
| `DP4` | 法务终审 | 否 |

`verdict.layer.machine_may_finalize=false` 时，**这条判定的结论不是结论，是一次转交**。
把它当成通过，等于替人过门（ADR-0005）。

---

## 五、失败形态：什么情况下这份判定不可信

这些不是免责声明，是**已知的、可复算的**限制。判定里都能看到：

1. **`coverage=catch_all`** —— 没命中任何规则不等于合规。存量语料里 54.6% 落在这里。
   「未覆盖」与「已检查且合规」是完全不同的两件事。
2. **品线维度尚未启用** —— 24 条规则里没有一条声明 `product_lines`，
   传入 `--product-line` 目前**不产生任何过滤**。这是「支持但你还没填」。
3. **语境守卫 85 条声明、46 条接线**，39 条未接线不会产生降级 ——
   同一个句式可能因为一个词没接线而从「降级」变成「红线」。
4. **判定只看文本**：图片、视频、A+ 详情页不在输入内（`not_covered_carriers`）。
5. **只在吸奶器上被验证过**：291 条存量里 289 条是该品线。
6. **有 59 条广告根本没有文案可查**（`Primary Text` / `Headline` / 落地页 URL 三者
   全空，Google PLA/PMax 为主），其中 55 条在源表里标着「合规·绿 / 无需处理」，
   合计投放 $15,747（占全部 $43,061 的 36.6%）。它们不是「已检查且合规」，
   是「没有东西可查」〔缺口:D9〕—— 见 `research/governance/端到端送审-演练报告.md`。

**读判定的人如果不知道第 1 条，会把「没查出来」读成「没问题」。**

---

## 六、明确不做

- **不给「能不能投」的结论。** 给的是规则命中 + 处置层 + 边界。
- **不替人过门**：`machine_may_finalize=false` 的层不产生终局结论。
- **不让业务在卡片里直接改规则**：规则变更必须有单一权威实现。
- **不把判定当训练数据**：回执不落原文（见 §七）。

---

## 七、回执：判定发生过就要留痕

```bash
# 演练：origin=test 会被**拒绝**写入生产账本（退出码非 0），这是有意的
cd research/governance/skeleton && python3 judge.py --text "演练文案" --receipt --origin test   # expect: fail
```

> 上面这条命令**预期失败**。账本里混进测试记录之后，没有任何字段能让下游把它认出来
> —— 所以宁可拒绝，也不写一条「看起来像真判定」的记录。演练请在自己的程序里
> 显式传 `receipt_path=<临时文件>`。

---

## 八、收工前跑一遍（全绿才算这次审查的基座是好的）

```bash
python3 base/verify_base.py
python3 tools/verify_engine_contract.py
python3 tools/verify_kb.py
python3 research/governance/audit_risk_label.py --check
```

最后一条守的是**源表口径**：它比对 `skeleton/_data/风险等级-还原.json` 与
`源表口径-风险等级-变更请求.md` 的生成块是否还对着当前语料。源表一改而不重算，
它红 —— 否则那份「157 条绿标真实构成」的账会静默变成一串没人知道过期了的数字。

---

## 九、这一页自己会不会腐烂

会 —— 所以每条命令都由 `python3 tools/verify_skill.py` 真的跑一遍：
命令必须退出码 0（§七那条必须非 0），且输出里必须出现本页承诺的字段。
**改了命令不改这页，或者改了这页不改命令，检查都会红。**

---

## 十、飞书工作流和业务状态

本文件里的 DP0–DP4 是本地判定引擎的处置层。飞书面向业务的结果状态是 PASS / SUGGEST / REVIEW / BLOCK；两者不能互相替代。纯文字机制问答走问答分支，不把问题本身判成素材。文字、图片与链接的入口、素材提取、审核链和失败回报统一见 `agent-skills/飞书内容审核工作流/SKILL.md`。

本地 `judge` 命中或未命中都不能独立证明完整内容审核已完成。素材不可读、证据不足、链未运行或结果为空时，必须保留未测/阻塞状态，不得写成 PASS。
