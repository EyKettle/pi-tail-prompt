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
 *    insert {role, content} immediately BEFORE the latest user message.
 *  - OpenAI Responses (payload.input array when messages is absent): same
 *    latest-user-before rule as Chat.
 *  - Anthropic Messages API: insert {role:"system", content} immediately AFTER
 *    the latest user turn (Anthropic requires a mid-conversation message to
 *    follow a user turn, not lead the array). This branch exists for a model
 *    that accepts mid-conversation system messages, so the inserted role is
 *    fixed to `system`; the configured role applies only to the messages-array
 *    (Chat/Responses) shape.
 *
 * Every adapter constructs and returns new arrays; nothing is mutated in place.
 * The Anthropic branch is selected when either signal says Anthropic: the
 * model's declared protocol (`api`), or the payload's top-level `system` field
 * (which OpenAI Chat and Responses never carry). The payload signal catches a
 * request routed away from the session model's protocol; the declared protocol
 * catches an Anthropic request whose leading system text is empty.
 */

/** Index of the latest user-role message, or -1 when none exists. Guarded against null elements. */
function findLatestUserIndex(messages: Array<Record<string, unknown>>): number {
	return messages.findLastIndex((m) => m?.role === "user");
}

/**
 * Return a new array with the tail prompt inserted immediately before the
 * latest user message, or null when there is no user message (the caller then
 * leaves the payload untouched).
 */
export function injectTailPrompt(
	messages: Array<Record<string, unknown>>,
	content: string,
	role: "system" | "user",
): Array<Record<string, unknown>> | null {
	const index = findLatestUserIndex(messages);
	if (index === -1) return null;
	return [
		...messages.slice(0, index),
		{ role, content },
		...messages.slice(index),
	];
}

/**
 * Whether the request targets the Anthropic Messages API. Either signal is
 * enough: the declared protocol, or the top-level `system` marker (which OpenAI
 * Chat and Responses never carry). The payload marker catches a request routed
 * away from the session model's protocol; the declared protocol catches an
 * Anthropic request whose leading system text is empty.
 */
export function isAnthropicPayload(
	payload: Record<string, unknown>,
	api?: string,
): boolean {
	if (api === "anthropic-messages") return true;
	return payload.system !== undefined && Array.isArray(payload.messages);
}

/**
 * Return a new array with a system message inserted immediately after the latest
 * user turn, or null when there is no user message. No idempotence guard: the
 * payload is rebuilt per request and this adapter runs once per fresh payload,
 * so a guard would only suppress injection when another producer legitimately
 * placed a message after the latest user turn.
 */
export function injectAnthropicTail(
	messages: Array<Record<string, unknown>>,
	content: string,
): Array<Record<string, unknown>> | null {
	const index = findLatestUserIndex(messages);
	if (index === -1) return null;
	return [
		...messages.slice(0, index + 1),
		{ role: "system", content },
		...messages.slice(index + 1),
	];
}

/**
 * Route a provider payload through the correct tail-injection adapter.
 *
 * Pure and hook-independent so the full routing is unit-testable without a
 * live event emitter. Returns a new payload, or undefined when nothing should
 * be sent back as a replacement (the handler then leaves the payload untouched).
 */
export function applyTailToPayload(
	payload: Record<string, unknown>,
	content: string,
	role: "system" | "user",
	api?: string,
): Record<string, unknown> | undefined {
	const messages = payload.messages;
	if (Array.isArray(messages)) {
		const arr = messages as Array<Record<string, unknown>>;
		const next = isAnthropicPayload(payload, api)
			? injectAnthropicTail(arr, content)
			: injectTailPrompt(arr, content, role);
		if (!next) return undefined;
		return { ...payload, messages: next };
	}
	const input = payload.input;
	if (Array.isArray(input)) {
		const next = injectTailPrompt(
			input as Array<Record<string, unknown>>,
			content,
			role,
		);
		if (!next) return undefined;
		return { ...payload, input: next };
	}
	return undefined;
}
