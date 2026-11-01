/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** The goal metric as the IDE measures it (block M), and the signals that stop a goal that no longer makes progress. */
import type { GoalMetric } from './native-goal.ts';

/** Read the metric from the measuring command's output; undefined when the output does not carry it. */
export function parseMetric(parse: GoalMetric['parse'], output: string): number | undefined {
	if (parse === 'go-coverage') {
		// `go tool cover -func`: "total:  (statements)  46.0%"; `go test -cover`: "coverage: 46.0% of statements" (averaged).
		const total = /^total:\s+\(statements\)\s+([\d.]+)%/m.exec(output);
		if (total) { return Number(total[1]); }
		const packages = [...output.matchAll(/coverage:\s+([\d.]+)% of statements/g)].map(match => Number(match[1]));
		return packages.length ? Math.round(packages.reduce((sum, value) => sum + value, 0) / packages.length * 10) / 10 : undefined;
	}
	// coverage.py "TOTAL ... 82%", istanbul "All files | 80.5", or the last percentage printed.
	const known = /^TOTAL\s+.*?([\d.]+)%\s*$/m.exec(output) ?? /^All files\s*\|\s*([\d.]+)/m.exec(output);
	if (known) { return Number(known[1]); }
	const last = [...output.matchAll(/([\d.]+)\s*%/g)].at(-1);
	return last ? Number(last[1]) : undefined;
}

/** Less than half a point of improvement in two consecutive steps (EC-01). */
export function plateaued(history: readonly number[], minimum = 0.5): boolean {
	if (history.length < 3) { return false; }
	const [a, b, c] = history.slice(-3);
	return b - a < minimum && c - b < minimum;
}

/** The same files flipping back and forth between steps (EC-05): A, B, A of the same file sets. */
export function oscillating(stepFiles: ReadonlyArray<readonly string[]>): boolean {
	if (stepFiles.length < 3) { return false; }
	const key = (files: readonly string[]) => [...files].sort().join('\n');
	const [first, , third] = stepFiles.slice(-3).map(key);
	return !!first && first === third && key(stepFiles.at(-2)!) !== first;
}

const CONNECTION = /ECONNREFUSED|connection refused|dial tcp|no such host|getaddrinfo|ETIMEDOUT|could not connect to server|Connection reset|ENOTFOUND|server closed the connection unexpectedly|EHOSTUNREACH/i;
/** A connection error means a service is down, not that the code is broken (EC-55): the agent must not "fix" it. */
export function serviceUnavailable(output: string): boolean { return CONNECTION.test(output); }

/** A test that fails and then passes on retry is flaky (EC-47) and does not block; one that fails every time is real. */
export function classifyRetry(first: 'passed' | 'failed', retry: 'passed' | 'failed'): 'passed' | 'flaky' | 'failed' {
	return first === 'passed' ? 'passed' : retry === 'passed' ? 'flaky' : 'failed';
}
