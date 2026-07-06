#!/usr/bin/env node
// vibe-trophy（占位名）v0.4 · 从本地 AI 编程日志生成你的 vibecoding 成就
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
const OUT = path.resolve(__dirname, arg('out', 'index.html'));
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
    let sTokens = 0, evts = [], isSide = false, burst = 0, prevTyped = '', fileLastTs = NaN, fileAuto = false;
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
        }
      }
    }
    if (!isSide && evts.length) { S.sessions++; B.sessions++; }
    if (sTokens > S.maxSessionTokens) S.maxSessionTokens = sTokens;
    // 时间类指标（肝度组的原料）只算人类会话，cron 拉起的不算
    if (!fileAuto && evts.length) {
      evts.sort((a, b) => a - b);
      let run = 0;
      for (let i = 1; i < evts.length; i++) {
        if (evts[i] - evts[i - 1] <= 30 * 60e3) { run += evts[i] - evts[i - 1]; if (run > S.longestRun) S.longestRun = run; }
        else run = 0;
      }
      for (const ts of evts) {
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

// ---------- 成就定义 ----------
const A = [
  // 🌱 日常
  { g: '日常', icon: '👋', name: 'Hello World', tier: '铜', desc: '第一次打开 AI 编程工具，从此再没亲手写过代码', cur: S.sessions, max: 1, val: `入坑于 ${isFinite(S.firstTs) ? local(S.firstTs).date : '?'}` },
  { g: '日常', icon: '🧩', name: '跨栈玩家', tier: '金', desc: '同时驯服 2 个以上 AI 编程平台，鸡蛋不放一个篮子', cur: srcOn.length, max: 2, val: `${srcOn.length} 个平台：${srcNames}` },
  { g: '日常', icon: '🛸', name: '全栈指挥官', tier: '白金', hidden: true, desc: '3 个平台同时在册，你不是用户，你是舰队司令', cur: srcOn.length, max: 3, val: `舰队编制：${srcNames}` },
  { g: '日常', icon: '🗺️', name: '项目海王', tier: '银', desc: '同时撩 10 个以上项目，每一个都说过"这是主线"', cur: S.projects.size, max: 10, val: `${S.projects.size} 个项目` },
  { g: '日常', icon: '🧰', name: '装备党', tier: '银', desc: 'MCP 工具调用 500 次，工具比活儿多', cur: S.mcpCalls, max: 500, val: `${S.mcpCalls} 次 MCP 调用` },
  { g: '日常', icon: '🖼️', name: '一图胜千言', tier: '铜', desc: '截图一甩："就照这个做"，累计 10 张', cur: S.images, max: 10, val: `甩过 ${S.images} 张图` },
  { g: '日常', icon: '📚', name: '提示词小说家', tier: '银', desc: '单条消息 500 字起步，这不是 prompt 是需求文档', cur: S.longPrompts, max: 1, val: `最长一条 ${S.maxPromptLen} 字，超500字共 ${S.longPrompts} 条` },
  { g: '日常', icon: '🤏', name: '一字千金', tier: '银', desc: '两个字以内的指令发了 20 条，"继续"就是最强 prompt', cur: S.tiny, max: 20, val: `${S.tiny} 条极简指令` },
  { g: '日常', icon: '🔂', name: '复读机', tier: '铜', desc: '一字不差把同一句话再发一遍，共 5 次。再试一次，再试亿次', cur: S.repeats, max: 5, val: `${S.repeats} 次原句重发` },
  { g: '日常', icon: '🧭', name: '导航员', tier: '铜', desc: '甩了 50 个链接过去："你自己去看"', cur: S.urls, max: 50, val: `${S.urls} 条带链接消息` },
  { g: '日常', icon: '🪞', name: '元成就', tier: '铜', hidden: true, desc: '用一个成就系统，围观自己的成就', cur: 1, max: 1, val: '你正在看它' },
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
  { g: '肝度', icon: '🍜', name: '饭点不存在', tier: '银', desc: '午饭点和晚饭点都在线，共 10 天。干饭不如干活', cur: mealBoth, max: 10, val: `${mealBoth} 天午晚连线` },
  { g: '肝度', icon: '🌤️', name: '周末战士', tier: '铜', desc: '周六周日也在线 10 天，双休是不存在的', cur: wknd, max: 10, val: `周末上线 ${wknd} 天` },
  // 💸 钞能力
  { g: '钞能力', icon: '🔥', name: '烧 token 大户', tier: '金', desc: '单次会话烧掉 5000 万 token，电表都没你转得快', cur: S.maxSessionTokens, max: 5e7, val: `单会话纪录 ${yi(S.maxSessionTokens)}`, fmt: yi },
  { g: '钞能力', icon: '💯', name: '亿级玩家', tier: '白金', hidden: true, desc: '单会话破 1 亿 token。致敬传说中 1.2 亿的那位', cur: S.maxSessionTokens, max: 1e8, val: `单会话纪录 ${yi(S.maxSessionTokens)}`, fmt: yi },
  { g: '钞能力', icon: '🐷', name: '缓存白嫖怪', tier: '金', desc: '缓存命中累计 10 亿 token，省下的都是赚的', cur: S.tokens.cr, max: 1e9, val: `白嫖 ${yi(S.tokens.cr)}`, fmt: yi },
  { g: '钞能力', icon: '🚧', name: '额度撞墙', tier: '银', hidden: true, desc: '撞过用量上限还回来继续，墙都不服就服你', cur: S.limitHit ? 1 : 0, max: 1, val: '这面墙记住你了' },
  // 🎮 微操
  { g: '微操', icon: '🏗️', name: '包工头', tier: '金', desc: '派出 100 个子代理，精通自己不干活的艺术', cur: S.taskCalls, max: 100, val: `已派 ${S.taskCalls} 个分身` },
  { g: '微操', icon: '🧨', name: '一句话工程', tier: '金', desc: '一条指令，AI 连打 50 个工具调用不带喘', cur: S.maxBurst, max: 50, val: `最长连击 ${S.maxBurst}` },
  { g: '微操', icon: '🫡', name: '你说得对学派', tier: '银', desc: '被 AI 说过 50 次"你说得对"，而你确实说得对', cur: S.saidRight, max: 50, val: `${S.saidRight} 次` },
  { g: '微操', icon: '🛑', name: '刹车侠', tier: '银', desc: '按 20 次 Esc 打断输出。刹车是最后的尊严', cur: S.interrupts, max: 20, val: `踩了 ${S.interrupts} 脚刹车` },
  { g: '微操', icon: '🚢', name: 'Ship 机器', tier: '金', desc: '经手 100 个 commit，信息还都写得比你好', cur: S.gitCommits, max: 100, val: `${S.gitCommits} 个 commit` },
  { g: '微操', icon: '💥', name: '上下文爆破手', tier: '银', desc: '把对话聊到失忆 10 次，compact 是一种境界', cur: S.compacts, max: 10, val: `${S.compacts} 次失忆` },
  { g: '微操', icon: '🎰', name: '全家桶收集者', tier: '银', desc: '用过 3 种以上模型：有的干活，有的跑腿，有的背锅', cur: S.models.size, max: 3, val: `${S.models.size} 种模型` },
  { g: '微操', icon: '🙋', name: '甲方本人', tier: '铜', desc: '被 AI 反过来追问 20 次需求，这就是话语权', cur: S.askCalls, max: 20, val: `被追问 ${S.askCalls} 次` },
  { g: '微操', icon: '🙏', name: '人机礼仪模范', tier: '铜', desc: '对 AI 说了 20 次谢谢。它记不住，但你是好人', cur: S.thanks, max: 20, val: `${S.thanks} 次感谢` },
  { g: '微操', icon: '🤬', name: '口吐芬芳', tier: '金', hidden: true, desc: '对 AI 爆了 10 次粗口。致敬 2012 年 Visual Studio 成就系统的 Potty Mouth', cur: S.swears, max: 10, val: `${S.swears} 次真情流露` },
  { g: '微操', icon: '⏳', name: '已读不回', tier: '金', hidden: true, desc: 'AI 答完干等你 2 小时起步，共 5 次。它不困，你先睡', cur: S.waits, max: 5, val: `共 ${S.waits} 次，最长晾了 ${(S.maxWait / 36e5).toFixed(1)} 小时` },
];
for (const a of A) a.ok = a.cur >= a.max;
const unlocked = A.filter(a => a.ok);

// ---------- HTML ----------
const TIER_COLOR = { '铜': '#b08d57', '银': '#9fb4c7', '金': '#e8b339', '白金': '#7fd4d0' };
const GROUPS = ['日常', '肝度', '钞能力', '微操'];
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
  <h2>${{ '日常': '🌱', '肝度': '🌙', '钞能力': '💸', '微操': '🎮' }[g]} ${g}<span class="gs">${A.filter(a => a.g === g && a.ok).length}/${A.filter(a => a.g === g).length}</span></h2>
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
  .srcs { font-size: 12.5px; color: #8a8f98; margin: 8px 0 0; }
  .srcs b { color: #c8ccd2; font-weight: 600; }
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
  body.share { padding-top: 40px; }
  body.share .wrap { max-width: 620px; }
  body.share h1 { text-align: center; }
  body.share .bar { flex-direction: column; gap: 12px; }
  body.share .stats { justify-content: center; }
  body.share h2, body.share .tip, body.share .st.hideShare { display: none; }
  body.share .srcs { text-align: center; }
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
  <div class="srcs">🧩 已接入 <b>${srcOn.length}</b> 个平台：${srcOn.map(b => `<b>${esc(b.name)}</b> ${b.sessions} 场`).join(' · ')}</div>
  <div class="tip">点卡片选中「晒」标记，晒图模式只显示选中的；不选则默认晒金/白金。</div>
${sections}
  <footer><span class="big">数据全部来自本地真实日志，一条没编。</span><br>已接入 ${srcOn.length} 平台（${esc(srcNames)}）· 本地离线生成 · 数据不出这台电脑 · vibe-trophy v0.4（占位名）</footer>
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
console.log(`平台: ${srcOn.map(b => `${b.name} ${b.sessions} 场/${yi(b.tokens)} token`).join(' · ')}`);
console.log(`解锁 ${unlocked.length}/${A.length}`);
for (const g of GROUPS) console.log(`  ${g}: ${A.filter(a => a.g === g).map(a => (a.ok ? a.icon : '🔒') + a.name).join(' ')}`);
console.log(`会话 ${S.sessions} · 活跃 ${S.days.size} 天 · 累计 ${yi(totalTokens)} token · 峰值 ${yi(S.maxSessionTokens)}/会话 · 连击 ${S.maxBurst} · 模型 ${S.models.size} 种`);
