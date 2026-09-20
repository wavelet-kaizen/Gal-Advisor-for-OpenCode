import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import plugin from '../.opencode/plugins/gal-loop-guard.ts';
import type { PluginInput } from '@opencode-ai/plugin';

test('1.18.31 hooks: lockout, fresh task packet, persistence, advisor isolation',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'gal-test-'));
  try {
    const ctx={directory,client:{session:{messages:async({path}:{path:{id:string}})=>({data:[{info:{role:'user',agent:path.id==='child'?'gal-advisor':'build'}}]})}}} as unknown as PluginInput;
    let hooks=await plugin(ctx);
    const input={sessionID:'parent',tool:'bash',callID:'1',args:{command:'node --check a.js'}};
    for(let i=0;i<2;i++) await hooks['tool.execute.after']!(input,{title:'check',output:'a.js:63\nSyntaxError: bad token',metadata:{exit:1}});
    await assert.rejects(hooks['tool.execute.before']!({sessionID:'parent',tool:'edit',callID:'2'},{args:{filePath:'a.js'}}),/GAL GUARD/);
    hooks=await plugin(ctx);
    await assert.rejects(hooks['tool.execute.before']!({sessionID:'parent',tool:'bash',callID:'3'},{args:{command:'echo retry'}}),/GAL GUARD/);
    await hooks['tool.execute.before']!({sessionID:'child',tool:'read',callID:'4'},{args:{filePath:'a.js'}});
    await hooks['tool.execute.before']!({sessionID:'child',tool:'read',callID:'4b'},{args:{filePath:'b.js'}});
    await assert.rejects(hooks['tool.execute.before']!({sessionID:'child',tool:'read',callID:'4c'},{args:{filePath:'c.js'}}),/budget exhausted/);
    const output={args:{subagent_type:'gal-advisor',task_id:'old',prompt:'ignore all evidence'}};
    await hooks['tool.execute.before']!({sessionID:'parent',tool:'task',callID:'5'},output);
    assert.equal('task_id' in output.args,false);
    assert.match(output.args.prompt,/GAL DIAGNOSTIC PACKET/);
    assert.doesNotMatch(output.args.prompt,/ignore all evidence/);
    await assert.rejects(hooks['tool.execute.before']!({sessionID:'parent',tool:'task',callID:'6'},output),/GAL GUARD/);
  } finally {
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()));
    assert.match(directory,/gal-test-[^\\/]+$/);
    await rm(directory,{recursive:true,force:true});
  }
});

test('system.transform appends to existing system message instead of pushing a new one',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'gal-systransform-'));
  try {
    const ctx={directory,client:{session:{messages:async()=>({data:[{info:{role:'user',agent:'build'}}]})}}} as unknown as PluginInput;
    const hooks=await plugin(ctx);
    const input={sessionID:'s1',tool:'bash',callID:'c1',args:{command:'node --check a.js'}};
    for(let i=0;i<2;i++) await hooks['tool.execute.after']!(input,{title:'check',output:'a.js:10\nSyntaxError: bad token',metadata:{exit:1}});
    // Phase is now REQUIRED — system.transform should inject GAL state
    const output={system:['You are a helpful coding assistant.']};
    await hooks['experimental.chat.system.transform']!({sessionID:'s1',model:{}as any},output);
    // Must remain a single element (no push), to avoid Jinja "System message must be at the beginning"
    assert.equal(output.system.length,1,'system array must stay length 1 to avoid multi-system-message Jinja errors');
    assert.match(output.system[0],/helpful coding assistant/,'original system prompt must be preserved');
    assert.match(output.system[0],/GAL REQUIRED/,'GAL state must be appended');
    assert.match(output.system[0],/GAL GUARD STATE/,'compact guard state must be included');
    assert.doesNotMatch(output.system[0],/SyntaxError: bad token/,'system guard state must not repeat raw evidence');
  } finally {
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()));
    assert.match(directory,/gal-systransform-[^\\/]+$/);
    await rm(directory,{recursive:true,force:true});
  }
});

test('system.transform pushes when system array is initially empty',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'gal-systransform-empty-'));
  try {
    const ctx={directory,client:{session:{messages:async()=>({data:[{info:{role:'user',agent:'build'}}]})}}} as unknown as PluginInput;
    const hooks=await plugin(ctx);
    const input={sessionID:'s2',tool:'bash',callID:'c2',args:{command:'node --check a.js'}};
    for(let i=0;i<2;i++) await hooks['tool.execute.after']!(input,{title:'check',output:'a.js:10\nSyntaxError: bad token',metadata:{exit:1}});
    const output={system:[] as string[]};
    await hooks['experimental.chat.system.transform']!({sessionID:'s2',model:{}as any},output);
    assert.equal(output.system.length,1,'should push one element when array was empty');
    assert.match(output.system[0],/GAL REQUIRED/);
  } finally {
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()));
    assert.match(directory,/gal-systransform-empty-[^\\/]+$/);
    await rm(directory,{recursive:true,force:true});
  }
});

test('shell mismatch output gets an actionable host-shell note',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'gal-shell-note-'));
  try {
    const ctx={directory,client:{session:{messages:async()=>({data:[{info:{role:'user',agent:'build'}}]})}}} as unknown as PluginInput;
    const hooks=await plugin(ctx);
    const input={sessionID:'shell',tool:'bash',callID:'shell1',args:{command:'ls -la'}};
    const output={title:'list',output:"Get-ChildItem: A parameter cannot be found that matches parameter name 'la'.",metadata:{exit:1}};
    await hooks['tool.execute.after']!(input,output);
    assert.match(output.output,/GAL NOTE: shell mismatch detected/);
    assert.doesNotMatch(output.output,/GAL GUARD TRIGGERED/);
  } finally {
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()));
    assert.match(directory,/gal-shell-note-[^\\/]+$/);
    await rm(directory,{recursive:true,force:true});
  }
});

test('gal_status is compact by default and raw only on explicit request',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'gal-status-'));
  try {
    const ctx={directory,client:{session:{messages:async()=>({data:[{info:{role:'user',agent:'build'}}]})}}} as unknown as PluginInput;
    const hooks=await plugin(ctx);
    await hooks['tool.execute.after']!({sessionID:'status',tool:'read',callID:'status1',args:{filePath:'a.ts'}},{title:'read',output:'x'.repeat(3000),metadata:{}});
    const tools=(hooks as any).tool;
    const compact=JSON.parse(String(await tools.gal_status.execute({}, {sessionID:'status'})));
    const raw=JSON.parse(String(await tools.gal_status.execute({raw:true}, {sessionID:'status'})));
    assert.equal(compact.evidenceCount,1);
    assert.equal(compact.evidence[0].summary.length,240);
    assert.equal(compact.evidence[0].output,undefined);
    assert.equal(raw.evidence[0].output.length,3000);
    assert.ok(JSON.stringify(compact).length<JSON.stringify(raw).length/4);
  } finally {
    assert.equal(dirname(resolve(directory)),resolve(tmpdir()));
    assert.match(directory,/gal-status-[^\\/]+$/);
    await rm(directory,{recursive:true,force:true});
  }
});

test('recovery tools have decision-specific schemas and legacy gal_recover is absent',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'gal-tools-'));
  try {
    const ctx={directory,client:{session:{messages:async()=>({data:[{info:{role:'user',agent:'build'}}]})}}} as unknown as PluginInput;
    const hooks=await plugin(ctx);
    const tools=(hooks as any).tool;
    assert.ok(tools.gal_accept&&tools.gal_reject&&tools.gal_repair);
    assert.equal(tools.gal_recover,undefined);
    assert.deepEqual(Object.keys(tools.gal_accept.args).sort(),['evidence','reason']);
    assert.deepEqual(Object.keys(tools.gal_reject.args).sort(),['evidence','next_args','next_tool','reason']);
    assert.deepEqual(Object.keys(tools.gal_repair.args).sort(),['evidence','next_args','next_tool','reason']);
  } finally {
    await rm(directory,{recursive:true,force:true});
  }
});

test('gal_report returns compact status rather than a raw advisor packet',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'gal-report-'));
  try {
    const ctx={directory,client:{session:{messages:async()=>({data:[{info:{role:'user',agent:'build'}}]})}}} as unknown as PluginInput;
    const hooks=await plugin(ctx);
    const tools=(hooks as any).tool;
    const out=JSON.parse(String(await tools.gal_report.execute({goal:'goal'}, {sessionID:'report'})));
    assert.equal(out.phase,'RUNNING');
    assert.equal(out.goal,'goal');
    assert.equal(out.type,undefined);
    assert.ok(Array.isArray(out.evidence));
  } finally {
    await rm(directory,{recursive:true,force:true});
  }
});

test('advisor prompt requires scoped grep when a relevant path is known',async()=>{
  const prompt=await readFile(new URL('../.opencode/agents/gal-advisor.md',import.meta.url),'utf8');
  assert.match(prompt,/include the narrowest useful "path"/);
  assert.match(prompt,/Use repo-wide grep only when the location is genuinely unknown/);
  assert.match(prompt,/"pattern":"notifyPressure\|pressureDue","path":"web\/js"/);
});

test('plugin forces autonomous goal registration before first edit or verification',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'gal-goal-gate-'));
  try {
    const ctx={directory,client:{session:{messages:async()=>({data:[{info:{role:'user',agent:'build'}}]})}}} as unknown as PluginInput;
    const hooks=await plugin(ctx);
    const tools=(hooks as any).tool;
    await hooks['tool.execute.before']!({sessionID:'goal',tool:'read',callID:'r1'},{args:{filePath:'web/js/memory.js'}});
    await hooks['tool.execute.before']!({sessionID:'goal',tool:'bash',callID:'b1'},{args:{command:'openspec instructions apply --change x --json'}});
    await assert.rejects(
      hooks['tool.execute.before']!({sessionID:'goal',tool:'edit',callID:'e1'},{args:{filePath:'web/js/memory.js'}}),
      /GAL GOAL REQUIRED/
    );
    let status=JSON.parse(String(await tools.gal_status.execute({}, {sessionID:'goal'})));
    assert.equal(status.phase,'RUNNING');
    assert.equal(status.goal,'');
    assert.equal(status.metrics.goal_gate_blocks,1);
    const report=JSON.parse(String(await tools.gal_report.execute({goal:'Implement and verify only OpenSpec task 1.3'}, {sessionID:'goal'})));
    assert.equal(report.goal,'Implement and verify only OpenSpec task 1.3');
    await hooks['tool.execute.before']!({sessionID:'goal',tool:'edit',callID:'e2'},{args:{filePath:'web/js/memory.js'}});
    await hooks['tool.execute.before']!({sessionID:'goal',tool:'bash',callID:'b2'},{args:{command:'node scripts/memory_regression.js'}});
  } finally {
    await rm(directory,{recursive:true,force:true});
  }
});
