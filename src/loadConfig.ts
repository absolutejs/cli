/**
 * Discover + load `absolutejs.config.ts` from the current working
 * directory (or its parents). Falls back to `absolutejs.config.js` /
 * `.mjs` if no .ts variant exists. Bun handles TS imports natively;
 * Node would need a loader.
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AbsolutejsConfig } from './index';

const CONFIG_NAMES = [
	'absolutejs.config.ts',
	'absolutejs.config.mts',
	'absolutejs.config.js',
	'absolutejs.config.mjs'
];

const findConfigPath = (startDir: string): string | undefined => {
	let dir = resolve(startDir);
	for (;;) {
		for (const name of CONFIG_NAMES) {
			const candidate = join(dir, name);
			try {
				if (existsSync(candidate) && statSync(candidate).isFile()) {
					return candidate;
				}
			} catch {
				// keep walking
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
};

export type LoadedConfig = {
	config: AbsolutejsConfig;
	path: string;
};

export const loadConfig = async (
	startDir: string = process.cwd()
): Promise<LoadedConfig> => {
	const path = findConfigPath(startDir);
	if (path === undefined) {
		throw new Error(
			`[absolutejs] no config file found.\n` +
				`Looked for: ${CONFIG_NAMES.join(', ')} (walked up from ${startDir})\n\n` +
				`Create an absolutejs.config.ts with:\n\n` +
				`  import { defineConfig } from '@absolutejs/cli';\n` +
				`  export default defineConfig({\n` +
				`    secrets: /* your SecretBroker */,\n` +
				`    deployments: [],\n` +
				`  });`
		);
	}
	let mod: unknown;
	try {
		mod = await import(path);
	} catch (error) {
		throw new Error(
			`[absolutejs] failed to load ${path}: ${
				error instanceof Error ? error.message : String(error)
			}`
		);
	}
	const config = (mod as { default?: AbsolutejsConfig }).default;
	if (config === undefined || typeof config !== 'object') {
		throw new Error(
			`[absolutejs] ${path} must \`export default defineConfig({...})\``
		);
	}
	return { config, path };
};
