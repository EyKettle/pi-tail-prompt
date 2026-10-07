import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "vitest";
import { resolveImportPath, loadPrompts } from "./prompts.ts";

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
