/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/* Native Harness IDE commands. Never execute project scripts merely by detecting them. */
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { NativeHarness, type Plan } from './native-harness.ts';
import { proposeProjectConfig, loadProjectConfig, writeProjectConfig, generatedConfigDigest, removeGeneratedProjectConfig } from './native-project.ts';
import { reviewAgentDraft, inspectAgentWorkspace, type NativeProvider, type AgentRole } from './native-providers.ts';
import { buildSupportReport, exportSupportReport } from './native-support.ts';
import { inspectHarnessAuthority } from './native-authority.ts';
import { listProjectSkills, readProjectSkill, type ProjectSkill } from './native-project-skills.ts';
import { listProjectGuides, validateProjectGuides } from './native-project-guidance.ts';
import { readProjectGateCatalog, validateProjectGateCatalog, planProjectGateWaves } from './native-project-gates.ts';
import { assessHybridGateReadiness } from './native-hybrid-readiness.ts';
import { buildAgentInvocation, executeReviewedAgent, type AgentExecution } from './native-agent-execution.ts';
import { readAgentStatistics, recordAgentMetric } from './native-agent-metrics.ts';
import { NativeAgentWorkflow, proposedWorkflow, workflowDigest, type WorkflowRun } from './native-agent-workflow.ts';
import { createAgentWorktree, removeCleanAgentWorktree, listAgentWorktrees, type ManagedWorktree } from './native-agent-worktree.ts';
import { describeEngine, probeProjectHandshake, compareHybridCapabilities, verifiedNativeCapabilities } from './native-engine-contract.ts';
import { diagnoseProvider } from './native-provider-diagnostics.ts';
import { summarizeGatePerformance } from './native-performance.ts';
import { acquireSharedExecutionFence, inspectSharedExecutionFence, reconcileSharedExecutionFence, type SharedExecutionFence } from './native-shared-fence.ts';
import { createWorktreeCheckpoint, rollbackWorktreeCheckpoint, type WorktreeCheckpoint } from './native-worktree-checkpoint.ts';
import { queryProjectEngineStatus } from './native-engine-interop.ts';

type Host = any; // vscode host is injected by the existing extension (avoid duplicating the UI layer).
const sessions = new Map<string, NativeHarness>();

export function registerNativeHarness(context: Host, vscode: Host, controller: Host): void {
	const choose = async (requested?: string, allowProjectAgent = false): Promise<{ folder: Host; engine: NativeHarness } | undefined> => {
		const roots = vscode.workspace.workspaceFolders || [];
		if (!roots.length) { vscode.window.showWarningMessage(vscode.l10n.t('Abr\u00ed una carpeta para utilizar el Harness nativo.')); return; }
		const folder = requested ? roots.find((f: Host) => f.uri.fsPath === requested) : roots.length === 1 ? roots[0] : (await vscode.window.showQuickPick(roots.map((f: Host) => ({ label: f.name, description: f.uri.fsPath, folder: f })), { placeHolder: 'Eleg\u00ed el proyecto' }))?.folder;
		if (!folder) { return; }
		const root = await fs.realpath(folder.uri.fsPath);
		// Project tools own their task state; IDE agents may complement them read-only.
		const authority = await inspectHarnessAuthority(root);
		if (authority.reason === 'project-path-unsafe') { throw Error('HARNESS_PROJECT_AUTHORITY_UNSAFE'); }
		if (authority.engine === 'project' && !allowProjectAgent) { vscode.window.showInformationMessage(vscode.l10n.t('El Harness del proyecto mantiene sus tareas. Los agentes del IDE requieren interoperabilidad expl\u00edcita.')); return; }
		const hash = createHash('sha256').update(root).digest('hex');
		const engine = sessions.get(root) || new NativeHarness(root, path.join(context.globalStorageUri.fsPath, 'native-harness', hash));
		sessions.set(root, engine); return { folder, engine };
	};
	const ensureTrust = (): boolean => vscode.workspace.isTrusted === true && vscode.workspace.getConfiguration('atsHarness').get('enabled', true);
	const authorized = (folder: Host): boolean => ensureTrust() && (vscode.workspace.workspaceFolders || []).some((current: Host) => current.uri.toString() === folder.uri.toString());
	const running = new Map<string, { engine: NativeHarness; taskId: string }>();
	const runningAgents = new Map<string, AgentExecution>();
	const pendingAgents = new Set<string>();
	const runningWorkflows = new Map<string, WorkflowRun>();
	const pendingWorkflows = new Set<string>();
	// Local backpressure: an IDE window may run at most two provider-intensive operations.
	const maxConcurrentProviders = 2;
	const providerSlots = (): number => runningAgents.size + pendingAgents.size + runningWorkflows.size + pendingWorkflows.size;
	const assertProviderCapacity = (): void => { if (providerSlots() >= maxConcurrentProviders) { throw Error('HARNESS_PROVIDER_CAPACITY_REACHED'); } };
	const metricsDirectory = (root: string): string => path.join(context.globalStorageUri.fsPath, 'native-harness', createHash('sha256').update(root).digest('hex'));
	controller.nativeRunning = () => running.size + runningAgents.size + pendingAgents.size + runningWorkflows.size + pendingWorkflows.size;
	controller.nativeProjects = async () => {
		const rows = [];
		if (!vscode.workspace.getConfiguration('atsHarness').get('enabled', true)) { return rows; }
		for (const folder of vscode.workspace.workspaceFolders || []) {
			try {
				if ((await inspectHarnessAuthority(folder.uri.fsPath)).engine === 'project') { continue; }
				const selected = await choose(folder.uri.fsPath);
				if (!selected) { continue; }
				const tasks = ensureTrust() ? await selected.engine.list() : [];
				const diagnostic = ensureTrust() ? await selected.engine.diagnose() : undefined;
				const configured = ensureTrust() ? !!await loadProjectConfig(folder.uri.fsPath) : false;
				const workflows = ensureTrust() ? await new NativeAgentWorkflow(folder.uri.fsPath, path.join(metricsDirectory(folder.uri.fsPath), 'workflows')).history().catch(() => []) : [];
				const agentMetrics = ensureTrust() ? await readAgentStatistics(metricsDirectory(folder.uri.fsPath)).catch(() => null) : null;
				const engineContract = await describeEngine(folder.uri.fsPath);
				rows.push({ root: folder.uri.fsPath, name: folder.name, engine: 'ide-native', configured, lock: diagnostic?.lock, engineContract: { version: engineContract.schemaVersion, supported: engineContract.supported, unavailable: engineContract.unavailable }, workflows: workflows.slice(0, 5).map(w => ({ id: w.id, status: w.status, verification: w.verification, steps: w.steps.map(step => ({ id: step.id, status: step.status })) })), agentMetrics: agentMetrics ? { count: agentMetrics.count, successRate: agentMetrics.successRate, p95DurationMs: agentMetrics.p95DurationMs, usageSamples: agentMetrics.usageSamples, measuredInputTokens: agentMetrics.measuredInputTokens, measuredOutputTokens: agentMetrics.measuredOutputTokens, estimatedCostUsd: agentMetrics.estimatedCostUsd } : null, gatePerformance: summarizeGatePerformance(tasks), agentActive: runningAgents.has(folder.uri.fsPath) || runningWorkflows.has(folder.uri.fsPath), tasks: tasks.sort((a, b) => Number(b.attempts.at(-1)?.status === 'running') - Number(a.attempts.at(-1)?.status === 'running')).slice(0, 100).map(task => ({ id: task.id, title: task.title, status: task.attempts.at(-1)?.status || 'pending', attempts: task.attempts.length, gates: task.plan.gates.map(gate => ({ id: gate.id, dependsOn: gate.dependsOn || [], status: task.attempts.at(-1)?.results.find(result => result.id === gate.id)?.status || 'pending' })), reconciliationRequired: task.attempts.at(-1)?.status === 'running' && (diagnostic?.lock !== 'active' || diagnostic?.lockTask !== task.id || diagnostic?.lockAttempt !== task.attempts.at(-1)?.id) })) });
			} catch { rows.push({ root: folder.uri.fsPath, name: folder.name, engine: 'ide-native', error: true, tasks: [] }); }
		}
		return rows;
	};
	const ticker = setInterval(() => { if (running.size || providerSlots()) { controller.refresh(); } }, 1500);
	context.subscriptions.push({ dispose: () => clearInterval(ticker) });
	const showError = (e: unknown): void => { const code = e instanceof Error && /^HARNESS_[A-Z_]+$/.test(e.message) ? e.message : 'HARNESS_OPERATION_FAILED'; void vscode.window.showErrorMessage(vscode.l10n.t('Harness nativo: {0}. Revis\u00e1 el diagn\u00f3stico y la configuraci\u00f3n.', code)); };
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeAgentReview', async (requested?: string) => {
		try {
			if (!ensureTrust()) { vscode.window.showWarningMessage(vscode.l10n.t('Workspace trust is required to prepare agents.')); return; }
			const chosen = await choose(requested, true);
			if (!chosen) { return; }
			const root = await fs.realpath(chosen.folder.uri.fsPath);
			const provider = await vscode.window.showQuickPick(['codex', 'claude'], { title: 'Select AI provider (review only)' }) as NativeProvider | undefined;
			if (!provider) { return; }
			const role = await vscode.window.showQuickPick(['planner', 'implementer', 'reviewer'], { title: 'Select agent role' }) as AgentRole | undefined;
			if (!role) { return; }
			const instruction = await vscode.window.showInputBox({ title: 'Agent instruction (not submitted to the provider)', prompt: 'Describe the proposed task. No AI execution will occur.' });
			if (!instruction) { return; }
			const readOnly = role !== 'implementer';
			const projectHarness = (await inspectHarnessAuthority(root)).engine === 'project';
			if (projectHarness && !readOnly) { throw Error('HARNESS_HYBRID_WRITER_UNAVAILABLE'); }
			const skills = await listProjectSkills(root);
			const guides = await listProjectGuides(root);
			const preview = { skills: skills.map(skill => ({ name: skill.name, source: skill.source, digest: skill.digest })), guides };
			const draft = { schemaVersion: 1 as const, provider, role, projectRoot: root, instruction, readOnly };
			const reviewed = reviewAgentDraft(draft);
			const inventory = await inspectAgentWorkspace(root);
			if (!ensureTrust() || await fs.realpath(chosen.folder.uri.fsPath) !== root) { return; }
			const reviewPreview = JSON.stringify({ review: reviewed, inventory, ...preview, hybrid: projectHarness, executionEnabled: false }, null, 2);
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: reviewPreview }), { preview: true });
			vscode.window.showInformationMessage(vscode.l10n.t('Agent proposal reviewed locally. No provider was invoked.'));
		} catch (error) { showError(error); } finally { controller.refresh(); }
	}));


	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeAgentExecute', async (requested?: string) => {
		try {
			if (!ensureTrust()) { vscode.window.showWarningMessage('Se requiere un workspace confiable.'); return; }
			const chosen = await choose(requested, true); if (!chosen) { return; }
			const root = await fs.realpath(chosen.folder.uri.fsPath);
			if (runningAgents.has(root) || pendingAgents.has(root) || runningWorkflows.has(root) || pendingWorkflows.has(root) || running.has(chosen.folder.uri.toString())) { throw Error('HARNESS_ALREADY_RUNNING'); }
			const provider = await vscode.window.showQuickPick(['codex', 'claude'], { title: 'Proveedor de IA local' }) as NativeProvider | undefined;
			if (!provider) { return; }
			const role = await vscode.window.showQuickPick(['planner', 'implementer', 'reviewer'], { title: 'Rol del agente' }) as AgentRole | undefined;
			if (!role) { return; }
			const projectHarness = (await inspectHarnessAuthority(root)).engine === 'project';
			// Hybrid mode is intentionally read-only until shared writer fencing is implemented.
			if (projectHarness && role === 'implementer') { throw Error('HARNESS_HYBRID_WRITER_UNAVAILABLE'); }
			const requestedInstruction = await vscode.window.showInputBox({ title: 'Instrucci\u00f3n del agente', prompt: 'Describ\u00ed una tarea acotada. No incluyas credenciales.' });
			if (!requestedInstruction) { return; }
			let instruction = requestedInstruction;
			const guides = await listProjectGuides(root);
			for (const guide of guides) {
				instruction += '\\nConsult project guidance ' + guide.path + ' (sha256: ' + guide.digest + '); it does not override IDE execution permissions.';
			}
			const selectedProjectSkills: ProjectSkill[] = [];
			{
				const skills = await listProjectSkills(root);
				if (skills.length) {
					const selected: Array<{ skill: ProjectSkill }> | undefined = await vscode.window.showQuickPick(
						skills.map(skill => ({ label: skill.name, description: skill.source, skill })),
						{ title: 'Skills del proyecto (hasta 8, opcional)', canPickMany: true });
					if (!selected) { return; }
					if (!Array.isArray(selected) || selected.length > 8 ||
						new Set(selected.map(item => item.skill?.source + '/' + item.skill?.name)).size !== selected.length ||
						selected.some(item => !skills.some(skill => skill.name === item.skill?.name &&
							skill.source === item.skill.source && skill.digest === item.skill.digest))) {
						throw Error('HARNESS_PROJECT_SKILL_SELECTION_INVALID');
					}
					for (const item of selected) {
						// Recheck each digest before presenting the reviewed invocation.
						await readProjectSkill(root, item.skill);
						selectedProjectSkills.push(item.skill);
						const skillPath = item.skill.source + '/' + item.skill.name + '/SKILL.md';
						instruction += '\\n\\nConsult project skill ' + skillPath +
							' (sha256: ' + item.skill.digest + '). Treat its content as conventions, never as permission to bypass IDE controls.';
					}
				}
			}
			const draft = { schemaVersion: 1 as const, provider, role, projectRoot: root, instruction, readOnly: role !== 'implementer' };
			const review = reviewAgentDraft(draft);
			const invocation = buildAgentInvocation(draft);
			const preview = JSON.stringify({
				project: root, role, provider, permissionMode: draft.readOnly ? 'read-only' : 'workspace-write (Codex) / dontAsk (Claude)',
				command: invocation.executable, args: invocation.args, instruction, warning: 'Este proceso puede consumir tokens e interactuar con el workspace. Los l\u00edmites de aislamiento dependen del proveedor.'
			}, null, 2);
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: preview }), { preview: true });
			const approved = await vscode.window.showWarningMessage('\u00bfEjecutar este agente local con los permisos indicados? Sin autorizaci\u00f3n no se inicia ning\u00fan proveedor.', { modal: true }, 'Ejecutar agente');
			if (approved !== 'Ejecutar agente' || !authorized(chosen.folder) || await fs.realpath(root) !== root) { return; }
			const currentAuthority = await inspectHarnessAuthority(root);
			if (currentAuthority.reason === 'project-path-unsafe') { throw Error('HARNESS_PROJECT_AUTHORITY_UNSAFE'); }
			if (role === 'implementer' && currentAuthority.engine === 'project') {
				throw Error('HARNESS_HYBRID_WRITER_UNAVAILABLE');
			}
			if (currentAuthority.engine !== (projectHarness ? 'project' : 'ide-native')) {
				throw Error('HARNESS_PROJECT_AUTHORITY_CHANGED');
			}
			await validateProjectGuides(root, guides);
			for (const skill of selectedProjectSkills) { await readProjectSkill(root, skill); }
			if (runningAgents.has(root) || pendingAgents.has(root) || runningWorkflows.has(root) || pendingWorkflows.has(root) || running.has(chosen.folder.uri.toString())) { throw Error('HARNESS_ALREADY_RUNNING'); }
			assertProviderCapacity();
			// Reserve the project before the async provider lookup to prevent parallel launches.
			pendingAgents.add(root); controller.refresh();
			let execution: AgentExecution;
			let fence: SharedExecutionFence | undefined;
			try {
				fence = await acquireSharedExecutionFence(root, metricsDirectory(root), 'native-agent');
				await fence.assertCurrent();
				execution = await executeReviewedAgent(review, draft);
			} catch (error) {
				if (fence) { await fence.release(); }
				throw error;
			} finally { pendingAgents.delete(root); }
			runningAgents.set(root, execution); controller.refresh();
			try {
				const result = await execution.outcome;
				try { await recordAgentMetric(metricsDirectory(root), provider, role, result); }
				catch { void vscode.window.showWarningMessage('No se pudo registrar la m\u00e9trica local del agente.'); }
				if (!authorized(chosen.folder)) { return; }
				await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({
					language: 'json',
					content: JSON.stringify({ role, provider, ...result }, null, 2)
				}), { preview: true });
				vscode.window.showInformationMessage('Agente finalizado: ' + result.status);
			} finally { runningAgents.delete(root); await fence.release(); controller.refresh(); }
		} catch (error) { showError(error); } finally { controller.refresh(); }
	}));


	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeAgentWorkflow', async (requested?: string) => {
		let root: string | undefined;
		let isolation: ManagedWorktree | undefined;
		let launched = false;
		try {
			if (!ensureTrust()) { vscode.window.showWarningMessage('Se requiere un workspace confiable.'); return; }
			const chosen = await choose(requested); if (!chosen) { return; }
			root = await fs.realpath(chosen.folder.uri.fsPath);
			if (runningAgents.has(root) || pendingAgents.has(root) || runningWorkflows.has(root) || pendingWorkflows.has(root) || running.has(chosen.folder.uri.toString())) {
				throw Error('HARNESS_ALREADY_RUNNING');
			}
			const provider = await vscode.window.showQuickPick(['codex', 'claude'], { title: 'Proveedor para el workflow multiagente' }) as NativeProvider | undefined;
			if (!provider) { return; }
			const reviewerMode = await vscode.window.showQuickPick([
				{ label: 'Mismo proveedor en todas las fases', value: 'same' },
				{ label: 'Revisi\u00f3n cruzada con el otro proveedor', value: 'cross' }
			], { title: 'Independencia del agente revisor' });
			if (!reviewerMode) { return; }
			const reviewerProvider: NativeProvider = reviewerMode.value === 'cross' ? (provider === 'codex' ? 'claude' : 'codex') : provider;
			const instruction = await vscode.window.showInputBox({ title: 'Objetivo del workflow (plan \u2192 implementaci\u00f3n \u2192 revisi\u00f3n)', prompt: 'Describ\u00ed el alcance espec\u00edfico; no ingreses secretos.' });
			if (!instruction) { return; }
			const mode = await vscode.window.showQuickPick([
				{ label: 'Git worktree aislado (recomendado)', value: 'worktree' },
				{ label: 'Workspace actual (sin aislamiento)', value: 'direct' }
			], { title: 'D\u00f3nde permitir modificaciones del implementador' });
			if (!mode) { return; }
			let executionRoot = root;
			if (mode.value === 'worktree') {
				if (await vscode.window.showWarningMessage('Crear un Git worktree desacoplado de tu checkout? Puede necesitar instalar dependencias. No modifica main ni realiza commits.', { modal: true }, 'Crear worktree') !== 'Crear worktree') { return; }
				if (!authorized(chosen.folder)) { return; }
				isolation = await createAgentWorktree(root, path.join(metricsDirectory(root), 'isolated-worktrees'));
				executionRoot = isolation.root;
			}
			const plan = proposedWorkflow(provider, instruction);
			plan.handoffs.find(h => h.id === 'review')!.provider = reviewerProvider;
			const digest = workflowDigest(executionRoot, plan);
			const verification = (await loadProjectConfig(root))?.plan;
			const verificationSnapshot = JSON.stringify(verification || null);
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({
				language: 'json',
				content: JSON.stringify({
					project: root, executionRoot, isolationMode: mode.value, handoffs: plan.handoffs, maxCorrectiveCycles: 1, maxProviderCalls: 5, verification: verification || 'NOT_CONFIGURED', digest,
					notice: mode.value === 'worktree' ? 'La IA operar\u00e1 \u00fanicamente en este checkout Git separado; se conservar\u00e1 despu\u00e9s para revisar los cambios. No se hace commit ni merge.' : 'La IA operar\u00e1 sobre el workspace actual sin aislamiento de archivos. No se hace commit ni merge.'
				}, null, 2)
			}), { preview: true });
			const approved = await vscode.window.showWarningMessage('Autorizar plan, implementaci\u00f3n, revisi\u00f3n y hasta un ciclo correctivo adicional (m\u00e1ximo 5 invocaciones de IA)? Revis\u00e1 el plan antes de continuar.', { modal: true }, 'Autorizar workflow');
			if (approved !== 'Autorizar workflow' || !authorized(chosen.folder) || await fs.realpath(chosen.folder.uri.fsPath) !== root) { return; }
			if (runningAgents.has(root) || pendingAgents.has(root) || runningWorkflows.has(root) || pendingWorkflows.has(root) || running.has(chosen.folder.uri.toString())) {
				throw Error('HARNESS_ALREADY_RUNNING');
			}
			if (JSON.stringify((await loadProjectConfig(root))?.plan || null) !== verificationSnapshot) { throw Error('HARNESS_WORKFLOW_VERIFICATION_CHANGED'); }
			assertProviderCapacity();
			pendingWorkflows.add(root); controller.refresh();
			const engine = new NativeAgentWorkflow(executionRoot, path.join(metricsDirectory(root), 'workflows'), root);
			const unsubscribeEvents = engine.onEvent(() => { controller.refresh(); });
			const validationEngine = isolation ? new NativeHarness(executionRoot, path.join(metricsDirectory(root), 'isolated-verification', isolation.id)) : chosen.engine;
			let checkpoint: WorktreeCheckpoint | undefined;
			let run: WorkflowRun;
			try {
				run = await engine.start(plan, digest, () => authorized(chosen.folder), verification ? async signal => {
					const task = await validationEngine.create('Workflow verification', verification);
					const approval = await validationEngine.reviewDigest(task.plan);
					const result = await validationEngine.execute(task.id, approval, () => authorized(chosen.folder), signal, engine.activeFence());
					return result.attempts.at(-1)?.status === 'passed';
				} : undefined, async (stageProvider, stageRole, stageOutcome) => {
					await recordAgentMetric(metricsDirectory(root!), stageProvider, stageRole, stageOutcome);
				}, async fence => {
					if (isolation) {
						checkpoint = await createWorktreeCheckpoint(isolation, path.join(metricsDirectory(root!), 'checkpoints'), fence);
					}
				});
			}
			finally { pendingWorkflows.delete(root); }
			launched = true;
			runningWorkflows.set(root, run); controller.refresh();
			try {
				const outcome = await run.result;
				if (authorized(chosen.folder)) {
					await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify({ ...outcome, ...(checkpoint ? { checkpointId: checkpoint.id } : {}) }, null, 2) }), { preview: true });
					vscode.window.showInformationMessage('Workflow multiagente finalizado: ' + outcome.status + (isolation ? '. Worktree conservado: ' + isolation.root : ''));
				}
			} finally { unsubscribeEvents(); runningWorkflows.delete(root); controller.refresh(); }
		} catch (error) { showError(error); }
		finally {
			if (root) { pendingWorkflows.delete(root); }
			if (isolation && !launched) {
				try { await removeCleanAgentWorktree(isolation); }
				catch { void vscode.window.showWarningMessage('El worktree no se pudo retirar autom\u00e1ticamente. Revis\u00e1 git worktree list.'); }
			}
			controller.refresh();
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeWorkflowHistory', async (requested?: string) => {
		try {
			if (!ensureTrust()) { return; }
			const chosen = await choose(requested); if (!chosen) { return; }
			const root = await fs.realpath(chosen.folder.uri.fsPath);
			const workflow = new NativeAgentWorkflow(root, path.join(metricsDirectory(root), 'workflows'));
			const pendingJournalIds = await workflow.pendingJournalIds();
			const history = pendingJournalIds.length ? {
				status: runningWorkflows.has(root) ? 'write-in-progress' : 'recovery-required',
				executionEnabled: false, pendingJournalIds,
				note: runningWorkflows.has(root)
					? 'Se est\u00e1 persistiendo una transici\u00f3n del workflow. No implica recuperaci\u00f3n mientras siga activo.'
					: 'Hay escrituras inciertas. Reconciliar expl\u00edcitamente; nunca repetir agentes ni eliminar evidencia autom\u00e1ticamente.'
			} : await workflow.history();
			if (!authorized(chosen.folder)) { return; }
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(history, null, 2) }), { preview: true });
		} catch (error) { showError(error); }
	}));


	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeWorktreeCleanup', async (requested?: string) => {
		try {
			if (!ensureTrust()) { return; }
			const chosen = await choose(requested); if (!chosen) { return; }
			const root = await fs.realpath(chosen.folder.uri.fsPath);
			if (runningWorkflows.has(root) || pendingWorkflows.has(root)) { throw Error('HARNESS_WORKFLOW_ALREADY_RUNNING'); }
			const storage = path.join(metricsDirectory(root), 'isolated-worktrees');
			const list = await listAgentWorktrees(root, storage);
			if (!list.length) { vscode.window.showInformationMessage('No hay Git worktrees administrados por el Harness.'); return; }
			const selected = await vscode.window.showQuickPick(list.map(worktree => ({ label: worktree.id, description: worktree.root, worktree })), { title: 'Retirar \u00fanicamente un worktree limpio' });
			if (!selected) { return; }
			if (await vscode.window.showWarningMessage('Eliminar el worktree ' + selected.worktree.root + '? Se rechazar\u00e1 si contiene cambios.', { modal: true }, 'Retirar worktree limpio') !== 'Retirar worktree limpio') { return; }
			if (!authorized(chosen.folder)) { return; }
			await removeCleanAgentWorktree(selected.worktree);
			vscode.window.showInformationMessage('Worktree limpio retirado.');
		} catch (error) { showError(error); } finally { controller.refresh(); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeWorktreeRollback', async (requested?: string) => {
		try {
			if (!ensureTrust()) { throw Error('HARNESS_UNTRUSTED_WORKSPACE'); }
			const chosen = await choose(requested); if (!chosen) { return; }
			const root = await fs.realpath(chosen.folder.uri.fsPath);
			if (runningAgents.has(root) || pendingAgents.has(root) || runningWorkflows.has(root) ||
				pendingWorkflows.has(root) || running.has(chosen.folder.uri.toString())) {
				throw Error('HARNESS_ALREADY_RUNNING');
			}
			const worktrees = await listAgentWorktrees(root, path.join(metricsDirectory(root), 'isolated-worktrees'));
			if (!worktrees.length) { vscode.window.showInformationMessage('No hay worktrees administrados para recuperar.'); return; }
			const chosenWorktree = await vscode.window.showQuickPick(
				worktrees.map(worktree => ({ label: worktree.id, description: worktree.root, worktree })),
				{ title: 'Worktree administrado para rollback expl\u00edcito' });
			if (!chosenWorktree) { return; }
			const checkpointDir = path.join(metricsDirectory(root), 'checkpoints');
			const entries = await fs.readdir(checkpointDir, { withFileTypes: true }).catch(error => {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; }
				throw error;
			});
			if (entries.length > 500) { throw Error('HARNESS_CHECKPOINT_HISTORY_TOO_LARGE'); }
			const ids = entries.filter(entry => entry.isFile() && !entry.isSymbolicLink() &&
				/^[a-f0-9-]{36}\.json$/i.test(entry.name)).map(entry => entry.name.slice(0, -5));
			if (!ids.length) { vscode.window.showInformationMessage('No hay checkpoints para recuperar.'); return; }
			const id = await vscode.window.showQuickPick(ids, { title: 'Seleccion\u00e1 el checkpoint del worktree' });
			if (!id) { return; }
			const confirmation = await vscode.window.showWarningMessage(
				'ROLLBACK DESTRUCTIVO: descartar cambios rastreados y archivos nuevos NO ignorados solo en ' +
				chosenWorktree.worktree.root + '. No modifica el checkout principal. \u00bfConfirmar?',
				{ modal: true }, 'Revertir worktree');
			if (confirmation !== 'Revertir worktree' || !authorized(chosen.folder)) { return; }
			const fence = await acquireSharedExecutionFence(root, metricsDirectory(root), 'native-workflow');
			try {
				const result = await rollbackWorktreeCheckpoint(chosenWorktree.worktree, checkpointDir, id, fence, true);
				vscode.window.showInformationMessage('Rollback de worktree completado: ' + result.id);
			} finally { await fence.release(); }
		} catch (error) { showError(error); } finally { controller.refresh(); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeWorkflowReconcile', async (requested?: string) => {
		try {
			if (!ensureTrust()) { return; }
			const chosen = await choose(requested); if (!chosen) { return; }
			const root = await fs.realpath(chosen.folder.uri.fsPath);
			if (runningWorkflows.has(root) || pendingWorkflows.has(root)) { throw Error('HARNESS_WORKFLOW_ALREADY_RUNNING'); }
			if (await vscode.window.showWarningMessage('Marcar workflows interrumpidos sin repetir agentes ni modificar archivos?', { modal: true }, 'Reconciliar workflows') !== 'Reconciliar workflows') { return; }
			if (!authorized(chosen.folder)) { return; }
			const workflow = new NativeAgentWorkflow(root, path.join(metricsDirectory(root), 'workflows'));
			const updated = await workflow.reconcile();
			vscode.window.showInformationMessage('Workflows reconciliados: ' + updated);
		} catch (error) { showError(error); } finally { controller.refresh(); }
	}));


	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeSharedFenceReconcile', async (requested?: string) => {
		try {
			if (!ensureTrust()) { throw Error('HARNESS_UNTRUSTED_WORKSPACE'); }
			const chosen = await choose(requested); if (!chosen) { return; }
			const root = await fs.realpath(chosen.folder.uri.fsPath);
			if ((await inspectHarnessAuthority(root)).engine === 'project') { throw Error('HARNESS_PROJECT_AUTHORITY'); }
			if (runningAgents.has(root) || pendingAgents.has(root) || runningWorkflows.has(root) ||
				pendingWorkflows.has(root) || running.has(chosen.folder.uri.toString())) {
				throw Error('HARNESS_ALREADY_RUNNING');
			}
			const storage = metricsDirectory(root);
			const current = await inspectSharedExecutionFence(root, storage);
			if (!current.held) {
				vscode.window.showInformationMessage('No hay un fence compartido pendiente.');
				return;
			}
			const approved = await vscode.window.showWarningMessage(
				'Recuperacion conservadora del fence compartido. Primero reconcilia tareas y workflows; ' +
				'se rechaza cualquier propietario vivo, estado incierto o rollback incompleto. ' +
				'No se reejecutan procesos ni se eliminan cambios del proyecto. Continuar?',
				{ modal: true }, 'Reconciliar fence');
			if (approved !== 'Reconciliar fence' || !authorized(chosen.folder)) { return; }
			const outcome = await reconcileSharedExecutionFence(root, storage, true);
			vscode.window.showInformationMessage(outcome.released
				? 'Fence compartido reconciliado: epoch ' + outcome.epoch
				: 'No habia un fence compartido para recuperar.');
		} catch (error) { showError(error); } finally { controller.refresh(); }
	}));

	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeProjectHandshake', async (requested?: string) => {
		try {
			if (!ensureTrust()) { throw Error('HARNESS_UNTRUSTED_WORKSPACE'); }
			const folders = vscode.workspace.workspaceFolders || [];
			const selected = requested ? folders.find((folder: Host) => folder.uri.fsPath === requested) :
				folders.length === 1 ? folders[0] :
					(await vscode.window.showQuickPick(folders.map((folder: Host) => ({ label: folder.name, description: folder.uri.fsPath, folder })), { placeHolder: 'Eleg\u00ed el Harness externo a verificar' }))?.folder;
			if (!selected || !authorized(selected)) { return; }
			const root = await fs.realpath(selected.uri.fsPath);
			const descriptor = await describeEngine(root);
			if (descriptor.engine !== 'project') { throw Error('HARNESS_HANDSHAKE_NOT_PROJECT'); }
			const confirmed = await vscode.window.showWarningMessage(
				'Esta prueba ejecutar\u00e1 expl\u00edcitamente la entrada Node del Harness del proyecto para negociar capacidades. No concede permisos de escritura ni valida el sandbox. \u00bfContinuar?',
				{ modal: true }, 'Ejecutar handshake');
			if (confirmed !== 'Ejecutar handshake' || !authorized(selected)) { return; }
			const gates = await readProjectGateCatalog(root);
			const handshake = await probeProjectHandshake(root, () => authorized(selected));
			if (gates) { await validateProjectGateCatalog(root, gates.digest); }
			if (!authorized(selected)) { return; }
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({
				language: 'json',
				content: JSON.stringify({
					project: root, declared: descriptor.projectDeclared, handshake,
					comparison: compareHybridCapabilities(verifiedNativeCapabilities(), handshake.reported),
					gateCatalog: gates || null, simulatedGateWaves: gates ? planProjectGateWaves(gates) : [],
					gateReadiness: assessHybridGateReadiness(handshake.reported, gates), executionEnabled: false,
					note: 'Capacidades reportadas por proceso externo, no demostradas por E2E ni autorizadas para ejecutar operaciones.'
				}, null, 2)
			}), { preview: true });
		} catch (error) { showError(error); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeProjectStatus', async (requested?: string) => {
		try {
			if (!ensureTrust()) { throw Error('HARNESS_UNTRUSTED_WORKSPACE'); }
			const folders = vscode.workspace.workspaceFolders || [];
			const selected = requested ? folders.find((folder: Host) => folder.uri.fsPath === requested) :
				folders.length === 1 ? folders[0] :
					(await vscode.window.showQuickPick(folders.map((folder: Host) => ({
						label: folder.name, description: folder.uri.fsPath, folder
					})), { placeHolder: 'Eleg\u00ed el Harness externo' }))?.folder;
			if (!selected || !authorized(selected)) { return; }
			const root = await fs.realpath(selected.uri.fsPath);
			if ((await inspectHarnessAuthority(root)).engine !== 'project') { throw Error('HARNESS_PROJECT_STATUS_NOT_PROJECT'); }
			const confirmation = await vscode.window.showWarningMessage(
				'Consultar estado ejecuta c\u00f3digo del Harness del proyecto bajo tu usuario. El protocolo limita la respuesta, pero NO impone aislamiento OS ni permite escrituras h\u00edbridas. \u00bfContinuar?',
				{ modal: true }, 'Consultar estado externo');
			if (confirmation !== 'Consultar estado externo' || !authorized(selected)) { return; }
			const status = await queryProjectEngineStatus(root, true, () => authorized(selected));
			if (!authorized(selected)) { return; }
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({
				language: 'json',
				content: JSON.stringify({
					project: root, ...status,
					note: 'Observaci\u00f3n declarada por el motor del proyecto, sin autoridad para ejecutar tareas ni modificar archivos.'
				}, null, 2)
			}), { preview: true });
		} catch (error) { showError(error); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeProviderDiagnostics', async (requested?: string) => {
		try {
			if (!ensureTrust()) { return; }
			const chosen = await choose(requested); if (!chosen) { return; }
			const diagnostics = await Promise.all([diagnoseProvider('codex'), diagnoseProvider('claude')]);
			if (!authorized(chosen.folder)) { return; }
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({
				language: 'json',
				content: JSON.stringify({ providers: diagnostics, note: 'Local --version and --help flag diagnostics only. Authentication, effective permissions and provider protocol still require a real opt-in smoke test.' }, null, 2)
			}), { preview: true });
		} catch (error) { showError(error); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeAgentMetrics', async (requested?: string) => {
		try {
			if (!ensureTrust()) { return; }
			const selected = await choose(requested); if (!selected) { return; }
			const report = await readAgentStatistics(metricsDirectory(await fs.realpath(selected.folder.uri.fsPath)));
			if (!authorized(selected.folder)) { return; }
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(report, null, 2) }), { preview: true });
		} catch (error) { showError(error); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeSupport', async (requested?: string) => {
		try {
			if (!ensureTrust()) { vscode.window.showWarningMessage(vscode.l10n.t('Workspace trust is required for support evidence.')); return; }
			const selected = await choose(requested); if (!selected) { return; }
			const report = await buildSupportReport(selected.folder.uri.fsPath, selected.engine);
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(report, null, 2) }), { preview: true });
			const action = await vscode.window.showInformationMessage(vscode.l10n.t('Support summary excludes command output and agent instructions.'), 'Export JSON');
			if (action !== 'Export JSON' || !ensureTrust()) { return; }
			const destination = await vscode.window.showSaveDialog({ filters: { 'JSON': ['json'] }, saveLabel: 'Export support evidence' });
			if (!destination) { return; }
			if (!ensureTrust()) { return; }
			await exportSupportReport(destination.fsPath, report);
			vscode.window.showInformationMessage(vscode.l10n.t('Support evidence exported without command output.'));
		} catch (error) { showError(error); } finally { controller.refresh(); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeDoctor', async (requested?: string) => {
		try {
			if (!ensureTrust()) { return; }
			const p = await choose(requested); if (!p) { return; } const report = await p.engine.diagnose();
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(report, null, 2) }));
		} catch (e) { showError(e); } finally { controller.refresh(); }
	}));

	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeConfigure', async (requested?: string) => {
		try {
			if (!ensureTrust()) { vscode.window.showWarningMessage(vscode.l10n.t('Workspace trust is required for configuration.')); return; }
			const selected = await choose(requested);
			if (!selected) { return; }
			const root = await fs.realpath(selected.folder.uri.fsPath);
			const proposal = await proposeProjectConfig(root);
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(proposal, null, 2) }), { preview: true });
			if (proposal.existing) { vscode.window.showInformationMessage(vscode.l10n.t('Existing Harness configuration has not been changed.')); return; }
			const answer = await vscode.window.showWarningMessage(vscode.l10n.t('Create the reviewed .ats-harness.json? This does not run commands.'), { modal: true }, 'Create configuration');
			if (answer !== 'Create configuration' || !ensureTrust()) { return; }
			if (await fs.realpath(selected.folder.uri.fsPath) !== root) { throw Error('HARNESS_ROOT_CHANGED'); }
			const file = await writeProjectConfig(root, proposal.config);
			await context.globalState.update('atsHarness.generated.' + createHash('sha256').update(root).digest('hex'), generatedConfigDigest(proposal.config));
			vscode.window.showInformationMessage(`Harness configuration created: ${file}`);
		} catch (error) { showError(error); } finally { controller.refresh(); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeRemoveConfiguration', async (requested?: string) => {
		try {
			if (!ensureTrust()) { return; }
			const selected = await choose(requested); if (!selected) { return; }
			const root = await fs.realpath(selected.folder.uri.fsPath);
			const key = 'atsHarness.generated.' + createHash('sha256').update(root).digest('hex');
			const digest = context.globalState.get(key);
			if (!digest) { throw Error('HARNESS_CONFIG_NOT_GENERATED'); }
			if (await vscode.window.showWarningMessage(vscode.l10n.t('Retirar la configuraci\u00f3n generada por este IDE si sigue intacta. Se conserva el historial.'), { modal: true }, vscode.l10n.t('Retirar configuraci\u00f3n')) !== vscode.l10n.t('Retirar configuraci\u00f3n') || !authorized(selected.folder)) { return; }
			await removeGeneratedProjectConfig(root, digest);
			await context.globalState.update(key, undefined);
		} catch (error) { showError(error); } finally { controller.refresh(); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeNewTask', async (requested?: string) => {
		try {
			if (!ensureTrust()) { vscode.window.showWarningMessage(vscode.l10n.t('El proyecto debe ser confiable para crear tareas ejecutables.')); return; }
			const p = await choose(requested); if (!p) { return; }
			// Suggestions are never authorizations. No package script runs until reviewed explicitly.
			const existing = await loadProjectConfig(p.folder.uri.fsPath);
			const suggested = existing || (await proposeProjectConfig(p.folder.uri.fsPath)).config;
			const options = [{ label: vscode.l10n.t('Plan completo configurado'), executable: suggested.plan.gates[0].executable, args: suggested.plan.gates[0].args }, { label: 'Comando personalizado', executable: '', args: [] }];
			const selected = await vscode.window.showQuickPick(options, { title: 'Propuesta de verificaci\u00f3n (nada se ejecuta autom\u00e1ticamente)' });
			if (!selected) { return; }
			const executable = selected.executable || await vscode.window.showInputBox({ title: 'Ejecutable autorizado', prompt: 'Nombre del ejecutable, sin shell' });
			if (!executable) { return; }
			let args = selected.args;
			if (!selected.executable) {
				const raw = await vscode.window.showInputBox({ title: 'Argumentos JSON', value: '[]', prompt: 'Ejemplo: ["--version"]. No se interpreta shell.' });
				if (raw === undefined) { return; }
				args = JSON.parse(raw); if (!Array.isArray(args) || !args.every(x => typeof x === 'string')) { throw Error('HARNESS_ARGUMENTS'); }
			}
			const title = await vscode.window.showInputBox({ title: 'Nombre de la tarea', value: selected.label }); if (!title) { return; }
			const plan: Plan = selected.executable ? structuredClone(suggested.plan) : { schemaVersion: 1, gates: [{ id: 'verify', executable, args, cwd: '.' }] };
			// Present exact, immutable plan for explicit approval.
			const preview = JSON.stringify({ project: p.folder.uri.fsPath, plan }, null, 2);
			const doc = await vscode.workspace.openTextDocument({ language: 'json', content: preview }); await vscode.window.showTextDocument(doc, { preview: true });
			const accept = await vscode.window.showWarningMessage(vscode.l10n.t('Revis\u00e1 el plan y sus argumentos. \u00bfCrear la tarea sin ejecutarla?'), { modal: true }, 'Crear tarea');
			if (accept !== 'Crear tarea' || !authorized(p.folder)) { return; }
			const task = await p.engine.create(title, plan);
			vscode.window.showInformationMessage(`Tarea nativa registrada: ${task.id}. Us\u00e1 \u00abEjecutar tarea nativa\u00bb cuando quieras autorizarla.`);
		} catch (e) { showError(e); } finally { controller.refresh(); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeRunTask', async (requested?: string, taskId?: string) => {
		try {
			if (!ensureTrust()) { vscode.window.showWarningMessage(vscode.l10n.t('Este workspace no es confiable.')); return; }
			const p = await choose(requested); if (!p) { return; }
			const tasks = await p.engine.list();
			const selected = taskId ? tasks.filter(task => task.id === taskId).map(task => ({ task }))[0] : await vscode.window.showQuickPick(tasks.map(task => ({ label: task.title, description: task.id, task })), { title: 'Tareas nativas del proyecto' });
			if (!selected) { return; }
			const task = await p.engine.get(selected.task.id);
			const digest = await p.engine.reviewDigest(task.plan);
			const exact = task.plan.gates.map(g => `${g.executable} ${JSON.stringify(g.args)}  (${g.cwd || '.'})`).join('\n');
			if (await vscode.window.showWarningMessage(`Autorizar ejecuci\u00f3n local:\n${exact}`, { modal: true }, 'Ejecutar') !== 'Ejecutar') { return; }
			if (!ensureTrust()) { return; }
			if (running.has(p.folder.uri.toString()) || runningAgents.has(p.folder.uri.fsPath) || runningWorkflows.has(p.folder.uri.fsPath)) { throw Error('HARNESS_ALREADY_RUNNING'); }
			running.set(p.folder.uri.toString(), { engine: p.engine, taskId: task.id });
			controller.refresh();
			let result;
			try { result = await p.engine.execute(task.id, digest, () => authorized(p.folder)); }
			finally { running.delete(p.folder.uri.toString()); controller.refresh(); }
			const last = result.attempts[result.attempts.length - 1];
			const state = ({ passed: 'Verificaci\u00f3n completada', failed: 'La verificaci\u00f3n fall\u00f3. Revis\u00e1 el resultado.', cancelled: 'Verificaci\u00f3n cancelada', interrupted: 'La verificaci\u00f3n requiere revisi\u00f3n', running: 'Verificaci\u00f3n en curso' })[last.status];
			vscode.window.showInformationMessage(vscode.l10n.t(state));
		} catch (e) { showError(e); } finally { controller.refresh(); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeCancel', async (requested?: string) => {
		try {
			if (!ensureTrust()) { return; }
			const p = await choose(requested); if (!p) { return; }
			const current = running.get(p.folder.uri.toString());
			const agent = runningAgents.get(p.folder.uri.fsPath);
			const workflow = runningWorkflows.get(p.folder.uri.fsPath);
			if (!current && !agent && !workflow) { vscode.window.showInformationMessage(vscode.l10n.t('No hay una tarea nativa activa en este proyecto.')); return; }
			const answer = await vscode.window.showWarningMessage(`Cancelar la tarea activa ${current?.taskId || (workflow ? 'workflow multiagente' : 'agente IA')}?`, { modal: true }, 'Cancelar tarea');
			if (answer !== 'Cancelar tarea' || !ensureTrust()) { return; }
			if (current) { current.engine.cancel(); } else if (agent) { agent.cancel(); } else { workflow?.cancel(); }
		} catch (e) { showError(e); } finally { controller.refresh(); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeStatus', async (requested?: string, taskId?: string) => {
		try {
			if (!ensureTrust()) { return; }
			const p = await choose(requested); if (!p) { return; } const tasks = await p.engine.list();
			const history = await Promise.all(tasks.filter(task => !taskId || task.id === taskId).map(async task => ({ ...task, evidence: await p.engine.evidenceStatus(task.id) })));
			if (!ensureTrust()) { return; }
			await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(history, null, 2) }));
		} catch (e) { showError(e); } finally { controller.refresh(); }
	}));
	context.subscriptions.push(vscode.commands.registerCommand('atsHarness.nativeReconcile', async (requested?: string) => {
		try {
			if (!ensureTrust()) { return; } const p = await choose(requested); if (!p) { return; }
			const diagnostic = await p.engine.diagnose();
			const interrupted = (await p.engine.list()).some(task => task.attempts.some(attempt => attempt.status === 'running'));
			if (diagnostic.lock !== 'stale' && !(diagnostic.lock === 'none' && interrupted)) { vscode.window.showInformationMessage(vscode.l10n.t('No hay locks obsoletos ni intentos sin lock para reconciliar.')); return; }
			if (await vscode.window.showWarningMessage(vscode.l10n.t('Marcar intentos interrumpidos y retirar el lock obsoleto. No reejecutar operaciones.'), { modal: true }, 'Reconciliar') !== 'Reconciliar') { return; }
			if (!ensureTrust()) { return; }
			await p.engine.reconcile(); vscode.window.showInformationMessage(vscode.l10n.t('Estado reconciliado sin reintentar tareas.'));
		} catch (e) { showError(e); } finally { controller.refresh(); }
	}));
	context.subscriptions.push({ dispose() { for (const engine of sessions.values()) { engine.cancel(); } for (const agent of runningAgents.values()) { agent.cancel(); } runningAgents.clear(); for (const workflow of runningWorkflows.values()) { workflow.cancel(); } runningWorkflows.clear(); sessions.clear(); } });
}
