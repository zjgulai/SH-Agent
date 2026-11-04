import { fileURLToPath } from 'node:url';

/** Per-invocation DSH controls. This module never reads or writes a profile. */
export const IMAGE_REPORT_MAX_TOKENS = 12288;
export const IMAGE_GENERATION_MODEL = 'deepseek-v4.1-flash';
export const IMAGE_GENERATION_PROVIDER = 'opencode-abi';

export function imageGenerationPatch({ baseUrl, model = IMAGE_GENERATION_MODEL,
  apiKeyEnv = 'OPENCODE_ABI_API_KEY', maxTokens = IMAGE_REPORT_MAX_TOKENS,
  reportOnly = false } = {}) {
  let endpoint;
  try { endpoint = new URL(baseUrl); } catch { throw new Error('image generation baseUrl endpoint is required'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash) throw new Error('image generation baseUrl must be an HTTP endpoint without credentials');
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 8192 || maxTokens > 16384) {
    throw new Error('image report maxTokens must reserve 8192–16384 output tokens');
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(apiKeyEnv)) throw new Error('apiKeyEnv must name an environment variable');
  const patches = [
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {
      [IMAGE_GENERATION_PROVIDER]: {
        api: 'openai-completions', baseURL: endpoint.href.replace(/\/$/, ''), apiKeyEnv,
        reasoning: 'off', timeoutMs: 90000,
        models: [{ id: model, contextWindow: 1000000, maxTokens, input: ['text', 'image'],
          // false would suppress the explicit `thinking:disabled` wire field.
          reasoningEfforts: { off: null, high: 'high' },
          compat: { thinkingFormat: 'deepseek', maxTokensField: 'max_tokens', supportsReasoningEffort: true } }],
      },
    } } },
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model',
      config: { provider: IMAGE_GENERATION_PROVIDER, model, reasoningEffort: 'off' } },
  ];
  if (reportOnly) patches.push({ insert: [{ id: 'shouheng-report-only-guard',
    name: fileURLToPath(new URL('./image_report_tool_guard.mjs', import.meta.url)) }] });
  return patches;
}
