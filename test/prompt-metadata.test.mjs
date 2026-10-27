import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePromptPreview,
  userPromptFromEvent,
} from "../prompt-metadata.js";

function userResponse(text) {
  return {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
    },
  };
}

test("selects the actual initial request after injected plugin context", () => {
  const events = [
    userResponse(
      "<recommended_plugins>Here is a list of plugins...</recommended_plugins>\n" +
        "# AGENTS.md instructions for /workspace",
    ),
    userResponse(
      "Run the production Threads post suggestions queue for this week.",
    ),
  ];

  const preview = events
    .map(userPromptFromEvent)
    .map(normalizePromptPreview)
    .find(Boolean);

  assert.equal(
    preview,
    "Run the production Threads post suggestions queue for this week.",
  );
});

test("keeps ordinary user messages that contain markup", () => {
  const prompt = userPromptFromEvent(
    userResponse("Please fix the <button>Save</button> caption."),
  );

  assert.equal(prompt, "Please fix the <button>Save</button> caption.");
});

test("keeps Grok ACP and history captions after extracting the shared parser", () => {
  const acp = {params: {update: {sessionUpdate: "user_message_chunk",
    content: {type: "text", text: "Inspect the generation set."}}}};
  assert.equal(userPromptFromEvent(acp), "Inspect the generation set.");
  assert.equal(userPromptFromEvent({type: "user", content: [{type: "text", text: "Review saved presets."}]}), "Review saved presets.");
  assert.equal(userPromptFromEvent({type: "user", synthetic_reason: "system", content: "Injected metadata"}), "");
});
