import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeLog, buildRankings, groupTaskTrees } from "../scripts/rank-context-waste.mjs";

async function withLog(records, callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "context-waste-test-"));
  const file = path.join(dir, "rollout-2026-07-10T00-00-00-test.jsonl");
  const lines = records.map((record) => typeof record === "string" ? record : JSON.stringify(record));
  await fs.writeFile(file, lines.join("\n"));
  try { await callback(file); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

function meta(id, extra = {}) {
  return { timestamp: "2026-07-10T00:00:00Z", type: "session_meta", payload: { id, cwd: "/repo", ...extra } };
}

function tokens(timestamp, total, last) {
  return { timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last } } };
}

test("uses deduplicated in-window turn usage instead of cumulative snapshots", async () => {
  const prior = { input_tokens: 90_000, cached_input_tokens: 40_000, output_tokens: 100, reasoning_output_tokens: 10 };
  const first = { input_tokens: 1_000, cached_input_tokens: 400, output_tokens: 20, reasoning_output_tokens: 2 };
  const second = { input_tokens: 2_000, cached_input_tokens: 500, output_tokens: 30, reasoning_output_tokens: 3 };
  await withLog([
    meta("root"),
    tokens("2026-07-02T00:00:00Z", prior, prior),
    tokens("2026-07-10T01:00:00Z", { input_tokens: 91_000 }, first),
    tokens("2026-07-10T01:00:01Z", { input_tokens: 91_000 }, first),
    tokens("2026-07-10T02:00:00Z", { input_tokens: 93_000 }, second),
  ], async (file) => {
    const result = await analyzeLog(file, { since: new Date("2026-07-03T00:00:00Z"), until: new Date("2026-07-11T00:00:00Z") });
    assert.equal(result.turnUsage.length, 2);
    assert.equal(result.metrics.inputTokens, 3_000);
    assert.equal(result.metrics.cachedInputTokens, 900);
    assert.equal(result.metrics.uncachedInputTokens, 2_100);
    assert.equal(result.metrics.contextReplayTokens, 2_000);
  });
});

test("continues after malformed JSON and detects repeated commands", async () => {
  const call = (line) => ({ timestamp: `2026-07-10T00:00:0${line}Z`, type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "git status" }) } });
  await withLog([meta("root"), "{bad", call(1), call(2), call(3)], async (file) => {
    const result = await analyzeLog(file);
    assert.equal(result.badJson, 1);
    assert.ok(result.signals.some((signal) => signal.ruleId === "repeated-command" && signal.quantity === 3));
  });
});

test("keeps the first session metadata and ignores inherited fork history", async () => {
  const inherited = { input_tokens: 50_000, cached_input_tokens: 40_000, output_tokens: 10, reasoning_output_tokens: 1 };
  const childTurn = { input_tokens: 2_000, cached_input_tokens: 1_000, output_tokens: 20, reasoning_output_tokens: 2 };
  await withLog([
    meta("child", { thread_source: "subagent", parent_thread_id: "root" }),
    { timestamp: "2026-07-01T00:00:00Z", type: "session_meta", payload: { id: "root", thread_source: "user" } },
    tokens("2026-07-01T01:00:00Z", inherited, inherited),
    tokens("2026-07-10T00:00:00.100Z", inherited, inherited),
    tokens("2026-07-10T01:00:00Z", { input_tokens: 52_000 }, childTurn),
  ], async (file) => {
    const result = await analyzeLog(file, { since: new Date("2026-07-03T00:00:00Z"), until: new Date("2026-07-11T00:00:00Z") });
    assert.equal(result.id, "child");
    assert.equal(result.parentThreadId, "root");
    assert.equal(result.metrics.inputTokens, 2_000);
  });
});

test("groups only by explicit parent ancestry and preserves orphans", () => {
  const baseMetrics = { inputTokens: 1, uncachedInputTokens: 1, largeOutputBytes: 0, failures: 0, signals: 0 };
  const root = { id: "root", start: "2026-07-10T00:00:00Z", metrics: baseMetrics, agentLinks: [] };
  const child = { id: "child", start: "2026-07-10T00:01:00Z", threadSource: "subagent", parentThreadId: "root", ancestryCheckParentId: "root", metrics: baseMetrics, agentLinks: [] };
  const orphan = { id: "orphan", start: "2026-07-10T00:02:00Z", threadSource: "subagent", parentThreadId: "missing", ancestryCheckParentId: "missing", metrics: baseMetrics, agentLinks: [] };
  const trees = groupTaskTrees([child, orphan, root]);
  assert.equal(trees.length, 2);
  assert.deepEqual(trees.find((tree) => tree.rootThreadId === "root").sessionIds, ["root", "child"]);
  assert.equal(trees.find((tree) => tree.rootThreadId === "missing").groupingIssues[0].issue, "parent-outside-scan");
});

test("rankings are deterministic and retain independent metrics", () => {
  const sessions = [
    { id: "b", metrics: { inputTokens: 5, uncachedInputTokens: 2, largeOutputBytes: 0, signals: 4, failures: 0 } },
    { id: "a", metrics: { inputTokens: 5, uncachedInputTokens: 3, largeOutputBytes: 9, signals: 1, failures: 1 } },
  ];
  const rankings = buildRankings(sessions, []);
  assert.deepEqual(rankings.sessions.inputTokens.map((item) => item.id), ["a", "b"]);
  assert.deepEqual(rankings.sessions.signals.map((item) => item.id), ["b", "a"]);
  assert.deepEqual(rankings.reviewSessionIds, ["a", "b"]);
});
