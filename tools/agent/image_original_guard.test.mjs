/**
 * 2026-11-03（Owner 批准 A/B）的回归样本 —— 两件线上真发生过的事：
 *
 *  ① 群内 post 送图时，原图**没落到本机**（`fetchImageForLink` 静默失败），
 *     链带着空 `--image` 起跑 ⇒ review_run.sh 图身份层 fail-closed（`image_source_missing`）
 *     ⇒ 兜成「审查未完成」。用户以为「审了但没审完」，实际是「图都没拿到」。
 *     ⇒ 现在：取不到原图**不起链**，当场说「没拿到原图 + 原因」。
 *
 *  ② 报告的主张声明表**某一行少了几格**时，`cells[table.content].trim()` 抛
 *     `Cannot read properties of undefined (reading 'trim')`，整条链 146 秒后崩掉。
 *     ⇒ 现在：缺格记错误、退回主键之后那段，**是判定不是崩溃**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let agent = null;
try { agent = await import('./agent.mjs'); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const { parseClaimDeclarations } = await import('./image_claim_declarations.mjs');

function stubs(overrides = {}) {
  const calls = { chain: 0 };
  return {
    calls,
    deps: {
      notify: async () => {},
      chainRunner: async () => { calls.chain += 1; return { answer: '不该跑到的回答' }; },
      modelSideRunner: async () => ({ ok: true, findings: [], dropped: [] }),
      publish: async () => ({ ok: true, action: 'skipped', detail: '自证桩' }),
      merged: async () => ({ ok: true, url: 'https://example.invalid/docx/STUB', detail: '自证桩' }),
      advice: async () => ({ ok: true, ms: 1, advice: {} }),
      mediaLinks: async () => [],
      mediaUpload: async () => ({ ok: false, reason: '自证桩：不真上传' }),
      fetchImage: async () => null,
      ...overrides,
    },
  };
}

test('A1 取不到原图 ⇒ 不起链，回「没拿到原图」+ 具体原因，而不是「审查未完成」', async () => {
  assert.equal(typeof agent?.runSubmissionGate, 'function', 'runSubmissionGate 没导出');
  const { calls, deps } = stubs();
  const inbound = {
    text: '审一下这张图', imageCount: 1, videoCount: 0,
    images: [{ index: 1, msgId: 'om_stub_message', imageKey: 'img_stub_key' }],
  };
  const result = await agent.runSubmissionGate({
    inbound, question: inbound.text, userText: inbound.text, force: false,
    chainRunner: deps.chainRunner,
    modelSideRunner: deps.modelSideRunner,
    publishRunner: deps.publish,
    mergedReportRunner: deps.merged,
    adviceRunner: deps.advice,
    mediaLinksRunner: deps.mediaLinks,
    mediaUpload: deps.mediaUpload,
    fetchVideoForLink: async () => null,
    fetchImageForLink: async () => ({ path: null, bytes: 0, error: '自证桩：403 Forbidden' }),
    imageClaimRunner: async () => ({ ok: true, missing: [] }),
  });
  assert.equal(calls.chain, 0, '拿不到原图却起了链 —— 又会兜成「审查未完成」');
  assert.equal(result.chainRan, false);
  assert.match(result.forcedReply ?? '', /没拿到原图/, '没有说清「拿不到原图」');
  assert.match(result.forcedReply ?? '', /403/, '原因没带出来（用户无法据此处理）');
  assert.doesNotMatch(result.forcedReply ?? '', /审查未完成/, '又回到了「审查未完成」这句');
});

test('A2 反向对照：取到原图时照旧起链（判据不能把正常单一起拦掉）', async () => {
  const { calls, deps } = stubs();
  const inbound = {
    text: '审一下这张图', imageCount: 1, videoCount: 0,
    images: [{ index: 1, msgId: 'om_stub_message', imageKey: 'img_stub_key' }],
  };
  let gotPaths = null;
  const result = await agent.runSubmissionGate({
    inbound, question: inbound.text, userText: inbound.text, force: false,
    chainRunner: async (task) => { calls.chain += 1; gotPaths = task; return { answer: '【审查结论：PASS】无问题。' }; },
    modelSideRunner: deps.modelSideRunner,
    publishRunner: deps.publish,
    mergedReportRunner: deps.merged,
    adviceRunner: deps.advice,
    mediaLinksRunner: deps.mediaLinks,
    mediaUpload: deps.mediaUpload,
    fetchVideoForLink: async () => null,
    fetchImageForLink: async (_id, _key, { dir }) => {
      const fs = await import('node:fs');
      const p = `${dir}/self-test.png`;
      fs.writeFileSync(p, 'stub');
      return { path: p, bytes: 4 };
    },
    imageClaimRunner: async () => ({ ok: true, missing: [] }),
  });
  assert.equal(calls.chain, 1, '原图取到了却被拦下 —— 判据把正常单也拦了');
  assert.ok(Array.isArray(gotPaths?.imagePaths) && gotPaths.imagePaths.length === 1,
    `链入参没带上原图路径：${JSON.stringify(gotPaths?.imagePaths ?? null)}`);
  assert.equal(result.chainRan, true);
});

test('B1 主张声明表缺格不再崩（线上 146 秒 TypeError 的那个形状）', () => {
  const ragged = [
    '| 编号 | 主张 | 来源 |',
    '|---|---|---|',
    '| C1 | 白色产品 | 画面 |',
    '| C2 |',                      // ← 少两格：原先 `cells[content].trim()` 直接抛 TypeError
  ].join('\n');
  const r = parseClaimDeclarations(ragged);
  assert.equal(r.ok, false, '缺格应当判不合格');
  assert.match(r.errors.join(' '), /缺「主张」列|单元格数量不完整/, '没有点名缺格');
  assert.deepEqual(r.ids.includes('C1'), true);
});

test('B2 反向对照：表头完整、每行格数对齐时照旧全绿', () => {
  const good = '| 编号 | 主张 | 来源 |\n|---|---|---|\n| C1 | 白色产品 | 画面 |\n| C2 | 容量 5 盎司 | 画面 |';
  const r = parseClaimDeclarations(good);
  assert.equal(r.ok, true, r.errors.join('；'));
  assert.deepEqual(r.ids, ['C1', 'C2']);
});

// ── C 组：报告章节标题带括注时必须认得（2026-11-03 16:17 线上那张图的真因之一）
//    `## 四、4A 规则符合性（知识库链路）` 的括注让切分器判「这不是标题」⇒
//    写了 11 条逐主张判断的 4A 被读成空 ⇒ 整单「审查未完成」。
test('C1 4A 标题带括注仍要被认成章节（否则整节被判空）', async () => {
  const { checkImageWorkflowEvidence } = await import('./image_workflow_evidence.mjs');
  const text = [
    '## 四、4A 规则符合性（知识库链路）',
    '**引擎结论**：`state=REVIEW`、`issue_count=0`，逐主张判断如下。',
    '| 主张 | 判断 | 说明 |',
    '|---|---|---|',
    '| C1 | 库侧无覆盖 | 库内没有对应条款 |',
  ].join('\n');
  const r = checkImageWorkflowEvidence(text, { sources: [] });
  assert.equal(r.stages.rules.present, true, '带括注的 4A 标题没被认成章节');
  assert.ok(r.stages.rules.body.includes('库侧无覆盖'), '4A 正文没被收进来');
  assert.ok(!r.missing.some((m) => m.startsWith('4A')), `4A 仍被判缺失：${r.missing.join('；')}`);
});

test('C2 反向对照：正文里顺口提一句「4A 规则符合性」不算章节', async () => {
  const { checkImageWorkflowEvidence } = await import('./image_workflow_evidence.mjs');
  const text = [
    '## 三、主张拆分与核查清单',
    '| 编号 | 主张 |',
    '|---|---|',
    '| C1 | 白色产品 |',
    '4A 规则符合性这一节这次没写。',
  ].join('\n');
  const r = checkImageWorkflowEvidence(text, { sources: [] });
  assert.equal(r.stages.rules.present, false, '一句顺口提的话被当成 4A 章节了（判据被改松）');
});
