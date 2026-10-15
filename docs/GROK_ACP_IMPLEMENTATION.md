# Grok ACP analysis implementation journal

Tracking: [issue #9](https://github.com/MicrowaveDev/agent-viewer/issues/9).

## Contents

- [Scope](#scope)
- [Implementation](#implementation)
- [Verification](#verification)
- [Limitations](#limitations)

## Scope

Implements stream E of the operator CLI efficiency plan. The source request is
measuring Grok context usage and recent CLI workflow waste using maintained
analysis, without committing private session data. Implementation branch starts
from the existing `codex/grok-log-export` HEAD because its viewer/export support
preserves the ACP fields needed here. That unmerged work is a PR dependency;
this change does not assert it has reached main.

## Implementation

- Added an ACP streaming collector and automatic detection in analyze-log.
- Session/call correlation handles declared and update-only calls, latest status,
  repeated event IDs and mirror snapshots. Only measurements persist in memory.
- Text projection supports display content, editor diffs, FileContent mirrors,
  structured task/list results and UTF-8 stdout/stderr arrays; unsupported shapes
  remain explicitly unmeasured.
- Bounded output/input tool rankings, target rankings and largest-call evidence
  contain no payload bodies. Token usage remains separate from byte proxies.
- Per-turn aggregate usage/cache counts exclude nested model totals and metadata
  context gauges. Missing usage is reported. Completed compactions and explicit
  balance/context errors are classified separately.

## Verification

- `node --test test/*.test.mjs`: 26 tests pass, including prior Grok viewer,
  Codex corpus/measurement/compare and new ACP/CLI fixtures.
- `node --check server.js`: passes; no server changes in this stream.
- Maintained analyzer on the frozen 7,027-record cleaned export: 1,721 unique
  calls; 157 completed turns, 147 with usage; 1,487 recorded model calls;
  185,373,756 input tokens, 170,966,912 cached read tokens; 7 completed
  compactions; explicit usage-balance exhaustion. These totals match the audit.
- Selected text output projection totals 3,676,289 bytes. Its leading tool
  contributors are read_file (1,564,881), terminal (966,575), grep (708,942),
  editor (207,133) and background-result reads (204,552). This projection differs
  from earlier ad hoc representation choices and does not imply billing savings.
  63 metadata-only/unsupported output calls are disclosed.
- No private source log or raw payload is committed. Full local report, if
  retained, is `/tmp/grok-acp-maintained-report.json`.

## Limitations

Real Grok adoption of improved CLI still needs a subsequent observed session.
The adapter supplies reusable measurements, not a claim that all ranked calls
were wasteful. The multi-log corpus scanner is unchanged. Mixed exports report
non-ACP records separately; use separate source exports for full coverage.
