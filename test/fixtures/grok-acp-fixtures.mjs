// Neutral ACP fixtures; never copy private session payloads into this file.
export const grokAcpCliFixture = [
  { params: { sessionId: 'fixture', update: { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'read_file', rawInput: { path: '/neutral/example.md' } } } },
  { params: { sessionId: 'fixture', update: { sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed', content: [{ text: 'DO_NOT_EMIT_PRIVATE_BODY' }] } } },
];
