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
