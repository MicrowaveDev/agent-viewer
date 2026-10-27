import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('Grok API export, chunks and live source transitions', { timeout: 20000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-grok-api-'));
  const dir = path.join(home, '.grok', 'sessions', 'project', 'session');
  fs.mkdirSync(dir, { recursive: true });
  const history = path.join(dir, 'chat_history.jsonl');
  const updates = path.join(dir, 'updates.jsonl');
  fs.writeFileSync(history, JSON.stringify({type:'user',content:'Fixture prompt'})+'\n');
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env: {...process.env, HOME:home, GROK_HOME:path.join(home,'.grok'), PORT:'0'}, stdio:['ignore','pipe','pipe'] });
  let copyPath;
  let reader;
  try {
    const base = await new Promise((resolve, reject) => {
      let output='';
      child.stdout.on('data', chunk => { output += chunk; const match=output.match(/running at (http:\/\/localhost:\d+)/); if(match)resolve(match[1]); });
      child.on('error',reject);
      child.on('exit', code => reject(new Error('Server exited '+code)));
    });
    const {files}=await (await fetch(base+'/api/files')).json();
    assert.equal(files.length,1);
    const id=files[0].id;
    assert.equal(files[0].source,'grok');
    assert.equal(files[0].promptPreview,'Fixture prompt');
    const content=await (await fetch(base+'/api/files/'+id)).json();
    const chunk=await (await fetch(base+'/api/files/'+id+'/chunk?limit=1024')).json();
    assert.equal(chunk.content.trim(),content.content.trim());
    assert.equal(chunk.done,true);
    const copy=await (await fetch(base+'/api/files/'+id+'/temp-copy',{method:'POST'})).json();
    copyPath=copy.tempPath;
    assert.equal(fs.readFileSync(copyPath,'utf8'),content.content);
    const response=await fetch(base+'/api/events');
    reader=response.body.getReader();
    let pending='';
    async function nextEvent(name) {
      while(true) {
        const end=pending.indexOf('\n\n');
        if(end<0) { const {value,done}=await reader.read(); assert.equal(done,false); pending+=new TextDecoder().decode(value); continue; }
        const event=pending.slice(0,end);pending=pending.slice(end+2);
        if(event.startsWith('event: '+name+'\n')) return JSON.parse(event.split('\ndata: ')[1]);
      }
    }
    await nextEvent('init');
    // Let chokidar complete its initial directory subscription.
    await new Promise(resolve=>setTimeout(resolve,250));
    fs.appendFileSync(history,JSON.stringify({type:'assistant',content:'Fixture answer'})+'\n');
    const append=await nextEvent('file-update');
    assert.match(append.content,/Fixture answer/);
    fs.writeFileSync(history,JSON.stringify({type:'user',content:'Reset'})+'\n');
    const reset=await nextEvent('file-update');
    assert.equal(reset.contentReset,true);
    assert.match(reset.content,/Reset/);
    fs.writeFileSync(updates,JSON.stringify({params:{sessionId:'session',update:{sessionUpdate:'user_message_chunk',content:{type:'text',text:'ACP prompt'}}}})+'\n');
    const switchEvent=await nextEvent('file-update');
    assert.equal(switchEvent.id,id);
    assert.equal(switchEvent.filename,'updates.jsonl');
    assert.equal(switchEvent.contentSkipped,true);
    assert.equal(switchEvent.contentReset,true);
    fs.unlinkSync(updates);
    const fallback=await nextEvent('file-update');
    assert.equal(fallback.filename,'chat_history.jsonl');
    fs.unlinkSync(history);
    assert.equal((await nextEvent('file-removed')).id,id);
  } finally {
    await reader?.cancel();
    const exited=once(child,'exit'); child.kill(); await exited;
    if(copyPath)fs.rmSync(copyPath,{force:true});
    fs.rmSync(home,{recursive:true,force:true});
  }
});
