#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMPARISON_SCHEMA_VERSION = 1;
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
  "taskCount",
  "completedTaskCount",
  "finalLinkedTaskCount",
  "attributedOutputCount",
  "unmatchedOutputCount",
  "lowConfidenceOutputCount",
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

export function compareMeasurements(before, after, findingLimit = DEFAULT_FINDING_LIMIT) {
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
  return {
    comparisonSchemaVersion: COMPARISON_SCHEMA_VERSION,
    interpretation: "Observed deltas only. This comparison does not estimate causal savings.",
    before: { schemaVersion: before.schemaVersion, detectorVersion: before.detectorVersion, since: before.since, until: before.until, sessionCount: before.sessionCount },
    after: { schemaVersion: after.schemaVersion, detectorVersion: after.detectorVersion, since: after.since, until: after.until, sessionCount: after.sessionCount },
    metrics,
    detectorDeltas: detectorDeltas.slice(0, Math.max(0, findingLimit)),
    detectorDeltasTruncated: detectorDeltas.length > findingLimit,
    findingLimit,
  };
}

function parseArgs(argv) {
  const result = { findingLimit: DEFAULT_FINDING_LIMIT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--before") result.before = argv[++index];
    else if (arg === "--after") result.after = argv[++index];
    else if (arg === "--output") result.output = argv[++index];
    else if (arg === "--findings") result.findingLimit = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function usage() {
  return "Usage: yarn agent:compare-context --before <analysis-dir> --after <analysis-dir> --output <report.json> [--findings <n>]";
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
      options.findingLimit,
    );
    const output = path.resolve(options.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, stableJson(report));
    console.log(`Wrote bounded comparison (${report.detectorDeltas.length} detector deltas) to ${output}`);
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(1);
  }
}
