import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// The entry resolves its config directory through Pi's accessor; the mock is
// the accessor, so the override path exercises the real call site.
vi.mock("@earendil-works/pi-coding-agent", async () => {
	const osMod = await import("node:os");
	const pathMod = await import("node:path");
	return {
		getAgentDir: () =>
			process.env.PI_CODING_AGENT_DIR ??
			pathMod.join(osMod.homedir(), ".pi", "agent"),
	};
});

import factory from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type BusHandler = (data: unknown) => void;

function createBus() {
	const handlers = new Map<string, Set<BusHandler>>();
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const errors: Array<{ channel: string; error: unknown }> = [];
	return {
		emit(channel: string, data: unknown) {
			emitted.push({ channel, data });
			for (const handler of handlers.get(channel) ?? []) {
				try {
					handler(data);
				} catch (error) {
					errors.push({ channel, error });
				}
			}
		},
		on(channel: string, handler: BusHandler) {
			let set = handlers.get(channel);
			if (!set) {
				set = new Set();
				handlers.set(channel, set);
			}
			const target = set;
			target.add(handler);
			return () => {
				target.delete(handler);
			};
		},
		emitted,
		errors,
	};
}

function capture() {
	const handlers: Record<string, Handler[]> = {};
	const bus = createBus();
	const pi = {
		on(event: string, handler: Handler) {
			(handlers[event] ??= []).push(handler);
			return () => {};
		},
		events: bus,
	};
	return { pi, handlers, bus };
}

const CAPABLE = { model: { compat: { supportsMidConvoSystemMessages: true } } };
const INCAPABLE = { model: { compat: { supportsMidConvoSystemMessages: false } } };

const created: string[] = [];
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousSubagent = process.env.PI_SUBAGENT_CHILD;

afterEach(() => {
	for (const dir of created.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (previousSubagent === undefined) delete process.env.PI_SUBAGENT_CHILD;
	else process.env.PI_SUBAGENT_CHILD = previousSubagent;
});

function scratchDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	created.push(dir);
	return dir;
}

/** A scratch agent dir holding a config whose block is "BLOCK-A". */
function scratchAgentDir(): string {
	const dir = scratchDir("tail-prompt-agent-");
	fs.mkdirSync(path.join(dir, "system-prompts"));
	fs.writeFileSync(path.join(dir, "system-prompts", "a.txt"), "BLOCK-A\n");
	fs.writeFileSync(
		path.join(dir, "tail-prompt.yaml"),
		[
			"role: system",
			"imports:",
			"  a: system-prompts/a.txt",
			"applyment:",
			"  - a",
			"",
		].join("\n"),
	);
	process.env.PI_CODING_AGENT_DIR = dir;
	delete process.env.PI_SUBAGENT_CHILD;
	return dir;
}

function load() {
	const { pi, handlers, bus } = capture();
	factory(pi as unknown as ExtensionAPI);
	return { handlers, bus };
}

function block(handlers: Record<string, Handler[]>): string {
	const out = handlers.before_provider_request[0](
		{ payload: { messages: [{ role: "user", content: "u" }] } },
		CAPABLE,
	) as { messages: Array<Record<string, unknown>> };
	return String(out.messages[0].content);
}

describe("entry assembly", () => {
	test("reads the configuration from the agent-directory override", () => {
		scratchAgentDir();
		const { handlers } = load();
		const out = handlers.before_provider_request[0](
			{ payload: { model: "gpt-5", messages: [{ role: "user", content: "u" }] } },
			CAPABLE,
		) as { messages: Array<Record<string, unknown>> };
		expect(out.messages).toEqual([
			{ role: "system", content: "BLOCK-A" },
			{ role: "user", content: "u" },
		]);
	});

	test("capable model: the tail branch injects, the merge branch is inert", () => {
		scratchAgentDir();
		const { handlers } = load();
		expect(
			handlers.context_with_system[0](
				{ messages: [{ role: "user", content: "u" }] },
				CAPABLE,
			),
		).toBeUndefined();
		expect(block(handlers)).toBe("BLOCK-A");
	});

	test("incapable model: the merge branch appends the block, the tail branch is inert", () => {
		scratchAgentDir();
		const { handlers } = load();
		const out = handlers.context_with_system[0](
			{ messages: [{ role: "user", content: "u" }] },
			INCAPABLE,
		) as { messages: Array<Record<string, unknown>> };
		expect(out.messages).toHaveLength(2);
		expect(out.messages[0]).toEqual({ role: "user", content: "u" });
		expect(out.messages[1]).toEqual({
			role: "system",
			content: "BLOCK-A",
			timestamp: expect.any(Number),
		});
		expect(
			handlers.before_provider_request[0](
				{ payload: { messages: [{ role: "user", content: "u" }] } },
				INCAPABLE,
			),
		).toBeUndefined();
	});

	test("no child-identity splice registration remains", () => {
		scratchAgentDir();
		const { handlers } = load();
		expect(handlers.before_agent_start).toBeUndefined();
	});

	test("no configuration: nothing is delivered on either branch", () => {
		process.env.PI_CODING_AGENT_DIR = scratchDir("tail-prompt-empty-");
		delete process.env.PI_SUBAGENT_CHILD;
		const { handlers } = load();
		expect(
			handlers.before_provider_request[0](
				{ payload: { messages: [{ role: "user", content: "u" }] } },
				CAPABLE,
			),
		).toBeUndefined();
		expect(
			handlers.context_with_system[0](
				{ messages: [{ role: "user", content: "u" }] },
				INCAPABLE,
			),
		).toBeUndefined();
	});
});

describe("segment registration", () => {
	test("emits the ready signal with no payload", () => {
		scratchAgentDir();
		const { bus } = load();
		const ready = bus.emitted.find((e) => e.channel === "tail-prompt:ready");
		expect(ready).toBeDefined();
		expect(ready?.data).toBeUndefined();
	});

	test("a registered text segment is delivered on the next request", () => {
		scratchAgentDir();
		const { handlers, bus } = load();
		bus.emit("tail-prompt:register", {
			id: "x",
			position: 1,
			source: { kind: "text", text: "SEG" },
		});
		expect(block(handlers)).toBe("SEG\n\nBLOCK-A");
	});

	test("re-registering the same identifier replaces it", () => {
		scratchAgentDir();
		const { handlers, bus } = load();
		bus.emit("tail-prompt:register", {
			id: "x",
			position: 1,
			source: { kind: "text", text: "old" },
		});
		bus.emit("tail-prompt:register", {
			id: "x",
			position: 1,
			source: { kind: "text", text: "new" },
		});
		expect(block(handlers)).toBe("new\n\nBLOCK-A");
	});

	test("an invalid registration is dropped, reported once, and interrupts nothing", () => {
		scratchAgentDir();
		const { handlers, bus } = load();
		const bad = { id: "", position: 1, source: { kind: "text", text: "bad" } };
		bus.emit("tail-prompt:register", bad);
		bus.emit("tail-prompt:register", bad);
		expect(block(handlers)).toBe("BLOCK-A");
		expect(bus.errors).toHaveLength(1);
	});

	test("a path segment tracks its file with no further registration", () => {
		scratchAgentDir();
		const { handlers, bus } = load();
		const dir = scratchDir("tail-prompt-seg-");
		const file = path.join(dir, "seg.txt");
		fs.writeFileSync(file, "ONE\n");
		bus.emit("tail-prompt:register", {
			id: "p",
			position: 1,
			source: { kind: "path", path: file },
		});
		expect(block(handlers)).toBe("ONE\n\nBLOCK-A");
		fs.writeFileSync(file, "TWO\n");
		expect(block(handlers)).toBe("TWO\n\nBLOCK-A");
	});
});
