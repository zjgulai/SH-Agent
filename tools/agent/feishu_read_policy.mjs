import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_POLICY_PATH = fileURLToPath(new URL('../../research/feishu/停读清单-v1.json', import.meta.url));

/** 每次读取文件，避免名单更新后仍使用进程启动时的旧配置。读不出时抛错，由调用方拒读。 */
export function stoppedFeishuResource(token, policyPath = DEFAULT_POLICY_PATH) {
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  if (policy?.schema_version !== 1 || !Array.isArray(policy.resources)) {
    throw new Error('停读清单格式无效');
  }
  const byToken = new Map();
  for (const resource of policy.resources) {
    if (!resource || typeof resource.name !== 'string' || !resource.name.trim()
      || typeof resource.url !== 'string' || !resource.url.trim()
      || !Array.isArray(resource.tokens) || resource.tokens.length === 0) {
      throw new Error('停读清单条目无效');
    }
    for (const item of resource.tokens) {
      if (typeof item !== 'string' || !/^[A-Za-z0-9]{8,}$/.test(item) || byToken.has(item)) {
        throw new Error('停读清单 token 无效或重复');
      }
      byToken.set(item, resource);
    }
  }
  return byToken.get(token) ?? null;
}
