/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  ArmoTuSitio integration: Alejandro Daniel Di Stefano - ArmoTuSitio.com.ar.
 *--------------------------------------------------------------------------------------------*/
/** Document-to-text extraction never calls a model, renders pages, executes code or writes temporary files. */
import { Worker } from 'node:worker_threads';
import { readBoundedDocument, type BoundedDocument } from './native-chat-attachment-file.ts';

export interface DocumentWorkerFiles { workerFile: string; pdfModule: string; pdfWorker: string }
export interface ChatDocument { text: string; kind: 'pdf' | 'notebook'; digest: string; bytes: number }
export const DOCUMENT_TIMEOUT_MS = 5000;
export const MAX_DOCUMENT_TEXT = 32_000;

async function extract(document: BoundedDocument, files: DocumentWorkerFiles, signal?: AbortSignal): Promise<ChatDocument> {
	if (signal?.aborted) { throw Error('HARNESS_DOCUMENT_CANCELLED'); }
	return await new Promise<ChatDocument>((resolve, reject) => {
		const worker = new Worker(files.workerFile, {
			workerData: {
				kind: document.kind, bytes: document.bytes,
				pdfModule: files.pdfModule, pdfWorker: files.pdfWorker
			},
			resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }
		});
		let done = false;
		const finish = (error?: Error, result?: string): void => {
			if (done) { return; }
			done = true;
			clearTimeout(timer);
			signal?.removeEventListener('abort', abort);
			worker.removeAllListeners('message');
			worker.removeAllListeners('error');
			worker.removeAllListeners('exit');
			void worker.terminate().catch(() => undefined);
			if (error || !result) { reject(error ?? Error('HARNESS_DOCUMENT_WORKER_FAILED')); }
			else { resolve({ text: result, kind: document.kind, digest: document.digest, bytes: document.bytes.length }); }
		};
		const abort = (): void => finish(Error('HARNESS_DOCUMENT_CANCELLED'));
		const timer = setTimeout(() => finish(Error('HARNESS_DOCUMENT_TIMEOUT')), DOCUMENT_TIMEOUT_MS);
		timer.unref();
		signal?.addEventListener('abort', abort, { once: true });
		if (signal?.aborted) { abort(); return; }
		worker.on('message', (value: unknown) => {
			if (!value || typeof value !== 'object' || Array.isArray(value)) { finish(Error('HARNESS_DOCUMENT_WORKER_FAILED')); return; }
			const reply = value as { text?: unknown; error?: unknown };
			if (typeof reply.error === 'string' && /^HARNESS_[A-Z_]+$/.test(reply.error)) {
				finish(Error(reply.error)); return;
			}
			if (typeof reply.text !== 'string' || !reply.text.trim() || reply.text.length > MAX_DOCUMENT_TEXT) {
				finish(Error('HARNESS_DOCUMENT_WORKER_FAILED')); return;
			}
			finish(undefined, reply.text);
		});
		worker.once('error', () => finish(Error('HARNESS_DOCUMENT_WORKER_FAILED')));
		worker.once('exit', () => finish(Error('HARNESS_DOCUMENT_WORKER_EXIT')));
	});
}

/** Strict path/digest revalidation prevents a document changing after preview/consent. */
export async function extractChatDocument(root: string, file: string, files: DocumentWorkerFiles, signal?: AbortSignal, expectedDigest?: string): Promise<ChatDocument> {
	const document = await readBoundedDocument(root, file);
	if (expectedDigest && expectedDigest !== document.digest) { throw Error('HARNESS_ATTACHMENT_INVALID'); }
	return extract(document, files, signal);
}

export async function chooseChatDocument(root: string, files: DocumentWorkerFiles, host: {
	pick(): Promise<string | undefined>;
	preview(file: string): Promise<void>;
	confirm(info: { kind: 'pdf' | 'notebook'; bytes: number; digest: string }): Promise<boolean>;
}, signal?: AbortSignal): Promise<ChatDocument | undefined> {
	if (signal?.aborted) { throw Error('HARNESS_DOCUMENT_CANCELLED'); }
	const file = await host.pick();
	if (!file) { return undefined; }
	const selected = await readBoundedDocument(root, file);
	await host.preview(file);
	if (signal?.aborted) { throw Error('HARNESS_DOCUMENT_CANCELLED'); }
	if (!await host.confirm({ kind: selected.kind, bytes: selected.bytes.length, digest: selected.digest })) { return undefined; }
	if (signal?.aborted) { throw Error('HARNESS_DOCUMENT_CANCELLED'); }
	return extractChatDocument(root, file, files, signal, selected.digest);
}
