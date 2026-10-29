/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { spawn } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const shell = await readFile(path.join(root, 'release.sh'), 'utf8');
const embedded = shell.split('<<\'NODE\'\n')[1]?.replace(/\nNODE\n?$/, '');
assert.ok(embedded, 'The shell launcher must contain the tested Node recipe.');

// All gh/git/build operations live inside this isolated fixture. No network,
// repository index, real release metadata or packaged outputs are accessed.
const runner = `
import { appendFile, readFile } from 'node:fs/promises';
let branch = 'main', merged = false, sourceChanged = false, validated = false;
const settings = JSON.parse(await readFile('fixture.json', 'utf8'));
const original = 'a'.repeat(40), updated = 'b'.repeat(40);
const record = async value => appendFile('calls.jsonl', JSON.stringify(value) + '\\n');
export async function run(file, args) {
	await record([file, ...args]);
	if (file === 'git') {
		if (args[0] === 'remote') return 'https://github.com/example/ide.git';
		if (args[0] === 'branch') return branch;
		if (args[0] === 'status') return settings.dirty || sourceChanged ? ' M source.ts' : '';
		if (args[0] === 'rev-parse') return merged ? updated : original;
		if (args[0] === 'switch') { branch = args.at(-1); return ''; }
		if (args[0] === 'pull') { merged = true; return ''; }
		if (args[0] === 'diff') return args[1] === '--name-only' ? 'build/armotusitio/product-overrides.json' : settings.mergeChangedSource && merged && args[1] === original ? 'unrelated.ts' : '';
		return '';
	}
	if (file === 'gh') {
		if (args[0] === 'auth') return '';
		if (args[0] === 'api' && args.some(arg => arg.includes('/releases?'))) return JSON.stringify(settings.releaseChangedAfterValidate && validated ? [[{ tag_name: 'ats-v1.143.1-r1', draft: false, published_at: '2026-10-25T10:00:00Z' }]] : settings.pages);
		if (args[0] === 'api') return JSON.stringify({ sha: settings.remoteChanged ? 'c'.repeat(40) : merged ? updated : original });
		if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ state: settings.blockMerge ? 'OPEN' : 'MERGED' });
		return '';
	}
	if (file === 'docker') return 'linux';
	return 'ready';
}
export async function withLock(directory, work) {
	await record(['lock', directory]);
	return work();
}
export async function requireActionsDisabled() {
	await record(['actions-check']);
	if (settings.actionsEnabled) throw new Error('Actions must be disabled.');
}
export async function main(args) {
	await record(['update', ...args]);
	if (settings.failStage === args[0]) throw new Error('fixture stage failed');
	if (settings.changeAfterValidate && args[0] === 'validate') sourceChanged = true;
	if (args[0] === 'validate') validated = true;
}
`;

async function fixture(settings: object, revision = 4, version = '1.143.1') {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'ats-release-script-'));
	const keys = generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
	const files: Record<string, string> = {
		'.nvmrc': process.versions.node,
		'package.json': JSON.stringify({ version }), 'product.json': '{}',
		'fixture.json': JSON.stringify(settings),
		'build/armotusitio/product-overrides.json': JSON.stringify({ quality: 'stable', armotusitioUpdate: { repository: 'example/ide', revision, publicKey: keys.publicKey }, armotusitioUpstream: { ref: version } }),
		'scripts/ats-autoupdate.mts': runner,
		'scripts/ats-build-all.mts': `import { main } from './ats-autoupdate.mts'; export const assertPackagedClosed = async () => {}; export const buildAll = async () => main(['build-all']);`,
		'src/vs/platform/update/common/armotusitioUpdate.ts': `export const armotusitioRepository = 'example/ide';`,
		'.build/ats-autoupdate/signing/private.pem': keys.privateKey,
		'node_modules/gulp/bin/gulp.js': '',
	};
	for (const [file, contents] of Object.entries(files)) {
		await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
		await writeFile(path.join(directory, file), contents);
	}
	return {
		directory,
		async invoke(flags: string[]) {
			return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
				const child = spawn(process.execPath, ['--input-type=module', '-', ...flags], {
					cwd: directory, env: { ...process.env, GH_HOST: 'github.com', GITHUB_ACTIONS: 'false', ATS_IDE_SIGNING_KEY: '' }, stdio: ['pipe', 'pipe', 'pipe']
				});
				let output = '';
				child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
				child.once('error', reject); child.once('close', code => resolve({ code, output }));
				child.stdin.end(embedded);
			});
		},
		async calls(): Promise<string[][]> { return (await readFile(path.join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); },
		async close() {
			assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(directory).startsWith('ats-release-script-'));
			await rm(directory, { recursive: true, force: true });
		}
	};
}

function published(tag: string) { return { tag_name: tag, draft: false, published_at: '2026-10-25T10:00:00Z' }; }

test('plan paginates all releases, selects the current version numerically, ignores drafts and never writes metadata/locks', async () => {
	const f = await fixture({ pages: [[published('ats-v1.143.1-r2'), published('ats-v1.144.0-r99')], [published('ats-v1.143.1-r10'), { tag_name: 'ats-v1.143.1-r20', draft: true }]] });
	try {
		const metadata = path.join(f.directory, 'build/armotusitio/product-overrides.json');
		const before = await readFile(metadata, 'utf8');
		const result = await f.invoke(['--plan']);
		assert.equal(result.code, 0, result.output); assert.match(result.output, /ats-v1\.143\.1-r11/);
		const calls = await f.calls();
		assert.ok(calls.some(call => call.includes('--paginate') && call.includes('--slurp')));
		assert.ok(calls.every(call => !['lock', 'update'].includes(call[0]) && !(call[0] === 'git' && ['switch', 'add', 'commit', 'push', 'pull'].includes(call[1]))));
		assert.equal(await readFile(metadata, 'utf8'), before);
		assert.deepEqual(await readdir(path.join(f.directory, '.build')), ['ats-autoupdate']);
	} finally { await f.close(); }
});

test('new version starts at r1 even when metadata has a higher old revision', async () => {
	const f = await fixture({ pages: [[published('ats-v1.143.1-r40')]] }, 4, '1.144.0');
	try { const result = await f.invoke(['--dry-run']); assert.equal(result.code, 0, result.output); assert.match(result.output, /Metadata revision: 4 -> 1/); }
	finally { await f.close(); }
});

test('release rejects an older Node than .nvmrc before metadata or build writes', async () => {
	const f = await fixture({ pages: [[]] });
	try {
		await writeFile(path.join(f.directory, '.nvmrc'), '24.99.0\n');
		const result = await f.invoke([]);
		assert.equal(result.code, 1, result.output);
		assert.match(result.output, /Node >=24\.99\.0/);
		assert.ok((await f.calls()).every(call => call[0] !== 'update' && !(call[0] === 'git' && ['switch', 'add', 'commit', 'push'].includes(call[1]))));
	} finally { await f.close(); }
});

test('plan fails closed on dirty source, remote drift, invalid API data, inconsistent version and enabled Actions', async () => {
	for (const settings of [{ dirty: true }, { remoteChanged: true }, { pages: {} }, { actionsEnabled: true }, { inconsistent: true }]) {
		const f = await fixture({ pages: [[]], ...settings });
		try {
			if ('inconsistent' in settings) { await writeFile(path.join(f.directory, 'package.json'), '{"version":"2.0.0"}'); }
			const result = await f.invoke(['--plan']); assert.equal(result.code, 1, result.output);
			assert.ok((await f.calls()).every(call => !['update', 'lock'].includes(call[0])));
		} finally { await f.close(); }
	}
});

test('matching draft is retained; mismatched draft blocks execution', async () => {
	for (const target of ['a'.repeat(40), 'c'.repeat(40)]) {
		const f = await fixture({ pages: [[published('ats-v1.143.1-r3'), { tag_name: 'ats-v1.143.1-r4', draft: true, target_commitish: target }]] });
		try { const result = await f.invoke(['--plan']); assert.equal(result.code, target.startsWith('a') ? 0 : 1, result.output); }
		finally { await f.close(); }
	}
});

test('full recipe scopes metadata commit, uses protected PR merge, then existing gates and publisher', { skip: process.platform !== 'win32' }, async () => {
	const f = await fixture({ pages: [[]] });
	try {
		const result = await f.invoke([]); assert.equal(result.code, 0, result.output);
		const calls = await f.calls();
		assert.deepEqual(calls.filter(call => call[0] === 'update'), [['update', 'validate'], ['update', 'build-all'], ['update', 'artifacts'], ['update', 'publish', '--approve']]);
		assert.ok(calls.some(call => call[0] === 'git' && call[1] === 'commit' && call.slice(-3).join(' ') === '--only -- build/armotusitio/product-overrides.json'));
		assert.ok(calls.some(call => call[0] === 'gh' && call[1] === 'pr' && call[2] === 'merge' && call.includes('--match-head-commit') && !call.includes('--admin')));
		assert.equal(JSON.parse(await readFile(path.join(f.directory, 'build/armotusitio/product-overrides.json'), 'utf8')).armotusitioUpdate.revision, 1);
	} finally { await f.close(); }
});

test('failed validation or changed source/releases prevents build/publication; no-publish omits publisher', { skip: process.platform !== 'win32' }, async () => {
	for (const settings of [{ failStage: 'validate' }, { changeAfterValidate: true }, { releaseChangedAfterValidate: true }, { noPublish: true }]) {
		const f = await fixture({ pages: [[]], ...settings }, 1);
		try {
			const result = await f.invoke('noPublish' in settings ? ['--no-publish'] : []);
			assert.equal(result.code, 'noPublish' in settings ? 0 : 1, result.output);
			const stages = (await f.calls()).filter(call => call[0] === 'update');
			assert.deepEqual(stages, 'noPublish' in settings ? [['update', 'validate'], ['update', 'build-all'], ['update', 'artifacts']] : [['update', 'validate']]);
		} finally { await f.close(); }
	}
});

test('repeating no-publish reuses the unpublished revision and does not create another metadata commit', { skip: process.platform !== 'win32' }, async () => {
	const f = await fixture({ pages: [[]] });
	try {
		const first = await f.invoke(['--no-publish']); assert.equal(first.code, 0, first.output);
		const count = (await f.calls()).length;
		const second = await f.invoke(['--no-publish']); assert.equal(second.code, 0, second.output);
		assert.match(second.output, /Metadata revision: 1 -> 1/);
		assert.ok((await f.calls()).slice(count).every(call => !(call[0] === 'git' && ['commit', 'push', 'add', 'switch'].includes(call[1]))));
	} finally { await f.close(); }
});

test('source changes introduced while merging metadata stop before validation/build', { skip: process.platform !== 'win32' }, async () => {
	const f = await fixture({ pages: [[]], mergeChangedSource: true });
	try { const result = await f.invoke([]); assert.equal(result.code, 1, result.output); assert.match(result.output, /unrelated source changes/); assert.ok((await f.calls()).every(call => call[0] !== 'update')); }
	finally { await f.close(); }
});

test('protected PR that remains open prevents all build/publication stages', { skip: process.platform !== 'win32' }, async () => {
	const f = await fixture({ pages: [[]], blockMerge: true });
	try { const result = await f.invoke([]); assert.equal(result.code, 1, result.output); assert.ok((await f.calls()).every(call => call[0] !== 'update')); }
	finally { await f.close(); }
});
