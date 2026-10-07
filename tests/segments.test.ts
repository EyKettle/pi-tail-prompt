import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	SegmentRegistry,
	materialize,
	validateSegment,
	type Segment,
} from "../segments.ts";

describe("validateSegment", () => {
	const ok = { id: "a", position: 1, source: { kind: "text", text: "x" } };

	test("accepts a text segment and an absolute path segment", () => {
		expect(validateSegment(ok)).toEqual(ok);
		const pathSeg = {
			id: "a",
			position: 0,
			source: { kind: "path", path: "/tmp/x" },
		};
		expect(validateSegment(pathSeg)).toEqual(pathSeg);
	});

	test("rejects every contract violation", () => {
		expect(validateSegment(null)).toBeNull();
		expect(validateSegment("nope")).toBeNull();
		expect(validateSegment({ ...ok, id: "" })).toBeNull();
		expect(validateSegment({ ...ok, position: 1.5 })).toBeNull();
		expect(validateSegment({ ...ok, position: "1" })).toBeNull();
		expect(validateSegment({ ...ok, source: { kind: "other" } })).toBeNull();
		expect(validateSegment({ ...ok, source: { kind: "text" } })).toBeNull();
		expect(
			validateSegment({ ...ok, source: { kind: "path", path: "rel/x" } }),
		).toBeNull();
	});
});

describe("SegmentRegistry", () => {
	test("orders by position descending then id ascending", () => {
		const registry = new SegmentRegistry();
		registry.register({ id: "b", position: 1, source: { kind: "text", text: "B" } });
		registry.register({ id: "a", position: 1, source: { kind: "text", text: "A" } });
		registry.register({ id: "c", position: 0, source: { kind: "text", text: "C" } });
		expect(registry.assemble()).toBe("A\n\nB\n\nC");
	});

	test("re-registering the same identifier replaces it", () => {
		const registry = new SegmentRegistry();
		registry.register({ id: "a", position: 1, source: { kind: "text", text: "old" } });
		registry.register({ id: "a", position: 1, source: { kind: "text", text: "new" } });
		expect(registry.assemble()).toBe("new");
	});

	test("drops an empty text and a missing path alone", () => {
		const registry = new SegmentRegistry();
		registry.register({ id: "a", position: 2, source: { kind: "text", text: "" } });
		registry.register({
			id: "b",
			position: 1,
			source: { kind: "path", path: "/no/such/file" },
		});
		registry.register({ id: "c", position: 0, source: { kind: "text", text: "keep" } });
		expect(registry.assemble()).toBe("keep");
	});

	test("returns null when nothing contributes", () => {
		expect(new SegmentRegistry().assemble()).toBeNull();
	});

	test("extra segments join the ordering", () => {
		const registry = new SegmentRegistry();
		registry.register({ id: "a", position: 1, source: { kind: "text", text: "A" } });
		const extra: Segment = {
			id: "tail-prompt",
			position: 0,
			source: { kind: "text", text: "C" },
		};
		expect(registry.assemble([extra])).toBe("A\n\nC");
	});
});

describe("materialize", () => {
	let dir: string;

	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-seg-"));
	});

	afterAll(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("reads an absolute path and trims", () => {
		const file = path.join(dir, "a.txt");
		fs.writeFileSync(file, "  hello\n");
		expect(materialize({ kind: "path", path: file })).toBe("hello");
	});

	test("returns null for a missing path", () => {
		expect(
			materialize({ kind: "path", path: path.join(dir, "missing") }),
		).toBeNull();
	});

	test("returns a text source unchanged", () => {
		expect(materialize({ kind: "text", text: "x" })).toBe("x");
	});
});
