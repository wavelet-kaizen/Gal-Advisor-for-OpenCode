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
        try { g=new Guard(JSON.parse(await readFile(path,'utf8')) as State); }
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
      gal_status: tool({description:'Read Gal state, evidence IDs, diagnosis and metrics.',args:{},async execute(_,ctx){return transaction(ctx.sessionID,g=>JSON.stringify(g.s));}}),
      gal_report: tool({description:'Report goal, evidence-backed hypothesis or visible loop signal. Never report hidden reasoning.',args:{
        goal:tool.schema.string().optional(),hypothesis:tool.schema.string().optional(),
        status:tool.schema.enum(['SUPPORTED','REFUTED','UNTESTED']).optional(),
        evidence:tool.schema.array(tool.schema.string()).optional(),
        signal:tool.schema.enum(['manual_verification','contradicted_baseline','advisor_approach_reuse','speculation','narrative_debugging','scope_drift','semantic_loop','assumption_lock','blast_radius']).optional(),
      },async execute(args,ctx){return transaction(ctx.sessionID,g=>{g.report(args);return g.packet();});}}),
      gal_recover: tool({description:'Commit GAL ACCEPT/REJECT with objective evidence IDs and exactly one next observation. ACCEPT uses the Advisor NEXT MOVE automatically. For REJECT: read requires {filePath:string}; glob {pattern:string,path?:string}; grep {pattern:string,path?:string,include?:string}; bash is limited to simple git diff/status/show/log.',args:{
        decision:tool.schema.enum(['ACCEPT','REJECT']),reason:tool.schema.string(),evidence:tool.schema.array(tool.schema.string()),
        next_tool:tool.schema.enum(['read','glob','grep','bash']).optional(),next_args:tool.schema.record(tool.schema.string(),tool.schema.unknown()).optional(),
      },async execute(args,ctx){return transaction(ctx.sessionID,g=>{
        const move=args.next_tool&&args.next_args?{tool:args.next_tool,args:args.next_args}:{tool:'',args:{}};
        g.contract(args.decision,args.reason,args.evidence,move);
        return 'GAL '+args.decision+'\nNEXT: '+JSON.stringify(g.s.move);
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
          g.consult();
          delete output.args.task_id;
          output.args.prompt=g.packet();
        }
      });
    },
    'tool.execute.after':async(input,output)=>{
      if(await isAdvisor(input.sessionID)) return;
      await transaction(input.sessionID,g=>{
        if(input.tool==='task'&&input.args.subagent_type==='gal-advisor') {g.advised(output.output);return;}
        if(input.tool.startsWith('gal_')) return;
        g.observe(input.tool,input.args,output.output,typeof output.metadata?.exit==='number'?output.metadata.exit:undefined);
        if(g.s.phase==='REQUIRED') output.output+='\nGAL GUARD TRIGGERED. Stop retries. Invoke task subagent_type=gal-advisor.\n'+g.packet();
      });
    },
    'experimental.chat.system.transform':async(input,output)=>{
      if(!input.sessionID || await isAdvisor(input.sessionID)) return;
      await transaction(input.sessionID,g=>{
        if(g.s.phase!=='RUNNING') {
          let msg='GAL '+g.s.phase+'. No retries or edits.';
          if(g.s.phase==='NEXT' && g.s.move) msg+='\nEXECUTE NOW — tool: '+g.s.move.tool+', args: '+JSON.stringify(g.s.move.args)+'\nDo not call gal_recover again. Call the tool above with exactly these args.';
          else msg+=' '+g.packet()+'\n'+(g.s.advice??'');
          if(output.system.length>0) output.system[output.system.length-1]+='\n'+msg;
          else output.system.push(msg);
        }
      });
    },
    event:async({event})=>{
      if(event.type!=='message.part.updated') return;
      const part=event.properties.part;
      if(part.type!=='tool'||part.state.status!=='error'||part.state.error.startsWith('GAL ')) return;
      if(part.tool.startsWith('gal_')) return;
      const error=part.state.error;
      const callKey=part.sessionID+':'+part.callID;
      if(failedCalls.has(callKey)) return;
      failedCalls.add(callKey);
      if(await isAdvisor(part.sessionID)) return;
      await transaction(part.sessionID,g=>{
        if(part.tool==='task'&&g.s.phase==='CONSULTING') {g.exhaust('Advisor task failed; no automatic retry');return;}
        g.observe(part.tool,part.state.input,error,1);
      });
    },
  };
};
export default GalLoopGuard;
