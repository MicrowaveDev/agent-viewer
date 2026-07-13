(function installExportCleaner(root) {
  function utf8Bytes(value) {
    const text = String(value || "");
    if (typeof Buffer !== "undefined") return Buffer.byteLength(text, "utf8");
    return new TextEncoder().encode(text).byteLength;
  }

  function removeEncryptedContent(value, seen = new Set()) {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (!Array.isArray(value)) delete value.encrypted_content;
    for (const child of Object.values(value)) removeEncryptedContent(child, seen);
  }

  function keepCorrelationMetadata(value) {
    if (!value || typeof value !== "object") return undefined;
    const correlationKeys = new Set(["call_id", "session_id", "thread_id", "parent_thread_id", "turn_id", "task_id"]);
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (correlationKeys.has(key) && child !== undefined && child !== null) result[key] = child;
      else if (child && typeof child === "object") {
        const nested = keepCorrelationMetadata(child);
        if (nested && Object.keys(nested).length) result[key] = nested;
      }
    }
    return result;
  }

  function redactGeneratedImagePayload(payload) {
    if (!payload || !String(payload.type || "").startsWith("image_generation_")) return;
    if (typeof payload.result === "string" && payload.result.length > 0) {
      payload.result_bytes = utf8Bytes(payload.result);
      payload.result = "[redacted generated image base64]";
    }
  }

  function cleanForCopy(content) {
    if (!content) return "";
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          const evt = JSON.parse(line);
          const payload = evt.payload;
          if (!payload) return JSON.stringify(evt);

          if (["token_count", "agent_message", "agent_reasoning"].includes(payload.type)) return null;
          redactGeneratedImagePayload(payload);
          removeEncryptedContent(payload);

          if (evt.type === "session_meta") {
            evt.payload = {
              id: payload.id,
              originator: payload.originator,
              cli_version: payload.cli_version,
              model_provider: payload.model_provider,
              cwd: payload.cwd,
              thread_source: payload.thread_source,
              parent_thread_id: payload.parent_thread_id,
              source: keepCorrelationMetadata(payload.source),
              git: payload.git ? { branch: payload.git.branch } : undefined,
            };
            return JSON.stringify(evt);
          }

          if (evt.type === "turn_context") {
            evt.payload = {
              model: payload.model,
              effort: payload.effort,
              session_id: payload.session_id,
              thread_id: payload.thread_id,
              parent_thread_id: payload.parent_thread_id,
              turn_id: payload.turn_id,
              task_id: payload.task_id,
            };
            return JSON.stringify(evt);
          }

          if (payload.type === "task_started") {
            delete payload.model_context_window;
            delete payload.collaboration_mode_kind;
          }

          return JSON.stringify(evt);
        } catch {
          return line;
        }
      })
      .filter(Boolean)
      .join("\n");
  }

  root.AgentViewerExportCleaner = { cleanForCopy, redactGeneratedImagePayload };
})(globalThis);
