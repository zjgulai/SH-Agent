import fs from 'node:fs';

// 外部标准库与知识库周更共用的唯一推送目标；不读取最近会话或环境变量。
export function scheduledPushTarget() {
  const policy = JSON.parse(fs.readFileSync(new URL('../push-policy.json', import.meta.url), 'utf8'));
  // 群名与 ID 的绑定已由飞书只读接口核实；不能仅靠名字或 ID 格式放行。
  if (policy?.version !== 1 || policy.chat_id !== 'oc_TEST_GROUP'
      || policy.chat_name !== '内容治理-守衡Agent-测试') {
    throw new Error('定时推送策略无效，拒绝发送');
  }
  return policy.chat_id;
}

export function assertScheduledPushTarget(chatId) {
  if (chatId !== scheduledPushTarget()) {
    throw new Error(`拒绝定时推送到未授权会话：${chatId ?? '空目标'}`);
  }
}
