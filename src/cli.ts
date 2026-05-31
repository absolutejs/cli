/**
 * `absolutejs` binary entry. Parses argv, loads
 * `absolutejs.config.ts`, dispatches to a verb handler.
 *
 * Hand-rolled arg parser — no commander/yargs dep, keeping with the
 * substrate's zero-peer-dep posture.
 */

import { loadConfig } from './loadConfig';
import { runSecrets, type SecretsArgs } from './commands/secrets';
import { runEnv, type EnvArgs } from './commands/env';
import { runDeploy, type DeployArgs } from './commands/deploy';
import { writeErr, writeOut, type OutputMode } from './utils/output';

export type ParsedArgs = {
	command: string | undefined;
	verb: string | undefined;
	positional: string[];
	flags: Record<string, string | boolean>;
};

/**
 * Parse `argv` into command + verb + positional + flags.
 *
 * Conventions:
 *   absolutejs <command> <verb> <pos...> [--flag] [--flag=value] [--flag value]
 *
 * Bare `--flag` becomes `{flag: true}`. `--flag=value` and `--flag value`
 * both become `{flag: value}`. Positional args don't start with `-`.
 */
export const parseArgs = (argv: string[]): ParsedArgs => {
	const positional: string[] = [];
	const flags: Record<string, string | boolean> = {};
	let command: string | undefined;
	let verb: string | undefined;
	let index = 0;
	while (index < argv.length) {
		const arg = argv[index] as string;
		if (arg.startsWith('--')) {
			const body = arg.slice(2);
			const eq = body.indexOf('=');
			if (eq >= 0) {
				flags[body.slice(0, eq)] = body.slice(eq + 1);
			} else {
				const next = argv[index + 1];
				if (next !== undefined && !next.startsWith('-')) {
					flags[body] = next;
					index += 1;
				} else {
					flags[body] = true;
				}
			}
		} else if (command === undefined) {
			command = arg;
		} else if (verb === undefined) {
			verb = arg;
		} else {
			positional.push(arg);
		}
		index += 1;
	}
	return { command, flags, positional, verb };
};

const HELP = `absolutejs — substrate CLI for the AbsoluteJS PaaS

USAGE
  absolutejs <command> <verb> [args...] [--flags]

COMMANDS
  secrets list                      list secret names + fingerprints from the broker
  secrets get <name> [--show]       resolve one secret (--show prints plaintext)
  secrets set <NAME>=<value>        put a value via the configured adapter
  secrets rotate <name>             generate + persist a new value, fire onRotate

  env push <stage>                  resolve secrets + extras, atomic write remote env file
  env pull <stage>                  print the remote env file (or --json its values)
  env diff <stage> [--all]          show what env push would change

  deploy releases <stage>           list release history for a stage
  deploy status <stage>             current release id + recent history
  deploy rollback <stage> [--to <id>] roll back to <id> or the previous release

GLOBAL FLAGS
  --json                            machine-readable output
  --help                            this banner

CONFIG
  Reads ./absolutejs.config.ts (walks parent dirs). Author it with:

    import { defineConfig } from '@absolutejs/cli';
    export default defineConfig({
      secrets: /* SecretBroker */,
      secretAdapter: /* SecretAdapter */,
      deployments: [
        { name: 'prod', target: () => ..., remotePath: '/etc/api.env',
          secretNames: ['STRIPE_KEY'], reload: 'systemctl reload api' }
      ],
    });`;

export const main = async (argv: string[]): Promise<number> => {
	const args = parseArgs(argv);
	if (args.flags.help === true || args.command === undefined) {
		writeOut(HELP);
		return args.command === undefined && args.flags.help !== true ? 1 : 0;
	}

	const mode: OutputMode = args.flags.json === true ? 'json' : 'human';
	const verb = args.verb;
	if (verb === undefined) {
		writeErr(`missing verb for "${args.command}". run \`absolutejs --help\``);
		return 2;
	}

	try {
		const { config } = await loadConfig();

		switch (args.command) {
			case 'secrets':
				return await runSecrets(
					config,
					{
						flags: args.flags,
						positional: args.positional,
						verb
					} satisfies SecretsArgs,
					mode
				);

			case 'env':
				return await runEnv(
					config,
					{
						flags: args.flags,
						positional: args.positional,
						verb
					} satisfies EnvArgs,
					mode
				);

			case 'deploy':
				return await runDeploy(
					config,
					{
						flags: args.flags,
						positional: args.positional,
						verb
					} satisfies DeployArgs,
					mode
				);

			default:
				writeErr(
					`unknown command "${args.command}". try: secrets | env | deploy`
				);
				return 2;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (mode === 'json') {
			process.stdout.write(`${JSON.stringify({ error: message })}\n`);
		} else {
			writeErr(`error: ${message}`);
		}
		return 1;
	}
};
