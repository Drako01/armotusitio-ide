/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatUploadSize, MAX_UPLOAD_BYTES, saveUploads, uploadFileName, uploadsContext, uploadSupport, UPLOAD_FOLDER } from '../src/native-chat-uploads.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const upload = (name: string, mime: string, bytes: Buffer) => ({ name, mime, data: bytes.toString('base64') });

async function withProject(work: (root: string) => Promise<void>): Promise<void> {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ats-uploads-')));
	try {
		await fs.mkdir(path.join(root, '.git', 'info'), { recursive: true });
		await fs.writeFile(path.join(root, '.git', 'info', 'exclude'), '# local\n*.log');
		await work(root);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('any file type is saved inside the project, kept out of git locally, and described to the agent by path', async () => {
	await withProject(async root => {
		const saved = await saveUploads(root, [upload('captura de pantalla.png', 'image/png', PNG), upload('notas.md', 'text/markdown', Buffer.from('# hola\n')),
			upload('reporte.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n')), upload('datos', '', Buffer.from('x'))]);
		await saveUploads(root, [upload('notas.md', 'text/markdown', Buffer.from('# hola\n'))]);
		const exclude = await fs.readFile(path.join(root, '.git', 'info', 'exclude'), 'utf8');
		const files = (await fs.readdir(path.join(root, UPLOAD_FOLDER))).sort();
		assert.deepEqual({
			paths: saved.map(entry => entry.path.replace(/\/[0-9a-f]{8}-/, '/<digest>-')),
			images: saved.map(entry => !!entry.image),
			mimes: saved.map(entry => entry.mime),
			files: files.length,
			excludedOnce: exclude.split('\n').filter(line => line === '/' + UPLOAD_FOLDER + '/').length,
			keptExisting: exclude.startsWith('# local\n*.log\n'),
			content: await fs.readFile(path.join(root, saved[1].path), 'utf8')
		}, {
			paths: [UPLOAD_FOLDER + '/<digest>-captura-de-pantalla.png', UPLOAD_FOLDER + '/<digest>-notas.md', UPLOAD_FOLDER + '/<digest>-reporte.pdf', UPLOAD_FOLDER + '/<digest>-datos'],
			images: [true, false, false, false],
			mimes: ['image/png', 'text/markdown', 'application/pdf', 'application/octet-stream'],
			files: 4, excludedOnce: 1, keptExisting: true, content: '# hola\n'
		});
		const context = uploadsContext(saved);
		assert.match(context, /^<attachments>\n/);
		for (const entry of saved) { assert.ok(context.includes('- ' + entry.path + ' ('), entry.path); }
	});
});

test('names cannot leave the folder and malformed or oversized input is refused before anything is written', async () => {
	await withProject(async root => {
		const digest = 'abcdef0123456789';
		assert.deepEqual([uploadFileName('../../etc/passwd', digest), uploadFileName('C:\\Users\\x\\secret.TXT', digest), uploadFileName('...', digest), uploadFileName('a<b>|c?.json', digest)],
			['abcdef01-passwd', 'abcdef01-secret.txt', 'abcdef01-file', 'abcdef01-a-b-c.json']);
		const refusals = await Promise.all([
			[], Array(6).fill(upload('a.txt', 'text/plain', Buffer.from('a'))), [{ name: 'a.txt', mime: 'text/plain', data: 'not base64!' }],
			[{ name: 'a.txt', mime: 'text/plain', data: 'YQ==', path: '/etc' }], [{ name: '', mime: 'text/plain', data: 'YQ==' }],
			[upload('big.bin', '', Buffer.alloc(MAX_UPLOAD_BYTES + 1))], [upload('a.bin', '', Buffer.alloc(MAX_UPLOAD_BYTES)), upload('b.bin', '', Buffer.alloc(MAX_UPLOAD_BYTES)), upload('c.bin', '', Buffer.alloc(1))]
		].map(input => saveUploads(root, input).then(() => 'saved', (error: Error) => error.message)));
		assert.deepEqual(refusals, ['HARNESS_UPLOAD_LIMIT', 'HARNESS_UPLOAD_LIMIT', 'HARNESS_UPLOAD_LIMIT', 'HARNESS_UPLOAD_INVALID', 'HARNESS_UPLOAD_INVALID', 'HARNESS_UPLOAD_LIMIT', 'HARNESS_UPLOAD_LIMIT']);
		assert.equal(await fs.stat(path.join(root, UPLOAD_FOLDER)).then(() => true, () => false), false);
	});
});

test('a file in place of the folder is refused, and attachments older than a week are removed on the next save', async () => {
	await withProject(async root => {
		await fs.writeFile(path.join(root, UPLOAD_FOLDER), 'not a folder');
		await assert.rejects(saveUploads(root, [upload('a.txt', 'text/plain', Buffer.from('a'))]), /HARNESS_UPLOAD_INVALID/);
		await fs.rm(path.join(root, UPLOAD_FOLDER));
		const [old] = await saveUploads(root, [upload('old.txt', 'text/plain', Buffer.from('old'))]);
		const lastWeek = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		await fs.utimes(path.join(root, old.path), lastWeek, lastWeek);
		const [fresh] = await saveUploads(root, [upload('new.txt', 'text/plain', Buffer.from('new'))]);
		assert.deepEqual(await fs.readdir(path.join(root, UPLOAD_FOLDER)), [path.basename(fresh.path)]);
	});
});

test('sizes read at a glance', () => {
	assert.deepEqual([formatUploadSize(512), formatUploadSize(34 * 1024), formatUploadSize(1.25 * 1024 * 1024)], ['512 B', '34 KB', '1.3 MB']);
});

test('J-19/JUN-012: each attachment says whether the agent can read it; a binary document is never presented as read', () => {
	const file = (name: string, mime: string) => ({ path: UPLOAD_FOLDER + '/x-' + name, name, mime, bytes: 10, digest: 'd' });
	const uploads = [file('notas.md', 'text/markdown'), file('reporte.pdf', 'application/pdf'), file('contrato.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), file('datos.csv', '')];
	assert.deepEqual(uploads.map(uploadSupport), ['text', 'pdf', 'unsupported', 'text']);
	const context = uploadsContext(uploads);
	assert.match(context, /contrato\.docx, readable: unsupported\)/);
	assert.match(context, /never claim to have read them/);
	assert.doesNotMatch(uploadsContext(uploads.slice(0, 2)), /never claim/);
});
