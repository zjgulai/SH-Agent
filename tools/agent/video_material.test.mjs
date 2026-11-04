import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'video-material-'));
const read=fs.readFileSync;
Object.assign(process.env,{SHOUHENG_STATE_DIR:tmp,SHOUHENG_KB_ROOT:path.join(tmp,'absent'),SHOUHENG_LLM_API_KEY:'fixture-only'});
fs.readFileSync=(file,...args)=>{
  const p=String(file);
  if(p.endsWith('/.dsh/credentials/shouheng-lark.json'))return '{"app_id":"fixture","app_secret":"fixture"}';
  if(p.endsWith('/.config/opencode/opencode.json'))return '{}';
  if(p.endsWith('/.dsh/.credentials.yaml'))throw new Error('No credentials');
  return read.call(fs,file,...args);
};
const {chainInput}=await import('./review_gate.mjs');
after(()=>{fs.readFileSync=read;fs.rmSync(tmp,{recursive:true,force:true});});
const scene={setting:'厨房',people:[{kind:'婴幼儿',doing:'靠近热杯',sleep_scene:false}],products:[{what:'水杯',orientation:'倒置',in_use:true}],visible_marks:['标识'],text_script:'英文',clean_text:['HOT'],risk_cues:['热水靠近婴儿'],unclear:['温度无法判断'],additional_reading:{occlusion:'把手被遮挡'}};
const make=(frameScene)=>chainInput({question:'审核',inbound:{videos:[{index:2,meta:{duration_s:28.9},framesRead:1,frames:[{t_s:.5,text:'OCR_MARKER'}],frameScene,transcript:{ok:true,text:'ASR_MARKER',chars:10}}]}}).text;
test('every successful video frame reaches engine material with full structured scene and identity',()=>{
  const text=make([{t_s:.5,ok:true,scene},{t_s:28.6,ok:true,scene:{...scene,setting:'客厅'}}]);
  assert.match(text,/OCR_MARKER/);assert.match(text,/ASR_MARKER/);
  assert.match(text,/视频 2.*画面读数/);assert.match(text,/0\.5/);assert.match(text,/28\.6/);
  for(const value of ['靠近热杯','倒置','温度无法判断','把手被遮挡','HOT'])assert.ok(text.includes(value),value);
  assert.doesNotMatch(text,/构图、动作、场景、产品怎么用\*\*不在/);
});
test('failed frame preserves timestamp and failure cause in material',()=>{
  const text=make([{t_s:12.1,ok:false,error:'HTTP 402'}]);
  assert.match(text,/\[12\.1s\] 画面未测/);assert.match(text,/HTTP 402/);
});
test('absent visual readings are explicitly untested',()=>assert.match(make([]),/画面层未测：没有本轮画面读数/));
test('an ok flag without scene data must not generate a successful observation',()=>assert.match(make([{t_s:4,ok:true}]),/\[4\.0s\] 画面未测/));
test('a scene marked with an error cannot be presented as successful material',()=>{
  const text=make([{t_s:4,ok:true,scene,error:'HTTP 402'}]);
  assert.match(text,/\[4\.0s\] 画面未测/);assert.match(text,/HTTP 402/);
});
test('a scene without its timestamp is explicitly untested',()=>assert.match(make([{ok:true,scene}]),/\[时间码未知\] 画面未测/));
test('text-only material receives no fabricated video block',()=>assert.equal(chainInput({inbound:{text:'ordinary text'}}).text,'ordinary text'));
