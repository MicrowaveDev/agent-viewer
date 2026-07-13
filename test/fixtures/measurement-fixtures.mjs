const timestamp = (second) => `2026-07-10T00:00:${String(second).padStart(2, "0")}Z`;

const event = (second, type, payload) => ({ timestamp: timestamp(second), type, payload });
const call = (second, callId, name, input, correlation = {}) => event(second, "response_item", {
  type: "custom_tool_call", name, input, call_id: callId, ...correlation,
});
const output = (second, callId, value, correlation = {}) => event(second, "response_item", {
  type: "custom_tool_call_output", call_id: callId, output: value, ...correlation,
});

export function correlationFixture() {
  return [
    event(0, "session_meta", { id: "fixture-session", cwd: "/fixture" }),
    event(1, "event_msg", { type: "user_message", message: "Measure correlation behavior" }),
    call(2, "unique", "fixture_tool", "small input"),
    output(3, "unique", "unique result"),
    output(4, "missing", "unmatched result"),
    call(5, "duplicate", "fixture_tool", "first duplicate"),
    call(6, "duplicate", "fixture_tool", "second duplicate"),
    event(7, "response_item", {
      type: "batch",
      items: [{ type: "custom_tool_call_output", call_id: "duplicate", output: "first duplicate result" }],
    }),
    output(8, "duplicate", "second duplicate result"),
    call(9, "async", "async_tool", "session one", { session_id: "session-one" }),
    call(10, "async", "async_tool", "session two", { session_id: "session-two" }),
    output(11, "async", "session two result", { session_id: "session-two" }),
    output(12, "async", "session one result", { session_id: "session-one" }),
    call(13, "session-call", "async_tool", "session fallback", { session_id: "session-three" }),
    output(14, null, "session fallback result", { session_id: "session-three" }),
  ];
}

export function lifecycleAndWasteFixture() {
  const oversizedInput = `fixture-oversized-${"x".repeat(8_100)}`;
  const artifact = `fixture-artifact-${"y".repeat(4_100)}`;
  return [
    event(0, "session_meta", { id: "lifecycle-session", cwd: "/fixture" }),
    event(1, "event_msg", { type: "user_message", message: "Complete task one" }),
    event(2, "response_item", { type: "function_call", name: "exec_command", call_id: "context", arguments: JSON.stringify({ cmd: "npm run task:context -- agent-viewer" }) }),
    output(3, "context", JSON.stringify({ exit_code: 0, output: "context complete" })),
    event(4, "response_item", { type: "function_call", name: "exec_command", call_id: "reread", arguments: JSON.stringify({ cmd: "sed -n '1,80p' AGENTS.md" }) }),
    output(5, "reread", "instructions"),
    call(6, "large-one", "fixture_tool", oversizedInput),
    output(7, "large-one", artifact),
    call(8, "large-two", "fixture_tool", oversizedInput),
    output(9, "large-two", "second result"),
    call(10, "replay", "fixture_tool", `prefix:${artifact}:suffix`),
    output(11, "replay", "replay accepted"),
    event(12, "response_item", { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Task one done" }] }),
    event(13, "event_msg", { type: "task_complete" }),
    event(14, "event_msg", { type: "user_message", message: "Complete task two" }),
    event(15, "event_msg", { type: "task_complete", final_message: "Task two done" }),
  ];
}

export function cleanedExportFixture() {
  return [
    event(0, "session_meta", {
      id: "clean-session", cwd: "/fixture", thread_source: "subagent", parent_thread_id: "parent-session",
      source: { subagent: { thread_spawn: { parent_thread_id: "parent-session" } } },
    }),
    event(1, "response_item", {
      type: "function_call", name: "fixture_tool", call_id: "clean-call", turn_id: "turn-one",
      session_id: "clean-session", arguments: "{}", encrypted_content: "ciphertext-placeholder",
    }),
    event(2, "event_msg", { type: "image_generation_complete", result: "base64-placeholder", saved_path: "/fixture/image.png" }),
  ];
}
