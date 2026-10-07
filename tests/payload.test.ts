import { describe, expect, test } from "vitest";
import {
	applyTailToPayload,
	injectAnthropicTail,
	injectTailPrompt,
	isAnthropicPayload,
} from "../payload.ts";

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
	test("classic turn: inserts before the final user message without mutating the input", () => {
		const messages = [system, user(1), { role: "assistant", content: "a" }];
		const out = injectTailPrompt(messages, "REMIND", "system");
		expect(out).not.toBe(messages);
		expect(out!.map((m) => m.role)).toEqual([
			"system",
			"system",
			"user",
			"assistant",
		]);
		expect(out![1]).toEqual({ role: "system", content: "REMIND" });
		expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
	});

	test("tool continuation: assistant tool_calls stay adjacent to tool responses", () => {
		const messages = [system, user(1), assistantWithCalls, toolResult];
		const out = injectTailPrompt(messages, "REMIND", "system")!;
		expect(out.map((m) => m.role)).toEqual([
			"system",
			"system",
			"user",
			"assistant",
			"tool",
		]);
		const asstIdx = out.findIndex((m) => m.role === "assistant");
		expect(out[asstIdx + 1]).toBe(toolResult);
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
		const out = injectTailPrompt(messages, "REMIND", "system")!;
		expect(out.map((m) => m.role)).toEqual([
			"system",
			"user",
			"assistant",
			"tool",
			"system",
			"user",
			"assistant",
		]);
		expect(out[4]).toEqual({ role: "system", content: "REMIND" });
	});

	test("respects the configured role when building the inserted message", () => {
		const out = injectTailPrompt([user(1)], "REMIND", "user")!;
		expect(out[0]).toEqual({ role: "user", content: "REMIND" });
	});

	test("no user message: returns null and leaves the payload untouched", () => {
		const messages = [system, assistantWithCalls, toolResult];
		expect(injectTailPrompt(messages, "REMIND", "system")).toBeNull();
		expect(messages.map((m) => m.role)).toEqual([
			"system",
			"assistant",
			"tool",
		]);
	});

	test("empty array: returns null", () => {
		expect(injectTailPrompt([], "REMIND", "system")).toBeNull();
	});

	test("tolerates null and undefined elements", () => {
		const messages = [
			null,
			{ role: "user", content: "u" },
			undefined,
		] as unknown as Array<Record<string, unknown>>;
		const out = injectTailPrompt(messages, "REMIND", "system")!;
		expect(out[0]).toBeNull();
		expect(out[1]).toEqual({ role: "system", content: "REMIND" });
		expect(out[2]).toEqual({ role: "user", content: "u" });
	});
});

describe("injectAnthropicTail", () => {
	test("inserts a message AFTER the latest user message without mutating the input", () => {
		const messages = [
			{ role: "user", content: "u1" },
			{ role: "assistant", content: [{ type: "text", text: "a" }] },
			{ role: "user", content: "u2" },
		];
		const out = injectAnthropicTail(messages, "REMIND");
		expect(out).not.toBe(messages);
		expect(out!.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
			"system",
		]);
		expect(out![3]).toEqual({ role: "system", content: "REMIND" });
		expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
	});

	test("tool continuation: stays after the user turn, no tool pairing split", () => {
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
		const out = injectAnthropicTail(messages, "REMIND")!;
		expect(out.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
			"system",
		]);
	});

	test("single user message: appends after it (not as first entry, so legal)", () => {
		const out = injectAnthropicTail([{ role: "user", content: "u1" }], "REMIND")!;
		expect(out.map((m) => m.role)).toEqual(["user", "system"]);
	});

	test("no idempotence guard: injects even when a system message already follows", () => {
		const messages = [
			{ role: "user", content: "u1" },
			{ role: "system", content: "existing" },
		];
		const out = injectAnthropicTail(messages, "REMIND")!;
		expect(out.map((m) => m.role)).toEqual(["user", "system", "system"]);
		expect(out[1]).toEqual({ role: "system", content: "REMIND" });
		expect(out[2]).toEqual({ role: "system", content: "existing" });
	});

	test("no user message: returns null and leaves the payload untouched", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "t1", name: "read", input: {} }],
			},
		];
		expect(injectAnthropicTail(messages, "REMIND")).toBeNull();
	});
});

describe("isAnthropicPayload", () => {
	test("either signal is enough: the payload marker wins over a non-Anthropic protocol", () => {
		expect(
			isAnthropicPayload(
				{
					system: [],
					messages: [{ role: "user", content: "u" }],
				} as unknown as Record<string, unknown>,
				"openai-completions",
			),
		).toBe(true);
	});
	test("the declared protocol is authoritative", () => {
		const payload = {
			messages: [{ role: "user", content: "u" }],
		} as unknown as Record<string, unknown>;
		expect(isAnthropicPayload(payload, "anthropic-messages")).toBe(true);
		expect(isAnthropicPayload(payload, "openai-completions")).toBe(false);
	});

	test("fallback: a top-level system field marks an Anthropic payload", () => {
		expect(
			isAnthropicPayload({
				system: [],
				messages: [{ role: "user", content: "u" }],
			} as unknown as Record<string, unknown>),
		).toBe(true);
	});

	test("fallback: no top-level system field is not Anthropic", () => {
		expect(
			isAnthropicPayload({
				messages: [{ role: "user", content: "u" }],
			} as unknown as Record<string, unknown>),
		).toBe(false);
	});
});

describe("applyTailToPayload (hook routing)", () => {
	const anthropicPayload = () => ({
		model: "claude-opus-4-8",
		system: [{ type: "text", text: "s" }],
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

	test("Anthropic payload: inserts after the latest user, returns a new payload", () => {
		const payload = anthropicPayload();
		const out = applyTailToPayload(
			payload as unknown as Record<string, unknown>,
			"REMIND",
			"system",
		);
		expect(out).not.toBe(payload);
		const messages = out!.messages as Array<Record<string, unknown>>;
		expect(messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
			"system",
		]);
		expect(messages[3]).toEqual({ role: "system", content: "REMIND" });
		expect(payload.messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
		]);
	});

	test("Anthropic by declared protocol even without a top-level system field", () => {
		const payload = {
			model: "claude-sonnet-5",
			messages: [
				{ role: "user", content: "u1" },
				{ role: "assistant", content: "a" },
				{ role: "user", content: "u2" },
			],
		};
		const out = applyTailToPayload(
			payload as unknown as Record<string, unknown>,
			"REMIND",
			"system",
			"anthropic-messages",
		)!;
		const messages = out.messages as Array<Record<string, unknown>>;
		expect(messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
			"system",
		]);
		expect(messages[3]).toEqual({ role: "system", content: "REMIND" });
	});

	test("OpenAI payload: inserts before the latest user, configured role", () => {
		const payload = openaiPayload();
		const out = applyTailToPayload(
			payload as unknown as Record<string, unknown>,
			"REMIND",
			"user",
		);
		expect(out).not.toBe(payload);
		const messages = out!.messages as Array<Record<string, unknown>>;
		expect(messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
			"user",
		]);
		expect(messages[2]).toEqual({ role: "user", content: "REMIND" });
	});

	test("Responses input: inserts before the latest user message", () => {
		const payload = {
			model: "grok-4.6",
			input: [
				{ role: "developer", content: "s" },
				{ role: "user", content: "u1" },
				{ role: "assistant", content: "a" },
				{ role: "user", content: "u2" },
			],
		};
		const out = applyTailToPayload(
			payload as unknown as Record<string, unknown>,
			"REMIND",
			"system",
		);
		const input = out!.input as Array<Record<string, unknown>>;
		expect(input.map((m) => m.role)).toEqual([
			"developer",
			"user",
			"assistant",
			"system",
			"user",
		]);
		expect(input[3]).toEqual({ role: "system", content: "REMIND" });
	});

	test("non-messages payload: returns undefined, untouched", () => {
		expect(
			applyTailToPayload({ model: "x" }, "REMIND", "system"),
		).toBeUndefined();
	});

	test("Responses input without a user message: returns undefined", () => {
		const payload = {
			model: "grok-4.6",
			input: [{ role: "developer", content: "s" }],
		};
		expect(
			applyTailToPayload(
				payload as unknown as Record<string, unknown>,
				"REMIND",
				"system",
			),
		).toBeUndefined();
	});

	test("messages present: Chat path wins over input", () => {
		const payload = {
			model: "gpt-5",
			messages: [{ role: "user", content: "u1" }],
			input: [{ role: "user", content: "other" }],
		};
		const out = applyTailToPayload(
			payload as unknown as Record<string, unknown>,
			"REMIND",
			"system",
		)!;
		expect((out.messages as Array<Record<string, unknown>>).map((m) => m.role)).toEqual([
			"system",
			"user",
		]);
		expect((out.input as Array<Record<string, unknown>>).map((m) => m.role)).toEqual([
			"user",
		]);
	});
});
