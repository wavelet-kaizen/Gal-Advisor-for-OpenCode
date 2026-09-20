import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
    assert.match(output.system[0],/GAL DIAGNOSTIC PACKET/,'diagnostic packet must be included');
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
