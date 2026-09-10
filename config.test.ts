import { describe, expect, test } from "bun:test";
import { parseConfig, applymentForSession, sessionClass } from "./config.ts";

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

describe("sessionClass", () => {
	test("treats PI_SUBAGENT_CHILD as subagent", () => {
		expect(sessionClass({ PI_SUBAGENT_CHILD: "1" })).toBe("subagent");
		expect(sessionClass({})).toBe("main");
	});
});
