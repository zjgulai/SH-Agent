import { sceneBlock } from './scene.mjs';

// Observations are evidence, not additional findings. This same text goes to
// the published report, or to the card when no such report was published.
export function videoAnalysisOf(inbound) {
  const blocks = [];
  for (const video of inbound?.videos ?? []) {
    const frames = (video.frameScene ?? []).filter((frame) => frame?.ok && frame.scene);
    if (!frames.length) continue;
    blocks.push(`**视频 ${video.index}：${frames.length} 帧视觉分析**`);
    for (const frame of frames) {
      blocks.push(`**[${Number(frame.t_s).toFixed(1)}s]**\n${sceneBlock(frame.scene)}`);
    }
  }
  return blocks.join('\n\n');
}

export function withVideoAnalysis(verdict, analysis) {
  return verdict && analysis ? { ...verdict, videoAnalysis: analysis } : verdict;
}
