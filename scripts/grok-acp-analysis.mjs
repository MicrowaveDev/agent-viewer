import { digestText, redactSensitiveText } from './measurement-foundation.mjs';

const fields = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedReadTokens', 'cacheCreationTokens', 'reasoningTokens', 'modelCalls'];
const bytes = value => Buffer.byteLength(value, 'utf8');
const safe = value => redactSensitiveText(String(value || ''), 180);
const isBytes = value => Array.isArray(value) && value.length > 0 && value.every(n => Number.isInteger(n) && n >= 0 && n <= 255);

// Select one display representation. Do not sum FileContent mirrors, stdout
// arrays, content blocks and rawOutput copies of the same tool response.
function text(value) {
  if (typeof value === 'string') return value;
  if (isBytes(value)) return Buffer.from(value).toString('utf8');
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  if (value.type === 'image' || value.type === 'audio' || value.mimeType?.startsWith('image/')) return '';
  if (value.type === 'diff') return [text(value.oldText), text(value.newText)].filter(Boolean).join('\n');
  if (value.Content) return text(value.Content);
  if (value.Result) return text(value.Result);
  if (value.EditsApplied) return text(value.EditsApplied.tool_output_for_prompt ?? value.EditsApplied.tool_output_for_prompt_concise);
  if (value.FileContent) return text(value.FileContent.content ?? value.FileContent.content_concise ?? value.FileContent.raw_output);
  if (value.stdout !== undefined || value.stderr !== undefined) return [text(value.stdout), text(value.stderr)].filter(Boolean).join('\n');
  if (value.text !== undefined) return text(value.text);
  if (value.content !== undefined) return text(value.content);
  if (value.output !== undefined) return text(value.output);
  return '';
}

export function createGrokAcpAnalysis() {
  const calls = new Map(), turns = new Map(), seenEvents = new Set(), compactions = new Map(), errors = new Set();
  let records = 0, duplicateEvents = 0, anonymousCalls = 0, turnRecords = 0;
  return {
    collect(event, line) {
      const p = event.params, u = p?.update;
      if (!u?.sessionUpdate) return false;
      records++;
      const session = p.sessionId || 'unknown-session';
      const eventId = p._meta?.eventId;
      if (eventId) {
        const id = `${session}:${eventId}`;
        if (seenEvents.has(id)) { duplicateEvents++; return true; }
        seenEvents.add(id);
      }
      const kind = u.sessionUpdate;
      if (kind === 'tool_call' || kind === 'tool_call_update') {
        const key = `${session}:${u.toolCallId || `anonymous-${line}`}`;
        if (!u.toolCallId) anonymousCalls++;
        const call = calls.get(key) || { line, name: 'unknown', status: 'unknown', inputBytes: 0, outputBytes: 0, outputDigest: digestText(''), target: '', declared: false };
        if (kind === 'tool_call') call.declared = true;
        call.name = u._meta?.['x.ai/tool']?.name || (kind === 'tool_call' ? u.title : '') || call.name;
        if (u.status) call.status = String(u.status).toLowerCase();
        if (u.rawInput !== undefined) {
          call.inputBytes = bytes(JSON.stringify(u.rawInput));
          const input = u.rawInput && typeof u.rawInput === 'object' ? u.rawInput : {};
          call.target = input.target_file || input.file_path || input.path || input.target_directory || call.target;
        }
        if (u.rawOutput !== undefined || u.content !== undefined) {
          // Prefer rich raw output (e.g. grep stdout) over a display summary.
          const hasDiff = Array.isArray(u.content) && u.content.some(block => block.type === 'diff');
          const output = hasDiff ? text(u.content) : text(u.rawOutput) || text(u.content);
          call.outputUnmeasured = !output && (u.rawOutput !== undefined || (u.content?.length > 0));
          call.outputBytes = bytes(output);
          call.outputDigest = digestText(output);
        }
        calls.set(key, call);
      }
      if (kind === 'turn_completed') {
        turnRecords++;
        const key = `${session}:${u.prompt_id || p._meta?.promptId || eventId || `line-${line}`}`;
        // Usage is a per-turn aggregate. modelUsage repeats those figures and
        // metadata.totalTokens is a context gauge, neither is added here.
        turns.set(key, { usage: u.usage || null, line });
      }
      if (kind === 'auto_compact_completed') {
        compactions.set(`${session}:${eventId || line}`, { line, before: Number.isFinite(u.tokens_before) && u.tokens_before >= 0 ? u.tokens_before : null, after: Number.isFinite(u.tokens_after) && u.tokens_after >= 0 ? u.tokens_after : null });
      }
      if (['turn_completed', 'retry_state'].includes(kind)) {
        const message = `${u.agent_result || ''} ${u.message || ''}`;
        if (/402/.test(message) && /(?:usage )?balance exhausted/i.test(message)) errors.add('usage_balance_exhausted');
        else if (/context.{0,30}(?:exceed|limit|exhaust)/i.test(message)) errors.add('context_limit_reported');
      }
      return true;
    },
    result() {
      const totals = Object.fromEntries(fields.map(key => [key, 0]));
      const coverage = Object.fromEntries(fields.map(key => [key, 0]));
      let withUsage = 0;
      for (const { usage } of turns.values()) {
        if (!usage) continue;
        withUsage++;
        for (const key of fields) if (Number.isFinite(usage[key]) && usage[key] >= 0) { totals[key] += usage[key]; coverage[key]++; }
      }
      const byTool = new Map(), byTarget = new Map(), statuses = {};
      let inputBytes = 0, outputBytes = 0, failed = 0, declaredCalls = 0, unmeasuredOutputCalls = 0;
      const largest = [];
      for (const call of calls.values()) {
        const input = call.inputBytes, output = call.outputBytes;
        inputBytes += input; outputBytes += output;
        if (call.status === 'failed') failed++;
        if (call.outputUnmeasured) unmeasuredOutputCalls++;
        if (call.declared) declaredCalls++;
        statuses[call.status] = (statuses[call.status] || 0) + 1;
        const add = (map, key) => {
          const row = map.get(key) || { name: safe(key), calls: 0, inputBytes: 0, outputBytes: 0 };
          row.calls++; row.inputBytes += input; row.outputBytes += output; map.set(key, row);
        };
        add(byTool, call.name);
        if (call.target) add(byTarget, call.target);
        largest.push({ line: call.line, tool: safe(call.name), status: safe(call.status), inputBytes: input, outputBytes: output, outputDigest: call.outputDigest });
      }
      const rank = map => [...map.values()].sort((a, b) => b.outputBytes - a.outputBytes || a.name.localeCompare(b.name)).slice(0, 20);
      return {
        format: 'grok-acp', records, duplicateEvents,
        tools: { unique: calls.size, statuses, declared: declaredCalls, updateOnly: calls.size - declaredCalls, anonymous: anonymousCalls, failed, unmeasuredOutputCalls, inputBytes, outputBytes, byTool: rank(byTool), byTarget: rank(byTarget), inputByTool: [...byTool.values()].sort((a, b) => b.inputBytes - a.inputBytes || a.name.localeCompare(b.name)).slice(0, 20), largestInputs: [...largest].sort((a, b) => b.inputBytes - a.inputBytes || a.line - b.line).slice(0, 20), largest: largest.sort((a, b) => b.outputBytes - a.outputBytes || a.line - b.line).slice(0, 20) },
        usage: { turns: turns.size, records: turnRecords, turnsWithUsage: withUsage, complete: turns.size > 0 && withUsage === turns.size && fields.every(key => coverage[key] === turns.size), totals, fieldCoverage: coverage },
        compactions: { count: compactions.size, examples: [...compactions.values()].slice(0, 20) },
        diagnoses: [...errors].sort(),
        limitations: ['Tool UTF-8 byte counts are context-volume proxies, not token or billing attribution.', 'Usage sums recorded top-level completed-turn aggregates only; nested modelUsage and metadata context gauges are excluded.', 'Tool updates are snapshots keyed by session and call ID; output/input mirrors count once using the latest observed snapshot.', 'Output bytes cover selected display text, diffs and known raw-output text fields; unmeasuredOutputCalls flags metadata-only or unsupported output shapes.', 'Missing turn usage or IDs means coverage is incomplete; this report cannot reconstruct unrecorded model calls.', 'Rankings are bounded candidates for review, not claims that calls were unnecessary.'],
      };
    },
  };
}
