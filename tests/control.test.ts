import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createGuardHooks } from '../.opencode/gal/plugin.ts';
import { Guard, hash } from '../.opencode/gal/guard.ts';
import { ControlInputError } from '../.opencode/gal/control.ts';

async function fixture(t:TestContext,options?:{permissions?:boolean;config?:unknown;denyRead?:boolean}) {
  const directory=await mkdtemp(join(tmpdir(),'gal-control-'));
  t.after(async()=>{
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()));
    assert.match(directory,/gal-control-[^\\/]+$/);
    await rm(directory,{recursive:true,force:true});
  });
  if(options?.config) {await mkdir(join(directory,'.opencode'));await writeFile(join(directory,'.opencode/gal.json'),JSON.stringify(options.config));}
  const reload=()=>createGuardHooks(directory,async()=>false,true,options?.permissions?async()=>{if(options.denyRead) throw Error('permission denied');}:undefined);
  let hooks=await reload();let callID=0;
  const before=(tool:string,args:Record<string,unknown>)=>hooks['tool.execute.before']!({sessionID:'main',tool,callID:'c'+(++callID)},{args});
  const control=async(name:string,args:Record<string,unknown>={})=>{
    const id='c'+(++callID);
    await hooks['tool.execute.before']!({sessionID:'main',tool:name,callID:id},{args});
    try {return await (hooks.tool![name] as any).execute(args,{sessionID:'main'});} catch(error) {
      // Real hosts also emit an error event after the tool rejects. It must not
      // count twice or enter the ordinary recovery-failure machinery.
      await hooks.event!({event:{type:'message.part.updated',properties:{part:{type:'tool',sessionID:'main',callID:id,tool:name,state:{status:'error',input:args,error:(error as Error).message}}}}} as any);
      throw error;
    }
  };
  const status=async()=>JSON.parse(String(await control('gal_status')));
  const system=async()=>{
    const output={system:['base']};await hooks['experimental.chat.system.transform']!({sessionID:'main',model:{}as any},output);return output.system;
  };
  return {directory,before,control,status,system,reload:async()=>{hooks=await reload();},hooks:()=>hooks};
}

test('repeated report input errors survive reload without locking discovery or goal correction',async t=>{
  const f=await fixture(t);
  for(let i=0;i<2;i++) await assert.rejects(f.control('gal_report',{goal:'check '+i,changePath:'Source.java'}),/Omit changePath, taskIDs and requiredChecks together/);
  await f.reload();
  const state=await f.status();
  assert.equal(state.phase,'RUNNING');assert.equal(state.goal,'');assert.equal(state.strict,undefined);
  assert.equal(state.controlInputs.gal_report.count,2);assert.equal(state.metrics.control_input_errors,2);
  assert.equal(state.metrics.triggers,undefined);assert.equal(state.evidenceCount,0);
  const system=await f.system();assert.equal(system.length,1);assert.match(system[0],/GAL CONTROL INPUT REPEAT/);
  await f.before('read',{filePath:'Source.java'});await f.before('bash',{command:'git status'});
  await assert.rejects(f.before('edit',{filePath:'Source.java'}),/GAL GOAL REQUIRED/);
  const fixed=JSON.parse(await f.control('gal_report',{goal:'verify one test'}));
  assert.equal(fixed.controlInputs,undefined);assert.equal(fixed.goal,'verify one test');
  await f.before('edit',{filePath:'Source.java'});
  assert.doesNotMatch((await f.system())[0],/GAL CONTROL INPUT REPEAT/);
});

test('host capability and missing check IDs have distinct actionable errors without changing a registered goal',async t=>{
  const f=await fixture(t);await f.control('gal_report',{goal:'original task'});
  const strict={changePath:'openspec/changes/x',taskIDs:['1.1'],requiredChecks:['unit']};
  for(let i=0;i<2;i++) await assert.rejects(f.control('gal_report',strict),/host lacks the V2 read permission API/);
  await f.before('bash',{command:'npm test'});
  assert.equal((await f.status()).goal,'original task');
  assert.equal((await f.status()).phase,'RUNNING');
  const supported=await fixture(t,{permissions:true});
  await assert.rejects(supported.control('gal_report',strict),/available IDs: \(none\)/);
  assert.equal((await supported.status()).strict,undefined);
});

test('strict registration validates task directory and IDs before committing immutable state',async t=>{
  const f=await fixture(t,{permissions:true,config:{checks:[{id:'unit',scope:'unit',kind:'test',paths:['Source.java'],command:'npm test'}]}});
  const args={goal:'strict task',changePath:'Source.java',taskIDs:['1.1'],requiredChecks:['unit']};
  await writeFile(join(f.directory,'Source.java'),'class Source {}');
  await assert.rejects(f.control('gal_report',args),/existing OpenSpec change directory/);
  assert.equal((await f.status()).strict,undefined);assert.equal((await f.status()).goal,'');
  await mkdir(join(f.directory,'openspec/changes/x'),{recursive:true});
  await writeFile(join(f.directory,'openspec/changes/x/tasks.md'),'- [ ] 1.1 implement');
  args.changePath='openspec/changes/x';
  await assert.rejects(f.control('gal_report',{...args,taskIDs:['missing']}),/Each selected taskID/);
  assert.equal((await f.status()).strict,undefined);
  const fixed=JSON.parse(await f.control('gal_report',args));
  assert.equal(fixed.strict.changePath,args.changePath);assert.equal(fixed.controlInputs,undefined);
});

test('invalid hypothesis evidence cannot partially assign a goal or strict registration',()=>{
  const g=new Guard();
  assert.throws(()=>g.report({goal:'new',changePath:'openspec/changes/x',taskIDs:['1.1'],requiredChecks:['unit'],hypothesis:'claim',status:'SUPPORTED',evidence:['missing']}),/evidence IDs required/);
  assert.equal(g.s.goal,'');assert.equal(g.s.strict,undefined);assert.deepEqual(g.s.hypotheses,{});
});

test('late recovery completion retires input advice for a control tool no longer available',async t=>{
  const f=await fixture(t);await f.control('gal_report',{goal:'original task'});
  const g=new Guard();g.report({goal:'original task'});
  g.s.phase='NEXT_EXECUTING';g.s.move={tool:'read',args:{filePath:'Source.java'}};g.s.executing=g.s.move;
  for(let i=0;i<2;i++) g.controlInputError('gal_repair',new ControlInputError('repair_evidence','invalid evidence','correct the repair evidence'));
  assert.match(g.controlInputNotice(),/gal_repair/);
  // Load the state through the real transaction path, then observe the late NEXT.
  await mkdir(join(f.directory,'.gal-state'),{recursive:true});
  await writeFile(join(f.directory,'.gal-state',hash('main')+'.json'),JSON.stringify({...g.s,generationHold:{requestID:'r',incidentID:'i',phase:'NEXT_EXECUTING',status:'pending',reason:'test'}}));
  await f.reload();
  await f.hooks()['tool.execute.after']!({sessionID:'main',tool:'read',callID:'late',args:{filePath:'Source.java'}},{title:'source',output:'new evidence',metadata:{}});
  const state=await f.status();assert.equal(state.phase,'RUNNING');assert.equal(state.controlInputs,undefined);assert.ok(state.generationHold);
  assert.doesNotMatch((await f.system())[0],/GAL CONTROL INPUT REPEAT/);
});

test('permission failures are not input errors and leave registration retryable',async t=>{
  const f=await fixture(t,{permissions:true,denyRead:true,config:{checks:[{id:'unit',scope:'unit',kind:'test',paths:['Source.java'],command:'npm test'}]}});
  await mkdir(join(f.directory,'openspec/changes/x'),{recursive:true});
  await writeFile(join(f.directory,'openspec/changes/x/tasks.md'),'- [ ] 1.1 implement');
  for(let i=0;i<2;i++) await assert.rejects(f.control('gal_report',{goal:'strict',changePath:'openspec/changes/x',taskIDs:['1.1'],requiredChecks:['unit']}),/permission denied/);
  const state=await f.status();assert.equal(state.controlInputs,undefined);assert.equal(state.strict,undefined);assert.equal(state.phase,'RUNNING');
});

test('repeated invalid ACCEPT remains rejectable without another consultation or lost evidence',async t=>{
  const f=await fixture(t);await f.control('gal_report',{goal:'original task'});
  const hooks=f.hooks();
  for(let i=0;i<2;i++) await hooks['tool.execute.after']!({sessionID:'main',tool:'bash',callID:'fail'+i,args:{command:'npm test'}},{title:'test',output:'TypeError: broken',metadata:{exit:1}});
  const task={sessionID:'main',tool:'task',callID:'advisor'};
  await hooks['tool.execute.before']!(task,{args:{subagent_type:'gal-advisor'}});
  await hooks['tool.execute.after']!({...task,args:{subagent_type:'gal-advisor'}},{title:'advisor',metadata:{},output:'DIAGNOSIS\nstalled\nDEAD ASSUMPTION\nunknown\nEVIDENCE\ne1\nNEXT MOVE\n{"tool":"edit","args":{}}\nEXPECTED RESULT\nobserve\nDO NOT\nrepeat'});
  const initial=await f.status();const evidence=initial.evidence.map((e:{id:string})=>e.id);
  for(let i=0;i<2;i++) await assert.rejects(f.control('gal_accept',{reason:'inspect',evidence}),/Use REJECT with a valid observation/);
  await f.reload();
  const state=await f.status();assert.equal(state.phase,'CONTRACT');assert.deepEqual(state.evidence,initial.evidence);
  assert.equal(state.metrics.gal_invocations,1);assert.equal(state.metrics.triggers,initial.metrics.triggers);
  for(let i=0;i<2;i++) await assert.rejects(f.control('gal_reject',{reason:'inspect source',evidence,next_tool:'read',next_args:{}}),/NEXT filePath must be a non-empty string/);
  assert.equal((await f.status()).phase,'CONTRACT');
  await f.control('gal_reject',{reason:'inspect source',evidence,next_tool:'read',next_args:{path:'Source.java'}});
  assert.equal((await f.status()).controlInputs,undefined);
  const args={filePath:'Source.java'};await f.before('read',args);
  await f.hooks()['tool.execute.after']!({sessionID:'main',tool:'read',callID:'next',args},{title:'source',output:'new evidence',metadata:{}});
  assert.equal((await f.status()).phase,'RUNNING');assert.equal((await f.status()).metrics.gal_invocations,1);
});

test('repeated control input errors preserve strict verification and the completion gate',async t=>{
  const f=await fixture(t,{permissions:true,config:{checks:[{id:'unit',scope:'unit',kind:'test',paths:['Source.java'],command:'npm test'}]}});
  await writeFile(join(f.directory,'Source.java'),'class Source {}');
  await mkdir(join(f.directory,'openspec/changes/x'),{recursive:true});
  await writeFile(join(f.directory,'openspec/changes/x/tasks.md'),'- [x] 1.1 implement');
  const args={goal:'strict',changePath:'openspec/changes/x',taskIDs:['1.1'],requiredChecks:['unit']};
  await f.control('gal_report',args);
  await f.before('bash',{command:'npm test'});
  // Match the fixture's monotonically allocated call ID for this verification.
  const raw=JSON.parse(await f.control('gal_status',{raw:true}));
  const callID=Object.keys(raw.executions)[0];
  await f.hooks()['tool.execute.after']!({sessionID:'main',tool:'bash',callID,args:{command:'npm test'}},{title:'test',output:'Tests run: 1, Failures: 0, Errors: 0',metadata:{exit:0}});
  const complete=await f.status();assert.ok(complete.completion);
  for(let i=0;i<2;i++) await assert.rejects(f.control('gal_report',args),/existing registration is preserved/);
  const repeated=await f.status();assert.deepEqual(repeated.strict,complete.strict);assert.deepEqual(repeated.completion,complete.completion);
  await assert.rejects(f.before('edit',{filePath:'Source.java'}),/GAL COMPLETION GUARD/);
  await f.control('gal_report',{goal:'strict'});
  assert.equal((await f.status()).controlInputs,undefined);
  await assert.rejects(f.before('edit',{filePath:'Source.java'}),/GAL COMPLETION GUARD/);
});
