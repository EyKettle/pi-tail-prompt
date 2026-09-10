import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { applymentForSession, parseConfig, sessionClass } from "./config.ts";
import { applyTailToPayload } from "./payload.ts";
import { loadPrompts } from "./prompts.ts";

describe("child applyment integration", () => {
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
