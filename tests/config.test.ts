import { describe, expect, test } from "vitest";
import { parseConfig } from "../config.ts";
import { PROFILE_YAML } from "./fixtures.ts";

describe("parseConfig", () => {
	test("parses role, imports, applyment, and the subagent profile", () => {
		const parsed = parseConfig(PROFILE_YAML);
		expect(parsed.role).toBe("system");
		expect(parsed.imports).toEqual({
			decompose: "system-prompts/decompose-thinking.txt",
			contract: "system-prompts/working-contract.txt",
			"child-contract": "system-prompts/child-working-contract.txt",
		});
		expect(parsed.applyment).toEqual(["decompose", "contract"]);
		expect(parsed.subagentApplyment).toEqual(["decompose", "child-contract"]);
	});

	test("defaults role to system when absent", () => {
		expect(parseConfig("applyment:\n  - decompose\n").role).toBe("system");
	});

	test("rejects an unknown role value", () => {
		expect(() => parseConfig("role: assistant\n")).toThrow(/unknown role/);
	});

	test("accepts a trailing comment after a profile key", () => {
		const parsed = parseConfig(
			[
				"profiles:",
				"  subagent: # child sessions",
				"    applyment:",
				"      - child-contract",
				"",
			].join("\n"),
		);
		expect(parsed.subagentApplyment).toEqual(["child-contract"]);
	});

	test("a sibling profile does not overwrite the subagent applyment", () => {
		const parsed = parseConfig(
			[
				"profiles:",
				"  subagent:",
				"    applyment:",
				"      - decompose",
				"  main:",
				"    applyment:",
				"      - contract",
				"",
			].join("\n"),
		);
		expect(parsed.subagentApplyment).toEqual(["decompose"]);
	});
});
