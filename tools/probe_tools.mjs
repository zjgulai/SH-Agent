import { execFileSync } from 'node:child_process';
const out = execFileSync('bash', ['-lc', 'cat ~/.dsh/.credentials.yaml'], { encoding:'utf8' });
const key = out.match(/DEEPSEEK_API_KEY:\s*(\S+)/)[1];
const H = { 'Content-Type':'application/json', 'Authorization':`Bearer ${key}` };

const tools = [{
  type: 'function',
  function: {
    name: 'get_group_member_count',
    description: '查询当前飞书群的成员数量',
    parameters: { type:'object', properties:{ chat_id:{type:'string',description:'群 ID'} }, required:['chat_id'] },
  },
}];

for (const model of ['deepseek-flash','deepseek-v4-pro']) {
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method:'POST', headers:H,
    body: JSON.stringify({
      model,
      messages:[{ role:'user', content:'群 oc_test123 里有多少人？用工具查。' }],
      tools, tool_choice:'auto', max_tokens:200,
    }),
  });
  const j = await r.json();
  const tc = j.choices?.[0]?.message?.tool_calls;
  console.log(`\n=== ${model} ===  HTTP ${r.status}`);
  if (j.error) { console.log('  ERR:', j.error.message); continue; }
  console.log('  finish_reason =', j.choices?.[0]?.finish_reason);
  console.log('  tool_calls =', tc ? JSON.stringify(tc) : '❌ 未发起工具调用');
}
