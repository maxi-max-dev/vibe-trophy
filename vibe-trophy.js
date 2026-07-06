#!/usr/bin/env node
// vibe-trophy（占位名）v0.2 · 从本地 Claude Code 日志生成你的 vibecoding 成就卡
// 用法: node vibe-trophy.js [--tz=Asia/Shanghai] [--out=index.html]
// 只读 ~/.claude/projects/**/*.jsonl，全程离线，不上传任何数据。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const arg = (k, d) => {
  const a = process.argv.find(x => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const TZ = arg('tz', 'Asia/Shanghai');
const OUT = path.resolve(__dirname, arg('out', 'index.html'));
const ROOT = path.join(os.homedir(), '.claude', 'projects');

// ---------- 收集文件 ----------
const files = [];
(function walk(d) {
  let es;
  try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) files.push(p);
  }
})(ROOT);
if (!files.length) { console.error(`没找到日志: ${ROOT}`); process.exit(1); }

// ---------- 时区换算 ----------
const dtf = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
function local(ms) {
  const parts = {};
  for (const { type, value } of dtf.formatToParts(new Date(ms))) parts[type] = value;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: +parts.hour % 24 };
}

// ---------- 扫描 ----------
const S = {
  sessions: 0, msgs: 0, days: new Set(), nightDays: new Set(), dawnDays: new Set(),
  tokens: { in: 0, out: 0, cc: 0, cr: 0 },
  maxSessionTokens: 0, saidRight: 0, taskCalls: 0, toolCalls: 0, mcpCalls: 0,
  askCalls: 0, gitCommits: 0, images: 0, interrupts: 0, compacts: 0,
  longPrompts: 0, maxPromptLen: 0, models: new Map(),
  projects: new Set(), longestRun: 0, maxBurst: 0, daySpan: {}, hourSessions: {}, daySessions: {},
  limitHit: false, firstTs: Infinity, lastTs: 0,
};
const RIGHT_RE = /you'?re absolutely right|你说得对|你是对的/i;

for (const f of files) {
  let lines;
  try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { continue; }
  let sTokens = 0, evts = [], isSide = false, sawFirst = false, burst = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (!sawFirst && typeof j.isSidechain === 'boolean') { isSide = j.isSidechain; sawFirst = true; }
    if (j.type === 'summary' || j.isCompactSummary) S.compacts++;
    const ts = j.timestamp ? Date.parse(j.timestamp) : NaN;
    if (!isNaN(ts)) {
      evts.push(ts);
      S.firstTs = Math.min(S.firstTs, ts); S.lastTs = Math.max(S.lastTs, ts);
      const { date, hour } = local(ts);
      S.days.add(date);
      if (hour >= 2 && hour < 6) S.nightDays.add(date);
      if (hour === 5) S.dawnDays.add(date);
      if (!S.daySpan[date]) S.daySpan[date] = [ts, ts];
      S.daySpan[date][0] = Math.min(S.daySpan[date][0], ts);
      S.daySpan[date][1] = Math.max(S.daySpan[date][1], ts);
      if (!isSide) {
        (S.hourSessions[`${date}T${hour}`] ||= new Set()).add(f);
        (S.daySessions[date] ||= new Set()).add(f);
      }
    }
    if (j.cwd) S.projects.add(j.cwd);
    const m = j.message;
    if (m) {
      S.msgs++;
      const u = m.usage;
      if (u) {
        const t = (u.input_tokens || 0) + (u.output_tokens || 0) +
          (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        sTokens += t;
        S.tokens.in += u.input_tokens || 0; S.tokens.out += u.output_tokens || 0;
        S.tokens.cc += u.cache_creation_input_tokens || 0; S.tokens.cr += u.cache_read_input_tokens || 0;
      }
      if (m.model && m.model !== '<synthetic>') S.models.set(m.model, (S.models.get(m.model) || 0) + 1);
      const c = m.content;
      if (j.type === 'user') {
        let typedLen = 0, hasInterrupt = false;
        if (typeof c === 'string') { typedLen = c.trim().length; hasInterrupt = c.includes('[Request interrupted'); }
        else if (Array.isArray(c)) {
          for (const b of c) {
            if (b.type === 'text' && b.text) {
              typedLen += b.text.trim().length;
              if (b.text.includes('[Request interrupted')) hasInterrupt = true;
            } else if (b.type === 'image') S.images++;
          }
        }
        if (hasInterrupt) S.interrupts++;
        if (typedLen > 0 && !hasInterrupt) {
          burst = 0; // 真人开口，连击重计
          if (typedLen > S.maxPromptLen) S.maxPromptLen = typedLen;
          if (typedLen >= 500) S.longPrompts++;
        }
      } else if (j.type === 'assistant' && Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'tool_use') {
            burst++; S.toolCalls++;
            if (burst > S.maxBurst) S.maxBurst = burst;
            if (b.name === 'Task' || b.name === 'Agent') S.taskCalls++;
            if (b.name === 'AskUserQuestion') S.askCalls++;
            if (/^mcp__/.test(b.name || '')) S.mcpCalls++;
            if (b.name === 'Bash' && b.input && typeof b.input.command === 'string' && /git commit/.test(b.input.command)) S.gitCommits++;
          } else if (b.type === 'text' && b.text && RIGHT_RE.test(b.text)) S.saidRight++;
        }
      }
    }
    if (!S.limitHit && /usage limit|rate limit|limit reached|额度|上限已/i.test(line)) S.limitHit = true;
  }
  if (!isSide && evts.length) S.sessions++;
  if (sTokens > S.maxSessionTokens) S.maxSessionTokens = sTokens;
  evts.sort((a, b) => a - b);
  let run = 0;
  for (let i = 1; i < evts.length; i++) {
    if (evts[i] - evts[i - 1] <= 30 * 60e3) { run += evts[i] - evts[i - 1]; if (run > S.longestRun) S.longestRun = run; }
    else run = 0;
  }
}

// ---------- 派生指标 ----------
const dayN = d => Math.round(Date.parse(d) / 86400e3);
const consec = set => { // 集合里最长连续天数
  const ds = [...set].sort(); let s = 0, b = 0, p = null;
  for (const d of ds) { s = (p !== null && dayN(d) - p === 1) ? s + 1 : 1; if (s > b) b = s; p = dayN(d); }
  return b;
};
const bestStreak = consec(S.days);
const vampStreak = consec(S.nightDays);
let comeback = false;
{ const ds = [...S.days].sort(); for (let i = 1; i < ds.length; i++) if (dayN(ds[i]) - dayN(ds[i - 1]) >= 7) { comeback = true; break; } }
let maxPara = 0;
for (const k in S.hourSessions) maxPara = Math.max(maxPara, S.hourSessions[k].size);
let maxDayS = 0;
for (const k in S.daySessions) maxDayS = Math.max(maxDayS, S.daySessions[k].size);
let maxDaySpanH = 0;
for (const d in S.daySpan) maxDaySpanH = Math.max(maxDaySpanH, (S.daySpan[d][1] - S.daySpan[d][0]) / 36e5);

const totalTokens = S.tokens.in + S.tokens.out + S.tokens.cc + S.tokens.cr;
const yi = n => n >= 1e8 ? `${(n / 1e8).toFixed(1)} 亿` : n >= 1e4 ? `${(n / 1e4).toFixed(1)} 万` : `${n}`;
const hrs = ms => ms / 36e5;
const h1 = h => `${Math.floor(h)} 小时 ${Math.round(h % 1 * 60)} 分`;

// ---------- 成就定义 ----------
// cur/max 数值型给进度条；bool 型只给 hint
const A = [
  // 🌱 入门
  { g: '入门', icon: '👋', name: 'Hello World', tier: '铜', desc: '第一次打开 Claude Code，从此再没亲手写过代码', cur: S.sessions, max: 1, val: `入坑于 ${isFinite(S.firstTs) ? local(S.firstTs).date : '?'}` },
  { g: '入门', icon: '🗺️', name: '项目海王', tier: '银', desc: '同时撩 10 个以上项目，每一个都说过"这是主线"', cur: S.projects.size, max: 10, val: `${S.projects.size} 个项目` },
  { g: '入门', icon: '🧰', name: '装备党', tier: '银', desc: 'MCP 工具调用 500 次，工具比活儿多', cur: S.mcpCalls, max: 500, val: `${S.mcpCalls} 次 MCP 调用` },
  { g: '入门', icon: '🖼️', name: '一图胜千言', tier: '铜', desc: '截图一甩："就照这个做"，累计 10 张', cur: S.images, max: 10, val: `甩过 ${S.images} 张图` },
  { g: '入门', icon: '📚', name: '提示词小说家', tier: '银', desc: '单条消息 500 字起步，这不是 prompt 是需求文档', cur: S.longPrompts, max: 1, val: `最长一条 ${S.maxPromptLen} 字，超500字共 ${S.longPrompts} 条` },
  // 🌙 肝度
  { g: '肝度', icon: '🌙', name: '凌晨三点俱乐部', tier: '银', desc: '02:00–06:00 还在 vibe，全世界只剩你和它的 loading', cur: S.nightDays.size, max: 1, val: `${S.nightDays.size} 个深夜` },
  { g: '肝度', icon: '🧛', name: '吸血鬼作息', tier: '金', desc: '连续 3 天深夜营业，太阳升起前必须收工', cur: vampStreak, max: 3, val: `连续 ${vampStreak} 天深夜在线` },
  { g: '肝度', icon: '🌅', name: '日出见证者', tier: '金', hidden: true, desc: '清晨五点还在线。没人知道你是没睡，还是刚醒', cur: S.dawnDays.size, max: 1, val: `${S.dawnDays.size} 次日出` },
  { g: '肝度', icon: '📅', name: '七天连勤', tier: '银', desc: '连续 7 天有会话。休息？那是模型维护日干的事', cur: bestStreak, max: 7, val: `最长连勤 ${bestStreak} 天` },
  { g: '肝度', icon: '🏃', name: '马拉松选手', tier: '金', desc: '一口气连续会话 6 小时，断档半小时算休息', cur: +hrs(S.longestRun).toFixed(1), max: 6, val: `最长 ${h1(hrs(S.longestRun))}`, hint: '坐下，别起来' },
  { g: '肝度', icon: '🧘', name: '全天候 Vibe', tier: '白金', desc: '睁眼第一件事和闭眼最后一件事是同一件事，单日跨度 16 小时', cur: +maxDaySpanH.toFixed(1), max: 16, val: `单日跨度 ${maxDaySpanH.toFixed(1)} 小时` },
  { g: '肝度', icon: '🗓️', name: '日理万机', tier: '金', desc: '单日开 15 场会话，每个窗口都在"快好了"', cur: maxDayS, max: 15, val: `单日最多 ${maxDayS} 场` },
  { g: '肝度', icon: '🎪', name: '多线程人格', tier: '金', desc: '同一小时 3 路会话并行：左手报错，右手"你说得对"', cur: maxPara, max: 3, val: `最高并行 ${maxPara} 路` },
  { g: '肝度', icon: '🔁', name: '我又回来了', tier: '铜', hidden: true, desc: '戒了 7 天，还是回来了', cur: comeback ? 1 : 0, max: 1, val: '欢迎回家' },
  // 💸 钞能力
  { g: '钞能力', icon: '🔥', name: '烧 token 大户', tier: '金', desc: '单次会话烧掉 5000 万 token，电表都没你转得快', cur: S.maxSessionTokens, max: 5e7, val: `单会话纪录 ${yi(S.maxSessionTokens)}`, fmt: yi },
  { g: '钞能力', icon: '💯', name: '亿级玩家', tier: '白金', hidden: true, desc: '单会话破 1 亿 token。致敬传说中 1.2 亿的那位', cur: S.maxSessionTokens, max: 1e8, val: `单会话纪录 ${yi(S.maxSessionTokens)}`, fmt: yi },
  { g: '钞能力', icon: '🐷', name: '缓存白嫖怪', tier: '金', desc: '缓存命中累计 10 亿 token，省下的都是赚的', cur: S.tokens.cr, max: 1e9, val: `白嫖 ${yi(S.tokens.cr)}`, fmt: yi },
  { g: '钞能力', icon: '🚧', name: '额度撞墙', tier: '银', hidden: true, desc: '撞过用量上限还回来继续，墙都不服就服你', cur: S.limitHit ? 1 : 0, max: 1, val: '这面墙记住你了' },
  // 🎮 微操
  { g: '微操', icon: '🏗️', name: '包工头', tier: '金', desc: '派出 100 个子代理，精通自己不干活的艺术', cur: S.taskCalls, max: 100, val: `已派 ${S.taskCalls} 个分身` },
  { g: '微操', icon: '🧨', name: '一句话工程', tier: '金', desc: '一条指令，AI 连打 50 个工具调用不带喘', cur: S.maxBurst, max: 50, val: `最长连击 ${S.maxBurst}` },
  { g: '微操', icon: '🫡', name: '你说得对学派', tier: '银', desc: '被 Claude 说过 50 次"你说得对"，而你确实说得对', cur: S.saidRight, max: 50, val: `${S.saidRight} 次` },
  { g: '微操', icon: '🛑', name: '刹车侠', tier: '银', desc: '按 20 次 Esc 打断输出。刹车是最后的尊严', cur: S.interrupts, max: 20, val: `踩了 ${S.interrupts} 脚刹车` },
  { g: '微操', icon: '🚢', name: 'Ship 机器', tier: '金', desc: '经手 100 个 commit，信息还都写得比你好', cur: S.gitCommits, max: 100, val: `${S.gitCommits} 个 commit` },
  { g: '微操', icon: '💥', name: '上下文爆破手', tier: '银', desc: '把对话聊到失忆 10 次，compact 是一种境界', cur: S.compacts, max: 10, val: `${S.compacts} 次失忆` },
  { g: '微操', icon: '🎰', name: '全家桶收集者', tier: '银', desc: '用过 3 种以上模型：Opus 干活，Haiku 跑腿，Sonnet 背锅', cur: S.models.size, max: 3, val: `${S.models.size} 种模型` },
  { g: '微操', icon: '🙋', name: '甲方本人', tier: '铜', desc: '被 AI 反过来追问 20 次需求，这就是话语权', cur: S.askCalls, max: 20, val: `被追问 ${S.askCalls} 次` },
];
for (const a of A) a.ok = a.cur >= a.max;
const unlocked = A.filter(a => a.ok);

// ---------- HTML ----------
const TIER_COLOR = { '铜': '#b08d57', '银': '#9fb4c7', '金': '#e8b339', '白金': '#7fd4d0' };
const GROUPS = ['入门', '肝度', '钞能力', '微操'];
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function card(a) {
  const lock = !a.ok;
  if (lock && a.hidden) return `<div class="card locked hid"><div class="ic">❓</div><div class="meta"><div class="nm">隐藏成就</div><div class="ds">继续 vibe，总会撞见的</div></div></div>`;
  const f = a.fmt || (x => x);
  const pct = Math.min(100, Math.round(a.cur / a.max * 100));
  const prog = lock && a.max > 1
    ? `<div class="pg"><div class="pgb" style="width:${pct}%"></div></div><div class="vl">${f(a.cur)} / ${f(a.max)}${a.hint ? ` · ${esc(a.hint)}` : ''}</div>`
    : `<div class="vl">${lock ? esc(a.hint || '未解锁') : esc(a.val)}</div>`;
  return `<div class="card ${lock ? 'locked' : 'ok'}${a.tier === '白金' ? ' plat' : ''}" style="--tc:${TIER_COLOR[a.tier]}" onclick="pick(this)">
    <div class="ic">${lock ? '🔒' : a.icon}</div>
    <div class="meta">
      <div class="nm">${esc(a.name)}<span class="tier">${a.tier}</span>${a.hidden ? '<span class="tier hdt">隐藏</span>' : ''}</div>
      <div class="ds">${esc(a.desc)}</div>
      ${prog}
    </div></div>`;
}
const sections = GROUPS.map(g => `
  <h2>${{ '入门': '🌱', '肝度': '🌙', '钞能力': '💸', '微操': '🎮' }[g]} ${g}<span class="gs">${A.filter(a => a.g === g && a.ok).length}/${A.filter(a => a.g === g).length}</span></h2>
  <div class="grid">${A.filter(a => a.g === g).map(card).join('\n')}</div>`).join('\n');

const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>我的 vibecoding 成就</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body { background: #14161b; color: #e8e6e3; font-family: -apple-system, "PingFang SC", "Noto Sans SC", sans-serif; padding: 28px 16px 60px; }
  .wrap { max-width: 880px; margin: 0 auto; }
  h1 { font-size: 26px; letter-spacing: 1px; }
  h1 .sub { font-size: 13px; color: #8a8f98; font-weight: 400; margin-left: 10px; }
  h2 { font-size: 16px; margin: 26px 0 10px; color: #c8ccd2; }
  h2 .gs { font-size: 12px; color: #6b7280; margin-left: 8px; }
  .stats { display: flex; flex-wrap: wrap; gap: 10px; margin: 18px 0 6px; }
  .st { background: #1d2027; border: 1px solid #2a2e37; border-radius: 10px; padding: 10px 14px; }
  .st b { display: block; font-size: 18px; color: #ffd76a; }
  .st span { font-size: 12px; color: #8a8f98; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(390px, 100%), 1fr)); gap: 12px; }
  .card { display: flex; gap: 14px; align-items: center; background: linear-gradient(135deg, #1d2027, #191c22); border: 1px solid #2a2e37; border-left: 4px solid var(--tc, #2a2e37); border-radius: 12px; padding: 13px 16px; cursor: pointer; position: relative; }
  .card.ok { box-shadow: 0 0 18px -8px var(--tc); }
  .card.plat.ok { background: linear-gradient(135deg, #1d2a2a, #191c22); }
  .card.locked { opacity: .45; filter: grayscale(.6); }
  .card.pick::after { content: "晒"; position: absolute; top: -8px; right: -6px; background: #e8b339; color: #14161b; font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 10px; }
  .ic { font-size: 32px; width: 46px; text-align: center; flex-shrink: 0; }
  .nm { font-weight: 700; font-size: 15px; }
  .tier { font-size: 11px; margin-left: 8px; padding: 1px 8px; border: 1px solid var(--tc); color: var(--tc); border-radius: 20px; vertical-align: 2px; }
  .hdt { border-color: #8458b3; color: #a78bda; }
  .ds { font-size: 12.5px; color: #9aa0aa; margin-top: 3px; }
  .vl { font-size: 12.5px; color: #ffd76a; margin-top: 5px; }
  .locked .vl { color: #6b7280; }
  .pg { height: 5px; background: #2a2e37; border-radius: 4px; margin-top: 8px; overflow: hidden; }
  .pgb { height: 100%; background: linear-gradient(90deg, #6b7280, #ffd76a); border-radius: 4px; }
  .bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; gap: 12px; flex-wrap: wrap; }
  button { background: #2a2e37; color: #e8e6e3; border: 1px solid #3a3f4b; border-radius: 8px; padding: 8px 14px; font-size: 13px; cursor: pointer; }
  .tip { font-size: 12px; color: #565b64; margin-top: 4px; }
  footer { margin-top: 34px; font-size: 12px; color: #565b64; text-align: center; line-height: 1.8; }
  /* 晒图模式 */
  body.share { padding-top: 40px; }
  body.share .wrap { max-width: 620px; }
  body.share h1 { text-align: center; }
  body.share .bar { flex-direction: column; gap: 12px; }
  body.share .stats { justify-content: center; }
  body.share h2, body.share .tip, body.share .st.hideShare { display: none; }
  body.share .grid { grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
  body.share .card { padding: 11px 13px; cursor: default; }
  body.share .card .ds { display: none; }
  body.share .card.locked, body.share .card.noshare { display: none; }
  body.share .card.pick::after { display: none; }
  body.share footer { margin-top: 22px; }
  body.share footer .big { font-size: 14px; color: #9aa0aa; }
</style>
</head>
<body>
<div class="wrap">
  <div class="bar">
    <h1>🏆 我的 vibecoding 成就<span class="sub">解锁 ${unlocked.length} / ${A.length}</span></h1>
    <button onclick="toggleShare()">晒图模式</button>
  </div>
  <div class="stats">
    <div class="st"><b>${isFinite(S.firstTs) ? local(S.firstTs).date : '?'}</b><span>入坑日</span></div>
    <div class="st"><b>${S.sessions}</b><span>会话</span></div>
    <div class="st"><b>${S.days.size}</b><span>活跃天</span></div>
    <div class="st"><b>${yi(totalTokens)}</b><span>累计 token（含缓存）</span></div>
    <div class="st hideShare"><b>${yi(S.tokens.out)}</b><span>输出 token</span></div>
    <div class="st hideShare"><b>${S.toolCalls}</b><span>工具调用</span></div>
    <div class="st hideShare"><b>${S.nightDays.size}</b><span>深夜场</span></div>
  </div>
  <div class="tip">点卡片选中「晒」标记，晒图模式只显示选中的；不选则默认晒金/白金。</div>
${sections}
  <footer><span class="big">数据全部来自本地真实日志，一条没编。</span><br>本地离线生成 · 数据不出这台电脑 · vibe-trophy v0.2（占位名）</footer>
</div>
<script>
function pick(el) {
  if (document.body.classList.contains('share') || el.classList.contains('locked')) return;
  el.classList.toggle('pick');
}
function toggleShare() {
  const b = document.body, cards = [...document.querySelectorAll('.card.ok')];
  if (!b.classList.contains('share')) {
    const picked = cards.filter(c => c.classList.contains('pick'));
    const show = picked.length ? picked : cards.filter(c => /金/.test(c.querySelector('.tier').textContent));
    cards.forEach(c => c.classList.toggle('noshare', !show.includes(c)));
  }
  b.classList.toggle('share');
}
</script>
</body>
</html>`;

fs.writeFileSync(OUT, html);
console.log(`✅ ${OUT}`);
console.log(`解锁 ${unlocked.length}/${A.length}`);
for (const g of GROUPS) console.log(`  ${g}: ${A.filter(a => a.g === g).map(a => (a.ok ? a.icon : '🔒') + a.name).join(' ')}`);
console.log(`会话 ${S.sessions} · 活跃 ${S.days.size} 天 · 累计 ${yi(totalTokens)} token · 峰值 ${yi(S.maxSessionTokens)}/会话 · 连击 ${S.maxBurst} · commit ${S.gitCommits} · 刹车 ${S.interrupts} · 失忆 ${S.compacts}`);
