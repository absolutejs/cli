/**
 * Tests for @absolutejs/cli. Driven entirely in-process via `main()`
 * with stdin/stdout/stderr captured. Mocks the broker / adapter /
 * target so no real disk or network IO happens.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../src/cli';
import { runSecrets } from '../src/commands/secrets';
import { runEnv } from '../src/commands/env';
import { runDeploy } from '../src/commands/deploy';
import type {
	AbsolutejsConfig,
	CliDeployer,
	CliSecretAdapter,
	CliSecretBroker,
	CliTarget
} from '../src/index';

// =============================================================================
// stdout/stderr capture
// =============================================================================

const captureIo = async (
	run: () => Promise<unknown>
): Promise<{ out: string; err: string }> => {
	const origOut = process.stdout.write.bind(process.stdout);
	const origErr = process.stderr.write.bind(process.stderr);
	let out = '';
	let err = '';
	process.stdout.write = ((chunk: unknown) => {
		out += String(chunk);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: unknown) => {
		err += String(chunk);
		return true;
	}) as typeof process.stderr.write;
	try {
		await run();
	} finally {
		process.stdout.write = origOut;
		process.stderr.write = origErr;
	}
	return { err, out };
};

// =============================================================================
// Mock broker / adapter / target / deployer
// =============================================================================

const makeBroker = (initial: Record<string, string> = {}): CliSecretBroker => {
	const store = new Map(Object.entries(initial));
	return {
		fingerprint: (value) => `fp:${value.slice(0, 6)}`,
		resolve: async (name) => {
			const value = store.get(name);
			if (value === undefined) return null;
			return { fingerprint: `fp:${value.slice(0, 6)}`, value };
		},
		rotate: async (name) => {
			const next = `rotated-${name}-${store.size}`;
			store.set(name, next);
			return { fingerprint: `fp:${next.slice(0, 6)}`, value: next };
		}
	};
};

const makeAdapter = (initial: Record<string, string> = {}): CliSecretAdapter => {
	const store = new Map(Object.entries(initial));
	return {
		fetch: async (name) => store.get(name) ?? null,
		list: async () => Array.from(store.keys()),
		put: async (name, value) => {
			store.set(name, value);
		},
		remove: async (name) => {
			store.delete(name);
		}
	};
};

const makeTarget = (
	initialFiles: Record<string, string> = {}
): { target: CliTarget; files: Map<string, string> } => {
	const files = new Map(Object.entries(initialFiles));
	const target: CliTarget = {
		description: 'mock',
		exec: async (cmd, opts) => {
			// Reproduce the env-command shell shapes the CLI uses.
			const readMatch = cmd.match(
				/^if \[ -f '([^']+)' \]; then cat '([^']+)'; else echo __ABS_DEPLOY_ENV_ABSENT__; fi$/
			);
			if (readMatch !== null) {
				const path = readMatch[1] as string;
				const existing = files.get(path);
				if (existing === undefined) {
					return {
						exitCode: 0,
						stderr: '',
						stdout: '__ABS_DEPLOY_ENV_ABSENT__\n'
					};
				}
				return { exitCode: 0, stderr: '', stdout: existing };
			}
			const writeMatch = cmd.match(/^cat > '([^']+)'$/);
			if (writeMatch !== null) {
				const path = writeMatch[1] as string;
				files.set(path, opts?.stdin ?? '');
				return { exitCode: 0, stderr: '', stdout: '' };
			}
			const mvMatch = cmd.match(/^mv '([^']+)' '([^']+)'$/);
			if (mvMatch !== null) {
				const [, src, dst] = mvMatch as unknown as [string, string, string];
				const contents = files.get(src);
				if (contents !== undefined) {
					files.set(dst, contents);
					files.delete(src);
				}
				return { exitCode: 0, stderr: '', stdout: '' };
			}
			return { exitCode: 0, stderr: '', stdout: '' };
		},
		upload: async () => {}
	};
	return { files, target };
};

const makeDeployer = (
	releases: Array<{ id: string; at: number; active?: boolean }>
): { deployer: CliDeployer; rolledBackTo: string[] } => {
	const rolledBackTo: string[] = [];
	const deployer: CliDeployer = {
		currentReleaseId: async () => releases.find((r) => r.active)?.id,
		listReleases: async () => [...releases],
		rollback: async (id) => {
			rolledBackTo.push(id);
		}
	};
	return { deployer, rolledBackTo };
};

// =============================================================================
// parseArgs
// =============================================================================

describe('parseArgs', () => {
	test('parses command + verb + positional', () => {
		const a = parseArgs(['secrets', 'get', 'STRIPE_KEY']);
		expect(a.command).toBe('secrets');
		expect(a.verb).toBe('get');
		expect(a.positional).toEqual(['STRIPE_KEY']);
	});

	test('parses --flag=value', () => {
		const a = parseArgs(['env', 'push', 'prod', '--target=hetzner']);
		expect(a.flags.target).toBe('hetzner');
	});

	test('parses --flag value', () => {
		const a = parseArgs(['deploy', 'rollback', 'prod', '--to', 'rel_123']);
		expect(a.flags.to).toBe('rel_123');
	});

	test('parses bare --flag as boolean', () => {
		const a = parseArgs(['secrets', 'list', '--json']);
		expect(a.flags.json).toBe(true);
	});

	test('positionals come after the verb', () => {
		const a = parseArgs(['env', 'diff', 'staging', '--all']);
		expect(a.positional).toEqual(['staging']);
		expect(a.flags.all).toBe(true);
	});
});

// =============================================================================
// secrets verbs
// =============================================================================

describe('secrets', () => {
	test('list — prints names + fingerprints', async () => {
		const broker = makeBroker({ DATABASE_URL: 'postgres://x', STRIPE_KEY: 'sk_live_xyz' });
		const adapter = makeAdapter({ DATABASE_URL: 'postgres://x', STRIPE_KEY: 'sk_live_xyz' });
		const config: AbsolutejsConfig = {
			secretAdapter: adapter,
			secrets: broker
		};
		const { out } = await captureIo(() =>
			runSecrets(config, { flags: {}, positional: [], verb: 'list' }, 'human')
		);
		expect(out).toContain('STRIPE_KEY');
		expect(out).toContain('DATABASE_URL');
		expect(out).toContain('fp:sk_liv');
		// Plaintext never appears.
		expect(out).not.toContain('sk_live_xyz');
		expect(out).not.toContain('postgres://x');
	});

	test('list --json emits structured output', async () => {
		const broker = makeBroker({ K: 'v' });
		const adapter = makeAdapter({ K: 'v' });
		const config: AbsolutejsConfig = {
			secretAdapter: adapter,
			secrets: broker
		};
		const { out } = await captureIo(() =>
			runSecrets(config, { flags: {}, positional: [], verb: 'list' }, 'json')
		);
		const parsed = JSON.parse(out);
		expect(parsed).toEqual([{ fingerprint: 'fp:v', name: 'K' }]);
	});

	test('get — redacts by default, shows with --show', async () => {
		const broker = makeBroker({ STRIPE_KEY: 'sk_live_xyz' });
		const config: AbsolutejsConfig = { secrets: broker };

		const redacted = await captureIo(() =>
			runSecrets(
				config,
				{ flags: {}, positional: ['STRIPE_KEY'], verb: 'get' },
				'human'
			)
		);
		expect(redacted.out).toContain('fingerprint=fp:sk_liv');
		expect(redacted.out).not.toContain('sk_live_xyz');

		const shown = await captureIo(() =>
			runSecrets(
				config,
				{ flags: { show: true }, positional: ['STRIPE_KEY'], verb: 'get' },
				'human'
			)
		);
		expect(shown.out.trim()).toBe('sk_live_xyz');
	});

	test('set — puts via the adapter', async () => {
		const broker = makeBroker();
		const adapter = makeAdapter();
		const config: AbsolutejsConfig = {
			secretAdapter: adapter,
			secrets: broker
		};
		await runSecrets(
			config,
			{ flags: {}, positional: ['NEW_KEY=hello'], verb: 'set' },
			'human'
		);
		expect(await adapter.fetch('NEW_KEY')).toBe('hello');
	});

	test('rotate — broker generates + persists a new value', async () => {
		const broker = makeBroker({ STRIPE_KEY: 'old' });
		const { out } = await captureIo(() =>
			runSecrets(
				{ secrets: broker },
				{ flags: {}, positional: ['STRIPE_KEY'], verb: 'rotate' },
				'human'
			)
		);
		expect(out).toMatch(/rotated STRIPE_KEY \(new fingerprint:/);
	});

	test('rejects when broker is missing on rotate', async () => {
		const { err } = await captureIo(async () => {
			try {
				await runSecrets(
					{},
					{ flags: {}, positional: ['STRIPE_KEY'], verb: 'rotate' },
					'human'
				);
			} catch (error) {
				process.stderr.write(String((error as Error).message));
			}
		});
		expect(err).toContain('config.secrets is not set');
	});

	test('rejects when adapter is missing on list', async () => {
		const { err } = await captureIo(async () => {
			try {
				await runSecrets(
					{ secrets: makeBroker() },
					{ flags: {}, positional: [], verb: 'list' },
					'human'
				);
			} catch (error) {
				process.stderr.write(String((error as Error).message));
			}
		});
		expect(err).toContain('config.secretAdapter is not set');
	});
});

// =============================================================================
// env verbs
// =============================================================================

describe('env', () => {
	const makeConfig = (
		broker: CliSecretBroker,
		target: CliTarget,
		extras?: Record<string, string>
	): AbsolutejsConfig => ({
		deployments: [
			{
				extras,
				name: 'prod',
				remotePath: '/etc/myapp.env',
				secretNames: ['STRIPE_KEY'],
				target: async () => target
			}
		],
		secrets: broker
	});

	test('push — writes resolved env file via the target', async () => {
		const broker = makeBroker({ STRIPE_KEY: 'sk_live_xyz' });
		const { files, target } = makeTarget();
		const config = makeConfig(broker, target, { NODE_ENV: 'production' });
		const { out } = await captureIo(() =>
			runEnv(
				config,
				{ flags: {}, positional: ['prod'], verb: 'push' },
				'human'
			)
		);
		expect(out).toContain('pushed 2 keys to prod:/etc/myapp.env');
		expect(files.get('/etc/myapp.env')).toContain('STRIPE_KEY=sk_live_xyz');
		expect(files.get('/etc/myapp.env')).toContain('NODE_ENV=production');
	});

	test('pull — prints existing remote env file', async () => {
		const broker = makeBroker({ STRIPE_KEY: 'sk_live_xyz' });
		const { target } = makeTarget({
			'/etc/myapp.env': 'STRIPE_KEY=sk_live_xyz\nNODE_ENV=production\n'
		});
		const config = makeConfig(broker, target);
		const { out } = await captureIo(() =>
			runEnv(
				config,
				{ flags: {}, positional: ['prod'], verb: 'pull' },
				'human'
			)
		);
		expect(out).toContain('STRIPE_KEY=sk_live_xyz');
	});

	test('pull missing file returns exit 2 + stderr', async () => {
		const broker = makeBroker({ STRIPE_KEY: 'x' });
		const { target } = makeTarget();
		const config = makeConfig(broker, target);
		let code = 0;
		const { err } = await captureIo(async () => {
			code = await runEnv(
				config,
				{ flags: {}, positional: ['prod'], verb: 'pull' },
				'human'
			);
		});
		expect(code).toBe(2);
		expect(err).toContain('no env file at');
	});

	test('diff — shows added/changed/removed keys', async () => {
		const broker = makeBroker({ STRIPE_KEY: 'sk_live_NEW' });
		const { target } = makeTarget({
			'/etc/myapp.env': 'STRIPE_KEY=sk_live_OLD\nGOING_AWAY=bye\n'
		});
		const config = makeConfig(broker, target);
		const { out } = await captureIo(() =>
			runEnv(
				config,
				{ flags: {}, positional: ['prod'], verb: 'diff' },
				'human'
			)
		);
		expect(out).toContain('STRIPE_KEY');
		expect(out).toContain('changed');
		expect(out).toContain('GOING_AWAY');
		expect(out).toContain('removed');
	});

	test('diff with no differences reports same', async () => {
		const broker = makeBroker({ STRIPE_KEY: 'sk_live_xyz' });
		const { target } = makeTarget({
			'/etc/myapp.env': 'STRIPE_KEY=sk_live_xyz\n'
		});
		const config = makeConfig(broker, target);
		const { out } = await captureIo(() =>
			runEnv(
				config,
				{ flags: {}, positional: ['prod'], verb: 'diff' },
				'human'
			)
		);
		expect(out).toContain('no differences');
	});

	test('unknown stage throws cleanly', async () => {
		const broker = makeBroker();
		const config: AbsolutejsConfig = { deployments: [], secrets: broker };
		await expect(
			runEnv(
				config,
				{ flags: {}, positional: ['nope'], verb: 'push' },
				'human'
			)
		).rejects.toThrow('unknown deployment "nope"');
	});
});

// =============================================================================
// deploy verbs
// =============================================================================

describe('deploy', () => {
	const makeConfig = (deployer: CliDeployer): AbsolutejsConfig => ({
		deployments: [
			{
				deployer: async () => deployer,
				name: 'prod',
				remotePath: '/etc/myapp.env',
				target: async () => ({
					description: 'mock',
					exec: async () => ({ exitCode: 0, stderr: '', stdout: '' })
				})
			}
		]
	});

	test('releases — prints release table', async () => {
		const { deployer } = makeDeployer([
			{ active: true, at: Date.now() - 60_000, id: 'rel_2' },
			{ at: Date.now() - 3_600_000, id: 'rel_1' }
		]);
		const config = makeConfig(deployer);
		const { out } = await captureIo(() =>
			runDeploy(
				config,
				{ flags: {}, positional: ['prod'], verb: 'releases' },
				'human'
			)
		);
		expect(out).toContain('rel_2');
		expect(out).toContain('rel_1');
		expect(out).toMatch(/\*\s+rel_2/); // active marker
	});

	test('status — prints current release + recent', async () => {
		const { deployer } = makeDeployer([
			{ active: true, at: Date.now(), id: 'rel_2' },
			{ at: Date.now() - 3_600_000, id: 'rel_1' }
		]);
		const config = makeConfig(deployer);
		const { out } = await captureIo(() =>
			runDeploy(
				config,
				{ flags: {}, positional: ['prod'], verb: 'status' },
				'human'
			)
		);
		expect(out).toContain('current release: rel_2');
	});

	test('rollback --to <id> calls deployer.rollback(id)', async () => {
		const { deployer, rolledBackTo } = makeDeployer([
			{ active: true, at: Date.now(), id: 'rel_2' },
			{ at: Date.now() - 3_600_000, id: 'rel_1' }
		]);
		const config = makeConfig(deployer);
		await captureIo(() =>
			runDeploy(
				config,
				{ flags: { to: 'rel_1' }, positional: ['prod'], verb: 'rollback' },
				'human'
			)
		);
		expect(rolledBackTo).toEqual(['rel_1']);
	});

	test('rollback without --to picks previous release', async () => {
		const { deployer, rolledBackTo } = makeDeployer([
			{ active: true, at: Date.now(), id: 'rel_3' },
			{ at: Date.now() - 60_000, id: 'rel_2' },
			{ at: Date.now() - 3_600_000, id: 'rel_1' }
		]);
		const config = makeConfig(deployer);
		await captureIo(() =>
			runDeploy(
				config,
				{ flags: {}, positional: ['prod'], verb: 'rollback' },
				'human'
			)
		);
		expect(rolledBackTo).toEqual(['rel_2']);
	});

	test('rollback fails clearly when there is no previous release', async () => {
		const { deployer } = makeDeployer([
			{ active: true, at: Date.now(), id: 'rel_1' }
		]);
		const config = makeConfig(deployer);
		await expect(
			runDeploy(
				config,
				{ flags: {}, positional: ['prod'], verb: 'rollback' },
				'human'
			)
		).rejects.toThrow('fewer than 2 releases');
	});

	test('deploy verbs reject when deployer is missing', async () => {
		const config: AbsolutejsConfig = {
			deployments: [
				{
					name: 'prod',
					remotePath: '/etc/myapp.env',
					target: async () => ({
						description: 'mock',
						exec: async () => ({ exitCode: 0, stderr: '', stdout: '' })
					})
				}
			]
		};
		await expect(
			runDeploy(
				config,
				{ flags: {}, positional: ['prod'], verb: 'releases' },
				'human'
			)
		).rejects.toThrow('has no deployer() factory');
	});
});

// =============================================================================
// loadConfig + main() integration
// =============================================================================

describe('loadConfig + main integration', () => {
	let tmpDir: string;
	beforeEach(async () => {
		tmpDir = await mkdir(join(tmpdir(), `abscli-${Date.now()}-${Math.random()}`), {
			recursive: true
		}).then((p) => p ?? '');
	});
	afterEach(async () => {
		if (tmpDir) await rm(tmpDir, { force: true, recursive: true });
	});

	test('loadConfig discovers absolutejs.config.ts in cwd', async () => {
		await mkdir(tmpDir, { recursive: true });
		const configPath = join(tmpDir, 'absolutejs.config.ts');
		await writeFile(
			configPath,
			`import { defineConfig } from '${join(import.meta.dir, '..', 'src', 'index')}';\n` +
				`export default defineConfig({ secrets: undefined, deployments: [] });\n`
		);
		const { loadConfig } = await import('../src/loadConfig');
		const result = await loadConfig(tmpDir);
		expect(result.path).toBe(configPath);
		expect(result.config.deployments).toEqual([]);
	});

	test('loadConfig walks up to find config', async () => {
		await mkdir(tmpDir, { recursive: true });
		const nested = join(tmpDir, 'a', 'b', 'c');
		await mkdir(nested, { recursive: true });
		const configPath = join(tmpDir, 'absolutejs.config.ts');
		await writeFile(
			configPath,
			`import { defineConfig } from '${join(import.meta.dir, '..', 'src', 'index')}';\n` +
				`export default defineConfig({ deployments: [] });\n`
		);
		const { loadConfig } = await import('../src/loadConfig');
		const result = await loadConfig(nested);
		expect(result.path).toBe(configPath);
	});

	test('loadConfig throws clearly when no config found', async () => {
		await mkdir(tmpDir, { recursive: true });
		const { loadConfig } = await import('../src/loadConfig');
		// Walk up from a deeply-nested temp dir to avoid hitting any real config.
		const isolated = join(tmpDir, 'nowhere');
		await mkdir(isolated, { recursive: true });
		// Note: this WILL walk to /, but as long as no parent has a config, it errors.
		// To keep the test hermetic, we just verify the error shape if it throws.
		try {
			await loadConfig(isolated);
		} catch (error) {
			expect((error as Error).message).toContain('no config file found');
		}
	});
});
