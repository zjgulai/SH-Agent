/**
 * model_side_taxonomy.test.mjs —— **模型侧 A3 归类**的判据（2026-10-19）
 *
 * ## 为什么要有它
 * Owner 原话：「守衡回复未归类问题 5 个，为什么没有归类，实际打开审查报告，里面都归类了」
 *       「**模型侧也需要归类，跟知识库侧一样**」
 *
 * 病灶不是渲染：12 类（`taxonomy_category`）原先是**规则层**的分类，模型侧条目不是规则
 * ⇒ 模型侧从来没有这一格 ⇒ 卡上永远落「未归类」，而报告逐条标签又印着 A1/类目名，两边对不上。
 * 现在模型侧也要给出 `taxonomy_category`（12 类闭集）＋ `taxonomy_subcategory`（该类下的 58 子类之一）。
 *
 * ## 四条判据（后三条都是**反向对照**：宽松照抄必须变红）
 *  ① 合法组合 ⇒ 两格都落下来；
 *  ② **自造类名**（不在 12 类里）⇒ 类置 null（渲染层落「未归类」），原话留在 `taxonomy_asked`；
 *  ③ **跨类子类**（子类不属于所选类别）⇒ 子类置 null（不许拼出一个「合规-母乳储存」）；
 *  ④ `未归类` ＋ 任意子类 ⇒ 子类置 null（兜底类没有子类）。
 *
 * 跑法：`node --test agent/model_side_taxonomy.test.mjs`
 */
import test from 'node:test';
import assert from 'node:assert';
import { parseFindings, TAXONOMY_CLASSES, TAXONOMY_SUBCLASSES } from './model_side.mjs';

/** 造一条最小可解析的输出（其余字段给足，免得被别的校验丢掉）。 */
const row = (tax, sub) => JSON.stringify([{
  location: '第 1 段', category: '合规', severity: 'REVIEW',
  description: '正文写「最好」', reason: '绝对化用语', excerpt: '最好',
  suggestion: '改成具体描述',
  ...(tax === undefined ? {} : { taxonomy_category: tax }),
  ...(sub === undefined ? {} : { taxonomy_subcategory: sub }),
}]);
const parse1 = (tax, sub) => {
  const r = parseFindings(row(tax, sub));
  assert.strictEqual(r.ok, true, `解析失败：${r.error}`);
  assert.strictEqual(r.findings.length, 1, `被丢了：${JSON.stringify(r.dropped)}`);
  return r.findings[0];
};

test('① 合法类别 + 该类的合法子类 ⇒ 两格都落下来', () => {
  const f = parse1('合规与受监管宣称', '绝对化与最高级用语');
  assert.strictEqual(f.taxonomyCategory, '合规与受监管宣称');
  assert.strictEqual(f.taxonomySubcategory, '绝对化与最高级用语');
});

test('② 反向对照：自造类名 ⇒ 类置 null，且原话留在 taxonomy_asked', () => {
  const f = parse1('绝对化与安全承诺', '');          // A1 词表的名字，不是 12 类
  assert.strictEqual(f.taxonomyCategory, null);
  assert.strictEqual(f.taxonomy_asked, '绝对化与安全承诺');
});

test('③ 反向对照：跨类子类 ⇒ 子类置 null（类别照留）', () => {
  // 「母乳储存」属于「母婴知识内容准确性」，不属于「合规与受监管宣称」
  const f = parse1('合规与受监管宣称', '母乳储存');
  assert.strictEqual(f.taxonomyCategory, '合规与受监管宣称');
  assert.strictEqual(f.taxonomySubcategory, null);
});

test('④ 反向对照：兜底类 `未归类` 不带子类', () => {
  const f = parse1('未归类', '绝对化与最高级用语');
  assert.strictEqual(f.taxonomyCategory, '未归类');
  assert.strictEqual(f.taxonomySubcategory, null);
});

test('⑤ 闭集自洽：58 个子类全部挂在 11 个实有类下（`未归类` 无子类）', () => {
  assert.strictEqual(TAXONOMY_CLASSES.length, 12);
  const total = Object.entries(TAXONOMY_SUBCLASSES)
    .reduce((n, [, v]) => n + v.length, 0);
  assert.strictEqual(total, 58);
  assert.deepStrictEqual(TAXONOMY_SUBCLASSES['未归类'], []);
  for (const c of TAXONOMY_CLASSES) {
    assert.ok(Array.isArray(TAXONOMY_SUBCLASSES[c]), `12 类里的「${c}」没有子类清单一栏`);
  }
});
