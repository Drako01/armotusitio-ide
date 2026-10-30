/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/** Conservative advisory assessment. No caller can authorize external gates through this report. */
import type { Capability } from './native-engine-contract.ts';
import type { ProjectGateCatalog } from './native-project-gates.ts';

export type HybridGateBlocker =
	| 'project-verification-unreported'
	| 'gate-catalog-unavailable'
	| 'shared-writer-fencing-unverified'
	| 'external-execution-protocol-unverified'
	| 'os-sandbox-unverified';

export interface HybridGateReadiness {
	declarativeReady: boolean;
	executionEnabled: false;
	blockers: HybridGateBlocker[];
	gateCount: number;
}

/** This returns intent metadata, never authority. All effects stay prohibited. */
export function assessHybridGateReadiness(
	reported: readonly Capability[], catalog: ProjectGateCatalog | undefined
): HybridGateReadiness {
	const blockers: HybridGateBlocker[] = [];
	if (!reported.includes('verification-gates')) { blockers.push('project-verification-unreported'); }
	if (!catalog || catalog.executionEnabled !== false || !catalog.gates.length) {
		blockers.push('gate-catalog-unavailable');
	}
	blockers.push('shared-writer-fencing-unverified');
	blockers.push('external-execution-protocol-unverified');
	blockers.push('os-sandbox-unverified');
	return {
		declarativeReady: blockers.every(reason => reason !== 'project-verification-unreported' &&
			reason !== 'gate-catalog-unavailable'),
		executionEnabled: false,
		blockers,
		gateCount: catalog?.gates.length || 0
	};
}
