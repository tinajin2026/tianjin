# PromptDiff Audit Lab

可在本地运行的系统提示词对比与审计实验室，支持多版本导入、Monaco Diff 定位、静态审计、AI 审计与三 Agent 辩论，并可导出报告。

## ✅ 安装

```bash
npm install
```

## ✅ 启动

```bash
npm run dev
```

- Client: http://localhost:5173
- Server: http://localhost:8787

## 使用流程

1. 左侧导入多个 `.md` / `.txt` 提示词（拖拽或选择），或点击 `Load Samples`。
2. 在列表中分别选定 Base 与 Compare。
3. 中间 Monaco Diff 会展示并支持“Prev/Next Change”。
4. 右侧 `Audit` 标签：
   - 展开静态审计条目并点击 `Locate` 跳转到对应 Diff 区域。
   - 填写规则、选择 provider/model，然后运行 `Run Audit` 或 `Generate Patch`。
5. `Review Prompt` 标签中可编辑 Layer-2 评审提示词，并保存为 preset。
6. `Debate` 标签中运行三 Agent 辩论并查看最终共识。
7. 点击 `Export Markdown` 或 `Export HTML` 输出报告。

## Mock 说明（无 Key 也可跑通）

- 默认 provider 为 `mock`，即使没有配置 API Key，审计/补丁/辩论也可完整运行。
- Mock 审计会基于 `diffSummary` 与 `rules` 生成稳定 JSON 结果。

## Key 配置

服务端仅从 `.env` 读取 API Key，不会下发到浏览器：

```bash
cp .env.example .env
# 填写 OPENAI_API_KEY
```

> 如未配置，将自动 fallback 到 mock。

## 已知限制

- 非 mock 模式下，当前仅支持 OpenAI Chat Completions。
- 超大文本（>= 50k chars）会提示可能影响 Diff 性能。
- 报告导出为 Markdown/HTML 的简化模板（不包含本机路径）。
