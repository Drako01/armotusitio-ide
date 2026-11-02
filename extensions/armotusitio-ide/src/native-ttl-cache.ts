/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Time-bounded async cache with single-flight: concurrent callers of one key share a promise, a fresh value is
 * reused until the TTL expires, and a forced read (or `invalidate`) goes back to the source. It exists so slow
 * local probes (CLI diagnostics) do not respawn a process on every refresh.
 */
export class TtlCache<T> {
	private readonly entries = new Map<string, { value: T; expiresAt: number }>();
	private readonly inflight = new Map<string, Promise<T>>();

	private readonly ttlMs: number;
	private readonly now: () => number;
	private readonly keep: (value: T) => boolean;

	/** `keep` decides whether a loaded value is worth caching (a transient failure should not stick for minutes). */
	constructor(ttlMs: number, now: () => number = Date.now, keep: (value: T) => boolean = () => true) {
		this.ttlMs = ttlMs;
		this.now = now;
		this.keep = keep;
	}

	/** Fresh cached value, the in-flight load, or a new load. `force` skips a cached value but still joins an in-flight forced load. */
	get(key: string, load: () => Promise<T>, force = false): Promise<T> {
		const cached = this.entries.get(key);
		if (!force && cached && cached.expiresAt > this.now()) { return Promise.resolve(cached.value); }
		const running = this.inflight.get(key);
		if (running) { return running; }
		const pending = load().then(value => {
			// An invalidation during the load wins: the value may predate the change.
			if (this.inflight.get(key) === pending && this.keep(value)) { this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs }); }
			return value;
		}).finally(() => { if (this.inflight.get(key) === pending) { this.inflight.delete(key); } });
		this.inflight.set(key, pending);
		return pending;
	}

	/** Drop one key, or everything, including loads in flight (their result is not stored). */
	invalidate(key?: string): void {
		if (key === undefined) { this.entries.clear(); this.inflight.clear(); } else { this.entries.delete(key); this.inflight.delete(key); }
	}
}
