import { describe, expect, test } from "bun:test";
import {
	injectTailPrompt,
	injectAnthropicTail,
	applyTailToPayload,
	isAnthropicPayload,
	isSonnet5,
} from "./index.ts";

const system = { role: "system", content: "s" };
const user = (n: number) => ({ role: "user", content: `u${n}` });
const assistantWithCalls = {
	role: "assistant",
	content: "calling",
	tool_calls: [
		{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } },
	],
};
const toolResult = { role: "tool", content: "r", tool_call_id: "c1" };

describe("injectTailPrompt", () => {
	test("classic turn: injects before the final user message", () => {
		const messages = [system, user(1), { role: "assistant", content: "a" }];
		const out = injectTailPrompt(messages, "REMIND", "system");
		expect(out).toBe(messages); // mutates in place
		expect(messages.map((m) => m.role)).toEqual([
			"system",
			"system",
			"user",
			"assistant",
		]);
		expect(messages[1]).toEqual({ role: "system", content: "REMIND" });
	});

	test("tool continuation: assistant tool_calls stay adjacent to tool responses", () => {
		const messages = [system, user(1), assistantWithCalls, toolResult];
		injectTailPrompt(messages, "REMIND", "system");
		expect(messages.map((m) => m.role)).toEqual([
			"system",
			"system",
			"user",
			"assistant",
			"tool",
		]);
		const asstIdx = messages.findIndex((m) => m.role === "assistant");
		expect(messages[asstIdx + 1]).toBe(toolResult); // immediate adjacency preserved
		expect(messages[1]).toEqual({ role: "system", content: "REMIND" });
	});

	test("anchors on the latest user message in a multi-user payload", () => {
		const messages = [
			system,
			user(1),
			assistantWithCalls,
			toolResult,
			user(2),
			{ role: "assistant", content: "a" },
		];
		injectTailPrompt(messages, "REMIND", "system");
		expect(messages.map((m) => m.role)).toEqual([
			"system",
			"user",
			"assistant",
			"tool",
			"system",
			"user",
			"assistant",
		]);
		expect(messages[4]).toEqual({ role: "system", content: "REMIND" });
	});

	test("respects the configured role when building the injected message", () => {
		const messages = [user(1)];
		injectTailPrompt(messages, "REMIND", "user");
		expect(messages[0]).toEqual({ role: "user", content: "REMIND" });
	});

	test("no user message: returns null and leaves the payload untouched", () => {
		const messages = [system, assistantWithCalls, toolResult];
		const snapshot = JSON.stringify(messages);
		expect(injectTailPrompt(messages, "REMIND", "system")).toBeNull();
		expect(JSON.stringify(messages)).toBe(snapshot);
	});

	test("empty array: returns null", () => {
		expect(injectTailPrompt([], "REMIND", "system")).toBeNull();
	});
});

describe("injectAnthropicTail", () => {
	test("injects a system message AFTER the latest user message", () => {
		const messages = [
			{ role: "user", content: "u1" },
			{ role: "assistant", content: [{ type: "text", text: "a" }] },
			{ role: "user", content: "u2" },
		];
		const out = injectAnthropicTail(messages, "REMIND");
		expect(out).toBe(messages);
		expect(messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
			"system",
		]);
		expect(messages[3]).toEqual({ role: "system", content: "REMIND" });
	});

	test("tool continuation: anthropic system stays after the user turn, no tool pairing split", () => {
		// Anthropic tool results are user-role messages carrying tool_result blocks;
		// the system message must follow that user turn, not precede it.
		const messages = [
			{ role: "user", content: "u1" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "t1", name: "read", input: {} }],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "t1", content: "r" }],
			},
		];
		injectAnthropicTail(messages, "REMIND");
		expect(messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
			"system",
		]);
		// the tool_result user turn keeps its place right after the tool_use assistant
		expect((messages[2] as Record<string, unknown>).role).toBe("user");
		expect(messages[3]).toEqual({ role: "system", content: "REMIND" });
	});

	test("single user message: appends system after it (not as first entry, so legal)", () => {
		// Anthropic forbids a system message as the FIRST entry in `messages`;
		// [user, system] keeps system second, which is allowed.
		const messages = [{ role: "user", content: "u1" }];
		injectAnthropicTail(messages, "REMIND");
		expect(messages.map((m) => m.role)).toEqual(["user", "system"]);
		expect(messages[1]).toEqual({ role: "system", content: "REMIND" });
	});

	test("no user message: returns null and leaves payload untouched", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "t1", name: "read", input: {} }],
			},
		];
		const snapshot = JSON.stringify(messages);
		expect(injectAnthropicTail(messages, "REMIND")).toBeNull();
		expect(JSON.stringify(messages)).toBe(snapshot);
	});
});

describe("applyTailToPayload (hook routing)", () => {
	const anthropicPayload = (model: string) => ({
		model,
		system: [{ type: "text", text: "s" }],
		max_tokens: 8192,
		messages: [
			{ role: "user", content: "u1" },
			{ role: "assistant", content: [{ type: "text", text: "a" }] },
			{ role: "user", content: "u2" },
		],
	});
	const openaiPayload = () => ({
		model: "gpt-5",
		messages: [
			{ role: "user", content: "u1" },
			{ role: "assistant", content: "a" },
			{ role: "user", content: "u2" },
		],
	});

	test("Anthropic payload: routes to injectAnthropicTail (system after latest user)", () => {
		const payload = anthropicPayload("claude-opus-4-8");
		const out = applyTailToPayload(
			payload as unknown as Record<string, unknown>,
			"REMIND",
			"system",
		);
		expect(out).toBe(payload);
		const messages = payload.messages as Array<Record<string, unknown>>;
		expect(messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
			"system",
		]);
		expect(messages[3]).toEqual({ role: "system", content: "REMIND" });
	});

	test("Sonnet 5 Anthropic payload: skipped, payload untouched", () => {
		const payload = anthropicPayload("claude-sonnet-5");
		const snapshot = JSON.stringify(payload);
		expect(
			applyTailToPayload(
				payload as unknown as Record<string, unknown>,
				"REMIND",
				"system",
			),
		).toBeUndefined();
		expect(JSON.stringify(payload)).toBe(snapshot);
	});

	test("OpenAI payload: routes to injectTailPrompt (before latest user, configured role)", () => {
		const payload = openaiPayload();
		const out = applyTailToPayload(
			payload as unknown as Record<string, unknown>,
			"REMIND",
			"user",
		);
		expect(out).toBe(payload);
		const messages = payload.messages as Array<Record<string, unknown>>;
		expect(messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
			"user",
		]);
		expect(messages[2]).toEqual({ role: "user", content: "REMIND" });
	});

	test("non-messages payload: returns undefined, untouched", () => {
		const payload = { model: "x" };
		expect(
			applyTailToPayload(
				payload as unknown as Record<string, unknown>,
				"REMIND",
				"system",
			),
		).toBeUndefined();
	});
});

describe("idempotence guards", () => {
	test("Anthropic: skips when a system message already follows the latest user (no double injection)", () => {
		const messages = [
			{ role: "user", content: "u1" },
			{ role: "user", content: "u2" },
			{ role: "system", content: "existing reminder" },
		];
		const snapshot = JSON.stringify(messages);
		expect(injectAnthropicTail(messages, "REMIND")).toBeNull();
		expect(JSON.stringify(messages)).toBe(snapshot);
	});

	test("Anthropic: inserts normally when the following message is not system", () => {
		const messages = [
			{ role: "user", content: "u1" },
			{ role: "assistant", content: [{ type: "text", text: "a" }] },
			{ role: "user", content: "u2" },
			{ role: "assistant", content: [{ type: "text", text: "b" }] },
		];
		const out = injectAnthropicTail(messages, "REMIND");
		expect(out).toBe(messages);
		expect(messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
			"system",
			"assistant",
		]);
	});
});

describe("isAnthropicPayload", () => {
	test("Anthropic shape: top-level system + max_tokens + messages array", () => {
		const payload = {
			model: "claude-opus-4-8",
			system: [{ type: "text", text: "s" }],
			max_tokens: 8192,
			messages: [{ role: "user", content: "u" }],
		};
		expect(
			isAnthropicPayload(payload as unknown as Record<string, unknown>),
		).toBe(true);
	});
	test("OpenAI shape: no top-level system field", () => {
		const payload = {
			model: "gpt-5",
			messages: [{ role: "user", content: "u" }],
		};
		expect(
			isAnthropicPayload(payload as unknown as Record<string, unknown>),
		).toBe(false);
	});
});

describe("isSonnet5", () => {
	test("matches Sonnet 5 ids only", () => {
		expect(isSonnet5("claude-sonnet-5")).toBe(true);
		expect(isSonnet5("claude-sonnet-5-20260101")).toBe(true);
		expect(isSonnet5("claude-sonnet-4-5")).toBe(false); // not Sonnet 5
		expect(isSonnet5("claude-sonnet-4-6")).toBe(false);
		expect(isSonnet5("claude-opus-4-8")).toBe(false);
	});
});
