import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {isolatedEnvironment} from './lib/run.mjs';
const profile=process.argv[2];const manifest=JSON.parse(await readFile(`${profile}/test-manifest.json`,'utf8'));
const env=isolatedEnvironment(manifest.git);
for(const key of Object.keys(env))if(/^GIT_/i.test(key))delete env[key];
Object.assign(env,{HOME:manifest.git.homeDirectory,USERPROFILE:manifest.git.homeDirectory,XDG_CONFIG_HOME:`${manifest.git.homeDirectory}/.config`,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:`${manifest.git.homeDirectory}/.gitconfig`,GCM_INTERACTIVE:'Never',GIT_TERMINAL_PROMPT:'0',GIT_PAGER:'cat',GIT_EDITOR:'true',GIT_SEQUENCE_EDITOR:'false',GIT_MERGE_AUTOEDIT:'no',GIT_OPTIONAL_LOCKS:'0',GIT_LITERAL_PATHSPECS:'1'});
const args=['--no-pager','-c','color.ui=false','-c','core.quotepath=false','-c','core.fsmonitor=false','-c','diff.external=','-c','log.showSignature=false','rev-parse','--absolute-git-dir'];
for(const slash of ['native','extended','forward']){
 const e={...env};if(slash==='extended'){for(const key of ['HOME','USERPROFILE','XDG_CONFIG_HOME','GIT_CONFIG_GLOBAL'])e[key]='\\\\?\\'+e[key];}
 if(slash==='forward'){for(const key of ['HOME','USERPROFILE','XDG_CONFIG_HOME','GIT_CONFIG_GLOBAL'])e[key]=e[key].replaceAll('\\','/');}
 const out=spawnSync('C:/Program Files/Git/cmd/git.exe',args,{cwd:process.argv[3],env:e,encoding:'utf8',windowsHide:true});
 console.log({slash,status:out.status,stdout:out.stdout,stderr:out.stderr,home:e.HOME});
}
