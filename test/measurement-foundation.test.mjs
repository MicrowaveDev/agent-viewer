import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import "../public/export-cleaner.js";
import { compareMeasurements, comparisonExitCode, summarizeMeasurementDirectory } from "../scripts/compare-context-measurements.mjs";
import { ANALYSIS_SCHEMA_VERSION, DETECTOR_VERSION } from "../scripts/measurement-foundation.mjs";
import { analyzeLog, run } from "../scripts/rank-context-waste.mjs";
import { cleanedExportFixture, comparisonGateFixtures, correlationFixture, lifecycleAndWasteFixture } from "./fixtures/measurement-fixtures.mjs";

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

async function writeMeasurementSummary(root, name, summary) {
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "run-manifest.json"), JSON.stringify({
    schemaVersion: summary.schemaVersion,
    detectorVersion: summary.detectorVersion,
    since: summary.since,
    until: summary.until,
  }));
  const signals = Object.entries(summary.detectors).flatMap(([ruleId, detector]) =>
    Array.from({ length: detector.occurrences }, () => ({ ruleId, quantity: detector.quantity / detector.occurrences })));
  await fs.writeFile(path.join(directory, "sessions.jsonl"), `${JSON.stringify({ metrics: summary.metrics, signals })}\n`);
  return directory;
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
  assert.equal(result.metrics.routeRereadsAfterTaskContext, 1);
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
  assert.equal(first.comparisonSchemaVersion, 2);
  assert.match(first.interpretation, /does not estimate causal savings/);
  assert.equal(first.detectorDeltas.length, 2);
  assert.equal(first.detectorDeltasTruncated, true);
  assert.equal(first.metrics.find((item) => item.metric === "commandOutputBytes").observedDelta, -20);
  assert.equal(first.gate.verdict, "informational");
});

test("regression gate passes improvements and fails deterministic regressions", () => {
  const fixtures = comparisonGateFixtures();
  const positive = compareMeasurements(fixtures.positive.before, fixtures.positive.after, { gate: true });
  const negative = compareMeasurements(fixtures.negative.before, fixtures.negative.after, { gate: true });
  assert.equal(positive.gate.verdict, "pass");
  assert.equal(comparisonExitCode(positive), 0);
  assert.equal(negative.gate.verdict, "fail");
  assert.equal(comparisonExitCode(negative), 1);
  assert.deepEqual(negative.gate.reasons.map((reason) => reason.category), [
    "route",
    "context-reread",
    "raw-artifact-replay",
    "oversized-repeat",
    "unmatched-or-duplicated-attribution",
    "completed-task-guardrail",
    "final-linked-task-guardrail",
  ]);
  assert.equal(compareMeasurements(fixtures.negative.before, fixtures.negative.after).gate.verdict, "informational");
});

test("comparison requires compatible versions by default", () => {
  const { incompatible } = comparisonGateFixtures();
  const blocked = compareMeasurements(incompatible.before, incompatible.after, { gate: true });
  assert.equal(blocked.compatibility.compatible, false);
  assert.equal(blocked.gate.verdict, "incompatible");
  assert.deepEqual(blocked.compatibility.reasons.map((reason) => reason.code), ["detector-version-mismatch"]);
  assert.equal(comparisonExitCode(blocked), 2);

  const informational = compareMeasurements(incompatible.before, incompatible.after, { requireCompatible: false });
  assert.equal(informational.compatibility.required, false);
  assert.equal(informational.gate.verdict, "informational");
  assert.equal(comparisonExitCode(informational), 0);

  const invalidGate = compareMeasurements(incompatible.before, incompatible.after, { gate: true, requireCompatible: false });
  assert.equal(comparisonExitCode(invalidGate), 2);
});

test("comparison CLI keeps weekly runs informational and exits nonzero for gated or incompatible regressions", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "comparison-cli-"));
  const script = fileURLToPath(new URL("../scripts/compare-context-measurements.mjs", import.meta.url));
  const fixtures = comparisonGateFixtures();
  try {
    const before = await writeMeasurementSummary(directory, "before", fixtures.negative.before);
    const regressed = await writeMeasurementSummary(directory, "regressed", fixtures.negative.after);
    const incompatible = await writeMeasurementSummary(directory, "incompatible", fixtures.incompatible.after);
    const invoke = (after, extra = [], outputName = "report.json") => spawnSync(process.execPath, [
      script, "--before", before, "--after", after, "--output", path.join(directory, outputName), ...extra,
    ], { encoding: "utf8" });

    assert.equal(invoke(regressed, [], "weekly.json").status, 0);
    const gated = invoke(regressed, ["--gate"], "gated.json");
    assert.equal(gated.status, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, "gated.json"), "utf8")).gate.verdict, "fail");
    assert.equal(invoke(incompatible, [], "blocked.json").status, 2);
    assert.equal(invoke(incompatible, ["--allow-incompatible"], "allowed.json").status, 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("gate compares normalized rates instead of corpus totals", () => {
  const { positive } = comparisonGateFixtures();
  const before = structuredClone(positive.after);
  const after = structuredClone(positive.after);
  before.detectors["raw-artifact-replay"] = { occurrences: 1, quantity: 4_000 };
  after.metrics.taskCount = 20;
  after.metrics.completedTaskCount = 20;
  after.metrics.finalLinkedTaskCount = 20;
  after.metrics.attributedOutputCount = 40;
  after.detectors["raw-artifact-replay"] = { occurrences: 2, quantity: 8_000 };
  const report = compareMeasurements(before, after, { gate: true });
  assert.equal(report.gate.verdict, "pass");
  assert.equal(report.normalizedRates.find((item) => item.category === "raw-artifact-replay").observedRateDelta, 0);
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
    const rootArtifactFiles = (await fs.readdir(output)).filter((name) => name !== "packets");
    const allArtifactContent = (await Promise.all([
      ...rootArtifactFiles.map((name) => fs.readFile(path.join(output, name), "utf8")),
      ...packetFiles.map((name) => fs.readFile(path.join(output, "packets", name), "utf8")),
    ])).join("\n");
    assert.equal(manifest.schemaVersion, ANALYSIS_SCHEMA_VERSION);
    assert.equal(manifest.detectorVersion, DETECTOR_VERSION);
    assert.doesNotMatch(sessions, /fixture-(?:oversized|artifact)-/);
    assert.doesNotMatch(packet, /fixture-(?:oversized|artifact)-/);
    assert.doesNotMatch(allArtifactContent, /rawInput|rawOutput/);
    assert.equal(JSON.parse(packet).schemaVersion, ANALYSIS_SCHEMA_VERSION);
    assert.equal(summarizeMeasurementDirectory(output).sessionCount, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
