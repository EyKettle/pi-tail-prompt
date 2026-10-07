import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parseConfig } from "../config.ts";
import { applyTailToPayload } from "../payload.ts";
import { loadPrompts, resolvePromptPaths } from "../prompts.ts";
import { applymentForSession, sessionClass } from "../session.ts";
import { PROFILE_YAML } from "./fixtures.ts";

describe("subagent applyment integration", () => {
	let root: string;

	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "tail-prompt-child-"));
		fs.mkdirSync(path.join(root, "system-prompts"));
		fs.writeFileSync(
			path.join(root, "system-prompts", "decompose-thinking.txt"),
			'<instruction target="thinking-step" kind="any" type="analysis">think</instruction>\n',
		);
		fs.writeFileSync(
			path.join(root, "system-prompts", "child-working-contract.txt"),
			'<instruction target="skill-load" kind="any" type="action">load</instruction>\n',
		);
	});

	afterAll(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("injects the child applyment block into messages and input", () => {
		const parsed = parseConfig(PROFILE_YAML);
		const names = applymentForSession(
			parsed,
			sessionClass({ PI_SUBAGENT_CHILD: "1" }),
		);
		expect(names).toEqual(["decompose", "child-contract"]);
		const prompts = loadPrompts(resolvePromptPaths(names!, parsed.imports, root)!);
		expect(prompts).not.toBeNull();
		const block = prompts!.join("\n\n");

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
			block,
			parsed.role,
		)!;
		const inputOut = applyTailToPayload(
			inputPayload as unknown as Record<string, unknown>,
			block,
			parsed.role,
		)!;

		const chatInjected = (
			chatOut.messages as Array<Record<string, unknown>>
		).find((m) => String(m.content).includes("<instruction"));
		const inputInjected = (
			inputOut.input as Array<Record<string, unknown>>
		).find((m) => String(m.content).includes("<instruction"));
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
