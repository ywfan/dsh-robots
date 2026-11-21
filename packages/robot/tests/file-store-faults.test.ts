import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const fault = vi.hoisted(() => ({ write: false, fileSync: false, fileClose: false, rename: false, directorySync: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real, rename: async (...args: Parameters<typeof real.rename>) => {
    if (fault.rename) throw new Error('injected rename failure');
    return real.rename(...args);
  }, open: async (...args: Parameters<typeof real.open>) => {
    const handle = await real.open(...args), path = String(args[0]);
    return new Proxy(handle, { get(target, key) {
      if (key === 'writeFile') return async (...values: Parameters<typeof handle.writeFile>) => { if (fault.write && path.endsWith('.tmp')) { fault.write = false; throw new Error('injected write failure'); } return handle.writeFile(...values); };
      if (key === 'sync') return async () => {
        if (fault.fileSync && path.endsWith('.tmp')) { fault.fileSync = false; throw new Error('injected file fsync failure'); }
        if (fault.directorySync && path.endsWith('/robots')) { fault.directorySync = false; throw new Error('injected directory fsync failure'); }
        return handle.sync();
      };
      if (key === 'close' && path.endsWith('.tmp')) return async () => {
        await handle.close();
        if (fault.fileClose) throw new Error('injected file close failure');
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
});
import { FileRobotStore } from '../src/storage/file-store.js';
import { RobotCatalog, type RobotSpec } from '../src/domain/index.js';
const principal={id:'owner',kind:'human' as const};
const spec:RobotSpec={name:'before',purpose:'test durable writes',instructions:'fixture',model:{provider:'fixture',model:'fixture'},resources:[],requiredCapabilities:[],externalActions:[],workflow:{entry:'one',steps:[{id:'one',title:'one',instruction:'fixture',skillIds:[],allowedActions:[],checks:[],transitions:{done:null},maxVisits:1}]}};
let directory:string,store:FileRobotStore,catalog:RobotCatalog;
beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'robot-faults-'));store=await FileRobotStore.open(directory);catalog=new RobotCatalog(store);});
afterEach(async()=>{await store.close();await rm(directory,{recursive:true,force:true});for (const key of Object.keys(fault) as (keyof typeof fault)[]) fault[key]=false;});
for(const failure of ['write','fileSync','fileClose','rename'] as const)it(`cleans temporary files after ${failure} failure and retains the previous revision`,async()=>{
  const robot=await catalog.createRobot(principal,spec),candidate=await catalog.preparePublication(principal,robot.robot.id);
  const revision=await catalog.publish(principal,robot.robot.id,candidate,{digest:candidate.digest,capabilities:[],checkedAt:new Date().toISOString()});
  const before=await catalog.getRobot(principal,robot.robot.id);fault[failure]=true;
  await expect(catalog.saveDraft(principal,robot.robot.id,before.draft.editVersion,{...spec,name:'failed write'})).rejects.toThrow('injected');
  fault[failure]=false;
  expect((await readdir(join(directory,'robots'))).filter(name=>name.endsWith('.tmp'))).toEqual([]);
  const after=await catalog.getRobot(principal,robot.robot.id);expect(after.revisions[0]).toEqual(revision);expect(after.draft.spec.name).toBe('before');expect(after.robot.version).toBe(before.robot.version);
  await catalog.saveDraft(principal,robot.robot.id,before.draft.editVersion,{...spec,name:'successful retry'});expect((await catalog.getRobot(principal,robot.robot.id)).draft.spec.name).toBe('successful retry');
});

it('removes abandoned temporary records only after acquiring the writer lock', async () => {
  const robot = await catalog.createRobot(principal, spec);
  const records = join(directory, 'robots');
  const abandoned = `${robot.robot.id}.json.4e96f1b0-16b3-41d0-aa78-63fd286bb194.tmp`;
  await writeFile(join(records, abandoned), 'interrupted write');
  await writeFile(join(records, 'unrelated.tmp'), 'leave intact');

  await expect(FileRobotStore.open(directory)).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(await readdir(records)).toContain(abandoned);
  await store.close();

  store = await FileRobotStore.open(directory);
  expect((await readdir(records)).sort()).toEqual([`${robot.robot.id}.json`, 'unrelated.tmp'].sort());
  expect(await store.readRobot(robot.robot.id)).toEqual(robot);
});
it('reports ambiguous durability after rename instead of claiming the write did not happen',async()=>{
  const robot=await catalog.createRobot(principal,spec);fault.directorySync=true;
  await expect(catalog.saveDraft(principal,robot.robot.id,robot.draft.editVersion,{...spec,name:'renamed before fsync error'})).rejects.toMatchObject({code:'COMMIT_UNCERTAIN'});
  const current=await catalog.getRobot(principal,robot.robot.id);expect(current.draft.spec.name).toBe('renamed before fsync error');expect(current.robot.version).toBe(robot.robot.version+1);
  expect((await readdir(join(directory,'robots'))).filter(name=>name.endsWith('.tmp'))).toEqual([]);
  await expect(catalog.saveDraft(principal,robot.robot.id,robot.draft.editVersion,{...spec,name:'blind retry'})).rejects.toMatchObject({code:'CONFLICT'});
});
