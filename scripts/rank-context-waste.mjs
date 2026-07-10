#!/usr/bin/env node

import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const LARGE_OUTPUT_BYTES = 20_000;
const PACKET_EVENT_LIMIT = 50;
const PACKET_BYTE_LIMIT = 48_000;
const FORK_HISTORY_BURST_MS = 250;
const READ_ONLY_COMMANDS = /^(rg|sed|cat|head|tail|find|ls|git status|git diff|git log|git show|npm run (repo:context|status:all|find:repos))/;

function parseArgs(argv) {
  const result = { roots: [], packetEventLimit: PACKET_EVENT_LIMIT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--since") result.since = argv[++i];
    else if (arg === "--until") result.until = argv[++i];
    else if (arg === "--output") result.output = argv[++i];
    else if (arg === "--root") result.roots.push(argv[++i]);
    else if (arg === "--packet-events") result.packetEventLimit = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function usage() {
  return `Usage: yarn agent:rank-context-waste --since <ISO> --until <ISO> --output <dir> [--root <dir>] [--packet-events <n>]

Streams Codex rollout JSONL files, emits deterministic rankings and bounded
evidence packets, and never modifies source logs.`;
}

function stableJson(value, indent = 2) {
  const sort = (item) => {
    if (Array.isArray(item)) return item.map(sort);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])]));
  };
  return `${JSON.stringify(sort(value), null, indent)}\n`;
}

function compactText(value, max = 500) {
  return String(value || "")
    .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, "[image redacted]")
    .replace(/[A-Za-z0-9+/=]{500,}/g, "[large payload redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => item?.text || item?.message || "").filter(Boolean).join("\n");
}

function extractCommand(payload) {
  let detail = payload.arguments ?? payload.input ?? "";
  if (typeof detail === "string") {
    try {
      const parsed = JSON.parse(detail);
      detail = parsed.cmd || parsed.command || parsed.query || detail;
    } catch {
      // Keep the original string.
    }
  } else if (detail && typeof detail === "object") {
    detail = detail.cmd || detail.command || detail.query || JSON.stringify(detail);
  }
  return compactText(detail, 700);
}

function normalizeCommand(command) {
  return command
    .replace(/\b[0-9a-f]{7,40}\b/gi, "<sha>")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSignature(usage) {
  return [usage?.input_tokens, usage?.cached_input_tokens, usage?.output_tokens, usage?.reasoning_output_tokens].join(":");
}

function isFailure(output) {
  return /exit code [1-9]/i.test(output) || /"exit_code"\s*:\s*[1-9]/.test(output) || /Script (?:failed|error)/i.test(output);
}

function addSignal(session, ruleId, line, quantity, detail, confidence = "medium") {
  session.signals.push({ ruleId, line, quantity, detail: compactText(detail, 300), confidence });
}

function safeRequest(text) {
  const compact = compactText(text, 1_000);
  if (!compact || compact.startsWith("<environment_context>") || compact.startsWith("# AGENTS.md instructions") || compact.startsWith("<subagent_notification>")) return "";
  return compact;
}

export async function analyzeLog(filePath, window = {}) {
  const session = {
    path: path.resolve(filePath),
    id: path.basename(filePath, ".jsonl").replace(/^rollout-[^-]+-[^-]+-[^-]+-/, ""),
    sessionCreatedAt: null,
    start: null,
    end: null,
    windowStart: null,
    windowEnd: null,
    cwd: null,
    originator: null,
    threadSource: null,
    parentThreadId: null,
    ancestryCheckParentId: null,
    model: null,
    sourceRequest: "",
    userRequests: [],
    assistantMessages: [],
    lines: 0,
    badJson: 0,
    turns: 0,
    toolCalls: [],
    failures: [],
    completions: 0,
    largeOutputBytes: 0,
    finalUsage: null,
    turnUsage: [],
    signals: [],
    agentLinks: [],
    excerpts: [],
  };
  const pendingCalls = new Map();
  const commandCounts = new Map();
  const readTargets = new Map();
  const taskContextTasks = new Set();
  let taskIndex = 0;
  let activeRequest = "";
  let previousUsageSignature = null;

  const rl = readline.createInterface({ input: fs.createReadStream(filePath), crlfDelay: Infinity });
  for await (const rawLine of rl) {
    if (!rawLine) continue;
    session.lines += 1;
    let evt;
    try { evt = JSON.parse(rawLine); } catch { session.badJson += 1; continue; }
    const timestamp = evt.timestamp || null;
    if (timestamp && (!session.start || timestamp < session.start)) session.start = timestamp;
    if (timestamp && (!session.end || timestamp > session.end)) session.end = timestamp;
    const payload = evt.payload || evt.message || {};

    if (evt.type === "session_meta" && !session.sessionCreatedAt) {
      session.id = payload.id || session.id;
      session.sessionCreatedAt = timestamp;
      session.cwd = payload.cwd || session.cwd;
      session.originator = payload.originator || session.originator;
      session.threadSource = payload.thread_source || session.threadSource;
      session.parentThreadId = payload.parent_thread_id || session.parentThreadId;
      session.ancestryCheckParentId = payload.source?.subagent?.thread_spawn?.parent_thread_id || session.ancestryCheckParentId;
    }
    if (evt.type === "turn_context") session.model = payload.model || session.model;
    const eventTime = timestamp ? new Date(timestamp) : null;
    const createdAt = session.sessionCreatedAt ? new Date(session.sessionCreatedAt) : null;
    const activityFloor = createdAt && session.threadSource === "subagent"
      ? new Date(createdAt.valueOf() + FORK_HISTORY_BURST_MS)
      : createdAt;
    const inWindow = eventTime && (!activityFloor || eventTime >= activityFloor) && (!window.since || eventTime >= window.since) && (!window.until || eventTime < window.until);
    if (window.since || window.until) {
      if (!inWindow) continue;
      if (!session.windowStart || timestamp < session.windowStart) session.windowStart = timestamp;
      if (!session.windowEnd || timestamp > session.windowEnd) session.windowEnd = timestamp;
    } else if (timestamp) {
      session.windowStart = session.start;
      session.windowEnd = session.end;
    }
    const rememberRequest = (text) => {
      const request = safeRequest(text);
      if (!request || request === activeRequest) return;
      activeRequest = request;
      taskIndex += 1;
      session.userRequests.push({ taskIndex, line: session.lines, timestamp, text: request });
      if (!session.sourceRequest) session.sourceRequest = request;
    };
    if (evt.type === "event_msg" && payload.type === "user_message") {
      rememberRequest(payload.message || payload.text_elements?.join(" "));
    }
    if (evt.type === "response_item" && payload.type === "message" && payload.role === "user") {
      rememberRequest(contentText(payload.content));
    }
    if (evt.type === "response_item" && payload.type === "message" && payload.role === "assistant") {
      const text = compactText(contentText(payload.content), 700);
      if (text) session.assistantMessages.push({ line: session.lines, timestamp, taskIndex, text });
    }
    if (evt.type === "event_msg" && payload.type === "token_count" && payload.info) {
      const total = payload.info.total_token_usage;
      const last = payload.info.last_token_usage;
      if (total) session.finalUsage = { ...total };
      if (last) {
        const signature = tokenSignature(last);
        if (signature !== previousUsageSignature) {
          session.turnUsage.push({ line: session.lines, timestamp, ...last });
          session.turns += 1;
          previousUsageSignature = signature;
        }
      }
    }
    if (evt.type === "event_msg" && payload.type === "task_complete") session.completions += 1;

    if (evt.type === "response_item" && ["function_call", "custom_tool_call"].includes(payload.type)) {
      const command = extractCommand(payload);
      const normalized = normalizeCommand(command || payload.name || "unknown");
      const call = { line: session.lines, timestamp, taskIndex, activeRequest, name: payload.name || "tool", command, normalized, outputBytes: null, failed: null, outputPreview: "" };
      session.toolCalls.push(call);
      if (payload.call_id) pendingCalls.set(payload.call_id, call);
      const commandKey = `${taskIndex}|${normalized}`;
      if (!commandCounts.has(commandKey)) commandCounts.set(commandKey, []);
      commandCounts.get(commandKey).push(call);
      if (/npm run task:context\s+--/.test(command)) taskContextTasks.add(taskIndex);
      if (taskContextTasks.has(taskIndex) && /(?:cat|sed\s+-n)[^\n]*(?:AGENTS\.md|portable-agent-instructions\.md)/.test(command)) {
        addSignal(session, "instruction-reread-after-task-context", session.lines, 1, command, "high");
      }
      if (/multi_agent.*spawn_agent|spawn_agent/.test(payload.name || command)) {
        session.agentLinks.push({ type: "spawn", line: session.lines, detail: compactText(command, 500) });
      }
      const readMatch = command.match(/^(?:sed\s+-n\s+[^ ]+\s+|cat\s+)([^\s|;]+)$/);
      if (readMatch) {
        const target = readMatch[1];
        const readKey = `${taskIndex}|${command.split(/\s+/)[0]}|${target}`;
        if (!readTargets.has(readKey)) readTargets.set(readKey, []);
        readTargets.get(readKey).push(call);
      }
    }
    if (evt.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(payload.type)) {
      const output = typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output || "");
      const bytes = Buffer.byteLength(output);
      const call = pendingCalls.get(payload.call_id);
      if (call) {
        call.outputBytes = bytes;
        call.failed = isFailure(output);
        call.outputPreview = compactText(output, 240);
      }
      if (bytes > LARGE_OUTPUT_BYTES) {
        session.largeOutputBytes += bytes;
        addSignal(session, "large-tool-output", session.lines, bytes, `${call?.name || "tool"}: ${compactText(output, 180)}`, "high");
      }
      if (isFailure(output)) {
        session.failures.push({ line: session.lines, callLine: call?.line || null, detail: compactText(output, 300) });
      }
      if (/agent_id|thread_id/.test(output) && call && /spawn_agent/.test(call.name || call.command)) {
        session.agentLinks.push({ type: "spawn-result", line: session.lines, detail: compactText(output, 500) });
      }
    }
  }

  for (const [commandKey, calls] of commandCounts) {
    if (calls.length >= 3) {
      addSignal(session, "repeated-command-within-task", calls[0].line, calls.length, `${commandKey.split("|").slice(1).join("|")} | lines ${calls.map((call) => call.line).join(",")}`);
    }
  }
  for (const [readKey, calls] of readTargets) {
    if (calls.length >= 2) addSignal(session, "repeated-file-read-within-task", calls[0].line, calls.length, `${readKey} | lines ${calls.map((call) => call.line).join(",")}`);
  }
  for (let i = 1; i < session.failures.length; i += 1) {
    const current = session.failures[i];
    const previous = session.failures[i - 1];
    if (current.line - previous.line <= 12) addSignal(session, "failure-recovery-loop", current.line, 2, `${previous.detail} -> ${current.detail}`);
  }
  let serialReads = 0;
  for (const call of session.toolCalls) {
    if (READ_ONLY_COMMANDS.test(call.command)) serialReads += 1;
    else serialReads = 0;
    if (serialReads === 4) addSignal(session, "serial-read-only", call.line, serialReads, "Four consecutive read-only commands", "low");
  }

  const usage = session.turnUsage.reduce((totals, item) => ({
    input_tokens: totals.input_tokens + (item.input_tokens || 0),
    cached_input_tokens: totals.cached_input_tokens + (item.cached_input_tokens || 0),
    output_tokens: totals.output_tokens + (item.output_tokens || 0),
    reasoning_output_tokens: totals.reasoning_output_tokens + (item.reasoning_output_tokens || 0),
  }), { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });
  session.metrics = {
    inputTokens: session.turnUsage.length ? usage.input_tokens : null,
    cachedInputTokens: session.turnUsage.length ? usage.cached_input_tokens : null,
    uncachedInputTokens: session.turnUsage.length ? Math.max(0, usage.input_tokens - usage.cached_input_tokens) : null,
    outputTokens: session.turnUsage.length ? usage.output_tokens : null,
    reasoningOutputTokens: session.turnUsage.length ? usage.reasoning_output_tokens : null,
    contextReplayTokens: session.turnUsage.slice(1).reduce((sum, item) => sum + (item.input_tokens || 0), 0),
    toolCalls: session.toolCalls.length,
    failures: session.failures.length,
    signals: session.signals.length,
    largeOutputBytes: session.largeOutputBytes,
  };
  if (window.since || window.until) {
    session.start = session.windowStart;
    session.end = session.windowEnd;
  }
  return session;
}

function walk(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) files.push(full);
    }
  }
  return files.sort();
}

function requestFingerprint(text) {
  return compactText(text, 180).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function groupTaskTrees(sessions) {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const rootFor = (session) => {
    const seen = new Set([session.id]);
    let current = session;
    while (current.threadSource === "subagent" && current.parentThreadId) {
      if (seen.has(current.parentThreadId)) return { root: session.id, issue: "ancestry-cycle" };
      seen.add(current.parentThreadId);
      const parent = byId.get(current.parentThreadId);
      if (!parent) return { root: current.parentThreadId, issue: "parent-outside-scan" };
      current = parent;
    }
    return { root: current.id, issue: null };
  };
  const groups = new Map();
  for (const session of sessions) {
    const ancestry = rootFor(session);
    if (!groups.has(ancestry.root)) groups.set(ancestry.root, { members: [], issues: [] });
    groups.get(ancestry.root).members.push(session);
    if (ancestry.issue) groups.get(ancestry.root).issues.push({ sessionId: session.id, issue: ancestry.issue });
    if (session.ancestryCheckParentId && session.ancestryCheckParentId !== session.parentThreadId) {
      groups.get(ancestry.root).issues.push({ sessionId: session.id, issue: "contradictory-parent-fields" });
    }
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([rootId, group], index) => {
    const members = group.members;
    const sorted = members.sort((a, b) => String(a.start).localeCompare(String(b.start)) || a.id.localeCompare(b.id));
    const explicitLinks = sorted.reduce((sum, item) => sum + item.agentLinks.length, 0);
    const rootPresent = byId.has(rootId);
    return {
      id: `tree-${String(index + 1).padStart(4, "0")}`,
      rootThreadId: rootId,
      sessionIds: sorted.map((item) => item.id),
      coordinatorSessionId: rootPresent ? rootId : null,
      groupingConfidence: group.issues.length ? "low" : "high",
      groupingEvidence: sorted.length === 1 && !sorted[0].parentThreadId ? "standalone root session" : "explicit session_meta parent_thread_id ancestry",
      groupingIssues: group.issues,
      corroboratingSpawnEvents: explicitLinks,
      metrics: {
        inputTokens: sorted.reduce((sum, item) => sum + (item.metrics.inputTokens || 0), 0),
        uncachedInputTokens: sorted.reduce((sum, item) => sum + (item.metrics.uncachedInputTokens || 0), 0),
        largeOutputBytes: sorted.reduce((sum, item) => sum + item.metrics.largeOutputBytes, 0),
        failures: sorted.reduce((sum, item) => sum + item.metrics.failures, 0),
        signals: sorted.reduce((sum, item) => sum + item.metrics.signals, 0),
      },
    };
  });
}

function topBy(items, field, count) {
  return [...items]
    .sort((a, b) => (b.metrics[field] || 0) - (a.metrics[field] || 0) || a.id.localeCompare(b.id))
    .slice(0, count)
    .map((item) => ({ id: item.id, value: item.metrics[field] || 0 }));
}

export function buildRankings(sessions, trees) {
  const controls = [...sessions]
    .filter((item) => (item.metrics.inputTokens || 0) > 0)
    .sort((a, b) => (a.metrics.signals || 0) - (b.metrics.signals || 0) || (a.metrics.inputTokens || 0) - (b.metrics.inputTokens || 0) || a.id.localeCompare(b.id))
    .slice(0, 5)
    .map((item) => ({ id: item.id, value: item.metrics.signals || 0 }));
  const rankings = {
    sessions: {
      inputTokens: topBy(sessions, "inputTokens", 15),
      uncachedInputTokens: topBy(sessions, "uncachedInputTokens", 15),
      largeOutputBytes: topBy(sessions, "largeOutputBytes", 15),
      signals: topBy(sessions, "signals", 15),
      failures: topBy(sessions, "failures", 10),
    },
    taskTrees: {
      inputTokens: topBy(trees, "inputTokens", 15),
      signals: topBy(trees, "signals", 10),
    },
    controlSessions: controls,
  };
  const topTreeIds = new Set(Object.values(rankings.taskTrees).flat().map((item) => item.id));
  const treeCoordinatorIds = trees.filter((tree) => topTreeIds.has(tree.id)).map((tree) => tree.coordinatorSessionId).filter(Boolean);
  rankings.reviewSessionIds = [...new Set([
    ...Object.values(rankings.sessions).flat().map((item) => item.id),
    ...controls.map((item) => item.id),
    ...treeCoordinatorIds,
  ])].sort();
  return rankings;
}

function packetFor(session, tree, eventLimit) {
  const signals = session.signals.slice(0, Math.min(25, eventLimit));
  const citedLines = new Set(signals.flatMap((signal) => [signal.line, ...(signal.detail.match(/\b\d+\b/g) || []).map(Number)]));
  const relatedCalls = session.toolCalls.filter((call) => [...citedLines].some((line) => Math.abs(call.line - line) <= 3));
  const toolCandidates = [...new Map([
    ...relatedCalls,
    ...session.toolCalls.slice(0, 5),
    ...session.toolCalls.slice(-5),
  ].map((call) => [call.line, call])).values()];
  const events = [
    ...signals.map((item) => ({ kind: "signal", ...item })),
    ...session.failures.slice(0, 10).map((item) => ({ kind: "failure", ...item })),
    ...toolCandidates.map((item) => ({
      kind: "tool", line: item.line, timestamp: item.timestamp, taskIndex: item.taskIndex,
      activeRequest: item.activeRequest, name: item.name, command: item.command,
      outputBytes: item.outputBytes, failed: item.failed, outputPreview: item.outputPreview,
    })),
  ].sort((a, b) => a.line - b.line).slice(0, eventLimit);
  const eventTaskIndexes = new Set(events.map((item) => item.taskIndex).filter(Boolean));
  const userRequests = session.userRequests.filter((item) => eventTaskIndexes.has(item.taskIndex));
  const nearbyUsage = [];
  for (const event of events) {
    const after = session.turnUsage.find((usage) => usage.line >= event.line);
    if (after) nearbyUsage.push(after);
  }
  const turnUsage = [...new Map([
    session.turnUsage[0],
    ...nearbyUsage,
    session.turnUsage.at(-1),
  ].filter(Boolean).map((usage) => [usage.line, usage])).values()].sort((a, b) => a.line - b.line);
  const packet = {
    schemaVersion: 2,
    session: {
      id: session.id, path: session.path, start: session.start, end: session.end,
      cwd: session.cwd, model: session.model, sourceRequest: session.sourceRequest,
      metrics: session.metrics, completions: session.completions, badJson: session.badJson,
    },
    taskTree: tree,
    userRequests,
    finalAssistantMessages: session.assistantMessages.slice(-3),
    turnUsage,
    events,
    escalation: "Request bounded source windows by path and line number only when this packet cannot establish necessity.",
  };
  let encoded = stableJson(packet);
  while (Buffer.byteLength(encoded) > PACKET_BYTE_LIMIT && packet.events.length > 5) {
    packet.events.pop();
    encoded = stableJson(packet);
  }
  while (Buffer.byteLength(encoded) > PACKET_BYTE_LIMIT && packet.turnUsage.length > 2) {
    packet.turnUsage.splice(-2, 1);
    encoded = stableJson(packet);
  }
  while (Buffer.byteLength(encoded) > PACKET_BYTE_LIMIT && packet.userRequests.length > 1) {
    packet.userRequests.pop();
    encoded = stableJson(packet);
  }
  if (Buffer.byteLength(encoded) > PACKET_BYTE_LIMIT) {
    packet.finalAssistantMessages = packet.finalAssistantMessages.slice(-1);
  }
  return packet;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, stableJson(value));
}

function writeJsonl(filePath, values) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, values.map((value) => stableJson(value, 0).trim()).join("\n") + "\n");
}

export async function run(options) {
  const since = new Date(options.since);
  const until = new Date(options.until);
  if (!options.output || Number.isNaN(since.valueOf()) || Number.isNaN(until.valueOf()) || since >= until) {
    throw new Error("Valid --since, --until, and --output values are required");
  }
  const roots = options.roots.length ? options.roots.map((root) => path.resolve(root)) : [path.join(os.homedir(), ".codex", "sessions")];
  const candidates = [...new Set(roots.flatMap(walk))];
  const sessions = [];
  const excluded = [];
  for (const filePath of candidates) {
    const session = await analyzeLog(filePath, { since, until });
    const sessionStart = session.start ? new Date(session.start) : null;
    if (!session.windowStart && sessionStart && sessionStart >= until) continue;
    if (!session.windowStart) excluded.push({ path: filePath, reason: session.start ? "outside-window" : "missing-timestamp" });
    else sessions.push(session);
  }
  sessions.sort((a, b) => String(a.start).localeCompare(String(b.start)) || a.id.localeCompare(b.id));
  const trees = groupTaskTrees(sessions);
  const rankings = buildRankings(sessions, trees);
  const output = path.resolve(options.output);
  fs.rmSync(path.join(output, "packets"), { recursive: true, force: true });
  let sourceCommit = null;
  try {
    sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.dirname(fileURLToPath(import.meta.url)), encoding: "utf8" }).trim();
  } catch {
    // The scanner also works from source archives without Git metadata.
  }
  const manifest = {
    schemaVersion: 2, detectorVersion: "v1-calibrated", sourceCommit, since: since.toISOString(), until: until.toISOString(), roots,
    includedCount: sessions.length, excludedCount: excluded.length,
    thresholds: { largeOutputBytes: LARGE_OUTPUT_BYTES, forkHistoryBurstMs: FORK_HISTORY_BURST_MS, packetEventLimit: options.packetEventLimit, packetByteLimit: PACKET_BYTE_LIMIT },
  };
  writeJson(path.join(output, "run-manifest.json"), manifest);
  writeJsonl(path.join(output, "sessions.jsonl"), sessions.map(({ toolCalls, failures, turnUsage, agentLinks, excerpts, userRequests, assistantMessages, ...session }) => session));
  writeJsonl(path.join(output, "task-trees.jsonl"), trees);
  writeJson(path.join(output, "rankings.json"), rankings);
  writeJson(path.join(output, "scanner-warnings.json"), { excluded, malformedSessions: sessions.filter((item) => item.badJson).map((item) => ({ id: item.id, badJson: item.badJson })) });
  const treeBySession = new Map(trees.flatMap((tree) => tree.sessionIds.map((id) => [id, tree])));
  for (const id of rankings.reviewSessionIds) {
    const session = sessions.find((item) => item.id === id);
    writeJson(path.join(output, "packets", `${id}.json`), packetFor(session, treeBySession.get(id), options.packetEventLimit));
  }
  return { output, manifest, rankings };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { console.log(usage()); process.exit(0); }
    const result = await run(options);
    console.log(`Analyzed ${result.manifest.includedCount} sessions; wrote ${result.rankings.reviewSessionIds.length} review packets to ${result.output}`);
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(1);
  }
}
