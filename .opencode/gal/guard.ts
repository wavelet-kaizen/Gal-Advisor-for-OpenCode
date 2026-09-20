import { createHash } from 'node:crypto';

export const hash = (v: unknown): string => createHash('sha256').update(stable(v)).digest('hex');
export function stable(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k,x]) => JSON.stringify(k)+':'+stable(x)).join(',') + '}';
  return JSON.stringify(v) ?? 'null';
}
export type Move = { tool: string; args: Record<string, unknown> };

const RECOVERY_TOOLS=new Set(['read','glob','grep','bash']);
const simpleGit=/^git (?:diff|status|show|log)(?: [a-zA-Z0-9_./:@{},+ -]+)?$/;
const dangerousGit=/--(?:output|ext-diff|textconv|config)/;
function requireString(args:Record<string,unknown>,key:string) {
  const value=args[key];
  if(typeof value!=='string'||!value.trim()) throw Error(`NEXT ${key} must be a non-empty string`);
}
function optionalString(args:Record<string,unknown>,key:string) {
  const value=args[key];
  if(value!==undefined&&typeof value!=='string') throw Error(`NEXT ${key} must be a string when provided`);
}
function optionalNumber(args:Record<string,unknown>,key:string) {
  const value=args[key];
  if(value!==undefined&&(typeof value!=='number'||!Number.isFinite(value)||value<0)) throw Error(`NEXT ${key} must be a non-negative number when provided`);
}
export function validateMove(move:Move) {
  if(!move||typeof move.tool!=='string'||!move.args||Array.isArray(move.args)||typeof move.args!=='object') throw Error('NEXT must contain one tool and args object');
  if(!RECOVERY_TOOLS.has(move.tool)) throw Error('NEXT must be one observation tool');
  if(move.tool==='read') {requireString(move.args,'filePath');optionalNumber(move.args,'offset');optionalNumber(move.args,'limit');}
  if(move.tool==='glob') {requireString(move.args,'pattern');optionalString(move.args,'path');}
  if(move.tool==='grep') {requireString(move.args,'pattern');optionalString(move.args,'path');optionalString(move.args,'include');}
  if(move.tool==='bash') {
    requireString(move.args,'command');
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
type Evidence = { id: string; tool: string; args: Record<string, unknown>; output: string; signature: string };
export type State = {
  phase: 'RUNNING'|'REQUIRED'|'CONSULTING'|'CONTRACT'|'NEXT'|'EXHAUSTED';
  goal: string; problem: string; reason: string; tick: number; edits: number;
  failure: string; failures: number; failedCount?: number; lastEdit: number; revision: number;
  evidence: Evidence[]; repeats: Record<string,number>; calls: Record<string,{count:number; evidence:string}>;
  hypotheses: Record<string,{status:string; evidence:string[]}>;
  signals: {name:string; tick:number}[]; advice?: string; recommended?: Move; advisorMoveError?: string; move?: Move; previous?: string;
  metrics: Record<string,number>;
};
export const initial = (): State => ({phase:'RUNNING',goal:'',problem:'',reason:'',tick:0,edits:0,failure:'',failures:0,lastEdit:0,revision:0,evidence:[],repeats:{},calls:{},hypotheses:{},signals:[],metrics:{}});
export class Guard {
  s: State;
  constructor(s: State = initial()) { this.s=s; }
  metric(k:string) { this.s.metrics[k]=(this.s.metrics[k]??0)+1; }
  trigger(reason:string) { if(this.s.phase==='RUNNING') {this.s.phase='REQUIRED';this.s.reason=reason;this.metric('triggers');} }
  exhaust(reason:string) {this.s.phase='EXHAUSTED';this.s.reason=reason;this.metric('advisor_exhausted');}
  packet() { return JSON.stringify({type:'GAL DIAGNOSTIC PACKET',goal:this.s.goal,problem:this.s.problem,reason:this.s.reason,evidence:this.s.evidence,hypotheses:this.s.hypotheses,question:'Return exactly one evidence-based observation as NEXT MOVE.'}); }
  refs(ids:string[]) { return ids.length>0 && ids.every(id=>this.s.evidence.some(e=>e.id===id)); }
  report(input:{goal?:string; hypothesis?:string; status?:string; evidence?:string[]; signal?:string}) {
    if(input.goal && !this.s.goal) this.s.goal=input.goal;
    if(input.hypothesis) {
      const old=this.s.hypotheses[input.hypothesis];
      if(old?.status==='REFUTED' && input.status!=='REFUTED') this.trigger('contradicted_hypothesis_reuse');
      else {
        if(input.status!=='UNTESTED' && !this.refs(input.evidence??[])) throw Error('Observed evidence IDs required');
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
    const key=this.s.problem||'session';
    const digest=hash(this.s.evidence.map(e=>e.signature).sort());
    const old=this.s.calls[key];
    if(old && (old.count>=2||old.evidence===digest)) {this.exhaust('Consultation budget or evidence cooldown');throw Error(this.s.reason);}
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
      validateMove(move);
      this.s.recommended=move;
    } catch(e) {
      this.s.advisorMoveError=e instanceof Error?e.message:String(e);
      this.metric('advisor_invalid_moves');
    }
  }
  contract(decision:string, reason:string, evidence:string[], move:Move) {
    if(this.s.phase!=='CONTRACT') throw Error('No pending recovery contract');
    if(!reason.trim() || !this.refs(evidence)) throw Error('Reason and observed evidence IDs required');
    if(!['ACCEPT','REJECT'].includes(decision)) throw Error('ACCEPT or REJECT required');
    if(decision==='ACCEPT'&&!this.s.recommended) throw Error('Advisor NEXT MOVE is invalid or unavailable'+(this.s.advisorMoveError?': '+this.s.advisorMoveError:'')+'. Use REJECT with a valid observation.');
    const effective=decision==='ACCEPT' ? this.s.recommended! : move;
    validateMove(effective);
    if(decision==='REJECT' && this.s.recommended && hash(effective)===hash(this.s.recommended)) throw Error('REJECT requires a different observation');
    if(hash(effective)===this.s.previous) throw Error('NEXT must differ from the previous stalled operation');
    this.s.move=effective;this.s.phase='NEXT';this.metric('advisor_'+decision.toLowerCase());
  }
  before(tool:string,args:Record<string,unknown>) {
    if(tool==='gal_status') return;
    if(this.s.phase==='EXHAUSTED') throw Error('GAL EXHAUSTED: stop autonomous debugging and report facts to user. '+this.s.reason);
    if(tool==='gal_report' && this.s.phase==='RUNNING') return;
    if(tool==='gal_recover' && this.s.phase==='CONTRACT') return;
    if(tool==='task' && args.subagent_type==='gal-advisor' && ['RUNNING','REQUIRED'].includes(this.s.phase)) return;
    if(this.s.phase==='NEXT' && this.s.move && matchesMove(this.s.move,tool,args)) {this.s.move=undefined;return;}
    if(this.s.phase==='NEXT' && this.s.move) throw Error('GAL GUARD NEXT: Execute the contracted observation now. Contracted values must be preserved; safe optional read/grep/glob args may be added.\nTOOL: '+this.s.move.tool+'\nARGS: '+JSON.stringify(this.s.move.args));
    if(this.s.phase!=='RUNNING') throw Error('GAL GUARD '+this.s.phase+': '+this.packet());
  }
  observe(tool:string,args:Record<string,unknown>,output:string,exit?:number) {
    if(this.s.phase==='NEXT' && !this.s.move) {this.s.phase='RUNNING';this.s.repeats={};this.s.failures=0;this.s.edits=0;this.metric('recovery_observations');}
    this.s.tick++;this.metric('tool_calls');
    const clean=output.replace(/\u001b\[[0-9;]*m/g,'').replace(/\r/g,'');
    const signature=hash({tool,exit,output:clean.replace(/\b\d+(?:\.\d+)?\s*ms\b/g,'<time>')});
    if(!this.s.evidence.some(e=>e.signature===signature)) {
      this.s.evidence.push({id:'e'+this.s.tick,tool,args,output:clean.slice(0,3000),signature});
      this.s.evidence=this.s.evidence.slice(-24);
    }
    if(['edit','write','apply_patch','patch'].includes(tool)) {this.s.revision++;this.s.edits++;return;}
    const error=clean.match(/(?:SyntaxError|AssertionError|TypeError|ReferenceError|Error):[^\n]*/)?.[0];
    const diagnostic=error??clean.split('\n').map(x=>x.trim()).find(x=>/^(?:error|fatal|panic|failed|failure|usage:)/i.test(x)||/(?:command not found|is not recognized)/i.test(x))??'nonzero';
    const count=clean.match(/# fail (\d+)|Tests:\s+(\d+) failed/);
    const failedCount=count?Number(count[1]??count[2]):undefined;
    const failed=exit!==undefined ? exit!==0 : (tool==='bash'&&(!!error||(failedCount!==undefined&&failedCount>0)));
    const key=hash({tool,args});
    const location=clean.match(/([^\s()]+\.(?:[cm]?[jt]s|tsx|py)):(\d+)/);
    const commandFamily=tool==='bash'?String(args.command??'').trim().split(/\s+/).slice(0,2).join(' '):tool;
    const failure=hash({diagnostic,file:location?.[1],bucket:location?Math.floor(Number(location[2])/10):undefined,commandFamily});
    const improved=failedCount!==undefined&&this.s.failedCount!==undefined&&failedCount<this.s.failedCount;
    const sameFailure=failure===this.s.failure;
    if(failed) {
      if(!this.s.problem) this.s.problem=hash({goal:this.s.goal,tool,args});
      if(improved || (this.s.failure && failure!==this.s.failure)) {this.s.failures=0;this.s.edits=0;this.s.repeats={};this.metric('progress');}
      if(failure===this.s.failure && this.s.revision>this.s.lastEdit) this.s.failures++;
      this.s.failure=failure;this.s.lastEdit=this.s.revision;this.s.failedCount=failedCount;
      this.s.repeats[key]=(this.s.repeats[key]??0)+1;
      if(this.s.failures>=2) this.trigger('same_failure_after_two_fixes');
      if(this.s.repeats[key]>=2 && !improved) this.trigger('same_tool_failure');
      if(this.s.edits>=3 && sameFailure && !improved) this.trigger('three_edits_without_progress');
    } else if(tool==='bash' && (exit===0 || failedCount===0) && this.s.problem===hash({goal:this.s.goal,tool,args})) {
      this.s.failures=0;this.s.edits=0;this.s.repeats={};this.s.failure='';this.metric('progress');
    }
    if(['grep','glob'].includes(tool)) {
      const search=hash({tool,args,signature});this.s.repeats[search]=(this.s.repeats[search]??0)+1;
      if(this.s.repeats[search]>=3) this.trigger('repeated_search_no_new_evidence');
    }
    this.s.previous=hash({tool,args});
  }
}
