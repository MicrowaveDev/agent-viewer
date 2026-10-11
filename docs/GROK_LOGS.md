# Grok CLI logs

Start the viewer with `yarn start`, or `GROK_HOME=/custom/grok yarn start` for a custom Grok home. The default store is `~/.grok/sessions`. `PORT` can override the default viewer port 60653.

The viewer discovers session directories recursively. It prefers `updates.jsonl` (the ACP conversation/tool event stream) and falls back to `chat_history.jsonl` if the stream is absent. Each session appears once with a **Gr** badge. The first user prompt supplies the caption; `summary.json` supplies the fallback title. Malformed or missing summary files do not prevent discovery.

Select a Grok session and use the existing **Copy all** or temporary-file copy controls. Exports preserve the selected file's JSONL schema, including session/tool IDs, tool input/output, usage and unknown event types. Encrypted reasoning fields are removed. The export is the selected conversation log, not an archive of every supporting file in the session folder.

Prompts, responses, reasoning, tool calls and results are rendered in the viewer. Other events remain accessible as JSON. Large sessions use the existing chunked loading path. New sessions, appended output, truncation and switching from raw history to an available ACP stream are detected live. Refresh rescans the configured store.

Storage reference: [Grok Build session management](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/17-sessions.md).
