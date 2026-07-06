# vibe-trophy（占位名，待定名）

从你本地的 Claude Code 日志，算出你的 vibecoding 成就。

👉 效果长这样（作者本人的真实成就墙）：https://maxi-max-dev.github.io/vibe-trophy/

别人的成就百分比是编的，这里的每个数字都来自你自己的真实日志。

## 用法

```bash
node vibe-trophy.js
```

跑完打开同目录下的 `index.html`。

可选参数：`--tz=Asia/Shanghai`（深夜成就按哪个时区算），`--out=index.html`（输出文件名）。

## 有什么

- 35 个成就，四组：🌱 日常 / 🌙 肝度 / 💸 钞能力 / 🎮 微操，含 7 个隐藏成就（其中一个致敬 2012 年 Visual Studio Achievements 的 Potty Mouth）
- 未解锁的显示进度条（差多少一目了然）
- 晒图模式：点卡片选中想晒的，一键切竖版，未解锁和敏感统计自动隐藏

## 隐私

- 只读 `~/.claude/projects/` 下的 jsonl 日志，零依赖，不联网，数据不出这台电脑
- 生成的页面里只有统计数字，不含任何项目路径和代码内容

## 致谢

点子的火种来自小红书上一张「要是 vibecoding 有成就系统」的概念图（@xixiai）和它评论区的集体创作。这里做的是另一半：把编出来的百分比，换成你自己的真实档案。

by Max
