/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * A small JSON document in private IDE storage shared by several windows: reads are bounded and refuse symlinks, writes are
 * durable and happen under a cross-window lock. A damaged or newer file is reported (`unsafeCode`) and never overwritten.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { withFileLock } from './native-chat.ts';
import { safeStorage, writeDurable } from './native-worktree-checkpoint.ts';

export class LockedJson<T> {
	private readonly directory: string;
	private readonly file: string;
	private readonly maxBytes: number;
	private readonly empty: () => T;
	private readonly valid: (value: unknown) => value is T;
	private readonly unsafeCode: string;

	constructor(directory: string, name: string, maxBytes: number, empty: () => T, valid: (value: unknown) => value is T, unsafeCode: string) {
		this.directory = directory; this.file = path.join(directory, name); this.maxBytes = maxBytes; this.empty = empty; this.valid = valid; this.unsafeCode = unsafeCode;
	}

	async read(): Promise<T> {
		try {
			const stat = await fs.lstat(this.file);
			if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxBytes) { throw Error(this.unsafeCode); }
			const parsed: unknown = JSON.parse(await fs.readFile(this.file, 'utf8'));
			if (!this.valid(parsed)) { throw Error(this.unsafeCode); }
			return parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return this.empty(); }
			throw error instanceof SyntaxError ? Error(this.unsafeCode) : error;
		}
	}

	/** Read-modify-write under the cross-window lock. */
	async update<R>(mutate: (value: T) => Promise<R>): Promise<R> {
		await safeStorage(this.directory);
		return withFileLock(this.file + '.lock', async () => {
			const value = await this.read();
			const result = await mutate(value);
			await writeDurable(this.file, value, false, this.maxBytes);
			return result;
		});
	}
}
