import { open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
export type Authorize=(sessionID:string,path:string,external:boolean)=>Promise<void>;
export async function readAuthorized(directory:string,path:string,sessionID:string,authorize:Authorize) {
  const canonical=await realpath(resolve(directory,path));const root=await realpath(directory);
  const rel=relative(root,canonical);const external=rel==='..'||rel.startsWith('..\\')||rel.startsWith('../')||isAbsolute(rel);
  await authorize(sessionID,canonical,external);
  const file=await open(canonical,'r');
  try {
    const stat=await file.stat();if(!stat.isFile()||stat.size>1024*1024) throw Error('GAL text input must be a file of at most 1 MiB');
    const bytes=Buffer.alloc(1024*1024+1);let used=0;
    while(used<bytes.length){const chunk=await file.read(bytes,used,bytes.length-used,null);if(!chunk.bytesRead)break;used+=chunk.bytesRead;}
    if(used>1024*1024) throw Error('GAL text input exceeds 1 MiB');
    // Re-resolve after opening to detect a symlink target changed during authorization.
    if(await realpath(resolve(directory,path))!==canonical) throw Error('GAL path changed during authorization');
    const data=bytes.subarray(0,used);return {path:canonical,bytes:data,contentHash:createHash('sha256').update(data).digest('hex')};
  } finally {await file.close();}
}
export async function inspectText(directory:string,input:{path:string;encoding?:string;startLine?:number;lineCount?:number},sessionID:string,authorize:Authorize) {
  const encoding=input.encoding??'utf-8';if(encoding!=='utf-8') throw Error('GAL supported encoding: utf-8 (strict)');
  const startLine=input.startLine??1,lineCount=input.lineCount??20;
  if(!Number.isInteger(startLine)||startLine<1||!Number.isInteger(lineCount)||lineCount<1||lineCount>100) throw Error('GAL invalid line range');
  const source=await readAuthorized(directory,input.path,sessionID,authorize);
  let text:string;
  try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(source.bytes);}
  catch{return {path:source.path,contentHash:source.contentHash,encoding,decode:'INVALID',bytesHex:source.bytes.subarray(0,128).toString('hex'),partial:true};}
  const all=text.split(/\r\n|\n|\r/);let remaining=2000;
  const lines=all.slice(startLine-1,startLine-1+lineCount).map((line,i)=>{
    const characters=Array.from(line).slice(0,remaining);remaining-=characters.length;
    const sample=characters.join('');return {line:startLine+i,text:sample,codepoints:characters.map(c=>'U+'+c.codePointAt(0)!.toString(16).toUpperCase().padStart(4,'0')),bytesHex:Buffer.from(sample,'utf8').toString('hex'),truncated:sample!==line};
  });
  return {path:source.path,contentHash:source.contentHash,encoding,decode:'VALID',newline:{crlf:(text.match(/\r\n/g)??[]).length,lf:(text.match(/(?<!\r)\n/g)??[]).length,cr:(text.match(/\r(?!\n)/g)??[]).length},startLine,lineCount:lines.length,partial:startLine>1||startLine-1+lineCount<all.length||lines.some(l=>l.truncated),lines};
}
