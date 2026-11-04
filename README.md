# SH-Agent

守衡（内容审查 Agent）的源码镜像。

## 包含

- `tools/agent/`：守衡内核（消息路由、审核链编排、双轨合并、模型侧复核、图片/视频处理）
- `tools/reply-cards/`：飞书卡片渲染与语域规则
- `tools/session_distill/`：会话蒸馏
- `tools/*.py` / `*.mjs` / `*.sh`：飞书读写、知识库索引、审核辅助工具
- `agent-skills/`：项目自有规程（内容合规审查、飞书内容审核工作流、守衡语域等）
- `base/`：本机 OCR / ASR / 视频抽帧源码与构建脚本

## 不包含

- 知识库内容（`内容治理知识库/`）
- PMO 日志、内部诊断记录、飞书消息原文
- 测试图片、真实审核报告、凭据
- 第三方技能库与构建产物

## 配置

- 飞书凭据：`~/.dsh/credentials/shouheng-lark.json`（仓库不含凭据）
- 模型端点：`~/.dsh/shouheng-llm.env`（仓库不含密钥）
- 公开镜像中的飞书群 ID 已替换为占位符：`oc_TEST_GROUP`、`oc_TEST_P2P`
- 生产部署时需在本地配置真实群 ID 与凭据

## 自证

```bash
node tools/agent/dual_track.mjs --selftest
node tools/verify_cards.mjs
node --test tools/agent/push_policy.test.mjs
```

部分测试依赖本机知识库、飞书凭据或 macOS Vision；公开镜像不保证全部可跑。