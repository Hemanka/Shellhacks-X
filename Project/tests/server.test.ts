import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';
import type { ServerMessage, Snapshot } from '../shared/protocol.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function unusedPort():Promise<number>{const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const port=(s.address() as {port:number}).port;await new Promise<void>((r,j)=>s.close(e=>e?j(e):r()));return port;}
async function rejectedSocket(url:string,origin:string,cookie?:string):Promise<number>{return new Promise((resolve,reject)=>{
 const ws=new WebSocket(url,{origin,headers:cookie?{Cookie:cookie}:{}});const timeout=setTimeout(()=>{ws.terminate();reject(Error('WebSocket rejection timeout'));},3000);
 ws.on('error',()=>{});ws.on('unexpected-response',(_req,res)=>{clearTimeout(timeout);resolve(res.statusCode??0);res.destroy();});
 ws.on('open',()=>{clearTimeout(timeout);ws.close();reject(Error('Unauthorized WebSocket opened'));});
});}
test('real server automatic session, WebSocket origin checks, revision controls and malformed messages', {timeout:15000}, async t=>{
 const port=await unusedPort();const base=`http://127.0.0.1:${port}`,socketUrl=`ws://127.0.0.1:${port}/stream`;
 const child=spawn(process.execPath,['--import','tsx','server/index.ts'],{cwd:root,env:{...process.env,PORT:String(port),ELEVENLABS_API_KEY:'',ELEVENLABS_VOICE_ID:''},stdio:'ignore'});
 let ws:WebSocket|undefined;
 t.after(async()=>{ws?.terminate();child.kill();await Promise.race([new Promise<void>(r=>child.once('close',()=>r())),new Promise<void>(r=>setTimeout(r,1000))]);});
 let up=false;
 for(let i=0;i<50;i++){try{const response=await fetch(`${base}/api/health`);if(response.ok){up=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
 assert.equal(up,true,'Isolated server should become ready');
 const health=await (await fetch(`${base}/api/health`)).json();assert.deepEqual(Object.keys(health),['configured']);assert.equal(typeof health.configured,'boolean');
 assert.equal(await rejectedSocket(socketUrl,base),403);
 const unauthorizedSpeech=await fetch(`${base}/api/speech`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'Turn right.'})});assert.equal(unauthorizedSpeech.status,401);
 const session=await fetch(`${base}/api/session`,{method:'POST'});assert.equal(session.status,200,'Automatic session should succeed');
 const setCookie=session.headers.get('set-cookie')||'';assert.equal(setCookie.includes('HttpOnly'),true);assert.equal(setCookie.includes('SameSite=Strict'),true);const cookie=setCookie.split(';')[0];
 assert.equal(await rejectedSocket(socketUrl,'https://other-origin.invalid',cookie),403);
 const missingVoice=await fetch(`${base}/api/speech`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({text:'Turn right.'})});assert.equal(missingVoice.status,503);
 ws=new WebSocket(socketUrl,{origin:base,headers:{Cookie:cookie}});
 const messages:ServerMessage[]=[];ws.on('message',data=>messages.push(JSON.parse(data.toString()) as ServerMessage));
 await new Promise<void>((r,j)=>{ws!.once('open',r);ws!.once('error',j);});
 const state=async(revision:number,phase:string):Promise<Snapshot>=>{for(let i=0;i<50;i++){const m=messages.find((m):m is Extract<ServerMessage,{type:'state'}>=>m.type==='state'&&m.state.revision===revision&&m.state.phase===phase);if(m)return m.state;await new Promise(r=>setTimeout(r,20));}throw Error('Expected revision/phase was not published');};
 assert.equal((await state(0,'searching')).target,null);
 ws.send(JSON.stringify({type:'start',query:'red cup',hand:'left'}));assert.equal((await state(1,'searching')).command?.action,'STOP');
 // Old-revision frames are discarded before image decoding; no visual/API request occurs.
 ws.send(JSON.stringify({type:'frame',id:0,revision:0,capturedAt:0,jpeg:'not-an-image'}));
 ws.send(JSON.stringify({type:'pause'}));assert.equal((await state(2,'paused')).metrics.visualCalls,0);
 ws.send(JSON.stringify({type:'resume'}));assert.equal((await state(3,'searching')).command?.action,'STOP');
 ws.send(JSON.stringify({type:'found'}));assert.equal((await state(4,'complete')).command?.action,'COMPLETE');
 ws.send(JSON.stringify({type:'another'}));assert.equal((await state(5,'searching')).target,null);
 ws.send(JSON.stringify({type:'start',query:'',hand:'left'}));const invalid=await state(6,'paused');assert.equal(invalid.command?.action,'STOP');assert.equal(invalid.metrics.visualCalls,0);
 assert.equal(messages.some(m=>m.type==='error'),true);
});
