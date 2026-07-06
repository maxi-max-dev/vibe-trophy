#!/usr/bin/env node
// vibe-trophy v0.5 · 从本地 AI 编程日志生成你的 vibecoding 成就
// 支持: Claude Code / Codex / OpenClaw（适配器架构，有本地日志的平台都能接）
// 用法: node vibe-trophy.js [--tz=Asia/Shanghai] [--out=index.html] [--src=claude,codex,openclaw]
// 只读本地日志，零依赖，不联网，数据不出这台电脑。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const arg = (k, d) => {
  const a = process.argv.find(x => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const TZ = arg('tz', 'Asia/Shanghai');
// npx 跑的时候脚本躺在缓存目录里，输出写到用户当前目录
const BASE = /node_modules|_npx/.test(__dirname) ? process.cwd() : __dirname;
const OUT = path.resolve(BASE, arg('out', 'index.html'));
const ONLY = arg('src', '').split(',').filter(Boolean);

function walk(d, out = []) {
  let es;
  try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}
const H = os.homedir();
const num = (u, ...keys) => { for (const k of keys) if (u && typeof u[k] === 'number') return u[k]; return 0; };
const textOf = c => typeof c === 'string' ? c.trim()
  : Array.isArray(c) ? c.filter(b => (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') && b.text).map(b => b.text.trim()).join('\n').trim() : '';

// ---------- 平台适配器：把各家日志翻译成同一种事件 ----------
// 归一化事件 o: {ts, cwd, model, usage{in,out,cc,cr}, typed, interrupt, images, tools[], aText, compact, limit, side}
const SOURCES = [
  {
    id: 'claude', name: 'Claude Code',
    files: () => walk(path.join(H, '.claude', 'projects')),
    parse(j, raw) {
      const o = { ts: j.timestamp ? Date.parse(j.timestamp) : NaN, cwd: j.cwd, side: j.isSidechain === true };
      if (j.type === 'summary' || j.isCompactSummary) o.compact = true;
      if (/usage limit|rate limit reached|limit reached|额度|上限已/i.test(raw)) o.limit = true;
      const m = j.message;
      if (m) {
        const u = m.usage;
        if (u) o.usage = { in: num(u, 'input_tokens'), out: num(u, 'output_tokens'), cc: num(u, 'cache_creation_input_tokens'), cr: num(u, 'cache_read_input_tokens') };
        if (m.model && m.model !== '<synthetic>') o.model = m.model;
        const c = m.content;
        if (j.type === 'user') {
          o.typed = textOf(c);
          o.interrupt = typeof c === 'string' ? c.includes('[Request interrupted') : Array.isArray(c) && c.some(b => b.type === 'text' && b.text && b.text.includes('[Request interrupted'));
          o.images = Array.isArray(c) ? c.filter(b => b.type === 'image').length : 0;
        } else if (j.type === 'assistant' && Array.isArray(c)) {
          o.tools = c.filter(b => b.type === 'tool_use').map(b => b.name || '');
          o.aText = c.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n');
        }
      }
      return o;
    },
  },
  {
    id: 'codex', name: 'Codex',
    files: () => [...walk(path.join(H, '.codex', 'sessions')), ...walk(path.join(H, '.codex', 'archived_sessions'))],
    parse(j) {
      const p = j.payload || {};
      const o = { ts: j.timestamp ? Date.parse(j.timestamp) : NaN };
      if (j.type === 'session_meta') { o.cwd = p.cwd; return o; }
      if (j.type === 'turn_context') { if (p.model) o.model = `codex/${p.model}`; return o; }
      if (j.type === 'event_msg') {
        if (p.type === 'token_count') {
          const u = p.info && p.info.last_token_usage;
          if (u) o.usage = { in: num(u, 'input_tokens'), out: num(u, 'output_tokens'), cc: 0, cr: num(u, 'cached_input_tokens') };
        }
        if (p.type === 'turn_aborted') o.interrupt = true;
        return o;
      }
      if (j.type === 'response_item') {
        if (p.type === 'message' && p.role === 'user') o.typed = textOf(p.content);
        else if (p.type === 'message' && p.role === 'assistant') o.aText = textOf(p.content);
        else if (p.type === 'function_call' || p.type === 'local_shell_call' || p.type === 'custom_tool_call') o.tools = [p.name || 'shell'];
        return o;
      }
      return o;
    },
  },
  {
    id: 'openclaw', name: 'OpenClaw',
    files: () => walk(path.join(H, '.openclaw', 'agents')).filter(f => /\/sessions\//.test(f) && !f.includes('.trajectory.')),
    parse(j) {
      const o = { ts: j.timestamp ? Date.parse(j.timestamp) : NaN };
      if (j.type === 'session') { o.cwd = j.cwd; return o; }
      if (j.type === 'model_change') { if (j.modelId) o.model = `${j.provider || 'openclaw'}/${j.modelId}`; return o; }
      if (j.type === 'message') {
        const m = j.message || {};
        const u = m.usage;
        if (u) o.usage = { in: num(u, 'input_tokens', 'input'), out: num(u, 'output_tokens', 'output'), cc: num(u, 'cache_creation_input_tokens', 'cacheWrite'), cr: num(u, 'cache_read_input_tokens', 'cacheRead') };
        const c = m.content;
        if (m.role === 'user') {
          o.typed = textOf(c);
          o.images = Array.isArray(c) ? c.filter(b => b.type === 'image').length : 0;
        } else if (m.role === 'assistant') {
          if (Array.isArray(c)) {
            o.tools = c.filter(b => b.type === 'toolCall' || b.type === 'tool_use' || b.type === 'tool-call').map(b => b.name || b.toolName || '');
            o.aText = c.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n');
          } else o.aText = textOf(c);
        }
      }
      return o;
    },
  },
];

// ---------- 时区 ----------
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
  thanks: 0, swears: 0, tiny: 0, repeats: 0, urls: 0, waits: 0, maxWait: 0,
  lunch: new Set(), dinner: new Set(),
  projects: new Set(), longestRun: 0, maxBurst: 0, daySpan: {}, hourSessions: {}, daySessions: {},
  limitHit: false, firstTs: Infinity, lastTs: 0, bySrc: {},
};
const RIGHT_RE = /you'?re absolutely right|你说得对|你是对的/i;
const active = SOURCES.filter(s => (!ONLY.length || ONLY.includes(s.id)));

for (const src of active) {
  const files = src.files();
  if (!files.length) continue;
  const B = S.bySrc[src.id] = { name: src.name, sessions: 0, tokens: 0 };
  for (const f of files) {
    let lines;
    try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { continue; }
    let sTokens = 0, evts = [], humanTs = [], isSide = false, burst = 0, prevTyped = '', fileLastTs = NaN, fileAuto = false;
    for (const raw of lines) {
      if (!raw.trim()) continue;
      let j; try { j = JSON.parse(raw); } catch { continue; }
      let o; try { o = src.parse(j, raw); } catch { continue; }
      if (!o) continue;
      if (o.side) isSide = true;
      if (o.compact) S.compacts++;
      if (o.limit) S.limitHit = true;
      let lineGap = NaN;
      const ts = o.ts;
      if (!isNaN(ts)) {
        if (!isNaN(fileLastTs)) lineGap = ts - fileLastTs;
        fileLastTs = ts;
        evts.push(ts);
        S.firstTs = Math.min(S.firstTs, ts); S.lastTs = Math.max(S.lastTs, ts);
      }
      if (o.cwd) S.projects.add(o.cwd);
      if (o.model) S.models.set(o.model, (S.models.get(o.model) || 0) + 1);
      if (o.usage) {
        const t = o.usage.in + o.usage.out + o.usage.cc + o.usage.cr;
        sTokens += t; B.tokens += t;
        S.tokens.in += o.usage.in; S.tokens.out += o.usage.out; S.tokens.cc += o.usage.cc; S.tokens.cr += o.usage.cr;
      }
      if (o.images) S.images += o.images;
      if (o.interrupt) S.interrupts++;
      if (o.tools) {
        for (const name of o.tools) {
          burst++; S.toolCalls++;
          if (burst > S.maxBurst) S.maxBurst = burst;
          if (name === 'Task' || name === 'Agent') S.taskCalls++;
          if (name === 'AskUserQuestion') S.askCalls++;
          if (/^mcp__/.test(name)) S.mcpCalls++;
        }
        S.msgs++;
      }
      if (o.aText) {
        if (RIGHT_RE.test(o.aText)) S.saidRight++;
        S.msgs++;
      }
      // git commit 检测：CC 的 Bash 工具入参
      if (o.tools && o.tools.includes('Bash') && j.message && Array.isArray(j.message.content)) {
        for (const b of j.message.content) {
          if (b.type === 'tool_use' && b.name === 'Bash' && b.input && typeof b.input.command === 'string' && /git commit/.test(b.input.command)) S.gitCommits++;
        }
      }
      if (typeof o.typed === 'string' && o.typed.length > 0 && !o.interrupt) {
        const typedText = o.typed, typedLen = typedText.length;
        S.msgs++;
        burst = 0; // 真人开口，连击重计
        if (/^\[cron:/.test(typedText)) fileAuto = true; // cron 拉起的会话，不算人肝的
        // 风格统计：跳过工具/系统/cron 注入的消息（<tag> 或 [xxx] 开头）
        if (!/^[<\[]/.test(typedText) && !/<command-|<local-command|<system-reminder/.test(typedText)) {
          if (typedLen > S.maxPromptLen) S.maxPromptLen = typedLen;
          if (typedLen >= 500) S.longPrompts++;
          if (/谢谢|辛苦了|thank/i.test(typedText)) S.thanks++;
          if (/卧槽|我靠|妈的|他妈|tmd|艹|fuck|shit|wtf/i.test(typedText)) S.swears++;
          if (typedLen <= 2) S.tiny++;
          if (/https?:\/\//.test(typedText)) S.urls++;
          if (typedText === prevTyped && typedLen >= 2) S.repeats++;
          prevTyped = typedText;
          if (lineGap >= 2 * 36e5) { S.waits++; if (lineGap > S.maxWait) S.maxWait = lineGap; }
          if (!isNaN(ts)) humanTs.push(ts); // 真人打字时刻，肝度成就的唯一原料
        }
      }
    }
    if (!isSide && evts.length) { S.sessions++; B.sessions++; }
    if (sTokens > S.maxSessionTokens) S.maxSessionTokens = sTokens;
    // 时间类指标（肝度组的原料）只认"真人打字的时刻"：cron 会话不算，代理自动跑的长尾也不算
    if (!fileAuto && humanTs.length) {
      humanTs.sort((a, b) => a - b);
      let run = 0;
      for (let i = 1; i < humanTs.length; i++) {
        if (humanTs[i] - humanTs[i - 1] <= 30 * 60e3) { run += humanTs[i] - humanTs[i - 1]; if (run > S.longestRun) S.longestRun = run; }
        else run = 0;
      }
      for (const ts of humanTs) {
        const { date, hour } = local(ts);
        S.days.add(date);
        if (hour >= 2 && hour < 6) S.nightDays.add(date);
        if (hour === 5) S.dawnDays.add(date);
        if (hour === 12 || hour === 13) S.lunch.add(date);
        if (hour === 18 || hour === 19) S.dinner.add(date);
        if (!S.daySpan[date]) S.daySpan[date] = [ts, ts];
        S.daySpan[date][0] = Math.min(S.daySpan[date][0], ts);
        S.daySpan[date][1] = Math.max(S.daySpan[date][1], ts);
        if (!isSide) {
          (S.hourSessions[`${date}T${hour}`] ||= new Set()).add(f);
          (S.daySessions[date] ||= new Set()).add(f);
        }
      }
    }
  }
  if (!B.sessions) delete S.bySrc[src.id];
}
const srcOn = Object.values(S.bySrc);
if (!S.sessions) { console.error('没找到任何平台的本地日志'); process.exit(1); }

// ---------- 派生指标 ----------
const dayN = d => Math.round(Date.parse(d) / 86400e3);
const consec = set => {
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
const mealBoth = [...S.lunch].filter(d => S.dinner.has(d)).length;
const wknd = [...S.days].filter(d => { const w = new Date(d + 'T00:00:00Z').getUTCDay(); return w === 0 || w === 6; }).length;

const totalTokens = S.tokens.in + S.tokens.out + S.tokens.cc + S.tokens.cr;
const yi = n => n >= 1e8 ? `${(n / 1e8).toFixed(1)} 亿` : n >= 1e4 ? `${(n / 1e4).toFixed(1)} 万` : `${n}`;
const hrs = ms => ms / 36e5;
const h1 = h => `${Math.floor(h)} 小时 ${Math.round(h % 1 * 60)} 分`;
const srcNames = srcOn.map(b => b.name).join(' + ');

// ---------- 成就定义（中英双语）----------
const yiEn = n => n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${n}`;
const h1En = h => `${Math.floor(h)}h ${Math.round(h % 1 * 60)}m`;
const joinDate = isFinite(S.firstTs) ? local(S.firstTs).date : '?';

const A = [
  // 🌱 日常 Daily
  { g: '日常', icon: '👋', name: 'Hello World', nameEn: 'Hello World', tier: '铜', desc: '第一次打开 AI 编程工具，从此再没亲手写过代码', descEn: 'Opened an AI coding tool once; never hand-wrote code again', cur: S.sessions, max: 1, val: `入坑于 ${joinDate}`, valEn: `Joined ${joinDate}` },
  { g: '日常', icon: '🧩', name: '跨栈玩家', nameEn: 'Cross-Stack Player', tier: '金', desc: '同时驯服 2 个以上 AI 编程平台，鸡蛋不放一个篮子', descEn: 'Taming 2+ AI coding platforms at once; eggs, many baskets', cur: srcOn.length, max: 2, val: `${srcOn.length} 个平台：${srcNames}`, valEn: `${srcOn.length} platforms: ${srcNames}` },
  { g: '日常', icon: '🛸', name: '全栈指挥官', nameEn: 'Fleet Commander', tier: '白金', hidden: true, desc: '3 个平台同时在册，你不是用户，你是舰队司令', descEn: '3+ platforms enlisted. You are not a user, you are an admiral', cur: srcOn.length, max: 3, val: `舰队编制：${srcNames}`, valEn: `Fleet: ${srcNames}` },
  { g: '日常', icon: '🗺️', name: '项目海王', nameEn: 'Repo Casanova', tier: '银', desc: '同时撩 10 个以上项目，每一个都说过"这是主线"', descEn: 'Juggling 10+ projects, each one sworn to be "the main one"', cur: S.projects.size, max: 10, val: `${S.projects.size} 个项目`, valEn: `${S.projects.size} project folders` },
  { g: '日常', icon: '🧰', name: '装备党', nameEn: 'Gear Head', tier: '银', desc: 'MCP 工具调用 500 次，工具比活儿多', descEn: '500 MCP tool calls; more tools than tasks', cur: S.mcpCalls, max: 500, val: `${S.mcpCalls} 次 MCP 调用`, valEn: `${S.mcpCalls} MCP calls` },
  { g: '日常', icon: '🖼️', name: '一图胜千言', nameEn: 'Screenshot Diplomat', tier: '铜', desc: '截图一甩："就照这个做"，累计 10 张', descEn: '"Just make it look like this" — 10 screenshots thrown', cur: S.images, max: 10, val: `甩过 ${S.images} 张图`, valEn: `${S.images} images thrown` },
  { g: '日常', icon: '📚', name: '提示词小说家', nameEn: 'Prompt Novelist', tier: '银', desc: '单条消息 500 字起步，这不是 prompt 是需求文档', descEn: '500+ chars in one message; that is not a prompt, that is a spec', cur: S.longPrompts, max: 1, val: `最长一条 ${S.maxPromptLen} 字，超500字共 ${S.longPrompts} 条`, valEn: `Longest ${S.maxPromptLen} chars · ${S.longPrompts} over 500` },
  { g: '日常', icon: '🤏', name: '一字千金', nameEn: 'Man of Few Words', tier: '银', desc: '两个字以内的指令发了 20 条，"继续"就是最强 prompt', descEn: '20 commands of two characters or less; "go" is the strongest prompt', cur: S.tiny, max: 20, val: `${S.tiny} 条极简指令`, valEn: `${S.tiny} micro-commands` },
  { g: '日常', icon: '🔂', name: '复读机', nameEn: 'Broken Record', tier: '铜', desc: '一字不差把同一句话再发一遍，共 5 次。再试一次，再试亿次', descEn: 'Re-sent the exact same message, 5 times. Try again. Try a-gain', cur: S.repeats, max: 5, val: `${S.repeats} 次原句重发`, valEn: `${S.repeats} exact re-sends` },
  { g: '日常', icon: '🧭', name: '导航员', nameEn: 'Link Dealer', tier: '铜', desc: '甩了 50 个链接过去："你自己去看"', descEn: 'Threw 50 URLs: "see for yourself"', cur: S.urls, max: 50, val: `${S.urls} 条带链接消息`, valEn: `${S.urls} messages with links` },
  { g: '日常', icon: '🪞', name: '元成就', nameEn: 'Meta Achievement', tier: '铜', hidden: true, desc: '用一个成就系统，围观自己的成就', descEn: 'Using an achievement system to admire your achievements', cur: 1, max: 1, val: '你正在看它', valEn: "You're looking at it" },
  // 🌙 肝度 Grind
  { g: '肝度', icon: '🌙', name: '凌晨三点俱乐部', nameEn: '3 AM Club', tier: '银', desc: '02:00–06:00 还在 vibe，全世界只剩你和它的 loading', descEn: 'Vibing between 2 and 6 AM; the world is just you and a loading spinner', cur: S.nightDays.size, max: 1, val: `${S.nightDays.size} 个深夜`, valEn: `${S.nightDays.size} late nights` },
  { g: '肝度', icon: '🧛', name: '吸血鬼作息', nameEn: 'Vampire Schedule', tier: '金', desc: '连续 3 天深夜营业，太阳升起前必须收工', descEn: '3 nights in a row; wrap up before sunrise', cur: vampStreak, max: 3, val: `连续 ${vampStreak} 天深夜在线`, valEn: `${vampStreak} consecutive late nights` },
  { g: '肝度', icon: '🌅', name: '日出见证者', nameEn: 'Sunrise Witness', tier: '金', hidden: true, desc: '清晨五点还在线。没人知道你是没睡，还是刚醒', descEn: 'Online at 5 AM. Nobody knows if you stayed up or got up', cur: S.dawnDays.size, max: 1, val: `${S.dawnDays.size} 次日出`, valEn: `${S.dawnDays.size} sunrises` },
  { g: '肝度', icon: '📅', name: '七天连勤', nameEn: 'Seven-Day Streak', tier: '银', desc: '连续 7 天有会话。休息？那是模型维护日干的事', descEn: 'Sessions 7 days straight. Rest is for model maintenance days', cur: bestStreak, max: 7, val: `最长连勤 ${bestStreak} 天`, valEn: `Longest streak ${bestStreak} days` },
  { g: '肝度', icon: '🏃', name: '马拉松选手', nameEn: 'Marathon Runner', tier: '金', desc: '一口气连续会话 6 小时，断档半小时算休息', descEn: '6 hours in one sitting; a 30-minute gap counts as rest', cur: +hrs(S.longestRun).toFixed(1), max: 6, val: `最长 ${h1(hrs(S.longestRun))}`, valEn: `Longest ${h1En(hrs(S.longestRun))}`, hint: '坐下，别起来', hintEn: 'Sit down. Stay.' },
  { g: '肝度', icon: '🧘', name: '全天候 Vibe', nameEn: 'Round-the-Clock Vibe', tier: '白金', desc: '睁眼第一件事和闭眼最后一件事是同一件事，单日跨度 16 小时', descEn: 'First and last thing of the day is the same thing: a 16-hour span', cur: +maxDaySpanH.toFixed(1), max: 16, val: `单日跨度 ${maxDaySpanH.toFixed(1)} 小时`, valEn: `${maxDaySpanH.toFixed(1)}h span in one day` },
  { g: '肝度', icon: '🗓️', name: '日理万机', nameEn: 'Overbooked', tier: '金', desc: '单日开 15 场会话，每个窗口都在"快好了"', descEn: '15 sessions in one day, every window "almost done"', cur: maxDayS, max: 15, val: `单日最多 ${maxDayS} 场`, valEn: `Up to ${maxDayS} sessions a day` },
  { g: '肝度', icon: '🎪', name: '多线程人格', nameEn: 'Multithreaded Personality', tier: '金', desc: '同一小时 3 路会话并行：左手报错，右手"你说得对"', descEn: '3 sessions in the same hour: errors on the left, "absolutely right" on the right', cur: maxPara, max: 3, val: `最高并行 ${maxPara} 路`, valEn: `${maxPara} sessions in parallel` },
  { g: '肝度', icon: '🔁', name: '我又回来了', nameEn: 'Back Again', tier: '铜', hidden: true, desc: '戒了 7 天，还是回来了', descEn: 'Quit for 7 days. Came back anyway', cur: comeback ? 1 : 0, max: 1, val: '欢迎回家', valEn: 'Welcome home' },
  { g: '肝度', icon: '🍜', name: '饭点不存在', nameEn: 'Meals Are Optional', tier: '银', desc: '午饭点和晚饭点都在线，共 10 天。干饭不如干活', descEn: 'Online at both lunch and dinner, 10 days', cur: mealBoth, max: 10, val: `${mealBoth} 天午晚连线`, valEn: `${mealBoth} days lunch + dinner online` },
  { g: '肝度', icon: '🌤️', name: '周末战士', nameEn: 'Weekend Warrior', tier: '铜', desc: '周六周日也在线 10 天，双休是不存在的', descEn: 'Online on 10 weekend days; weekends are a myth', cur: wknd, max: 10, val: `周末上线 ${wknd} 天`, valEn: `${wknd} weekend days online` },
  // 💸 钞能力 Cash Burn
  { g: '钞能力', icon: '🔥', name: '烧 token 大户', nameEn: 'Token Furnace', tier: '金', desc: '单次会话烧掉 5000 万 token，电表都没你转得快', descEn: '50M+ tokens in one session; faster than your power meter', cur: S.maxSessionTokens, max: 5e7, val: `单会话纪录 ${yi(S.maxSessionTokens)}`, valEn: `Record ${yiEn(S.maxSessionTokens)} in one session`, fmt: yi, fmtEn: yiEn },
  { g: '钞能力', icon: '💯', name: '亿级玩家', nameEn: 'Hundred-Million Club', tier: '白金', hidden: true, desc: '单会话破 1 亿 token。致敬传说中 1.2 亿的那位', descEn: '100M+ tokens in one session. Tribute to the legendary 120M guy', cur: S.maxSessionTokens, max: 1e8, val: `单会话纪录 ${yi(S.maxSessionTokens)}`, valEn: `Record ${yiEn(S.maxSessionTokens)} in one session`, fmt: yi, fmtEn: yiEn },
  { g: '钞能力', icon: '🐷', name: '缓存白嫖怪', nameEn: 'Cache Freeloader', tier: '金', desc: '缓存命中累计 10 亿 token，省下的都是赚的', descEn: '1B+ cached tokens; every hit is free money', cur: S.tokens.cr, max: 1e9, val: `白嫖 ${yi(S.tokens.cr)}`, valEn: `${yiEn(S.tokens.cr)} freeloaded`, fmt: yi, fmtEn: yiEn },
  { g: '钞能力', icon: '🚧', name: '额度撞墙', nameEn: 'Rate-Limit Survivor', tier: '银', hidden: true, desc: '撞过用量上限还回来继续，墙都不服就服你', descEn: 'Hit the usage wall and came back for more', cur: S.limitHit ? 1 : 0, max: 1, val: '这面墙记住你了', valEn: 'The wall remembers you' },
  // 🎮 微操 Micro-ops
  { g: '微操', icon: '🏗️', name: '包工头', nameEn: 'The Foreman', tier: '金', desc: '派出 100 个子代理，精通自己不干活的艺术', descEn: '100 subagents dispatched; the art of not doing the work yourself', cur: S.taskCalls, max: 100, val: `已派 ${S.taskCalls} 个分身`, valEn: `${S.taskCalls} clones dispatched` },
  { g: '微操', icon: '🧨', name: '一句话工程', nameEn: 'One-Prompt Wonder', tier: '金', desc: '一条指令，AI 连打 50 个工具调用不带喘', descEn: 'One instruction, 50+ tool calls without catching a breath', cur: S.maxBurst, max: 50, val: `最长连击 ${S.maxBurst}`, valEn: `Longest combo ${S.maxBurst}` },
  { g: '微操', icon: '🫡', name: '你说得对学派', nameEn: '"You\'re Absolutely Right"', tier: '银', desc: '被 AI 说过 50 次"你说得对"，而你确实说得对', descEn: 'Heard it 50 times. And you absolutely were', cur: S.saidRight, max: 50, val: `${S.saidRight} 次`, valEn: `${S.saidRight} times` },
  { g: '微操', icon: '🛑', name: '刹车侠', nameEn: 'Emergency Brake', tier: '银', desc: '按 20 次 Esc 打断输出。刹车是最后的尊严', descEn: '20 Esc presses; the brake is your last dignity', cur: S.interrupts, max: 20, val: `踩了 ${S.interrupts} 脚刹车`, valEn: `${S.interrupts} brakes` },
  { g: '微操', icon: '🚢', name: 'Ship 机器', nameEn: 'Ship Machine', tier: '金', desc: '经手 100 个 commit，信息还都写得比你好', descEn: '100 commits, with messages written better than yours', cur: S.gitCommits, max: 100, val: `${S.gitCommits} 个 commit`, valEn: `${S.gitCommits} commits` },
  { g: '微操', icon: '💥', name: '上下文爆破手', nameEn: 'Context Bomber', tier: '银', desc: '把对话聊到失忆 10 次，compact 是一种境界', descEn: 'Talked the AI into amnesia 10 times; compaction is a lifestyle', cur: S.compacts, max: 10, val: `${S.compacts} 次失忆`, valEn: `${S.compacts} blackouts` },
  { g: '微操', icon: '🎰', name: '全家桶收集者', nameEn: 'Model Collector', tier: '银', desc: '用过 3 种以上模型：有的干活，有的跑腿，有的背锅', descEn: '3+ models: one works, one runs errands, one takes the blame', cur: S.models.size, max: 3, val: `${S.models.size} 种模型`, valEn: `${S.models.size} models` },
  { g: '微操', icon: '🙋', name: '甲方本人', nameEn: 'The Client', tier: '铜', desc: '被 AI 反过来追问 20 次需求，这就是话语权', descEn: 'The AI asked YOU for requirements 20 times; that is leverage', cur: S.askCalls, max: 20, val: `被追问 ${S.askCalls} 次`, valEn: `Asked ${S.askCalls} times` },
  { g: '微操', icon: '🙏', name: '人机礼仪模范', nameEn: 'Politeness Award', tier: '铜', desc: '对 AI 说了 20 次谢谢。它记不住，但你是好人', descEn: 'Said thanks 20 times. It will not remember, but you are a good person', cur: S.thanks, max: 20, val: `${S.thanks} 次感谢`, valEn: `${S.thanks} thanks` },
  { g: '微操', icon: '🤬', name: '口吐芬芳', nameEn: 'Potty Mouth', tier: '金', hidden: true, desc: '对 AI 爆了 10 次粗口。致敬 2012 年 Visual Studio 成就系统的 Potty Mouth', descEn: 'Swore at the AI 10 times. A tribute to Visual Studio Achievements (2012)', cur: S.swears, max: 10, val: `${S.swears} 次真情流露`, valEn: `${S.swears} heartfelt outbursts` },
  { g: '微操', icon: '⏳', name: '已读不回', nameEn: 'Left on Read', tier: '金', hidden: true, desc: 'AI 答完干等你 2 小时起步，共 5 次。它不困，你先睡', descEn: 'The AI answered, you vanished for 2+ hours, 5 times. It is not tired; you sleep first', cur: S.waits, max: 5, val: `共 ${S.waits} 次，最长晾了 ${(S.maxWait / 36e5).toFixed(1)} 小时`, valEn: `${S.waits} times · longest ${(S.maxWait / 36e5).toFixed(1)}h ghost` },
];
for (const a of A) a.ok = a.cur >= a.max;
const unlocked = A.filter(a => a.ok);

// ---------- 渲染（双语）----------
const TIER_COLOR = { '铜': '#b08d57', '银': '#9fb4c7', '金': '#e8b339', '白金': '#7fd4d0' };
const GROUPS = ['日常', '肝度', '钞能力', '微操'];
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const UI = {
  zh: {
    lang: 'zh', title: '我的 vibecoding 成就', doc: '我的 vibecoding 成就',
    unlockedTxt: (u, t) => `解锁 ${u} / ${t}`, share: '晒图模式', switchHref: 'en.html', switchTxt: 'EN',
    stats: ['入坑日', '会话', '活跃天', '累计 token（含缓存）', '输出 token', '工具调用', '深夜场'],
    srcsLine: (n, parts) => `🧩 已接入 <b>${n}</b> 个平台：${parts}`, sess: '场',
    tip: '点卡片选中「晒」标记，晒图模式只显示选中的；不选则默认晒金/白金。',
    hiddenName: '隐藏成就', hiddenDesc: '继续 vibe，总会撞见的', lockedTxt: '未解锁', hiddenTag: '隐藏',
    groups: { '日常': '🌱 日常', '肝度': '🌙 肝度', '钞能力': '💸 钞能力', '微操': '🎮 微操' },
    tiers: { '铜': '铜', '银': '银', '金': '金', '白金': '白金' },
    foot1: '数据全部来自本地真实日志，一条没编。',
    foot2: (n, names) => `已接入 ${n} 平台（${names}）· 本地离线生成 · 数据不出这台电脑`,
    exportBtn: '导出图片', copyBtn: '复制战绩', copied: '✅ 已复制', shareHeader: '我的 vibecoding 成就', moreTxt: n => `…还有 ${n} 项`, fromLogs: '数据来自本地真实日志',
  },
  en: {
    lang: 'en', title: 'My Vibecoding Achievements', doc: 'My Vibecoding Achievements',
    unlockedTxt: (u, t) => `${u} / ${t} unlocked`, share: 'Share mode', switchHref: 'index.html', switchTxt: '中',
    stats: ['Joined', 'Sessions', 'Active days', 'Total tokens (incl. cache)', 'Output tokens', 'Tool calls', 'Late nights'],
    srcsLine: (n, parts) => `🧩 <b>${n}</b> platforms connected: ${parts}`, sess: 'sessions',
    tip: 'Click cards to mark them for sharing; share mode shows only marked cards (default: gold & platinum).',
    hiddenName: 'Hidden achievement', hiddenDesc: 'Keep vibing, you will bump into it', lockedTxt: 'Locked', hiddenTag: 'hidden',
    groups: { '日常': '🌱 Daily', '肝度': '🌙 Grind', '钞能力': '💸 Cash Burn', '微操': '🎮 Micro-ops' },
    tiers: { '铜': 'Bronze', '银': 'Silver', '金': 'Gold', '白金': 'Platinum' },
    foot1: 'Every number comes from local logs. Nothing made up.',
    foot2: (n, names) => `${n} platforms connected (${names}) · generated offline · your data never leaves this machine`,
    exportBtn: 'Export PNG', copyBtn: 'Copy stats', copied: '✅ Copied', shareHeader: 'My Vibecoding Achievements', moreTxt: n => `…and ${n} more`, fromLogs: 'straight from local logs',
  },
};

function render(L) {
  const T = t => L.tiers[t];
  const pick = (a, zh, en) => L.lang === 'en' ? (a[en] ?? a[zh]) : a[zh];
  const card = a => {
    const lock = !a.ok;
    if (lock && a.hidden) return `<div class="card locked hid"><div class="plaque"><span class="ic">❓</span></div><div class="meta"><div class="nm">${L.hiddenName}</div><div class="ds">${L.hiddenDesc}</div></div></div>`;
    const f = (L.lang === 'en' ? a.fmtEn : a.fmt) || (x => x);
    const pct = Math.min(100, Math.round(a.cur / a.max * 100));
    const hint = pick(a, 'hint', 'hintEn');
    const prog = lock && a.max > 1
      ? `<div class="pg"><div class="pgb" style="width:${pct}%"></div></div><div class="vl">${f(a.cur)} / ${f(a.max)}${hint ? ` · ${esc(hint)}` : ''}</div>`
      : `<div class="vl">${lock ? esc(hint || L.lockedTxt) : esc(pick(a, 'val', 'valEn'))}</div>`;
    return `<div class="card ${lock ? 'locked' : 'ok'}${a.tier === '白金' ? ' plat' : ''}" style="--tc:${TIER_COLOR[a.tier]}" onclick="pick(this)">
    <div class="plaque"><span class="ic">${lock ? '🔒' : a.icon}</span></div>
    <div class="meta">
      <div class="nm">${esc(pick(a, 'name', 'nameEn'))}<span class="tier">${T(a.tier)}</span>${a.hidden ? `<span class="tier hdt">${L.hiddenTag}</span>` : ''}</div>
      <div class="ds">${esc(pick(a, 'desc', 'descEn'))}</div>
      ${prog}
    </div></div>`;
  };
  const sections = GROUPS.map(g => `
  <h2><span>${L.groups[g]}</span><span class="gs">${A.filter(a => a.g === g && a.ok).length}/${A.filter(a => a.g === g).length}</span><span class="rule"></span></h2>
  <div class="grid">${A.filter(a => a.g === g).map(card).join('\n')}</div>`).join('\n');
  const statVals = [joinDate, S.sessions, S.days.size, yi(totalTokens), yi(S.tokens.out), S.toolCalls, S.nightDays.size];
  const statValsEn = [joinDate, S.sessions, S.days.size, yiEn(totalTokens), yiEn(S.tokens.out), S.toolCalls, S.nightDays.size];
  const sv = L.lang === 'en' ? statValsEn : statVals;
  const srcParts = srcOn.map(b => `<b>${esc(b.name)}</b> ${b.sessions} ${L.sess}`).join(' · ');
  const headLine = L.lang === 'en'
    ? `🏆 ${L.shareHeader} — ${L.unlockedTxt(unlocked.length, A.length)} (${L.fromLogs})`
    : `🏆 ${L.shareHeader} ${L.unlockedTxt(unlocked.length, A.length)}（${L.fromLogs}）`;

  return `<!DOCTYPE html>
<html lang="${L.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${L.doc}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🏆</text></svg>">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; }
  body {
    background: #101216;
    background-image: radial-gradient(900px 500px at 8% -10%, rgba(232,179,57,.07), transparent 60%),
                      radial-gradient(800px 500px at 95% -5%, rgba(127,212,208,.05), transparent 55%);
    color: #e8e6e3; font-family: -apple-system, "PingFang SC", "Noto Sans SC", sans-serif;
    padding: 34px 16px 60px; line-height: 1.45;
  }
  .wrap { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 27px; letter-spacing: .5px; }
  h1 .sub { font-size: 13px; color: #8a8f98; font-weight: 500; margin-left: 12px; background: #1d2027; border: 1px solid #2f3440; padding: 3px 10px; border-radius: 20px; vertical-align: 4px; }
  h2 { display: flex; align-items: center; gap: 10px; font-size: 15px; margin: 30px 0 12px; color: #c8ccd2; letter-spacing: 1px; }
  h2 .gs { font-size: 12px; color: #6b7280; font-weight: 500; }
  h2 .rule { flex: 1; height: 1px; background: linear-gradient(90deg, #2a2e37, transparent); }
  .bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; gap: 12px; flex-wrap: wrap; }
  .actions { display: flex; gap: 8px; align-items: center; }
  .stats { display: flex; flex-wrap: wrap; gap: 10px; margin: 16px 0 8px; }
  .st { background: linear-gradient(160deg, #1d2027, #181b21); border: 1px solid #2a2e37; border-radius: 12px; padding: 10px 15px; min-width: 86px; }
  .st b { display: block; font-size: 19px; color: #ffd76a; font-variant-numeric: tabular-nums; }
  .st span { font-size: 11.5px; color: #8a8f98; }
  .srcs { font-size: 12.5px; color: #8a8f98; margin: 6px 0 0; }
  .srcs b { color: #c8ccd2; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(400px, 100%), 1fr)); gap: 12px; }
  .card { display: flex; gap: 14px; align-items: center; background: linear-gradient(135deg, #1c1f26, #171a20); border: 1px solid #262b34; border-radius: 14px; padding: 13px 15px; cursor: pointer; position: relative; transition: transform .15s ease, box-shadow .15s ease; }
  .card.ok { border-color: color-mix(in srgb, var(--tc) 45%, #262b34); box-shadow: 0 0 22px -10px var(--tc), inset 0 1px 0 rgba(255,255,255,.03); }
  .card.ok:hover { transform: translateY(-2px); box-shadow: 0 6px 26px -10px var(--tc); }
  .card.plat.ok { background: linear-gradient(135deg, #1a2626, #171a20); animation: platGlow 3.2s ease-in-out infinite; }
  @keyframes platGlow { 0%,100% { box-shadow: 0 0 18px -10px var(--tc); } 50% { box-shadow: 0 0 30px -8px var(--tc); } }
  .card.locked { opacity: .42; filter: grayscale(.65); }
  .card.pick::after { content: "晒"; position: absolute; top: -8px; right: -6px; background: #e8b339; color: #14161b; font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,.4); }
  html[lang=en] .card.pick::after { content: "★"; }
  .plaque { width: 52px; height: 52px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: #14161b; border: 1.5px solid color-mix(in srgb, var(--tc, #3a3f4b) 60%, transparent); border-radius: 13px; box-shadow: inset 0 0 12px rgba(0,0,0,.5); }
  .locked .plaque { border-color: #2a2e37; }
  .ic { font-size: 27px; }
  .nm { font-weight: 700; font-size: 15px; }
  .tier { font-size: 10.5px; margin-left: 8px; padding: 1.5px 8px; border-radius: 20px; vertical-align: 2px; color: var(--tc); background: color-mix(in srgb, var(--tc) 13%, transparent); border: 1px solid color-mix(in srgb, var(--tc) 45%, transparent); }
  .hdt { color: #a78bda; background: rgba(132, 88, 179, .14); border-color: rgba(167, 139, 218, .4); }
  .ds { font-size: 12.5px; color: #9aa0aa; margin-top: 3px; }
  .vl { font-size: 12.5px; color: #ffd76a; margin-top: 6px; font-variant-numeric: tabular-nums; }
  .locked .vl { color: #6b7280; }
  .pg { height: 6px; background: #262b34; border-radius: 4px; margin-top: 9px; overflow: hidden; }
  .pgb { height: 100%; background: linear-gradient(90deg, #7a6a45, #ffd76a); border-radius: 4px; }
  button, .lswitch { background: #1d2027; color: #e8e6e3; border: 1px solid #2f3440; border-radius: 9px; padding: 8px 14px; font-size: 13px; cursor: pointer; text-decoration: none; transition: border-color .15s; }
  button:hover, .lswitch:hover { border-color: #e8b339; }
  .tip { font-size: 12px; color: #565b64; margin-top: 6px; }
  footer { margin-top: 38px; font-size: 12px; color: #565b64; text-align: center; line-height: 1.9; }
  footer .big { font-size: 14px; color: #9aa0aa; }
  footer .brand { color: #8a8f98; letter-spacing: .5px; }
  footer .brand b { color: #ffd76a; }
  /* 晒图模式 / share mode */
  body.share { padding-top: 42px; }
  body.share .wrap { max-width: 640px; border: 1px solid #262b34; border-radius: 22px; padding: 28px 22px 24px; background: linear-gradient(180deg, #14171c, #101216); }
  body.share h1 { text-align: center; }
  body.share .bar { flex-direction: column; gap: 12px; }
  body.share .stats { justify-content: center; }
  body.share h2, body.share .tip, body.share .st.hideShare, body.share .lswitch { display: none; }
  body.share .srcs { text-align: center; }
  body.share .grid { grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
  body.share .card { padding: 11px 13px; cursor: default; }
  body.share .card .ds { display: none; }
  body.share .card.locked, body.share .card.noshare { display: none; }
  body.share .card.pick::after { display: none; }
  body.share footer { margin-top: 24px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="bar">
    <h1>🏆 ${L.title}<span class="sub">${L.unlockedTxt(unlocked.length, A.length)}</span></h1>
    <div class="actions"><a class="lswitch" href="${L.switchHref}">${L.switchTxt}</a><button id="copyBtn" onclick="copyStats()">${L.copyBtn}</button><button onclick="exportPng()">${L.exportBtn}</button><button onclick="toggleShare()">${L.share}</button></div>
  </div>
  <div class="stats">
${sv.map((v, i) => `    <div class="st${i >= 4 ? ' hideShare' : ''}"><b>${v}</b><span>${L.stats[i]}</span></div>`).join('\n')}
  </div>
  <div class="srcs">${L.srcsLine(srcOn.length, srcParts)}</div>
  <div class="tip">${L.tip}</div>
${sections}
  <footer><span class="big">${L.foot1}</span><br>${L.foot2(srcOn.length, esc(srcNames))}<br><span class="brand">🏆 <b>vibe-trophy</b> · github.com/maxi-max-dev/vibe-trophy</span></footer>
</div>
<script>
const SHARE_TITLE = ${JSON.stringify('🏆 ' + L.shareHeader)};
const SHARE_SUB = ${JSON.stringify(L.unlockedTxt(unlocked.length, A.length))};
const SHARE_HEAD = ${JSON.stringify(headLine)};
const MORE_TXT = ${JSON.stringify(L.moreTxt('{n}'))};
const COPIED_TXT = ${JSON.stringify(L.copied)};
const STATS4 = ${JSON.stringify(sv.slice(0, 4).map((v, i) => ({ v: String(v), l: L.stats[i] })))};
const SEP = ${JSON.stringify(L.lang === 'en' ? ': ' : '：')};
const REPO_URL = 'github.com/maxi-max-dev/vibe-trophy';
function pick(el) {
  if (document.body.classList.contains('share') || el.classList.contains('locked')) return;
  el.classList.toggle('pick');
}
function shareSet(cap) {
  const cards = [...document.querySelectorAll('.card.ok')];
  const picked = cards.filter(c => c.classList.contains('pick'));
  const tc = c => getComputedStyle(c).getPropertyValue('--tc').trim();
  let set = picked.length ? picked
    : [...cards.filter(c => tc(c) === '#7fd4d0'), ...cards.filter(c => tc(c) === '#e8b339')];
  return cap ? set.slice(0, cap) : set;
}
function rowData(c) {
  return {
    icon: c.querySelector('.ic').textContent,
    name: c.querySelector('.nm').childNodes[0].textContent,
    tier: c.querySelector('.tier').textContent,
    val: c.querySelector('.vl').textContent,
    color: getComputedStyle(c).getPropertyValue('--tc').trim() || '#e8b339',
  };
}
function toggleShare() {
  const b = document.body, cards = [...document.querySelectorAll('.card.ok')];
  if (!b.classList.contains('share')) {
    const show = shareSet(0);
    cards.forEach(c => c.classList.toggle('noshare', !show.includes(c)));
  }
  b.classList.toggle('share');
}
function rr(x, a, b, w, h, r) { x.beginPath(); x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r); x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath(); }
function exportPng() {
  const all = shareSet(0), rows = all.slice(0, 8).map(rowData), extra = all.length - rows.length;
  const W = 1080, Hh = 1350, F = '-apple-system, "PingFang SC", "Noto Sans SC", sans-serif';
  const cv = document.createElement('canvas'); cv.width = W; cv.height = Hh;
  const x = cv.getContext('2d');
  x.fillStyle = '#101216'; x.fillRect(0, 0, W, Hh);
  const g = x.createRadialGradient(180, -80, 0, 180, -80, 950);
  g.addColorStop(0, 'rgba(232,179,57,0.10)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, W, Hh);
  x.strokeStyle = '#2a2e37'; x.lineWidth = 2; rr(x, 26, 26, W - 52, Hh - 52, 30); x.stroke();
  x.textBaseline = 'middle';
  x.fillStyle = '#e8e6e3'; x.font = '700 50px ' + F; x.fillText(SHARE_TITLE, 72, 122);
  x.fillStyle = '#8a8f98'; x.font = '400 27px ' + F; x.fillText(SHARE_SUB, 72, 180);
  let sx = 72;
  STATS4.forEach(s => {
    x.fillStyle = '#ffd76a'; x.font = '700 40px ' + F; x.fillText(s.v, sx, 264);
    const vw = x.measureText(s.v).width;
    x.fillStyle = '#8a8f98'; x.font = '400 21px ' + F; x.fillText(s.l, sx, 304);
    sx += Math.max(vw, x.measureText(s.l).width) + 52;
  });
  let y = 402;
  rows.forEach(r => {
    x.fillStyle = '#1c1f26'; rr(x, 72, y - 46, W - 144, 92, 18); x.fill();
    x.strokeStyle = r.color; x.lineWidth = 1.5; rr(x, 72, y - 46, W - 144, 92, 18); x.stroke();
    x.fillStyle = r.color; rr(x, 72, y - 46, 7, 92, 3); x.fill();
    x.font = '40px ' + F; x.fillText(r.icon, 102, y + 2);
    x.fillStyle = '#e8e6e3'; x.font = '700 31px ' + F; x.fillText(r.name, 172, y - 15);
    const nw = x.measureText(r.name).width;
    x.fillStyle = r.color; x.font = '400 21px ' + F; x.fillText(r.tier, 172 + nw + 16, y - 13);
    x.fillStyle = '#ffd76a'; x.font = '400 25px ' + F; x.fillText(r.val, 172, y + 26);
    y += 104;
  });
  if (extra > 0) { x.fillStyle = '#6b7280'; x.font = '400 25px ' + F; x.fillText(MORE_TXT.replace('{n}', extra), 84, y); }
  x.fillStyle = '#8a8f98'; x.font = '400 23px ' + F; x.fillText('🏆 vibe-trophy · ' + REPO_URL, 72, Hh - 82);
  cv.toBlob(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'vibe-trophy.png'; a.click(); });
}
function copyStats() {
  const lines = [SHARE_HEAD];
  shareSet(6).map(rowData).forEach(r => lines.push(r.icon + ' ' + r.name + SEP + r.val));
  lines.push('👉 https://' + REPO_URL);
  navigator.clipboard.writeText(lines.join('\\n')).then(() => {
    const b = document.getElementById('copyBtn'), t = b.textContent;
    b.textContent = COPIED_TXT; setTimeout(() => { b.textContent = t; }, 1500);
  });
}
</script>
</body>
</html>`;
}

fs.writeFileSync(OUT, render(UI.zh));
const OUT_EN = path.join(path.dirname(OUT), 'en.html');
fs.writeFileSync(OUT_EN, render(UI.en));
console.log(`✅ ${OUT}`);
console.log(`✅ ${OUT_EN} (English)`);
console.log(`平台: ${srcOn.map(b => `${b.name} ${b.sessions} 场/${yi(b.tokens)} token`).join(' · ')}`);
console.log(`解锁 ${unlocked.length}/${A.length}`);
for (const g of GROUPS) console.log(`  ${g}: ${A.filter(a => a.g === g).map(a => (a.ok ? a.icon : '🔒') + a.name).join(' ')}`);
console.log(`会话 ${S.sessions} · 活跃 ${S.days.size} 天 · 累计 ${yi(totalTokens)} token · 峰值 ${yi(S.maxSessionTokens)}/会话 · 连击 ${S.maxBurst} · 模型 ${S.models.size} 种`);
