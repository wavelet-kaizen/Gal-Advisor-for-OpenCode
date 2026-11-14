import type { Config } from './config.ts';
// Public lifecycle metadata only. This class never receives stream/reasoning text.
export class GenerationMonitor {
  private active=new Map<string,{requestID:string;started:number;advisor:boolean;warned:boolean;limited:boolean}>();
  private settings:Config['generation'];private notify:(sessionID:string,message:string)=>void;private now:()=>number;
  constructor(settings:Config['generation'],notify:(sessionID:string,message:string)=>void,now=()=>Date.now()) {this.settings=settings;this.notify=notify;this.now=now;}
  start(sessionID:string,requestID:string,kind:string,advisor=false) {
    if(this.settings.mode==='off'||kind!=='primary') return;
    // Retried provider calls share the outstanding operation's cumulative budget.
    if(!this.active.has(sessionID)) this.active.set(sessionID,{requestID,started:this.now(),advisor,warned:false,limited:false});
  }
  end(sessionID:string,requestID?:string) {
    if(!requestID||this.active.get(sessionID)?.requestID===requestID) this.active.delete(sessionID);
  }
  poll() {
    for(const [id,run] of this.active) {
      const seconds=(this.now()-run.started)/1000;
      const limit=run.advisor?this.settings.advisorMaxSeconds:this.settings.maxSeconds;
      if(seconds>=limit&&!run.limited){run.limited=true;this.notify(id,'GAL generation_budget_exceeded: public lifecycle budget exceeded; notify-only, generation loop and server cancellation are not confirmed');}
      else if(seconds>=this.settings.warnAfterSeconds&&!run.warned&&!run.limited){run.warned=true;this.notify(id,'GAL generation warning: model request exceeds configured warning budget');}
    }
  }
  clear(){this.active.clear();}
}
