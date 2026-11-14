import { tool } from '@opencode-ai/plugin';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const z=tool.schema;
const path=z.string().min(1);
const check=z.object({
  id:path,scope:path,kind:z.enum(['compile','test','command']),paths:z.array(path).min(1),
  command:path.optional(),tool:path.optional(),match:z.record(z.string(),z.string()).default({}),
  resultTool:path.optional(),executionIDPath:path.optional(),resultIDArg:path.default('executionID'),
  statePath:path.default('state'),exitPath:path.default('exit'),textPath:path.default('output'),
  errorsPath:path.optional(),
}).strict().refine(v=>Boolean(v.command)!==Boolean(v.tool),'Specify exactly one command or tool')
  .refine(v=>!v.resultTool||Boolean(v.executionIDPath),'Asynchronous adapter requires executionIDPath');
export const configSchema=z.object({
  checks:z.array(check).default([]),
  generation:z.object({mode:z.enum(['off','notify','interrupt']).default('off'),warnAfterSeconds:z.number().positive().default(180),maxSeconds:z.number().positive().default(600),advisorMaxSeconds:z.number().positive().default(180)}).strict().default({mode:'off',warnAfterSeconds:180,maxSeconds:600,advisorMaxSeconds:180}),
}).strict().superRefine((v,ctx)=>{
  if(new Set(v.checks.map(c=>c.id)).size!==v.checks.length) ctx.addIssue({code:'custom',message:'Duplicate check id'});
  const routes=v.checks.map(c=>c.command?'command:'+c.command:'tool:'+c.tool+':'+JSON.stringify(Object.entries(c.match).sort()));
  if(new Set(routes).size!==routes.length) ctx.addIssue({code:'custom',message:'Duplicate verification route'});
  if(v.generation.warnAfterSeconds>=v.generation.maxSeconds) ctx.addIssue({code:'custom',message:'Warning must precede generation limit'});
  // No validated end/cancellation capability exists for the bundled hosts yet.
  if(v.generation.mode==='interrupt') ctx.addIssue({code:'custom',message:'interrupt unavailable: host/Strata cancellation capability has not been validated; use notify'});
});
export type Config=ReturnType<typeof configSchema.parse>;
export type Check=Config['checks'][number];
export async function loadConfig(directory:string):Promise<Config> {
  try{return configSchema.parse(JSON.parse(await readFile(join(directory,'.opencode','gal.json'),'utf8')));}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT') return configSchema.parse({});throw e;}
}
export function field(value:unknown,path:string):unknown {
  return path.split('.').reduce<unknown>((v,k)=>v&&typeof v==='object'&&Object.hasOwn(v,k)?(v as Record<string,unknown>)[k]:undefined,value);
}
