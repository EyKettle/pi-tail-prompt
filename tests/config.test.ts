import { describe, expect, test } from "vitest";
import { parseConfig, resolveRole } from "../config.ts";
import { PROFILE_YAML } from "./fixtures.ts";

describe("parseConfig", () => {
	test("parses role, imports, applyment, and the subagent profile", () => {
		const parsed = parseConfig(PROFILE_YAML);
		expect(parsed.role).toBe("system");
		expect(parsed.roleRules).toEqual([]);
		expect(parsed.warnings).toEqual([]);
		expect(parsed.imports).toEqual({
			decompose: "system-prompts/decompose-thinking.txt",
			contract: "system-prompts/working-contract.txt",
			"child-contract": "system-prompts/child-working-contract.txt",
		});
		expect(parsed.applyment).toEqual(["decompose", "contract"]);
		expect(parsed.subagentApplyment).toEqual(["decompose", "child-contract"]);
	});

	test("defaults role to user when absent", () => {
		expect(parseConfig("applyment:\n  - decompose\n").role).toBe("user");
	});

	test("rejects an unknown role value", () => {
		expect(() => parseConfig("role: assistant\n")).toThrow(/unknown role/);
	});

	test("parses role rules in order", () => {
		const parsed = parseConfig(
			[
				"role: system",
				"roleRules:",
				'  ".*deepseek.*": user',
				'  "^gpt-5": system',
				"",
			].join("\n"),
		);
		expect(
			parsed.roleRules.map((rule) => [rule.pattern.source, rule.role]),
		).toEqual([
			[".*deepseek.*", "user"],
			["^gpt-5", "system"],
		]);
		expect(parsed.warnings).toEqual([]);
	});

	test("skips invalid role rules with a positional warning", () => {
		const parsed = parseConfig(
			[
				"roleRules:",
				'  "": user',
				'  "[": user',
				'  "ok": assistant',
				'  "nocolon"',
				'  "ok": user',
				"",
			].join("\n"),
		);
		expect(parsed.roleRules.map((rule) => rule.pattern.source)).toEqual(["ok"]);
		expect(parsed.warnings).toEqual([
			"roleRules[1] skipped: empty pattern",
			"roleRules[2] skipped: invalid regular expression '['",
			"roleRules[3] skipped: unknown role 'assistant'",
			"roleRules[4] skipped: expected \"pattern\": role",
		]);
	});

	test("an empty roleRules section yields no rules and no warning", () => {
		const parsed = parseConfig("roleRules:\n");
		expect(parsed.roleRules).toEqual([]);
		expect(parsed.warnings).toEqual([]);
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


describe("resolveRole", () => {
	const config = {
		role: "system" as const,
		roleRules: [
			{ pattern: /^deepseek/, role: "user" as const },
			{ pattern: /^gpt/, role: "system" as const },
		],
	};

	test("the first matching rule wins", () => {
		expect(resolveRole(config, "deepseek-chat")).toBe("user");
	});

	test("an unmatched model falls back to role", () => {
		expect(resolveRole(config, "claude")).toBe("system");
	});

	test("an undefined model falls back to role", () => {
		expect(resolveRole(config, undefined)).toBe("system");
	});
});
