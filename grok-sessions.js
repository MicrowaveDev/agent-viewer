import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

export function grokSessionsDir(env = process.env, home = os.homedir()) {
  return path.resolve(env.GROK_HOME || path.join(home, '.grok'), 'sessions');
}

export function grokFileId(sessionDir) {
  return `grok-${createHash('sha256').update(path.resolve(sessionDir)).digest('hex').slice(0, 24)}`;
}

export function discoverGrokSessions(root) {
  const sessions = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const names = new Set(entries.filter(e => e.isFile()).map(e => e.name));
    const filename = names.has('updates.jsonl') ? 'updates.jsonl'
      : names.has('chat_history.jsonl') ? 'chat_history.jsonl' : null;
    if (filename) {
      let summary = {};
      try { summary = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')); } catch {}
      if (!summary || typeof summary !== 'object') summary = {};
      sessions.push({ id: grokFileId(dir), filename, filePath: path.join(dir, filename),
        displayLabel: [summary.title, summary.session_summary, summary.summary].find(value => typeof value === "string" && value.trim()) || path.basename(dir), source: 'grok' });
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
    }
  }
  walk(root);
  return sessions;
}
