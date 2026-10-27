// Neutral ACP fixtures; never copy private session payloads into this file.
export const grokAcpCliFixture = [
  { params: { sessionId: 'fixture', update: { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'read_file', rawInput: { path: '/neutral/example.md' } } } },
  { params: { sessionId: 'fixture', update: { sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed', content: [{ text: 'DO_NOT_EMIT_PRIVATE_BODY' }] } } },
];

// Shape regression from Oct 27: completed means the Bash transport succeeded,
// even when the CLI returned exit 1. The bytes mirror the prompt representation.
export const grokCompletedBashFailure = {
  sessionUpdate: 'tool_call_update', toolCallId: 'bash-failure', status: 'completed',
  rawOutput: { type: 'Bash', exit_code: 1, output_for_prompt: 'exit: 1\nneutral CLI failure', output: [...Buffer.from('neutral CLI failure')], timed_out: false, signal: null },
};
