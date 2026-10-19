'use strict';
const vscode=require('vscode');
const path=require('node:path');
const {git,listWorktrees,createWorktree}=require('./git');
const {indexProject,summary}=require('./context');
async function chooseProject(projects){const all=projects();if(all.length===1)return all[0];return(await vscode.window.showQuickPick(all.map(p=>({label:p.profile.name,description:p.profile.root,project:p})),{placeHolder:'Select project'}))?.project;}
function trust(){if(!vscode.workspace.isTrusted){vscode.window.showWarningMessage('This action requires a trusted workspace.');return false;}return true;}
async function runTool(project,name,args,label){
 const task=new vscode.Task({type:'ats-ide-tool',name},project.folder,label,'ArmoTuSitio IDE',new vscode.ProcessExecution(name,args,{cwd:project.profile.root}));
 task.presentationOptions={reveal:vscode.TaskRevealKind.Always,panel:vscode.TaskPanelKind.New};
 await vscode.tasks.executeTask(task);
}
function register(context,projects){
 function add(name,callback){context.subscriptions.push(vscode.commands.registerCommand('atsIde.'+name,callback));}
 add('worktrees',async()=>{const p=await chooseProject(projects);if(!p)return;try{const entries=await listWorktrees(p.profile.root);await vscode.window.showQuickPick(entries.map(e=>({label:e.branch||'(detached)',description:e.worktree})),{title:'Git Worktrees ('+entries.length+')'});}catch(e){vscode.window.showErrorMessage(e.message);}});
 add('createWorktree',async()=>{
  if(!trust())return;const p=await chooseProject(projects);if(!p)return;
  const branch=await vscode.window.showInputBox({prompt:'New worktree branch (for example feat/RED-123)',validateInput:value=>/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,120}$/.test(value)&&!value.includes('..')?null:'Invalid Git branch'});
  if(!branch)return;
  const base=path.join(p.profile.root,'.ats-worktrees');
  if(await vscode.window.showWarningMessage('Create isolated Git worktree '+branch+' in '+base+'?',{modal:true},'Create')!=='Create')return;
  try{const target=await createWorktree(p.profile.root,base,branch);vscode.window.showInformationMessage('Worktree created: '+target);}catch(e){vscode.window.showErrorMessage(e.message);}
 });
 add('context',async()=>{
  const p=await chooseProject(projects);if(!p)return;
  const indexed=indexProject(p.profile.root);
  const doc=await vscode.workspace.openTextDocument({language:'markdown',content:'# '+p.profile.name+' — Context inventory\n\nFiles indexed: '+indexed.files.length+(indexed.truncated?' (limit reached)':'')+'\n\nExtensions: '+summary(indexed)+'\n\n## Files\n'+indexed.files.map(f=>'- `'+f+'`').join('\n')});
  await vscode.window.showTextDocument(doc);
 });
 add('github',async()=>{
  if(!trust())return;const p=await chooseProject(projects);if(!p)return;
  const action=await vscode.window.showQuickPick([{label:'Pull requests',args:['pr','list','--repo',p.profile.repo]},{label:'Recent workflow runs',args:['run','list','--repo',p.profile.repo,'--limit','15']},{label:'Repository status',args:['repo','view',p.profile.repo]}],{placeHolder:'GitHub read-only command'});
  if(action)await runTool(p,'gh',action.args,'ATS GitHub: '+action.label);
 });
 add('n8n',async()=>{
  const url=vscode.workspace.getConfiguration('atsHarness').get('n8nUrl','http://127.0.0.1:5678');
  let parsed;try{parsed=new URL(url);}catch{vscode.window.showErrorMessage('Invalid n8n URL');return;}
  if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password){vscode.window.showErrorMessage('Unsafe n8n URL');return;}
  await vscode.env.openExternal(vscode.Uri.parse(parsed.toString()));
 });
 add('agent',async()=>{
  if(!trust())return;const p=await chooseProject(projects);if(!p)return;
  const provider=await vscode.window.showQuickPick(['codex','claude'],{placeHolder:'Select installed and authenticated CLI'});
  if(!provider)return;
  const prompt=await vscode.window.showInputBox({prompt:'Task to send to '+provider,maxLength:4000,ignoreFocusOut:true});
  if(!prompt?.trim())return;
  const args=provider==='codex'?['exec',prompt]:['-p',prompt];
  if(await vscode.window.showWarningMessage(provider+' will execute within '+p.profile.name+' and may modify files. Review its permissions and scope.',{modal:true},'Run agent')!=='Run agent')return;
  await runTool(p,provider,args,'ATS Agent: '+provider);
 });
}
module.exports={register};
