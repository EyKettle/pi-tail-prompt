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

import factory, {
	blockKey,
	configSegment,
	createBlockLoader,
	usesMergeBranch,
} from "../index.ts";

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

const CAPABLE = { model: { compat: { supportsMidConvoSystemMessages: true } }, hasUI: false };
const INCAPABLE = { model: { compat: { supportsMidConvoSystemMessages: false } }, hasUI: false };
const DEVELOPER = {
	model: {
		api: "openai-completions",
		reasoning: true,
		compat: {
			supportsMidConvoSystemMessages: true,
			supportsDeveloperRole: true,
		},
	},
	hasUI: false,
};

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

/** Run the `before_agent_start` handler and return the prompt options it saw. */
function promptOptions(
	handlers: Record<string, Handler[]>,
	model: Record<string, unknown>,
	initial = "",
): { appendSystemPrompt: string } {
	const options = { appendSystemPrompt: initial };
	handlers.before_agent_start[0](
		{ systemPrompt: "", systemPromptOptions: options },
		{ model, hasUI: false },
	);
	return options;
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
		expect(promptOptions(handlers, CAPABLE.model).appendSystemPrompt).toBe(
			"",
		);
		expect(block(handlers)).toBe("BLOCK-A");
	});

	test("incapable model: the merge branch appends the block, the tail branch is inert", () => {
		scratchAgentDir();
		const { handlers } = load();
		expect(
			promptOptions(handlers, INCAPABLE.model).appendSystemPrompt,
		).toBe("BLOCK-A");
		expect(
			handlers.before_provider_request[0](
				{ payload: { messages: [{ role: "user", content: "u" }] } },
				INCAPABLE,
			),
		).toBeUndefined();
	});

	test("a reasoning OpenAI model: the tail block takes the developer identity", () => {
		scratchAgentDir();
		const { handlers } = load();
		const out = handlers.before_provider_request[0](
			{
				payload: {
					messages: [
						{ role: "system", content: "S" },
						{ role: "user", content: "u" },
					],
				},
			},
			DEVELOPER,
		) as { messages: Array<Record<string, unknown>> };
		expect(out.messages).toEqual([
			{ role: "system", content: "S" },
			{ role: "developer", content: "BLOCK-A" },
			{ role: "user", content: "u" },
		]);
	});

	test("the merge branch appends after an existing append-system prompt", () => {
		scratchAgentDir();
		const { handlers } = load();
		expect(
			promptOptions(handlers, INCAPABLE.model, "BASE").appendSystemPrompt,
		).toBe("BASE\n\nBLOCK-A");
	});

	test("reports a present config that yields no block, once", () => {
		const dir = scratchDir("tail-prompt-broken-");
		fs.writeFileSync(
			path.join(dir, "tail-prompt.yaml"),
			["role: system", "applyment:", "  - missing", ""].join("\n"),
		);
		process.env.PI_CODING_AGENT_DIR = dir;
		delete process.env.PI_SUBAGENT_CHILD;
		const { handlers } = load();
		const notices: string[] = [];
		const ctx = {
			...CAPABLE,
			hasUI: true,
			ui: { notify: (message: string) => notices.push(message) },
		};
		const call = () =>
			handlers.before_provider_request[0](
				{ payload: { messages: [{ role: "user", content: "u" }] } },
				ctx,
			);
		call();
		call();
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("missing");
	});

	test("a missing configuration file is not reported", () => {
		process.env.PI_CODING_AGENT_DIR = scratchDir("tail-prompt-none-");
		delete process.env.PI_SUBAGENT_CHILD;
		const { handlers } = load();
		const notices: string[] = [];
		handlers.before_provider_request[0](
			{ payload: { messages: [{ role: "user", content: "u" }] } },
			{
				...CAPABLE,
				hasUI: true,
				ui: { notify: (message: string) => notices.push(message) },
			},
		);
		expect(notices).toHaveLength(0);
	});

	test("a subagent session uses the child applyment profile", () => {
		const dir = scratchDir("tail-prompt-subagent-");
		fs.mkdirSync(path.join(dir, "system-prompts"));
		fs.writeFileSync(path.join(dir, "system-prompts", "main.txt"), "MAIN\n");
		fs.writeFileSync(path.join(dir, "system-prompts", "child.txt"), "CHILD\n");
		fs.writeFileSync(
			path.join(dir, "tail-prompt.yaml"),
			[
				"role: system",
				"imports:",
				"  main: system-prompts/main.txt",
				"  child: system-prompts/child.txt",
				"applyment:",
				"  - main",
				"profiles:",
				"  subagent:",
				"    applyment:",
				"      - child",
				"",
			].join("\n"),
		);
		process.env.PI_CODING_AGENT_DIR = dir;
		process.env.PI_SUBAGENT_CHILD = "1";
		const { handlers } = load();
		expect(block(handlers)).toBe("CHILD");
	});

	test("the merge branch uses the prompt path, not a transcript message", () => {
		scratchAgentDir();
		const { handlers } = load();
		// The block must reach the model through the prompt path, not as a
		// transcript message the provider layer would drop.
		expect(handlers.context_with_system).toBeUndefined();
		expect(handlers.before_agent_start).toBeDefined();
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
		expect(promptOptions(handlers, INCAPABLE.model).appendSystemPrompt).toBe(
			"",
		);
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
			source: { kind: "text", text: "SEG" },
		});
		bus.emit("tail-prompt:register", {
			id: "x",
			position: 1,
			source: { kind: "text", text: "SEG2" },
		});
		expect(block(handlers)).toBe("SEG2\n\nBLOCK-A");
	});

	test("an invalid registration is dropped, reported once, and interrupts nothing", () => {
		scratchAgentDir();
		const { handlers, bus } = load();
		const bad = { id: "", position: 1, source: { kind: "text", text: "bad" } };
		bus.emit("tail-prompt:register", bad);
		bus.emit("tail-prompt:register", bad);
		const notices: string[] = [];
		const ctx = {
			...CAPABLE,
			hasUI: true,
			ui: { notify: (message: string) => notices.push(message) },
		};
		const call = () =>
			handlers.before_provider_request[0](
				{ payload: { messages: [{ role: "user", content: "u" }] } },
				ctx,
			);
		expect(block(handlers)).toBe("BLOCK-A");
		call();
		call();
		expect(notices).toHaveLength(1);
	});

	test("a path segment tracks its file with no further registration", () => {
		const dir = scratchDir("tail-prompt-seg-");
		fs.mkdirSync(path.join(dir, "system-prompts"));
		fs.writeFileSync(path.join(dir, "system-prompts", "a.txt"), "BLOCK-A\n");
		fs.writeFileSync(path.join(dir, "seg.txt"), "SEG\n");
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
		const { handlers, bus } = load();
		bus.emit("tail-prompt:register", {
			id: "p",
			position: 1,
			source: { kind: "path", path: path.join(dir, "seg.txt") },
		});
		expect(block(handlers)).toBe("SEG\n\nBLOCK-A");
		fs.writeFileSync(path.join(dir, "seg.txt"), "SEG-EDITED\n");
		expect(block(handlers)).toBe("SEG-EDITED\n\nBLOCK-A");
	});
});

describe("registration load order", () => {
	test("a contributor that loaded first registers through the ready signal", () => {
		scratchAgentDir();
		const { pi, handlers, bus } = capture();
		// The contributor emits before tail-prompt subscribes, so the ready
		// signal is its only route to registration.
		const registration = {
			id: "early",
			position: 1,
			source: { kind: "text", text: "EARLY" },
		};
		bus.emit("tail-prompt:register", registration);
		bus.on("tail-prompt:ready", () => {
			bus.emit("tail-prompt:register", registration);
		});
		factory(pi as unknown as ExtensionAPI);
		expect(block(handlers)).toBe("EARLY\n\nBLOCK-A");
	});
});

describe("block loader cache", () => {
	test("the cache key covers the config stamp and every prompt stamp", () => {
		const stamps: Record<string, string> = { cfg: "c1", "/a": "p1", "/b": "p2" };
		const key = blockKey(
			"c1",
			["/a", "/b"],
			(file) => stamps[file] ?? "missing",
		);
		expect(key).toBe("c1|p1|p2");
	});

	test("a prompt-level failure re-evaluates when the prompt file changes", () => {
		let reads = 0;
		let promptStamp = "p1";
		const loader = createBlockLoader(
			{
				readConfig: () => ({
					parsed: {
						role: "system",
						imports: { a: "/a" },
						applyment: ["a"],
						subagentApplyment: undefined,
					},
					stamp: "c1",
					error: null,
				}),
				session: () => "main",
				applyment: () => ["a"],
				resolvePaths: () => ({ value: ["/a"] }),
				readPrompts: () => {
					reads += 1;
					return reads === 1
						? { failure: { kind: "unreadable-prompt", path: "/a" } }
						: { value: ["BODY"] };
				},
				fileStamp: () => promptStamp,
			},
			"/agent",
		);
		expect(loader()).toEqual({
			config: null,
			failure: { kind: "unreadable-prompt", path: "/a" },
		});
		promptStamp = "p2";
		expect(loader()).toEqual({
			config: { role: "system", block: "BODY" },
			failure: null,
		});
		expect(reads).toBe(2);
	});

	test("the configured prompts are the position-zero segment", () => {
		const segment = configSegment("BODY");
		expect(segment).toEqual({
			id: "tail-prompt",
			position: 0,
			source: { kind: "text", text: "BODY" },
		});
	});
});

describe("merge-branch predicate", () => {
	test("merges only for a system block the model cannot carry mid-conversation", () => {
		expect(usesMergeBranch(true, "system")).toBe(false);
		expect(usesMergeBranch(true, "user")).toBe(false);
		expect(usesMergeBranch(false, "system")).toBe(true);
		expect(usesMergeBranch(false, "user")).toBe(false);
	});
});

describe("role: user on a model without mid-conversation support", () => {
	function roleUserAgentDir(): string {
		const dir = scratchDir("tail-prompt-role-user-");
		fs.mkdirSync(path.join(dir, "system-prompts"));
		fs.writeFileSync(path.join(dir, "system-prompts", "a.txt"), "BLOCK-A\n");
		fs.writeFileSync(
			path.join(dir, "tail-prompt.yaml"),
			[
				"role: user",
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

	test("non-Anthropic: the block is tail-inserted", () => {
		roleUserAgentDir();
		const { handlers } = load();
		const out = handlers.before_provider_request[0](
			{ payload: { messages: [{ role: "user", content: "u" }] } },
			INCAPABLE,
		) as { messages: Array<Record<string, unknown>> };
		expect(out.messages).toEqual([
			{ role: "user", content: "BLOCK-A" },
			{ role: "user", content: "u" },
		]);
	});

	test("Anthropic protocol: the tail branch owns it, before the latest user", () => {
		roleUserAgentDir();
		const { handlers } = load();
		const ctx = {
			model: {
				compat: { supportsMidConvoSystemMessages: false },
				api: "anthropic-messages",
			},
			hasUI: false,
		};
		// A user block is legal at the tail, so the merge branch stays inert.
		expect(promptOptions(handlers, ctx.model).appendSystemPrompt).toBe("");
		const out = handlers.before_provider_request[0](
			{ payload: { messages: [{ role: "user", content: "u" }] } },
			ctx,
		) as { messages: Array<Record<string, unknown>> };
		expect(out.messages).toEqual([
			{ role: "user", content: "BLOCK-A" },
			{ role: "user", content: "u" },
		]);
	});
});

describe("shape-independent fallback", () => {
	test("a payload with neither messages nor input still receives the block", () => {
		scratchAgentDir();
		const { handlers } = load();
		const out = handlers.before_provider_request[0](
			{ payload: { model: "x", system: "LEAD" } },
			CAPABLE,
		) as { system: string };
		expect(out.system).toBe("LEAD\n\nBLOCK-A");
	});

	test("no leading system content: the request is reported instead", () => {
		scratchAgentDir();
		const { handlers } = load();
		const notices: string[] = [];
		handlers.before_provider_request[0](
			{ payload: { model: "x" } },
			{
				...CAPABLE,
				hasUI: true,
				ui: { notify: (message: string) => notices.push(message) },
			},
		);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("no leading system");
	});
});

describe("one placement per request", () => {
	test("merge configuration: the block appears exactly once after folding", () => {
		scratchAgentDir();
		const { handlers } = load();
		const transcript = [
			{ role: "system", content: "S" },
			{ role: "user", content: "u" },
		];
		// 1) The prompt path carries the block for a model without
		// mid-conversation system support.
		const options = { appendSystemPrompt: "" };
		handlers.before_agent_start[0](
			{ systemPrompt: "", systemPromptOptions: options },
			INCAPABLE,
		);
		expect(options.appendSystemPrompt).toBe("BLOCK-A");
		// 2) The payload hook must leave such a payload untouched: the merge
		// configuration already delivered the block through the prompt.
		const payload = {
			model: "gpt-5",
			messages: [
				{ role: "system", content: `S\n\n${options.appendSystemPrompt}` },
				...transcript.filter((m) => m.role !== "system"),
			],
		};
		expect(
			handlers.before_provider_request[0]({ payload }, INCAPABLE),
		).toBeUndefined();
		// 3) The block appears exactly once in the leading prompt.
		const leading = String(payload.messages[0].content);
		expect(leading.split("BLOCK-A").length - 1).toBe(1);
	});
});
