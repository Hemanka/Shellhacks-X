import './handsfree-audio.js';
class HandsfreeCapture extends AudioWorkletProcessor {
  constructor() {
    super();this.segmenter=new globalThis.HandsfreeAudio.Segmenter(sampleRate,
      samples=>this.port.postMessage({type:'clip',samples,rate:sampleRate},[samples.buffer]),
      activity=>this.port.postMessage({type:'activity',activity}));
    this.port.onmessage=()=>this.segmenter.reset();
  }
  process(inputs) {
    const channels=inputs[0];
    if(channels?.length) {
      const mono=new Float32Array(channels[0].length);
      for(const channel of channels)for(let i=0;i<mono.length;i++)mono[i]+=channel[i]/channels.length;
      this.segmenter.process(mono);
    }
    return true;
  }
}
registerProcessor('handsfree-capture',HandsfreeCapture);
