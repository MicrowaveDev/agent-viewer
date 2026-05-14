#!/usr/bin/env node

import fs from "fs";
import path from "path";
import readline from "readline";

const args = process.argv.slice(2);
const filePath = args.find((arg) => !arg.startsWith("-"));
const mode = args.includes("--workflow-waste")
  ? "workflow-waste"
  : args.includes("--all")
    ? "all"
    : "summary";

if (!filePath || args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: yarn agent:analyze-log <rollout.jsonl> [--all|--workflow-waste]

Streams a Codex/Claude JSONL log and prints compact analysis without emitting
large image/base64 payloads.`);
  process.exit(filePath ? 0 : 1);
}

const absPath = path.resolve(filePath);
if (!fs.existsSync(absPath)) {
  console.error(`Log file not found: ${absPath}`);
  process.exit(1);
}

const stats = fs.statSync(absPath);
const summary = {
  lines: 0,
  badJson: 0,
  types: new Map(),
  payloadTypes: new Map(),
  roles: new Map(),
  userRequests: [],
  assistantMessages: [],
  toolCalls: [],
  toolFailures: [],
  largeToolOutputs: [],
  imageGenerations: [],
  imageBytes: 0,
  largeRecords: [],
  taskCompleteCount: 0,
};

function addCount(map, key) {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + 1);
}

function compactText(text, max = 220) {
  return String(text || "")
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi, " [image] ")
    .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, "[image base64 redacted]")
    .replace(/[A-Za-z0-9+/=]{500,}/g, "[base64 redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function firstTextFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => block?.text || block?.message || "")
    .filter(Boolean)
    .join("\n");
}

function shouldKeepUserRequest(text) {
  if (!text) return false;
  if (text.startsWith("<environment_context>")) return false;
  if (text.startsWith("# AGENTS.md instructions")) return false;
  return true;
}

function pushUserRequest(item) {
  if (!shouldKeepUserRequest(item.text)) return;
  const previous = summary.userRequests[summary.userRequests.length - 1];
  if (previous?.text === item.text) return;
  summary.userRequests.push(item);
}

function describeToolCall(payload) {
  if (payload.type === "custom_tool_call") {
    return {
      name: payload.name || "custom_tool",
      detail: compactText(payload.name === "apply_patch" ? "apply_patch" : payload.input),
    };
  }

  let detail = payload.arguments || "";
  try {
    const parsed = JSON.parse(detail);
    detail = parsed.cmd || parsed.command || parsed.query || JSON.stringify(parsed);
  } catch {
    // Keep raw detail.
  }
  return {
    name: payload.name || "function_call",
    detail: compactText(detail),
  };
}

function summarizeImageGeneration(evt, payload, lineBytes) {
  const resultBytes = typeof payload.result === "string"
    ? Buffer.byteLength(payload.result, "utf8")
    : 0;
  summary.imageBytes += resultBytes;
  summary.imageGenerations.push({
    line: summary.lines,
    timestamp: evt.timestamp,
    type: payload.type,
    status: payload.status,
    savedPath: payload.saved_path,
    resultBytes,
    prompt: compactText(payload.revised_prompt || payload.prompt, 180),
    recordBytes: lineBytes,
  });
}

function collectEvent(evt, line, lineBytes) {
  summary.lines += 1;
  addCount(summary.types, evt.type);

  const payload = evt.payload || evt.message || {};
  addCount(summary.payloadTypes, payload.type);
  addCount(summary.roles, payload.role || evt.message?.role);

  if (lineBytes > 50000) {
    summary.largeRecords.push({
      line: summary.lines,
      type: evt.type,
      payloadType: payload.type,
      bytes: lineBytes,
    });
  }

  if (String(payload.type || "").startsWith("image_generation_")) {
    summarizeImageGeneration(evt, payload, lineBytes);
    return;
  }

  if (evt.type === "event_msg" && payload.type === "user_message") {
    const text = compactText(payload.message || payload.text_elements?.join(" "), 280);
    pushUserRequest({ line: summary.lines, timestamp: evt.timestamp, text });
    return;
  }

  if (evt.type === "response_item" && payload.type === "message") {
    const text = compactText(firstTextFromContent(payload.content), 280);
    if (payload.role === "user") {
      pushUserRequest({ line: summary.lines, timestamp: evt.timestamp, text });
    }
    if (payload.role === "assistant" && text) {
      summary.assistantMessages.push({
        line: summary.lines,
        timestamp: evt.timestamp,
        phase: payload.phase,
        text,
      });
    }
    return;
  }

  if (
    evt.type === "response_item" &&
    (payload.type === "function_call" || payload.type === "custom_tool_call")
  ) {
    summary.toolCalls.push({
      line: summary.lines,
      timestamp: evt.timestamp,
      ...describeToolCall(payload),
    });
    return;
  }

  if (
    evt.type === "response_item" &&
    (payload.type === "function_call_output" || payload.type === "custom_tool_call_output")
  ) {
    const output = typeof payload.output === "string"
      ? payload.output
      : JSON.stringify(payload.output || "");
    const isFailure =
      /exit code [1-9]/.test(output) ||
      /metadata"?\s*:\s*\{[^}]*"exit_code"?\s*:\s*[1-9]/.test(output);
    if (isFailure) {
      summary.toolFailures.push({
        line: summary.lines,
        timestamp: evt.timestamp,
        output: compactText(output, 220),
      });
    }
    if (Buffer.byteLength(output, "utf8") > 20000) {
      summary.largeToolOutputs.push({
        line: summary.lines,
        timestamp: evt.timestamp,
        bytes: Buffer.byteLength(output, "utf8"),
        preview: compactText(output, 160),
      });
    }
    return;
  }

  if (evt.type === "event_msg" && payload.type === "task_complete") {
    summary.taskCompleteCount += 1;
  }
}

const rl = readline.createInterface({
  input: fs.createReadStream(absPath, { encoding: "utf8" }),
  crlfDelay: Infinity,
});

for await (const line of rl) {
  if (!line) continue;
  const lineBytes = Buffer.byteLength(line, "utf8");
  try {
    collectEvent(JSON.parse(line), line, lineBytes);
  } catch {
    summary.lines += 1;
    summary.badJson += 1;
  }
}

function topEntries(map, max = 12) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([key, count]) => `- ${key}: ${count}`)
    .join("\n");
}

function repeatedToolFamilies() {
  const counts = new Map();
  for (const call of summary.toolCalls) {
    const key = call.name === "exec_command"
      ? call.detail.split(/\s+/).slice(0, 3).join(" ")
      : call.name;
    addCount(counts, key || call.name);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);
}

function printSection(title, body) {
  console.log(`\n## ${title}`);
  console.log(body || "- none");
}

console.log(`# Log Analysis: ${path.basename(absPath)}`);
console.log(`Mode: ${mode}`);
console.log(`Size: ${formatBytes(stats.size)}`);

printSection(
  "Shape",
  [
    `- JSONL records: ${summary.lines}`,
    `- Bad JSON records: ${summary.badJson}`,
    `- Task completions: ${summary.taskCompleteCount}`,
    `- Image generation records: ${summary.imageGenerations.length}`,
    `- Image result bytes redacted from analysis: ${formatBytes(summary.imageBytes)}`,
    `- Records over 50 KB: ${summary.largeRecords.length}`,
  ].join("\n"),
);

printSection("Payload Types", topEntries(summary.payloadTypes));

printSection(
  "Source Request",
  summary.userRequests
    .slice(0, 8)
    .map((req) => `- line ${req.line}: ${req.text}`)
    .join("\n"),
);

if (mode === "all" || mode === "workflow-waste") {
  const repeated = repeatedToolFamilies();
  printSection(
    "Workflow Waste Signals",
    [
      `- Tool calls: ${summary.toolCalls.length}`,
      `- Tool failures: ${summary.toolFailures.length}`,
      `- Large tool outputs over 20 KB: ${summary.largeToolOutputs.length}`,
      `- Repeated command/tool families: ${
        repeated.length
          ? repeated.map(([key, count]) => `${key} (${count})`).join(", ")
          : "none"
      }`,
    ].join("\n"),
  );

  printSection(
    "Tool Failures",
    summary.toolFailures
      .slice(0, 10)
      .map((item) => `- line ${item.line}: ${item.output}`)
      .join("\n"),
  );

  printSection(
    "Large Records",
    summary.largeRecords
      .slice(0, 12)
      .map(
        (item) =>
          `- line ${item.line}: ${item.type}/${item.payloadType || "unknown"} ${formatBytes(item.bytes)}`,
      )
      .join("\n"),
  );
}

printSection(
  "Image Generations",
  summary.imageGenerations
    .slice(0, 20)
    .map(
      (item) =>
        `- line ${item.line}: ${item.type} ${item.status || ""} ${formatBytes(item.resultBytes)} ${item.savedPath || ""} ${item.prompt ? `| ${item.prompt}` : ""}`.trim(),
    )
    .join("\n"),
);

if (summary.imageGenerations.length > 20) {
  console.log(`- ... ${summary.imageGenerations.length - 20} more image generation records`);
}
