import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { locateRoleChapter, applyChildSystemPrompt } from "./identity.ts";

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
	].join("\n");

	function expectChildIdentity(out: string) {
		expect(out).toContain("I am a child subagent.");
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

	test("Role locator holds on disk SYSTEM.md", () => {
		const disk = fs.readFileSync(
			path.join(os.homedir(), ".pi", "agent", "SYSTEM.md"),
			"utf-8",
		);
		const lines = disk.split("\n");
		expect(lines.filter((l) => l === "## Role and Capability")).toHaveLength(1);
		const span = locateRoleChapter(disk);
		expect(span).not.toBeNull();
		expect(disk.slice(span!.start, span!.end)).toContain(
			"## Role and Capability",
		);
	});

	test("append-mode replaces the Role identity unit", () => {
		const out = applyChildSystemPrompt(systemMd, systemMd, childRole);
		expectChildIdentity(out);
		expect(out).toContain("Preamble");
	});

	test("replace-mode inserts the entire spliced SYSTEM.md", () => {
		const agentBody = "You are worker.\n\nDo the task.\n";
		const out = applyChildSystemPrompt(agentBody, systemMd, childRole);
		expect(out.startsWith("Preamble")).toBe(true);
		expect(out).toContain("Preamble");
		expect(out).toContain("You are worker.");
		expectChildIdentity(out);
		const roleCount = out.split("## Role and Capability").length - 1;
		expect(roleCount).toBe(1);
	});

	test("replace-mode inserts after child boundary when present", () => {
		const boundary =
			"You are a child subagent, not the parent orchestrator.\nStay in role.\n\nYou are worker.\n";
		const out = applyChildSystemPrompt(boundary, systemMd, childRole);
		expect(out.startsWith("You are a child subagent")).toBe(true);
		const boundaryAt = out.indexOf("You are a child subagent");
		const contractAt = out.indexOf("Preamble");
		expect(contractAt).toBeGreaterThan(boundaryAt);
		expect(out).toContain("You are worker.");
		expectChildIdentity(out);
	});

	test("idempotent when the Role unit already matches child", () => {
		const already = applyChildSystemPrompt(systemMd, systemMd, childRole);
		expect(applyChildSystemPrompt(already, systemMd, childRole)).toBe(already);
	});

	test("throws when SYSTEM.md Role locator fails", () => {
		expect(() =>
			applyChildSystemPrompt("agent", "no role chapter\n", childRole),
		).toThrow(/Role chapter locator failed/);
	});

	test("throws when parent identity remains after splice", () => {
		const leftover = `${systemMd}\nI am an orchestrator, not an implementer.\n`;
		expect(() => applyChildSystemPrompt(leftover, leftover, childRole)).toThrow(
			/parent identity/,
		);
	});

	test("splices disk SYSTEM.md with the published child role file", () => {
		const agentHome = path.join(os.homedir(), ".pi", "agent");
		const disk = fs.readFileSync(path.join(agentHome, "SYSTEM.md"), "utf-8");
		const publishedRole = fs.readFileSync(
			path.join(agentHome, "system-prompts", "child-role.md"),
			"utf-8",
		);
		const out = applyChildSystemPrompt(disk, disk, publishedRole);
		expect(out).toContain("I am a child subagent.");
		expect(out).not.toContain("I am an orchestrator, not an implementer.");
		expect(out).not.toContain(
			"This agent is an orchestrator, not an implementer.",
		);
		expect(out).toContain("# Namespace Registry");
	});
});
