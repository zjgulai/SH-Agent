/** Installed only by the task-local report recovery patch. */
export const inject = ['tools'];

export function apply(ctx) {
  // This is the tool service's monotonic pre-execution guard. It rejects even a
  // provider that emits a tool call after being instructed to return text only.
  ctx.tools.guard(() => 'report recovery forbids tool execution; use the completed session evidence');
}
