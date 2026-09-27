/* Convert device orientation to rear-camera azimuth; relative north is sufficient. */
(function(root) {
  function cameraHeading(alpha,beta,gamma) {
    if (![alpha,beta,gamma].every(Number.isFinite)) return null;
    const [a,b,g]=[alpha,beta,gamma].map(v=>v*Math.PI/180);
    const x=-(Math.cos(a)*Math.sin(g)+Math.sin(a)*Math.sin(b)*Math.cos(g));
    const y=-Math.sin(a)*Math.sin(g)+Math.cos(a)*Math.sin(b)*Math.cos(g);
    if (Math.hypot(x,y)<.25) return null;
    return (Math.atan2(x,y)*180/Math.PI+360)%360;
  }
  class PhoneOrientation {
    constructor(report=()=>{}) { this.report=report; this.sample=null; this.epoch=0; this.started=false; this.lastSent=0; }
    async enable() {
      try {
        const API=root.DeviceOrientationEvent;
        if (!API) throw new Error('Orientation unavailable');
        if (typeof API.requestPermission === 'function' && await API.requestPermission() !== 'granted') throw new Error('Orientation permission denied');
        if (!this.started) {
          root.addEventListener('deviceorientation',e=>this.update(e));
          root.addEventListener('deviceorientationabsolute',e=>this.update(e));
          this.started=true;
        }
        this.report('enabled');
      } catch(e) { this.report(e.message); }
    }
    update(e) {
      const now=performance.now(), screen=root.screen?.orientation?.angle ?? root.orientation ?? 0;
      const compass=Number.isFinite(e.webkitCompassHeading);
      const type=compass ? 'webkit' : e.absolute ? 'absolute' : 'relative';
      if (this.sample?.reference.includes('absolute') && type==='relative') return;
      const heading=cameraHeading(compass ? 360-e.webkitCompassHeading : e.alpha,e.beta,e.gamma);
      if (this.type && this.type!==type) this.epoch++;
      if (this.sample && (screen!==this.sample.screen || (heading!==null && now-this.sample.at<100 && Math.abs(((heading-this.sample.heading+540)%360)-180)>60))) this.epoch++;
      this.type=type;
      this.sample={valid:heading!==null && (!compass || !Number.isFinite(e.webkitCompassAccuracy) || (e.webkitCompassAccuracy>=0 && e.webkitCompassAccuracy<=30)),
        heading:heading ?? 0,at:now,reference:`${type}:${this.epoch}`,screen};
    }
    current() { return this.sample && {...this.sample,valid:this.sample.valid && performance.now()-this.sample.at<=500}; }
  }
  root.PhoneOrientation=PhoneOrientation;
  if (typeof module!=='undefined') module.exports={cameraHeading,PhoneOrientation};
})(typeof window!=='undefined'?window:globalThis);
