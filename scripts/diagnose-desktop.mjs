import { createRun, gitExecutable, json, errorInfo } from './lib/run.mjs';
import { createFixtures } from './lib/fixtures.mjs';
import { OwnedProcesses, startDesktop, archiveDesktop } from './lib/desktop.mjs';
import { join, resolve } from 'node:path';
const output=process.argv[2];if(!output)throw new Error('Provide a new empty run directory.');
const run=await createRun(resolve(output),'diagnostics');run.gitBinary=gitExecutable();const owned=new OwnedProcesses(run);let wd;let failure;
try{
 const fixtures=await createFixtures(run);
 wd=await startDesktop(run,{binary:resolve('src-tauri/target/debug/qgitgraph.exe'),driver:resolve('artifacts/tools/edge-157-20261121-01/extracted/msedgedriver.exe')},owned);
 console.log('Initialized isolated app.');
 await wd.click('button[data-action="repository-options"]');await wd.click('[role="menuitem"][data-action="open-repository-by-path"]');
 await wd.wait('Open dialog','return !!document.querySelector("dialog[open]");');
 await wd.fill('dialog[open] input[name="path"]',fixtures.repository);
 await wd.click('button[data-action="confirm-open-repository"]');
 await wd.wait('open operation settled','return document.querySelector(".app-shell")?.dataset.taskState==="idle" && (document.querySelector(".app-shell")?.dataset.repoPath || document.querySelector(".errorbar:not([hidden])"));');
 console.log(await wd.state());
 if(await wd.script('return !!document.querySelector(".errorbar:not([hidden])");')){
   await wd.click('.errorbar:not([hidden]) button[title="Details"]');
   await json(join(run.output,'error-details.json'),{text:await wd.script('return document.querySelector("dialog[open]")?.innerText;')});
   throw new Error('Repository failed to open; expanded error saved.');
 }
}catch(error){failure=error;console.log(errorInfo(error));
 if(!wd)wd=run.webDriver;
 if(wd?.sessionId){
   if(await wd.script('return !!document.querySelector(".errorbar:not([hidden]) button[title=Details]");').catch(()=>false)){
     await wd.click('.errorbar:not([hidden]) button[title="Details"]');
     await json(join(run.output,'error-details.json'),{text:await wd.script('return document.querySelector("dialog[open]")?.innerText;')});
   }
 }
}finally{
 await archiveDesktop(run,wd,'diagnose').catch(()=>{});
 if(wd?.sessionId)await wd.call('DELETE',wd.prefix).catch(()=>{});
 const cleanup=await owned.cleanup().catch(error=>({error:errorInfo(error)}));
 run.manifest.status=failure?'failed':'passed';run.manifest.error=failure?errorInfo(failure):undefined;run.manifest.cleanup=cleanup;await run.save();
}
