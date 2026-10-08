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
 *  - Anthropic Messages API: the anchor follows the configured role — a
 *    `system` block lands immediately AFTER the latest user turn (Anthropic
 *    requires a mid-conversation system message to follow a user turn, not lead
 *    the array); a `user` block lands before the latest user message like every
 *    other shape. The inserted role is always the configured role.
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
	return payload.system !== undefined;
}

/**
 * Return a new array with the block inserted at the Anthropic Messages anchor,
 * or null when there is no user message. The anchor follows the configured
 * role: a `system` block follows the latest user turn, a `user` block leads the
 * latest user message. No idempotence guard: the payload is rebuilt per request
 * and this adapter runs once per fresh payload, so a guard would only suppress
 * injection when another producer legitimately placed a message at that anchor.
 */
export function injectAnthropicTail(
	messages: Array<Record<string, unknown>>,
	content: string,
	role: "system" | "user",
): Array<Record<string, unknown>> | null {
	const index = findLatestUserIndex(messages);
	if (index === -1) return null;
	const anchor = role === "system" ? index + 1 : index;
	return [
		...messages.slice(0, anchor),
		{ role, content },
		...messages.slice(anchor),
	];
}

/**
 * Route a provider payload through the correct tail-injection adapter.
 *
 * Pure and hook-independent so the full routing is unit-testable without a
 * live event emitter. Returns a new payload, or undefined when nothing should
 * be sent back as a replacement (the handler then leaves the payload untouched).
 *
 * The configured role decides the inserted message's role; the payload shape
 * decides the anchor (the tail placement table in docs_zh-CN/architecture.md):
 * `messages` and `input` lead the latest user message, and the Anthropic
 * Messages shape leads it for `user` and follows the latest user turn for
 * `system`.
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
			? injectAnthropicTail(arr, content, role)
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

/**
 * A system field's content after appending: a string, an array of content
 * blocks, or an object carrying a `parts` array.
 */
type SystemText =
	| string
	| Array<Record<string, unknown>>
	| Record<string, unknown>;

/**
 * Append text to whatever shape a system field uses: a plain string, an array
 * of content blocks, or an object with a `parts` array. Undefined when the
 * shape is not one of those.
 */
function appendSystemText(
	value: unknown,
	content: string,
): SystemText | undefined {
	if (typeof value === "string") return `${value}\n\n${content}`;
	if (Array.isArray(value)) {
		const blocks = value as Array<Record<string, unknown>>;
		return [...blocks, { type: "text", text: content }];
	}
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		if (Array.isArray(record.parts)) {
			return { ...record, parts: [...record.parts, { text: content }] };
		}
	}
	return undefined;
}

/**
 * Shape-independent fallback: merge the block into the payload's leading
 * system content, whatever field carries it. Probes `system`,
 * `systemInstruction`, `messages[0]`, then `input[0]`. Returns a new payload,
 * or undefined when no leading system field can be found.
 */
export function mergeBlockIntoLeadingSystem(
	payload: Record<string, unknown>,
	content: string,
): Record<string, unknown> | undefined {
	for (const field of ["system", "systemInstruction"] as const) {
		if (payload[field] === undefined) continue;
		const next = appendSystemText(payload[field], content);
		if (next !== undefined) return { ...payload, [field]: next };
	}
	for (const field of ["messages", "input"] as const) {
		const array = payload[field];
		if (!Array.isArray(array) || array.length === 0) continue;
		const head = array[0] as Record<string, unknown> | undefined;
		if (!head || typeof head !== "object") continue;
		if (head.role !== "system" && head.role !== "developer") continue;
		const next = appendSystemText(head.content, content);
		if (next === undefined) continue;
		const copy = [...array];
		copy[0] = { ...head, content: next };
		return { ...payload, [field]: copy };
	}
	return undefined;
}
