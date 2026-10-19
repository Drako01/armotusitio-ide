#!/usr/bin/env node
// Windows build diagnostics for ArmoTuSitio IDE. Does not mutate dependencies.
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
function line(ok,label,detail=''){console.log((ok?'[OK] ':'[FAIL] ')+label+(detail?' — '+detail:''));}
function version(s){return (s.match(/\d+\.\d+\.\d+/)||[])[0];}
if(process.platform!=='win32'){console.error('Este diagnóstico es exclusivo de Windows.');process.exit(2);}
const expected=readFileSync(join(root,'.nvmrc'),'utf8').trim();
const actual=process.versions.node;
const em=expected.split('.').map(Number),am=actual.split('.').map(Number);
const nodeOK=am[0]===em[0]&&(am[1]>em[1]||(am[1]===em[1]&&am[2]>=em[2]));
line(nodeOK,'Node',actual+' (requerido '+expected+')');
const lock=existsSync(join(root,'package-lock.json'));
line(lock,'Lockfile npm',lock?'package-lock.json encontrado':'falta package-lock.json');
const pnpmLock=existsSync(join(root,'pnpm-lock.yaml'));
if(pnpmLock)console.warn('[WARN] pnpm-lock.yaml local: evitar mezclar pnpm y npm en este checkout.');
const candidatePaths=[process.env.vs2022_install,process.env.vs2026_install,process.env['ProgramFiles(x86)']&&join(process.env['ProgramFiles(x86)'],'Microsoft Visual Studio','Installer','vswhere.exe')];
const vswhere=candidatePaths[2];
let installs=[];
if(vswhere&&existsSync(vswhere)){
 try{
 const raw=execFileSync(vswhere,['-all','-prerelease','-products','*','-format','json'],{encoding:'utf8',timeout:15000});
 installs=JSON.parse(raw);
 }catch(e){console.warn('[WARN] vswhere no pudo consultar todas las instalaciones: '+e.message);}
}
for(const p of candidatePaths.slice(0,2).filter(Boolean)){if(!installs.some(i=>i.installationPath?.toLowerCase()===p.toLowerCase()))installs.push({installationPath:p,installationVersion:p===process.env.vs2022_install?'17.0':'18.0'});}
const supported=installs.filter(i=>Number.parseInt(i.installationVersion,10)===17&&existsSync(join(i.installationPath,'VC','Auxiliary','Build','vcvars64.bat')));
const insider=installs.filter(i=>Number.parseInt(i.installationVersion,10)>=18);
for(const i of installs)console.log('[VS] '+(i.installationVersion||'?')+' '+i.installationPath);
if(supported.length)line(true,'Toolchain VS 2022 compatible con node-gyp 11',supported[0].installationPath);
else if(insider.length)line(false,'Toolchain para npm ci','Se detectó VS 2026, pero npm utiliza node-gyp 11.x que no identifica esa versión correctamente.');
else line(false,'Toolchain para npm ci','No se detectó Visual Studio 2022 con C++.');
if(!supported.length)console.log('\nAcción recomendada: instalar VS 2022 Build Tools (v17), carga "Desktop development with C++", Windows SDK y bibliotecas MSVC Spectre x64/x86. Se puede instalar junto a VS 2026. No hace falta desinstalar VS 2026.');
console.log('\nDespués, abrir "x64 Native Tools Command Prompt for VS 2022" y ejecutar desde la raíz: npm ci');
console.log('No se han descargado paquetes ni borrado archivos.');
if(!nodeOK||!lock||!supported.length)process.exitCode=1;
