/* Only the phone's monotonic clock decides whether a cue may still play. */
(function(root) {
  class PhoneFeedback {
    constructor(speech,report=()=>{},display=()=>{},interrupt=()=>{}) {
      this.speech=speech; this.report=report; this.display=display; this.interrupt=interrupt;
      this.revision=0; this.seen=new Set(); this.queue=null; this.active=null; this.stream=null; this.context=null;
      this.timer=setInterval(()=>this.tick(),100);
    }
    unlock() {
      try { const Context=root.AudioContext || root.webkitAudioContext; if(Context) { this.context ||= new Context(); this.context.resume().catch(()=>{}); } } catch {}
      this.report('haptics',typeof navigator.vibrate==='function'?'available (device feedback unverified)':'unavailable; warning tone fallback');
    }
    tone() {
      try {
        if (!this.context || this.context.state!=='running') { this.report('feedback','Warning tone blocked; enable audio'); return; }
        const oscillator=this.context.createOscillator(), gain=this.context.createGain();
        oscillator.frequency.value=660; gain.gain.value=.12; oscillator.connect(gain); gain.connect(this.context.destination);
        oscillator.start(); oscillator.stop(this.context.currentTime+.25);
        oscillator.onended=()=>{oscillator.disconnect();gain.disconnect();};
      } catch { this.report('feedback','Warning tone unavailable'); }
    }
    warning() {
      let accepted=false; try { accepted=typeof navigator.vibrate==='function' && navigator.vibrate([200,100,200]); } catch {}
      this.report('haptics',accepted?'vibration request accepted (not physically verified)':'tone fallback');
      if (!accepted) this.tone();
    }
    cancel() { this.queue=null; this.active=null; this.speech.stop(); try { navigator.vibrate?.(0); } catch {} }
    session(revision,stream,running) {
      if (revision!==this.revision || stream!==this.stream || !running) this.cancel();
      if (revision!==this.revision || stream!==this.stream) this.seen.clear();
      this.revision=revision; this.stream=stream; this.running=running;
    }
    valid(cue) { return cue && (this.running || cue.stage==='COMPLETE') && cue.stream===this.stream && cue.revision===this.revision && (cue.expiresAt===null || cue.expiresAt>performance.now()); }
    accept(cue) {
      if (!this.valid(cue) || this.seen.has(cue.id)) { this.report('suppressed','Expired, duplicate, or old-session instruction'); return; }
      this.seen.add(cue.id); if(this.seen.size>200) this.seen.delete(this.seen.values().next().value);
      this.display(cue); this.queue=null;
      if(cue.type==='hazard') { this.interrupt(); this.warning(); }
      const sameAction=this.active?.key===cue.key;
      const ordinary=this.active && this.speech.busy && cue.priority>1 && sameAction;
      if (ordinary) { this.queue=cue; return; }
      this.play(cue);
    }
    play(cue) { if (!this.valid(cue)) return; this.active=cue; this.speech.speak(cue.text,()=>this.valid(cue) && this.active?.id===cue.id); }
    tick() {
      if (this.active && !this.valid(this.active) && !this.speech.playing) { this.speech.stop(); this.active=null; try { navigator.vibrate?.(0); } catch {} }
      if(this.queue && !this.speech.busy) {const cue=this.queue;this.queue=null;this.play(cue);}
    }
    repeat() {
      if(this.valid(this.active)) this.play(this.active);
      else this.report('suppressed','Instruction expired; wait for a fresh view');
    }
  }
  root.PhoneFeedback=PhoneFeedback;
  if(typeof module!=='undefined') module.exports={PhoneFeedback};
})(typeof window!=='undefined'?window:globalThis);
