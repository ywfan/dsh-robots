import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
export async function connect(file=new URL('../.runtime/connection.json',import.meta.url)) {
 const {url}=JSON.parse(await readFile(file,'utf8')); const target=new URL(url);const root=target.origin;
 const response=await fetch(root+'/connect'+target.search,{redirect:'manual'});
 if(response.status!==302)throw new Error(`Connect: HTTP ${response.status}`);
 const cookie=response.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
 return async function rpc(endpoint,args={}){
  const response=await fetch(`${root}/api/${endpoint}`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:endpoint,payload:{args}})});
  const body=await response.json();if(!body.result?.ok)throw new Error(JSON.stringify(body.result?.error??body));return body.result.value;
 };
}
if(process.argv[1]===new URL(import.meta.url).pathname){const rpc=await connect();const value=await rpc(process.argv[2]??'robotManagement/list',process.argv[3]?JSON.parse(process.argv[3]):{});process.stdout.write(JSON.stringify(value,null,2)+'\n');}
