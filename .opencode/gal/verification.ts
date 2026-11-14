export type Verdict='PASS'|'FAIL'|'UNKNOWN';
export type Summary={testsRun:number;failures:number;errors:number;skipped:number};
export type Diagnostic={path?:string;line?:number;column?:number;message:string};
export type Verification={verdict:Verdict;summary?:Summary;diagnostic?:Diagnostic;complete:boolean};

export function diagnostic(text:string):Diagnostic|undefined {
  const javac=text.match(/(?:^|\n)(.+?\.(?:java|jsp|jspx)):(\d+)(?::(\d+))?:\s*(?:error:)?\s*([^\n]+)/);
  if(javac) return {path:javac[1].trim(),line:Number(javac[2]),column:javac[3]?Number(javac[3]):undefined,message:javac[4].trim()};
  const jsp=text.match(/([^\s\[\]]+\.jspx?)\]?[^\n]*?\bline[: ]+\[?(\d+)\]?/i);
  if(jsp) return {path:jsp[1],line:Number(jsp[2]),message:text.split('\n').find(line=>line.includes(jsp[1]))??'JSP compilation error'};
  const stack=text.match(/\(([^()]+\.java):(\d+)\)/);
  if(stack) return {path:stack[1],line:Number(stack[2]),message:text.match(/[^\n]*(?:Exception|Error)[^\n]*/)?.[0]??'Java stack trace'};
  return undefined;
}

export function junit(text:string):Summary|undefined {
  if(/<!DOCTYPE|<!ENTITY/i.test(text)) return undefined;
  const summaries=[...text.matchAll(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)(?:,\s*Skipped:\s*(\d+))?/g)];
  if(summaries.length) {
    const unique=new Set(summaries.map(m=>JSON.stringify(m.slice(1))));
    if(unique.size!==1) return undefined; // Multiple unscoped suites cannot safely be added.
    const m=summaries[0];return {testsRun:+m[1],failures:+m[2],errors:+m[3],skipped:+(m[4]??0)};
  }
  const suites=[...text.matchAll(/<testsuite\b([^>]*)>/g)];
  if(!suites.length) return undefined;
  const seen=new Set<string>();const total={testsRun:0,failures:0,errors:0,skipped:0};
  for(const suite of suites) {
    const attrs=Object.fromEntries([...suite[1].matchAll(/([\w]+)=["']([^"']*)["']/g)].map(m=>[m[1],m[2]]));
    if(!attrs.name||seen.has(attrs.name)||!['tests','failures','errors'].every(k=>/^\d+$/.test(attrs[k]??''))) return undefined;
    if(attrs.skipped!==undefined&&!/^\d+$/.test(attrs.skipped)) return undefined;
    seen.add(attrs.name);total.testsRun+=+attrs.tests;total.failures+=+attrs.failures;total.errors+=+attrs.errors;total.skipped+=+(attrs.skipped??0);
  }
  // Reject incomplete fragments; parent testsuites totals are deliberately ignored.
  if((text.match(/<\/testsuite>/g)?.length??0)+suites.filter(m=>/\/$/.test(m[1].trim())).length!==suites.length) return undefined;
  return total;
}

export function simpleVerification(command:string):'compile'|'test'|'command'|undefined {
  if(/[;|&\r\n<>]/.test(command)) return undefined;
  if(/^(?:"[^"\r\n]*[\\/]javac(?:\.exe)?"|(?:\S*[\\/])?javac(?:\.exe)?)\s/i.test(command)) return 'compile';
  if(/^(?:ant(?:\.bat|\.cmd)?)(?:\s|$)/i.test(command)) return 'command';
  return undefined;
}

export function verify(text:string,exit:number|undefined,kind:'compile'|'test'|'command',complete=true):Verification {
  const summary=junit(text),issue=diagnostic(text);
  if(!complete) return {verdict:'UNKNOWN',complete:false};
  if((exit!==undefined&&exit!==0)||(summary&&(summary.failures+summary.errors>0))||/\bBUILD FAILED\b/.test(text)) return {verdict:'FAIL',summary,diagnostic:issue,complete:true};
  if(exit!==0||/Tests run:|<testsuite\b/.test(text)&&!summary||summary?.testsRun===0||kind==='test'&&!summary) return {verdict:'UNKNOWN',summary,diagnostic:issue,complete:true};
  return {verdict:'PASS',summary,diagnostic:issue,complete:true};
}
