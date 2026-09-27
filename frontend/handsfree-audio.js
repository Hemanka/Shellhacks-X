(function(root) {
  const normalize = text => String(text || '').toLowerCase().replace(/[^a-z0-9' ]/g,' ').replace(/\s+/g,' ').trim();
  class VoiceGate {
    constructor() { this.until=0; this.recent=[]; }
    remember(text,now) { this.recent.push({text:normalize(text),at:now}); this.recent=this.recent.slice(-12); }
    open(now) { this.until=now+8000; }
    accept(text,now,eligibleAt=now) {
      const normalized=normalize(text);
      const echo=this.recent.some(item=>{
        if(now-item.at>=30000)return false;
        const words=normalized.split(' '), spoken=new Set(item.text.split(' '));
        const shared=words.filter(word=>spoken.has(word)).length;
        return normalized===item.text || (normalized.length>12 && item.text.includes(normalized)) ||
          (words.length>=3 && shared/words.length>=.8 && shared/spoken.size>=.8);
      });
      if(echo) return {kind:'echo'};
      const wake=/^hey way\s?finder\b\s*/.exec(normalized);
      if(!wake && !(eligibleAt<this.until && this.until>0)) return {kind:'ignored'};
      this.until=0;
      // Preserve the accepted wording (including distinguishing hyphens) for the intent parser.
      const raw=String(text || '').trim();
      const command=wake?raw.replace(/^hey[^a-z0-9']+way[^a-z0-9']*finder\b[^a-z0-9']*/i,'').trim():raw;
      return command ? {kind:'command',text:command} : {kind:'wake'};
    }
  }
  class Segmenter {
    constructor(rate,onClip,onActivity=()=>{}) { this.rate=rate;this.onClip=onClip;this.onActivity=onActivity;this.reset(); }
    reset() { this.calibration=0;this.noise=.002;this.pre=[];this.preSize=0;this.parts=[];this.size=0;this.active=false;this.loud=0;this.silent=0;this.lastState=''; }
    process(input) {
      const block=new Float32Array(input), n=block.length;
      const rms=Math.sqrt(block.reduce((sum,x)=>sum+x*x,0)/n);
      if(this.calibration<this.rate) { this.noise=this.noise*.95+rms*.05;this.calibration+=n;this.status('calibrating');return; }
      const loud=rms>Math.max(.008,this.noise*3);
      if(!this.active && !loud) this.noise=this.noise*.995+rms*.005;
      if(!this.active) {
        // Keep 300 ms before the 200 ms sustained onset confirmation.
        this.pre.push(block);this.preSize+=n;
        while(this.preSize>this.rate*.5 && this.pre.length>1) this.preSize-=this.pre.shift().length;
        this.loud=loud?this.loud+n:0;
        this.status(loud?'activity':'quiet');
        if(this.loud<this.rate*.2) return;
        this.active=true;this.parts=this.pre;this.size=this.preSize;this.pre=[];this.preSize=0;
      } else { this.parts.push(block);this.size+=n; }
      this.status('recording');this.silent=loud?0:this.silent+n;
      if(this.silent>=this.rate*.7 || this.size>=this.rate*8) {
        const clip=new Float32Array(Math.min(this.size,this.rate*8));let offset=0;
        for(const part of this.parts) { const count=Math.min(part.length,clip.length-offset);if(count<=0)break;clip.set(part.subarray(0,count),offset);offset+=count; }
        this.parts=[];this.size=0;this.active=false;this.loud=0;this.silent=0;
        this.onClip(clip);this.status('quiet');
      }
    }
    status(value) { if(value!==this.lastState) {this.lastState=value;this.onActivity(value);} }
  }
  function wav(samples,rate) {
    const count=Math.floor(samples.length*16000/rate), buffer=new ArrayBuffer(44+count*2), view=new DataView(buffer);
    const text=(at,value)=>{for(let i=0;i<value.length;i++)view.setUint8(at+i,value.charCodeAt(i));};
    text(0,'RIFF');view.setUint32(4,36+count*2,true);text(8,'WAVE');text(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);text(36,'data');view.setUint32(40,count*2,true);
    for(let i=0;i<count;i++) {
      // Average each source interval to reduce aliasing when downsampling.
      const start=Math.floor(i*rate/16000),end=Math.max(start+1,Math.floor((i+1)*rate/16000));let sum=0;
      for(let j=start;j<end;j++)sum+=samples[Math.min(j,samples.length-1)];
      const value=Math.max(-1,Math.min(1,sum/(end-start)));view.setInt16(44+i*2,value<0?value*32768:value*32767,true);
    }
    return buffer;
  }
  class ClipQueue {
    constructor(run,result,drop=()=>{},failure=()=>{}) {Object.assign(this,{run,result,drop,failure});this.epoch=0;this.busy=false;this.pending=null;}
    push(clip) { if(this.busy) {if(this.pending)this.drop();else this.pending=clip;return;}this.start(clip); }
    async start(clip) {
      this.busy=true;const epoch=this.epoch,controller=new AbortController();this.controller=controller;
      try {const result=await this.run(clip,controller.signal);if(epoch===this.epoch)this.result(result,clip);}
      catch(error) {if(epoch===this.epoch && error.name!=='AbortError')this.failure(error);}
      finally {this.busy=false;this.controller=null;const next=this.pending;this.pending=null;if(next)this.start(next);}
    }
    clear() {this.epoch++;this.pending=null;this.controller?.abort();}
  }
  root.HandsfreeAudio={VoiceGate,Segmenter,wav,ClipQueue};
  if(typeof module!=='undefined')module.exports=root.HandsfreeAudio;
})(globalThis);
