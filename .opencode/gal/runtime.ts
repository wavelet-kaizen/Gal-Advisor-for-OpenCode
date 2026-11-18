import { join } from 'node:path';
import { Guard, hash } from './guard.ts';
import { type Config, type Check, field } from './config.ts';
import { readAuthorized, type Authorize } from './inspect.ts';
import { verify, type Verification } from './verification.ts';
import { ControlInputError, strictHelp } from './control.ts';

export class ProjectRuntime {
  readonly directory:string;readonly config:Config;private authorize?:Authorize;
  constructor(directory:string,config:Config,authorize?:Authorize) {this.directory=directory;this.config=config;this.authorize=authorize;}
  matches(tool:string,args:Record<string,unknown>) {
    return this.config.checks.find(c=>c.command!==undefined?tool==='bash'&&args.command===c.command:c.tool===tool&&Object.entries(c.match).every(([k,v])=>args[k]===v));
  }
  async validateRegistration(changePath:string,taskIDs:string[],sessionID:string) {
    if(!this.authorize) throw Error('GAL strict completion requires host read permission support (V2)');
    let tasks;
    try {tasks=await readAuthorized(this.directory,join(changePath,'tasks.md'),sessionID,this.authorize);} catch(error) {
      if(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??'')) throw new ControlInputError('strict_registration','changePath must be an existing OpenSpec change directory containing tasks.md; no task was registered.',strictHelp);
      throw error;
    }
    const text=new TextDecoder('utf-8',{fatal:true}).decode(tasks.bytes);
    for(const id of taskIDs) {
      const pattern=new RegExp('^\\s*- \\[[ xX]\\] '+id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?:\\s|$)');
      if(text.split(/\r?\n/).filter(line=>pattern.test(line)).length!==1) throw new ControlInputError('strict_registration','Each selected taskID must occur exactly once in changePath/tasks.md; no task was registered.',strictHelp);
    }
  }
  private async snapshot(check:Check,sessionID:string) {
    if(!this.authorize) throw Error('GAL strict verification requires host read permission support (V2)');
    const contents=[];
    for(const path of check.paths) {const file=await readAuthorized(this.directory,path,sessionID,this.authorize);contents.push({path:file.path,hash:file.contentHash});}
    return hash({definition:check,contents});
  }
  async before(g:Guard,sessionID:string,tool:string,args:Record<string,unknown>,callID:string) {
    const check=this.matches(tool,args);
    if(!check) return;
    if(!g.s.goal) throw Error('GAL GOAL REQUIRED: register goal before configured verification');
    const digest=await this.snapshot(check,sessionID);
    const executions=g.s.executions??={};
    for(const [id,receipt] of Object.entries(executions)) if(receipt.finished&&Object.keys(executions).length>=256) delete executions[id];
    if(Object.keys(executions).length>=256) throw Error('GAL pending execution capacity exceeded');
    if(executions[callID]) throw Error('GAL duplicate execution call ID');
    executions[callID]={executionKey:callID,checkID:check.id,digest,args,revision:g.s.revision};
  }
  async after(g:Guard,sessionID:string,tool:string,args:Record<string,unknown>,callID:string,text:string,exit:number|undefined,result:unknown):Promise<{handled:boolean;note?:string}> {
    let receipt=g.s.executions?.[callID];
    let check=receipt?this.config.checks.find(c=>c.id===receipt!.checkID):undefined;
    if(!receipt) {
      check=this.config.checks.find(c=>c.resultTool===tool&&g.s.executions?.['provider:'+c.id+':'+String(args[c.resultIDArg])]);
      if(check) receipt=g.s.executions?.['provider:'+check.id+':'+String(args[check.resultIDArg])];
    }
    if(!check||!receipt) return {handled:false};
    if(receipt.finished) return {handled:true};
    const state=check.command?'completed':field(result,check.statePath)??(check.resultTool?'unknown':'completed');
    if(state==='running') {
      const id=check.executionIDPath?field(result,check.executionIDPath):undefined;
      if(typeof id!=='string'||!id) throw Error('GAL running verification requires an execution ID');
      g.s.executions!['provider:'+check.id+':'+id]=receipt;return {handled:true};
    }
    const rawBody=check.command?text:field(result,check.textPath);
    let body:string=typeof rawBody==='string'?rawBody:'';
    let code=check.command?exit:field(result,check.exitPath);
    const issues=check.errorsPath?field(result,check.errorsPath):undefined;
    if(Array.isArray(issues)&&check.kind==='compile'&&issues.every(i=>i&&typeof i==='object'&&['ERROR','WARNING','INFO'].includes((i as {severity:string}).severity))) {
      const errors=issues.filter(i=>i&&typeof i==='object'&&(i as {severity?:string}).severity==='ERROR');
      code=errors.length?1:0;body=errors.map(i=>JSON.stringify(i)).join('\n');
    }
    let verification:Verification=verify(body,typeof code==='number'?code:undefined,check.kind,state==='completed'||state==='failed'||state==='cancelled');
    if(check.errorsPath&&(!Array.isArray(issues)||!issues.every(i=>i&&typeof i==='object'&&['ERROR','WARNING','INFO'].includes((i as {severity:string}).severity)))) verification={...verification,verdict:'UNKNOWN'};
    if(state==='failed'||state==='cancelled') verification={...verification,verdict:'FAIL'};
    const digest=await this.snapshot(check,sessionID);
    if(digest!==receipt.digest||g.s.revision!==receipt.revision) verification={...verification,verdict:'UNKNOWN'};
    receipt.finished=true;
    // Mark all persisted aliases, including objects independently reconstructed by JSON.parse.
    for(const other of Object.values(g.s.executions??{})) if(other.executionKey===receipt.executionKey) other.finished=true;
    const scopeArgs={command:check.command??check.tool,_galCheck:check.id+':'+check.scope};
    const note=g.observe('bash',scopeArgs,body||'GAL verification '+verification.verdict,verification.verdict==='FAIL'?1:verification.verdict==='PASS'?0:undefined,verification);
    g.recordCheck(check.id,check.scope,verification.verdict,receipt.digest);
    return {handled:true,note};
  }
  async refresh(g:Guard,sessionID:string) {
    const strict=g.s.strict;if(!strict) return;
    if(!this.authorize) throw Error('GAL strict completion requires host read permission support (V2)');
    const tasks=await readAuthorized(this.directory,join(strict.changePath,'tasks.md'),sessionID,this.authorize);
    const text=new TextDecoder('utf-8',{fatal:true}).decode(tasks.bytes);
    const done=strict.taskIDs.every(id=>{
      const matches=text.split(/\r?\n/).filter(line=>new RegExp('^\\s*- \\[[xX]\\] '+id.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?:\\s|$)').test(line));
      return matches.length===1;
    });
    const digests:Record<string,string>={};
    for(const id of strict.requiredChecks) {const check=this.config.checks.find(c=>c.id===id);if(check) digests[id]=await this.snapshot(check,sessionID);}
    g.refreshCompletion(done,digests);
  }
}
