/** Real tools/child-process boundary; only the external DSH executable is replaced. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { checkImageReport } from './image_report_completion.mjs';
import { reviewFixtureClaims } from './__fixtures__/image-claim-review.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'image-chain-execution-'));
const read = fs.readFileSync;
const connect = net.Socket.prototype.connect;
fs.readFileSync = function(file, ...args) {
  const p = String(file);
  if (p.endsWith('/.dsh/credentials/shouheng-lark.json')) return JSON.stringify({app_id:'fixture',app_secret:'fixture'});
  if (p.endsWith('/.dsh/.credentials.yaml')) return '';
  if (p.endsWith('/.config/opencode/opencode.json')) return '{}';
  return read.call(this, file, ...args);
};
net.Socket.prototype.connect = () => { throw new Error('No network permitted'); };
const bin = path.join(tmp, 'fake-dsh.mjs');
Object.assign(process.env, {SHOUHENG_STATE_DIR:tmp, SHOUHENG_KB_ROOT:tmp,
  SHOUHENG_PROFILE_DIR:tmp, SHOUHENG_LLM_API_KEY:'fixture',
  SHOUHENG_LLM_BASE_URL:'http://127.0.0.1:9', SHOUHENG_DSH_BIN:bin,
  SHOUHENG_DSH_EXEC:process.execPath, SHOUHENG_REVIEW_TABLE:'off',
  SHOUHENG_MEDIA_LINK:'off', SHOUHENG_IDENTITY_REJECT_LOG:path.join(tmp,'reject.ndjson')});
fs.mkdirSync(path.join(tmp,'kb/.work/sidecars'),{recursive:true});
fs.writeFileSync(path.join(tmp,'kb/kbpy'), 'case "$1" in *kb_loop_claim.py) echo 无认领;; *) echo "{}";; esac\n');
fs.writeFileSync(bin, `import fs from 'node:fs'; import crypto from 'node:crypto';
const task=process.argv.at(-1), args=process.argv.slice(2);
fs.appendFileSync('calls.ndjson',JSON.stringify(args)+'\\n');
const resume=args.includes('--session-id');
const mode=fs.readFileSync('mode','utf8');
const send=x=>console.log(JSON.stringify(x));
send({type:'session',sessionId:'session-current'});
if(!resume){
 const material=task.match(/\\/tmp\\/shouheng-material-[^\\s\\x60]+\\.txt/)[0];
 const hash=crypto.createHash('sha256').update(fs.readFileSync(material,'utf8').trimEnd()).digest('hex');
 const identity=mode==='foreign'?'f'.repeat(64):hash;
 const engine={state:'REVIEW',decision:{review_id:'review-current',content_version:identity,content_id:'AUTO-'+identity.slice(0,12)},image_skill_gate:{ok:true,load:{verdict:'loaded'}}};
 fs.writeFileSync('kb/.work/sidecars/engine-fixture.json',JSON.stringify(engine));
 fs.writeFileSync('kb/.work/sidecars/review-fixture.json',JSON.stringify({base:'fixture',review_id:'review-current',at:new Date().toISOString(),review_token:['foreign','same-content-foreign-run'].includes(mode)?'foreign':material,text_sha8:identity.slice(0,8),content_version:identity,state:'REVIEW'}));
 send({type:'tool_call',callId:'chain',tool:'bash',input:{command:'bash kb/l8/review_run.sh'}});
 send({type:'tool_result',callId:'chain',status:'completed',result:'exit 0'});
}
 if(resume&&(mode==='recover'||mode==='partial')||mode==='success'){
  send({type:'status',phase:'turn_end',reason:{kind:'completed'}});
  send({type:'final',text:fs.readFileSync(resume&&mode==='repair'?'repaired-report':'report','utf8')});
 }else if(mode==='partial'&&!resume){
  send({type:'status',phase:'turn_end',reason:{kind:'completed'}});
  send({type:'final',text:fs.readFileSync('partial-report','utf8')});
 }else{
 send({type:'thinking',text:'NEVER_USE_AS_REPORT'});
 send({type:'status',phase:'turn_end',reason:{kind:'max-tokens'}});
 process.exitCode=1;
}
`);
const report = [
 '审核对象与范围：图1白桌上的杯子，检查文字、安全与图文一致性。',
 '视觉分析与 OCR：图1没有人物，白色杯体没有可读文字。',
 '主张拆分与核查清单：C1：本图没有产品性能或安全主张。',
 '4A 规则符合性：本轮规则未覆盖，未发现命中，不能冒称已有条款证明合规。',
 '4B 事实准确性核查：',
 '| 主张 | 核查结论 | 依据及边界 | 来源 | 来源原文 |',
 '| --- | --- | --- | --- | --- |',
 '| C1 | 不适用 | 杯体没有文字，也没有人物或使用行为，因此没有外部事实需要核对 | — | — |',
 '图文一致性：没有可读文字，未见文字与画面矛盾。',
 '视觉核对：婴幼儿姿势=无；婴儿睡眠位置=无；产品状态=无；场景关系=无；隐私=无',
 '### 问题清单', '1. 无', '【审查结论：REVIEW】库侧未覆盖，最终结论由双轨合并。',
].join('\n');
fs.writeFileSync(path.join(tmp,'report'),report);
fs.writeFileSync(path.join(tmp,'repaired-report'),report.replace('### 问题清单\n1. 无',
  '4B 补充说明，不改问题清单。\n### 问题清单\n1. 画面风险已列出｜左侧，图 1 第 2 处｜改：移除侧放奶瓶的摆放方式。'));
fs.writeFileSync(path.join(tmp,'partial-report'),report.replace(/图文一致性：[^\n]+/, ''));
let pass=0, fail=0;
const test=async(name,fn)=>{try{await fn();pass++;console.log('PASS '+name);}catch(e){fail++;console.error('FAIL '+name+': '+e.message);}};
try {
 const tools=await import('./tools.mjs');
  const run=async(mode,deadlineAt,{checker=true}={})=>{
  fs.writeFileSync(path.join(tmp,'mode'),mode); fs.writeFileSync(path.join(tmp,'calls.ndjson'),'');
  return tools.withAgentTurnContext(async()=>{
   const cache = new Map();
   tools.setAgentTurnContext({chainTurnModality:'image',chainTurnImagePaths:['/tmp/synthetic-current.png'],
     imageReportChecker: checker ? (answer, { sources, deadlineAt }) => checkImageReport(answer, {
      scenes: [{ setting:'影棚', people:[], products:[], risk_cues:[], unclear:[] }],
      materialTexts: [{ origin:'image_ocr', image:1, status:'empty', text:'' }],
      sources, deadlineAt, cache, claimRunner: reviewFixtureClaims,
     }) : null});
   const out=await tools.executeTool('kb_review_chain',{question:'审查这张图',text:'fixture '+mode,deadlineAt});
   return out.result;
  });
 };
 await test('token exhaustion retains same-request engine while withholding a final decision',async()=>{
  const r=await run('exhausted',Date.now()+20500);
  assert.equal(r.engine?.image_skill_gate?.ok,true);
  assert.equal(r.reason_code,'final_output_token_limit'); assert.ok(r.error);
  assert.ok(!r.answer?.includes('NEVER_USE_AS_REPORT'));
 });
 await test('foreign artifacts are rejected even after a child failure',async()=>{
  const r=await run('foreign',Date.now()+20500); assert.ok(!r.engine); assert.ok(r.error);
 });
 await test('same-content artifacts from another run are not returned as current evidence',async()=>{
  const r=await run('same-content-foreign-run',Date.now()+20500);
  assert.ok(!r.engine); assert.ok(!r.review); assert.ok(r.error);
 });
 await test('successful JSON stream yields only final text and uses a task-local patch',async()=>{
  const r=await run('success',Date.now()+180000); assert.equal(r.answer,report);
  const [args]=fs.readFileSync(path.join(tmp,'calls.ndjson'),'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(args.includes('--json')); assert.ok(args.includes('--patch'));
 });
 await test('production image execution refuses a missing full-report checker',async()=>{
  const r=await run('success',Date.now()+180000,{checker:false});
  assert.equal(r.ok,false);
  assert.match(r.error,/本轮图片主张与来源验收上下文未提供/);
  assert.equal(r.answer,undefined);
 });
  await test('a missing final report resumes the same session exactly once without rerunning the chain',async()=>{
  const r=await run('recover',Date.now()+180000); assert.equal(r.answer,report); assert.equal(r.recovery?.completed,true);
  const calls=fs.readFileSync(path.join(tmp,'calls.ndjson'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length,2); assert.equal(calls[1][calls[1].indexOf('--session-id')+1],'session-current');
   assert.ok(!calls[1].at(-1).includes('bash kb/l8/review_run.sh'));
  });
  await test('a nonempty incomplete report records exact missing checks and repairs once in-session',async()=>{
   const r=await run('partial',Date.now()+180000);
    assert.equal(r.recovery?.completed,true);
    assert.ok(r.answer.includes('图文一致性：'));
    assert.ok(r.answer.includes('### 问题清单\n1. 无'), 'first-pass issue list is authoritative and restored');
    assert.equal(r.answer.includes('画面风险已列出'), false, 'continuation cannot rewrite the issue block');
   const calls=fs.readFileSync(path.join(tmp,'calls.ndjson'),'utf8').trim().split('\n').map(JSON.parse);
   assert.equal(calls.length,2);
   assert.ok(calls[1].at(-1).includes('本轮已有报告底稿'));
   assert.ok(calls[1].at(-1).includes('图文一致性'));
  });
  await test('40.862s preparation keeps the engine budget and permits one repair from actual remaining time',async()=>{
   // Simulate elapsed ingress preparation by shortening the original deadline;
   // sleeping inside the report checker would measure a different stage twice.
   const deadline=Date.now()+180000-40862;
   const r=await run('partial',deadline);
   const calls=fs.readFileSync(path.join(tmp,'calls.ndjson'),'utf8').trim().split('\n').map(JSON.parse);
   assert.equal(calls.length,2,'initial incompleteness still receives one report-only continuation');
   assert.equal(calls[1][calls[1].indexOf('--session-id')+1],'session-current');
   assert.equal(r.recovery?.completed,true,r.error);
   assert.equal(r.generation.budget.first_turn_ms,110000,
     'engine retains its cap when the actual deadline still permits it');
   assert.ok(r.generation.budget.recovery_ms >= 5000 && r.generation.budget.recovery_ms <= 45000,
     'recovery uses actual remaining time and stays within its independent cap');
   assert.ok(Date.now() <= deadline-20000,'completed report must preserve the original final-send reserve');
  });
 } finally { fs.readFileSync=read; net.Socket.prototype.connect=connect; fs.rmSync(tmp,{recursive:true,force:true}); }
console.log(JSON.stringify({pass,fail})); process.exitCode=fail?1:0;
