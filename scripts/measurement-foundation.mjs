import { createHash } from "node:crypto";

export const ANALYSIS_SCHEMA_VERSION = 3;
export const DETECTOR_VERSION = "v2-measurement-foundation";
export const OVERSIZED_INPUT_BYTES = 8_000;
export const RAW_ARTIFACT_BYTES = 4_000;

const TOOL_CALL_TYPES = new Set(["function_call", "custom_tool_call"]);
const TOOL_OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);
const CORRELATION_KEYS = ["call_id", "session_id", "thread_id", "parent_thread_id", "turn_id", "task_id"];

export function redactSensitiveText(value, max = 500) {
  return String(value || "")
    .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, "[image redacted]")
    .replace(/[A-Za-z0-9+/=]{500,}/g, "[large payload redacted]")
    .replace(/\b(authorization|api[_-]?key|password|secret|token)\b\s*[:=]\s*([^\s,;}]+)/gi, "$1=[redacted]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[credentials-redacted]@")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function digestText(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

export function extractCorrelation(payload = {}) {
  return Object.fromEntries(CORRELATION_KEYS
    .filter((key) => payload[key] !== undefined && payload[key] !== null)
    .map((key) => [key, String(payload[key])]));
}

export function collectToolPayloads(event) {
  const calls = [];
  const outputs = [];
  const seen = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (TOOL_CALL_TYPES.has(value.type)) calls.push(value);
    if (TOOL_OUTPUT_TYPES.has(value.type)) outputs.push(value);
    for (const [key, child] of Object.entries(value)) {
      if (key !== "output" && key !== "arguments" && key !== "input") visit(child);
    }
  };
  visit(event?.payload || event?.message || {});
  return { calls, outputs };
}

export function rawToolInput(payload) {
  const value = payload.arguments ?? payload.input ?? "";
  return typeof value === "string" ? value : JSON.stringify(value || "");
}

export function rawToolOutput(payload) {
  return typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output ?? "");
}

function sessionScope(item) {
  return item.correlation.session_id || item.correlation.thread_id || null;
}

export function correlateToolOutputs(calls, outputs) {
  const callsById = new Map();
  for (const call of calls) {
    const id = call.correlation.call_id;
    if (!id) continue;
    if (!callsById.has(id)) callsById.set(id, []);
    callsById.get(id).push(call);
  }

  const assigned = new Set();
  const attributions = [];
  for (const output of outputs) {
    const callId = output.correlation.call_id;
    const outputScope = sessionScope(output);
    const sameId = callId ? (callsById.get(callId) || []) : [];
    const scoped = outputScope ? sameId.filter((call) => sessionScope(call) === outputScope) : sameId;
    const available = scoped.filter((call) => !assigned.has(call));
    let call = null;
    let confidence = "none";
    let reason = callId ? "unmatched-call-id" : "missing-call-id";

    if (available.length === 1) {
      [call] = available;
      confidence = sameId.length === 1 || (outputScope && scoped.length === 1) ? "high" : "low";
      reason = outputScope && sameId.length > 1
        ? "call-id-and-session"
        : sameId.length > 1 ? "duplicate-call-id-fifo" : "unique-call-id";
    } else if (available.length > 1) {
      call = available.find((candidate) => candidate.line <= output.line) || available[0];
      confidence = "low";
      reason = "duplicate-call-id-fifo";
    } else if (!callId && outputScope) {
      const sessionCandidates = calls.filter((candidate) => !assigned.has(candidate) && sessionScope(candidate) === outputScope);
      if (sessionCandidates.length === 1) {
        [call] = sessionCandidates;
        confidence = "medium";
        reason = "unique-session-correlation";
      }
    }

    if (call) assigned.add(call);
    attributions.push({ output, call, confidence, reason, candidateCount: available.length });
  }
  return attributions;
}

export function buildLifecycle(userRequests, assistantMessages, completions) {
  return userRequests.map((request) => {
    const taskCompletions = completions.filter((item) => item.taskIndex === request.taskIndex);
    const finalMessages = assistantMessages.filter((item) => item.taskIndex === request.taskIndex && item.phase === "final_answer");
    const completion = taskCompletions.at(-1) || null;
    const finalMessage = completion
      ? [...finalMessages].reverse().find((item) => item.line <= completion.line) || finalMessages.at(-1) || null
      : finalMessages.at(-1) || null;
    const payloadFinal = completion?.hasFinalMessage || false;
    const linked = Boolean(completion && (finalMessage || payloadFinal));
    return {
      taskIndex: request.taskIndex,
      requestLine: request.line,
      completionLines: taskCompletions.map((item) => item.line),
      finalMessageLines: finalMessages.map((item) => item.line),
      status: !completion ? "incomplete" : linked ? "complete-with-final" : "complete-without-final",
      linkageConfidence: finalMessage ? "high" : payloadFinal ? "medium" : "none",
      linkedFinalLine: finalMessage?.line || completion?.line || null,
    };
  });
}

export function detectMeasuredWaste(session, addSignal) {
  const oversized = new Map();
  for (const call of session.toolCalls) {
    if (call.inputBytes < OVERSIZED_INPUT_BYTES) continue;
    if (!oversized.has(call.inputDigest)) oversized.set(call.inputDigest, []);
    oversized.get(call.inputDigest).push(call);
  }
  for (const calls of oversized.values()) {
    if (calls.length < 2) continue;
    addSignal("repeated-oversized-tool-input", calls[0].line, calls.reduce((sum, call) => sum + call.inputBytes, 0),
      `count=${calls.length}; bytes=${calls.map((call) => call.inputBytes).join(",")}; digest=${calls[0].inputDigest}`, "high");
  }

  const successfulContext = session.toolCalls.filter((call) => /npm run task:context\s+--/.test(call.command) && call.failed === false);
  for (const call of session.toolCalls) {
    if (!/(?:cat|sed\s+-n)[^\n]*(?:AGENTS\.md|portable-agent-instructions\.md)/.test(call.command)) continue;
    const context = successfulContext.find((candidate) => candidate.taskIndex === call.taskIndex && candidate.line < call.line);
    if (context) addSignal("instruction-reread-after-successful-task-context", call.line, 1,
      `taskContextLine=${context.line}; rereadLine=${call.line}`, "high");
  }

  const attributedOutputs = session.toolOutputs.filter((output) => output.callLine && output.rawBytes >= RAW_ARTIFACT_BYTES);
  for (const output of attributedOutputs) {
    const replay = session.toolCalls.find((call) => call.line > output.line && call.rawInput.includes(output.rawOutput));
    if (replay) addSignal("raw-artifact-replay", replay.line, output.rawBytes,
      `outputLine=${output.line}; replayLine=${replay.line}; digest=${output.outputDigest}`, "high");
  }
}
