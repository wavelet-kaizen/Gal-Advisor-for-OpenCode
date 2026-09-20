import type { Plugin } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';
import { Guard, hash, type State } from '../gal/guard.ts';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const GalLoopGuard: Plugin = async ({ directory, client }) => {
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
    const result=await client.session.messages({path:{id},query:{limit:20}});
    if(result.error) throw Error('Cannot identify session agent');
    if(result.data?.some(m=>m.info.role==='user'&&m.info.agent==='gal-advisor')) {advisorSessions.add(id);return true;}
    return false;
  }
  return {
    'chat.message':async(input)=>{if(input.agent==='gal-advisor') advisorSessions.add(input.sessionID);},
    tool: {
      gal_status: tool({description:'Read compact Gal status. Set raw=true only when the full persisted state is explicitly needed for diagnostics.',args:{raw:tool.schema.boolean().optional()},async execute(args,ctx){return transaction(ctx.sessionID,g=>JSON.stringify(g.status(args.raw===true)));}}),
      gal_report: tool({description:'Report goal, evidence-backed hypothesis or visible loop signal. Never report hidden reasoning.',args:{
        goal:tool.schema.string().optional(),hypothesis:tool.schema.string().optional(),
        status:tool.schema.enum(['SUPPORTED','REFUTED','UNTESTED']).optional(),
        evidence:tool.schema.array(tool.schema.string()).optional(),
        signal:tool.schema.enum(['manual_verification','contradicted_baseline','advisor_approach_reuse','speculation','narrative_debugging','scope_drift','semantic_loop','assumption_lock','blast_radius']).optional(),
      },async execute(args,ctx){return transaction(ctx.sessionID,g=>{g.report(args);return JSON.stringify(g.status());});}}),
      gal_reopen: tool({description:'Reopen a task after GAL recorded verified completion. Requires a concrete reason and evidence IDs produced after the completion checkpoint. Use only for a newly observed defect, not cosmetic speculation.',args:{
        reason:tool.schema.string(),evidence:tool.schema.array(tool.schema.string()),
      },async execute(args,ctx){return transaction(ctx.sessionID,g=>{g.reopen(args.reason,args.evidence);return 'GAL REOPEN\n'+JSON.stringify(g.status());});}}),
      gal_accept: tool({description:'Accept the Advisor NEXT MOVE. Supply only reason and current-episode evidence IDs; the stored Advisor NEXT is used automatically.',args:{
        reason:tool.schema.string(),evidence:tool.schema.array(tool.schema.string()),
      },async execute(args,ctx){return transaction(ctx.sessionID,g=>{
        g.contract('ACCEPT',args.reason,args.evidence,{tool:'',args:{}});
        return 'GAL ACCEPT\nPHASE=NEXT\nEXECUTE EXACTLY: '+JSON.stringify(g.s.move);
      });}}),
      gal_reject: tool({description:'Reject the Advisor NEXT MOVE using objective evidence and contract one different valid observation. read {filePath}; glob {pattern,path?}; grep {pattern,path?,include?}; bash only simple git diff/status/show/log.',args:{
        reason:tool.schema.string(),evidence:tool.schema.array(tool.schema.string()),
        next_tool:tool.schema.enum(['read','glob','grep','bash']),next_args:tool.schema.record(tool.schema.string(),tool.schema.unknown()),
      },async execute(args,ctx){return transaction(ctx.sessionID,g=>{
        g.contract('REJECT',args.reason,args.evidence,{tool:args.next_tool,args:args.next_args});
        return 'GAL REJECT\nPHASE=NEXT\nEXECUTE EXACTLY: '+JSON.stringify(g.s.move);
      });}}),
      gal_repair: tool({description:'Repair only a NEXT_EXECUTING observation whose correct tool visibly returned a tool/schema/infrastructure error but no completion event. Contract one different valid observation.',args:{
        reason:tool.schema.string(),evidence:tool.schema.array(tool.schema.string()),
        next_tool:tool.schema.enum(['read','glob','grep','bash']),next_args:tool.schema.record(tool.schema.string(),tool.schema.unknown()),
      },async execute(args,ctx){return transaction(ctx.sessionID,g=>{
        g.repair(args.reason,args.evidence,{tool:args.next_tool,args:args.next_args});
        return 'GAL REPAIR\nPHASE=NEXT\nEXECUTE EXACTLY: '+JSON.stringify(g.s.move);
      });}}),
    },
    'tool.execute.before':async(input,output)=>{
      if(await isAdvisor(input.sessionID)) {
        await transaction(input.sessionID,g=>{
          if(!['read','glob','grep'].includes(input.tool)) throw Error('GAL Advisor is observation-only');
          if((g.s.metrics.advisor_observations??0)>=2) throw Error('GAL Advisor observation budget exhausted; return diagnosis now');
          g.metric('advisor_observations');
        });
        return;
      }
      await transaction(input.sessionID,g=>{
        g.before(input.tool,output.args);
        if(input.tool==='task'&&output.args.subagent_type==='gal-advisor') {
          g.consult();delete output.args.task_id;output.args.prompt=g.packet();
        }
      });
    },
    'tool.execute.after':async(input,output)=>{
      if(await isAdvisor(input.sessionID)) return;
      const exit=typeof output.metadata?.exit==='number'?output.metadata.exit:undefined;
      if(exit!==undefined&&exit!==0) failedCalls.add(input.sessionID+':'+input.callID);
      await transaction(input.sessionID,g=>{
        if(input.tool==='task'&&input.args.subagent_type==='gal-advisor') {g.advised(output.output);return;}
        if(input.tool.startsWith('gal_')) return;
        const note=g.observe(input.tool,input.args,output.output,exit);
        if(note) output.output+='\n'+note;
        if(g.s.phase==='REQUIRED') output.output+='\nGAL GUARD TRIGGERED. Stop retries. Invoke task subagent_type=gal-advisor.\n'+g.guardNotice();
      });
    },
    'experimental.chat.system.transform':async(input,output)=>{
      if(!input.sessionID||await isAdvisor(input.sessionID)) return;
      await transaction(input.sessionID,g=>{
        if(g.s.phase==='RUNNING'&&g.s.completion) {
          const msg='GAL COMPLETION CHECKPOINT. Verification passed and the OpenSpec task is marked complete. Do not edit or run ad-hoc bash. Observe with read/grep/glob/read-only git or rerun recognized verification. If new evidence proves a defect remains, use gal_reopen(reason,evidence).';
          if(output.system.length>0) output.system[output.system.length-1]+='\n'+msg;
          else output.system.push(msg);
        } else if(g.s.phase!=='RUNNING') {
          let msg='GAL '+g.s.phase+'. No retries or edits.';
          if(g.s.phase==='NEXT'&&g.s.move) msg+='\nEXECUTE NOW — tool: '+g.s.move.tool+', args: '+JSON.stringify(g.s.move.args)+'\nPreserve the contracted values. Safe optional read/grep/glob args may be added.';
          else if(g.s.phase==='NEXT_EXECUTING') msg+='\nThe contracted observation started but completion was not observed. Do not use ACCEPT/REJECT here. Only if the correct NEXT visibly returned a tool/schema/infrastructure error without a completion event, call gal_repair with current evidence and a different valid observation.';
          else msg+=' '+g.guardNotice();
          if(output.system.length>0) output.system[output.system.length-1]+='\n'+msg;
          else output.system.push(msg);
        }
      });
    },
    event:async({event})=>{
      if(event.type!=='message.part.updated') return;
      const part=event.properties.part;
      if(part.type!=='tool') return;
      const state=part.state;
      if(state.status!=='error'||state.error.startsWith('GAL ')) return;
      if(part.tool.startsWith('gal_')) return;
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
};
export default GalLoopGuard;
