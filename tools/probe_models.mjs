import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
let key = process.env.DEEPSEEK_API_KEY;
if (!key) {
  const out = execFileSync('bash', ['-lc', 'cat ~/.dsh/.credentials.yaml'], { encoding:'utf8' });
  key = out.match(/DEEPSEEK_API_KEY:\s*(\S+)/)?.[1];
}
const H = { 'Content-Type':'application/json', 'Authorization':`Bearer ${key}` };

console.log('=== 1) 可用模型清单 ===');
const m = await (await fetch('https://api.deepseek.com/models', { headers:H })).json();
console.log(JSON.stringify(m, null, 2).slice(0, 800));

console.log('\n=== 2) 逐模型试探 chat/completions 是否可用 ===');
for (const id of ['deepseek-chat','deepseek-reasoner']) {
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method:'POST', headers:H,
    body: JSON.stringify({ model:id, messages:[{role:'user',content:'说"ok"'}], max_tokens:10 }),
  });
  const j = await r.json();
  console.log(`  ${id}: HTTP ${r.status} ->`, j.error ? `ERR ${j.error.message}` : `OK "${j.choices?.[0]?.message?.content}" usage=${JSON.stringify(j.usage)}`);
}
