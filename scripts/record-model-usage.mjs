import { connect } from './api-client.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
const rpc=await connect(), sessionId=process.argv[2]; if(!sessionId)throw new Error('Pass sessionId');
const page=await rpc('session/events',{request:{address:{kind:'session',sessionId},maxMessages:1000}});
if(page.hasMore)throw new Error('History truncated; do not report partial totals');
const totals={}, calls=[];
for(const record of page.records){const event=record.event;if(!event)continue;
 if(event.type==='assistant/message'){
  const {message,usage,turn,step}=event.data; if(message.source?.kind!=='model')continue;
  const route=`${message.source.provider}/${message.source.model}`; const sum=totals[route]??={requests:0,inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,totalTokens:0};sum.requests++;
  for(const key of ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','totalTokens'])sum[key]+=usage?.[key]??0;
  calls.push({seq:event.seq,turn,step,provider:message.source.provider,model:message.source.model,usage});
 }
 if(event.type==='session/title-llm-request')calls.push({seq:event.seq,auxiliary:'session-title',route:event.data.route,usage:event.data.usage??null});
}
const report={sessionId,recordedAt:new Date().toISOString(),source:'DSH durable session/events; model request metadata, not model self-report',totals,calls,auxiliaryUsageNote:'If a title request has null usage it is not included in totals; no guessed counts or costs.'};
await mkdir('artifacts/live',{recursive:true});await writeFile(`artifacts/live/${sessionId}-usage.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({sessionId,totals,auxiliary:calls.filter(x=>x.auxiliary)}));
