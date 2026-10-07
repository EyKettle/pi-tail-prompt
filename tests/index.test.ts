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

function capture() {
	const handlers: Record<string, Handler[]> = {};
	const pi = {
		on(event: string, handler: Handler) {
			(handlers[event] ??= []).push(handler);
			return () => {};
		},
	};
	return { pi, handlers };
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

/** A scratch agent dir holding a config whose block is "BLOCK-A". */
function scratchAgentDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tail-prompt-agent-"));
	created.push(dir);
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
	const { pi, handlers } = capture();
	factory(pi as unknown as ExtensionAPI);
	return handlers;
}

describe("entry assembly", () => {
	test("reads the configuration from the agent-directory override", () => {
		scratchAgentDir();
		const handlers = load();
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
		const handlers = load();
		expect(
			handlers.context_with_system[0](
				{ messages: [{ role: "user", content: "u" }] },
				CAPABLE,
			),
		).toBeUndefined();
		const out = handlers.before_provider_request[0](
			{ payload: { messages: [{ role: "user", content: "u" }] } },
			CAPABLE,
		) as { messages: Array<Record<string, unknown>> };
		expect(out.messages[0]).toEqual({ role: "system", content: "BLOCK-A" });
	});

	test("incapable model: the merge branch appends the block, the tail branch is inert", () => {
		scratchAgentDir();
		const handlers = load();
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
		const handlers = load();
		expect(handlers.before_agent_start).toBeUndefined();
	});

	test("no configuration: nothing is delivered on either branch", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tail-prompt-empty-"));
		created.push(dir);
		process.env.PI_CODING_AGENT_DIR = dir;
		delete process.env.PI_SUBAGENT_CHILD;
		const handlers = load();
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
