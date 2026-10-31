/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * What is known about an interrupted workflow. A step that finished has a recorded outcome (confirmed);
 * a step that was running when the host stopped may or may not have changed files (uncertain). The IDE never
 * assumes an uncertain operation can be run again: once a writer started, the only safe next steps are to
 * inspect what is in the isolated worktree and to integrate or discard it through the reviewed paths.
 */
import type { WorkflowRecord } from './native-agent-workflow.ts';

export type StepCertainty = 'confirmed' | 'uncertain' | 'not-started';
export type RecoveryAction = 'restart' | 'inspect-worktree' | 'review-and-integrate' | 'discard-worktree';
export interface WorkflowRecoveryAssessment {
	workflowId: string;
	steps: Array<{ id: string; role: string; certainty: StepCertainty }>;
	/** Writers that were interrupted mid-run: their changes, if any, are unknown. */
	uncertainWriters: string[];
	/** Writers that finished: their changes exist and were reported. */
	confirmedWriters: string[];
	/** Restarting from the beginning is safe only while no writer ever started. */
	restartAllowed: boolean;
	actions: RecoveryAction[];
}

function certaintyOf(status: WorkflowRecord['steps'][number]['status']): StepCertainty {
	if (status === 'pending') { return 'not-started'; }
	return status === 'running' || status === 'interrupted' ? 'uncertain' : 'confirmed';
}

export function assessWorkflowRecovery(record: WorkflowRecord): WorkflowRecoveryAssessment {
	const steps = record.steps.map(step => ({ id: step.id, role: step.role, certainty: certaintyOf(step.status) }));
	const writers = steps.filter(step => step.role === 'implementer' && step.certainty !== 'not-started');
	const restartAllowed = writers.length === 0;
	return {
		workflowId: record.id, steps,
		uncertainWriters: writers.filter(step => step.certainty === 'uncertain').map(step => step.id),
		confirmedWriters: writers.filter(step => step.certainty === 'confirmed').map(step => step.id),
		restartAllowed,
		actions: restartAllowed ? ['restart'] : ['inspect-worktree', 'review-and-integrate', 'discard-worktree']
	};
}
