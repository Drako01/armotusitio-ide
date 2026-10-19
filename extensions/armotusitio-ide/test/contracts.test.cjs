'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const test=require('node:test');
const pkg=require('../package.json');
const theme=require('../themes/armotusitio-dark-color-theme.json');
test('extension declares own theme and registered execution command',()=>{
 assert.ok(pkg.contributes.commands.some(c=>c.command==='atsHarness.execute'));
 assert.ok(pkg.contributes.themes.some(t=>t.label==='ArmoTuSitio Dark'));
 assert.equal(theme.colors['editor.background'],'#141b22');
 assert.equal(theme.colors['focusBorder'],'#f9ed32');
});
test('activity icon references an existing asset',()=>{
 const icon=pkg.contributes.viewsContainers.activitybar[0].icon;
 assert.ok(fs.existsSync(path.join(__dirname,'..',icon)));
});
test('main extension is shipped at its declared path',()=>{
 assert.ok(fs.existsSync(path.join(__dirname,'..',pkg.main)));
});
