import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const app = process.env.SHOUHENG_DSH_APP || '/Applications/DSH NEXT.app';
const runtime = path.join(app, 'Contents/MacOS/DSH NEXT');
const modules = path.join(app, 'Contents/Resources/app.asar/node_modules');
const bin = path.join(modules, '@deepseek-ai/dsh/lib/bin.js');

async function policy() {
  const mod = await import('./image_generation_policy.mjs').catch(e => {
    if (e.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw e;
  });
  assert.equal(typeof mod.imageGenerationPatch, 'function', '图片任务需要可执行的生成预算配置');
  return mod.imageGenerationPatch;
}

// This catches a missing compatibility flag or output budget in the real request,
// not merely the spelling of the patch file. Only the HTTP model endpoint is fake.
async function probe(t, { reportOnly = false, attemptTool = false, resume = false } = {}) {
  const buildPatch = await policy();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shouheng-generation-wire-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const requests = [];
  const marker = path.join(dir, 'tool-must-not-write');
  let toolSent = false;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = { id: 'wire-fixture', object: 'chat.completion.chunk', created: 1,
      model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '完整报告测试已返回。' }, finish_reason: null }] };
    const maliciousTool = attemptTool && body.tools?.length > 0 && !toolSent;
    if (maliciousTool) {
      toolSent = true;
      chunk.choices[0].delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-forbidden-bash',
        type: 'function', function: { name: 'bash', arguments: JSON.stringify({
          command: `printf blocked > '${marker}'`, description: 'test report recovery execution barrier', timeoutMs: 1000 }) } }] };
    }
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    chunk.choices = [{ index: 0, delta: {}, finish_reason: maliciousTool ? 'tool_calls' : 'stop' }];
    chunk.usage = { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 };
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const profile = path.join(dir, 'profiles/headless');
  await fs.mkdir(profile, { recursive: true });
  await fs.symlink(modules, path.join(profile, 'node_modules'));
  await fs.writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'image-wire-fixture', private: true,
    dependencies: { '@deepseek-ai/dsh-base': '0.2.1-rc.3', '@deepseek-ai/dsh-headless': '0.2.1-rc.3' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } } }));
  // A clean bundled profile has no personal llm-pi-ai entry at all.
  const initial = [];
  const profilePath = path.join(profile, 'cordis.patch.yml');
  await fs.writeFile(profilePath, JSON.stringify(initial));
  const before = await fs.readFile(profilePath, 'utf8');
  const patchPath = path.join(dir, 'image-budget.json');
  const patch = buildPatch({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reportOnly: resume ? false : reportOnly });
  await fs.writeFile(patchPath, JSON.stringify(patch));
  let { stdout } = await run(runtime, [bin, '--profile', 'headless', '--patch', patchPath, '--json',
    '仅回复：完整报告测试已返回。不调用工具。'], {
    cwd: dir, timeout: 30000, maxBuffer: 4 << 20,
    env: { PATH: process.env.PATH, DSH_HOME: dir, ELECTRON_RUN_AS_NODE: '1',
      OPENCODE_ABI_API_KEY: 'fixture-key-not-a-secret', DEEPSEEK_API_KEY: 'fixture-key-not-a-secret' },
  });
  if (resume) {
    const initialEvents = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const sessionId = initialEvents.find(e => e.type === 'session')?.sessionId;
    assert.ok(sessionId, '恢复必须使用真实会话号');
    assert.ok(await fs.stat(marker).then(() => true, () => false), '恢复前原会话的工具确实能执行');
    await fs.rm(marker);
    toolSent = false;
    await fs.writeFile(patchPath, JSON.stringify(buildPatch({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reportOnly: true })));
    ({ stdout } = await run(runtime, [bin, '--profile', 'headless', '--patch', patchPath, '--json',
      '--session-id', sessionId, '仅用本会话已有证据完成报告。'], {
      cwd: dir, timeout: 30000, maxBuffer: 4 << 20,
      env: { PATH: process.env.PATH, DSH_HOME: dir, ELECTRON_RUN_AS_NODE: '1',
        OPENCODE_ABI_API_KEY: 'fixture-key-not-a-secret', DEEPSEEK_API_KEY: 'fixture-key-not-a-secret' },
    }));
    const resumed = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    assert.equal(resumed.find(e => e.type === 'session')?.sessionId, sessionId);
  }
  const events = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  assert.ok(events.some(event => event.type === 'final' && /完整报告/.test(event.text)));
  assert.ok(requests.length > 0, '必须真实走到HTTP请求');
  const reportRequests = requests.filter(body => body.tools?.length > 0);
  assert.ok(reportRequests.length > 0, '必须捕获审查agent请求，标题辅助调用不算报告');
  for (const body of reportRequests) {
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.ok(body.max_tokens >= 8192 && body.max_tokens <= 16384,
      `六节报告须有完整输出余量，又不能沿用32768全思考：${body.max_tokens}`);
    assert.equal(body.model, 'deepseek-v4.1-flash');
  }
  assert.equal(await fs.readFile(profilePath, 'utf8'), before, '单次patch不得改写共享profile');
  const markerExists = await fs.stat(marker).then(() => true, () => false);
  return { events, markerExists, toolSent };
}

test('任务级配置实际发出 thinking.disabled 并给完整报告留输出额度', async (t) => {
  await probe(t);
});

// The resume process must reject a model-generated bash call before its command
// can execute. A guard callback returning nothing reproduces this regression.
test('报告补写硬闸在执行前拒绝工具，不能被模型的bash调用绕过', async (t) => {
  const guard = await import('./image_report_tool_guard.mjs').catch(e => {
    if (e.code === 'ERR_MODULE_NOT_FOUND') return {};
    throw e;
  });
  assert.equal(typeof guard.apply, 'function', '恢复任务必须安装工具执行闸门');
  const normal = await probe(t, { attemptTool: true });
  assert.equal(normal.markerExists, true, '正对照：正常首轮仍必须能执行完整skill与审查链');
  const recovery = await probe(t, { attemptTool: true, reportOnly: true, resume: true });
  assert.equal(recovery.toolSent, true);
  assert.equal(recovery.markerExists, false, '恢复期不许执行模型请求的命令');
  assert.ok(recovery.events.some(e => e.type === 'tool_result' && e.status === 'error'
    && /report recovery/.test(e.result)), '拒绝必须留下机器可读原因');
});

test('预算patch不接收凭据值或无效端点', async () => {
  const buildPatch = await policy();
  assert.throws(() => buildPatch({ baseUrl: 'file:///private/config' }), /endpoint|baseUrl/i);
  assert.throws(() => buildPatch({ baseUrl: 'http://user:user@example.com' }), /credential|baseUrl/i);
});

test('生产 tools adapter 的真实 CLI 参数顺序能走到模型请求', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shouheng-adapter-wire-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = { id: 'adapter-wire', object: 'chat.completion.chunk', created: 1,
      model: body.model, choices: [{ index: 0,
        delta: { role: 'assistant', content: 'adapter reached model; no review engine ran' }, finish_reason: null }] };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    chunk.choices = [{ index: 0, delta: {}, finish_reason: 'stop' }];
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const profile = path.join(dir, 'profiles/headless');
  await fs.mkdir(profile, { recursive: true });
  await fs.symlink(modules, path.join(profile, 'node_modules'));
  await fs.writeFile(path.join(profile, 'package.json'), JSON.stringify({ name: 'adapter-wire-fixture', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } } }));
  await fs.writeFile(path.join(profile, 'cordis.patch.yml'), '[]');
  await fs.mkdir(path.join(dir, 'kb/.work/sidecars'), { recursive: true });
  await fs.writeFile(path.join(dir, 'kb/kbpy'), 'echo "{}"\n');
  const adapter = new URL('./tools.mjs', import.meta.url).href;
  const runner = `
    import fs from 'node:fs';
    const originalRead = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      const p = String(file);
      if (p.endsWith('/.dsh/credentials/shouheng-lark.json')) return JSON.stringify({app_id:'fixture',app_secret:'fixture'});
      if (p.endsWith('/.dsh/.credentials.yaml')) return '';
      if (p.endsWith('/.config/opencode/opencode.json')) return '{}';
      return originalRead.call(this, file, ...args);
    };
    const tools = await import(${JSON.stringify(adapter)});
    const result = await tools.withAgentTurnContext(async () => {
      tools.setAgentTurnContext({chainTurnModality:'image',chainTurnImagePaths:['/tmp/adapter-fixture.png']});
      return tools.executeTool('kb_review_chain', {question:'isolated CLI wire check',text:'adapter fixture',deadlineAt:Date.now()+40000});
    });
    console.log('ADAPTER_RESULT='+JSON.stringify(result.result));
  `;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', runner], {
    cwd: dir, timeout: 30000, maxBuffer: 4 << 20,
    env: { PATH: process.env.PATH, DSH_HOME: dir, SHOUHENG_STATE_DIR: dir, SHOUHENG_KB_ROOT: dir,
      SHOUHENG_PROFILE_DIR: dir, SHOUHENG_LLM_API_KEY: 'fixture', SHOUHENG_LLM_BASE_URL: 'http://127.0.0.1:9',
      SHOUHENG_IMAGE_CHAIN_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      SHOUHENG_DSH_APP: app, SHOUHENG_REVIEW_TABLE: 'off', SHOUHENG_MEDIA_LINK: 'off',
      OPENCODE_ABI_API_KEY: 'fixture', DEEPSEEK_API_KEY: 'fixture' },
  });
  const result = JSON.parse(stdout.split('\n').find(line => line.startsWith('ADAPTER_RESULT=')).slice(15));
  assert.ok(requests.some(body => body.tools?.length > 0), '生产 adapter 必须真正到达模型 HTTP 端点');
  for (const body of requests.filter(body => body.tools?.length > 0)) {
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.max_tokens, 12288);
  }
  assert.ok(result.generation.attempts[0].session_id, '真实 CLI 必须产出 session 事件');
  assert.equal(result.generation.attempts[0].has_final, true);
  assert.equal(result.reason_code, 'kb_readings_missing', '只有模型回复而没跑链，仍然拒收');
});
