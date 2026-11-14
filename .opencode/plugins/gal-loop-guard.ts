import { Plugin } from '@opencode/plugin';
import type { Plugin as V1Plugin, ToolContext } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';
import type { Result } from '@opencode/plugin/promise/tool';
import { canonicalMove, createGuardHooks } from '../gal/plugin.ts';
import { GenerationMonitor } from '../gal/generation.ts';

const server:V1Plugin=({directory,client})=>createGuardHooks(directory,async(id)=>{
  const result=await client.session.messages({path:{id},query:{limit:20}});
  if(result.error) throw Error('Cannot identify session agent');
  return result.data?.some(m=>m.info.role==='user'&&m.info.agent==='gal-advisor')??false;
});

function record(input:unknown):Record<string,unknown> {
  if(!input||typeof input!=='object'||Array.isArray(input)) throw Error('GAL tool input must be an object');
  return input as Record<string,unknown>;
}

type SessionID=Parameters<Plugin.Context['session']['get']>[0]['sessionID'];

function text(result:Result):string {
  if(typeof result.content==='string') return result.content;
  if(result.content) return result.content.filter(p=>p.type==='text').map(p=>p.text).join('\n');
  return typeof result.output==='string'?result.output:JSON.stringify(result.output)??'';
}

export default {
  ...Plugin.define({
    id:'gal-loop-guard',
    async setup(ctx) {
      const permission=ctx.permission as typeof ctx.permission & {assert?:(input:{sessionID:SessionID;action:string;resources:string[];save:string[]})=>Promise<void>};
      const authorize=typeof permission?.assert==='function'?async(sessionID:string,path:string,external:boolean)=>{
        if(external) await permission.assert!({sessionID:sessionID as SessionID,action:'external_directory',resources:[path],save:[]});
        await permission.assert!({sessionID:sessionID as SessionID,action:'read',resources:[path],save:[]});
      }:undefined;
      const hooks=await createGuardHooks(ctx.location.directory,async(id)=>
        (await ctx.session.get({sessionID:id as SessionID})).agent==='gal-advisor',true,authorize);
      const monitor=new GenerationMonitor(hooks.settings.generation,(sessionID,message)=>{
        // Emit a public notification, without enqueueing another model request.
        void ctx.session.synthetic({sessionID:sessionID as SessionID,text:message,resume:false}).catch(()=>{});
      });
      const controller=new AbortController();let timer:ReturnType<typeof setInterval>|undefined;
      let events:Promise<void>|undefined;
      if(hooks.settings.generation.mode==='notify') {
        if(typeof ctx.event?.subscribe!=='function') throw Error('GAL generation notifications require the public event subscription API');
        let serial=0;
        await ctx.session.hook('model.request',event=>monitor.start(event.sessionID,String(++serial),event.kind,event.agent==='gal-advisor'));
        timer=setInterval(()=>monitor.poll(),1000);timer.unref?.();
        hooks.monitorState.active=true;
        events=(async()=>{
          for await(const event of ctx.event.subscribe({signal:controller.signal})) {
            if(event.type==='session.status') {
              const data=event.data as {sessionID:string;status:{type:string}};
              if(data.status.type==='idle') monitor.end(data.sessionID);
            }
          }
        })().catch(error=>{if(!controller.signal.aborted){monitor.clear();if(timer) clearInterval(timer);hooks.monitorState.active=false;hooks.monitorState.error='Public lifecycle event stream unavailable';throw error;}});
        // Consume failures; generation capability is only advisory and must not crash the host.
        void events.catch(()=>{});
      }

      await ctx.tool.transform(editor=>{
        for(const [name,definition] of Object.entries(hooks.tool??{})) {
          const schema=tool.schema.object(definition.args);
          editor.add({
            name,description:definition.description,input:tool.schema.toJSONSchema(schema),
            // Control tools stay directly callable while Code Mode is blocked.
            options:{codemode:false},
            async execute(input,context) {
              // Shared control tools only consume sessionID from the host context.
              const result=await definition.execute(schema.parse(input),{sessionID:context.sessionID} as unknown as ToolContext);
              return {content:typeof result==='string'?result:result.output};
            },
          });
        }
      });

      await ctx.tool.hook('execute.before',async event=>{
        monitor.end(event.sessionID);
        const native=record(event.input);
        const call=canonicalMove({tool:event.tool,args:native});
        const output={args:call.args};
        await hooks['tool.execute.before']!({sessionID:event.sessionID,tool:call.tool,callID:event.id},output);
        if(event.tool==='subagent'&&native.agent==='gal-advisor') {
          const args:Record<string,unknown>={...native,prompt:output.args.prompt};
          delete args.sessionID;
          delete args.task_id;
          event.input=args;
        }
      });

      await ctx.tool.hook('execute.after',async event=>{
        const call=canonicalMove({tool:event.tool,args:record(event.input)});
        if(event.status==='error') {
          await hooks.event!({event:{type:'message.part.updated',properties:{part:{
            type:'tool',id:event.id,messageID:event.messageID,sessionID:event.sessionID,callID:event.id,tool:call.tool,
            state:{status:'error',input:call.args,error:event.error.message,time:{start:0,end:0}},
          }}}});
          return;
        }
        const structured=event.result.output as {exit?:number;status?:string;shellID?:string;timeout?:boolean}|undefined;
        if(call.tool==='bash'&&(structured?.status==='running'||event.result.metadata?.status==='running')) {
          const shellID=structured?.shellID??event.result.metadata?.shellID;
          if(typeof shellID!=='string') throw Error('GAL cannot track background shell without shellID');
          await hooks.deferShell(event.sessionID,shellID,call.args,event.id);
          return;
        }
        let content=text(event.result);
        if(call.tool==='task'&&call.args.subagent_type==='gal-advisor') {
          const result=event.result.output as {sessionID?:string;status?:string;output?:string}|undefined;
          if(result?.status==='running') {
            try {
              if(!result.sessionID) throw Error('Advisor result has no sessionID');
              const sessionID=result.sessionID as SessionID;
              await ctx.session.wait({sessionID});
              const messages=await ctx.session.context({sessionID});
              const response=messages.findLast(message=>message.type==='assistant');
              content=response?.type==='assistant'?response.content.filter(p=>p.type==='text').map(p=>p.text).join(''):'';
            } catch(error) {
              content='Advisor task failed: '+(error instanceof Error?error.message:String(error));
            }
          } else if(typeof result?.output==='string') content=result.output;
        }
        const metadata=event.result.metadata??{};
        const exit=typeof metadata.exit==='number'?metadata.exit:structured?.exit??(metadata.timeout||structured?.timeout?1:undefined);
        const output={title:event.tool,output:content,metadata:{...metadata,_galResult:event.result.output,...(exit===undefined?{}:{exit})}};
        await hooks['tool.execute.after']!({sessionID:event.sessionID,tool:call.tool,callID:event.id,args:call.args},output);
        // Preserve structured output, metadata, and file attachments while adding notices.
        if(output.output!==text(event.result)) {
          const attachments=Array.isArray(event.result.content)?event.result.content.filter(p=>p.type!=='text'):[];
          event.result={...event.result,content:attachments.length?[...attachments,{type:'text',text:output.output}]:output.output};
        }
      });

      await ctx.session.hook('context',async event=>{
        let notes:string[]=[];
        if(event.agent!=='gal-advisor') {
          const messages=await ctx.session.context({sessionID:event.sessionID});
          const notifications=messages.flatMap(message=>{
            if(message.type!=='synthetic'||message.metadata?.source!=='shell'||typeof message.metadata.shellID!=='string') return [];
            const exit=typeof message.metadata.exit==='number'?message.metadata.exit:
              message.metadata.timeout||message.metadata.state==='error'||message.metadata.state==='cancelled'?1:undefined;
            return [{shellID:message.metadata.shellID,output:message.text,exit}];
          });
          notes=await hooks.completeShells(event.sessionID,notifications);
        }
        const output={system:[notes.join('\n')]};
        await hooks['experimental.chat.system.transform']!({sessionID:event.sessionID,model:{} as never},output);
        if(!output.system[0]) return;
        const last=event.system.at(-1);
        if(last?.type==='text') event.system[event.system.length-1]={...last,text:last.text+'\n'+output.system[0].trimStart()};
        else event.system.push({type:'text',text:output.system[0].trimStart()});
      });
      return async()=>{controller.abort();if(timer) clearInterval(timer);monitor.clear();hooks.monitorState.active=false;await events?.catch(()=>{});};
    },
  }),
  server,
};
