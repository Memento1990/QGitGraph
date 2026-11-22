import {readFile,writeFile,mkdir}from'node:fs/promises';
import{spawn,spawnSync}from'node:child_process';
import{createServer}from'node:net';
import{resolve,join}from'node:path';
import{randomBytes}from'node:crypto';
import assert from'node:assert/strict';
import{createRun,gitExecutable,gitText,git,json,errorInfo}from'./lib/run.mjs';
const binary=resolve(process.argv[2]);const output=resolve(process.argv[3]);const run=await createRun(output,'interactive-console');run.gitBinary=gitExecutable();const results=[];
async function fixture(name){const repo=join(output,name);await mkdir(repo);git(run,repo,['init','-b','main',`--template=${run.manifest.git.templateDirectory}`]);for(const[k,v]of[['user.name','Console test'],['user.email','console@example.invalid'],['commit.gpgsign','false'],['core.editor','true'],['sequence.editor','true'],['core.hooksPath',run.manifest.git.hooksDirectory]])git(run,repo,['config',k,v]);await writeFile(join(repo,'base.txt'),'base\n');git(run,repo,['add','.']);git(run,repo,['commit','-m','base']);return repo;}
async function consoleRun(repo,args){const token=randomBytes(32).toString('hex');let child;let resolveDone,rejectDone;const done=new Promise((a,b)=>{resolveDone=a;rejectDone=b;});
 const server=createServer(stream=>{let input='';let authenticated=false;stream.on('data',chunk=>{input+=chunk;let at;while((at=input.indexOf('\n'))>=0){const line=input.slice(0,at);input=input.slice(at+1);if(!authenticated){assert.equal(line,token);authenticated=true;stream.write(JSON.stringify({token,id:'test-console',repoId:repo,kind:'rebase',executable:run.gitBinary,shellAfter:false,repository:repo,gitDirectory:join(repo,'.git'),args,isolatedHome:run.manifest.git.homeDirectory})+'\n');}else{const event=JSON.parse(line);assert.equal(event.token,token);resolveDone(event);}}});stream.on('error',rejectDone);});
 await new Promise(resolve=>server.listen({host:'127.0.0.1',port:0},resolve));const address=server.address();
 child=spawn(binary,['--git-console-v2',`127.0.0.1:${address.port}`,token],{env:{...run.env,GIT_SEQUENCE_EDITOR:'true',GIT_EDITOR:'true'},cwd:repo,windowsHide:false,stdio:'ignore'});
 child.once('error',rejectDone);let timeout=setTimeout(()=>rejectDone(new Error('Interactive console did not return a lifecycle event.')),30000);
 try{const event=await done;await new Promise((resolve,reject)=>{child.once('exit',code=>code===event.code?resolve():reject(new Error(`Console exit ${code} != ${event.code}`)));if(child.exitCode!==null)resolve();});return event;}finally{clearTimeout(timeout);server.close();if(child.exitCode===null)child.kill();}}
try{
 let repo=await fixture('linear');let base=gitText(run,repo,['rev-parse','HEAD']);await writeFile(join(repo,'one.txt'),'one\n');git(run,repo,['add','.']);git(run,repo,['commit','-m','one']);await writeFile(join(repo,'two.txt'),'two\n');git(run,repo,['add','.']);git(run,repo,['commit','-m','two']);
 let event=await consoleRun(repo,['rebase','--interactive','--no-autostash','--no-update-refs','--no-fork-point',base]);assert.equal(event.status,'completed');assert.equal(event.operation,null);assert.equal(event.code,0);results.push({label:'real interactive rebase console with editor and completed lifecycle',status:'passed',event});
 repo=await fixture('conflict');base=gitText(run,repo,['rev-parse','HEAD']);git(run,repo,['checkout','-b','topic']);await writeFile(join(repo,'base.txt'),'topic\n');git(run,repo,['add','.']);git(run,repo,['commit','-m','topic']);git(run,repo,['checkout','main']);await writeFile(join(repo,'base.txt'),'main\n');git(run,repo,['add','.']);git(run,repo,['commit','-m','main']);const upstream=gitText(run,repo,['rev-parse','HEAD']);git(run,repo,['checkout','topic']);
 event=await consoleRun(repo,['rebase','--interactive','--no-autostash','--no-update-refs','--no-fork-point',upstream]);assert.equal(event.status,'paused');assert.equal(event.operation,'rebase');assert.notEqual(event.code,0);assert(gitText(run,repo,['status','--porcelain']).includes('UU'));
 git(run,repo,['rebase','--abort']);assert.equal(gitText(run,repo,['symbolic-ref','--short','HEAD']),'topic');results.push({label:'interactive conflict returns paused state and remains recoverable',status:'passed',event});
 await json(join(output,'test-report.json'),{schemaVersion:1,kind:'interactive-console',status:'passed',results});console.log({status:'passed',results});
}catch(error){await json(join(output,'test-report.json'),{schemaVersion:1,kind:'interactive-console',status:'failed',results,error:errorInfo(error)});throw error;}
