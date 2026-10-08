import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	loadPrompts,
	resolveImportPath,
	resolvePromptPaths,
} from "../prompts.ts";

describe("prompt loading", () => {
	let root: string;

	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "tail-prompt-"));
	});

	afterAll(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	test("resolveImportPath resolves a relative path under the config dir", () => {
		expect(resolveImportPath("system-prompts/a.txt", root)).toBe(
			path.join(root, "system-prompts", "a.txt"),
		);
	});

	test("resolveImportPath takes an absolute path as it is", () => {
		expect(resolveImportPath("/etc/prompts/a.txt", root)).toBe(
			"/etc/prompts/a.txt",
		);
	});

	test("resolveImportPath leaves escapes to the filesystem", () => {
		expect(resolveImportPath("../secret", root)).toBe(
			path.join(root, "..", "secret"),
		);
	});

	test("resolvePromptPaths reports an unmapped name", () => {
		const outcome = resolvePromptPaths(
			["a", "z"],
			{ a: "prompts/a.txt" },
			root,
		);
		expect(outcome.failure).toEqual({ kind: "unmapped-import", name: "z" });
	});

	test("loadPrompts reads resolved paths in order", () => {
		fs.mkdirSync(path.join(root, "prompts"), { recursive: true });
		fs.writeFileSync(path.join(root, "prompts", "a.txt"), "A\n");
		const resolved = resolvePromptPaths(["a"], { a: "prompts/a.txt" }, root);
		expect(loadPrompts(resolved.value!)).toEqual({ value: ["A"] });
	});

	test("loadPrompts reports the first unreadable path", () => {
		const missing = path.join(root, "prompts", "missing.txt");
		expect(loadPrompts([missing])).toEqual({
			failure: { kind: "unreadable-prompt", path: missing },
		});
	});

	test("loadPrompts reports a path that is a directory", () => {
		fs.mkdirSync(path.join(root, "adir"), { recursive: true });
		const resolved = resolveImportPath("adir", root);
		expect(loadPrompts([resolved])).toEqual({
			failure: { kind: "unreadable-prompt", path: resolved },
		});
	});
});
