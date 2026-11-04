// 直连验证：拿 server 下发的 URL 做一次真实 WebSocket 握手，盯住 open/error/close 三个事件
import WebSocket from 'ws';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const cred = JSON.parse(fs.readFileSync(path.join(os.homedir(),'.dsh','credentials','shouheng-lark.json'),'utf8'));
const t0 = Date.now();
const stamp = () => `+${String(Date.now()-t0).padStart(5)}ms`;

const r = await fetch('https://open.feishu.cn/callback/ws/endpoint', {
  method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ AppID: cred.app_id, AppSecret: cred.app_secret }),
});
const j = await r.json();
console.log(`[${stamp()}] ① 取 endpoint: code=${j.code} msg=${j.msg||'(空)'}`);
console.log(`              URL = ${j.data?.URL?.slice(0,80)}…`);
console.log(`              Ping=${j.data?.ClientConfig?.PingInterval}s Reconnect=${j.data?.ClientConfig?.ReconnectInterval}s`);

const ws = new WebSocket(j.data.URL);
let opened = false;

ws.on('open', () => { opened = true; console.log(`[${stamp()}] ② ✓ WebSocket OPEN —— 真实握手成功`); });
ws.on('message', (d) => {
  const s = d.toString();
  let pretty = s;
  try {
    const o = JSON.parse(s);
    pretty = JSON.stringify(o).slice(0, 400);
    const h = o.headers ?? [];
    const get = (k) => h.find(x=>x.key===k)?.value;
    console.log(`[${stamp()}] ③ ★ 收到帧: type=${get('type')} msg_type=${get('message_type')} sum=${o.payload?.length??'-'}B`);
    console.log(`               ${pretty}`);
  } catch { console.log(`[${stamp()}] ③ 收到帧(非JSON): ${s.slice(0,200)}`); }
});
ws.on('error', (e) => console.log(`[${stamp()}] ✗ ERROR: ${e.code||''} ${e.message}`));
ws.on('close', (c, why) => console.log(`[${stamp()}] ✗ CLOSE code=${c} reason=${why?.toString()||'(空)'}`));

await new Promise(res => setTimeout(res, 20000));
console.log(`\n[${stamp()}] 结论: ${opened ? '握手成功，连接保持 20s 无异常' : '握手失败 —— 见上方 error/close'}`);
ws.close();
process.exit(0);
