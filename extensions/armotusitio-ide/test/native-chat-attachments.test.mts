/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** ArmoTuSitio integration: Alejandro Daniel Di Stefano - ArmoTuSitio.com.ar. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseChatDocument, extractChatDocument } from '../src/native-chat-attachments.ts';
import { readBoundedDocument } from '../src/native-chat-attachment-file.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const extension = path.resolve(here, '..');
const files = {
	workerFile: path.join(extension, 'src/native-chat-document-worker.mts'),
	pdfModule: path.join(extension, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs'),
	pdfWorker: path.join(extension, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs')
};
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ats-document-'));
	try { await run(await fs.realpath(root)); }
	finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
function tinyPdf(text: string): Buffer {
	const stream = 'BT /F1 12 Tf 20 50 Td (' + text + ') Tj ET';
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
		'<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream'
	];
	let pdf = '%PDF-1.4\n';
	const offsets = [0];
	for (const [i, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(pdf));
		pdf += (i + 1) + ' 0 obj\n' + object + '\nendobj\n';
	}
	const xref = Buffer.byteLength(pdf);
	pdf += 'xref\n0 6\n0000000000 65535 f \n';
	for (const offset of offsets.slice(1)) { pdf += String(offset).padStart(10, '0') + ' 00000 n \n'; }
	pdf += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
	return Buffer.from(pdf, 'latin1');
}

test('notebooks include only source and ignore outputs, metadata and attachments', async () => {
	await fixture(async root => {
		const file = path.join(root, 'notes.ipynb');
		await fs.writeFile(file, JSON.stringify({
			nbformat: 4, metadata: { secret: 'NEVER_INCLUDE_META' },
			cells: [
				{ cell_type: 'code', source: ['print("safe")\n'], outputs: [{ text: 'NEVER_INCLUDE_OUTPUT' }], execution_count: 12 },
				{ cell_type: 'markdown', source: 'Project notes', attachments: { image: 'NEVER_INCLUDE_ATTACHMENT' } }
			]
		}));
		let reviewed = false;
		const selected = await chooseChatDocument(root, files, {
			pick: async () => file,
			preview: async () => { reviewed = true; },
			confirm: async () => reviewed
		});
		assert.equal(selected?.kind, 'notebook');
		assert.match(selected?.text ?? '', /print\("safe"\)/);
		assert.match(selected?.text ?? '', /Project notes/);
		assert.doesNotMatch(selected?.text ?? '', /NEVER_INCLUDE_/);
	});
});
test('consent refusal never sends document text', async () => {
	await fixture(async root => {
		const file = path.join(root, 'refuse.ipynb');
		await fs.writeFile(file, '{"nbformat":4,"cells":[{"cell_type":"raw","source":"never send"}]}');
		assert.equal(await chooseChatDocument(root, files, { pick: async () => file, preview: async () => undefined, confirm: async () => false }), undefined);
	});
});
test('notebook schema, cell and text limits fail closed', async () => {
	await fixture(async root => {
		const file = path.join(root, 'limit.ipynb');
		await fs.writeFile(file, JSON.stringify({ nbformat: 4, cells: new Array(201).fill({ cell_type: 'raw', source: 'x' }) }));
		await assert.rejects(extractChatDocument(root, file, files), /HARNESS_NOTEBOOK_INVALID/);
		await fs.writeFile(file, JSON.stringify({ nbformat: 4, cells: [{ cell_type: 'markdown', source: 'x'.repeat(33000) }] }));
		await assert.rejects(extractChatDocument(root, file, files), /HARNESS_DOCUMENT_TEXT_LIMIT/);
	});
});
test('PDF.js extracts a local text-only fixture without rendering or remote services', async () => {
	await fixture(async root => {
		const file = path.join(root, 'text.pdf');
		await fs.writeFile(file, tinyPdf('Text fixture'));
		const document = await extractChatDocument(root, file, files);
		assert.equal(document.kind, 'pdf');
		assert.match(document.text, /Text fixture/);
	});
});
test('invalid PDF, cancellation and changed documents never return extracted data', async () => {
	await fixture(async root => {
		const file = path.join(root, 'bad.pdf');
		await fs.writeFile(file, 'not a valid PDF file');
		await assert.rejects(extractChatDocument(root, file, files), /HARNESS_PDF_INVALID/);
		const signal = new AbortController(); signal.abort();
		await assert.rejects(extractChatDocument(root, file, files, signal.signal), /HARNESS_DOCUMENT_CANCELLED/);
		const digest = (await readBoundedDocument(root, file)).digest;
		await fs.writeFile(file, 'different PDF file contents');
		await assert.rejects(extractChatDocument(root, file, files, undefined, digest), /HARNESS_ATTACHMENT_INVALID/);
	});
});
test('document reads reject sensitive, outside and oversized paths', async () => {
	await fixture(async root => {
		const hidden = path.join(root, '.env.ipynb');
		await fs.writeFile(hidden, '{"nbformat":4,"cells":[]}');
		await assert.rejects(readBoundedDocument(root, hidden), /HARNESS_ATTACHMENT_INVALID/);
		const huge = path.join(root, 'huge.pdf');
		await fs.writeFile(huge, Buffer.alloc(4 * 1024 * 1024 + 1));
		await assert.rejects(readBoundedDocument(root, huge), /HARNESS_ATTACHMENT_LIMIT/);
		const outside = path.join(os.tmpdir(), 'ats-document-external-' + process.pid + '.pdf');
		await fs.writeFile(outside, '%PDF-outside');
		try { await assert.rejects(readBoundedDocument(root, outside), /HARNESS_ATTACHMENT_INVALID/); }
		finally { await fs.rm(outside, { force: true }); }
	});
});

test('a document worker that hangs, exhausts memory, exits or answers out of contract never yields text', async () => {
	await fixture(async root => {
		const file = path.join(root, 'doc.pdf');
		await fs.writeFile(file, tinyPdf('bounded'));
		const hostile = async (name: string, source: string): Promise<string> => {
			const workerFile = path.join(root, name + '.mjs');
			await fs.writeFile(workerFile, 'import { parentPort } from "node:worker_threads";\n' + source);
			const started = Date.now();
			const outcome = await extractChatDocument(root, file, { ...files, workerFile }).then(() => 'accepted', error => (error as Error).message);
			return outcome + (Date.now() - started < 9000 ? '' : ' (slow)');
		};
		assert.deepEqual({
			hangs: await hostile('hang', 'setInterval(() => undefined, 1000);'),
			memory: await hostile('memory', 'const hoard = []; while (true) { hoard.push(new Array(1e6).fill(1)); }'),
			exits: await hostile('exit', 'process.exit(0);'),
			oversized: await hostile('oversized', 'parentPort.postMessage({ text: "x".repeat(32001) });'),
			foreignError: await hostile('foreign', 'parentPort.postMessage({ error: "C:/Users/private/secret.pdf failed" });'),
			emptyText: await hostile('empty', 'parentPort.postMessage({ text: "   " });')
		}, {
			hangs: 'HARNESS_DOCUMENT_TIMEOUT', memory: 'HARNESS_DOCUMENT_WORKER_FAILED', exits: 'HARNESS_DOCUMENT_WORKER_EXIT',
			oversized: 'HARNESS_DOCUMENT_WORKER_FAILED', foreignError: 'HARNESS_DOCUMENT_WORKER_FAILED', emptyText: 'HARNESS_DOCUMENT_WORKER_FAILED'
		});
	});
});
