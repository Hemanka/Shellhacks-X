const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
function harness(vibration=true) {
 let now=1000,interrupts=0;const reports=[],buzz=[],spoken=[],tones=[];
 const speech={busy:false,stop(){this.busy=false;},speak(text,valid){if(valid()){spoken.push(text);this.busy=true;}}};
 const context={window:{},navigator:{...(vibration?{vibrate:p=>{buzz.push(p);return true;}}:{})},performance:{now:()=>now},setInterval(){}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../frontend/feedback.js'),'utf8'),context);
 const f=new context.window.PhoneFeedback(speech,(...r)=>reports.push(r),()=>{},()=>interrupts++);
 f.session(1,'s',true);f.tone=()=>tones.push('tone');
 const cue=(overrides={})=>({type:'hazard',id:'1',revision:1,stream:'s',expiresAt:4000,priority:0,key:'chair',text:'Stop—chair ahead.',stage:'HOLD',...overrides});
 return {f,speech,reports,buzz,spoken,tones,cue,interrupts:()=>interrupts,advance:ms=>now+=ms};
}
test('hazard vibrates immediately, interrupts input, and names obstacle',()=>{const h=harness();h.f.accept(h.cue());assert.equal(h.interrupts(),1);assert.deepEqual(Array.from(h.buzz.at(-1)),[200,100,200]);assert.match(h.spoken[0],/chair/);});
test('unsupported vibration uses local tone without preventing speech',()=>{const h=harness(false);h.f.accept(h.cue());assert.equal(h.tones.length,1);assert.equal(h.spoken.length,1);});
test('duplicates, expired cues and wrong session cannot play',()=>{const h=harness();h.f.accept(h.cue());h.f.accept(h.cue());h.f.accept(h.cue({id:'2',revision:0}));h.advance(4000);h.f.accept(h.cue({id:'3'}));assert.equal(h.spoken.length,1);});
test('pause and stream changes invalidate pending audio',()=>{const h=harness();h.f.accept(h.cue());h.f.session(1,'s',false);h.f.accept(h.cue({id:'2'}));assert.equal(h.spoken.length,1);h.f.session(1,'new',true);h.f.accept(h.cue({id:'3'}));assert.equal(h.spoken.length,1);});
test('ordinary duplicate actions queue at most one and cannot replay expired',()=>{const h=harness();h.f.accept(h.cue({type:'guidance',priority:2}));h.f.accept(h.cue({type:'guidance',priority:2,id:'2'}));assert.equal(h.spoken.length,1);h.advance(4000);h.f.tick();h.f.repeat();assert.equal(h.spoken.length,1);});
test('new hazard cancels queued ordinary guidance',()=>{const h=harness();h.f.accept(h.cue({type:'guidance',priority:2}));h.f.accept(h.cue({type:'guidance',priority:2,id:'2'}));h.f.accept(h.cue({id:'3',key:'table',text:'Stop—table edge.'}));assert.equal(h.f.queue,null);assert.match(h.spoken.at(-1),/table/);});

test('incremental cue survives slow speech preparation but pause still cancels it',()=>{
 const h=harness();h.f.accept(h.cue({expiresAt:null}));h.advance(60000);
 assert.equal(h.f.valid(h.f.active),true);h.f.session(1,'s',false);assert.equal(h.f.active,null);
});

test('found finishes before next routine cue while hazards interrupt immediately',()=>{
 const h=harness();h.f.accept(h.cue({type:'guidance',key:'target-found',priority:2,text:'Cup found.',expiresAt:null}));
 h.f.accept(h.cue({id:'2',type:'guidance',key:'route:FORWARD',priority:2,text:'Short step forward.',expiresAt:null}));
 assert.equal(h.spoken.length,1);assert.equal(h.f.queue.id,'2');
 h.f.accept(h.cue({id:'3',key:'route:obstacle',text:'Stop. Chair ahead.'}));assert.equal(h.f.queue,null);assert.equal(h.spoken.at(-1),'Stop. Chair ahead.');
});
