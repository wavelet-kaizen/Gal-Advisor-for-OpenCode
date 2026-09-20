import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Guard } from '../.opencode/gal/guard.ts';

const cmd={command:'node --check tests/image-translation.test.cjs'};
const failure="tests/image-translation.test.cjs:63\nSyntaxError: Unexpected token ']'";
const advice='DIAGNOSIS\n今回の編集を確認。\nDEAD ASSUMPTION\nHEAD was broken\nEVIDENCE\ne1, e2\nNEXT MOVE\n{"tool":"bash","args":{"command":"git diff HEAD -- tests/image-translation.test.cjs"}}\nEXPECTED RESULT\n差分から原因を絞る\nDO NOT\n括弧を頭で数えない';
const next={tool:'bash',args:{command:'git diff HEAD -- tests/image-translation.test.cjs'}};
function stuck(){const g=new Guard();g.observe('bash',cmd,failure,1);g.observe('bash',cmd,failure,1);return g;}
test('Qwen reconstruction: baseline evidence refutes hypothesis; reuse stops tools',()=>{
  const g=new Guard();g.observe('bash',cmd,failure,1);
  g.observe('bash',{command:'node --check baseline.cjs'},'HEAD copy PASS',0);
  g.report({hypothesis:'HEAD was broken',status:'REFUTED',evidence:['e2']});
  g.report({hypothesis:'HEAD was broken',status:'UNTESTED'});
  assert.equal(g.s.reason,'contradicted_hypothesis_reuse');
  assert.throws(()=>g.before('edit',{}));assert.throws(()=>g.before('bash',cmd));
  assert.throws(()=>g.before('task',{subagent_type:'general'}));
  assert.match(g.packet(),/HEAD copy PASS/);
});
test('TDD 8 -> 3 -> 1 failures is progress',()=>{
  const g=new Guard();for(const n of [8,3,1]) {g.observe('edit',{filePath:'a.ts'},'ok');g.observe('bash',{command:'node --test'},`# fail ${n}`,1);}
  assert.equal(g.s.phase,'RUNNING');assert.equal(g.s.metrics.progress,2);
});
test('same failed tool twice triggers; changed error class resets',()=>{
  assert.equal(stuck().s.phase,'REQUIRED');
  const g=new Guard();g.observe('bash',cmd,failure,1);g.observe('bash',cmd,'AssertionError: wrong value',1);
  assert.equal(g.s.phase,'RUNNING');
});
test('unchanged search three times triggers, different results do not',()=>{
  const g=new Guard();for(let i=0;i<3;i++)g.observe('grep',{pattern:'modal'},'no matches');
  assert.equal(g.s.phase,'REQUIRED');
  const h=new Guard();for(let i=0;i<3;i++)h.observe('grep',{pattern:'modal'},'result '+i);
  assert.equal(h.s.phase,'RUNNING');
});
test('ACCEPT requires evidence; only contracted operation is allowed once',()=>{
  const g=stuck();g.consult();g.advised(advice);
  assert.throws(()=>g.contract('ACCEPT','ok',[],next));
  g.contract('ACCEPT','HEAD passes',['e1'],next);
  // NEXT phase: wrong tool gives actionable error with contracted move details
  try{g.before('gal_recover',{decision:'ACCEPT'});assert.fail('should throw');}catch(e:any){
    assert.match(e.message,/Execute the contracted observation/);
    assert.match(e.message,new RegExp(next.tool));
  }
  // Correct contracted tool is allowed once
  g.before(next.tool,next.args);assert.throws(()=>g.before(next.tool,next.args));
  g.observe(next.tool,next.args,'changed closing bracket',0);
  assert.equal(g.s.phase,'RUNNING');
});
test('no new evidence means exhausted; budget survives JSON reload',()=>{
  const g=stuck();g.consult();g.advised(advice);g.contract('ACCEPT','inspect',['e1'],next);
  g.before(next.tool,next.args);g.observe(next.tool,next.args,'new diff',0);g.trigger('again');
  g.consult();g.advised(advice);
  const reloaded=new Guard(JSON.parse(JSON.stringify(g.s)));
  reloaded.s.phase='REQUIRED';assert.throws(()=>reloaded.consult());assert.equal(reloaded.s.phase,'EXHAUSTED');
  assert.equal(reloaded.s.metrics.gal_invocations,2);
  const h=stuck();h.consult();h.s.phase='REQUIRED';assert.throws(()=>h.consult());assert.equal(h.s.phase,'EXHAUSTED');
});
test('soft signals need distinct categories within eight calls',()=>{
  const g=new Guard();g.report({signal:'speculation'});g.report({signal:'speculation'});assert.equal(g.s.phase,'RUNNING');
  for(let i=0;i<8;i++)g.observe('read',{filePath:String(i)},'data');
  g.report({signal:'scope_drift'});assert.equal(g.s.phase,'RUNNING');
  g.report({signal:'semantic_loop'});assert.equal(g.s.phase,'REQUIRED');
});
test('invalid Advisor and arbitrary recovery shell fail closed',()=>{
  const g=stuck();g.consult();g.advised('please retry');assert.equal(g.s.phase,'EXHAUSTED');
  const h=stuck();h.consult();h.advised(advice);
  assert.throws(()=>h.contract('REJECT','different evidence',['e1'],{tool:'bash',args:{command:'git diff; rm file'}}));
});
test('error text in read or successful git diff is not a verification failure',()=>{
  const g=new Guard();
  for(let i=0;i<3;i++){g.observe('read',{filePath:'a.js'},failure);g.observe('bash',{command:'git diff'},failure,0);}
  assert.equal(g.s.phase,'RUNNING');assert.equal(g.s.problem,'');
});
test('command-only changes do not manufacture new observation evidence',()=>{
  const g=new Guard();g.observe('bash',{command:'check a'},'same error',1);
  g.observe('bash',{command:'check a --verbose'},'same error',1);
  assert.equal(g.s.evidence.length,1);
});
test('ACCEPT uses recommended move regardless of supplied move; first failure after edits is allowed',()=>{
  const g=stuck();g.consult();g.advised(advice);
  // ACCEPT with an arbitrary move still succeeds — it uses recommended automatically
  g.contract('ACCEPT','inspect',['e1'],{tool:'read',args:{filePath:'other'}});
  assert.deepEqual(g.s.move,next,'ACCEPT must use recommended, not the supplied move');
  assert.equal(g.s.phase,'NEXT');
  const h=new Guard();for(let i=0;i<3;i++)h.observe('edit',{filePath:'a.js'},'ok');
  h.observe('bash',cmd,failure,1);assert.equal(h.s.phase,'RUNNING');
});
test('ACCEPT with empty move placeholder uses recommended',()=>{
  const g=stuck();g.consult();g.advised(advice);
  g.contract('ACCEPT','evidence supports advisor',['e1'],{tool:'',args:{}});
  assert.deepEqual(g.s.move,next);
  assert.equal(g.s.phase,'NEXT');
});
test('REJECT requires a different move from recommended',()=>{
  const g=stuck();g.consult();g.advised(advice);
  assert.throws(()=>g.contract('REJECT','disagree',['e1'],next),/REJECT requires a different observation/);
  g.contract('REJECT','different approach',['e1'],{tool:'grep',args:{pattern:'choices',path:'tests'}});
  assert.equal(g.s.phase,'NEXT');
});
test('malformed REJECT args are rejected before NEXT so recovery cannot self-lock',()=> {
  const g=stuck();g.consult();g.advised(advice);
  assert.throws(()=>g.contract('REJECT','inspect source',['e1'],{tool:'read',args:{filePath:{type:'string',value:'a.ts'}} as any}),/filePath must be a non-empty string/);
  assert.equal(g.s.phase,'CONTRACT');
  assert.equal(g.s.move,undefined);
});
test('contracted read accepts safe optional args while preserving contracted values',()=> {
  const g=stuck();g.consult();g.advised(advice);
  const readMove={tool:'read',args:{filePath:'a.ts'}};
  g.contract('REJECT','inspect source',['e1'],readMove);
  g.before('read',{filePath:'a.ts',limit:300});
  g.observe('read',{filePath:'a.ts',limit:300},'source');
  assert.equal(g.s.phase,'RUNNING');
});
test('invalid Advisor bash recommendation stays recoverable via REJECT',()=> {
  const invalid=advice.replace('git diff HEAD -- tests/image-translation.test.cjs','python scripts\\\\android_notification_regression.py 2>&1');
  const g=stuck();g.consult();g.advised(invalid);
  assert.equal(g.s.phase,'CONTRACT');
  assert.equal(g.s.recommended,undefined);
  assert.match(g.s.advisorMoveError??'',/Recovery bash permits only simple git inspection/);
  assert.throws(()=>g.contract('ACCEPT','run advisor move',['e1'],{tool:'',args:{}}),/Use REJECT with a valid observation/);
  g.contract('REJECT','inspect the script instead',['e1'],{tool:'read',args:{filePath:'scripts/android_notification_regression.py'}});
  assert.equal(g.s.phase,'NEXT');
});
test('different generic CLI usage errors do not collapse into one failure class',()=> {
  const g=new Guard();
  g.observe('bash',{command:'openspec status --json'},"error: unknown option '--foo'",1);
  g.observe('edit',{filePath:'a.ts'},'ok');
  g.observe('bash',{command:'openspec validate --change x'},"error: unknown option '--change'",1);
  g.observe('edit',{filePath:'a.ts'},'ok');
  g.observe('bash',{command:'openspec archive --bad'},"error: unknown option '--bad'",1);
  assert.equal(g.s.phase,'RUNNING');
  assert.equal(g.s.failures,0);
});
test('unrelated edits do not count as fixes for a located verification failure',()=> {
  const g=new Guard();const f='src/a.ts:10\nTypeError: same bug';
  g.observe('bash',{command:'node test one'},f,1);
  g.observe('edit',{filePath:'src/b.ts'},'ok');
  g.observe('bash',{command:'node test two'},f,1);
  g.observe('edit',{filePath:'src/b.ts'},'ok');
  g.observe('bash',{command:'node test three'},f,1);
  assert.equal(g.s.phase,'RUNNING');
  assert.equal(g.s.failures,0);
  assert.equal(g.s.metrics.unrelated_edits,2);
});
test('two relevant fixes with the same verification failure trigger',()=> {
  const g=new Guard();const f='src/a.ts:10\nTypeError: same bug';
  g.observe('bash',{command:'node test one'},f,1);
  g.observe('edit',{filePath:'src/a.ts'},'ok');
  g.observe('bash',{command:'node test two'},f,1);
  g.observe('edit',{filePath:'src/a.ts'},'ok');
  g.observe('bash',{command:'node test three'},f,1);
  assert.equal(g.s.phase,'REQUIRED');
  assert.equal(g.s.reason,'same_failure_after_two_fixes');
});
test('three relevant edits before re-verification trigger without relying on global edit count',()=> {
  const g=new Guard();const f='src/a.ts:10\nTypeError: same bug';
  g.observe('bash',{command:'node test one'},f,1);
  for(let i=0;i<3;i++) g.observe('edit',{filePath:'src/a.ts'},'ok');
  g.observe('bash',{command:'node test two'},f,1);
  assert.equal(g.s.phase,'REQUIRED');
  assert.equal(g.s.reason,'three_relevant_edits_without_progress');
});
test('a distinct problem gets a fresh episode, evidence packet and consultation budget',()=> {
  const g=stuck();const first=g.s.problem;
  g.consult();g.advised(advice);g.contract('ACCEPT','inspect',['e1'],next);g.before(next.tool,next.args);g.observe(next.tool,next.args,'new diff',0);
  const other={command:'node --check other.cjs'};const otherFailure="other.cjs:10\nTypeError: second bug";
  g.observe('bash',other,otherFailure,1);g.observe('bash',other,otherFailure,1);
  assert.equal(g.s.phase,'REQUIRED');assert.notEqual(g.s.problem,first);
  assert.doesNotMatch(g.packet(),/Unexpected token/);
  assert.match(g.packet(),/second bug/);
  g.consult();assert.equal(g.s.phase,'CONSULTING');
});
test('NEXT mismatch reports the delta and cancels the bad contract instead of deadlocking',()=> {
  const g=stuck();g.consult();g.advised(advice);
  g.contract('REJECT','read source',['e1'],{tool:'read',args:{filePath:'a.ts'}});
  assert.throws(()=>g.before('read',{filePath:'b.ts'}),/filePath expected .*a\.ts.*received .*b\.ts/);
  assert.equal(g.s.phase,'CONTRACT');assert.equal(g.s.move,undefined);
  g.contract('REJECT','read another source',['e1'],{tool:'read',args:{filePath:'c.ts'}});
  assert.equal(g.s.phase,'NEXT');
});
test('NEXT is consumed only after its result is observed',()=> {
  const g=stuck();g.consult();g.advised(advice);
  g.contract('REJECT','read source',['e1'],{tool:'read',args:{filePath:'a.ts'}});
  g.before('read',{filePath:'a.ts'});
  assert.equal(g.s.phase,'NEXT_EXECUTING');assert.ok(g.s.move);
  g.observe('read',{filePath:'a.ts'},'permission denied',1);
  assert.equal(g.s.phase,'RUNNING');assert.equal(g.s.move,undefined);assert.equal(g.s.executing,undefined);
});
test('REPAIR escapes a NEXT execution whose completion event was lost',()=> {
  const g=stuck();g.consult();g.advised(advice);
  g.contract('REJECT','read source',['e1'],{tool:'read',args:{filePath:'a.ts'}});
  g.before('read',{filePath:'a.ts'});
  g.repair('tool returned without completion hook',['e1'],{tool:'read',args:{filePath:'b.ts'}});
  assert.equal(g.s.phase,'NEXT');assert.deepEqual(g.s.move,{tool:'read',args:{filePath:'b.ts'}});
});
test('persisted malformed or in-flight NEXT state is repaired on reload',()=> {
  const malformed=stuck();malformed.s.phase='NEXT';malformed.s.move={tool:'read',args:{filePath:{type:'string',value:'a.ts'}} as any};
  const repaired=new Guard(JSON.parse(JSON.stringify(malformed.s)));
  assert.equal(repaired.s.phase,'CONTRACT');assert.equal(repaired.s.move,undefined);assert.equal(repaired.s.metrics.state_repairs,1);
  const inflight=stuck();inflight.s.phase='NEXT_EXECUTING';inflight.s.move={tool:'read',args:{filePath:'a.ts'}};inflight.s.executing={tool:'read',args:{filePath:'a.ts'}};
  const resumed=new Guard(JSON.parse(JSON.stringify(inflight.s)));
  assert.equal(resumed.s.phase,'NEXT');assert.equal(resumed.s.executing,undefined);
});
test('PowerShell and CLI usage failures are classified and steer away from source edits',()=> {
  const g=new Guard();
  const shell=g.observe('bash',{command:'ls -la'},"Get-ChildItem: A parameter cannot be found that matches parameter name 'la'.",1);
  assert.match(shell??'',/shell mismatch/);assert.equal(g.s.failureKind,'shell_mismatch');
  g.observe('edit',{filePath:'src/a.ts'},'ok');assert.equal(g.s.edits,0);
  const cli=g.observe('bash',{command:'openspec validate --change x'},"error: unknown option '--change' (Did you mean --changes?)",1);
  assert.match(cli??'',/CLI usage error/);assert.equal(g.s.failureKind,'cli_usage');
});
test('previous read with safe optional args is still the same stalled operation',()=> {
  const g=new Guard();g.observe('read',{filePath:'a.ts',limit:300},'data');g.trigger('manual');g.consult();g.advised(advice);
  assert.throws(()=>g.contract('REJECT','same read',['e1'],{tool:'read',args:{filePath:'a.ts'}}),/previous stalled operation/);
});
test('test failure counts stay in one problem episode while progress is recorded',()=> {
  const g=new Guard();const args={command:'node --test'};
  g.observe('bash',args,'# fail 8',1);const problem=g.s.problem;
  g.observe('edit',{filePath:'src/a.ts'},'ok');
  g.observe('bash',args,'# fail 3',1);
  assert.equal(g.s.problem,problem);assert.equal(g.s.metrics.progress,1);
  g.observe('bash',args,'# fail 1',1);
  assert.equal(g.s.problem,problem);assert.equal(g.s.metrics.progress,2);
});
test('late goal registration does not re-key an active problem or reset its consultation budget',()=> {
  const g=stuck();const problem=g.s.problem;
  g.report({goal:'fix current failure'});
  assert.equal(g.s.problem,problem);
  g.consult();assert.equal(g.s.calls[problem].count,1);
});
test('simple recovery git inspection accepts Windows path separators',()=> {
  const g=stuck();g.consult();g.advised(advice);
  g.contract('REJECT','inspect windows path',['e1'],{tool:'bash',args:{command:'git diff HEAD -- tests\\image-translation.test.cjs'}});
  assert.equal(g.s.phase,'NEXT');
});
