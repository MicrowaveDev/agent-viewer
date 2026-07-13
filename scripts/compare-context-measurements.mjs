#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMPARISON_SCHEMA_VERSION = 2;
const DEFAULT_FINDING_LIMIT = 20;
const METRIC_KEYS = [
  "inputTokens",
  "uncachedInputTokens",
  "contextReplayTokens",
  "toolCalls",
  "commandOutputBytes",
  "largeOutputBytes",
  "repeatedOversizedToolInputBytes",
  "instructionRereadsAfterTaskContext",
  "rawArtifactReplayBytes",
  "routeRereadsAfterTaskContext",
  "taskCount",
  "completedTaskCount",
  "finalLinkedTaskCount",
  "attributedOutputCount",
  "unmatchedOutputCount",
  "lowConfidenceOutputCount",
];

const GATE_RATE_DEFINITIONS = [
  { category: "route", direction: "increase", detectorIds: ["route-reread-after-successful-task-context"], denominator: "taskCount" },
  { category: "context-reread", direction: "increase", detectorIds: ["instruction-reread-after-successful-task-context"], denominator: "taskCount" },
  { category: "raw-artifact-replay", direction: "increase", detectorIds: ["raw-artifact-replay"], denominator: "taskCount" },
  { category: "oversized-repeat", direction: "increase", detectorIds: ["repeated-oversized-tool-input"], denominator: "taskCount" },
  { category: "unmatched-or-duplicated-attribution", direction: "increase", metricKeys: ["unmatchedOutputCount", "lowConfidenceOutputCount"], denominator: "outputCount" },
  { category: "completed-task-guardrail", direction: "decrease", metricKeys: ["completedTaskCount"], denominator: "taskCount" },
  { category: "final-linked-task-guardrail", direction: "decrease", metricKeys: ["finalLinkedTaskCount"], denominator: "taskCount" },
];

function stableJson(value) {
  const sort = (item) => {
    if (Array.isArray(item)) return item.map(sort);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, sort(item[key])]));
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function summarizeMeasurementDirectory(directory) {
  const root = path.resolve(directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "run-manifest.json"), "utf8"));
  const sessions = readJsonl(path.join(root, "sessions.jsonl"));
  const metrics = Object.fromEntries(METRIC_KEYS.map((key) => [key,
    sessions.reduce((sum, session) => sum + (Number(session.metrics?.[key]) || 0), 0)]));
  const detectors = new Map();
  for (const session of sessions) {
    for (const signal of session.signals || []) {
      const current = detectors.get(signal.ruleId) || { occurrences: 0, quantity: 0 };
      current.occurrences += 1;
      current.quantity += Number(signal.quantity) || 0;
      detectors.set(signal.ruleId, current);
    }
  }
  return {
    schemaVersion: manifest.schemaVersion,
    detectorVersion: manifest.detectorVersion,
    since: manifest.since,
    until: manifest.until,
    sessionCount: sessions.length,
    metrics,
    detectors: Object.fromEntries([...detectors.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
}

function compatibilityFor(before, after, required) {
  const reasons = [];
  if (before.schemaVersion !== after.schemaVersion) reasons.push({
    code: "schema-version-mismatch", before: before.schemaVersion ?? null, after: after.schemaVersion ?? null,
  });
  if (before.detectorVersion !== after.detectorVersion) reasons.push({
    code: "detector-version-mismatch", before: before.detectorVersion ?? null, after: after.detectorVersion ?? null,
  });
  return { required, compatible: reasons.length === 0, reasons };
}

function detectorOccurrences(summary, detectorIds) {
  return detectorIds.reduce((sum, ruleId) => sum + (summary.detectors[ruleId]?.occurrences || 0), 0);
}

function metricTotal(summary, metricKeys) {
  return metricKeys.reduce((sum, key) => sum + (summary.metrics[key] || 0), 0);
}

function rateValue(summary, definition) {
  const numerator = definition.detectorIds
    ? detectorOccurrences(summary, definition.detectorIds)
    : metricTotal(summary, definition.metricKeys);
  const denominator = definition.denominator === "outputCount"
    ? metricTotal(summary, ["attributedOutputCount", "unmatchedOutputCount"])
    : summary.metrics[definition.denominator] || 0;
  return { numerator, denominator, rate: denominator > 0 ? numerator / denominator : null };
}

function normalizedRates(before, after) {
  return GATE_RATE_DEFINITIONS.map((definition) => {
    const beforeValue = rateValue(before, definition);
    const afterValue = rateValue(after, definition);
    return {
      category: definition.category,
      regressionDirection: definition.direction,
      denominator: definition.denominator,
      before: beforeValue,
      after: afterValue,
      observedRateDelta: beforeValue.rate === null || afterValue.rate === null ? null : afterValue.rate - beforeValue.rate,
    };
  });
}

function gateFor(rates, compatibility, requested) {
  if (!compatibility.compatible) {
    if (!requested && !compatibility.required) return { requested: false, verdict: "informational", reasons: [] };
    return { requested, verdict: "incompatible", reasons: compatibility.reasons };
  }
  if (!requested) return { requested: false, verdict: "informational", reasons: [] };
  const reasons = rates.filter((item) => item.observedRateDelta !== null && (
    item.regressionDirection === "increase" ? item.observedRateDelta > 0 : item.observedRateDelta < 0
  )).map((item) => ({
    code: `${item.category}-regression`,
    category: item.category,
    regressionDirection: item.regressionDirection,
    beforeRate: item.before.rate,
    afterRate: item.after.rate,
    observedRateDelta: item.observedRateDelta,
    beforeNumerator: item.before.numerator,
    beforeDenominator: item.before.denominator,
    afterNumerator: item.after.numerator,
    afterDenominator: item.after.denominator,
  }));
  return { requested: true, verdict: reasons.length ? "fail" : "pass", reasons };
}

export function compareMeasurements(before, after, options = {}) {
  const normalizedOptions = typeof options === "number" ? { findingLimit: options } : options;
  const findingLimit = normalizedOptions.findingLimit ?? DEFAULT_FINDING_LIMIT;
  const gateRequested = Boolean(normalizedOptions.gate);
  const requireCompatible = normalizedOptions.requireCompatible !== false;
  const compatibility = compatibilityFor(before, after, requireCompatible);
  const metrics = METRIC_KEYS.map((key) => ({
    metric: key,
    before: before.metrics[key] || 0,
    after: after.metrics[key] || 0,
    observedDelta: (after.metrics[key] || 0) - (before.metrics[key] || 0),
  }));
  const detectorIds = [...new Set([...Object.keys(before.detectors), ...Object.keys(after.detectors)])].sort();
  const detectorDeltas = detectorIds.map((ruleId) => ({
    ruleId,
    beforeOccurrences: before.detectors[ruleId]?.occurrences || 0,
    afterOccurrences: after.detectors[ruleId]?.occurrences || 0,
    observedOccurrenceDelta: (after.detectors[ruleId]?.occurrences || 0) - (before.detectors[ruleId]?.occurrences || 0),
    beforeQuantity: before.detectors[ruleId]?.quantity || 0,
    afterQuantity: after.detectors[ruleId]?.quantity || 0,
    observedQuantityDelta: (after.detectors[ruleId]?.quantity || 0) - (before.detectors[ruleId]?.quantity || 0),
  })).sort((a, b) => Math.abs(b.observedQuantityDelta) - Math.abs(a.observedQuantityDelta) || a.ruleId.localeCompare(b.ruleId));
  const rates = normalizedRates(before, after);
  return {
    comparisonSchemaVersion: COMPARISON_SCHEMA_VERSION,
    interpretation: "Observed deltas only. This comparison does not estimate causal savings.",
    before: { schemaVersion: before.schemaVersion, detectorVersion: before.detectorVersion, since: before.since, until: before.until, sessionCount: before.sessionCount },
    after: { schemaVersion: after.schemaVersion, detectorVersion: after.detectorVersion, since: after.since, until: after.until, sessionCount: after.sessionCount },
    compatibility,
    metrics,
    normalizedRates: rates,
    detectorDeltas: detectorDeltas.slice(0, Math.max(0, findingLimit)),
    detectorDeltasTruncated: detectorDeltas.length > findingLimit,
    findingLimit,
    gate: gateFor(rates, compatibility, gateRequested),
  };
}

export function comparisonExitCode(report) {
  if (report.gate.verdict === "incompatible") return 2;
  if (!report.compatibility.compatible && report.compatibility.required) return 2;
  if (report.gate.requested && report.gate.verdict !== "pass") return 1;
  return 0;
}

function parseArgs(argv) {
  const result = { findingLimit: DEFAULT_FINDING_LIMIT, gate: false, requireCompatible: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--before") result.before = argv[++index];
    else if (arg === "--after") result.after = argv[++index];
    else if (arg === "--output") result.output = argv[++index];
    else if (arg === "--findings") result.findingLimit = Number(argv[++index]);
    else if (arg === "--gate") result.gate = true;
    else if (arg === "--allow-incompatible") result.requireCompatible = false;
    else if (arg === "--help" || arg === "-h") result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function usage() {
  return "Usage: yarn agent:compare-context --before <analysis-dir> --after <analysis-dir> --output <report.json> [--findings <n>] [--gate] [--allow-incompatible]";
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
      process.exit(0);
    }
    if (!options.before || !options.after || !options.output || !Number.isInteger(options.findingLimit) || options.findingLimit < 0 || options.findingLimit > 100) {
      throw new Error("Valid --before, --after, --output, and --findings (0-100) values are required");
    }
    const report = compareMeasurements(
      summarizeMeasurementDirectory(options.before),
      summarizeMeasurementDirectory(options.after),
      { findingLimit: options.findingLimit, gate: options.gate, requireCompatible: options.requireCompatible },
    );
    const output = path.resolve(options.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, stableJson(report));
    console.log(`Wrote bounded comparison (${report.detectorDeltas.length} detector deltas; gate=${report.gate.verdict}) to ${output}`);
    process.exitCode = comparisonExitCode(report);
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(1);
  }
}
