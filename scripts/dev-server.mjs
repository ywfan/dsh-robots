import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
const root = resolve(import.meta.dirname,'..');
const home = process.env.DSH_HOME ?? resolve(root, '.runtime/dsh-dev-home');
const connectionPath = resolve(process.env.ROBOT_CONNECTION_FILE ?? resolve(root,'.runtime/connection.json'));
const child = spawn(resolve(root,'node_modules/.bin/dsh'),['--profile','web','--host','127.0.0.1','--port',process.env.ROBOT_PORT ?? '38080','--no-open'], {cwd:root,env:{...process.env,DSH_HOME:home},stdio:['inherit','pipe','pipe']});
let buffer='';
child.stdout.on('data', async data => {
 buffer+=data.toString(); const match=/dsh web: (http[^\s]+)/.exec(buffer);
 if(match){await mkdir(dirname(connectionPath),{recursive:true,mode:0o700});await writeFile(connectionPath,JSON.stringify({url:match[1],pid:child.pid,home,startedAt:new Date().toISOString()}),{mode:0o600}); buffer='';}
 process.stdout.write(data.toString().replace(/token=[^\s]+/g,'token=<local-token-hidden>'));
});
child.stderr.pipe(process.stderr);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',code=>{process.exitCode=code??1;});
