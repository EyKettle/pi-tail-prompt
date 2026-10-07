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

	test("resolveImportPath keeps paths under the config dir", () => {
		expect(resolveImportPath("system-prompts/a.txt", root)).toBe(
			path.join(fs.realpathSync(root), "system-prompts", "a.txt"),
		);
	});

	test("resolveImportPath rejects lexical escapes", () => {
		expect(resolveImportPath("/etc/passwd", root)).toBeNull();
		expect(resolveImportPath("../secret", root)).toBeNull();
		expect(resolveImportPath("foo/../../outside", root)).toBeNull();
	});

	test("resolveImportPath rejects a symlink pointing outside the config dir", () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "tail-prompt-out-"));
		try {
			const target = path.join(outside, "secret.txt");
			fs.writeFileSync(target, "secret\n");
			fs.symlinkSync(target, path.join(root, "link.txt"));
			expect(resolveImportPath("link.txt", root)).toBeNull();
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	test("resolvePromptPaths fails closed on an unmapped name", () => {
		fs.mkdirSync(path.join(root, "prompts"), { recursive: true });
		fs.writeFileSync(path.join(root, "prompts", "a.txt"), "A\n");
		const imports = {
			a: "prompts/a.txt",
			b: "prompts/missing.txt",
		};
		expect(resolvePromptPaths(["a", "z"], imports, root)).toBeNull();
		expect(resolvePromptPaths(["a", "b"], imports, root)).not.toBeNull();
	});

	test("loadPrompts fails closed on a missing path and reads the rest", () => {
		const imports = {
			a: "prompts/a.txt",
			b: "prompts/missing.txt",
		};
		expect(
			loadPrompts(resolvePromptPaths(["a", "b"], imports, root)!),
		).toBeNull();
		expect(loadPrompts(resolvePromptPaths(["a"], imports, root)!)).toEqual([
			"A",
		]);
	});

	test("loadPrompts fails closed when a resolved path is unreadable", () => {
		fs.mkdirSync(path.join(root, "adir"), { recursive: true });
		const resolved = resolveImportPath("adir", root)!;
		expect(loadPrompts([resolved])).toBeNull();
	});
});
