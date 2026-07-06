# vibe-trophy（占位名，待定名）

从你本地的 AI 编程日志，算出你的 vibecoding 成就。

👉 效果长这样（作者本人的真实成就墙）：https://maxi-max-dev.github.io/vibe-trophy/

别人的成就百分比是编的，这里的每个数字都来自你自己的真实日志。成就属于人，不属于某一个工具，所以它读的是你整个 vibe coding 生涯：

| 平台 | 状态 | 数据源 |
|---|---|---|
| Claude Code | ✅ | `~/.claude/projects/**/*.jsonl` |
| Codex（CLI/Desktop） | ✅ | `~/.codex/sessions/`、`~/.codex/archived_sessions/` |
| OpenClaw | ✅ | `~/.openclaw/agents/*/sessions/*.jsonl` |
| Gemini CLI 等其它 CLI | 🔜 | 有本地日志就能加一个适配器 |
| Cursor / TRAE / Windsurf | 🗺️ 路线图 | 聊天记录埋在无文档的 SQLite 里，能做但脆 |
| Copilot | ❌ | 数据在服务端，本地没得读 |

装了哪个读哪个，一个都没装才会报错。各平台字段覆盖不同，缺的字段按 0 计，不猜不编。

## 用法

```bash
node vibe-trophy.js
```

跑完打开同目录下的 `index.html`。

可选参数：`--tz=Asia/Shanghai`（深夜成就按哪个时区算），`--out=index.html`（输出文件名），`--src=claude,codex,openclaw`（只统计指定平台）。

## 有什么

- 37 个成就，四组：🌱 日常 / 🌙 肝度 / 💸 钞能力 / 🎮 微操，含 8 个隐藏成就（其中一个致敬 2012 年 Visual Studio Achievements 的 Potty Mouth）
- 跨平台成就：同时驯服多个 AI 编程工具的人有专属奖杯
- 未解锁的显示进度条（差多少一目了然）
- 晒图模式：点卡片选中想晒的，一键切竖版，未解锁和敏感统计自动隐藏

## 隐私

- 只读上表列出的本地日志目录，零依赖，不联网，数据不出这台电脑
- 生成的页面里只有统计数字，不含任何项目路径、消息原文和代码内容

## 致谢

点子的火种来自小红书上一张「要是 vibecoding 有成就系统」的概念图（@xixiai）和它评论区的集体创作。这里做的是另一半：把编出来的百分比，换成你自己的真实档案。

by Max
