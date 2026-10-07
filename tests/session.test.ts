import { describe, expect, test } from "vitest";
import { parseConfig } from "../config.ts";
import { applymentForSession, sessionClass } from "../session.ts";
import { PROFILE_YAML } from "./fixtures.ts";

describe("sessionClass", () => {
	test("treats PI_SUBAGENT_CHILD as subagent", () => {
		expect(sessionClass({ PI_SUBAGENT_CHILD: "1" })).toBe("subagent");
		expect(sessionClass({})).toBe("main");
	});
});

describe("applymentForSession", () => {
	test("main uses applyment; subagent uses the child profile", () => {
		const parsed = parseConfig(PROFILE_YAML);
		expect(applymentForSession(parsed, "main")).toEqual([
			"decompose",
			"contract",
		]);
		expect(applymentForSession(parsed, "subagent")).toEqual([
			"decompose",
			"child-contract",
		]);
	});

	test("a missing subagent profile fails closed", () => {
		const parsed = parseConfig("role: system\napplyment:\n  - decompose\n");
		expect(applymentForSession(parsed, "subagent")).toBeNull();
		expect(applymentForSession(parsed, "main")).toEqual(["decompose"]);
	});
});
