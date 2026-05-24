#!/usr/bin/env node
import fs from "fs";
import path from "path";

function usage() {
  console.error("Usage: yarn agent:analyze-log <rollout.jsonl> [--all|--workflow-waste]");
  process.exit(2);
}

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith("--"));
const mode = args.includes("--workflow-waste")
  ? "workflow-waste"
  : args.includes("--all")
    ? "all"
    : "summary";

if (!file) usage();

const abs = path.resolve(file);
if (!fs.existsSync(abs)) {
  console.error(`Log not found: ${abs}`);
  process.exit(1);
}

const lines = fs.readFileSync(abs, "utf8").split(/\n/).filter(Boolean);
const events = [];
for (let index = 0; index < lines.length; index += 1) {
  try {
    events.push({ line: index + 1, value: JSON.parse(lines[index]) });
  } catch (err) {
    events.push({ line: index + 1, parseError: err.message });
  }
}

function textOf(event) {
  return JSON.stringify(event.value ?? {});
}

function payload(event) {
  return event.value?.payload || {};
}

const userMessages = events
  .filter((event) => event.value?.type === "event_msg" && payload(event).type === "user_message")
  .map((event) => ({ line: event.line, text: payload(event).message || "" }));

const assistantMessages = events
  .filter((event) => event.value?.type === "event_msg" && payload(event).type === "agent_message")
  .map((event) => ({ line: event.line, text: payload(event).message || "", phase: payload(event).phase || "" }));

const functionCalls = events
  .filter((event) => event.value?.type === "response_item" && payload(event).type === "function_call")
  .map((event) => ({
    line: event.line,
    name: payload(event).name,
    arguments: payload(event).arguments || ""
  }));

const commandCalls = functionCalls.filter((call) => call.name === "exec_command");
const spawnCalls = functionCalls.filter((call) => /spawn_agent|wait_agent/.test(call.name));
const toolErrors = events.filter((event) => /error|failed|Cannot index|not found|rejected/i.test(textOf(event)));
const failedCommandOutputs = events.filter((event) => {
  if (event.value?.type !== "response_item" || payload(event).type !== "function_call_output") return false;
  const output = String(payload(event).output || "");
  const code = output.match(/Process exited with code (\d+)/);
  return (
    (code && Number(code[1]) !== 0)
    || /error Command|Cannot index|^not ok\b/im.test(output)
  );
});

function compact(value, max = 180) {
  return String(value).replace(/\s+/g, " ").slice(0, max);
}

function printSection(title) {
  console.log(`\n## ${title}`);
}

console.log(`# Agent Log Analysis: ${path.basename(abs)}`);
console.log(`mode: ${mode}`);
console.log(`lines: ${lines.length}`);

printSection("User Messages");
for (const msg of userMessages) {
  console.log(`- line ${msg.line}: ${compact(msg.text, 260)}`);
}

printSection("Command Summary");
console.log(`- function calls: ${functionCalls.length}`);
console.log(`- shell commands: ${commandCalls.length}`);
console.log(`- sub-agent calls: ${spawnCalls.length}`);
console.log(`- failed command outputs: ${failedCommandOutputs.length}`);
console.log(`- suspicious error-like events: ${toolErrors.length}`);

if (mode === "all" || mode === "workflow-waste") {
  printSection("Workflow-Waste Leads");
  const badSpawn = spawnCalls.filter((call) => /fork_context/.test(call.arguments));
  if (badSpawn.length) {
    for (const call of badSpawn) {
      console.log(`- line ${call.line}: spawn_agent call includes fork_context; retry likely needed.`);
    }
  }

  const broadReads = commandCalls.filter((call) => /sed -n '1,[2-9][0-9]{2}p'/.test(call.arguments));
  if (broadReads.length > 5) {
    console.log(`- ${broadReads.length} broad file reads; consider a narrower workflow helper or summary command.`);
  }

  for (const event of failedCommandOutputs.slice(0, 12)) {
    console.log(`- line ${event.line}: failed output: ${compact(payload(event).output, 240)}`);
  }

  const final = assistantMessages.filter((msg) => /final_answer|complete/i.test(msg.phase || msg.text)).at(-1);
  if (final) {
    console.log(`- final/handoff line ${final.line}: ${compact(final.text, 300)}`);
  }
}

if (mode === "all") {
  printSection("Function Calls");
  for (const call of functionCalls) {
    console.log(`- line ${call.line}: ${call.name} ${compact(call.arguments, 220)}`);
  }
}
