/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Single secret redactor for everything the Harness displays, logs or persists. */

const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\))/g;
const BEARER = /\b(Bearer\s+)[^\s"']+/gi;
/** `key=value`, `key: value` and JSON `"key": "value"`; a quoted value stays quoted so JSON remains valid. */
const ASSIGNMENT = /(["']?(?:token|secret|password|api[_-]?key|access[_-]?key|private[_-]?key|connection[_-]?token)["']?\s*[=:]\s*)("(?:\\.|[^"\\])*(?:"|$)|'[^']*(?:'|$)|[^\s,"'}]+)/gi;
/** Well-known credential shapes that appear without a key name. */
const TOKEN_SHAPES = /\b(?:sk-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|[sr]k_live_[A-Za-z0-9]{16,})\b/g;
/** A password inside a URL's user-info part: it goes, the rest of the address stays readable. */
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)[^\s@/]+(?=@)/gi;
/** A whole PEM private key block, even when it was cut off before its END line. */
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

export function redactSecrets(value: string): string {
	return String(value).replace(ANSI, '').replace(BEARER, '$1[redacted]')
		.replace(ASSIGNMENT, (_, prefix: string, secret: string) => prefix + (secret.startsWith('"') ? '"[redacted]"' : '[redacted]'))
		.replace(TOKEN_SHAPES, '[redacted]').replace(URL_CREDENTIALS, '$1[redacted]').replace(PRIVATE_KEY_BLOCK, '[redacted private key]');
}

/**
 * Bounded, per-stream redaction. Only complete records leave the buffer, so a credential or ANSI
 * sequence split between process chunks cannot leak a prefix. Multiline quoted values and PEM
 * blocks stay together. Oversized records suppress the rest of that stream rather than expose fragments.
 */
export class StreamingSecretRedactor {
	private pending = '';
	private suppressed = false;
	private readonly maxRecordBytes: number;

	constructor(maxRecordBytes = 1024 * 1024) { this.maxRecordBytes = maxRecordBytes; }

	write(text: string): string {
		if (this.suppressed) { return ''; }
		let output = '';
		for (const part of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
			this.pending += part;
			if (Buffer.byteLength(this.pending) > this.maxRecordBytes) {
				this.pending = ''; this.suppressed = true;
				return output + '[redacted oversized output record; remaining stream suppressed]\n';
			}
			if (part.endsWith('\n') && !this.incomplete()) {
				output += redactSecrets(this.pending); this.pending = '';
			}
		}
		return output;
	}

	end(): string {
		const result = redactSecrets(this.pending);
		this.pending = '';
		return result;
	}

	private incomplete(): boolean {
		const text = this.pending.replace(ANSI, '');
		if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text) && !/-----END [A-Z ]*PRIVATE KEY-----/.test(text)) { return true; }
		const assignments = /["']?(?:token|secret|password|api[_-]?key|access[_-]?key|private[_-]?key|connection[_-]?token)["']?\s*[=:]\s*(["'])/gi;
		for (const match of text.matchAll(assignments)) {
			const quote = match[1];
			let closed = false;
			for (let index = match.index + match[0].length; index < text.length; index++) {
				if (quote === '"' && text[index] === '\\') { index++; continue; }
				if (text[index] === quote) { closed = true; break; }
			}
			if (!closed) { return true; }
		}
		return false;
	}
}
