/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Explicitly opt-in, one-call real-provider smoke test in a disposable read-only Git fixture.
 * Never invoked by CI, formatting, npm test, or workspace discovery.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { executeReviewedAgent } from '../extensions/armotusitio-ide/src/native-agent-execution.ts';
import { reviewAgentDraft, type NativeProvider } from '../extensions/armotusitio-ide/src/native-providers.ts';
import { parseReviewerVerdict } from '../extensions/armotusitio-ide/src/native-review.ts';

const APPROVAL = '--acknowledge-real-model-call';
const PROVIDERS = new Set(['codex', 'claude']);
const HELP = [
	'Usage: node scripts/ats-harness-real-provider-smoke.mts --provider codex|claude --acknowledge-real-model-call',
	'',
	'Runs exactly one read-only model request in a temporary Git repository.',
	'Requires interactive terminal approval. Can consume provider credits/quota.',
	'Does NOT certify an operating-system sandbox, network restriction or production readiness.',
	'No prompt, model response or credentials are logged.'
].join('\n');

export function parseSmokeArgs(args: readonly string[]): { provider: NativeProvider; approved: true } {
	if (args.length !== 3 || args[0] !== '--provider' || !PROVIDERS.has(args[1]) || args[2] !== APPROVAL) {
		throw Error('HARNESS_REAL_SMOKE_EXPLICIT_APPROVAL_REQUIRED');
	}
	return { provider: args[1] as NativeProvider, approved: true };
}

function git(folder: string, args: string[]): void {
	execFileSync('git', ['-C', folder, ...args], { stdio: 'ignore', timeout: 10000, windowsHide: true });
}

async function main(): Promise<void> {
	if (process.argv.includes('--help') || process.argv.includes('-h')) {
		process.stdout.write(HELP + '\n');
		return;
	}
	const config = parseSmokeArgs(process.argv.slice(2));
	if (process.env.CI || !process.stdin.isTTY || !process.stdout.isTTY) {
		throw Error('HARNESS_REAL_SMOKE_REQUIRES_INTERACTIVE_TERMINAL');
	}
	process.stdout.write('Real ' + config.provider + ' call; may consume quota. Read-only fixture, NOT an OS sandbox.\n');
	process.stdout.write('Type RUN to authorize this single invocation: ');
	const response = await new Promise<string>(resolve => {
		let input = '';
		process.stdin.setEncoding('utf8');
		process.stdin.resume();
		const onData = (chunk: string): void => {
			input += chunk;
			if (input.length > 32 || /[\r\n]/.test(input)) {
				process.stdin.off('data', onData);
				process.stdin.pause();
				resolve(input.trim());
			}
		};
		process.stdin.on('data', onData);
	});
	if (response !== 'RUN') { throw Error('HARNESS_REAL_SMOKE_NOT_APPROVED'); }
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-real-provider-smoke-'));
	let modified = false;
	try {
		const canonical = await fs.realpath(root);
		await fs.writeFile(path.join(root, 'README.md'), '# Smoke fixture\nThis is an isolated test repository.\n', 'utf8');
		git(root, ['init', '-q']);
		git(root, ['add', '--', 'README.md']);
		git(root, ['-c', 'user.name=Harness Smoke', '-c', 'user.email=harness-smoke@example.invalid', 'commit', '-qm', 'fixture']);
		const draft = {
			schemaVersion: 1 as const,
			provider: config.provider,
			role: 'reviewer' as const,
			readOnly: true,
			projectRoot: canonical,
			instruction: 'Read the local README.md. Do not change files, do not use network tools, do not run commands, and do not access any other directory. If it contains the title Smoke fixture, reply with exactly HARNESS_REVIEW: PASS; otherwise reply with exactly HARNESS_REVIEW: FAIL.'
		};
		const run = await executeReviewedAgent(reviewAgentDraft(draft), draft, 90_000);
		const outcome = await run.outcome;
		modified = outcome.scopeViolation === true;
		const approved = outcome.status === 'passed' && outcome.scopeVerified === true &&
			outcome.scopeViolation === false && !outcome.truncated &&
			parseReviewerVerdict(outcome.output, outcome.truncated) === 'approved';
		process.stdout.write(JSON.stringify({
			provider: config.provider, passed: approved, status: outcome.status,
			scopeVerified: outcome.scopeVerified === true,
			scopeViolation: modified, responseTruncated: outcome.truncated,
			durationMs: outcome.durationMs,
			tokenUsageReported: outcome.usage !== undefined
		}, null, 2) + '\n');
		if (!approved) { process.exitCode = 1; }
	} finally {
		if (modified) {
			process.stderr.write('Read-only violation detected. The temporary fixture was left for inspection: ' + root + '\n');
		} else {
			await fs.rm(root, { recursive: true, force: true });
		}
	}
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		process.stderr.write('Smoke failed: ' + (error instanceof Error ? error.message : 'UNKNOWN') + '\n');
		process.exitCode = 1;
	});
}
