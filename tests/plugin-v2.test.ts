import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import type { Plugin } from '@opencode/plugin';
import type { Info, ToolContext } from '@opencode/plugin/promise/tool';
import type { SessionContext } from '@opencode/plugin/promise/session';
import entrypoint from '../.opencode/plugins/gal-loop-guard.ts';

type ToolEvent=Parameters<Parameters<Plugin.Context['tool']['hook']>[1]>[0];
type After=Extract<ToolEvent,{status:string}>;
type Before=Exclude<ToolEvent,After>;
type Messages=Awaited<ReturnType<Plugin.Context['session']['context']>>;
const diagnosis=(move:unknown)=>'DIAGNOSIS\nstalled\nDEAD ASSUMPTION\n未確定\nEVIDENCE\ne1\nNEXT MOVE\n'+JSON.stringify(move)+'\nEXPECTED RESULT\ndiscriminates\nDO NOT\nrepeat';

async function fixture(t:TestContext,options?:{config:unknown;permissions?:boolean}) {
  const directory=await mkdtemp(join(tmpdir(),'gal-v2-'));
  t.after(async()=>{
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()));
    assert.match(directory,/gal-v2-[^\\/]+$/);
    await rm(directory,{recursive:true,force:true});
  });
  const tools=new Map<string,Info>();
  if(options){await mkdir(join(directory,'.opencode'));await writeFile(join(directory,'.opencode','gal.json'),JSON.stringify(options.config));}
  let before!:(event:Before)=>Promise<void>|void;
  let after!:(event:After)=>Promise<void>|void;
  let context!:(event:SessionContext)=>Promise<void>|void;
  let messages:Messages=[];
  let wait:()=>Promise<void>=async()=>{};
  let count=0;
  const ctx={
    location:{directory},
    permission:options?.permissions?{assert:async()=>{}}:undefined,
    tool:{
      transform:async(callback:(editor:{add:(tool:Info)=>void})=>void)=>{callback({add:tool=>tools.set(tool.name,tool)});return {dispose:async()=>{}};},
      hook:async(name:string,callback:never)=>{if(name==='execute.before') before=callback;else after=callback;return {dispose:async()=>{}};},
    },
    session:{
      get:async({sessionID}:{sessionID:string})=>({agent:sessionID==='child'?'gal-advisor':'build'}),
      context:async()=>messages,
      wait:async()=>wait(),
      hook:async(name:string,callback:never)=>{assert.equal(name,'context');context=callback;return {dispose:async()=>{}};},
    },
  } as unknown as Plugin.Context;
  const reload=()=>entrypoint.setup(ctx);
  await reload();
  const call=(tool:string,input:unknown,sessionID='parent'):Before=>({tool,input,sessionID,agent:sessionID==='child'?'gal-advisor':'build',messageID:'message',id:'call-'+(++count)} as Before);
  type Result=Extract<After,{status:'completed'}>['result'];
  const done=async(event:Before,result:Result)=>{
    const completed={...event,status:'completed',result} as Extract<After,{status:'completed'}>;
    await after(completed);return completed.result;
  };
  const control=async(name:string,input:unknown={},sessionID='parent')=>{
    const event=call(name,input,sessionID);
    await before(event);
    const result=await tools.get(name)!.execute(event.input,{sessionID} as ToolContext);
    await done(event,result);
    return typeof result.content==='string'?result.content:'';
  };
  const status=async(sessionID='parent')=>JSON.parse(await control('gal_status',{},sessionID));
  const system=async(sessionID='parent',system:SessionContext['system']=[{type:'text',text:'base'}])=>{
    const event={sessionID,agent:sessionID==='child'?'gal-advisor':'build',system} as SessionContext;
    await context(event);return event.system;
  };
  const fail=async()=>{
    const event=call('shell',{command:'npm test'});
    await before(event);
    return done(event,{content:'a.ts:10\nTypeError: broken',output:{exit:1},metadata:{exit:1}});
  };
  return {directory,tools,call,done,control,status,system,fail,reload,before:(event:Before)=>before(event),after:(event:After)=>after(event),
    setMessages:(value:unknown)=>{messages=value as Messages;},setWait:(value:()=>Promise<void>)=>{wait=value;}};
}

test('V2 official entrypoint registers control tools and the text observation with JSON schemas',async t=>{
  const f=await fixture(t);
  assert.equal(entrypoint.id,'gal-loop-guard');
  assert.equal(typeof entrypoint.server,'function');
  assert.equal(f.tools.size,7);
  for(const definition of f.tools.values()) {
    assert.equal(definition.options?.codemode,false);
    assert.equal((definition.input as {type:string}).type,'object');
  }
  const schema=f.tools.get('gal_reject')!.input as {properties:{next_tool:{enum:string[]}}};
  assert.deepEqual(schema.properties.next_tool.enum,['read','glob','grep','shell','gal_inspect_text']);
});

test('V2 native shell goal gate, failure lockout, system context and persisted reload',async t=>{
  const f=await fixture(t);
  await f.before(f.call('read',{path:'a.ts'}));
  await assert.rejects(async()=>f.before(f.call('shell',{command:'npm test'})),/GAL GOAL REQUIRED/);
  await f.control('gal_report',{goal:'Support V2'});
  await f.fail();
  const result=await f.fail();
  assert.match(String(result.content),/Invoke subagent agent=gal-advisor/);
  await f.reload();
  assert.equal((await f.status()).phase,'REQUIRED');
  await assert.rejects(async()=>f.before(f.call('edit',{path:'a.ts'})),/GAL GUARD/);
  await assert.rejects(async()=>f.before(f.call('execute',{code:'bypass()'})),/GAL GUARD/);
  await assert.rejects(async()=>f.before(f.call('subagent',{agent:'build',prompt:'bypass'})),/GAL GUARD/);
  const system=await f.system();
  assert.equal(system.length,1);
  assert.match((system[0] as {text:string}).text,/base\nGAL REQUIRED/);
  assert.match((system[0] as {text:string}).text,/subagent agent=gal-advisor/);
});

test('V2 foreground Advisor packet starts fresh and native read NEXT completes once',async t=>{
  const f=await fixture(t);
  await f.control('gal_report',{goal:'Support V2'});await f.fail();await f.fail();
  const task=f.call('subagent',{agent:'gal-advisor',description:'diagnose',sessionID:'old',task_id:'old',prompt:'untrusted'});
  await f.before(task);
  assert.equal('sessionID' in (task.input as object),false);
  assert.equal('task_id' in (task.input as object),false);
  assert.match((task.input as {prompt:string}).prompt,/GAL DIAGNOSTIC PACKET/);
  assert.doesNotMatch((task.input as {prompt:string}).prompt,/untrusted/);
  await f.done(task,{output:{sessionID:'child',status:'completed',output:diagnosis({tool:'read',args:{path:'a.ts'}})}});
  const state=await f.status();
  const evidence=state.evidence.map((item:{id:string})=>item.id);
  const accepted=await f.control('gal_accept',{reason:'Inspect failure',evidence});
  assert.match(accepted,/"path":"a.ts"/);
  assert.doesNotMatch(accepted,/filePath/);
  await assert.rejects(async()=>f.before(f.call('read',{path:'b.ts'})),/NEXT MISMATCH/);
  await f.control('gal_accept',{reason:'Inspect failure',evidence});
  const read=f.call('read',{path:'a.ts',limit:20});await f.before(read);
  const result=await f.done(read,{content:[{type:'text',text:'source'},{type:'file',uri:'file:///image.png',mime:'image/png'}],output:{kind:'file'},metadata:{preserved:true}});
  assert.deepEqual(result.output,{kind:'file'});assert.equal(result.metadata?.preserved,true);
  assert.ok(Array.isArray(result.content)&&result.content.some(p=>p.type==='file'));
  assert.match(JSON.stringify(result.content),/GAL RECOVERY COMPLETE/);
  assert.equal((await f.status()).phase,'RUNNING');
});

test('V2 background-only Advisor stays CONSULTING until its final text arrives',async t=>{
  const f=await fixture(t);
  await f.control('gal_report',{goal:'Support V2'});await f.fail();await f.fail();
  const task=f.call('subagent',{agent:'gal-advisor',prompt:'diagnose'});await f.before(task);
  let release!:()=>void;
  let started!:()=>void;
  const waiting=new Promise<void>(resolve=>{started=resolve;});
  f.setWait(()=>{started();return new Promise<void>(resolve=>{release=resolve;});});
  f.setMessages([{type:'assistant',content:[{type:'reasoning',text:'hidden'},{type:'text',text:diagnosis({tool:'shell',args:{command:'git diff'}})}]}]);
  const pending=f.done(task,{content:'working',output:{sessionID:'child',status:'running'}});
  await waiting;
  assert.equal((await f.status()).phase,'CONSULTING');
  await assert.rejects(async()=>f.before(f.call('edit',{path:'a.ts'})),/GAL GUARD/);
  release();await pending;
  const state=await f.status();assert.equal(state.phase,'CONTRACT');
  const accepted=await f.control('gal_accept',{reason:'Inspect diff',evidence:state.evidence.map((e:{id:string})=>e.id)});
  assert.match(accepted,/"tool":"shell"/);
  const shell=f.call('shell',{command:'git diff'});await f.before(shell);
  const result=await f.done(shell,{content:'diff',output:{exit:0}});
  assert.match(String(result.content),/GAL RECOVERY COMPLETE/);
});

test('V2 native error events deduplicate failures and exhaust a failed consultation',async t=>{
  const f=await fixture(t);
  await f.control('gal_report',{goal:'Support V2'});
  const event=f.call('read',{path:'missing.ts'});await f.before(event);
  const error={...event,status:'error',error:{message:'File not found'}} as After;
  await f.after(error);await f.after(error);
  assert.equal((await f.status()).metrics.tool_calls,1);
  const second=f.call('read',{path:'missing.ts'});await f.before(second);
  await f.after({...second,status:'error',error:{message:'File not found'}} as After);
  assert.equal((await f.status()).phase,'REQUIRED');
  const task=f.call('subagent',{agent:'gal-advisor',prompt:'diagnose'});await f.before(task);
  await f.after({...task,status:'error',error:{message:'Provider unavailable'}} as After);
  assert.equal((await f.status()).phase,'EXHAUSTED');
});

test('V2 background Advisor wait failure fails closed',async t=>{
  const f=await fixture(t);
  const task=f.call('subagent',{agent:'gal-advisor',prompt:'diagnose'});await f.before(task);
  f.setWait(async()=>{throw Error('session unavailable');});
  await f.done(task,{output:{sessionID:'child',status:'running'}});
  assert.equal((await f.status()).phase,'EXHAUSTED');
});

test('V2 Advisor isolation permits only two observations and never inherits parent gates',async t=>{
  const f=await fixture(t);
  await f.before(f.call('read',{path:'a.ts'},'child'));
  await f.before(f.call('grep',{pattern:'x',path:'a.ts'},'child'));
  await assert.rejects(async()=>f.before(f.call('read',{path:'b.ts'},'child')),/budget exhausted/);
  await assert.rejects(async()=>f.before(f.call('shell',{command:'git diff'},'child')),/observation-only/);
  await assert.rejects(async()=>f.before(f.call('gal_report',{goal:'bypass'},'child')),/observation-only/);
  assert.equal((await f.status()).metrics.tool_calls??0,0);
  assert.deepEqual(await f.system('child'),[{type:'text',text:'base'}]);
});

test('V2 native edit path arms completion and preserves the system message',async t=>{
  const f=await fixture(t);
  await f.control('gal_report',{goal:'Complete task'});
  const check=f.call('shell',{command:'npm test'});await f.before(check);
  await f.done(check,{content:'all pass',output:{exit:0}});
  const edit=f.call('edit',{path:'openspec/changes/v2/tasks.md',oldString:'- [ ] 1.1 support',newString:'- [x] 1.1 support'});await f.before(edit);
  await f.done(edit,{content:'updated'});
  assert.equal((await f.status()).metrics.completion_checkpoints,1);
  const system=await f.system();assert.equal(system.length,1);
  assert.match((system[0] as {text:string}).text,/GAL COMPLETION CHECKPOINT/);
  await assert.rejects(async()=>f.before(f.call('edit',{path:'a.ts'})),/GAL COMPLETION GUARD/);
});

test('V2 running shell is not a verification pass; completion survives reload and is consumed once',async t=>{
  const f=await fixture(t);
  await f.control('gal_report',{goal:'Verify V2'});
  const check=f.call('shell',{command:'npm test',background:true});await f.before(check);
  await f.done(check,{content:'working',output:{shellID:'shell-1',status:'running'}});
  assert.equal((await f.status()).metrics.verification_passes??0,0);
  await f.reload();
  f.setMessages([{type:'synthetic',text:'all pass',metadata:{source:'shell',shellID:'shell-1',state:'completed',exit:0}}]);
  await f.system();await f.system();
  assert.equal((await f.status()).metrics.verification_passes,1);
});

test('V2 native REJECT and REPAIR return executable host contracts',async t=>{
  const f=await fixture(t);
  await f.control('gal_report',{goal:'Recover V2'});await f.fail();await f.fail();
  const task=f.call('subagent',{agent:'gal-advisor',prompt:'diagnose'});await f.before(task);
  await f.done(task,{output:{status:'completed',output:diagnosis({tool:'read',args:{path:'a.ts'}})}});
  const evidence=(await f.status()).evidence.map((e:{id:string})=>e.id);
  const rejected=await f.control('gal_reject',{reason:'Inspect repository state instead',evidence,next_tool:'shell',next_args:{command:'git status'}});
  assert.match(rejected,/"tool":"shell"/);
  assert.match(JSON.stringify(await f.system()),/tool: shell/);
  await f.before(f.call('shell',{command:'git status'}));
  const repaired=await f.control('gal_repair',{reason:'Correct call visibly failed in infrastructure without its completion hook',evidence,next_tool:'read',next_args:{path:'b.ts'}});
  assert.match(repaired,/"path":"b.ts"/);
  const read=f.call('read',{path:'b.ts'});await f.before(read);
  assert.match(String((await f.done(read,{content:'source'})).content),/GAL RECOVERY COMPLETE/);
});

test('V2 background shell failures trigger the guard when completion notifications arrive',async t=>{
  const f=await fixture(t);
  await f.control('gal_report',{goal:'Observe asynchronous failures'});
  for(const shellID of ['one','two']) {
    const event=f.call('shell',{command:'npm test',background:true});await f.before(event);
    await f.done(event,{output:{status:'running',shellID}});
  }
  f.setMessages(['one','two'].map(shellID=>({type:'synthetic',text:'a.ts:10\nTypeError: broken',metadata:{source:'shell',shellID,state:'completed',exit:1}})));
  const system=await f.system();
  assert.equal(system.length,1);
  assert.match((system[0] as {text:string}).text,/GAL REQUIRED/);
  assert.equal((await f.status()).metrics.verification_passes??0,0);
});

test('V2 timed-out shell results cannot manufacture a verification pass',async t=>{
  const f=await fixture(t);
  await f.control('gal_report',{goal:'Verify timeouts'});
  const event=f.call('shell',{command:'npm test'});await f.before(event);
  await f.done(event,{content:'Command timed out before completion.',output:{timeout:true}});
  assert.equal((await f.status()).metrics.verification_passes??0,0);
  assert.equal((await f.status()).evidence[0].kind,'tooling');
  const raw=JSON.parse(await f.control('gal_status',{raw:true}));
  assert.match(raw.evidence[0].output,/timed out/);
});

test('V2 permission-capable host binds strict completion and re-verifies exactly one reopened edit',async t=>{
  const f=await fixture(t,{permissions:true,config:{checks:[{id:'unit',scope:'unit',kind:'test',paths:['Source.java'],command:'java RunSingleTest'}]}});
  await writeFile(join(f.directory,'Source.java'),'class Source {}');
  await mkdir(join(f.directory,'openspec/changes/x'),{recursive:true});
  const tasks=join(f.directory,'openspec/changes/x/tasks.md');await writeFile(tasks,'- [ ] 1.1 implement');
  await f.control('gal_report',{goal:'strict task',changePath:'openspec/changes/x',taskIDs:['1.1'],requiredChecks:['unit']});
  const run=async()=>{const event=f.call('shell',{command:'java RunSingleTest'});await f.before(event);await f.done(event,{content:'Tests run: 1, Failures: 0, Errors: 0',output:{exit:0}});};
  await run();
  const edit=f.call('edit',{path:tasks,oldString:'- [ ] 1.1 implement',newString:'- [x] 1.1 implement'});await f.before(edit);
  await writeFile(tasks,'- [x] 1.1 implement');await f.done(edit,{content:'updated'});
  assert.ok((await f.status()).completion);
  const read=f.call('read',{path:'Source.java'});await f.before(read);await f.done(read,{content:'newly observed defect'});
  const state=await f.status();await f.control('gal_reopen',{reason:'new source defect',evidence:[state.evidence.at(-1).id]});
  const fix=f.call('edit',{path:'Source.java'});await f.before(fix);await writeFile(join(f.directory,'Source.java'),'class Source {int fixed;}');await f.done(fix,{content:'fixed'});
  await assert.rejects(async()=>f.before(f.call('edit',{path:'Source.java'})),/GAL COMPLETION GUARD/);
  await run();assert.ok((await f.status()).completion);assert.equal((await f.status()).completionReopen,undefined);
});

test('V2 text inspection refuses hosts without a read permission API',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.control('gal_inspect_text',{path:'Source.java'}),/read permission API/);
});
