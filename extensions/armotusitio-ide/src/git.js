'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
function validRef(ref){return /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,120}$/.test(ref)&&!ref.includes('..')&&!ref.endsWith('.lock');}
function git(root,args,opts={}){
 return new Promise((resolve,reject)=>{
  if(!Array.isArray(args)||!args.every(x=>typeof x==='string'))return reject(new Error('Invalid Git argv'));
  let output='',errors='';
  const child=spawn('git',args,{cwd:root,shell:false,windowsHide:true,env:process.env});
  const kill=()=>child.kill();
  opts.signal?.addEventListener('abort',kill,{once:true});
  child.stdout.on('data',data=>{output+=data;if(output.length>1024*1024)child.kill();});
  child.stderr.on('data',data=>{errors+=data;if(errors.length>1024*1024)child.kill();});
  child.once('error',reject);
  child.once('close',code=>{opts.signal?.removeEventListener('abort',kill);code===0?resolve(output.trim()):reject(new Error('git '+args[0]+' failed ('+code+'): '+errors.slice(-2000)));});
 });
}
async function listWorktrees(root){
 const raw=await git(root,['worktree','list','--porcelain']);
 return raw.split(/\r?\n\r?\n/).filter(Boolean).map(block=>Object.fromEntries(block.split(/\r?\n/).map(line=>{const i=line.indexOf(' ');return i<0?[line,true]:[line.slice(0,i),line.slice(i+1)];})));
}
async function createWorktree(root,baseDir,branch){
 if(!validRef(branch)||branch.startsWith('-'))throw new Error('Invalid worktree branch');
 const target=path.resolve(baseDir,branch.replaceAll('/','__'));
 const base=path.resolve(baseDir);
 if(!target.startsWith(base+path.sep))throw new Error('Worktree escapes base directory');
 if(fs.existsSync(target))throw new Error('Worktree destination already exists');
 await git(root,['worktree','add','-b',branch,target]);
 return target;
}
module.exports={git,listWorktrees,createWorktree,validRef};
