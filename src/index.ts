/**
 * @absolutejs/cli — substrate CLI for the AbsoluteJS PaaS.
 *
 * Library entry: exports `defineConfig` for `absolutejs.config.ts`
 * authors + the types the CLI verbs operate on. The CLI itself runs
 * via the `absolutejs` binary (see `bin/absolutejs.js` and
 * `src/cli.ts`).
 *
 * Composes with `@absolutejs/secrets` (broker, encrypted file
 * adapter), `@absolutejs/deploy` (Target, Deployer, EnvDeployment),
 * and any other substrate package that satisfies one of the narrow
 * interfaces below.
 */

// =============================================================================
// Narrow types — match the shapes from @absolutejs/secrets +
// @absolutejs/deploy without importing them directly. Users pass
// instances that satisfy these structurally.
// =============================================================================

export type SecretValue = { value: string; fingerprint: string };

/**
 * Narrow SecretBroker interface — the SecretBroker from
 * `@absolutejs/secrets` satisfies this structurally.
 */
export type CliSecretBroker = {
	resolve: (name: string) => Promise<SecretValue | null>;
	rotate: (name: string) => Promise<SecretValue>;
	fingerprint: (value: string) => string;
};

/**
 * Narrow SecretAdapter interface — for `secrets list` / `secrets set`,
 * which need to write to the underlying store (broker doesn't expose
 * `put`).
 */
export type CliSecretAdapter = {
	fetch: (name: string) => Promise<string | null>;
	list?: () => Promise<string[]>;
	put?: (name: string, value: string) => Promise<void>;
	remove?: (name: string) => Promise<void>;
};

export type CliTargetExec = (
	cmd: string,
	opts?: {
		cwd?: string;
		env?: Record<string, string>;
		stdin?: string;
		timeoutMs?: number;
	}
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/** Narrow Target — @absolutejs/deploy's Target satisfies this. */
export type CliTarget = {
	readonly description: string;
	exec: CliTargetExec;
	upload?: (
		localPath: string,
		remotePath: string,
		opts?: { exclude?: string[]; deleteOrphans?: boolean }
	) => Promise<void>;
	close?: () => Promise<void>;
};

/**
 * A deployment entry — names a remote, declares which secrets it
 * consumes, points at a remote env file. Modeled after
 * `EnvDeployment` from `@absolutejs/deploy/env`.
 *
 * The `target` field is a FACTORY (lazy) so a `secrets list` call
 * doesn't accidentally provision a Hetzner box. Only verbs that
 * actually need a remote (env push/pull/diff, deploy rollback)
 * invoke it.
 */
export type CliDeployment = {
	/** Stage name — `'prod'`, `'staging'`, `'pr-123'`. */
	name: string;
	/** Lazy target factory. Resolved only when a verb needs it. */
	target: () => Promise<CliTarget>;
	/** Remote env file path. */
	remotePath: string;
	/** Names of secrets the broker should resolve into this file. */
	secretNames?: ReadonlyArray<string>;
	/** Non-secret env vars merged into the file. */
	extras?: Record<string, string>;
	/** File mode. Default `'600'`. */
	mode?: string;
	/** File owner. */
	owner?: string;
	/** Command run after the env file changes (e.g. `'systemctl reload api'`). */
	reload?: string;
	/**
	 * Optional Deployer factory — for `deploy rollback / releases / status`.
	 * Same lazy contract as `target`.
	 */
	deployer?: () => Promise<CliDeployer>;
};

/** Narrow Deployer interface — @absolutejs/deploy's Deployer satisfies. */
export type CliDeployer = {
	listReleases?: () => Promise<
		ReadonlyArray<{
			id: string;
			at: number;
			active?: boolean;
			annotations?: Record<string, unknown>;
		}>
	>;
	rollback?: (releaseId: string) => Promise<void>;
	currentReleaseId?: () => Promise<string | undefined>;
};

/** The shape of `absolutejs.config.ts`'s default export. */
export type AbsolutejsConfig = {
	/** Optional broker — required for any `secrets` verb. */
	secrets?: CliSecretBroker;
	/**
	 * Optional adapter — required for `secrets list` / `secrets set`
	 * (broker.rotate/resolve don't expose put/list). Pass the same
	 * adapter you used to build the broker.
	 */
	secretAdapter?: CliSecretAdapter;
	/** Stage deployments. Empty array is valid for `secrets`-only setups. */
	deployments?: ReadonlyArray<CliDeployment>;
};

/**
 * Author-facing helper for `absolutejs.config.ts`. Pure identity
 * function; exists for type inference + future extension.
 */
export const defineConfig = (config: AbsolutejsConfig): AbsolutejsConfig =>
	config;
