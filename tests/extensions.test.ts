import { test,type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,mkdir,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,dirname,resolve } from 'node:path';
import { Guard,type Phase } from '../.opencode/gal/guard.ts';
import { verify,junit,diagnostic,simpleVerification } from '../.opencode/gal/verification.ts';
import { configSchema } from '../.opencode/gal/config.ts';
import { inspectText } from '../.opencode/gal/inspect.ts';
import { ProjectRuntime } from '../.opencode/gal/runtime.ts';
import { GenerationMonitor } from '../.opencode/gal/generation.ts';
import { createGuardHooks } from '../.opencode/gal/plugin.ts';
import type { ToolContext } from '@opencode-ai/plugin';
import type { Plugin } from '@opencode/plugin';
import entrypoint from '../.opencode/plugins/gal-loop-guard.ts';
const summary=(f:number)=>`Tests run: 7, Failures: ${f}, Errors: 0, Skipped: 0`;
const fresh=()=>{const g=new Guard();g.report({goal:'Implement reviewed extensions'});return g;};
async function project(t:TestContext) {
  const root=await mkdtemp(join(tmpdir(),'gal-extensions-'));
  t.after(async()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.match(root,/gal-extensions-[^\\/]+$/);await rm(root,{recursive:true,force:true});});
  await mkdir(join(root,'src'));await mkdir(join(root,'.opencode'));
  await mkdir(join(root,'openspec','changes','x'),{recursive:true});
  await writeFile(join(root,'src','Foo.java'),'class Foo {}');
  await writeFile(join(root,'openspec','changes','x','tasks.md'),'- [ ] 1.1 implement\n- [x] 1.2 other');
  return root;
}
const config=(extras={})=>configSchema.parse({checks:[{id:'unit',scope:'all-unit',kind:'test',paths:['src/Foo.java'],command:'java RunSingleTest'}],...extras});
const register=(g:Guard)=>g.report({changePath:'openspec/changes/x',taskIDs:['1.1'],requiredChecks:['unit']});

test('JUnit failures, conflicting exit codes, zero runs and incomplete XML cannot pass',()=>{
  assert.equal(verify(summary(2),0,'test').verdict,'FAIL');
  const conflict=fresh();conflict.observe('bash',{command:'mvn test'},summary(2),0);assert.equal(conflict.s.failedCount,2);assert.equal(conflict.s.metrics.verification_passes??0,0);
  assert.equal(verify(summary(0),1,'test').verdict,'FAIL');
  assert.equal(verify('BUILD SUCCESSFUL',undefined,'command').verdict,'UNKNOWN');
  assert.equal(verify('Tests run: 0, Failures: 0, Errors: 0',0,'test').verdict,'UNKNOWN');
  assert.equal(verify(summary(0),0,'test',false).verdict,'UNKNOWN');
  const xml='<testsuites tests="999"><testsuite name="a" tests="2" failures="0" errors="1"/><testsuite name="b" tests="3" failures="0" errors="0"/></testsuites>';
  assert.deepEqual(junit(xml),{testsRun:5,failures:0,errors:1,skipped:0});
  assert.equal(junit('<testsuite name="a" tests="1" failures="0" errors="0">'),undefined);
  assert.equal(junit(xml+xml),undefined);
  assert.equal(junit('<!DOCTYPE x>'+xml),undefined);
});

test('Java/JSP locations are extracted without inventing servlet-to-JSP mappings',()=>{
  assert.equal(diagnostic('src/Foo.java:42: error: cannot find symbol')?.path,'src/Foo.java');
  assert.equal(diagnostic('Unable to compile /view/index.jsp at line: [14]')?.line,14);
  assert.equal(diagnostic('java.lang.AssertionError: bad\n at a.Foo.run(Foo.java:12)')?.path,'Foo.java');
  const g=fresh();g.observe('bash',{command:'javac src/Foo.java'},'src/Foo.java:42: error: missing',1);
  assert.equal(g.s.failureFile,'src/Foo.java');assert.equal(g.s.failureKind,'verification');
  const uncertain=fresh();uncertain.observe('bash',{command:'javac Foo.java'},'Foo.java:42: error: missing',1);
  assert.equal(uncertain.s.failureFile,'');
});

test('JUnit improvements stay in one episode; javac and Ant are recognized conservatively',()=>{
  const g=fresh();for(const failures of [4,2,1]) g.observe('bash',{command:'ant test'},summary(failures),1);
  assert.equal(g.s.phase,'RUNNING');assert.equal(g.s.failedCount,1);assert.equal(g.s.metrics.progress,2);
  assert.equal(simpleVerification('java arbitrary.Main'),undefined);
  assert.equal(simpleVerification('ant test; echo done'),undefined);
  const compile=fresh();compile.observe('bash',{command:'javac src/Foo.java'},'',0);
  assert.equal(compile.s.metrics.verification_passes,1);
});

test('config rejects unsafe capability claims, duplicate IDs, unknown keys and ambiguous runners',()=>{
  assert.throws(()=>configSchema.parse({generation:{mode:'interrupt'}}),/cancellation capability/);
  assert.throws(()=>configSchema.parse({unexpected:true}));
  assert.throws(()=>configSchema.parse({checks:[...config().checks,...config().checks]}),/Duplicate/);
  assert.throws(()=>configSchema.parse({checks:[{id:'a',scope:'a',kind:'test',paths:['a'],command:'test',tool:'other'}]}));
});

test('strict text inspection preserves bytes/codepoints, bounds output and honors denied read permissions',async t=>{
  const root=await project(t);const path=join(root,'text.txt');await writeFile(path,'A\u3060\r\nB\u3061');
  const authorized:string[]=[];const allow=async(_id:string,path:string)=>{authorized.push(path);};
  const result=await inspectText(root,{path:'text.txt'},'s',allow);
  assert.equal(result.decode,'VALID');assert.equal(result.lines?.[0].codepoints[1],'U+3060');assert.equal(result.newline?.crlf,1);
  assert.equal(authorized[0],path);
  await assert.rejects(inspectText(root,{path:'text.txt'},'s',async()=>{throw Error('denied');}),/denied/);
  await assert.rejects(inspectText(root,{path:'text.txt',encoding:'windows-31j'},'s',allow),/supported encoding/);
  await writeFile(path,Buffer.from([0xc3,0x28]));assert.equal((await inspectText(root,{path:'text.txt'},'s',allow)).decode,'INVALID');
  await writeFile(path,'x'.repeat(3000));assert.equal((await inspectText(root,{path:'text.txt'},'s',allow)).lines?.[0].text.length,2000);
  await writeFile(path,Buffer.alloc(1024*1024+1));await assert.rejects(inspectText(root,{path:'text.txt'},'s',allow),/1 MiB/);
});

test('numeric/codepoint changes are new evidence; unrelated edits do not erase a stale window',()=>{
  const g=fresh();for(const text of ['U+3060','U+3061','0x3062','0x3063','Tests run:4','Tests run:3']) g.observe('read',{filePath:'src/a.java'},text);
  assert.equal(g.s.phase,'RUNNING');assert.equal(g.s.metrics.investigation_stale_observations??0,0);
  const stalled=fresh();for(let i=0;i<3;i++) stalled.observe('read',{filePath:'src/a.java'},'same');
  stalled.observe('edit',{filePath:'tmp/helper.py'},'ok');stalled.observe('read',{filePath:'src/a.java'},'same');
  assert.equal(stalled.s.phase,'REQUIRED');
});

test('registered verification binds current source, exact task, and required checks',async t=>{
  const root=await project(t);const runtime=new ProjectRuntime(root,config(),async()=>{});const g=fresh();register(g);
  await runtime.before(g,'s','bash',{command:'java RunSingleTest'},'c1');
  await runtime.after(g,'s','bash',{command:'java RunSingleTest'},'c1',summary(0),0,undefined);
  await runtime.refresh(g,'s');assert.equal(g.s.completion,undefined,'other checked task is insufficient');
  await writeFile(join(root,'openspec/changes/x/tasks.md'),'- [x] 1.1 implement');
  await runtime.refresh(g,'s');assert.ok(g.s.completion);
  await writeFile(join(root,'src/Foo.java'),'class Foo {int changed;}');
  await runtime.refresh(g,'s');assert.equal(g.s.completion,undefined);assert.equal(g.s.strict?.checks.unit.verdict,'UNKNOWN');
});

test('source changes during execution and missing results never manufacture PASS',async t=>{
  const root=await project(t);const runtime=new ProjectRuntime(root,config(),async()=>{});const g=fresh();register(g);
  await runtime.before(g,'s','bash',{command:'java RunSingleTest'},'c1');
  await writeFile(join(root,'src/Foo.java'),'changed');
  await runtime.after(g,'s','bash',{command:'java RunSingleTest'},'c1',summary(0),0,undefined);
  assert.equal(g.s.strict?.checks.unit.verdict,'UNKNOWN');
  const unrelated=await runtime.after(g,'s','execute',{},'unknown','PASS',0,{state:'completed',exit:0});
  assert.equal(unrelated.handled,false);
});

test('Eclipse adapter associates asynchronous completion and deduplicates persisted aliases',async t=>{
  const root=await project(t);const cfg=config({checks:[{id:'unit',scope:'unit',kind:'test',paths:['src/Foo.java'],tool:'runner_launch',match:{name:'unit'},resultTool:'runner_result',executionIDPath:'id'}]});
  const runtime=new ProjectRuntime(root,cfg,async()=>{});let g=fresh();register(g);
  await runtime.before(g,'s','runner_launch',{name:'unit'},'launch');
  await runtime.after(g,'s','runner_launch',{name:'unit'},'launch','',0,{state:'running',id:'run1'});
  assert.equal(g.s.strict?.checks.unit,undefined);
  g=new Guard(JSON.parse(JSON.stringify(g.s)));
  await runtime.after(g,'s','runner_result',{executionID:'run1'},'result','',0,{state:'completed',exit:0,output:summary(0)});
  const count=g.s.metrics.tool_calls;
  await runtime.after(g,'s','runner_launch',{name:'unit'},'launch','',0,{state:'completed',exit:0,output:summary(0)});
  assert.equal(g.s.metrics.tool_calls,count);assert.equal(g.s.strict?.checks.unit.verdict,'PASS');
});

test('text observation participates in the NEXT contract exactly once',async t=>{
  const root=await project(t);const hooks=await createGuardHooks(root,async()=>false,true,async()=>{});
  const context={sessionID:'s'} as ToolContext;
  await hooks.tool!.gal_report.execute({goal:'inspect'},context);
  for(const id of ['a','b']) await hooks['tool.execute.after']!({sessionID:'s',tool:'bash',callID:id,args:{command:'npm test'}},{title:'test',output:'TypeError: bad',metadata:{exit:1}});
  const task={args:{subagent_type:'gal-advisor',prompt:''}};
  await hooks['tool.execute.before']!({sessionID:'s',tool:'task',callID:'task'},task);
  const advice='DIAGNOSIS\nx\nDEAD ASSUMPTION\nx\nEVIDENCE\nx\nNEXT MOVE\n'+JSON.stringify({tool:'gal_inspect_text',args:{path:'src/Foo.java'}})+'\nEXPECTED RESULT\nx\nDO NOT\nx';
  await hooks['tool.execute.after']!({sessionID:'s',tool:'task',callID:'task',args:task.args},{title:'advisor',output:advice,metadata:{}});
  const status=JSON.parse(String(await hooks.tool!.gal_status.execute({},context)));
  await hooks.tool!.gal_accept.execute({reason:'inspect bytes',evidence:status.evidence.map((e:{id:string})=>e.id)},context);
  const args={path:'src/Foo.java'};
  await hooks['tool.execute.before']!({sessionID:'s',tool:'gal_inspect_text',callID:'inspect'},{args});
  const result=String(await hooks.tool!.gal_inspect_text.execute(args,context));
  const out={title:'inspect',output:result,metadata:{}};
  await hooks['tool.execute.after']!({sessionID:'s',tool:'gal_inspect_text',callID:'inspect',args},out);
  assert.match(out.output,/GAL RECOVERY COMPLETE/);
});

test('generation hold preserves all phases and two-consultation NEXT across reload',()=>{
  for(const phase of ['RUNNING','REQUIRED','CONSULTING','CONTRACT','NEXT','NEXT_EXECUTING','EXHAUSTED'] as Phase[]) {
    let g=fresh();g.s.phase=phase;g.s.move={tool:'read',args:{filePath:'a.java'}};g.s.calls.problem={count:2,evidence:'same'};
    if(phase==='NEXT_EXECUTING') g.s.executing=g.s.move;
    g.holdGeneration('request','incident');g=new Guard(JSON.parse(JSON.stringify(g.s)));
    assert.equal(g.s.phase,phase);assert.throws(()=>g.before('read',{filePath:'a.java'}),/GENERATION HOLD/);
    assert.throws(()=>g.resumeGeneration('request',true),/confirmation/);
    g.confirmGeneration('request',true);g.resumeGeneration('request',true);
    assert.equal(g.s.phase,phase==='RUNNING'?'REQUIRED':phase);assert.equal(g.s.calls.problem.count,2);
    assert.deepEqual(g.s.move,{tool:'read',args:{filePath:'a.java'}});
    if(phase==='NEXT') assert.doesNotThrow(()=>g.before('read',{filePath:'a.java'}));
  }
});

test('results observed while held are not rolled back; old confirmations cannot release a new hold',()=>{
  const g=fresh();g.s.phase='NEXT';g.s.move={tool:'read',args:{filePath:'a.java'}};g.before('read',g.s.move.args);
  g.holdGeneration('r1','i1');g.observe('read',{filePath:'a.java'},'source');
  assert.equal(g.s.phase,'RUNNING');g.confirmGeneration('old',true);assert.equal(g.s.generationHold?.status,'pending');
  g.confirmGeneration('r1',true);g.resumeGeneration('r1',true);assert.equal(g.s.phase,'RUNNING');
});

test('generation monitor excludes auxiliary work, keeps retry budget, and emits only once per threshold',()=>{
  let now=0;const notices:string[]=[];
  const monitor=new GenerationMonitor(configSchema.parse({generation:{mode:'notify',warnAfterSeconds:3,maxSeconds:6,advisorMaxSeconds:4}}).generation,(_id,text)=>notices.push(text),()=>now);
  monitor.start('s','r','title');now=10000;monitor.poll();assert.equal(notices.length,0);
  monitor.start('s','r1','primary');now=14000;monitor.poll();monitor.start('s','retry','primary');
  now=17000;monitor.poll();monitor.poll();assert.equal(notices.length,2);
  monitor.end('s','old');monitor.poll();assert.equal(notices.length,2);
  monitor.end('s');monitor.start('child','c','primary',true);now+=4500;monitor.poll();assert.equal(notices.length,3);
});

test('V2 notify adapter uses public request metadata, emits a non-resuming notice and cleans up',async t=>{
  const root=await project(t);
  await writeFile(join(root,'.opencode/gal.json'),JSON.stringify({generation:{mode:'notify',warnAfterSeconds:0.001,maxSeconds:0.003,advisorMaxSeconds:0.003}}));
  const callbacks=new Map<string,(event:Record<string,unknown>)=>void>();
  let notice!:(value:{text:string;resume:boolean})=>void;
  const notification=new Promise<{text:string;resume:boolean}>(resolve=>{notice=resolve;});
  const ctx={location:{directory:root},tool:{transform:async()=>({dispose:async()=>{}}),hook:async()=>({dispose:async()=>{}})},session:{
    get:async()=>({agent:'build'}),hook:async(name:string,callback:(event:Record<string,unknown>)=>void)=>{callbacks.set(name,callback);return {dispose:async()=>{}};},
    synthetic:async(input:{text:string;resume:boolean})=>{notice(input);},
  },event:{subscribe:async function*({signal}:{signal:AbortSignal}){await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));}}} as unknown as Plugin.Context;
  const cleanup=await entrypoint.setup(ctx);
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try {
    callbacks.get('model.request')!({sessionID:'s',agent:'build',kind:'primary'});
    const message=await Promise.race([notification,new Promise<never>((_resolve,reject)=>{timeout=setTimeout(()=>reject(Error('Notification timeout')),3000);})]);
    assert.equal(message.resume,false);assert.match(message.text,/generation_budget_exceeded/);
  } finally {if(timeout) clearTimeout(timeout);await cleanup?.();}
});
