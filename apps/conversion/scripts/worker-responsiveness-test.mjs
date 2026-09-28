import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { convertDocumentInWorker } from '../dist/convert-in-worker.js';
import { ConversionQueue } from '../dist/queue.js';
import { createConversionServer } from '../dist/server.js';
import { synthMultiPagePdf } from './failure-fixtures.mjs';

const root = mkdtempSync(join(tmpdir(), 'cunote-worker-test.'));
const jobs = join(root, 'jobs'); mkdirSync(jobs);
const oldTmp = process.env.TMPDIR, oldRenderer = process.env.PDFTOPPM_BIN;
const realRenderer = spawnSync('which', ['pdftoppm'], { encoding: 'utf8' }).stdout.trim();
assert.ok(realRenderer, 'pdftoppm required');
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const marker = join(root, 'render-started');
const renderer = join(root, 'slow-render');
writeFileSync(renderer, `#!/bin/sh\ntouch ${quote(marker)}\nsleep 3\nexec ${quote(realRenderer)} "$@"\n`, {mode:0o700});
process.env.TMPDIR = jobs; process.env.PDFTOPPM_BIN = renderer;
const body = synthMultiPagePdf();
const uploaded = [];
const storage = { async putObject({key}) { assert.ok(readdirSync(jobs).length); uploaded.push(key); return {key,url:`stub://${key}`}; }, async getObjectText(){return '';}, publicUrl(key){return `stub://${key}`;} };
const queue = new ConversionQueue({ storage, concurrency:2, fetchSource:async()=>body, convertDocument:convertDocumentInWorker });
const server = createConversionServer({queue,sharedSecret:'local-fixture'});
try {
 server.listen(0,'127.0.0.1'); await once(server,'listening');
 const base = `http://127.0.0.1:${server.address().port}`;
 const headers = {'x-shared-secret':'local-fixture','content-type':'application/json'};
 for (const id of ['first','second','queued']) {
  const response = await fetch(base+'/v1/conversion-jobs',{method:'POST',headers,body:JSON.stringify({jobId:id,source:'bizinfo',sourceId:id,filename:'fixture.pdf',sourceObjectUrl:'stub://fixture',sha256:createHash('sha256').update(body).digest('hex')})});
  assert.equal(response.status,202);
 }
 const deadline=Date.now()+10000;
 while(!existsSync(marker)&&Date.now()<deadline) await new Promise(r=>setTimeout(r,10));
 assert.ok(existsSync(marker),'real synchronous renderer must be running');
 const started=performance.now();
 const response=await fetch(base+'/v1/conversion-jobs/first',{headers,signal:AbortSignal.timeout(1000)});
 assert.equal(response.status,200);assert.equal((await response.json()).status,'running');
 const elapsed=performance.now()-started;assert.ok(elapsed<1000,`status blocked for ${elapsed}ms`);
 assert.equal((await (await fetch(base+'/v1/conversion-jobs/queued',{headers})).json()).status,'queued');
 await queue.drain();
 assert.equal(queue.peakActive,2);assert.ok(uploaded.length>0);
 for(const id of ['first','second','queued']) {const record=queue.get(id);assert.ok(['succeeded','partial'].includes(record.status));assert.equal(record.sourceSha256,createHash('sha256').update(body).digest('hex'));assert.ok(record.artifacts.length);}
 assert.deepEqual(readdirSync(jobs),[]);
 // Uncaught errors and silent/nonzero exits must settle the queue and clean its directory.
 for(const [name,code,pattern] of [['throw',"throw new Error('fixture crash')",/fixture crash/],['exit',"process.exit(2)",/code 2/],['silent',"process.exit(0)",/without a result/]]) {
  const fixture=join(root,`${name}.mjs`);writeFileSync(fixture,code);
  const bad=new ConversionQueue({storage,fetchSource:async()=>body,convertDocument:(input)=>convertDocumentInWorker(input,pathToFileURL(fixture))});
  bad.enqueue({jobId:name,source:'bizinfo',sourceId:name,filename:'fixture.pdf',sourceObjectUrl:'stub://fixture',sha256:createHash('sha256').update(body).digest('hex')});
  await bad.drain();assert.equal(bad.get(name).status,'failed');assert.match(bad.get(name).error,pattern);assert.equal(bad.active,0);assert.deepEqual(readdirSync(jobs),[]);
 }
 console.log(JSON.stringify({ok:true,statusLatencyMs:Math.round(elapsed),blockingRendererMs:3000,concurrency:queue.peakActive,workerFailureCases:3,cleanup:true}));
} finally {
 await queue.drain();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
 if(oldTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=oldTmp;
 if(oldRenderer===undefined)delete process.env.PDFTOPPM_BIN;else process.env.PDFTOPPM_BIN=oldRenderer;
 rmSync(root,{recursive:true,force:true});
}
