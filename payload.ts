/**
 * Provider payload adapters — tail-prompt injection for the three supported
 * payload shapes, all anchored to the latest user turn so the reminder stays
 * in the tail-attention window.
 *
 * Placement anchor: the payload's last message is NOT always a user message —
 * after tool execution the array ends with role:"tool" messages that must stay
 * adjacent to the assistant tool_calls message they answer. Inserting at the
 * raw end would break that adjacency (provider 400: "insufficient tool messages
 * following tool_calls message"), so the insert point is the latest user message.
 *
 *  - OpenAI-compatible Chat (payload.messages array, no top-level `system`):
 *    inject {role, content} immediately BEFORE the latest user message.
 *  - OpenAI Responses (payload.input array when messages is absent): same
 *    latest-user-before-insert rule as Chat.
 *  - Anthropic Messages API (top-level `system` + `max_tokens`): inject a
 *    {role:"system"} mid-conversation message immediately AFTER the latest user
 *    turn (Anthropic requires system to follow a user turn, not lead the
 *    array). Claude Sonnet 5 lacks mid-conversation support, so it is skipped.
 * Other provider shapes are skipped untouched.
 */

/**
 * Index of the latest user-role message, or -1 when none exists. Guarded
 * against null/undefined array elements.
 */
function findLatestUserIndex(messages: Array<Record<string, unknown>>): number {
	return messages.findLastIndex((m) => m?.role === "user");
}

/**
 * Insert the tail prompt immediately before the latest user message.
 *
 * Mutates the given payload messages array in place (matching the hook's
 * handling). Returns the array, or null when no user message exists — the
 * caller then leaves the payload untouched. No idempotence guard: a leading
 * system message (the standard OpenAI layout) is legitimate and must not be
 * mistaken for an already-injected reminder; the hook runs once per fresh
 * payload, so double-injection cannot self-occur.
 */
export function injectTailPrompt(
	messages: Array<Record<string, unknown>>,
	content: string,
	role: "system" | "user",
): Array<Record<string, unknown>> | null {
	const lastUserIndex = findLatestUserIndex(messages);
	if (lastUserIndex === -1) return null;
	messages.splice(lastUserIndex, 0, { role, content });
	return messages;
}

/**
 * Detect an Anthropic Messages API payload: it carries a top-level `system`
 * field (OpenAI Chat never does) alongside `max_tokens` and a `messages` array.
 */
export function isAnthropicPayload(payload: Record<string, unknown>): boolean {
	return (
		payload.max_tokens !== undefined &&
		payload.system !== undefined &&
		Array.isArray(payload.messages)
	);
}

/**
 * Claude Sonnet 5 does not support mid-conversation system messages; the
 * extension skips injection for it. Matches ids like "claude-sonnet-5" or
 * "claude-sonnet-5-20260101", never "claude-sonnet-4-5".
 */
export function isSonnet5(model: string): boolean {
	return /sonnet-?5(?:$|[^0-9])/i.test(model);
}

/**
 * Insert the tail prompt as a mid-conversation system message immediately
 * AFTER the latest user turn — Anthropic's placement rule requires a system
 * message to follow a user turn (including one carrying tool_result blocks)
 * and precede an assistant turn or end the array. A system message cannot be
 * the first entry in `messages`; inserting after the first user message yields
 * [user, system], which is allowed. Returns the array, or null when no user
 * message exists.
 */
export function injectAnthropicTail(
	messages: Array<Record<string, unknown>>,
	content: string,
): Array<Record<string, unknown>> | null {
	const lastUserIndex = findLatestUserIndex(messages);
	if (lastUserIndex === -1) return null;
	if (messages[lastUserIndex + 1]?.role === "system") return null; // idempotence
	messages.splice(lastUserIndex + 1, 0, { role: "system", content });
	return messages;
}

/**
 * Route a provider payload through the correct tail-injection adapter.
 *
 * Pure and hook-independent so the full routing (Anthropic dispatch, Sonnet 5
 * skip, Chat messages, Responses input) is unit-testable without a live event
 * emitter. Returns the (mutated) payload, or undefined when nothing should be
 * sent back as a replacement (the handler then leaves the payload untouched).
 */
export function applyTailToPayload(
	payload: Record<string, unknown>,
	content: string,
	role: "system" | "user",
): Record<string, unknown> | undefined {
	const messages = payload.messages;
	if (Array.isArray(messages)) {
		const arr = messages as Array<Record<string, unknown>>;
		if (isAnthropicPayload(payload)) {
			// Claude Sonnet 5 does not support mid-conversation system messages; skip.
			if (isSonnet5(String(payload.model ?? ""))) return undefined;
			if (!injectAnthropicTail(arr, content)) return undefined;
		} else if (!injectTailPrompt(arr, content, role)) return undefined;
		return payload;
	}
	const input = payload.input;
	if (Array.isArray(input)) {
		const arr = input as Array<Record<string, unknown>>;
		if (!injectTailPrompt(arr, content, role)) return undefined;
		return payload;
	}
	return undefined;
}
