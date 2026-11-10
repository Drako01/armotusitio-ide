/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *  ArmoTuSitio integration: Alejandro Daniel Di Stefano - ArmoTuSitio.com.ar.
 *--------------------------------------------------------------------------------------------*/
/** Isolated text extraction. Never render, execute cells, fetch documents or include notebook outputs. */
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

interface DocumentWorkerData {
	kind: 'notebook' | 'pdf';
	bytes: Uint8Array;
	pdfModule?: string;
	pdfWorker?: string;
}
const MAX_TEXT = 32_000;
const MAX_PAGES = 20;
const MAX_CELLS = 200;
const request = workerData as DocumentWorkerData;

try {
	let text = '';
	const append = (value: string): void => {
		text += value;
		if (text.length > MAX_TEXT) { throw Error('HARNESS_DOCUMENT_TEXT_LIMIT'); }
	};
	if (request.kind === 'notebook') {
		const notebook: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(request.bytes));
		if (!notebook || typeof notebook !== 'object' || Array.isArray(notebook)) { throw Error('HARNESS_NOTEBOOK_INVALID'); }
		const book = notebook as { nbformat?: unknown; cells?: unknown };
		if (book.nbformat !== 4 || !Array.isArray(book.cells) || book.cells.length > MAX_CELLS) { throw Error('HARNESS_NOTEBOOK_INVALID'); }
		for (const unknownCell of book.cells) {
			if (!unknownCell || typeof unknownCell !== 'object' || Array.isArray(unknownCell)) { throw Error('HARNESS_NOTEBOOK_INVALID'); }
			const cell = unknownCell as { cell_type?: unknown; source?: unknown };
			if (!['code', 'markdown', 'raw'].includes(String(cell.cell_type))) { throw Error('HARNESS_NOTEBOOK_INVALID'); }
			const source = typeof cell.source === 'string' ? cell.source : Array.isArray(cell.source) && cell.source.every(part => typeof part === 'string') ? cell.source.join('') : undefined;
			if (source === undefined) { throw Error('HARNESS_NOTEBOOK_INVALID'); }
			append('[' + cell.cell_type + ']\n' + source + '\n\n');
		}
	} else if (request.kind === 'pdf') {
		const bytes = Buffer.from(request.bytes);
		if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-' || typeof request.pdfModule !== 'string' || typeof request.pdfWorker !== 'string') {
			throw Error('HARNESS_PDF_INVALID');
		}
		const pdfjs = await import(pathToFileURL(request.pdfModule).href);
		pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(request.pdfWorker).href;
		const loading = pdfjs.getDocument({
			data: new Uint8Array(bytes), isEvalSupported: false, useWasm: false,
			disableFontFace: true, useSystemFonts: false, isOffscreenCanvasSupported: false,
			isImageDecoderSupported: false, maxImageSize: 0, useWorkerFetch: false,
			disableRange: true, stopAtErrors: true, disableAutoFetch: true, disableStream: true,
			verbosity: 0
		});
		try {
			const document = await loading.promise;
			if (document.numPages > MAX_PAGES) { throw Error('HARNESS_PDF_PAGE_LIMIT'); }
			for (let number = 1; number <= document.numPages; number++) {
				const page = await document.getPage(number);
				const content = await page.getTextContent();
				const items = content.items as Array<{ str?: unknown; hasEOL?: boolean }>;
				append(items.filter(item => typeof item.str === 'string')
					.map(item => String(item.str) + (item.hasEOL ? '\n' : ' ')).join('') + '\n');
				page.cleanup();
			}
		} finally { await loading.destroy(); }
	} else { throw Error('HARNESS_DOCUMENT_INVALID'); }
	if (!text.trim()) { throw Error('HARNESS_DOCUMENT_NO_TEXT'); }
	parentPort?.postMessage({ text });
} catch (error) {
	const message = error instanceof Error ? error.message : '';
	parentPort?.postMessage({ error: /^HARNESS_[A-Z_]+$/.test(message) ? message : 'HARNESS_DOCUMENT_INVALID' });
}
