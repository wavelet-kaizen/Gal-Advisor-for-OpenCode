import { createHash } from 'node:crypto';

export const hash = (v: unknown): string => createHash('sha256').update(stable(v)).digest('hex');
export function stable(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k,x]) => JSON.stringify(k)+':'+stable(x)).join(',') + '}';
  return JSON.stringify(v) ?? 'null';
}

export type Move = { tool: string; args: Record<string, unknown> };
export type FailureKind = 'verification'|'cli_usage'|'shell_mismatch'|'tooling';
export type Phase = 'RUNNING'|'REQUIRED'|'CONSULTING'|'CONTRACT'|'NEXT'|'NEXT_EXECUTING'|'EXHAUSTED';
type Evidence = { id: string; tick?: number; tool: string; args: Record<string, unknown>; output: string; signature: string; kind?: FailureKind };
const STATE_SCHEMA_VERSION=2;

const RECOVERY_TOOLS=new Set(['read','glob','grep','bash']);
const simpleGit=/^git (?:diff|status|show|log)(?: [a-zA-Z0-9_./\\:@{},+ -]+)?$/;
const dangerousGit=/--(?:output|ext-diff|textconv|config)/;

function requireString(args:Record<string,unknown>,key:string) {
  const value=args[key];
  if(typeof value!=='string'||!value.trim()) throw Error('NEXT '+key+' must be a non-empty string');
}
function optionalString(args:Record<string,unknown>,key:string) {
  const value=args[key];
  if(value!==undefined&&typeof value!=='string') throw Error('NEXT '+key+' must be a string when provided');
}
function optionalNumber(args:Record<string,unknown>,key:string) {
  const value=args[key];
  if(value!==undefined&&(typeof value!=='number'||!Number.isFinite(value)||value<0)) throw Error('NEXT '+key+' must be a non-negative number when provided');
}
export function validateMove(move:Move) {
  if(!move||typeof move.tool!=='string'||!move.args||Array.isArray(move.args)||typeof move.args!=='object') throw Error('NEXT must contain one tool and args object');
  if(!RECOVERY_TOOLS.has(move.tool)) throw Error('NEXT must be one observation tool');
  if(move.tool==='read') {requireString(move.args,'filePath');optionalNumber(move.args,'offset');optionalNumber(move.args,'limit');}
  if(move.tool==='glob') {requireString(move.args,'pattern');optionalString(move.args,'path');}
  if(move.tool==='grep') {requireString(move.args,'pattern');optionalString(move.args,'path');optionalString(move.args,'include');}
  if(move.tool==='bash') {
    requireString(move.args,'command');optionalNumber(move.args,'timeout');optionalString(move.args,'description');
    const command=String(move.args.command);
    if(!simpleGit.test(command)||dangerousGit.test(command)) throw Error('Recovery bash permits only simple git inspection; use read/grep otherwise');
  }
  return move;
}
function matchesMove(expected:Move,tool:string,args:Record<string,unknown>) {
  if(tool!==expected.tool) return false;
  try {validateMove({tool,args});} catch {return false;}
  return Object.entries(expected.args).every(([key,value])=>stable(args[key])===stable(value));
}
function mismatchDetails(expected:Move,tool:string,args:Record<string,unknown>) {
  const details:string[]=[];
  if(tool!==expected.tool) details.push('tool expected '+expected.tool+' but received '+tool);
  try {validateMove({tool,args});} catch(e) {details.push('received args invalid: '+(e instanceof Error?e.message:String(e)));}
  if(tool===expected.tool) for(const [key,value] of Object.entries(expected.args)) {
    if(stable(args[key])!==stable(value)) details.push(key+' expected '+stable(value)+' but received '+stable(args[key]));
  }
  return details.join('; ')||'received call does not satisfy the contracted values';
}
function evidenceTick(e:Evidence) {
  if(typeof e.tick==='number') return e.tick;
  const n=Number(e.id.replace(/^e/,''));
  return Number.isFinite(n)?n:0;
}
function normPath(p:string) {
  return p.replace(/\\/g,'/').replace(/^\.\//,'').replace(/\/+/g,'/').replace(/\/$/,'');
}
function sameFile(a:string,b:string) {
  let x=normPath(a),y=normPath(b);
  if(/^[A-Za-z]:\//.test(x)||/^[A-Za-z]:\//.test(y)) {x=x.toLowerCase();y=y.toLowerCase();}
  return x===y||x.endsWith('/'+y)||y.endsWith('/'+x);
}
function editPaths(args:Record<string,unknown>) {
  const out:string[]=[];
  for(const key of ['filePath','path','file','target']) if(typeof args[key]==='string') out.push(String(args[key]));
  if(typeof args.patchText==='string') {
    for(const line of String(args.patchText).split('\n')) {
      const m=line.match(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/);
      if(m) out.push(m[1].trim());
    }
  }
  return [...new Set(out)];
}
function commandFamily(tool:string,args:Record<string,unknown>) {
  if(tool!=='bash') return tool;
  return String(args.command??'').trim().split(/\s+/).slice(0,2).join(' ');
}
function shellSegments(args:Record<string,unknown>) {
  return String(args.command??'').trim().split(/\s*(?:;|&&)\s*/).map(x=>x.trim()).filter(Boolean);
}
function shellNavigation(segment:string) {
  return /^(?:cd|chdir|set-location)\b/i.test(segment)||/^(?:pwd|get-location)\b/i.test(segment);
}
function goalFreeBash(args:Record<string,unknown>) {
  const segments=shellSegments(args);
  return segments.length>0&&segments.every(segment=>
    shellNavigation(segment)||
    /^openspec\s+(?:list|status|show|instructions)\b/i.test(segment)||
    /^git\s+(?:status|diff|show|log|branch|rev-parse)\b/i.test(segment)
  );
}
function verificationBash(args:Record<string,unknown>) {
  const segments=shellSegments(args).filter(segment=>!shellNavigation(segment));
  if(segments.length!==1) return false;
  const command=segments[0];
  return /^(?:npm(?:\.cmd)?\s+(?:test\b|run\s+(?:test|typecheck|lint|check|build)\b)|pnpm\s+(?:test\b|run\s+(?:test|typecheck|lint|check|build)\b)|yarn\s+(?:test\b|(?:test|typecheck|lint|check|build)\b)|bun\s+test\b|node(?:\.exe)?\s+--test\b|node(?:\.exe)?\s+\S*(?:test|spec|regression|check)\S*|pytest\b|python(?:\.exe)?\s+-m\s+pytest\b|cargo\s+test\b|go\s+test\b|dotnet\s+test\b|mvn\s+.*\btest\b|(?:gradle|gradlew(?:\.bat)?)\s+.*\btest\b|tsc\b|eslint\b|openspec\s+validate\b)/i.test(command);
}
function requiresGoal(tool:string,args:Record<string,unknown>) {
  if(['edit','write','apply_patch','patch'].includes(tool)) return true;
  if(tool==='bash') return !goalFreeBash(args);
  return false;
}
function completionGateBlocks(tool:string,args:Record<string,unknown>) {
  if(['edit','write','apply_patch','patch'].includes(tool)) return true;
  if(tool==='bash') return !goalFreeBash(args)&&!verificationBash(args);
  if(tool==='task') return true;
  return false;
}
function checkboxCount(text:string,checked:boolean) {
  const re=checked?/^- \[[xX]\]/gm:/^- \[ \]/gm;
  return text.match(re)?.length??0;
}
function completionMarkerChange(tool:string,args:Record<string,unknown>) {
  if(!['edit','write','apply_patch','patch'].includes(tool)) return undefined;
  const path=editPaths(args).find(p=>/(?:^|\/)openspec\/changes\/[^/]+\/tasks\.md$/i.test(normPath(p)));
  if(!path) return undefined;
  const oldText=String(args.oldString??args.old_string??'');
  const newText=String(args.newString??args.new_string??'');
  const patch=String(args.patchText??'');
  if(oldText||newText) {
    const oldOpen=checkboxCount(oldText,false),newOpen=checkboxCount(newText,false);
    const oldDone=checkboxCount(oldText,true),newDone=checkboxCount(newText,true);
    if(newDone>oldDone&&newOpen<oldOpen) return {kind:'complete' as const,path};
    if(newDone<oldDone&&newOpen>oldOpen) return {kind:'reopen' as const,path};
  }
  if(patch) {
    if(/^[-].*- \[ \]/m.test(patch)&&/^[+].*- \[[xX]\]/m.test(patch)) return {kind:'complete' as const,path};
    if(/^[-].*- \[[xX]\]/m.test(patch)&&/^[+].*- \[ \]/m.test(patch)) return {kind:'reopen' as const,path};
  }
  return undefined;
}
function classifyFailure(clean:string,error:string|undefined,failedCount:number|undefined):FailureKind {
  if(/(?:parameter (?:cannot be found|name).*['"]-?la['"]|not recognized as the name of a cmdlet|not recognized as an internal or external command|The term '.+' is not recognized|[A-Za-z]:\\dev\\null|(?:^|\s)head(?:\s|:).*not recognized)/im.test(clean)) return 'shell_mismatch';
  if(/\b(?:unknown|unrecognized) (?:option|argument)\b|\bDid you mean\b|^usage:/im.test(clean)) return 'cli_usage';
  if(error||failedCount!==undefined||/^(?:error(?:\[|:)|FAIL\b|FAILED\b)/im.test(clean)) return 'verification';
  return 'tooling';
}
function diagnosticLine(clean:string,error:string|undefined,failedCount:number|undefined) {
  if(error) return error;
  if(failedCount!==undefined) return 'test failures';
  const lines=clean.split('\n').map(x=>x.trim()).filter(Boolean);
  return lines.find(x=>/^(?:error|fatal|panic|failed|failure|usage:)/i.test(x)||/(?:unknown|unrecognized) (?:option|argument)|command not found|not recognized/i.test(x))??lines[0]??'nonzero';
}

export type State = {
  schemaVersion: number;
  phase: Phase;
  goal: string; problem: string; problemSignature: string; problemOperation: string; reason: string;
  tick: number; episodeStartTick: number; edits: number;
  failure: string; failureFile: string; failureKind: FailureKind|''; failures: number; failedCount?: number;
  lastEdit: number; revision: number; relevantRevision: number;
  evidence: Evidence[]; repeats: Record<string,number>; calls: Record<string,{count:number; evidence:string}>;
  hypotheses: Record<string,{status:string; evidence:string[]}>;
  signals: {name:string; tick:number}[]; advice?: string; recommended?: Move; advisorMoveError?: string;
  move?: Move; executing?: Move; previous?: string; previousMove?: Move;
  completionMarker?: {tick:number; revision:number; path:string};
  lastVerification?: {tick:number; revision:number; command:string; signature:string};
  completion?: {tick:number; revision:number; path:string; verificationTick:number; command:string};
  metrics: Record<string,number>;
};
export const initial = (): State => ({
  schemaVersion:STATE_SCHEMA_VERSION,
  phase:'RUNNING',goal:'',problem:'',problemSignature:'',problemOperation:'',reason:'',
  tick:0,episodeStartTick:0,edits:0,failure:'',failureFile:'',failureKind:'',failures:0,
  lastEdit:0,revision:0,relevantRevision:0,evidence:[],repeats:{},calls:{},hypotheses:{},signals:[],metrics:{},
});
type StoredState = Partial<State> & {schemaVersion?:number};
function migrateLegacyState(source:StoredState):State {
  const evidence=Array.isArray(source.evidence)?source.evidence:[];
  const maxEvidenceTick=evidence.reduce((max,e)=>Math.max(max,evidenceTick(e)),0);
  const tick=Math.max(typeof source.tick==='number'?source.tick:0,maxEvidenceTick);
  const metrics={...(source.metrics??{})};
  metrics.state_migrations=(metrics.state_migrations??0)+1;
  return {
    ...initial(),
    tick,
    episodeStartTick:tick+1,
    evidence:evidence.slice(-24),
    metrics,
  };
}
function normalizeState(s:State):State {
  const source=s as StoredState;
  if(source.schemaVersion!==STATE_SCHEMA_VERSION) return migrateLegacyState(source);
  const b=initial();
  return {...b,...source,evidence:source.evidence??[],repeats:source.repeats??{},calls:source.calls??{},hypotheses:source.hypotheses??{},signals:source.signals??[],metrics:source.metrics??{}};
}
function compactEvidence(e:Evidence) {
  return {
    id:e.id,
    tool:e.tool,
    kind:e.kind,
    summary:e.output.replace(/\s+/g,' ').trim().slice(0,240),
  };
}

export class Guard {
  s: State;
  constructor(s: State = initial()) {
    this.s=normalizeState(s);
    this.repairLoadedState();
  }
  metric(k:string) {this.s.metrics[k]=(this.s.metrics[k]??0)+1;}
  private repairLoadedState() {
    if(this.s.phase==='NEXT_EXECUTING') {
      if(this.s.move) {
        try {validateMove(this.s.move);this.s.phase='NEXT';this.s.executing=undefined;this.metric('state_repairs');return;} catch {}
      }
      this.s.phase='CONTRACT';this.s.move=undefined;this.s.executing=undefined;this.s.advisorMoveError='Recovered an invalid persisted NEXT execution';this.metric('state_repairs');return;
    }
    if(this.s.phase==='NEXT') {
      try {if(!this.s.move) throw Error('missing NEXT move');validateMove(this.s.move);}
      catch(e) {
        this.s.phase='CONTRACT';this.s.move=undefined;this.s.executing=undefined;
        this.s.advisorMoveError='Recovered invalid persisted NEXT: '+(e instanceof Error?e.message:String(e));
        this.metric('state_repairs');
      }
    }
  }
  private episodeEvidence() {return this.s.evidence.filter(e=>evidenceTick(e)>=this.s.episodeStartTick);}
  status(raw=false) {
    if(raw) return this.s;
    const evidence=this.episodeEvidence().map(compactEvidence);
    return {
      schemaVersion:this.s.schemaVersion,
      phase:this.s.phase,
      goal:this.s.goal,
      problem:this.s.problem,
      reason:this.s.reason,
      failure:{kind:this.s.failureKind,file:this.s.failureFile||undefined},
      advisorMoveError:this.s.advisorMoveError,
      recommended:this.s.recommended,
      move:this.s.move,
      executing:this.s.executing,
      completion:this.s.completion,
      completionMarker:this.s.completionMarker,
      lastVerification:this.s.lastVerification,
      episodeStartTick:this.s.episodeStartTick,
      evidenceCount:evidence.length,
      evidence,
      metrics:this.s.metrics,
    };
  }
  private refs(ids:string[],current=false) {
    const pool=current?this.episodeEvidence():this.s.evidence;
    return ids.length>0&&ids.every(id=>pool.some(e=>e.id===id));
  }
  private resetLoopCounters() {
    this.s.repeats={};this.s.failures=0;this.s.edits=0;this.s.failedCount=undefined;this.s.lastEdit=this.s.relevantRevision;
  }
  private startProblem(signature:string,operation:string,file:string,kind:FailureKind) {
    this.s.problemSignature=signature;
    this.s.problem=hash({goal:this.s.goal||'unreported',signature});
    this.s.problemOperation=operation;
    this.s.episodeStartTick=this.s.tick;
    this.s.reason='';this.s.failure='';this.s.failureFile=file;this.s.failureKind=kind;
    this.s.hypotheses={};this.s.signals=[];this.s.advice=undefined;this.s.recommended=undefined;this.s.advisorMoveError=undefined;
    this.resetLoopCounters();
  }
  private closeProblem() {
    this.s.problem='';this.s.problemSignature='';this.s.problemOperation='';this.s.reason='';this.s.failure='';this.s.failureFile='';this.s.failureKind='';
    this.s.hypotheses={};this.s.signals=[];this.s.advice=undefined;this.s.recommended=undefined;this.s.advisorMoveError=undefined;
    this.s.episodeStartTick=this.s.tick+1;this.resetLoopCounters();
  }
  private addEvidence(tool:string,args:Record<string,unknown>,clean:string,signature:string,kind?:FailureKind) {
    if(!this.s.evidence.some(e=>e.signature===signature&&evidenceTick(e)>=this.s.episodeStartTick)) {
      this.s.evidence.push({id:'e'+this.s.tick,tick:this.s.tick,tool,args,output:clean.slice(0,3000),signature,kind});
      this.s.evidence=this.s.evidence.slice(-24);
    }
  }
  private armCompletion() {
    const marker=this.s.completionMarker,verification=this.s.lastVerification;
    if(!marker||!verification) return undefined;
    this.s.completion={tick:this.s.tick,revision:this.s.revision,path:marker.path,verificationTick:verification.tick,command:verification.command};
    this.metric('completion_checkpoints');
    return 'GAL COMPLETION CHECKPOINT: verification passed and '+marker.path+' marks the task complete. Further edits and ad-hoc bash are blocked. Observe with read/grep/glob or read-only git/OpenSpec; if a real defect remains, collect new evidence and call gal_reopen.';
  }
  trigger(reason:string) {if(this.s.phase==='RUNNING') {this.s.phase='REQUIRED';this.s.reason=reason;this.metric('triggers');}}
  exhaust(reason:string) {this.s.phase='EXHAUSTED';this.s.reason=reason;this.metric('advisor_exhausted');}
  packet() {
    const all=this.episodeEvidence();
    const evidence=all.slice(-12).map(e=>({...e,output:e.output.slice(0,1200)}));
    return JSON.stringify({
      type:'GAL DIAGNOSTIC PACKET',goal:this.s.goal||'(unreported)',problem:this.s.problem,reason:this.s.reason,
      failure:{kind:this.s.failureKind,file:this.s.failureFile||undefined},episodeStartTick:this.s.episodeStartTick,
      evidence,evidenceOmitted:Math.max(0,all.length-evidence.length),hypotheses:this.s.hypotheses,completion:this.s.completion,
      question:'Return exactly one evidence-based observation as NEXT MOVE.'
    });
  }
  guardNotice() {
    const evidence=this.episodeEvidence().map(e=>e.id);
    const nextAction=
      this.s.phase==='REQUIRED'?'invoke task with subagent_type=gal-advisor':
      this.s.phase==='CONSULTING'?'wait for the advisor result; do not run project tools':
      this.s.phase==='CONTRACT'?'call gal_accept to use Advisor NEXT, or gal_reject with one different valid observation; do not execute NEXT before contracting':
      this.s.phase==='NEXT'?'execute the contracted NEXT exactly once':
      this.s.phase==='NEXT_EXECUTING'?'wait for the contracted result; use gal_repair only if the correct NEXT visibly returned a tool/schema/infrastructure error but no completion was observed':
      this.s.phase==='EXHAUSTED'?'stop autonomous debugging and report facts to the user':
      'continue normal work';
    return JSON.stringify({
      type:'GAL GUARD STATE',phase:this.s.phase,reason:this.s.reason,
      failure:{kind:this.s.failureKind,file:this.s.failureFile||undefined},
      evidence,advisorMoveError:this.s.advisorMoveError,nextAction
    });
  }
  reopen(reason:string,evidence:string[]) {
    if(this.s.phase!=='RUNNING'||!this.s.completion) throw Error('GAL REOPEN is available only after a verified completion checkpoint');
    const after=this.s.evidence.filter(e=>evidenceTick(e)>this.s.completion!.tick);
    if(!reason.trim()||evidence.length===0||!evidence.every(id=>after.some(e=>e.id===id))) throw Error('GAL REOPEN requires a reason and evidence produced after the completion checkpoint');
    this.s.completion=undefined;this.metric('completion_reopens');
  }
  report(input:{goal?:string; hypothesis?:string; status?:string; evidence?:string[]; signal?:string}) {
    if(input.goal&&!this.s.goal) this.s.goal=input.goal;
    if(input.hypothesis) {
      const old=this.s.hypotheses[input.hypothesis];
      if(old?.status==='REFUTED'&&input.status!=='REFUTED') this.trigger('contradicted_hypothesis_reuse');
      else {
        if(input.status!=='UNTESTED'&&!this.refs(input.evidence??[],true)) throw Error('Current-problem evidence IDs required');
        this.s.hypotheses[input.hypothesis]={status:input.status??'UNTESTED',evidence:input.evidence??[]};
      }
    }
    if(input.signal) {
      if(['manual_verification','contradicted_baseline','advisor_approach_reuse'].includes(input.signal)) this.trigger(input.signal);
      else {
        this.s.signals=this.s.signals.filter(x=>this.s.tick-x.tick<8);
        this.s.signals.push({name:input.signal,tick:this.s.tick});
        if(new Set(this.s.signals.map(x=>x.name)).size>=2) this.trigger('soft_signals');
      }
    }
  }
  consult() {
    if(this.s.phase==='RUNNING') this.trigger('explicit_consultation');
    if(this.s.phase!=='REQUIRED') throw Error('Consultation unavailable: '+this.s.phase);
    const key=this.s.problem||'session:'+hash(this.s.goal||'unreported');
    const digest=hash(this.episodeEvidence().map(e=>e.signature).sort());
    const old=this.s.calls[key];
    if(old&&(old.count>=2||old.evidence===digest)) {this.exhaust('Consultation budget or evidence cooldown');throw Error(this.s.reason);}
    this.s.calls[key]={count:(old?.count??0)+1,evidence:digest};
    this.s.phase='CONSULTING';this.metric('gal_invocations');
  }
  advised(text:string) {
    if(this.s.phase!=='CONSULTING') return;
    if(!['DIAGNOSIS','DEAD ASSUMPTION','EVIDENCE','NEXT MOVE','EXPECTED RESULT','DO NOT'].every(x=>text.includes(x))) {
      this.exhaust('Advisor returned invalid or failed diagnosis');return;
    }
    this.s.advice=text.slice(0,12000);this.s.phase='CONTRACT';this.s.recommended=undefined;this.s.advisorMoveError=undefined;
    try {
      const section=text.split('NEXT MOVE')[1].split('EXPECTED RESULT')[0];
      const json=section.slice(section.indexOf('{'),section.lastIndexOf('}')+1);
      const move=JSON.parse(json) as Move;
      validateMove(move);this.s.recommended=move;
    } catch(e) {
      this.s.advisorMoveError=e instanceof Error?e.message:String(e);this.metric('advisor_invalid_moves');
    }
  }
  contract(decision:string,reason:string,evidence:string[],move:Move) {
    if(this.s.phase!=='CONTRACT') throw Error('No pending recovery contract');
    if(!reason.trim()||!this.refs(evidence,true)) throw Error('Reason and current-problem evidence IDs required');
    if(!['ACCEPT','REJECT'].includes(decision)) throw Error('ACCEPT or REJECT required');
    if(decision==='ACCEPT'&&!this.s.recommended) throw Error('Advisor NEXT MOVE is invalid or unavailable'+(this.s.advisorMoveError?': '+this.s.advisorMoveError:'')+'. Use REJECT with a valid observation.');
    const effective=decision==='ACCEPT'?this.s.recommended!:move;
    validateMove(effective);
    if(decision==='REJECT'&&this.s.recommended&&hash(effective)===hash(this.s.recommended)) throw Error('REJECT requires a different observation');
    if(this.s.previousMove&&matchesMove(effective,this.s.previousMove.tool,this.s.previousMove.args)) throw Error('NEXT must differ from the previous stalled operation');
    this.s.move=effective;this.s.executing=undefined;this.s.phase='NEXT';this.metric('advisor_'+decision.toLowerCase());
  }
  repair(reason:string,evidence:string[],move:Move) {
    if(this.s.phase!=='NEXT_EXECUTING') throw Error('REPAIR is only available after a contracted observation started but no completion was observed');
    if(!reason.trim()||!this.refs(evidence,true)) throw Error('REPAIR requires a reason and current-problem evidence IDs');
    validateMove(move);
    if(this.s.executing&&matchesMove(move,this.s.executing.tool,this.s.executing.args)) throw Error('REPAIR must choose a different observation');
    this.s.move=move;this.s.executing=undefined;this.s.phase='NEXT';this.metric('advisor_repair');
  }
  before(tool:string,args:Record<string,unknown>) {
    if(tool==='gal_status') return;
    if(this.s.phase==='EXHAUSTED') throw Error('GAL EXHAUSTED: stop autonomous debugging and report facts to user. '+this.s.reason);
    if(tool==='gal_report'&&this.s.phase==='RUNNING') return;
    if(tool==='gal_reopen'&&this.s.phase==='RUNNING'&&this.s.completion) return;
    if(this.s.phase==='RUNNING'&&!this.s.goal&&requiresGoal(tool,args)) {
      this.metric('goal_gate_blocks');
      throw Error('GAL GOAL REQUIRED: register the current task goal with gal_report(goal=...) before edits or verification. This tool did not run. Read/glob/grep and read-only OpenSpec/git discovery remain allowed.');
    }
    if(this.s.phase==='RUNNING'&&this.s.completion&&completionGateBlocks(tool,args)) {
      this.metric('post_success_blocks');
      throw Error('GAL COMPLETION GUARD: verification already passed and the OpenSpec task is marked complete. This tool did not run. Use read/grep/glob, read-only git/OpenSpec discovery, or a recognized verification command. If a real defect remains, collect evidence after this checkpoint and call gal_reopen(reason,evidence) before modifying files.');
    }
    if(['gal_accept','gal_reject'].includes(tool)&&this.s.phase==='CONTRACT') return;
    if(tool==='gal_repair'&&this.s.phase==='NEXT_EXECUTING') return;
    if(tool==='task'&&args.subagent_type==='gal-advisor'&&['RUNNING','REQUIRED'].includes(this.s.phase)) return;
    if(this.s.phase==='NEXT'&&this.s.move) {
      if(matchesMove(this.s.move,tool,args)) {
        this.s.executing={tool,args};this.s.phase='NEXT_EXECUTING';this.metric('recovery_starts');return;
      }
      const detail=mismatchDetails(this.s.move,tool,args);
      this.s.move=undefined;this.s.executing=undefined;this.s.phase='CONTRACT';this.metric('next_contract_mismatches');
      throw Error('GAL GUARD NEXT MISMATCH: '+detail+'. phase_after=CONTRACT; move_cleared=true; REPAIR=false. The attempted tool did not run. Call gal_accept to retry the Advisor NEXT, or gal_reject with a different valid observation.');
    }
    if(this.s.phase==='NEXT_EXECUTING') throw Error('GAL GUARD NEXT_EXECUTING: the contracted observation started but completion was not observed. REPAIR is valid only if the correct NEXT visibly returned a tool/schema/infrastructure error without a completion event; then call gal_repair with a different valid observation.');
    if(this.s.phase!=='RUNNING') throw Error('GAL GUARD '+this.s.phase+': '+this.guardNotice());
  }
  observe(tool:string,args:Record<string,unknown>,output:string,exit?:number):string|undefined {
    let recovered=false;
    if(this.s.phase==='NEXT_EXECUTING'&&this.s.move&&matchesMove(this.s.move,tool,args)) {
      recovered=true;this.s.phase='RUNNING';this.s.move=undefined;this.s.executing=undefined;this.resetLoopCounters();this.metric('recovery_observations');
    }
    this.s.tick++;this.metric('tool_calls');
    const clean=output.replace(/\u001b\[[0-9;]*m/g,'').replace(/\r/g,'');
    const signature=hash({tool,exit,output:clean.replace(/\b\d+(?:\.\d+)?\s*ms\b/g,'<time>')});

    if(['edit','write','apply_patch','patch'].includes(tool)) {
      const markerChange=completionMarkerChange(tool,args);
      this.addEvidence(tool,args,clean,signature);
      this.s.revision++;
      const paths=editPaths(args);
      if(this.s.failureFile&&paths.some(p=>sameFile(p,this.s.failureFile))) {this.s.relevantRevision++;this.s.edits++;}
      else this.metric('unrelated_edits');
      if(markerChange?.kind==='reopen') {
        this.s.completionMarker=undefined;this.s.completion=undefined;this.metric('completion_markers_reopened');
      } else if(markerChange?.kind==='complete') {
        this.s.completionMarker={tick:this.s.tick,revision:this.s.revision,path:markerChange.path};this.metric('completion_markers');
        if(this.s.lastVerification&&this.s.lastVerification.revision===this.s.revision-1) return this.armCompletion();
      }
      return;
    }

    const error=clean.match(/(?:SyntaxError|AssertionError|TypeError|ReferenceError|Error):[^\n]*/)?.[0];
    const count=clean.match(/# fail (\d+)|Tests:\s+(\d+) failed/);
    const failedCount=count?Number(count[1]??count[2]):undefined;
    const failed=exit!==undefined?exit!==0:(tool==='bash'&&(!!error||(failedCount!==undefined&&failedCount>0)));
    const key=hash({tool,args});
    const location=clean.match(/([^\s()]+\.(?:[cm]?[jt]s|tsx|py)):(\d+)/);
    const file=location?.[1]??'';
    const bucket=location?Math.floor(Number(location[2])/10):undefined;
    const family=commandFamily(tool,args);
    let note:string|undefined;

    if(failed) {
      if(tool==='bash'&&verificationBash(args)&&this.s.completion) {
        this.s.completion=undefined;this.s.lastVerification=undefined;this.metric('completion_invalidated');
      }
      const diagnostic=diagnosticLine(clean,error,failedCount);
      const kind=classifyFailure(clean,error,failedCount);
      const problemSignature=hash({kind,diagnostic,file,bucket});
      const failure=hash({kind,diagnostic,file,bucket,family});
      const newProblem=!this.s.problemSignature||this.s.problemSignature!==problemSignature;
      const priorFailure=this.s.failure;
      const priorFailedCount=this.s.failedCount;
      if(newProblem) {
        if(this.s.problemSignature) this.metric('progress');
        this.startProblem(problemSignature,key,file,kind);
      } else {
        this.s.problemOperation=key;this.s.failureFile=file;this.s.failureKind=kind;
      }
      this.addEvidence(tool,args,clean,signature,kind);
      const improved=!newProblem&&failedCount!==undefined&&priorFailedCount!==undefined&&failedCount<priorFailedCount;
      const changedFailure=!newProblem&&!!priorFailure&&priorFailure!==failure;
      if(improved||changedFailure) {this.resetLoopCounters();this.metric('progress');}
      const sameFailure=!newProblem&&priorFailure===failure;
      if(kind==='verification'&&sameFailure&&this.s.relevantRevision>this.s.lastEdit) this.s.failures++;
      this.s.failure=failure;this.s.lastEdit=this.s.relevantRevision;this.s.failedCount=failedCount;
      this.s.repeats[key]=(this.s.repeats[key]??0)+1;
      if(this.s.failures>=2) this.trigger('same_failure_after_two_fixes');
      if(this.s.repeats[key]>=2&&!improved) this.trigger('same_tool_failure');
      if(kind==='verification'&&this.s.edits>=3&&sameFailure&&!improved) this.trigger('three_relevant_edits_without_progress');
      if(kind==='shell_mismatch') {this.metric('shell_mismatches');note='GAL NOTE: shell mismatch detected. Adapt the command to the active host/shell; do not edit project files to fix shell syntax.';}
      if(kind==='cli_usage') {this.metric('cli_usage_errors');note='GAL NOTE: CLI usage error detected. Check the command help/flags before changing project files.';}
    } else {
      this.addEvidence(tool,args,clean,signature);
      if(tool==='bash'&&this.s.problem&&key===this.s.problemOperation) {this.closeProblem();this.metric('progress');}
      if(tool==='bash'&&verificationBash(args)) {
        this.s.lastVerification={tick:this.s.tick,revision:this.s.revision,command:String(args.command??''),signature};
        this.metric('verification_passes');
        if(this.s.completionMarker) {
          const completionNote=this.armCompletion();
          if(completionNote) note=note?note+'\n'+completionNote:completionNote;
        }
      }
    }

    if(['grep','glob'].includes(tool)) {
      const search=hash({tool,args,signature});this.s.repeats[search]=(this.s.repeats[search]??0)+1;
      if(this.s.repeats[search]>=3) this.trigger('repeated_search_no_new_evidence');
    }
    this.s.previous=key;this.s.previousMove={tool,args};
    if(recovered) {
      const ack='GAL RECOVERY COMPLETE: contracted '+tool+' result observed; phase='+this.s.phase+'. Normal tools are allowed again.';
      note=note?ack+'\n'+note:ack;
    }
    return note;
  }
}
