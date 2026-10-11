import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { discoverGrokSessions, grokSessionsDir } from '../grok-sessions.js';
import '../public/grok-format.js';
import '../public/export-cleaner.js';

test('Grok home override and default storage', () => {
  assert.equal(grokSessionsDir({}, '/home/test'), '/home/test/.grok/sessions');
  assert.equal(grokSessionsDir({ GROK_HOME: '/custom' }), '/custom/sessions');
});

test('discovery prefers updates, falls back to chat and keeps IDs stable and distinct', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-grok-'));
  try {
    for (const project of ['project-one', 'project-two']) {
      const dir = path.join(root, project, 'same-session');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'chat_history.jsonl'), '{}\n');
      fs.writeFileSync(path.join(dir, 'summary.json'), project === 'project-one'
        ? JSON.stringify({ session_summary: 'Session title' }) : '{incomplete');
    }
    fs.writeFileSync(path.join(root, 'project-one', 'prompt_history.jsonl'), '{}');
    const before = discoverGrokSessions(root);
    assert.equal(before.length, 2);
    assert.notEqual(before[0].id, before[1].id);
    fs.writeFileSync(path.join(root, 'project-one', 'same-session', 'updates.jsonl'), '{}\n');
    const after = discoverGrokSessions(root);
    assert.deepEqual(after.map(x => x.id), before.map(x => x.id));
    assert.equal(after[0].filename, 'updates.jsonl');
    assert.equal(after[0].displayLabel, 'Session title');
    assert.equal(after[1].filename, 'chat_history.jsonl');
    fs.writeFileSync(path.join(root, 'project-two', 'same-session', 'summary.json'), 'null');
    assert.equal(discoverGrokSessions(root).length, 2);
    assert.deepEqual(discoverGrokSessions(path.join(root, 'missing')), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('prompts support ACP and raw history without synthetic context', () => {
  const { prompt } = globalThis.AgentViewerGrok;
  assert.equal(prompt({ params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Hello' } } } }), 'Hello');
  assert.equal(prompt({ type: 'user', content: [{ type: 'text', text: 'Hello' }] }), 'Hello');
  assert.equal(prompt({ type: 'user', synthetic_reason: 'context', content: 'Injected' }), '');
  assert.equal(prompt({ type: 'user', message: { content: 'Claude prompt' } }), '');
});

test('export preserves Grok tool IDs, usage and unknown events and removes encrypted reasoning', () => {
  const events = [
    { type: 'reasoning', encrypted_content: 'secret', summary: [{ type: 'summary_text', text: 'Thinking' }] },
    { params: { sessionId: 'session', update: { sessionUpdate: 'tool_call', toolCallId: 'call', rawInput: { command: 'pwd' } } } },
    { params: { update: { sessionUpdate: 'future_event', usage: { totalTokens: 100 } } } },
  ];
  const result = globalThis.AgentViewerExportCleaner.cleanForCopy(events.map(e => JSON.stringify(e)).join('\n')).split('\n').map(JSON.parse);
  assert.equal(result[0].encrypted_content, undefined);
  assert.equal(result[0].summary[0].text, 'Thinking');
  assert.deepEqual(result.slice(1), events.slice(1));
});

test('renderer shows Grok prompts, tool output and unknown events safely', () => {
  const context = vm.createContext({ AgentViewerGrok: globalThis.AgentViewerGrok });
  vm.runInContext(fs.readFileSync(new URL('../public/renderers.js', import.meta.url), 'utf8'), context);
  vm.runInContext('md = { parse: text => escapeHtml(text) }', context);
  const render = evt => context.renderGrokEvent(evt);
  assert.match(render({ params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Hello <script>' } } } }), /Hello &lt;script&gt;/);
  assert.match(render({ params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'Tool output' } }] } } }), /ERROR[\s\S]*Tool output/);
  assert.match(render({ params: { update: { sessionUpdate: 'future_event' } } }), /future_event/);
  assert.match(render({ type: 'assistant', tool_calls: [{ name: 'shell', id: 'call', arguments: 'pwd' }] }), /shell[\s\S]*pwd/);
});
