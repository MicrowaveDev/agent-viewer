/**
 * Event renderers for Claude Code and Codex CLI JSONL formats.
 *
 * Exports: initMarkdown(), renderEvent(), renderCodexEvent(), resetCodexState()
 * Depends on globals: marked, markedHighlight, hljs (loaded via CDN in index.html)
 */

// --- Shared state ---
let blockIdCounter = 0;
let md; // Marked instance (initialized in initMarkdown)

// Codex turn_context deduplication
let lastTurnModel = "";
let lastTurnEffort = "";

// --- Initialization ---

function initMarkdown() {
  const { Marked } = globalThis.marked;
  const { markedHighlight } = globalThis.markedHighlight;
  md = new Marked(
    markedHighlight({
      emptyLangClass: "hljs",
      langPrefix: "hljs language-",
      highlight(code, lang) {
        if (!lang && isDiff(code)) lang = "diff";
        if (lang === "diff") return highlightDiff(code);
        const language = hljs.getLanguage(lang) ? lang : "plaintext";
        return hljs.highlight(code, { language }).value;
      },
    }),
  );
}

function resetBlockCounter() {
  blockIdCounter = 0;
}

function resetCodexState() {
  lastTurnModel = "";
  lastTurnEffort = "";
}

// --- Helpers ---

function isDiff(code) {
  if (typeof code !== "string") return false;
  const lines = code.split("\n").slice(0, 10);
  return lines.some((l) => /^(diff --git|@@\s|---\s|(\+\+\+)\s)/.test(l));
}

function highlightDiff(code) {
  return code
    .split("\n")
    .map((line) => {
      const esc = escapeHtml(line);
      if (line.startsWith("+")) return `<span class="diff-add">${esc}</span>`;
      if (line.startsWith("-")) return `<span class="diff-del">${esc}</span>`;
      if (line.startsWith("@@")) return `<span class="diff-hunk">${esc}</span>`;
      if (line.startsWith("diff "))
        return `<span class="diff-header">${esc}</span>`;
      return esc;
    })
    .join("\n");
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(str, max) {
  str = String(str || "");
  if (!str || str.length <= max) return str || "";
  return str.slice(0, max) + "...";
}

function stringifyToolContent(value) {
  if (typeof value === "string") return value;
  if (!value) return "";
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item?.type === "input_image") {
          const imageUrl = item.image_url || "";
          const label = imageUrl.startsWith("data:")
            ? imageUrl.slice(0, 32) + "..."
            : imageUrl;
          return `[input_image ${label}]`;
        }
        if (item?.type === "text" || item?.type === "input_text") {
          return item.text || "";
        }
        return JSON.stringify(item, (key, val) => {
          if (key === "image_url" && typeof val === "string") {
            return val.startsWith("data:") ? val.slice(0, 32) + "..." : val;
          }
          return val;
        });
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(value, (key, val) => {
    if (key === "image_url" && typeof val === "string") {
      return val.startsWith("data:") ? val.slice(0, 32) + "..." : val;
    }
    return val;
  }, 2);
}

function renderMarkdown(text) {
  try {
    return md.parse(text);
  } catch {
    return escapeHtml(text);
  }
}

function formatTimestamp(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// --- Shared building blocks ---

function renderTextBlock(text) {
  if (!text) return "";
  if (isDiff(text) && !text.includes("```")) {
    text = "```diff\n" + text + "\n```";
  }
  return `<div class="md-content">${renderMarkdown(text)}</div>`;
}

function renderSpoiler(label, lineCount, content, cssClass) {
  const bid = "sp-" + blockIdCounter++;
  return `<div class="json-spoiler">
    <div class="json-spoiler-header" onclick="toggleBlock('${bid}')">
      <span class="chevron" id="chev-${bid}">&#9654;</span>
      <span class="json-spoiler-label">${escapeHtml(label)}</span>
      <span class="json-spoiler-lines">${lineCount} lines</span>
    </div>
    <div class="json-spoiler-body ${cssClass || ""}" id="${bid}">${content}</div>
  </div>`;
}

function renderJsonSpoiler(evt) {
  const jsonStr = JSON.stringify(evt, null, 2);
  return renderSpoiler("JSON", jsonStr.split("\n").length, escapeHtml(jsonStr));
}

function renderToolBlock(name, desc, bodyContent) {
  const bid = "tu-" + blockIdCounter++;
  return `<div class="tool-block">
    <div class="tool-header" onclick="toggleBlock('${bid}')">
      <span class="chevron" id="chev-${bid}">&#9654;</span>
      <span class="tool-name">${escapeHtml(name)}</span>
      <span class="tool-desc">${escapeHtml(truncate(desc, 80))}</span>
    </div>
    <div class="tool-body" id="${bid}">${bodyContent}</div>
  </div>`;
}

function renderToolResult(preview, fullContent, isErr) {
  const bid = "tr-" + blockIdCounter++;
  const normalizedContent = stringifyToolContent(fullContent);
  const displayContent = isDiff(normalizedContent)
    ? `<pre><code>${highlightDiff(normalizedContent)}</code></pre>`
    : escapeHtml(normalizedContent);
  return `<div class="tool-result">
    <div class="tool-result-header" onclick="toggleBlock('${bid}')">
      <span class="chevron" id="chev-${bid}">&#9654;</span>
      <span class="${isErr ? "result-err" : "result-ok"}">${isErr ? "ERROR" : "OK"}</span>
      <span style="color:var(--text-muted);font-size:11px">${escapeHtml(preview) || "(empty)"}</span>
    </div>
    <div class="tool-result-body" id="${bid}">${displayContent}</div>
  </div>`;
}

// ============================================================
// Claude Code renderer
// ============================================================

function renderUserContent(msg) {
  const content = msg.content;
  if (typeof content === "string") return renderTextBlock(content);
  if (!Array.isArray(content)) return "";
  let html = "";
  for (const block of content) {
    if (block.type === "text") {
      html += renderTextBlock(block.text);
    } else if (block.type === "tool_result") {
      const fullContent =
        typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content, null, 2);
      html += renderToolResult(
        truncate(fullContent, 100),
        fullContent,
        block.is_error,
      );
    }
  }
  return html;
}

function renderAssistantContent(msg) {
  if (!msg.content || !Array.isArray(msg.content)) return "";
  let html = "";
  for (const block of msg.content) {
    if (block.type === "text") {
      html += renderTextBlock(block.text);
    } else if (block.type === "tool_use") {
      const desc =
        block.input?.description ||
        block.input?.command ||
        block.input?.pattern ||
        block.input?.file_path ||
        block.input?.query ||
        "";
      html += renderToolBlock(
        block.name || "Unknown",
        desc,
        escapeHtml(JSON.stringify(block.input || {}, null, 2)),
      );
    }
  }
  return html;
}

function renderEvent(evt) {
  const type = evt.type;
  const time = formatTimestamp(evt.timestamp);

  if (type === "user") {
    const msg = evt.message;
    if (!msg) return "";
    const hasOnlyToolResults =
      Array.isArray(msg.content) &&
      msg.content.every((b) => b.type === "tool_result");
    const eventClass = hasOnlyToolResults ? "event-tool" : "event-user";
    const badge = hasOnlyToolResults
      ? '<span class="badge badge-tool">Result</span>'
      : '<span class="badge badge-user">User</span>';
    return `<div class="event ${eventClass}">
      <div class="event-header">${badge}<span class="event-time">${time}</span></div>
      <div class="event-body">${renderUserContent(msg)}</div>
      ${renderJsonSpoiler(evt)}
    </div>`;
  }

  if (type === "assistant") {
    const msg = evt.message;
    if (!msg) return "";
    const model = msg.model || "";
    const shortModel = model
      .replace("claude-", "")
      .replace("-20251001", "")
      .replace("-20250514", "");
    const usage = msg.usage;
    const tokens = usage
      ? `in:${usage.input_tokens || 0} out:${usage.output_tokens || 0}`
      : "";
    const hasToolUse =
      Array.isArray(msg.content) &&
      msg.content.some((b) => b.type === "tool_use");
    return `<div class="event event-assistant">
      <div class="event-header">
        <span class="badge badge-assistant">Assistant</span>
        ${shortModel ? `<span class="badge badge-model">${escapeHtml(shortModel)}</span>` : ""}
        ${hasToolUse ? '<span class="badge badge-tool">Tool</span>' : ""}
        <span class="token-stats">${tokens}</span>
        <span class="event-time">${time}</span>
      </div>
      <div class="event-body">${renderAssistantContent(msg)}</div>
      ${renderJsonSpoiler(evt)}
    </div>`;
  }

  if (type === "progress") {
    const d = evt.data;
    if (!d) return "";
    let body = "";
    if (d.type === "bash_progress") {
      body = `<div class="progress-info">${escapeHtml(truncate(d.output, 200))} <span style="color:#666">${d.elapsedTimeSeconds}s | ${d.totalLines} lines</span></div>`;
    } else if (d.type === "hook_progress") {
      body = `<div class="progress-info">${escapeHtml(d.hookName || d.hookEvent)}</div>`;
    }
    if (!body) return "";
    return `<div class="event event-progress">
      <div class="event-header"><span class="badge badge-progress">Progress</span><span class="event-time">${time}</span></div>
      <div class="event-body">${body}</div>
      ${renderJsonSpoiler(evt)}
    </div>`;
  }

  return "";
}

// ============================================================
// Codex CLI renderer
// ============================================================

function renderCodexEvent(evt, file) {
  const type = evt.type;
  const p = evt.payload;
  const time = formatTimestamp(evt.timestamp);

  // --- session_meta ---
  if (type === "session_meta") {
    const fields = [
      ["Source", p.originator],
      ["Version", p.cli_version],
      ["Provider", p.model_provider],
      ["CWD", p.cwd],
      ["Branch", p.git?.branch],
      ["Started", p.timestamp ? new Date(p.timestamp).toLocaleString() : null],
    ];
    const rows = fields
      .filter(([, v]) => v)
      .map(
        ([k, v]) =>
          `<div><span class="session-field">${k}:</span> <span class="session-value">${escapeHtml(String(v))}</span></div>`,
      )
      .join("");
    return `<div class="event event-session">
      <div class="event-header"><span class="badge badge-session">Session</span><span class="event-time">${time}</span></div>
      <div class="event-body"><div class="session-header">${rows}</div></div>
    </div>`;
  }

  // --- response_item ---
  if (type === "response_item") {
    return renderCodexResponseItem(p, time);
  }

  // --- event_msg ---
  if (type === "event_msg") {
    return renderCodexEventMsg(p, time, file);
  }

  // --- turn_context (deduplicated) ---
  if (type === "turn_context") {
    const model = p.model || "";
    const effort = p.effort || "";
    if (model === lastTurnModel && effort === lastTurnEffort) return "";
    lastTurnModel = model;
    lastTurnEffort = effort;
    return `<div class="turn-divider">${escapeHtml(model)} | effort: ${escapeHtml(effort)}</div>`;
  }

  // --- compacted ---
  if (type === "compacted") {
    return `<div class="turn-divider">Context compacted</div>`;
  }

  return "";
}

function renderCodexResponseItem(p, time) {
  const subtype = p.type;

  // Skip user messages (contain system-injected AGENTS.md)
  if (subtype === "message" && p.role === "user") return "";

  // Developer message — collapsed spoiler
  if (subtype === "message" && p.role === "developer") {
    const texts = (p.content || [])
      .filter((b) => b.type === "input_text")
      .map((b) => b.text)
      .join("\n");
    if (!texts) return "";
    return renderSpoiler(
      "Developer prompt",
      texts.split("\n").length,
      escapeHtml(texts),
    );
  }

  // Assistant message
  if (subtype === "message" && p.role === "assistant") {
    const texts = (p.content || [])
      .filter((b) => b.type === "output_text")
      .map((b) => b.text);
    if (texts.length === 0) return "";
    const phaseBadge = p.phase
      ? `<span class="badge badge-phase">${escapeHtml(p.phase)}</span>`
      : "";
    return `<div class="event event-assistant">
      <div class="event-header">
        <span class="badge badge-assistant">Assistant</span>
        ${phaseBadge}
        <span class="event-time">${time}</span>
      </div>
      <div class="event-body">${texts.map(renderTextBlock).join("")}</div>
    </div>`;
  }

  // Function call (exec_command etc.)
  if (subtype === "function_call") {
    let args = p.arguments || "";
    let desc = "";
    try {
      const parsed = JSON.parse(args);
      desc = parsed.cmd || parsed.command || parsed.query || "";
      args = JSON.stringify(parsed, null, 2);
    } catch {
      desc = truncate(args, 80);
    }
    return `<div class="event event-assistant">
      <div class="event-header">
        <span class="badge badge-assistant">Assistant</span>
        <span class="badge badge-tool">Tool</span>
        <span class="event-time">${time}</span>
      </div>
      <div class="event-body">${renderToolBlock(p.name || "Unknown", desc, escapeHtml(args))}</div>
    </div>`;
  }

  // Function call output
  if (subtype === "function_call_output") {
    const output = stringifyToolContent(p.output);
    const isErr =
      output.includes("exit code") &&
      !output.includes("exit code 0") &&
      !output.includes("code 0\n");
    return `<div class="event event-tool">
      <div class="event-header"><span class="badge badge-tool">Result</span><span class="event-time">${time}</span></div>
      <div class="event-body">${renderToolResult(truncate(output, 120), output, isErr)}</div>
    </div>`;
  }

  // Custom tool call (apply_patch, MCP tools)
  if (subtype === "custom_tool_call") {
    const name = p.name || "custom_tool";
    const input = p.input || "";
    const desc = name === "apply_patch" ? "patch" : truncate(input, 60);
    const bodyContent = isDiff(input)
      ? `<pre><code>${highlightDiff(input)}</code></pre>`
      : escapeHtml(input);
    return `<div class="event event-assistant">
      <div class="event-header">
        <span class="badge badge-assistant">Assistant</span>
        <span class="badge badge-tool">Tool</span>
        <span class="event-time">${time}</span>
      </div>
      <div class="event-body">${renderToolBlock(name, desc, bodyContent)}</div>
    </div>`;
  }

  // Custom tool call output
  if (subtype === "custom_tool_call_output") {
    const raw = stringifyToolContent(p.output);
    let displayOutput = raw;
    let isErr = false;
    try {
      const parsed = JSON.parse(raw);
      displayOutput = parsed.output || raw;
      isErr =
        parsed.metadata?.exit_code !== 0 &&
        parsed.metadata?.exit_code !== undefined;
    } catch {
      // Not JSON
    }
    return `<div class="event event-tool">
      <div class="event-header"><span class="badge badge-tool">Result</span><span class="event-time">${time}</span></div>
      <div class="event-body">${renderToolResult(truncate(displayOutput, 120), displayOutput, isErr)}</div>
    </div>`;
  }

  // Reasoning
  if (subtype === "reasoning") {
    const summaryTexts = (p.summary || [])
      .filter((s) => s.type === "summary_text")
      .map((s) => s.text);
    if (summaryTexts.length === 0) return "";
    const preview = truncate(summaryTexts.join(" ").replace(/\*\*/g, ""), 80);
    const bid = "re-" + blockIdCounter++;
    return `<div class="event event-reasoning">
      <div class="event-header"><span class="badge badge-reasoning">Reasoning</span><span class="event-time">${time}</span></div>
      <div class="event-body">
        <div class="tool-block">
          <div class="tool-header" onclick="toggleBlock('${bid}')">
            <span class="chevron" id="chev-${bid}">&#9654;</span>
            <span style="color:var(--purple);font-weight:600">Summary</span>
            <span class="tool-desc">${escapeHtml(preview)}</span>
          </div>
          <div class="tool-body" id="${bid}">${summaryTexts.map(renderTextBlock).join("")}</div>
        </div>
      </div>
    </div>`;
  }

  // Web search
  if (subtype === "web_search_call") {
    const queries = p.action?.queries || [p.action?.query].filter(Boolean);
    if (queries.length === 0) return "";
    return `<div class="event event-assistant">
      <div class="event-header"><span class="badge badge-search">Search</span><span class="event-time">${time}</span></div>
      <div class="event-body"><div class="progress-info">${queries.map((q) => escapeHtml(q)).join("<br>")}</div></div>
    </div>`;
  }

  return "";
}

function renderImageRefs(refs, file) {
  if (!refs || refs.length === 0) return "";
  const previews = Array.isArray(file?.imagePreviews) ? file.imagePreviews : [];
  return `<div class="message-images">${refs
    .map((ref, index) => {
      const src = previews[index]?.endpoint || ref;
      return `<img class="message-image" src="${escapeHtml(src)}" alt="Prompt image ${index + 1}" loading="lazy">`;
    })
    .join("")}</div>`;
}

function renderCodexEventMsg(p, time, file) {
  const subtype = p.type;

  // User message (clean text)
  if (subtype === "user_message") {
    const text = p.message || "";
    if (!text || text.startsWith("<environment_context>")) return "";
    const imageRefs = [...(p.images || []), ...(p.local_images || [])];
    return `<div class="event event-user">
      <div class="event-header"><span class="badge badge-user">User</span><span class="event-time">${time}</span></div>
      <div class="event-body">${renderTextBlock(text)}${renderImageRefs(imageRefs, file)}</div>
    </div>`;
  }

  // Task started
  if (subtype === "task_started") {
    return `<div class="turn-divider">Turn ${escapeHtml(p.turn_id?.slice(0, 8) || "")} started</div>`;
  }

  // Task complete
  if (subtype === "task_complete") {
    const msg = p.last_agent_message || "";
    if (!msg) return `<div class="turn-divider">Turn complete</div>`;
    return `<div class="turn-divider">Turn complete</div>
      <div class="event event-assistant">
        <div class="event-header"><span class="badge badge-assistant">Final Answer</span><span class="event-time">${time}</span></div>
        <div class="event-body">${renderTextBlock(msg)}</div>
      </div>`;
  }

  // Turn aborted
  if (subtype === "turn_aborted") {
    return `<div class="turn-divider turn-abort">Turn aborted: ${escapeHtml(p.reason || "unknown")}</div>`;
  }

  // Context compacted
  if (subtype === "context_compacted") {
    return `<div class="turn-divider">Context compacted</div>`;
  }

  // Skip: agent_message, agent_reasoning, token_count (duplicates/noise)
  return "";
}
