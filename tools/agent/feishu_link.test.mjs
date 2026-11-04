#!/usr/bin/env node
/**
 * feishu_link.test.mjs —— 「飞书链接怎么读」的离线自证
 *
 * 这条路的病灶与判据见 `feishu_link.mjs` 的文件头。这里只做离线反向对照：
 *   · 分流判据是纯函数 ⇒ 喂**像飞书的域名**（`feishu.cn.evil.com` / `notfeishu.cn`）必须不是飞书；
 *   · 读正文只走只读接口 ⇒ 桩里**任何 download / medias 路径**一旦出现，本文件必须红
 *     （红线 §2.6：附件不下载、不探测）；
 *   · 读不了时必须给出**分形态**的话（附件=红线 / 权限=可修），且都带 fail-closed 尾巴。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  classifyFeishuLink, isFeishuHost, readFeishuLink, readLink,
} from './feishu_link.mjs';

const cases = [];
const test = async (name, fn) => { await fn(); cases.push(name); console.log(`  ✅ ${name}`); };

/** 桩：按路径正则回包，并把**每一次**调用记下来（用来断言「一次都没碰下载」）。 */
function makeRequest(routes = []) {
  const calls = [];
  const request = async (path, opts = {}) => {
    calls.push({ path, method: opts.method ?? 'GET', data: opts.data });
    for (const [re, handler] of routes) if (re.test(path)) return handler(path, opts);
    return { code: 'stub_missing', msg: `测试桩没配这条路径：${path}`, data: {} };
  };
  return { request, calls };
}

/** 反向对照：**任何**下载/临时链接端点出现就算失败（红线是整个测试的公共护栏）。 */
function assertNoDownload(calls) {
  const bad = calls.filter((c) => /download|medias|permissions/i.test(c.path));
  assert.deepEqual(bad, [], `不许碰下载/临时链接/权限探测端点，实际调了：${JSON.stringify(bad)}`);
}

const DOCX = 'https://momcozy-in.feishu.cn/docx/Ybg1dZtoaoG5GKxLfREcHAK2nfs';
const SHEET = 'https://momcozy-in.feishu.cn/sheets/B1aUs2Vuah8YwjtwWO6cr5MFnUd';
const BASE = 'https://momcozy-in.feishu.cn/base/Lk3Qb8y2QaVyZns6gprcVNE9nA0';
const WIKI = 'https://momcozy-in.feishu.cn/wiki/A0fxdtmKxoQbmAxmpXVce7SVnEd';
const PPTX = 'https://momcozy-in.feishu.cn/file/IWbobAGHAoDcycxRFWNcBYd1nY6';

await test('分流判据：飞书域名的五种形态都认得出，且认得出 token', () => {
  const kinds = [
    [DOCX, 'docx', 'Ybg1dZtoaoG5GKxLfREcHAK2nfs'],
    [SHEET, 'sheet', 'B1aUs2Vuah8YwjtwWO6cr5MFnUd'],
    [BASE, 'bitable', 'Lk3Qb8y2QaVyZns6gprcVNE9nA0'],
    [WIKI, 'wiki', 'A0fxdtmKxoQbmAxmpXVce7SVnEd'],
    [PPTX, 'file', 'IWbobAGHAoDcycxRFWNcBYd1nY6'],
    [`${DOCX}?from=share`, 'docx', 'Ybg1dZtoaoG5GKxLfREcHAK2nfs'],
  ];
  for (const [url, kind, token] of kinds) {
    const c = classifyFeishuLink(url);
    assert.equal(c.isFeishu, true, `${url} 必须认成飞书链接`);
    assert.equal(c.kind, kind, `${url} 的形态应为 ${kind}，实际 ${c.kind}`);
    assert.equal(c.token, token, `${url} 的 token 应为 ${token}，实际 ${c.token}`);
  }
  // 飞书官方域名与 Lark 域名的**裸域**也算（租户域名都是子域，但别把裸域漏掉）
  assert.equal(isFeishuHost('feishu.cn'), true);
  assert.equal(isFeishuHost('open.larksuite.com'), true);
  // 认不出的飞书路径 ⇒ unknown（**不猜**，后面照实说读不了）
  assert.equal(classifyFeishuLink('https://momcozy-in.feishu.cn/foo/bar').kind, 'unknown');
  // 没 token 的文档路径 ⇒ token=null（不许拿路径当 token 去打接口）
  assert.equal(classifyFeishuLink('https://momcozy-in.feishu.cn/docx/').token, null);
});

await test('反向对照：长得像飞书的域名**不许**被当成飞书（否则等于自己开了个入口）', () => {
  for (const host of [
    'https://feishu.cn.evil.com/docx/ABC12345678',
    'https://notfeishu.cn/docx/ABC12345678',
    'https://feishu.cn.attacker.net/docx/ABC12345678',
    'https://evil.com/?next=https://momcozy-in.feishu.cn/docx/ABC12345678',
  ]) {
    assert.equal(classifyFeishuLink(host).isFeishu, false, `${host} 不许认成飞书链接`);
  }
  // 非 http(s) 一律 invalid（交给下游报「链接格式无效 / 仅支持 HTTP(S)」）
  for (const bad of ['file:///etc/passwd', 'ftp://example.com/x', 'not a url']) {
    assert.equal(classifyFeishuLink(bad).invalid, true, `${bad} 必须是 invalid`);
  }
  // 普通公网链接既不是飞书，也不是 invalid
  const pub = classifyFeishuLink('https://example.com/p/1');
  assert.equal(pub.isFeishu, false);
  assert.equal(pub.invalid, false);
});

await test('飞书文档（docx）：走只读正文接口，标题来自元数据，正文进审核链输入', async () => {
  const { request, calls } = makeRequest([
    [/metas\/batch_query/, () => ({ code: 0, data: { metas: [{ title: '红人 Brief' }] } })],
    [/docx\/v1\/documents\/Ybg1dZtoaoG5GKxLfREcHAK2nfs\/raw_content/,
      () => ({ code: 0, data: { content: '这是待审的 brief 正文。' } })],
  ]);
  const page = await readFeishuLink(DOCX, { request });
  assert.equal(page.text, '这是待审的 brief 正文。');
  assert.equal(page.title, '红人 Brief');
  assert.equal(page.contentType, 'feishu/docx');
  assertNoDownload(calls);
  assert.ok(calls.some((c) => /raw_content/.test(c.path)), '必须真的调了只读正文接口');
});

await test('知识库节点：先 get_node 再按 obj_type 取正文（wiki → docx）', async () => {
  const { request, calls } = makeRequest([
    [/wiki\/v2\/spaces\/get_node/, () => ({ code: 0, data: { node: { obj_type: 'docx', obj_token: 'OBJ12345678', title: '知识库里的那篇' } } })],
    [/docx\/v1\/documents\/OBJ12345678\/raw_content/, () => ({ code: 0, data: { content: '知识库正文' } })],
  ]);
  const page = await readFeishuLink(WIKI, { request });
  assert.equal(page.text, '知识库正文');
  assert.equal(page.title, '知识库里的那篇');
  assertNoDownload(calls);
});

await test('表格：工作表逐个读值，单元格拼成可审正文', async () => {
  const { request, calls } = makeRequest([
    [/sheets\/v3\/spreadsheets\/B1aUs2Vuah8YwjtwWO6cr5MFnUd\/sheets\/query/,
      () => ({ code: 0, data: { sheets: [{ sheet_id: 's1', title: 'Sheet1', grid_properties: { row_count: 2, column_count: 2 } }] } })],
    [/\/values\/s1!A1:B2/, () => ({ code: 0, data: { valueRange: { values: [['标题', '内容'], ['宣称', '帮助轻松喂养']] } } })],
  ]);
  const page = await readFeishuLink(SHEET, { request });
  assert.match(page.text, /标题 \| 内容/);
  assert.match(page.text, /宣称 \| 帮助轻松喂养/);
  assert.equal(page.contentType, 'feishu/sheet');
  assertNoDownload(calls);
});

await test('多维表格：表名与记录字段拼成可审正文', async () => {
  const { request, calls } = makeRequest([
    [/bitable\/v1\/apps\/Lk3Qb8y2QaVyZns6gprcVNE9nA0\/tables\?page_size=100/,
      () => ({ code: 0, data: { items: [{ table_id: 'tbl1', name: '合规表述' }] } })],
    [/tables\/tbl1\/records/, () => ({ code: 0, data: { items: [{ fields: { 名称: '防晒', 状态: [{ text: '已批准' }] } }] } })],
  ]);
  const page = await readFeishuLink(BASE, { request });
  assert.match(page.text, /数据表：合规表述/);
  assert.match(page.text, /名称：防晒/);
  assert.match(page.text, /状态：已批准/);
  assert.equal(page.contentType, 'feishu/bitable');
  assertNoDownload(calls);
});

await test('★ 云空间附件（这次那份 pptx）：按红线不取，话要说清原因与出路', async () => {
  const { request, calls } = makeRequest([
    [/metas\/batch_query/, () => ({ code: 0, data: { metas: [{ title: '【FINAL】Momcozy Wellness 1 红人Brief_职场妈妈版.pptx' }] } })],
  ]);
  let error = null;
  try { await readFeishuLink(PPTX, { request }); } catch (e) { error = e; }
  assert.ok(error, '附件必须读不了（读得了就说明红线破了）');
  assert.equal(error.name, 'FeishuLinkError');
  assert.equal(error.linkKind, 'file');
  assert.match(error.shouhengReply, /附件/, '必须说清这是附件');
  assert.match(error.shouhengReply, /按红线「飞书内容禁止下载」/, '必须说清是红线，不是权限/能力');
  assert.match(error.shouhengReply, /未读取到的内容不会判为通过/, '必须带 fail-closed 尾巴');
  assert.match(error.shouhengReply, /贴给我/, '必须给替代路径 —— 只说「读不了」等于没说');
  assert.doesNotMatch(error.shouhengReply, /域名解析到非公网地址/, '不许再拿 DNS 当原因（那是另一码事）');
  assert.match(error.shouhengReply, /红人Brief_职场妈妈版\.pptx/, '标题要说出来，人才知道你说的是哪一个文件');
  assertNoDownload(calls);
  // 反向对照：连「探测一下能不能下」都不许 —— 附件形态**一次网络请求都不该有**
  const reads = calls.filter((c) => !/metas\/batch_query/.test(c.path));
  assert.deepEqual(reads, [], `附件形态只允许查标题，实际还调了：${JSON.stringify(reads)}`);
});

await test('读不成（权限 / 不存在）：把飞书回的 code 说出来，别猜', async () => {
  const { request } = makeRequest([
    [/docx\/v1\/documents\/Ybg1dZtoaoG5GKxLfREcHAK2nfs\/raw_content/,
      () => ({ code: 131006, msg: 'permission denied' })],
  ]);
  let error = null;
  try { await readFeishuLink(DOCX, { request }); } catch (e) { error = e; }
  assert.ok(error);
  assert.match(error.shouhengReply, /code=131006/);
  assert.match(error.shouhengReply, /未读取到的内容不会判为通过/);
});

await test('飞书链接没有 token ⇒ 直接说清楚，**一个接口都不打**', async () => {
  const { request, calls } = makeRequest([]);
  let error = null;
  try { await readFeishuLink('https://momcozy-in.feishu.cn/docx/', { request }); } catch (e) { error = e; }
  assert.ok(error);
  assert.match(error.shouhengReply, /token/);
  assert.deepEqual(calls, [], '没有 token 时不该发任何请求');
});

await test('★ 分流：公网链接走公开网页读取器，飞书链接走飞书只读接口（两条路不许串）', async () => {
  const { request, calls } = makeRequest([
    [/docx\/v1\/documents\/Ybg1dZtoaoG5GKxLfREcHAK2nfs\/raw_content/, () => ({ code: 0, data: { content: '飞书正文' } })],
  ]);
  let publicCalls = 0;
  const readPublicPageStub = async (url) => {
    publicCalls += 1;
    return { url, contentType: 'text/html', text: '公网正文' };
  };
  const feishuPage = await readLink(DOCX, { request, readPublicPage: readPublicPageStub });
  assert.equal(feishuPage.text, '飞书正文');
  assert.equal(publicCalls, 0, '飞书链接**不许**走公开网页抓取（那正是这次事故的形状）');

  const callsBefore = calls.length;   // 飞书那条路刚才打了 metas + raw_content 两次
  const pubPage = await readLink('https://example.com/p/1', { request, readPublicPage: readPublicPageStub });
  assert.equal(pubPage.text, '公网正文');
  assert.equal(publicCalls, 1);
  // 反向对照：公网那条路**一次飞书接口都不该打** —— 否则就是「两条路串了」
  assert.equal(calls.length, callsBefore, `公网链接不许调飞书接口，实际多调了 ${calls.length - callsBefore} 次`);
});

const policyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-link-policy-'));
const policyPath = path.join(policyDir, 'policy.json');
const stoppedToken = 'STOPPED12345678';
const stoppedWiki = 'WIKISTOP12345678';
const writePolicy = (tokens = []) => fs.writeFileSync(policyPath, JSON.stringify({
  schema_version: 1,
  resources: tokens.length ? [{ name: '已停读资源', url: `https://momcozy-in.feishu.cn/base/${tokens[0]}`, tokens }] : [],
}));

try {
  await test('停读资源的各种直接链接在任何网络请求前拒读，包括 Wiki 和应用壳', async () => {
    writePolicy([stoppedToken, stoppedWiki]);
    for (const route of ['base', 'docx', 'sheets', 'wiki', 'app', 'file']) {
      const { request, calls } = makeRequest([]);
      await assert.rejects(
        readLink(`https://momcozy-in.feishu.cn/${route}/${stoppedToken}?from=share`, { request, policyPath }),
        (e) => e.name === 'FeishuLinkError' && /移除|停读|停止读取/.test(e.shouhengReply)
          && !/权限|不存在/.test(e.shouhengReply),
      );
      assert.deepEqual(calls, [], `${route} 的停读 token 不许先查标题或正文`);
    }
    const { request, calls } = makeRequest([]);
    await assert.rejects(readFeishuLink(`https://momcozy-in.feishu.cn/wiki/${stoppedWiki}`, { request, policyPath }),
      (e) => e.name === 'FeishuLinkError' && /移除|停读|停止读取/.test(e.shouhengReply));
    assert.deepEqual(calls, []);
  });

  await test('未登记的 Wiki 别名解析到停读 obj_token 后，不得继续读正文', async () => {
    writePolicy([stoppedToken]);
    const { request, calls } = makeRequest([
      [/get_node/, () => ({ code: 0, data: { node: { obj_type: 'docx', obj_token: stoppedToken, title: '新 Wiki 别名' } } })],
      [/raw_content/, () => ({ code: 0, data: { content: '不该读到的正文' } })],
    ]);
    await assert.rejects(readFeishuLink(WIKI, { request, policyPath }),
      (e) => e.name === 'FeishuLinkError' && /移除|停读|停止读取/.test(e.shouhengReply));
    assert.ok(calls.some((c) => /get_node/.test(c.path)), '确实经过 Wiki 解析');
    assert.equal(calls.filter((c) => /raw_content/.test(c.path)).length, 0);
  });

  await test('同一进程中更新停读清单立即生效，解除停读后也能重新读取', async () => {
    const token = classifyFeishuLink(DOCX).token;
    writePolicy();
    const { request, calls } = makeRequest([
      [/raw_content/, () => ({ code: 0, data: { content: '保留资源的正文' } })],
    ]);
    assert.equal((await readFeishuLink(DOCX, { request, policyPath })).text, '保留资源的正文');
    const before = calls.length;
    writePolicy([token]);
    await assert.rejects(readFeishuLink(DOCX, { request, policyPath }),
      (e) => e.name === 'FeishuLinkError' && /移除|停读|停止读取/.test(e.shouhengReply));
    assert.equal(calls.length, before, '更新清单后不许沿用启动时的旧名单');
    writePolicy();
    assert.equal((await readFeishuLink(DOCX, { request, policyPath })).text, '保留资源的正文');
  });

  await test('停读清单缺失、语法损坏或字段错误时拒读，不得退回全部放行', async () => {
    const invalidValues = [null, '{', '{}', '{"schema_version":2,"resources":[]}',
      '{"schema_version":1,"resources":[{"name":"坏条目","url":"https://example.com","tokens":[]}]}'];
    for (const value of invalidValues) {
      if (value === null) fs.rmSync(policyPath, { force: true });
      else fs.writeFileSync(policyPath, value);
      const { request, calls } = makeRequest([
        [/raw_content/, () => ({ code: 0, data: { content: '不该放行的正文' } })],
      ]);
      await assert.rejects(readFeishuLink(DOCX, { request, policyPath }),
        (e) => e.name === 'FeishuLinkError' && /停读清单/.test(e.shouhengReply));
      assert.deepEqual(calls, []);
    }
  });

  await test('公网读取不受飞书停读清单影响', async () => {
    fs.rmSync(policyPath, { force: true });
    const page = await readLink('https://example.com/public', {
      policyPath, readPublicPage: async (url) => ({ url, text: '正常公网正文' }),
    });
    assert.equal(page.text, '正常公网正文');
  });
} finally {
  fs.rmSync(policyDir, { recursive: true, force: true });
}

console.log(`\n飞书链接：通过 ${cases.length} 项 / 失败 0 项`);
