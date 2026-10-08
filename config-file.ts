/**
 * Config file reading — the file's stamp, and a reader that re-parses the file
 * only when that stamp changes. One reader per extension runtime, so the cache
 * never outlives the factory that owns it.
 */

import * as fs from "node:fs";
import { parseConfig, type ParsedTailYaml } from "./config.ts";

/** The `mtime:size` stamp of a file, or `"missing"` when it cannot be stat'ed. */
export function fileStamp(filePath: string): string {
	try {
		const st = fs.statSync(filePath);
		return `${st.mtimeMs}:${st.size}`;
	} catch {
		return "missing";
	}
}

export type ConfigRead = {
	parsed: ParsedTailYaml | null;
	stamp: string;
	/** The parse error when the file exists but cannot be parsed. */
	error: string | null;
};

/** A reader that parses the config file only when its stamp changes. */
export function createConfigReader(configPath: string): () => ConfigRead {
	let cache: ConfigRead | null = null;
	return () => {
		const stamp = fileStamp(configPath);
		if (cache && cache.stamp === stamp) return cache;
		let parsed: ParsedTailYaml | null = null;
		let error: string | null = null;
		if (stamp !== "missing") {
			try {
				parsed = parseConfig(fs.readFileSync(configPath, "utf-8"));
			} catch (cause) {
				error = cause instanceof Error ? cause.message : String(cause);
				console.error(`tail-prompt: config load failed: ${error}`);
			}
		}
		cache = { parsed, stamp, error };
		return cache;
	};
}
