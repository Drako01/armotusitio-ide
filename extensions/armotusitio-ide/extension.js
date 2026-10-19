'use strict';
const vscode=require('vscode');
const fs=require('node:fs');
const path=require('node:path');
const {detect,command,validatePlan}=require('./src/core');

function projects(){return (vscode.workspace.workspaceFolders||[]).map(folder=>({folder,profile:detect(folder.uri.fsPath)})).filter(x=>x.profile);}
async function selectProject(uri){
 const all=projects();if(uri)return all.find(x=>x.folder.uri.toString()===uri);
 if(all.length===1)return all[0];
 return (await vscode.window.showQuickPick(all.map(x=>({label:x.profile.name,description:x.profile.root,project:x})),{placeHolder:'Select project'}))?.project;
}
class Controller {
 constructor(){this.jobs=new Map();this.events=new vscode.EventEmitter();this.onDidChangeTreeData=this.events.event;}
 refresh(){this.events.fire();}
 getTreeItem(item){return item;}
 getChildren(element){
  if(!element){
   const all=projects();return all.length?all.map(project=>{const item=new vscode.TreeItem(project.profile.name,vscode.TreeItemCollapsibleState.Expanded);item.project=project;item.iconPath=new vscode.ThemeIcon('repo');item.description=project.profile.repo;return item;}):[new vscode.TreeItem('Open RedEvent or ArmoTuSitio 2.0')];
  }
  if(!element.project)return [];
  const {project}=element;
  const nodes=project.profile.actions.map(action=>{const item=new vscode.TreeItem(action);item.iconPath=new vscode.ThemeIcon(action==='run'?'play':'terminal');item.command={command:'atsHarness.execute',title:action,arguments:[project.folder.uri.toString(),action]};return item;});
  for(const job of this.jobs.values()){
   if(job.project!==project.profile.root)continue;
   const item=new vscode.TreeItem(job.action+' — '+job.state);item.description=job.started;item.iconPath=new vscode.ThemeIcon(job.state==='running'?'sync':job.state==='passed'?'check':'error');nodes.unshift(item);
  }
  return nodes;
 }
 async execute(uri,action){
  const project=await selectProject(uri);if(!project){vscode.window.showWarningMessage('Supported workspace not found');return;}
  let spec;try{spec=command(project.profile,action);}catch(e){vscode.window.showErrorMessage(e.message);return;}
  if(!vscode.workspace.isTrusted){vscode.window.showWarningMessage('Trust the workspace before executing harness tasks.');return;}
  if(await vscode.window.showWarningMessage('Run '+spec.executable+' '+spec.args.join(' ')+' in '+project.profile.name+'?',{modal:true},'Run')!=='Run')return;
  const task=new vscode.Task({type:'ats-harness',action},project.folder,'ATS '+project.profile.id+' '+action,'ArmoTuSitio IDE',new vscode.ProcessExecution(spec.executable,spec.args,{cwd:spec.cwd}));
  task.presentationOptions={reveal:vscode.TaskRevealKind.Always,panel:vscode.TaskPanelKind.New};
  const execution=await vscode.tasks.executeTask(task);
  const id=Date.now()+'-'+Math.random().toString(36).slice(2);
  this.jobs.set(execution,{id,project:spec.cwd,action,state:'running',started:new Date().toLocaleTimeString()});
  this.refresh();
 }
 finish(execution,exitCode){const job=this.jobs.get(execution);if(!job)return;job.state=exitCode===0?'passed':'failed';this.refresh();}
 async terminate(){
  const jobs=[...this.jobs.entries()].filter(([,job])=>job.state==='running');
  if(!jobs.length){vscode.window.showInformationMessage('No active ATS harness task');return;}
  const selected=await vscode.window.showQuickPick(jobs.map(([execution,job])=>({label:job.action+' · '+job.project,execution})),{placeHolder:'Cancel one ATS task'});
  if(!selected)return;
  if(await vscode.window.showWarningMessage('Terminate this harness process?',{modal:true},'Terminate')==='Terminate')selected.execution.terminate();
 }
}
async function reviewPlan(){
 const project=await selectProject();if(!project)return;
 const files=await vscode.window.showOpenDialog({defaultUri:project.folder.uri,canSelectFiles:true,canSelectMany:false,filters:{JSON:['json']}});
 if(!files?.length)return;
 try{
  const raw=await vscode.workspace.fs.readFile(files[0]);
  if(raw.byteLength>1048576)throw new Error('Plan too large');
  const result=validatePlan(JSON.parse(Buffer.from(raw).toString('utf8')));
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(files[0]));
  vscode.window.showInformationMessage('Validated agent DAG: '+result.tasks+' tasks, reserved budget '+result.budget+'. Plan was not executed.');
 }catch(e){vscode.window.showErrorMessage('Invalid agent plan: '+e.message);}
}
function activate(context){
 const controller=new Controller();
 context.subscriptions.push(vscode.window.registerTreeDataProvider('atsHarness.tasks',controller));
 context.subscriptions.push(vscode.commands.registerCommand('atsHarness.refresh',()=>controller.refresh()));
 context.subscriptions.push(vscode.commands.registerCommand('atsHarness.execute',(uri,action)=>controller.execute(uri,action)));
 context.subscriptions.push(vscode.commands.registerCommand('atsHarness.cancelTask',()=>controller.terminate()));
 context.subscriptions.push(vscode.commands.registerCommand('atsHarness.reviewPlan',reviewPlan));
 for(const action of ['check','status','run'])context.subscriptions.push(vscode.commands.registerCommand('atsHarness.'+action,uri=>controller.execute(uri,action)));
 context.subscriptions.push(vscode.tasks.onDidEndTaskProcess(e=>controller.finish(e.execution,e.exitCode)));
 context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(()=>controller.refresh()));
 const watcher=vscode.workspace.createFileSystemWatcher('**/package.json');
 context.subscriptions.push(watcher);
 context.subscriptions.push(watcher.onDidChange(()=>controller.refresh()),watcher.onDidCreate(()=>controller.refresh()),watcher.onDidDelete(()=>controller.refresh()));
}
function deactivate(){}
module.exports={activate,deactivate};
