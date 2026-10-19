/*---------------------------------------------------------------------------------------------
 *  ArmoTuSitio IDE - Harness integration. Licensed under MIT.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');

const commandCatalog = ['check', 'status', 'run'];
function detectHarness(folder) {
  const root = folder.uri.fsPath;
  if (!fs.existsSync(path.join(root, 'package.json'))) return undefined;
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { return undefined; }
  const scripts = pkg.scripts || {};
  if (!scripts['harness:check'] || !fs.existsSync(path.join(root, '.harness'))) return undefined;
  return { folder, scripts, manager: typeof pkg.packageManager === 'string' && pkg.packageManager.startsWith('pnpm@') ? 'pnpm' : 'npm' };
}
class HarnessProvider {
  constructor() { this.emitter = new vscode.EventEmitter(); this.onDidChangeTreeData = this.emitter.event; }
  refresh() { this.emitter.fire(); }
  getTreeItem(item) { return item; }
  getChildren() {
    if (!vscode.workspace.getConfiguration('atsHarness').get('enabled', true)) return [new vscode.TreeItem('Harness integration disabled')];
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) return [new vscode.TreeItem('Open a project workspace')];
    const entries = folders.map(detectHarness).filter(Boolean);
    if (!entries.length) return [new vscode.TreeItem('No compatible harness found')];
    return entries.flatMap(entry => {
      const heading = new vscode.TreeItem(entry.folder.name, vscode.TreeItemCollapsibleState.None);
      heading.description = 'Harness detected';
      const nodes = [heading];
      for (const action of commandCatalog) {
        if (!entry.scripts['harness:' + action]) continue;
        const item = new vscode.TreeItem(action === 'run' ? 'Run task…' : 'Harness ' + action, vscode.TreeItemCollapsibleState.None);
        item.command = { command: 'atsHarness.' + action, title: 'Harness ' + action, arguments: [entry.folder.uri.toString()] };
        item.iconPath = new vscode.ThemeIcon(action === 'run' ? 'play' : action === 'status' ? 'pulse' : 'check');
        nodes.push(item);
      }
      return nodes;
    });
  }
}
async function execute(action, selectedUri) {
  const entries = (vscode.workspace.workspaceFolders || []).map(detectHarness).filter(Boolean);
  if (!entries.length) { vscode.window.showWarningMessage('No compatible .harness found in this workspace.'); return; }
  const entry = selectedUri ? entries.find(e => e.folder.uri.toString() === selectedUri) : entries.length === 1 ? entries[0] : await vscode.window.showQuickPick(entries.map(e => ({label:e.folder.name, entry:e})), {placeHolder:'Choose harness workspace'}).then(x => x?.entry);
  if (!entry) return;
  if (!entry.scripts['harness:' + action]) { vscode.window.showWarningMessage('Harness script is not available: ' + action); return; }
  let args = [];
  if (action === 'run') {
    const text = await vscode.window.showInputBox({prompt:'Harness task arguments (project-specific syntax)',ignoreFocusOut:true});
    if (text === undefined || !text.trim()) return;
    // Do not interpolate untrusted input into a shell command.
    vscode.window.showInformationMessage('Run the task from the integrated terminal using the documented harness syntax.');
    const term = vscode.window.createTerminal({name:'ATS Harness: run',cwd:entry.folder.uri.fsPath});
    term.show();
    term.sendText(entry.manager === 'pnpm' ? 'pnpm harness:run' : 'npm run harness:run', false);
    return;
  }
  const command = entry.manager === 'pnpm' ? 'pnpm harness:' + action : 'npm run harness:' + action;
  if (vscode.workspace.getConfiguration('atsHarness').get('confirmExecution', true)) {
    const approved = await vscode.window.showWarningMessage('Run ' + command + ' in ' + entry.folder.name + '?', {modal:true}, 'Run');
    if (approved !== 'Run') return;
  }
  const term = vscode.window.createTerminal({name:'ATS Harness: ' + action,cwd:entry.folder.uri.fsPath});
  term.show();
  term.sendText(command);
}
function activate(context) {
  const provider = new HarnessProvider();
  context.subscriptions.push(vscode.window.registerTreeDataProvider('atsHarness.tasks', provider));
  context.subscriptions.push(vscode.commands.registerCommand('atsHarness.refresh', () => provider.refresh()));
  for (const action of commandCatalog) context.subscriptions.push(vscode.commands.registerCommand('atsHarness.' + action, selectedUri => execute(action, selectedUri)));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()));
}
function deactivate() {}
module.exports = { activate, deactivate };
