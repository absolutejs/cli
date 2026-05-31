/**
 * `absolutejs secrets <verb>` — broker-level secret management.
 *
 * Verbs:
 *   list                       — print known secret names + fingerprints
 *   get <name>                 — print one value (requires --show)
 *   set <name>=<value>         — put a value via the adapter
 *   rotate <name>              — broker.rotate(name)
 *
 * Most verbs need a broker; `list`/`set` also need an adapter to
 * read/write the underlying store. The CLI prints clear errors when
 * the config doesn't provide what a verb needs.
 */

import type { AbsolutejsConfig } from '../index';
import {
	renderTable,
	writeErr,
	writeJson,
	writeOut,
	type OutputMode
} from '../utils/output';

export type SecretsArgs = {
	verb: string;
	positional: string[];
	flags: Record<string, string | boolean>;
};

const requireBroker = (config: AbsolutejsConfig) => {
	if (config.secrets === undefined) {
		throw new Error(
			'config.secrets is not set — `secrets` verbs need a SecretBroker'
		);
	}
	return config.secrets;
};

const requireAdapter = (config: AbsolutejsConfig) => {
	if (config.secretAdapter === undefined) {
		throw new Error(
			'config.secretAdapter is not set — pass the SecretAdapter you used to build the broker'
		);
	}
	return config.secretAdapter;
};

export const runSecrets = async (
	config: AbsolutejsConfig,
	args: SecretsArgs,
	mode: OutputMode
): Promise<number> => {
	const { verb, positional, flags } = args;

	switch (verb) {
		case 'list': {
			const adapter = requireAdapter(config);
			const broker = requireBroker(config);
			if (adapter.list === undefined) {
				throw new Error(
					'the configured SecretAdapter does not implement `list()`'
				);
			}
			const names = await adapter.list();
			const rows: string[][] = [];
			for (const name of names.sort()) {
				const value = await adapter.fetch(name);
				const fingerprint =
					value === null ? '(empty)' : broker.fingerprint(value);
				rows.push([name, fingerprint]);
			}
			if (mode === 'json') {
				writeJson(
					rows.map(([name, fingerprint]) => ({ fingerprint, name }))
				);
			} else {
				writeOut(renderTable(['name', 'fingerprint'], rows));
			}
			return 0;
		}

		case 'get': {
			const broker = requireBroker(config);
			const name = positional[0];
			if (name === undefined) {
				throw new Error('usage: secrets get <name> [--show]');
			}
			const resolved = await broker.resolve(name);
			if (resolved === null) {
				writeErr(`(no value for ${name})`);
				return 2;
			}
			if (mode === 'json') {
				writeJson({
					fingerprint: resolved.fingerprint,
					name,
					value: flags.show === true ? resolved.value : '(redacted; pass --show)'
				});
			} else if (flags.show === true) {
				writeOut(resolved.value);
			} else {
				writeOut(
					`${name}: fingerprint=${resolved.fingerprint} (pass --show to print plaintext)`
				);
			}
			return 0;
		}

		case 'set': {
			const adapter = requireAdapter(config);
			if (adapter.put === undefined) {
				throw new Error(
					'the configured SecretAdapter does not implement `put()`'
				);
			}
			const pair = positional[0];
			if (pair === undefined) {
				throw new Error('usage: secrets set <NAME>=<value>');
			}
			const eq = pair.indexOf('=');
			if (eq <= 0) {
				throw new Error(
					'usage: secrets set <NAME>=<value> (missing `=`)'
				);
			}
			const name = pair.slice(0, eq);
			const value = pair.slice(eq + 1);
			await adapter.put(name, value);
			if (mode === 'json') {
				writeJson({ name, set: true });
			} else {
				writeOut(`set ${name}`);
			}
			return 0;
		}

		case 'rotate': {
			const broker = requireBroker(config);
			const name = positional[0];
			if (name === undefined) {
				throw new Error('usage: secrets rotate <name>');
			}
			const rotated = await broker.rotate(name);
			if (mode === 'json') {
				writeJson({
					fingerprint: rotated.fingerprint,
					name,
					rotated: true
				});
			} else {
				writeOut(`rotated ${name} (new fingerprint: ${rotated.fingerprint})`);
			}
			return 0;
		}

		default:
			throw new Error(
				`unknown secrets verb: "${verb}". try: list | get | set | rotate`
			);
	}
};
