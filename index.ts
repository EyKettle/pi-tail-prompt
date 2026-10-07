/**
 * Tail Prompt Extension — entry assembly.
 *
 * Delivers the assembled tail block on every provider request through exactly
 * one placement, chosen from the model's declared capability:
 *
 *  - The model declares mid-conversation system messages
 *    (`compat.supportsMidConvoSystemMessages`): the block is inserted into the
 *    final payload adjacent to the latest user turn.
 *  - Otherwise: the block is appended as a request-local system message and Pi
 *    folds it into the leading system prompt.
 *
 * The block is assembled from ordered segments (segments.ts): tail-prompt's own
 * configured prompts at position 0, plus every segment another extension
 * registers through the published contract (docs_zh-CN/api.md) on `pi.events`.
 * The block never enters the persisted session history. Configuration lives at
 * `<agent dir>/tail-prompt.yaml`, where the agent directory comes from Pi's own
 * `getAgentDir()`; the assembled block is cached by the config and prompt files'
 * mtime and size.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { readConfig } from "./config.ts";
import { applyTailToPayload } from "./payload.ts";
import { loadPrompts, resolvePromptPaths } from "./prompts.ts";
import { SegmentRegistry, validateSegment, type Segment } from "./segments.ts";
import { applymentForSession, sessionClass } from "./session.ts";

const CONFIG_SEGMENT_ID = "tail-prompt";
const CONFIG_POSITION = 0;
const REGISTER_CHANNEL = "tail-prompt:register";
const READY_CHANNEL = "tail-prompt:ready";

interface TailConfig {
	role: "system" | "user";
	block: string;
}

interface ModelView {
	compat?: unknown;
	api?: unknown;
}

function supportsMidConvoSystemMessages(model: ModelView | undefined): boolean {
	const compat = model?.compat as
		| { supportsMidConvoSystemMessages?: boolean }
		| undefined;
	return compat?.supportsMidConvoSystemMessages === true;
}

function modelApi(model: ModelView | undefined): string | undefined {
	return model?.api === undefined ? undefined : String(model.api);
}

function fileStamp(filePath: string): string {
	try {
		const st = fs.statSync(filePath);
		return `${st.mtimeMs}:${st.size}`;
	} catch {
		return "missing";
	}
}

function fingerprint(raw: unknown): string {
	try {
		return JSON.stringify(raw);
	} catch {
		return String(raw);
	}
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const configPath = path.join(agentDir, "tail-prompt.yaml");
	const registry = new SegmentRegistry();
	const rejected = new Set<string>();

	pi.events.on(REGISTER_CHANNEL, (raw) => {
		const segment = validateSegment(raw);
		if (segment) {
			registry.register(segment);
			return;
		}
		const key = fingerprint(raw);
		if (rejected.has(key)) return;
		rejected.add(key);
		throw new Error(`tail-prompt: rejected registration ${key}`);
	});

	// A contributor that loaded before this extension missed its own emit; the
	// ready signal asks it to re-send, so either load order takes effect.
	pi.events.emit(READY_CHANNEL, undefined);

	let cache: { key: string; config: TailConfig | null } | null = null;

	const getConfig = (): TailConfig | null => {
		const parsed = readConfig(configPath);
		if (!parsed) {
			cache = null;
			return null;
		}
		const names = applymentForSession(parsed, sessionClass());
		if (!names) {
			cache = null;
			return null;
		}
		const paths = resolvePromptPaths(names, parsed.imports, agentDir);
		if (!paths) {
			cache = null;
			return null;
		}
		const key = [configPath, ...paths].map(fileStamp).join("|");
		if (cache && cache.key === key) return cache.config;
		const prompts = loadPrompts(paths);
		const config = prompts
			? { role: parsed.role, block: prompts.join("\n\n") }
			: null;
		cache = { key, config };
		return config;
	};

	const build = (): { block: string; role: "system" | "user" } | null => {
		const config = getConfig();
		if (!config) return null;
		const configSegment: Segment = {
			id: CONFIG_SEGMENT_ID,
			position: CONFIG_POSITION,
			source: { kind: "text", text: config.block },
		};
		const block = registry.assemble([configSegment]);
		if (block === null) return null;
		return { block, role: config.role };
	};

	// Merge branch: the model cannot carry a mid-conversation system message, so
	// append one to the transcript and let Pi fold it into the leading prompt.
	pi.on("context_with_system", (event, ctx) => {
		if (supportsMidConvoSystemMessages(ctx.model)) return;
		const built = build();
		if (!built) return;
		return {
			messages: [
				...event.messages,
				{ role: "system", content: built.block, timestamp: Date.now() },
			],
		};
	});

	// Tail branch: the model carries mid-conversation system messages, so insert
	// the block into the final payload adjacent to the latest user turn.
	pi.on("before_provider_request", (event, ctx) => {
		if (!supportsMidConvoSystemMessages(ctx.model)) return;
		const built = build();
		if (!built) return;
		const payload = event.payload as Record<string, unknown> | undefined;
		if (!payload) return;
		return applyTailToPayload(
			payload,
			built.block,
			built.role,
			modelApi(ctx.model),
		);
	});
}
