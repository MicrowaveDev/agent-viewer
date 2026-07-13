export function normalizePromptPreview(text) {
  return String(text || "")
    .replace(/<ide_[^>]+>[\s\S]*?<\/ide_[^>]+>/g, " ")
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>/gi, " [image] ")
    .replace(/<image\s*\/>/gi, " [image] ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstTextFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" || block?.type === "input_text")
    .map((block) => block.text)
    .filter(Boolean)
    .join(" ");
}

function isInjectedUserContext(text) {
  const trimmed = String(text || "").trimStart();
  return [
    "# AGENTS.md instructions",
    "<environment_context>",
    "<recommended_plugins>",
  ].some((prefix) => trimmed.startsWith(prefix));
}

export function userPromptFromEvent(evt) {
  const payload = evt.payload;

  if (evt.type === "event_msg" && payload?.type === "user_message") {
    return payload.message || payload.text_elements?.join(" ");
  }

  if (
    evt.type === "response_item" &&
    payload?.type === "message" &&
    payload.role === "user"
  ) {
    const text = firstTextFromContent(payload.content);
    return isInjectedUserContext(text) ? "" : text;
  }

  if (evt.type === "user") {
    return firstTextFromContent(evt.message?.content);
  }

  return "";
}

export function imageRefsFromEvent(evt) {
  const payload = evt.payload;
  const refs = [];

  if (evt.type === "event_msg" && payload?.type === "user_message") {
    refs.push(...(payload.images || []));
    refs.push(...(payload.local_images || []));
  }

  if (
    evt.type === "response_item" &&
    payload?.type === "message" &&
    payload.role === "user" &&
    Array.isArray(payload.content)
  ) {
    for (const block of payload.content) {
      if (block?.type === "input_image" && block.image_url) refs.push(block.image_url);
      if (block?.type === "local_image" && block.path) refs.push(block.path);
    }
  }

  return refs.filter(Boolean);
}
