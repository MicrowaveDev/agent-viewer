import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import "../public/export-cleaner.js";
import { compareMeasurements, summarizeMeasurementDirectory } from "../scripts/compare-context-measurements.mjs";
import { ANALYSIS_SCHEMA_VERSION, DETECTOR_VERSION } from "../scripts/measurement-foundation.mjs";
import { analyzeLog, run } from "../scripts/rank-context-waste.mjs";
import { cleanedExportFixture, correlationFixture, lifecycleAndWasteFixture } from "./fixtures/measurement-fixtures.mjs";

async function analyzeFixture(records) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "measurement-foundation-"));
  const file = path.join(directory, "rollout-2026-07-10T00-00-00-fixture.jsonl");
  await fs.writeFile(file, records.map((record) => JSON.stringify(record)).join("\n"));
  try {
    return await analyzeLog(file);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("cleaned exports preserve correlation metadata and redact sensitive bodies", () => {
  const source = cleanedExportFixture().map((record) => JSON.stringify(record)).join("\n");
  const cleaned = globalThis.AgentViewerExportCleaner.cleanForCopy(source);
  const records = cleaned.split("\n").map((line) => JSON.parse(line));
  assert.equal(records[0].payload.id, "clean-session");
  assert.equal(records[0].payload.parent_thread_id, "parent-session");
  assert.equal(records[0].payload.source.subagent.thread_spawn.parent_thread_id, "parent-session");
  assert.equal(records[1].payload.call_id, "clean-call");
  assert.equal(records[1].payload.session_id, "clean-session");
  assert.equal(records[1].payload.turn_id, "turn-one");
  assert.equal(records[1].payload.encrypted_content, undefined);
  assert.equal(records[2].payload.result, "[redacted generated image base64]");
  assert.equal(records[2].payload.result_bytes, 18);
});

test("attributes matched, unmatched, duplicate, nested, and session-correlated outputs once", async () => {
  const result = await analyzeFixture(correlationFixture());
  assert.equal(result.toolOutputs.length, 7);
  assert.equal(result.metrics.attributedOutputCount, 6);
  assert.equal(result.metrics.unmatchedOutputCount, 1);
  assert.equal(result.metrics.lowConfidenceOutputCount, 2);
  assert.equal(result.toolOutputs.find((item) => item.correlation.call_id === "unique").attributionConfidence, "high");
  assert.equal(result.toolOutputs.find((item) => item.correlation.call_id === "missing").attributionReason, "unmatched-call-id");
  assert.deepEqual(result.toolOutputs.filter((item) => item.correlation.call_id === "duplicate").map((item) => item.attributionConfidence), ["low", "low"]);
  assert.deepEqual(result.toolOutputs.filter((item) => item.correlation.call_id === "async").map((item) => item.attributionConfidence), ["high", "high"]);
  assert.equal(result.toolOutputs.find((item) => item.correlation.session_id === "session-three").attributionConfidence, "medium");
  assert.equal(result.toolCalls.reduce((sum, call) => sum + call.outputCount, 0), 6);
});

test("measures repeated inputs, outputs, rereads, artifact replay, and multi-task final linkage", async () => {
  const result = await analyzeFixture(lifecycleAndWasteFixture());
  assert.ok(result.metrics.commandOutputBytes > 4_100);
  assert.ok(result.metrics.repeatedOversizedToolInputBytes > 16_000);
  assert.equal(result.metrics.instructionRereadsAfterTaskContext, 1);
  assert.ok(result.metrics.rawArtifactReplayBytes > 4_000);
  assert.equal(result.metrics.taskCount, 2);
  assert.equal(result.metrics.completedTaskCount, 2);
  assert.equal(result.metrics.finalLinkedTaskCount, 2);
  assert.deepEqual(result.taskLifecycle.map((task) => task.status), ["complete-with-final", "complete-with-final"]);
  assert.deepEqual(result.taskLifecycle.map((task) => task.linkageConfidence), ["high", "medium"]);
  assert.ok(result.signals.every((signal) => !signal.detail.includes("fixture-artifact-yyyy")));
  assert.ok(result.toolCalls.every((call) => !call.command.includes("fixture-oversized-xxxx")));
});

test("comparison is deterministic, bounded, versioned, and non-causal", () => {
  const before = {
    schemaVersion: ANALYSIS_SCHEMA_VERSION, detectorVersion: DETECTOR_VERSION, since: "2026-07-01", until: "2026-07-02", sessionCount: 1,
    metrics: { commandOutputBytes: 100, taskCount: 1 },
    detectors: { zeta: { occurrences: 1, quantity: 10 }, alpha: { occurrences: 2, quantity: 2 } },
  };
  const after = {
    schemaVersion: ANALYSIS_SCHEMA_VERSION, detectorVersion: DETECTOR_VERSION, since: "2026-07-08", until: "2026-07-09", sessionCount: 1,
    metrics: { commandOutputBytes: 80, taskCount: 1 },
    detectors: { zeta: { occurrences: 2, quantity: 40 }, beta: { occurrences: 1, quantity: 3 } },
  };
  const first = compareMeasurements(before, after, 2);
  const second = compareMeasurements(before, after, 2);
  assert.deepEqual(first, second);
  assert.equal(first.comparisonSchemaVersion, 1);
  assert.match(first.interpretation, /does not estimate causal savings/);
  assert.equal(first.detectorDeltas.length, 2);
  assert.equal(first.detectorDeltasTruncated, true);
  assert.equal(first.metrics.find((item) => item.metric === "commandOutputBytes").observedDelta, -20);
});

test("scanner artifacts are versioned, bounded, and exclude raw tool payload bodies", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "measurement-artifacts-"));
  const input = path.join(directory, "input");
  const output = path.join(directory, "output");
  await fs.mkdir(input);
  await fs.writeFile(
    path.join(input, "rollout-2026-07-10T00-00-00-fixture.jsonl"),
    lifecycleAndWasteFixture().map((record) => JSON.stringify(record)).join("\n"),
  );
  try {
    await run({
      since: "2026-07-10T00:00:00Z",
      until: "2026-07-11T00:00:00Z",
      output,
      roots: [input],
      packetEventLimit: 50,
    });
    const manifest = JSON.parse(await fs.readFile(path.join(output, "run-manifest.json"), "utf8"));
    const sessions = await fs.readFile(path.join(output, "sessions.jsonl"), "utf8");
    const packetFiles = await fs.readdir(path.join(output, "packets"));
    const packet = await fs.readFile(path.join(output, "packets", packetFiles[0]), "utf8");
    assert.equal(manifest.schemaVersion, ANALYSIS_SCHEMA_VERSION);
    assert.equal(manifest.detectorVersion, DETECTOR_VERSION);
    assert.doesNotMatch(sessions, /fixture-(?:oversized|artifact)-/);
    assert.doesNotMatch(packet, /fixture-(?:oversized|artifact)-/);
    assert.equal(JSON.parse(packet).schemaVersion, ANALYSIS_SCHEMA_VERSION);
    assert.equal(summarizeMeasurementDirectory(output).sessionCount, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
