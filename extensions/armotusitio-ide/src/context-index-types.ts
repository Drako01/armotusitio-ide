/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Types for the CommonJS context index; keep runtime module detection unchanged. */
export interface ContextSymbol { path: string; name: string }
export interface ContextSearchOptions { signal?: AbortSignal; symbols?: readonly ContextSymbol[]; limit?: number }
export interface ContextSearchStats { files: number; readFiles: number; cacheHits: number; readBytes: number; contentLimited: boolean }
export interface ContextIndex {
	invalidate(file?: string): void;
	search(query: string, options?: ContextSearchOptions): Promise<{ files: string[]; stats: ContextSearchStats; truncated: boolean }>;
}
