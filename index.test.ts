import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import {
	injectTailPrompt,
	injectAnthropicTail,
	applyTailToPayload,
	isAnthropicPayload,
	isSonnet5,
	parseConfig,
	applymentForSession,
	locateRoleChapter,
	locateClosingIdentity,
	applyChildSystemPrompt,
	resolveImportPath,
	loadPrompts,
	sessionClass,
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

	test("Responses input: injects before the latest user message", () => {
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
		expect(out).toBe(payload);
		const input = payload.input as Array<Record<string, unknown>>;
		expect(input.map((m) => m.role)).toEqual([
			"developer",
			"user",
			"assistant",
			"system",
			"user",
		]);
		expect(input[3]).toEqual({ role: "system", content: "REMIND" });
	});

	test("Responses input without a user message: returns undefined, untouched", () => {
		const payload = {
			model: "grok-4.6",
			input: [{ role: "developer", content: "s" }],
		};
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

	test("messages present: Chat path wins over input", () => {
		const payload = {
			model: "gpt-5",
			messages: [{ role: "user", content: "u1" }],
			input: [{ role: "user", content: "other" }],
		};
		applyTailToPayload(
			payload as unknown as Record<string, unknown>,
			"REMIND",
			"system",
		);
		expect(payload.messages.map((m) => m.role)).toEqual(["system", "user"]);
		expect(payload.input.map((m) => m.role)).toEqual(["user"]);
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

describe("parseConfig profiles", () => {
	const yaml = [
		"role: system",
		"imports:",
		"  decompose: system-prompts/decompose-thinking.txt",
		"  contract: system-prompts/working-contract.txt",
		"  child-contract: system-prompts/child-working-contract.txt",
		"applyment:",
		"  - decompose",
		"  - contract",
		"profiles:",
		"  subagent:",
		"    applyment:",
		"      - decompose",
		"      - child-contract",
		"",
	].join("\n");

	test("parent applyment stays decompose then contract", () => {
		const parsed = parseConfig(yaml);
		expect(applymentForSession(parsed, "main")).toEqual([
			"decompose",
			"contract",
		]);
	});

	test("subagent applyment is decompose then child-contract", () => {
		const parsed = parseConfig(yaml);
		expect(applymentForSession(parsed, "subagent")).toEqual([
			"decompose",
			"child-contract",
		]);
	});

	test("missing subagent profile fails closed", () => {
		const parsed = parseConfig("role: system\napplyment:\n  - decompose\n");
		expect(applymentForSession(parsed, "subagent")).toBeNull();
		expect(applymentForSession(parsed, "main")).toEqual(["decompose"]);
	});

	test("sibling profile applyment does not overwrite subagent applyment", () => {
		const parsed = parseConfig(
			[
				"role: system",
				"imports:",
				"  decompose: system-prompts/decompose-thinking.txt",
				"  contract: system-prompts/working-contract.txt",
				"  child-contract: system-prompts/child-working-contract.txt",
				"applyment:",
				"  - decompose",
				"profiles:",
				"  subagent:",
				"    applyment:",
				"      - decompose",
				"      - child-contract",
				"  main:",
				"    applyment:",
				"      - contract",
				"",
			].join("\n"),
		);
		expect(applymentForSession(parsed, "subagent")).toEqual([
			"decompose",
			"child-contract",
		]);
	});
});

describe("import path and prompt load", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tail-prompt-"));

	test("resolveImportPath keeps paths under config dir", () => {
		const inside = resolveImportPath("system-prompts/a.txt", root);
		expect(inside).toBe(path.resolve(root, "system-prompts/a.txt"));
	});

	test("resolveImportPath rejects escape (absolute or ..)", () => {
		expect(resolveImportPath("/etc/passwd", root)).toBeNull();
		expect(resolveImportPath("../secret", root)).toBeNull();
		expect(resolveImportPath("foo/../../outside", root)).toBeNull();
	});

	test("loadPrompts fails closed when any applyment name is missing", () => {
		fs.mkdirSync(path.join(root, "prompts"));
		fs.writeFileSync(path.join(root, "prompts", "a.txt"), "A\n");
		const imports = {
			a: "prompts/a.txt",
			b: "prompts/missing.txt",
		};
		expect(loadPrompts(["a", "b"], imports, root)).toBeNull();
		expect(loadPrompts(["a"], imports, root)).toEqual(["A"]);
	});
});

describe("Identity unit splice", () => {
	const parentRole = [
		"## Role and Capability",
		"",
		"**Role**:",
		"I am an orchestrator, not an implementer.",
		"",
		"---",
	].join("\n");
	const childRole = [
		"## Role and Capability",
		"",
		"**Role**:",
		"I am a child subagent.",
		"",
		"---",
	].join("\n");
	const parentClosing = [
		"**This agent is an orchestrator, not an implementer.**",
		"",
		"Delegate significant implementation (HB#1).",
		"",
		"The full constraint set is in the sections above.",
		"",
		"_(End of SOUL)_",
	].join("\n");
	const childClosing = [
		"**This agent is a child subagent.**",
		"",
		"Complete the assigned task inside AUTHORIZATION.",
		"",
		"The full constraint set is in the sections above.",
		"",
		"_(End of SOUL)_",
	].join("\n");
	const systemMd = [
		"Preamble",
		"",
		parentRole,
		"",
		"# Namespace Registry",
		"",
		"## Delegation & Orchestration",
		"",
		"HB#7",
		"",
		parentClosing,
		"",
	].join("\n");

	function expectChildIdentity(out: string) {
		expect(out).toContain("I am a child subagent.");
		expect(out).toContain("**This agent is a child subagent.**");
		expect(out).not.toContain("I am an orchestrator, not an implementer.");
		expect(out).not.toContain(
			"This agent is an orchestrator, not an implementer.",
		);
		expect(out).toContain("# Namespace Registry");
		expect(out).toContain("HB#7");
		expect(out).toContain("## Delegation & Orchestration");
	}

	test("Role locator requires heading, fence, and Namespace Registry", () => {
		const span = locateRoleChapter(systemMd);
		expect(span).not.toBeNull();
		expect(systemMd.slice(span!.start, span!.end).trim()).toBe(parentRole);
		expect(locateRoleChapter(`${parentRole}\n\n# Other\n`)).toBeNull();
		expect(locateRoleChapter("no role here\n# Namespace Registry\n")).toBeNull();
	});

	test("closing locator spans the unique start line through End of SOUL", () => {
		const span = locateClosingIdentity(systemMd);
		expect(span).not.toBeNull();
		const slice = systemMd.slice(span!.start, span!.end).trim();
		expect(
			slice.startsWith(
				"**This agent is an orchestrator, not an implementer.**",
			),
		).toBe(true);
		expect(slice.endsWith("_(End of SOUL)_")).toBe(true);
		expect(
			locateClosingIdentity(systemMd.replace("_(End of SOUL)_", "nope")),
		).toBeNull();
		expect(
			locateClosingIdentity(
				`${systemMd}\n**This agent is an orchestrator, not an implementer.**\n`,
			),
		).toBeNull();
		expect(locateClosingIdentity(`${systemMd}\n_(End of SOUL)_\n`)).toBeNull();
	});

	test("closing locator is unique on disk SYSTEM.md", () => {
		const disk = fs.readFileSync(
			path.join(os.homedir(), ".pi", "agent", "SYSTEM.md"),
			"utf-8",
		);
		const lines = disk.split("\n");
		expect(
			lines.filter(
				(l) => l === "**This agent is an orchestrator, not an implementer.**",
			),
		).toHaveLength(1);
		expect(lines.filter((l) => l === "_(End of SOUL)_")).toHaveLength(1);
		const span = locateClosingIdentity(disk);
		expect(span).not.toBeNull();
		const slice = disk.slice(span!.start, span!.end);
		expect(slice).toContain(
			"**This agent is an orchestrator, not an implementer.**",
		);
		expect(slice.trimEnd().endsWith("_(End of SOUL)_")).toBe(true);
	});

	test("append-mode replaces Role and closing identity", () => {
		const out = applyChildSystemPrompt(
			systemMd,
			systemMd,
			childRole,
			childClosing,
		);
		expectChildIdentity(out);
		expect(out).toContain("Preamble");
	});

	test("replace-mode inserts the entire spliced SYSTEM.md", () => {
		const agentBody = "You are worker.\n\nDo the task.\n";
		const out = applyChildSystemPrompt(
			agentBody,
			systemMd,
			childRole,
			childClosing,
		);
		expect(
			out.startsWith("## Role and Capability") || out.includes("Preamble"),
		).toBe(true);
		expect(out).toContain("Preamble");
		expect(out).toContain("You are worker.");
		expectChildIdentity(out);
		const roleCount = out.split("## Role and Capability").length - 1;
		expect(roleCount).toBe(1);
	});

	test("replace-mode inserts after child boundary when present", () => {
		const boundary =
			"You are a child subagent, not the parent orchestrator.\nStay in role.\n\nYou are worker.\n";
		const out = applyChildSystemPrompt(
			boundary,
			systemMd,
			childRole,
			childClosing,
		);
		expect(out.startsWith("You are a child subagent")).toBe(true);
		const boundaryAt = out.indexOf("You are a child subagent");
		const contractAt = out.indexOf("Preamble");
		expect(contractAt).toBeGreaterThan(boundaryAt);
		expect(out).toContain("You are worker.");
		expectChildIdentity(out);
	});

	test("idempotent when both identity units already match child", () => {
		const already = applyChildSystemPrompt(
			systemMd,
			systemMd,
			childRole,
			childClosing,
		);
		expect(
			applyChildSystemPrompt(already, systemMd, childRole, childClosing),
		).toBe(already);
	});

	test("does not skip closing splice when Role already matches child", () => {
		const mixed = systemMd.replace(
			"I am an orchestrator, not an implementer.",
			"I am a child subagent.",
		);
		expect(mixed).toContain("I am a child subagent.");
		expect(mixed).toContain(
			"This agent is an orchestrator, not an implementer.",
		);
		const out = applyChildSystemPrompt(
			mixed,
			systemMd,
			childRole,
			childClosing,
		);
		expectChildIdentity(out);
	});

	test("throws when SYSTEM.md Role locator fails", () => {
		expect(() =>
			applyChildSystemPrompt(
				"agent",
				"no role chapter\n",
				childRole,
				childClosing,
			),
		).toThrow(/Role chapter locator failed/);
	});

	test("throws when SYSTEM.md closing locator fails", () => {
		const noClosing = `Preamble\n\n${parentRole}\n\n# Namespace Registry\n\nHB#7\n`;
		expect(() =>
			applyChildSystemPrompt("agent", noClosing, childRole, childClosing),
		).toThrow(/closing identity locator failed/);
	});

	test("throws when parent identity remains after splice", () => {
		const leftover = `${systemMd}\nI am an orchestrator, not an implementer.\n`;
		expect(() =>
			applyChildSystemPrompt(leftover, leftover, childRole, childClosing),
		).toThrow(/parent identity/);
	});

	test("splices disk SYSTEM.md with published child identity files", () => {
		const agentHome = path.join(os.homedir(), ".pi", "agent");
		const disk = fs.readFileSync(path.join(agentHome, "SYSTEM.md"), "utf-8");
		const publishedRole = fs.readFileSync(
			path.join(agentHome, "system-prompts", "child-role.md"),
			"utf-8",
		);
		const publishedClosing = fs.readFileSync(
			path.join(agentHome, "system-prompts", "child-closing.md"),
			"utf-8",
		);
		const out = applyChildSystemPrompt(
			disk,
			disk,
			publishedRole,
			publishedClosing,
		);
		expect(out).toContain("I am a child subagent.");
		expect(out).toContain("This agent is a child subagent.");
		expect(out).not.toContain("I am an orchestrator, not an implementer.");
		expect(out).not.toContain(
			"This agent is an orchestrator, not an implementer.",
		);
		expect(out).toContain("# Namespace Registry");
		expect(out).toContain("HB#7");
		expect(out).toContain("## Delegation & Orchestration");
	});
});

describe("child applyment on Chat and Responses payloads", () => {
	const yaml = [
		"role: system",
		"imports:",
		"  decompose: system-prompts/decompose-thinking.txt",
		"  contract: system-prompts/working-contract.txt",
		"  child-contract: system-prompts/child-working-contract.txt",
		"applyment:",
		"  - decompose",
		"  - contract",
		"profiles:",
		"  subagent:",
		"    applyment:",
		"      - decompose",
		"      - child-contract",
		"",
	].join("\n");

	test("sessionClass treats PI_SUBAGENT_CHILD as subagent", () => {
		expect(sessionClass({ PI_SUBAGENT_CHILD: "1" })).toBe("subagent");
		expect(sessionClass({})).toBe("main");
	});

	test("injects thinking-step and skill-load tags into messages and input", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "tail-prompt-child-"));
		fs.mkdirSync(path.join(root, "system-prompts"));
		fs.writeFileSync(
			path.join(root, "system-prompts", "decompose-thinking.txt"),
			'<instruction target="thinking-step" kind="any" type="analysis">think</instruction>\n',
		);
		fs.writeFileSync(
			path.join(root, "system-prompts", "child-working-contract.txt"),
			'<instruction target="skill-load" kind="any" type="action">load</instruction>\n',
		);
		const parsed = parseConfig(yaml);
		const names = applymentForSession(
			parsed,
			sessionClass({ PI_SUBAGENT_CHILD: "1" }),
		);
		expect(names).toEqual(["decompose", "child-contract"]);
		const prompts = loadPrompts(names!, parsed.imports, root);
		expect(prompts).not.toBeNull();
		const content = prompts!.join("\n\n");

		const chatPayload = {
			model: "gpt-5",
			messages: [
				{ role: "system", content: "s" },
				{ role: "user", content: "u1" },
			],
		};
		const inputPayload = {
			model: "grok-4.6",
			input: [
				{ role: "developer", content: "s" },
				{ role: "user", content: "u1" },
			],
		};

		const chatOut = applyTailToPayload(
			chatPayload as unknown as Record<string, unknown>,
			content,
			parsed.role,
		);
		const inputOut = applyTailToPayload(
			inputPayload as unknown as Record<string, unknown>,
			content,
			parsed.role,
		);
		expect(chatOut).toBe(chatPayload);
		expect(inputOut).toBe(inputPayload);

		const chatInjected = chatPayload.messages.find((m) =>
			String(m.content).includes("<instruction"),
		);
		const inputInjected = inputPayload.input.find((m) =>
			String(m.content).includes("<instruction"),
		);
		expect(chatInjected).toBeDefined();
		expect(inputInjected).toBeDefined();
		expect(String(chatInjected!.content)).toContain(
			'<instruction target="thinking-step"',
		);
		expect(String(chatInjected!.content)).toContain('target="skill-load"');
		expect(String(inputInjected!.content)).toContain(
			'<instruction target="thinking-step"',
		);
		expect(String(inputInjected!.content)).toContain('target="skill-load"');
	});
});
