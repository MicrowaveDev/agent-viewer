(function installGrokFormat(root) {
  function text(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map(text).filter(Boolean).join('\n');
    if (content?.type === 'text' || content?.type === 'summary_text') return content.text || '';
    if (content?.type === 'content') return text(content.content);
    if (content) return JSON.stringify(content);
    return '';
  }
  function prompt(evt) {
    const update = evt.params?.update;
    if (update?.sessionUpdate === 'user_message_chunk') return text(update.content);
    if (evt.type === 'user' && !evt.synthetic_reason && !evt.message) return text(evt.content);
    return '';
  }
  root.AgentViewerGrok = { text, prompt };
})(globalThis);
