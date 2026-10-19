'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const PROFILES = {
  'armotusitio2.0': { label: 'ArmoTuSitio 2.0', directory: 'harness', actions: ['doctor','check','context','verify','report','run','changes','ci-gaps','tokens'] },
  'redevent': { label: 'RedEvent', directory: '.harness', actions: ['doctor','check','status','context','verify','report','run','dispatch','plan','progress','abort','metrics','ci-gaps'] }
};
const SAFE_ACTIONS = new Set(['doctor','check','status','context','verify','report','run','dispatch','plan','progress','abort','metrics','ci-gaps','tokens','changes']);
function inspect(folder) {
  const root = folder.uri.fsPath;
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')); } catch { return; }
  const scripts = pkg.scripts || {};
  if (typeof scripts['harness:check'] !== 'string') return;
  const profileId = pkg.name === 'redevent' ? 'redevent' :
    pkg.name === 'armotusitio-next' ? 'armotusitio2.0' : undefined;
  const profile = profileId && PROFILES[profileId];
  if (!profile || !fs.existsSync(path.join(root,profile.directory))) return;
  const manager = (pkg.packageManager || '').startsWith('pnpm@') ? 'pnpm' : 'npm';
  return { folder, profileId, profile, manager, scripts };
}
function findAll() { return (vscode.workspace.workspaceFolders || []).map(inspect).filter(Boolean); }
class ProjectsProvider {
  constructor() { this.events = new vscode.EventEmitter(); this.onDidChangeTreeData = this.events.event; }
  refresh() { this.events.fire(); }
  getTreeItem(item) { return item; }
  getChildren(element) {
    if (!vscode.workspace.getConfiguration('atsHarness').get('enabled',true)) return [new vscode.TreeItem('Harness disabled')];
    if (!element) {
      const projects=findAll();
      return projects.length ? projects.map(p=>{
        const item=new vscode.TreeItem(p.profile.label,vscode.TreeItemCollapsibleState.Expanded);
        item.description=p.folder.name; item.contextValue='atsProject'; item.profile=p;
        item.iconPath=new vscode.ThemeIcon('repo'); return item;
      }) : [new vscode.TreeItem('Open ArmoTuSitio 2.0 or RedEvent')];
    }
    if (!element.profile) return [];
    return element.profile.profile.actions.filter(action=>typeof element.profile.scripts['harness:'+action]==='string')
      .map(action=>{
        const item=new vscode.TreeItem(action,vscode.TreeItemCollapsibleState.None);
        item.iconPath=new vscode.ThemeIcon(action==='run'||action==='dispatch'?'play':'terminal');
        item.command={command:'atsHarness.execute',title:'Execute harness '+action,arguments:[element.profile.folder.uri.toString(),action]};
        return item;
      });
  }
}
async function chooseProject(uri) {
  const projects=findAll();
  if (uri) return projects.find(p=>p.folder.uri.toString()===uri);
  if (projects.length===1) return projects[0];
  const chosen=await vscode.window.showQuickPick(projects.map(p=>({label:p.profile.label,description:p.folder.uri.fsPath,project:p})),{placeHolder:'Select harness'});
  return chosen?.project;
}
function npmArgs(project, action) {
  return project.manager==='pnpm' ? ['harness:'+action] : ['run','harness:'+action];
}
async function runAction(uri, action) {
  if (!SAFE_ACTIONS.has(action)) return;
  const project=await chooseProject(uri);
  if (!project) { vscode.window.showWarningMessage('Open a supported project workspace first.'); return; }
  if (typeof project.scripts['harness:'+action]!=='string') { vscode.window.showWarningMessage('Command not available in this harness.'); return; }
  const command=project.manager+' '+npmArgs(project,action).join(' ');
  const confirm=await vscode.window.showWarningMessage('Launch '+command+' in '+project.profile.label+'?',{modal:true},'Launch');
  if (confirm!=='Launch') return;
  // A VS Code Task uses ProcessExecution: never concatenate prompts into shell source.
  const execution=new vscode.ProcessExecution(project.manager,npmArgs(project,action),{cwd:project.folder.uri.fsPath});
  const task=new vscode.Task({type:'ats-harness',action},project.folder,'ATS '+action,'ArmoTuSitio IDE',execution);
  task.presentationOptions={reveal:vscode.TaskRevealKind.Always,panel:vscode.TaskPanelKind.Dedicated,clear:false};
  await vscode.tasks.executeTask(task);
}
async function openPlan(uri) {
  const project=await chooseProject(uri);
  if (!project) return;
  const plan=await vscode.window.showOpenDialog({canSelectFiles:true,canSelectFolders:false,canSelectMany:false,openLabel:'Open harness plan',filters:{JSON:['json']},defaultUri:project.folder.uri});
  if (!plan?.length) return;
  const doc=await vscode.workspace.openTextDocument(plan[0]); await vscode.window.showTextDocument(doc);
  vscode.window.showInformationMessage('Plan opened for review. Execute it using the project harness CLI after validating permissions, scope and token budgets.');
}
function activate(context) {
  const provider=new ProjectsProvider();
  context.subscriptions.push(vscode.window.registerTreeDataProvider('atsHarness.tasks',provider));
  context.subscriptions.push(vscode.commands.registerCommand('atsHarness.refresh',()=>provider.refresh()));
  context.subscriptions.push(vscode.commands.registerCommand('atsHarness.execute',runAction));
  context.subscriptions.push(vscode.commands.registerCommand('atsHarness.openPlan',openPlan));
  for (const action of ['check','status','run']) context.subscriptions.push(vscode.commands.registerCommand('atsHarness.'+action,uri=>runAction(uri,action)));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(()=>provider.refresh()));
  const watcher=vscode.workspace.createFileSystemWatcher('**/package.json');
  watcher.onDidChange(()=>provider.refresh()); watcher.onDidCreate(()=>provider.refresh()); watcher.onDidDelete(()=>provider.refresh());
  context.subscriptions.push(watcher);
}
function deactivate(){}
module.exports={activate,deactivate,inspect};
