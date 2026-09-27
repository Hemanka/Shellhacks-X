const test=require('node:test'),assert=require('node:assert/strict');
const {VoiceGate,Segmenter,wav,ClipQueue}=require('../frontend/handsfree-audio.js');
const {parseIntent}=require('../frontend/intent.js');
test('wake is anchored, normalized, and accepts both spellings',()=>{
 const gate=new VoiceGate();
 for(const text of ['Hey Wayfinder, could we find the red cup?','HEY WAY FINDER! Could we find the red cup']) assert.deepEqual(parseIntent(gate.accept(text,100).text),{type:'target',target:'red cup'});
 for(const text of ['find the cup','they said hey wayfinder pause','hello there'])assert.equal(gate.accept(text,100).kind,'ignored');
 assert.equal(gate.accept('Hey Wayfinder find the right-hand door',100).text,'find the right-hand door');
 for(const command of ['pause','resume','repeat','got it','lost it','too far'])assert.equal(parseIntent(gate.accept('Hey Wayfinder '+command,100).text).type,'command');
});
test('one response window expires and echoes never consume it',()=>{
 const gate=new VoiceGate();assert.equal(gate.accept('Hey Wayfinder',0).kind,'wake');gate.open(100);
 gate.remember('Short step forward.',100);assert.equal(gate.accept('short step forward',200).kind,'echo');
 assert.equal(gate.accept('red cup',8000).kind,'command');assert.equal(gate.accept('blue cup',8001).kind,'ignored');
 gate.open(100);assert.equal(gate.accept('red cup',8200).kind,'ignored');
 assert.equal(gate.accept('red cup',9000,7000).kind,'command'); // latency does not erase an utterance made inside the window
});
test('silence and short transients produce no clips; speech includes pre-roll and trailing silence',()=>{
 const clips=[],segment=new Segmenter(16000,x=>clips.push(x));const feed=(seconds,amplitude)=>{for(let i=0;i<seconds*100;i++)segment.process(new Float32Array(160).fill(amplitude));};
 feed(2,0);feed(.1,.1);feed(1,0);assert.equal(clips.length,0);
 feed(.5,.1);feed(.7,0);assert.equal(clips.length,1);assert.ok(clips[0].length>=16000*1.4);assert.ok(clips[0].length<=16000*1.51);
 feed(9,.1);assert.equal(clips[1].length,128000);
});
test('WAV is complete mono signed PCM at 16kHz',()=>{
 const data=new DataView(wav(new Float32Array(48000).fill(.5),48000));
 assert.equal(data.byteLength,32044);assert.equal(data.getUint32(24,true),16000);assert.equal(data.getUint16(22,true),1);assert.equal(data.getUint16(34,true),16);assert.equal(data.getUint32(40,true),32000);assert.equal(data.getInt16(44,true),16383);
});
test('queue bounds work and invalidation rejects in-flight and pending results',async()=>{
 const resolvers=[],started=[],results=[];let drops=0;
 const queue=new ClipQueue(clip=>{started.push(clip);return new Promise(resolve=>resolvers.push(resolve));},result=>results.push(result),()=>drops++);
 queue.push(1);queue.push(2);queue.push(3);assert.equal(drops,1);assert.deepEqual(started,[1]);
 resolvers.shift()(1);await new Promise(setImmediate);assert.deepEqual(started,[1,2]);
 queue.push(4);queue.clear();resolvers.shift()(2);await new Promise(setImmediate);assert.deepEqual(results,[1]);assert.deepEqual(started,[1,2]);
 queue.push(5);resolvers.shift()(5);await new Promise(setImmediate);assert.deepEqual(results,[1,5]);
});
