const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const audio=require('../frontend/handsfree-audio.js');
function harness() {
 const elements=new Map(),sent=[],spoken=[],timers=[],requests=[];let socket,node,clock=10000,reportSpeech;
 const tracks=[{readyState:'live',stop(){}},{readyState:'live',stop(){},getSettings(){return {echoCancellation:true,noiseSuppression:true};}}];
 const stream={getTracks:()=>tracks,getVideoTracks:()=>[tracks[0]],getAudioTracks:()=>[tracks[1]]};
 const el=id=>{if(!elements.has(id))elements.set(id,{hidden:false,handlers:{},addEventListener(k,fn){this.handlers[k]=fn;},play:async()=>{},videoWidth:640,videoHeight:480,getContext:()=>({drawImage(){}}),toDataURL:()=> 'data:image/jpeg;base64,test'});return elements.get(id);};
 class Context {state='running';destination={};audioWorklet={addModule:async()=>{}};async resume(){this.state='running';}createMediaStreamSource(){return {connect(){},disconnect(){}};}}
 const context=vm.createContext({HandsfreeAudio:audio,parseIntent:require('../frontend/intent.js').parseIntent,URLSearchParams,AbortController,Blob,FormData,performance:{now:()=>clock},location:{search:'?session=test',protocol:'https:',host:'test'},document:{getElementById:el,createElement:el},window:{isSecureContext:true,AudioContext:Context,addEventListener(){}},navigator:{mediaDevices:{getUserMedia:async()=>stream}},
 AudioWorkletNode:class {constructor(){node=this;this.port={postMessage(){}};}connect(){}disconnect(){}},
 PhoneOrientation:class {enable(){}current(){return null;}},
 WayfinderSpeech:class {constructor(cb){reportSpeech=cb;}unlock(){}stop(){}speak(text){spoken.push(text);}},
 WebSocket:class {static OPEN=1;readyState=1;bufferedAmount=0;constructor(){socket=this;}send(text){sent.push(JSON.parse(text));}close(){this.onclose?.();}},
 setInterval(fn,ms){timers.push({fn,ms});},fetch:async(url,options)=>new Promise(resolve=>requests.push({url,options,resolve}))});
 vm.runInContext(fs.readFileSync('frontend/feedback.js','utf8').replace("typeof window!=='undefined'?window:globalThis","globalThis"),context);
 vm.runInContext(fs.readFileSync('frontend/handsfree.js','utf8')+'\nglobalThis.state=hf;globalThis.id=streamId;',context);
 return {sent,spoken,requests,tracks,elements,state:context.state,id:context.id,
 message:msg=>socket.onmessage({data:JSON.stringify(msg)}),enable:()=>el('allow-permissions').handlers.click(),
 clip(){node.port.onmessage({data:{type:'clip',samples:new Float32Array(16000),rate:16000}});},
 async reply(text){requests.shift().resolve({ok:true,json:async()=>({text})});await new Promise(setImmediate);},
 tick(ms){clock+=ms;timers.forEach(t=>t.fn());},block(){reportSpeech('blocked','test');},disconnect(){socket.onclose();}};
}
async function ready(){const h=harness();h.message({type:'peer_status',connected:true});await h.enable();return h;}
test('hands-free becomes empty after setup; mic runs while paused; nearby conversation does not listen or interrupt',async()=>{
 const h=await ready();assert.equal(h.elements.get('setup').hidden,true);assert.equal(h.state.running,false);
 h.clip();await h.reply('we should get lunch');assert.equal(h.spoken.length,0);assert.equal(h.sent.some(m=>m.type==='listening'&&m.active),false);assert.equal(h.sent.some(m=>m.type==='transcript'),false);
 h.clip();await h.reply('Hey Wayfinder could we find the red cup');assert.equal(h.sent.find(m=>m.type==='transcript').text,'could we find the red cup');
});
test('wake-only and clarification windows acknowledge before prompting and expire',async()=>{
 const h=await ready();h.clip();await h.reply('Hey Way Finder');assert.equal(h.spoken.length,0);assert.ok(h.sent.some(m=>m.type==='listening'&&m.active));
 h.message({type:'stop_speech'});assert.equal(h.spoken.at(-1),'Listening.');h.tick(8100);assert.equal(h.state.window,false);
 h.message({type:'guidance',text:'Which item?'});h.message({type:'stop_speech'});assert.equal(h.spoken.at(-1),'Which item?');
 h.tick(1100);h.clip();await h.reply('small red cup');assert.equal(h.sent.filter(m=>m.type==='transcript').at(-1).text,'small red cup');
});
test('permission loss and audio blocking restore setup and pause; disconnected STT cannot execute',async()=>{
 const h=await ready();h.clip();h.disconnect();await h.reply('Hey Wayfinder resume');assert.equal(h.sent.some(m=>m.type==='transcript'),false);assert.equal(h.elements.get('setup').hidden,false);
 const second=await ready();second.block();assert.equal(second.elements.get('setup').hidden,false);assert.ok(second.sent.some(m=>m.type==='control'&&m.action==='pause'));
 const third=await ready();third.tracks[0].onended();assert.equal(third.state.ready,false);
});
test('hazards interrupt command windows and reject earlier transcription',async()=>{
 const h=await ready();h.message({type:'session_state',running:true,revision:3});h.clip();await h.reply('hey wayfinder');h.message({type:'stop_speech'});h.clip();
 h.message({type:'hazard',id:'3:1',revision:3,stream:h.id,expiresAt:null,priority:0,key:'chair',stage:'HOLD',text:'Stop. Chair ahead.'});
 assert.equal(h.spoken.at(-1),'Stop. Chair ahead.');assert.equal(h.state.window,false);await h.reply('resume');assert.equal(h.sent.some(m=>m.type==='transcript'),false);
});
