/**
 * `absolutejs env <verb>` — env-file management against the remote
 * target for a deployment.
 *
 * Verbs:
 *   push <stage>              — resolve secrets + extras, atomic write
 *   pull <stage>              — read the remote env file as-is
 *   diff <stage>              — show diff between remote and what `push` would write
 *
 * Each verb resolves the deployment's lazy `target()` factory, so a
 * `secrets list` call doesn't accidentally provision a Hetzner box.
 */

import type { AbsolutejsConfig, CliDeployment } from '../index';
import {
	renderTable,
	writeErr,
	writeJson,
	writeOut,
	type OutputMode
} from '../utils/output';

export type EnvArgs = {
	verb: string;
	positional: string[];
	flags: Record<string, string | boolean>;
};

const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const NEEDS_QUOTING = /[\s"'`$\\#&|;<>(){}*?!]/;

const validateKey = (key: string): void => {
	if (!KEY_PATTERN.test(key)) {
		throw new Error(`invalid env key "${key}" — must match /^[A-Z_][A-Z0-9_]*$/`);
	}
};

const serializeLine = (key: string, value: string): string => {
	validateKey(key);
	if (value.includes('\n') || value.includes('\r')) {
		throw new Error(
			`value for "${key}" contains a newline — env files cannot represent multi-line values`
		);
	}
	if (NEEDS_QUOTING.test(value) || value.startsWith('=') || value === '') {
		const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
		return `${key}="${escaped}"`;
	}
	return `${key}=${value}`;
};

const serializeEnvFile = (values: Record<string, string>): string => {
	const lines: string[] = [];
	for (const key of Object.keys(values).sort()) {
		const value = values[key];
		if (value === undefined) continue;
		lines.push(serializeLine(key, value));
	}
	return `${lines.join('\n')}\n`;
};

const unquoteValue = (raw: string): string => {
	if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
		return raw.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\');
	}
	if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
		return raw.slice(1, -1);
	}
	return raw;
};

const parseEnvFile = (text: string): Record<string, string> => {
	const result: Record<string, string> = {};
	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq <= 0) continue; // tolerate stray malformed lines on `pull`
		const key = line.slice(0, eq).trim();
		const value = unquoteValue(line.slice(eq + 1).trim());
		if (KEY_PATTERN.test(key)) result[key] = value;
	}
	return result;
};

const findDeployment = (
	config: AbsolutejsConfig,
	stage: string
): CliDeployment => {
	const match = (config.deployments ?? []).find((d) => d.name === stage);
	if (match === undefined) {
		const names = (config.deployments ?? []).map((d) => d.name);
		throw new Error(
			`unknown deployment "${stage}". configured: ${names.length > 0 ? names.join(', ') : '(none)'}`
		);
	}
	return match;
};

const resolveValuesForDeployment = async (
	config: AbsolutejsConfig,
	deployment: CliDeployment
): Promise<Record<string, string>> => {
	const merged: Record<string, string> = {};
	for (const [key, value] of Object.entries(deployment.extras ?? {})) {
		validateKey(key);
		merged[key] = value;
	}
	if ((deployment.secretNames ?? []).length > 0) {
		if (config.secrets === undefined) {
			throw new Error(
				`deployment "${deployment.name}" declares secretNames but config.secrets is not set`
			);
		}
		for (const name of deployment.secretNames ?? []) {
			const resolved = await config.secrets.resolve(name);
			if (resolved === null) {
				throw new Error(
					`secret "${name}" not found in broker (deployment: ${deployment.name})`
				);
			}
			if (merged[name] !== undefined) {
				throw new Error(
					`"${name}" defined in BOTH extras and secretNames for ${deployment.name}`
				);
			}
			merged[name] = resolved.value;
		}
	}
	return merged;
};

const shellQuote = (value: string): string =>
	`'${value.replaceAll("'", "'\\''")}'`;

const readRemoteFile = async (
	deployment: CliDeployment
): Promise<string | undefined> => {
	const target = await deployment.target();
	const sentinel = '__ABS_DEPLOY_ENV_ABSENT__';
	const result = await target.exec(
		`if [ -f ${shellQuote(deployment.remotePath)} ]; then cat ${shellQuote(
			deployment.remotePath
		)}; else echo ${sentinel}; fi`
	);
	if (result.exitCode !== 0) {
		throw new Error(
			`failed to read ${deployment.remotePath}: exit ${result.exitCode}: ${result.stderr || result.stdout}`
		);
	}
	if (result.stdout.trim() === sentinel) return undefined;
	return result.stdout;
};

const writeRemoteFile = async (
	deployment: CliDeployment,
	contents: string
): Promise<void> => {
	const target = await deployment.target();
	const tempPath = `${deployment.remotePath}.new.${Math.floor(Date.now() / 1000)}`;
	const dir = deployment.remotePath.split('/').slice(0, -1).join('/') || '/';
	const mkdir = await target.exec(`mkdir -p ${shellQuote(dir)}`);
	if (mkdir.exitCode !== 0) {
		throw new Error(`mkdir ${dir} failed: ${mkdir.stderr || mkdir.stdout}`);
	}
	const write = await target.exec(`cat > ${shellQuote(tempPath)}`, {
		stdin: contents
	});
	if (write.exitCode !== 0) {
		throw new Error(`write to ${tempPath} failed: ${write.stderr || write.stdout}`);
	}
	const mode = deployment.mode ?? '600';
	const chmod = await target.exec(
		`chmod ${shellQuote(mode)} ${shellQuote(tempPath)}`
	);
	if (chmod.exitCode !== 0) {
		throw new Error(`chmod failed: ${chmod.stderr || chmod.stdout}`);
	}
	if (deployment.owner !== undefined) {
		const chown = await target.exec(
			`chown ${shellQuote(deployment.owner)} ${shellQuote(tempPath)}`
		);
		if (chown.exitCode !== 0) {
			throw new Error(`chown failed: ${chown.stderr || chown.stdout}`);
		}
	}
	const mv = await target.exec(
		`mv ${shellQuote(tempPath)} ${shellQuote(deployment.remotePath)}`
	);
	if (mv.exitCode !== 0) {
		throw new Error(`mv failed: ${mv.stderr || mv.stdout}`);
	}
	if (deployment.reload !== undefined) {
		const reload = await target.exec(deployment.reload);
		if (reload.exitCode !== 0) {
			throw new Error(
				`reload command failed: ${reload.stderr || reload.stdout}`
			);
		}
	}
};

export const runEnv = async (
	config: AbsolutejsConfig,
	args: EnvArgs,
	mode: OutputMode
): Promise<number> => {
	const { verb, positional, flags } = args;
	const stage = positional[0];
	if (stage === undefined) {
		throw new Error(`usage: env ${verb} <stage>`);
	}
	const deployment = findDeployment(config, stage);

	switch (verb) {
		case 'pull': {
			const remoteText = await readRemoteFile(deployment);
			if (remoteText === undefined) {
				if (mode === 'json') writeJson({ exists: false });
				else writeErr(`(no env file at ${deployment.remotePath})`);
				return 2;
			}
			if (mode === 'json') {
				writeJson({
					exists: true,
					path: deployment.remotePath,
					values: parseEnvFile(remoteText)
				});
			} else {
				writeOut(remoteText);
			}
			return 0;
		}

		case 'push': {
			const resolved = await resolveValuesForDeployment(config, deployment);
			const next = serializeEnvFile(resolved);
			await writeRemoteFile(deployment, next);
			const message = `pushed ${Object.keys(resolved).length} keys to ${stage}:${deployment.remotePath}`;
			if (mode === 'json') {
				writeJson({
					keys: Object.keys(resolved).sort(),
					path: deployment.remotePath,
					pushed: true,
					stage
				});
			} else {
				writeOut(message);
			}
			return 0;
		}

		case 'diff': {
			const remoteText = await readRemoteFile(deployment);
			const remote = remoteText === undefined ? {} : parseEnvFile(remoteText);
			const next = await resolveValuesForDeployment(config, deployment);
			const allKeys = [
				...new Set([...Object.keys(remote), ...Object.keys(next)])
			].sort();
			type DiffRow = { key: string; status: string; detail: string };
			const rows: DiffRow[] = [];
			for (const key of allKeys) {
				const before = remote[key];
				const after = next[key];
				if (before === undefined) {
					rows.push({
						detail: '(new)',
						key,
						status: 'added'
					});
				} else if (after === undefined) {
					rows.push({
						detail: '(removed)',
						key,
						status: 'removed'
					});
				} else if (before === after) {
					if (flags.all === true) {
						rows.push({ detail: '(unchanged)', key, status: 'same' });
					}
				} else {
					rows.push({
						detail: `before ≠ after`,
						key,
						status: 'changed'
					});
				}
			}
			if (mode === 'json') {
				writeJson({ diff: rows, stage });
			} else {
				if (rows.length === 0) {
					writeOut(`no differences (${allKeys.length} keys match)`);
				} else {
					writeOut(
						renderTable(
							['key', 'status', 'detail'],
							rows.map((r) => [r.key, r.status, r.detail])
						)
					);
				}
			}
			return 0;
		}

		default:
			throw new Error(
				`unknown env verb: "${verb}". try: pull | push | diff`
			);
	}
};
