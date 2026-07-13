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
