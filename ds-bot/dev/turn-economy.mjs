#!/usr/bin/env node
// Turn economy report: how many Bot turns a day, what opened them, what they cost.
// Reads only the local DSH data (~/.dsh/bot/chat-index.sqlite and ~/.dsh/sessions).
//
//   node dev/turn-economy.mjs --day 2026-11-14
//
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const home = process.env.DSH_HOME || join(homedir(), '.dsh');
const args = process.argv.slice(2);
const dayArg = args[args.indexOf('--day') + 1];
if (!dayArg || !/^\d{4}-\d{2}-\d{2}$/.test(dayArg)) {
  console.error('usage: node dev/turn-economy.mjs --day YYYY-MM-DD [--json]');
  process.exit(2);
}
const dayStart = new Date(`${dayArg}T00:00:00+08:00`).getTime();
const dayEnd = dayStart + 86_400_000;

/** Bot chat sessions, from the chat index the Bot team already keeps. */
function botSessions() {
  const db = new DatabaseSync(join(home, 'bot', 'chat-index.sqlite'), { readOnly: true });
  try {
    return new Set(db.prepare('select distinct session from lines').all().map(r => r.session));
  } finally {
    db.close();
  }
}

function* sessionFiles(root) {
  for (const cwdDir of readdirSync(root)) {
    const dir = join(root, cwdDir);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name, 'session.v4.jsonl.zstd');
      try {
        if (statSync(file).isFile()) yield { id: name, file };
      } catch {}
    }
  }
}

const textLen = (content) =>
  (content || []).reduce((n, c) => n + (c?.type === 'text' ? (c.text || '').length : 0), 0);

function report() {
  const sessions = botSessions();
  const seeds = new Map();
  const roles = new Map();
  const durs = [];
  const tools = [];
  const texts = [];
  const injected = [];
  let zeroTool = 0;
  let zeroText = 0;

  for (const { id, file } of sessionFiles(join(home, 'sessions'))) {
    if (!sessions.has(id)) continue;
    let lines;
    try {
      lines = zstdDecompressSync(readFileSync(file)).toString('utf8').split('\n');
    } catch {
      continue;
    }
    let turn = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === 'turn/start') {
        turn = (ev.time < dayStart || ev.time > dayEnd) ? null : { start: ev.time, tools: 0, text: 0, injected: 0, opened: false };
        continue;
      }
      if (!turn) continue;
      if (ev.type === 'tool/call') turn.tools += 1;
      else if (ev.type === 'assistant/message') turn.text += textLen(ev.data?.message?.content);
      else if (ev.type === 'user/message') {
        const content = ev.data?.content;
        if (!turn.opened) {
          turn.opened = true;
          const source = ev.data?.source || {};
          const kind = source.kind || 'none';
          seeds.set(kind, (seeds.get(kind) || 0) + 1);
          if (source.role) roles.set(source.role, (roles.get(source.role) || 0) + 1);
        } else {
          turn.injected += textLen(content);
        }
      } else if (ev.type === 'turn/end') {
        if (ev.time <= dayEnd) {
          durs.push((ev.time - turn.start) / 1000);
          tools.push(turn.tools);
          texts.push(turn.text);
          injected.push(turn.injected);
          if (turn.tools === 0) zeroTool += 1;
          if (turn.text === 0) zeroText += 1;
        }
        turn = null;
      }
    }
  }

  const at = (v, p) => {
    if (!v.length) return 0;
    const s = [...v].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.round((s.length - 1) * p))];
  };
  const mean = (v) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
  const turns = durs.length;
  return {
    day: dayArg,
    sessions: sessions.size,
    turns,
    seeds: Object.fromEntries([...seeds].sort((a, b) => b[1] - a[1])),
    botRoles: Object.fromEntries([...roles].sort((a, b) => b[1] - a[1])),
    duration: { p50: at(durs, 0.5), p75: at(durs, 0.75), p90: at(durs, 0.9), max: durs.length ? Math.max(...durs) : 0 },
    tools: { mean: mean(tools), zeroTool, zeroToolShare: turns ? zeroTool / turns : 0 },
    text: { mean: mean(texts), zeroText, zeroTextShare: turns ? zeroText / turns : 0 },
    injected: { mean: mean(injected), p50: at(injected, 0.5), p90: at(injected, 0.9) },
  };
}

const result = report();
if (args.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const pct = (n) => `${(n * 100).toFixed(1)}%`;
  console.log(`day ${result.day}: ${result.turns} turns over ${result.sessions} Bot sessions`);
  console.log('opened by:', Object.entries(result.seeds).map(([k, v]) => `${k}=${v}`).join('  '));
  console.log('bot roles:', Object.entries(result.botRoles).map(([k, v]) => `${k}=${v}`).join('  '));
  console.log(`duration s: p50=${result.duration.p50.toFixed(1)} p75=${result.duration.p75.toFixed(1)} p90=${result.duration.p90.toFixed(1)} max=${result.duration.max.toFixed(1)}`);
  console.log(`tool calls/turn: mean=${result.tools.mean.toFixed(2)}  zero-tool=${result.tools.zeroTool} (${pct(result.tools.zeroToolShare)})`);
  console.log(`assistant chars/turn: mean=${result.text.mean.toFixed(0)}  zero-text=${result.text.zeroText} (${pct(result.text.zeroTextShare)})`);
  console.log(`injected chars/turn: mean=${result.injected.mean.toFixed(0)} p50=${result.injected.p50} p90=${result.injected.p90}`);
}
