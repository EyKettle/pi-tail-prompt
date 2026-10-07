/**
 * Tail Prompt Extension — entry assembly.
 *
 * Delivers the configured tail block on every provider request through exactly
 * one placement, chosen from the model's declared capability:
 *
 *  - The model declares mid-conversation system messages
 *    (`compat.supportsMidConvoSystemMessages`): the block is inserted into the
 *    final payload adjacent to the latest user turn.
 *  - Otherwise: the block is appended as a request-local system message and Pi
 *    folds it into the leading system prompt.
 *
 * The block never enters the persisted session history. Configuration lives at
 * `<agent dir>/tail-prompt.yaml`, where the agent directory comes from Pi's own
 * `getAgentDir()`. The assembled block is cached by the config file and every
 * prompt file's mtime and size, so a request re-reads nothing until one changes.
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
import { applymentForSession, sessionClass } from "./session.ts";

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

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const configPath = path.join(agentDir, "tail-prompt.yaml");
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

	// Merge branch: the model cannot carry a mid-conversation system message, so
	// append one to the transcript and let Pi fold it into the leading prompt.
	pi.on("context_with_system", (event, ctx) => {
		if (supportsMidConvoSystemMessages(ctx.model)) return;
		const config = getConfig();
		if (!config) return;
		return {
			messages: [
				...event.messages,
				{ role: "system", content: config.block, timestamp: Date.now() },
			],
		};
	});

	// Tail branch: the model carries mid-conversation system messages, so insert
	// the block into the final payload adjacent to the latest user turn.
	pi.on("before_provider_request", (event, ctx) => {
		if (!supportsMidConvoSystemMessages(ctx.model)) return;
		const config = getConfig();
		if (!config) return;
		const payload = event.payload as Record<string, unknown> | undefined;
		if (!payload) return;
		return applyTailToPayload(
			payload,
			config.block,
			config.role,
			modelApi(ctx.model),
		);
	});
}
