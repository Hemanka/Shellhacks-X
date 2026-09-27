/* Phone audio output. Keep one unlocked player and expose fallback causes. */
window.WayfinderSpeech = class {
  constructor(report = () => {}) {
    this.report = report; this.sequence = 0; this.audio = new Audio();
    this.url = null; this.request = null; this.cache = new Map(); this.busy = false;
  }
  stop() {
    this.sequence++; this.busy = false; this.playing = false;
    this.request?.abort(); this.request = null;
    window.speechSynthesis?.cancel();
    this.audio.pause(); this.audio.onended = null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
  unlock() {
    // Unlock the same HTML audio element that will play ElevenLabs responses.
    // Unlocking speechSynthesis does not unlock HTML audio on mobile browsers.
    if (this.url) { this.audio.play().catch(() => {}); return; }
    const wav = new Uint8Array(926), view = new DataView(wav.buffer);
    for (const [offset, value] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) {
      for (let i = 0; i < value.length; i++) wav[offset + i] = value.charCodeAt(i);
    }
    view.setUint32(4, 918, true); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 44100, true); view.setUint32(28, 88200, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, 882, true);
    const silentUrl = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    this.audio.src = silentUrl;
    this.audio.play().catch(() => {}).finally(() => URL.revokeObjectURL(silentUrl));
  }
  async speak(text, valid = () => true) {
    this.stop(); if (!valid()) return; this.busy = true; const sequence = this.sequence; const started = performance.now();
    this.request = new AbortController();
    this.report('requesting', 'Preparing ElevenLabs guidance');
    let phase = 'request';
    try {
      let blob = this.cache.get(text);
      if (!blob) {
        const response = await fetch('/api/speech', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }), signal: this.request.signal,
        });
        if (!response.ok) {
          let detail = '';
          try { detail = (await response.json()).detail || ''; } catch {}
          throw new Error(`Speech service returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
        }
        blob = await response.blob();
        if (sequence !== this.sequence) return;
        if (!valid()) { this.stop(); this.report('expired', 'Instruction expired before audio'); return; }
        this.cache.set(text, blob);
        if (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value);
      }
      if (sequence !== this.sequence) return;
        if (!valid()) { this.stop(); this.report('expired', 'Instruction expired before audio'); return; }
      phase = 'playback';
      this.url = URL.createObjectURL(blob); this.audio.src = this.url;
      this.audio.onended = () => {
        if (sequence !== this.sequence) return;
        if (!valid()) { this.stop(); this.report('expired', 'Instruction expired before audio'); return; }
        if (this.url) URL.revokeObjectURL(this.url);
        this.url = null; this.busy = false; this.playing = false; this.report('idle', 'ElevenLabs guidance finished');
      };
      await this.audio.play();
      if (sequence === this.sequence) { this.playing = true; this.report('playing', `ElevenLabs · ${Math.round(performance.now() - started)} ms to audio`); }
    } catch (error) {
      if (sequence !== this.sequence || error.name === 'AbortError') return;
      this.busy = false;
      if (!valid()) return;
      const reason = `ElevenLabs ${phase}: ${error.name || 'Error'} — ${error.message}`;
      if (error.name === 'NotAllowedError') {
        this.report('blocked', `${reason}. Tap Hear again to enable ElevenLabs audio.`);
        return;
      }
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = null;
      this.report('fallback', reason);
      if (!window.speechSynthesis) { this.report('blocked', reason); return; }
      // Retain emergency speech when the service/network/decoder is unavailable.
      const utterance = new SpeechSynthesisUtterance(text); utterance.rate = 1.05;
      utterance.onstart = () => { if (sequence === this.sequence) this.report('playing', `Browser voice fallback · ${reason}`); };
      utterance.onend = () => { if (sequence === this.sequence) this.report('idle', 'Browser fallback finished'); };
      utterance.onerror = () => { if (sequence === this.sequence) this.report('blocked', `${reason}. Browser voice also failed.`); };
      this.busy = true;
      const ended = utterance.onend; utterance.onend = () => { if(sequence===this.sequence) {this.busy = false; this.playing=false;} ended(); };
      const failed = utterance.onerror; utterance.onerror = () => { if(sequence===this.sequence) {this.busy = false; this.playing=false;} failed(); };
      window.speechSynthesis.speak(utterance);
    }
  }
};
