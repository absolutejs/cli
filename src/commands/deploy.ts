/**
 * `absolutejs deploy <verb>` — deploy-side ops over the existing
 * `@absolutejs/deploy` Deployer surface.
 *
 * Verbs:
 *   releases <stage>          — list release history for a stage
 *   rollback <stage> [--to <id>] — rollback to <id> or previous
 *   status <stage>            — current release id + recent history
 *
 * Each deployment in the config may expose a `deployer()` factory.
 * Verbs that need it bail out clearly when it's absent.
 */

import type { AbsolutejsConfig, CliDeployer, CliDeployment } from '../index';
import {
	formatRelativeTime,
	renderTable,
	writeErr,
	writeJson,
	writeOut,
	type OutputMode
} from '../utils/output';

export type DeployArgs = {
	verb: string;
	positional: string[];
	flags: Record<string, string | boolean>;
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

const requireDeployer = async (
	deployment: CliDeployment
): Promise<CliDeployer> => {
	if (deployment.deployer === undefined) {
		throw new Error(
			`deployment "${deployment.name}" has no deployer() factory in config`
		);
	}
	return deployment.deployer();
};

export const runDeploy = async (
	config: AbsolutejsConfig,
	args: DeployArgs,
	mode: OutputMode
): Promise<number> => {
	const { verb, positional, flags } = args;
	const stage = positional[0];
	if (stage === undefined) {
		throw new Error(`usage: deploy ${verb} <stage>`);
	}
	const deployment = findDeployment(config, stage);
	const deployer = await requireDeployer(deployment);

	switch (verb) {
		case 'releases': {
			if (deployer.listReleases === undefined) {
				throw new Error('the deployer for this stage does not implement listReleases()');
			}
			const releases = await deployer.listReleases();
			if (mode === 'json') {
				writeJson({ releases, stage });
			} else {
				const rows = releases.map((release) => [
					release.active === true ? '*' : ' ',
					release.id,
					new Date(release.at).toISOString(),
					formatRelativeTime(Date.now() - release.at)
				]);
				writeOut(renderTable(['', 'id', 'at', 'age'], rows));
			}
			return 0;
		}

		case 'status': {
			const releases = deployer.listReleases
				? await deployer.listReleases()
				: [];
			const currentId = deployer.currentReleaseId
				? await deployer.currentReleaseId()
				: undefined;
			if (mode === 'json') {
				writeJson({
					currentReleaseId: currentId ?? null,
					recentReleases: releases.slice(0, 5),
					stage
				});
			} else {
				writeOut(`stage: ${stage}`);
				writeOut(`current release: ${currentId ?? '(unknown)'}`);
				if (releases.length > 0) {
					writeOut('\nrecent releases:');
					const rows = releases
						.slice(0, 5)
						.map((release) => [
							release.active === true ? '*' : ' ',
							release.id,
							formatRelativeTime(Date.now() - release.at)
						]);
					writeOut(renderTable(['', 'id', 'age'], rows));
				}
			}
			return 0;
		}

		case 'rollback': {
			if (deployer.rollback === undefined) {
				throw new Error('the deployer for this stage does not implement rollback()');
			}
			let target = typeof flags.to === 'string' ? flags.to : undefined;
			if (target === undefined) {
				// --to-previous: find the second-most-recent release.
				if (deployer.listReleases === undefined) {
					throw new Error(
						'rollback without --to requires deployer.listReleases() to find the previous release'
					);
				}
				const releases = await deployer.listReleases();
				if (releases.length < 2) {
					throw new Error(
						`stage ${stage} has fewer than 2 releases — nothing to roll back to`
					);
				}
				const activeIndex = releases.findIndex((r) => r.active === true);
				const previous =
					activeIndex >= 0 && activeIndex + 1 < releases.length
						? releases[activeIndex + 1]
						: releases[1];
				target = previous?.id;
				if (target === undefined) {
					throw new Error('could not determine previous release id');
				}
			}
			await deployer.rollback(target);
			if (mode === 'json') {
				writeJson({ rolledBackTo: target, stage });
			} else {
				writeOut(`${stage}: rolled back to ${target}`);
			}
			return 0;
		}

		default:
			throw new Error(
				`unknown deploy verb: "${verb}". try: releases | status | rollback`
			);
	}
};
