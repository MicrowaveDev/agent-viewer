import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { grokAcpCliFixture } from './fixtures/grok-acp-fixtures.mjs';
import { createGrokAcpAnalysis } from '../scripts/grok-acp-analysis.mjs';
const event = (update, sessionId = 's', meta = {}) => ({ params: { sessionId, update, _meta: meta } });
const call = (id, extra = {}) => ({ sessionUpdate: 'tool_call', toolCallId: id, title: 'read_file', rawInput: { path: '/neutral/file.md' }, ...extra });
function analyze(events) { const a = createGrokAcpAnalysis(); events.forEach((e, i) => a.collect(e, i + 1)); return a.result(); }

test('ACP unique IDs, update-only calls, statuses and snapshot mirrors', () => {
  const output = 'neutral café output';
  const rows = [event(call('a')), event({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: output } }], rawOutput: { FileContent: { content: output, content_concise: output, raw_output: output } } }), event(call('a')), event(call('a'), 'another'), event({ sessionUpdate: 'tool_call_update', toolCallId: 'missing', status: 'failed', rawOutput: { stdout: [...Buffer.from('héllo')], stderr: [] }, content: [{ text: 'summary' }] })];
  const r = analyze(rows);
  assert.equal(r.tools.unique, 3); assert.equal(r.tools.declared, 2); assert.equal(r.tools.updateOnly, 1); assert.equal(r.tools.failed, 1);
  assert.equal(r.tools.outputBytes, Buffer.byteLength(output + 'héllo'));
  assert.equal(r.tools.byTarget[0].calls, 2);
  assert.ok(!JSON.stringify(r).includes(output));
});

test('repeated terminal updates count once and images are excluded', () => {
  const update = { sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed', content: [{ text: 'abc' }, { type: 'image', data: 'secret-image' }] };
  const r = analyze([event(call('a')), event(update, 's', { eventId: 'x' }), event(update, 's', { eventId: 'x' }), event(update, 's', { eventId: 'y' })]);
  assert.equal(r.duplicateEvents, 1); assert.equal(r.tools.outputBytes, 3);
  assert.ok(!JSON.stringify(r).includes('secret-image'));
});

test('top-level per-turn usage excludes nested totals and deduplicates turns', () => {
  const usage = { inputTokens: 100, outputTokens: 10, totalTokens: 110, cachedReadTokens: 80, cacheCreationTokens: 0, reasoningTokens: 3, modelCalls: 2, modelUsage: { model: { inputTokens: 100 } } };
  const turn = { sessionUpdate: 'turn_completed', prompt_id: 'p', usage };
  const r = analyze([event(turn), event(turn), event({ sessionUpdate: 'turn_completed', prompt_id: 'other' }), event({ sessionUpdate: 'agent_message_chunk' }, 's', { totalTokens: 9000 })]);
  assert.equal(r.usage.totals.inputTokens, 100); assert.equal(r.usage.totals.modelCalls, 2);
  assert.equal(r.usage.turns, 2); assert.equal(r.usage.turnsWithUsage, 1); assert.equal(r.usage.complete, false);
});

test('compaction and balance diagnoses use explicit lifecycle events only', () => {
  const r = analyze([event({ sessionUpdate: 'auto_compact_started', tokens_used: 200000 }), event({ sessionUpdate: 'auto_compact_completed', tokens_before: 200000, tokens_after: 15000 }), event(call('a', { rawInput: { command: 'echo 402 balance exhausted' } })), event({ sessionUpdate: 'retry_state', message: 'API error (status 402 Payment Required): Grok Build usage balance exhausted' }), event({ sessionUpdate: 'turn_completed', prompt_id: 'p', agent_result: 'API error (status 402 Payment Required): Grok Build usage balance exhausted' })]);
  assert.equal(r.compactions.count, 1); assert.deepEqual(r.diagnoses, ['usage_balance_exhausted']);
  assert.equal(r.compactions.examples[0].after, 15000);
});

test('maintained analyzer CLI discovers ACP and emits bounded safe JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-analyzer-'));
  try {
    const file = path.join(dir, 'fixture.jsonl');
    fs.writeFileSync(file, grokAcpCliFixture.map(JSON.stringify).join('\n'));
    const stdout = execFileSync(process.execPath, ['scripts/analyze-log.mjs', file, '--workflow-waste'], { encoding: 'utf8' });
    const r = JSON.parse(stdout); assert.equal(r.format, 'grok-acp'); assert.equal(r.tools.unique, 1); assert.ok(!stdout.includes('DO_NOT_EMIT_PRIVATE_BODY'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('known structured output variants include editor diffs and task results once', () => {
  const rows = [
    { Content: { content: 'directory listing' } },
    { Result: { output: 'background result', command: 'not-output' } },
    { EditsApplied: { tool_output_for_prompt: 'edit acknowledgement' } },
  ].map((rawOutput, i) => event({ sessionUpdate: 'tool_call_update', toolCallId: String(i), rawOutput }));
  rows.push(event({ sessionUpdate: 'tool_call_update', toolCallId: 'diff', content: [{ type: 'diff', oldText: 'old', newText: 'new' }], rawOutput: { EditsApplied: { new_string: 'new', tool_output_for_prompt: 'duplicate acknowledgement' } } }));
  const r = analyze(rows);
  assert.equal(r.tools.outputBytes, Buffer.byteLength('directory listingbackground resultedit acknowledgementold\nnew'));
  assert.equal(r.tools.unmeasuredOutputCalls, 0);
});
