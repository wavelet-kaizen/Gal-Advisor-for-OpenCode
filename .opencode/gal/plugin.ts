import type { Hooks } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';
import { Guard, hash, type Move, type State } from './guard.ts';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, type Config } from './config.ts';
import { inspectText, type Authorize } from './inspect.ts';
import { ProjectRuntime } from './runtime.ts';

// Keep persisted state canonical when switching between V1 and V2 hosts.
export function canonicalMove(move:Move):Move {
  const args={...move.args};
  const name=move.tool==='shell'?'bash':move.tool==='subagent'?'task':move.tool;
  if(['read','edit','write'].includes(name)&&'path' in args) {args.filePath=args.path;delete args.path;}
  if(name==='task'&&'agent' in args) {args.subagent_type=args.agent;delete args.agent;}
  return {tool:name,args};
}

type ShellNotification={shellID:string;output:string;exit?:number};
type GuardHooks=Hooks & {
  settings:Config;
  monitorState:{active:boolean;error?:string};
  deferShell(sessionID:string,shellID:string,args:Record<string,unknown>,callID?:string):Promise<void>;
  completeShells(sessionID:string,notifications:ShellNotification[]):Promise<string[]>;
};

export async function createGuardHooks(directory:string, lookupAdvisor:(id:string)=>Promise<boolean>, v2=false, authorizeRead?:Authorize):Promise<GuardHooks> {
  const config=await loadConfig(directory);
  if(!v2&&config.generation.mode!=='off') throw Error('GAL generation notifications require OpenCode V2');
  const monitorState:{active:boolean;error?:string}={active:false};
  const runtime=new ProjectRuntime(directory,config,authorizeRead);
  const hostMove=(move:Move):Move=>{
    if(!v2) return move;
    const args={...move.args};
    if(['read','edit','write'].includes(move.tool)&&'filePath' in args) {args.path=args.filePath;delete args.filePath;}
    return {tool:move.tool==='bash'?'shell':move.tool,args};
  };
  const serialize=(value:unknown)=>JSON.stringify(value,(_key,value)=>{
    if(value&&typeof value==='object'&&typeof value.tool==='string'&&value.args) return {...value,...hostMove(value)};
    return value;
  });
  const notice=(text:string)=>v2?text.replace(/task (?:with )?subagent_type=gal-advisor/g,'subagent agent=gal-advisor').replace(/\bbash\b/g,'shell'):text;
  const nextTools=v2?['read','glob','grep','shell','gal_inspect_text'] as const:['read','glob','grep','bash','gal_inspect_text'] as const;
  const root=join(directory,'.gal-state');
  const guards=new Map<string,Guard>();
  let queue:Promise<unknown>=Promise.resolve();
  const transaction=<T>(id:string, action:(g:Guard)=>T|Promise<T>):Promise<T> => {
    const run=queue.then(async()=>{
      const path=join(root,hash(id)+'.json');
      let g=guards.get(id);
      if(!g) {
        try {g=new Guard(JSON.parse(await readFile(path,'utf8')) as State);}
        catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e;g=new Guard();}
        guards.set(id,g);
      }
      try {return await action(g);}
      finally {await mkdir(root,{recursive:true});await writeFile(path+'.tmp',JSON.stringify(g.s));await rename(path+'.tmp',path);}
    });
    queue=run.catch(()=>{});return run;
  };
  const advisorSessions=new Set<string>();
  const failedCalls=new Set<string>();
  async function isAdvisor(id:string) {
    if(advisorSessions.has(id)) return true;
    if(await lookupAdvisor(id)) {advisorSessions.add(id);return true;}
    return false;
  }
  const hooks:Hooks={
    'chat.message':async(input)=>{if(input.agent==='gal-advisor') advisorSessions.add(input.sessionID);},
    tool: {
      gal_status: tool({description:'Read compact Gal status. Set raw=true only when the full persisted state is explicitly needed for diagnostics.',args:{raw:tool.schema.boolean().optional()},async execute(args,ctx){return transaction(ctx.sessionID,g=>serialize({...g.status(args.raw===true),effectiveConfig:config,capabilities:{strictCompletion:Boolean(authorizeRead),generationInterrupt:false},generationMonitor:monitorState}));}}),
      gal_inspect_text:tool({description:'Read strict UTF-8 bytes and codepoints without editing. This is an observation, including during NEXT recovery.',args:{path:tool.schema.string().min(1),encoding:tool.schema.literal('utf-8').optional(),startLine:tool.schema.number().int().positive().optional(),lineCount:tool.schema.number().int().min(1).max(100).optional()},async execute(args,ctx){
        if(!authorizeRead&&typeof ctx.ask!=='function') throw Error('GAL text inspection unavailable: host read permission API is required');
        const authorize=authorizeRead??(async(_id:string,path:string,external:boolean)=>{
          if(external) await ctx.ask({permission:'external_directory',patterns:[path],always:[],metadata:{}});
          await ctx.ask({permission:'read',patterns:[path],always:[],metadata:{}});
        });
        return JSON.stringify(await inspectText(directory,args,ctx.sessionID,authorize));
      }}),
      gal_report: tool({description:'Report goal, evidence-backed hypothesis or visible loop signal. Never report hidden reasoning.',args:{
        goal:tool.schema.string().optional(),hypothesis:tool.schema.string().optional(),
        changePath:tool.schema.string().min(1).optional(),taskIDs:tool.schema.array(tool.schema.string().min(1)).min(1).optional(),requiredChecks:tool.schema.array(tool.schema.string().min(1)).min(1).optional(),
        status:tool.schema.enum(['SUPPORTED','REFUTED','UNTESTED']).optional(),
        evidence:tool.schema.array(tool.schema.string()).optional(),
        signal:tool.schema.enum(['manual_verification','contradicted_baseline','advisor_approach_reuse','speculation','narrative_debugging','scope_drift','semantic_loop','assumption_lock','blast_radius']).optional(),
      },async execute(args,ctx){return transaction(ctx.sessionID,g=>{
        if(args.requiredChecks&&(!authorizeRead||args.requiredChecks.some(id=>!config.checks.some(c=>c.id===id)))) throw Error('GAL requiredChecks need registered checks and V2 host read permission support');
        g.report(args);return serialize(g.status());
      });}}),
      gal_reopen: tool({description:'Reopen a task after GAL recorded verified completion. Requires a concrete reason and evidence IDs produced after the completion checkpoint. Use only for a newly observed defect, not cosmetic speculation.',args:{
        reason:tool.schema.string(),evidence:tool.schema.array(tool.schema.string()),
      },async execute(args,ctx){return transaction(ctx.sessionID,g=>{g.reopen(args.reason,args.evidence);return 'GAL REOPEN\n'+serialize(g.status());});}}),
      gal_accept: tool({description:'Accept the Advisor NEXT MOVE. Supply only reason and current-episode evidence IDs; the stored Advisor NEXT is used automatically.',args:{
        reason:tool.schema.string(),evidence:tool.schema.array(tool.schema.string()),
      },async execute(args,ctx){return transaction(ctx.sessionID,g=>{
        g.contract('ACCEPT',args.reason,args.evidence,{tool:'',args:{}});
        return 'GAL ACCEPT\nPHASE=NEXT\nEXECUTE EXACTLY: '+serialize(g.s.move);
      });}}),
      gal_reject: tool({description:notice('Reject the Advisor NEXT MOVE using objective evidence and contract one different valid observation. read {'+(v2?'path':'filePath')+'}; glob {pattern,path?}; grep {pattern,path?,include?}; bash only simple git diff/status/show/log.'),args:{
        reason:tool.schema.string(),evidence:tool.schema.array(tool.schema.string()),
        next_tool:tool.schema.enum(nextTools),next_args:tool.schema.record(tool.schema.string(),tool.schema.unknown()),
      },async execute(args,ctx){return transaction(ctx.sessionID,g=>{
        const move={tool:args.next_tool,args:args.next_args};
        g.contract('REJECT',args.reason,args.evidence,v2?canonicalMove(move):move);
        return 'GAL REJECT\nPHASE=NEXT\nEXECUTE EXACTLY: '+serialize(g.s.move);
      });}}),
      gal_repair: tool({description:'Repair only a NEXT_EXECUTING observation whose correct tool visibly returned a tool/schema/infrastructure error but no completion event. Contract one different valid observation.',args:{
        reason:tool.schema.string(),evidence:tool.schema.array(tool.schema.string()),
        next_tool:tool.schema.enum(nextTools),next_args:tool.schema.record(tool.schema.string(),tool.schema.unknown()),
      },async execute(args,ctx){return transaction(ctx.sessionID,g=>{
        const move={tool:args.next_tool,args:args.next_args};
        g.repair(args.reason,args.evidence,v2?canonicalMove(move):move);
        return 'GAL REPAIR\nPHASE=NEXT\nEXECUTE EXACTLY: '+serialize(g.s.move);
      });}}),
    },
    'tool.execute.before':async(input,output)=>{
      if(await isAdvisor(input.sessionID)) {
        await transaction(input.sessionID,g=>{
          if(!['read','glob','grep','gal_inspect_text'].includes(input.tool)) throw Error('GAL Advisor is observation-only');
          if((g.s.metrics.advisor_observations??0)>=2) throw Error('GAL Advisor observation budget exhausted; return diagnosis now');
          g.metric('advisor_observations');
        });
        return;
      }
      await transaction(input.sessionID,async g=>{
        if(input.tool!=='gal_status'&&!g.s.generationHold) await runtime.refresh(g,input.sessionID);
        g.before(input.tool,output.args,Boolean(runtime.matches(input.tool,output.args)));
        await runtime.before(g,input.sessionID,input.tool,output.args,input.callID);
        if(input.tool==='task'&&output.args.subagent_type==='gal-advisor') {
          g.consult();delete output.args.task_id;delete output.args.sessionID;
          output.args.prompt=(v2?'Runtime: OpenCode 2. Use subagent (agent), shell, and read {path}. NEXT MOVE must use those native names. Packet evidence uses canonical V1 names.\n':'')+g.packet();
        }
      });
    },
    'tool.execute.after':async(input,output)=>{
      if(await isAdvisor(input.sessionID)) return;
      const exit=typeof output.metadata?.exit==='number'?output.metadata.exit:undefined;
      if(exit!==undefined&&exit!==0) failedCalls.add(input.sessionID+':'+input.callID);
      await transaction(input.sessionID,async g=>{
        if(input.tool==='task'&&input.args.subagent_type==='gal-advisor') {
          let advice=output.output;
          if(v2) {
            try {
              const section=advice.split('NEXT MOVE')[1].split('EXPECTED RESULT')[0];
              const json=section.slice(section.indexOf('{'),section.lastIndexOf('}')+1);
              advice=advice.replace(json,JSON.stringify(canonicalMove(JSON.parse(json) as Move)));
            } catch { /* Guard records invalid recommendations without unlocking. */ }
          }
          g.advised(advice);return;
        }
        if(input.tool.startsWith('gal_')&&input.tool!=='gal_inspect_text') return;
        const verification=await runtime.after(g,input.sessionID,input.tool,input.args,input.callID,output.output,exit,output.metadata?._galResult);
        if(verification.handled) {
          if(verification.note) output.output+='\n'+verification.note;
          if(g.s.phase==='REQUIRED') output.output+='\n'+notice('GAL GUARD TRIGGERED. Stop retries. Invoke task subagent_type=gal-advisor.\n'+g.guardNotice());
          await runtime.refresh(g,input.sessionID);return;
        }
        const note=g.observe(input.tool,input.args,output.output,exit);
        if(note) output.output+='\n'+note;
        await runtime.refresh(g,input.sessionID);
        if(g.s.phase==='REQUIRED') output.output+='\n'+notice('GAL GUARD TRIGGERED. Stop retries. Invoke task subagent_type=gal-advisor.\n'+g.guardNotice());
      });
    },
    'experimental.chat.system.transform':async(input,output)=>{
      if(!input.sessionID||await isAdvisor(input.sessionID)) return;
      await transaction(input.sessionID,g=>{
        if(g.s.phase==='RUNNING'&&g.s.completion) {
          const reopen=g.s.completionReopen;
          const msg=reopen
            ?(reopen.editUsed
              ?'GAL COMPLETION REOPEN. The one authorized corrective edit is used. Do not edit or run ad-hoc bash; run recognized verification now.'
              :'GAL COMPLETION REOPEN. Fresh evidence authorized exactly one corrective edit. Ad-hoc bash remains blocked; after the edit run recognized verification.')
            :'GAL COMPLETION CHECKPOINT. Verification passed and the OpenSpec task is marked complete. Do not edit or run ad-hoc bash. Observe with read/grep/glob/read-only git or rerun recognized verification. If new evidence proves a defect remains, use gal_reopen(reason,evidence).';
          if(output.system.length>0) output.system[output.system.length-1]+='\n'+notice(msg);
          else output.system.push(notice(msg));
        } else if(g.s.phase!=='RUNNING') {
          let msg='GAL '+g.s.phase+'. No retries or edits.';
          if(g.s.phase==='NEXT'&&g.s.move) {const move=hostMove(g.s.move);msg+='\nEXECUTE NOW — tool: '+move.tool+', args: '+JSON.stringify(move.args)+'\nPreserve the contracted values. Safe optional read/grep/glob args may be added.';}
          else if(g.s.phase==='NEXT_EXECUTING') msg+='\nThe contracted observation started but completion was not observed. Do not use ACCEPT/REJECT here. Only if the correct NEXT visibly returned a tool/schema/infrastructure error without a completion event, call gal_repair with current evidence and a different valid observation.';
          else msg+=' '+g.guardNotice();
          if(output.system.length>0) output.system[output.system.length-1]+='\n'+notice(msg);
          else output.system.push(notice(msg));
        }
      });
    },
    event:async({event})=>{
      if(event.type!=='message.part.updated') return;
      const part=event.properties.part;
      if(part.type!=='tool') return;
      const state=part.state;
      if(state.status!=='error'||state.error.startsWith('GAL ')) return;
      if(part.tool.startsWith('gal_')&&part.tool!=='gal_inspect_text') return;
      const callKey=part.sessionID+':'+part.callID;
      if(failedCalls.has(callKey)) return;
      failedCalls.add(callKey);
      if(await isAdvisor(part.sessionID)) return;
      await transaction(part.sessionID,g=>{
        if(part.tool==='task'&&g.s.phase==='CONSULTING') {g.exhaust('Advisor task failed; no automatic retry');return;}
        g.observe(part.tool,state.input,state.error,1);
      });
    },
  };
  return {
    ...hooks,
    settings:config,
    monitorState,
    async deferShell(sessionID,shellID,args,callID) {
      await transaction(sessionID,g=>{(g.s.pendingShells??={})[shellID]={...args,_galExecutionCall:callID};});
    },
    async completeShells(sessionID,notifications) {
      return transaction(sessionID,async g=>{
        const notes:string[]=[];
        for(const item of notifications) {
          const args=g.s.pendingShells?.[item.shellID];
          if(!args) continue;
          delete g.s.pendingShells![item.shellID];
          const callID=args._galExecutionCall;delete args._galExecutionCall;
          const verification=typeof callID==='string'?await runtime.after(g,sessionID,'bash',args,callID,item.output,item.exit,undefined):{handled:false};
          const note=verification.handled?verification.note:g.observe('bash',args,item.output,item.exit);
          if(note) notes.push(notice(note));
        }
        await runtime.refresh(g,sessionID);return notes;
      });
    },
  };
}
