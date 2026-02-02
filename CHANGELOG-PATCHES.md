# Local Patches – Pending PRs

Patches applied in this fork for upstream submission. Use npm `openclaw` as single source of truth; contribute via PR.

---

## UI: Unwrap action JSON in Control UI chat

**File:** `ui/src/ui/chat/message-extract.ts`

**Issue:** When models output action-style JSON (e.g. `{"name": "message_create", "arguments": {"text": "Hello!"}}`), the Control UI displayed the raw JSON instead of the message text.

**Change:** Add `unwrapActionJson()` to detect JSON with `name` and `arguments` and return `arguments.text` for assistant messages, so the chat shows plain text instead of raw JSON.

**Tests:** `ui/src/ui/chat/message-extract.test.ts` – `unwraps action JSON for assistant messages`, `passes through action JSON with no text`.

---

## Hooks: Use primary model for LLM slug generator

**File:** `src/hooks/llm-slug-generator.ts`

**Issue:** The `llm-slug-generator` hook used hardcoded Anthropic/Claude, causing `No API key found for provider "anthropic"` in Ollama-only setups.

**Change:** Derive `provider` and `model` from `agents.defaults.model.primary` (e.g. `ollama/qwen2.5-coder:7b`), falling back to defaults only when unset.

**Result:** Ollama-only installs can generate LLM slugs for session memory filenames instead of falling back to timestamp slugs.

---

## TUI: Unwrap action JSON and tool_use for assistant output

**File:** `src/tui/tui-formatters.ts`

**Issue:** When models output action-style JSON or `tool_use` blocks (e.g. `message_create` with `arguments.text`), the TUI showed "(no output)" because it only extracted plain text blocks.

**Change:** Add `unwrapActionJson()` for text blocks and `textFromToolBlock()` to extract `arguments.text` from `tool_use` blocks for message_create/message/agent_send, so the TUI displays the message instead of "(no output)".

**Tests:** `src/tui/tui-formatters.test.ts` – `unwraps action JSON in text blocks`, `extracts text from message_create tool_use blocks`.
