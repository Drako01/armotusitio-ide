/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Goal integrity guards (block M): reject a step that games the metric instead of meeting the goal. Pure functions over a unified diff. */
import { isTestFile } from './native-goal.ts';
import { redactSecrets } from './native-redact.ts';

export interface FilePatch { path: string; added: string[]; removed: string[]; created: boolean }

/** Split `git diff` output into per-file added and removed lines. */
export function parseUnifiedDiff(diff: string): FilePatch[] {
	const files: FilePatch[] = [];
	let current: FilePatch | undefined;
	for (const line of diff.split('\n')) {
		const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
		if (header) { current = { path: header[2], added: [], removed: [], created: false }; files.push(current); continue; }
		if (!current) { continue; }
		if (line.startsWith('new file mode')) { current.created = true; continue; }
		if (line.startsWith('+++') || line.startsWith('---')) { continue; }
		if (line.startsWith('+')) { current.added.push(line.slice(1)); }
		else if (line.startsWith('-')) { current.removed.push(line.slice(1)); }
	}
	return files;
}

const ASSERTION = /\b(t\.(Error|Errorf|Fatal|Fatalf|Fail|FailNow)|assert\w*|require\.\w+|expect\s*\(|should\b|Assert\.\w+|assertThat|self\.assert\w+|pytest\.raises|toBe|toEqual|toThrow|cmp\.Diff|reflect\.DeepEqual|panic\()/;
const TEST_CASE = /^\s*(func\s+(Test|Fuzz)\w*\s*\(|(it|test)\s*\(|def\s+test_\w+|@Test\b|\[(Fact|Theory|Test)\]|it\s+['"])/;
const SKIP = /\bt\.Skip(Now|f)?\s*\(|@(pytest\.mark\.)?skip\b|\b(it|test|describe)\.skip\s*\(|\bx(it|describe)\s*\(|@Disabled\b|\[Ignore\]|\.skip\(/;
const COVERAGE_EXCLUSION = /istanbul ignore|c8 ignore|pragma:\s*no cover|\/\/go:build\s+ignore|#\s*pragma\s+no\s+cover|@codeCoverageIgnore|ExcludeFromCodeCoverage|coverage:\s*ignore/i;
const COVERAGE_CONFIG = /(^|\/)(\.coveragerc|\.nycrc(\.json)?|codecov\.ya?ml|jest\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|\.c8rc(\.json)?|coverage\.(ya?ml|json))$|(^|\/)setup\.cfg$/;
/** A skip that documents a bug keeps its reason next to it. */
const DOCUMENTED = /bug|issue|#\d+|[A-Z]+-\d+|TODO\(|porque|because/i;

export interface GuardOptions { allowProduction: boolean; maxNewSkips?: number }

/** Every reason the step must be rejected; empty when it passes. */
export function checkStepIntegrity(patches: readonly FilePatch[], options: GuardOptions): string[] {
	const reasons: string[] = [];
	let newSkips = 0;
	for (const patch of patches) {
		const test = isTestFile(patch.path);
		if (COVERAGE_CONFIG.test(patch.path)) { reasons.push('coverage-config-changed:' + patch.path); }
		if (patch.added.some(line => COVERAGE_EXCLUSION.test(line))) { reasons.push('coverage-exclusion:' + patch.path); }
		if (!options.allowProduction && !test) { reasons.push('production-change:' + patch.path); }
		if (redactSecrets(patch.added.join('\n')) !== patch.added.join('\n')) { reasons.push('secret-in-diff:' + patch.path); }
		if (!test) { continue; }
		newSkips += patch.added.filter(line => SKIP.test(line) && !DOCUMENTED.test(line)).length - patch.removed.filter(line => SKIP.test(line)).length;
		const addedCases = patch.added.filter(line => TEST_CASE.test(line)).length;
		const addedAssertions = patch.added.filter(line => ASSERTION.test(line)).length;
		if (addedCases > 0 && addedAssertions === 0) { reasons.push('tests-without-assertions:' + patch.path); }
		// Existing tests losing checks: more assertions or cases removed than added back.
		if (!patch.created && (patch.removed.filter(line => ASSERTION.test(line)).length > addedAssertions || patch.removed.filter(line => TEST_CASE.test(line)).length > addedCases)) {
			reasons.push('weakened-tests:' + patch.path);
		}
	}
	if (newSkips > (options.maxNewSkips ?? 0)) { reasons.push('new-skips:' + newSkips); }
	return reasons;
}
