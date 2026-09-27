/* Session-local navigation. No model calls, DOM, or inferred metric distances. */
(function(root) {
  const DEFAULTS = Object.freeze({ routeMode: false, rotationLimit: 25, memoryMs: 12000, sensorMs: 500,
    confidence: .8, repeatMs: 8000, hazardRepeatMs: 4000, recoveryRepeatMs: 3000,
    enterLeft: .30, enterRight: .70, leaveLeft: .20, leaveRight: .80,
    recoveryEnter: 15, recoveryLeave: 8, recoveryDwellMs: 300 });
  const delta = (a, b) => ((a - b + 540) % 360) - 180;
  const sideText = d => ({LEFT:'on your left', RIGHT:'on your right', CENTER:'directly ahead'}[d] || 'nearby');
  class NavigationController {
    constructor(emit = () => {}, report = () => {}, config = {}) {
      this.emit = emit; this.report = report; this.config = {...DEFAULTS, ...config}; this.revision = 0; this.reset('');
    }
    reset(target) {
      this.routeScene = null; this.routeSeq = -1; this.routeStream = null; this.lastRouteAction = null; this.routeActionCount = 0; this.movementAt = -Infinity; this.observedSeq = -1; this.observedStream = null;
      this.revision++; this.target = target; this.stage = 'SEARCH'; this.memory = null;
      this.history = []; this.seen = new Set(); this.aligned = false; this.offset = ''; this.offsetCount = 0;
      this.reachCount = 0; this.hazard = null; this.clearCount = 0; this.lastKey = ''; this.lastAt = -Infinity;
      this.lastHazardAt = -Infinity; this.lastRecoveryAt = -Infinity; this.recoverySide = ''; this.recoverySince = 0;
      this.reachRetryAfter = null; this.pickupPending = false; this.reachRejected = false; this.latest = null; this.counter = 0; this.reason = 'New target'; this.snapshot();
    }
    invalidate(reason) { if (/paused|disconnected|stream changed|interrupted/i.test(reason)) { this.lastOutput = null; this.routeScene = null; } this.memory = null; this.recoverySide = ''; this.reachCount = 0; this.reason = reason; this.snapshot(); }
    snapshot(extra = {}) {
      this.report({stage:this.stage, reason:this.reason, target:this.target, revision:this.revision,
        aligned:this.aligned, memory:this.memory, hazard:this.hazard, reachCount:this.reachCount,
        config:this.config, ...extra});
    }
    cue(stage, text, key, now, meta = null, priority = 2, physical = false, force = false, type = 'guidance') {
      const changed = this.stage !== stage;
      this.stage = stage; this.reason = key;
      this.snapshot({instruction:text, evidenceFrame:meta?.seq, evidenceAge:meta ? now-meta.capturedAt : null});
      if (!force && !changed && key === this.lastKey && now-this.lastAt < (['camera-detail','vision-unavailable','missing-metadata','pickup-delayed','hazard-delayed'].includes(key) ? 20000 : this.config.repeatMs)) return null;
      const expiresAt = null; // Incremental cues end on state changes, not elapsed time.
      const output = {type, text, key, stage, priority, revision:this.revision,
        id:`${this.revision}:${++this.counter}`, expiresAt, stream:meta?.stream || this.latest?.stream,
        evidenceFrame:meta?.seq ?? null, evidenceAge:meta ? now-meta.capturedAt : null,
        source:key.startsWith('route:') ? 'nvidia_route' : stage === 'RECOVER' ? 'remembered_orientation' : 'vision', physical};
      if (['APPROACH','ALIGN','RECOVER','PICKUP'].includes(stage) && (physical || stage === 'RECOVER')) this.movementAt = now;
      this.lastKey = key; this.lastAt = now; this.lastOutput = output; this.emit(output); return output;
    }
    observe(result, meta, now, orientation) {
      if (this.stage === 'COMPLETE') return;
      if (!meta || !Number.isFinite(meta.capturedAt) || !meta.stream || !Number.isInteger(meta.seq)) {
        this.reachCount = 0;
        return this.cue('HOLD','Stay in place. Waiting for a current camera observation.','missing-metadata',now);
      }
      const frameKey = `${meta.stream}:${meta.seq}`;
      if (this.seen.has(frameKey) || (this.observedStream === meta.stream && meta.seq <= this.observedSeq)) return;
      this.observedStream = meta.stream; this.observedSeq = meta.seq;
      if (this.latest && this.latest.stream !== meta.stream) this.invalidate('Camera stream changed');
      this.latest = meta; this.seen.add(frameKey);
      const p = result.perception || {}, t = p.target || {}, access = p.access || {};
      this.history.push({meta, perception:p});
      this.history = this.history.filter(x => now-x.meta.capturedAt <= 60000).slice(-100);
      this.seen = new Set(this.history.map(x=>`${x.meta.stream}:${x.meta.seq}`));
      const beforeMovement = meta.capturedAt <= this.movementAt;
      const captureOrientation = meta.orientation;
      const comparable = captureOrientation?.valid && orientation?.valid && now-orientation.at <= this.config.sensorMs;
      const rotated = comparable && (captureOrientation.reference !== orientation.reference
        || captureOrientation.screen !== orientation.screen
        || Math.abs(delta(captureOrientation.heading,orientation.heading)) >= this.config.rotationLimit);
      if (beforeMovement || rotated || meta.capturedAt > now) {
        this.reachCount = 0;
        if (rotated) this.invalidate('Phone rotated since capture');
        return this.cue('HOLD', 'Hold this position while I check a new view.',
          beforeMovement ? 'await-post-movement-view' : 'view-changed', now);
      }
      const failed = ['fallback','demo','insufficient_image'].includes(result.source) || result.rateLimited;
      const visible = !failed && t.visible && t.confidence >= this.config.confidence;
      // Delayed sightings can orient a stationary search, never authorize a step.
      if (visible && meta.orientation?.valid && now >= meta.capturedAt && now-meta.capturedAt <= this.config.memoryMs) {
        this.memory = {stream:meta.stream, at:meta.capturedAt, heading:meta.orientation.heading,
          reference:meta.orientation.reference, screen:meta.orientation.screen, direction:t.direction, bbox:t.bbox, confidence:t.confidence};
      }
      if (failed) {
        this.reachCount = 0;
        const blank = result.source === 'insufficient_image';
        const text = blank ? 'Point the camera toward the room and slowly look around. The camera view has too little detail.'
          : 'Stay in place. The vision service could not check this view; trying again.';
        return this.cue(blank ? 'SEARCH' : 'HOLD',text,blank ? 'camera-detail' : 'vision-unavailable',now);
      }
      if (this.config.routeMode) {
        this.routeScene = {p,meta};
        if (!visible) {
          if (this.pickupPending) return this.cue('PICKUP','Did you pick it up? Say got it, or lost it.','confirm-pickup',now);
          this.reachCount = 0;
          if (this.tick(now,orientation)) return;
          return this.cue('SEARCH', "Stay in place and slowly look around. I haven't spotted the item yet.", 'search', now);
        }
        const blockedReach = (p.obstacles || []).find(o => o.relationship === 'separate' && o.confidence >= this.config.confidence && ['reach','both'].includes(o.intrusion));
        if (this.reachRejected && this.reachRetryAfter !== null && meta.capturedAt > this.reachRetryAfter) { this.reachRejected=false; this.reachRetryAfter=null; }
        const ready = !this.reachRejected && t.pickupSuitable && access.reachability === 'easily_reachable' && access.reach === 'clear' && access.evidence && !blockedReach;
        if(access.reachability === 'needs_approach') this.reachRejected = false;
        this.reachCount = ready ? this.reachCount+1 : 0;
        if (this.reachCount >= 2) {
          this.pickupPending = true;
          const support = (p.obstacles || []).find(o => o.relationship === 'target_support');
          return this.cue('PICKUP', `Stay here. The ${t.label || this.target} looks comfortably within reach${support?.label ? ` on the ${support.label}` : ''}. Say got it when you have it.`, 'pickup', now, meta, 2, true);
        }
        if (ready || this.pickupPending) {
          return this.cue('HOLD', blockedReach ? `Stay here. ${blockedReach.label || 'An obstacle'} is between you and the item.` : 'The item appears comfortably within reach. Stay here while I confirm, or say too far if you need to move closer.', 'check-reach', now);
        }
        return this.cue('HOLD', `I found the ${t.label || this.target}. Stay in place while I check for a clear floor path.`, 'target-found-route-pending', now, meta);
      }
      const obstacles = p.obstacles || [];
      const hazards = obstacles.filter(o => o.confidence >= this.config.confidence && o.proximity === 'appears_close' && o.proximityConfidence >= .85
        && ['approach','reach','both'].includes(o.intrusion) && o.evidence)
        .sort((a,b)=>Number(b.intrusion === (this.stage === 'PICKUP' ? 'reach' : 'approach'))-Number(a.intrusion === (this.stage === 'PICKUP' ? 'reach' : 'approach')));
      const hazard = hazards.find(o => !['target_itself','target_support'].includes(o.relationship)) || hazards[0];
      if(access.reachability==='needs_approach') this.reachRejected=false;
      const pickupReady = !this.reachRejected && visible && t.pickupSuitable && access.reachability === 'easily_reachable' && access.reach === 'clear' && !!access.evidence;
      this.reachCount = pickupReady ? this.reachCount + 1 : 0;
      if (hazard && !(['target_itself','target_support'].includes(hazard.relationship) && this.reachCount >= 2)) {
        this.clearCount = 0;
        const key = `${hazard.label}:${hazard.direction}:${hazard.relationship}`;
        const changed = this.hazard?.key !== key;
        this.hazard = {...hazard,key,at:meta.capturedAt,verified:true};
        this.stage = 'HOLD'; this.reason = 'Close obstacle'; this.snapshot();
        if (changed || now-this.lastHazardAt >= this.config.hazardRepeatMs) {
          this.lastHazardAt = now;
          const name = hazard.label?.trim() || 'an obstacle';
          return this.cue('HOLD',`Stop—${name}${hazard.relationship === 'target_itself' ? " you're finding" : ''} is close ${sideText(hazard.direction)}.`,
            `hazard:${key}`,now,meta,0,true,true,'hazard');
        }
        return;
      }
      if (this.hazard) {
        const clear = access.approach === 'clear' && access.reach === 'clear';
        this.clearCount = clear ? this.clearCount + 1 : 0;
        if (['target_itself','target_support'].includes(this.hazard.relationship) && this.reachCount >= 2) this.clearCount = 2;
        if (this.clearCount < 2) return this.cue('HOLD','Stay in place while I check the obstruction again.','hazard-unverified',now);
        this.hazard = null; this.emit({type:'cancel_hazard',revision:this.revision});
      }
      if (this.pickupPending && !visible) return this.cue('PICKUP','Did you pick it up? Say got it, or lost it.','confirm-pickup',now);
      if (!visible) {
        this.offsetCount = 0;
        if (this.tick(now,orientation)) return;
        return this.cue('SEARCH',"Stay in place and slowly look around. I haven't spotted the item yet.",'search',now);
      }
      if (this.reachCount >= 2) {
        this.pickupPending = true;
        const support = obstacles.find(o => o.relationship === 'target_support' && o.confidence >= this.config.confidence);
        const surface = support?.label ? `on the ${support.label}` : ['floor','table','shelf'].includes(t.support) ? `on the ${t.support}` : 'nearby';
        return this.cue('PICKUP',`Stay here. The ${t.label || this.target} looks comfortably within reach, ${surface} ${sideText(t.direction)}. Say got it when you have it.`,
          'pickup',now,meta,2,true);
      }
      if (this.pickupPending) return this.cue('HOLD','Stay here. I need a clearer view of the item and the space around it.','pickup-uncertain',now);
      // A distant support is the endpoint, not a barrier to the open floor before it.
      // Unknown/close supports still prevent stepping; never ignore a separate obstacle.
      const barrier = obstacles.find(o => o.relationship !== 'target_itself'
        && !(o.relationship === 'target_support' && o.proximity === 'not_close' && access.approach === 'clear')
        && o.confidence >= this.config.confidence && ['approach','both'].includes(o.intrusion));
      if (access.approach === 'blocked' || barrier) {
        const side = result.decision?.action === 'TURN_LEFT' ? 'left' : result.decision?.action === 'TURN_RIGHT' ? 'right' : null;
        if (side && p.sectors?.[side]?.status === 'OPEN' && p.sectors[side].confidence >= this.config.confidence) {
          return this.cue('ALIGN',`${barrier?.label || 'An obstacle'} is blocking the approach. Turn slightly ${side}, then pause.`,`detour:${side}`,now,meta,2,true);
        }
        return this.cue('HOLD',`Stay here. ${barrier?.label || 'An obstacle'} is blocking access to the ${t.label || this.target}.`,'blocked-access',now,meta,1,true);
      }
      if (access.approach !== 'clear' || !access.evidence || !t.bbox) {
        return this.cue('HOLD','Stay in place. Show the item and the space around it so I can check the approach.','uncertain-access',now);
      }
      const center = (t.bbox[0]+t.bbox[2])/2;
      const c = this.config;
      if (center >= c.enterLeft && center <= c.enterRight) this.aligned = true;
      const outside = center < c.leaveLeft ? 'left' : center > c.leaveRight ? 'right' : '';
      if (outside) { this.offsetCount = outside === this.offset ? this.offsetCount+1 : 1; this.offset = outside; }
      else { this.offsetCount = 0; this.offset = ''; }
      if (this.offsetCount >= 2) {
        this.aligned = false;
        return this.cue('ALIGN',`A little ${outside}, then pause.`,`align:${outside}`,now,meta,2,true);
      }
      if (!this.aligned || outside) return this.cue('ALIGN','Hold here while I check the direction.','alignment-pending',now);
      if (access.reachability !== 'needs_approach') return this.cue('HOLD','Stay here. Show the item and the space between you and it so I can check whether it is within reach.','check-reach',now);
      const output = this.cue('APPROACH',`The ${t.label || this.target} is ahead. Take one small step toward it, then pause.`,'step',now,meta,2,true);
      if (output) this.invalidate('Walking instruction issued');
      return output;
    }
    observeRoute(result, meta, now, orientation) {
      if (!this.config.routeMode || !meta || this.stage === 'COMPLETE' || this.pickupPending) return;
      if (this.routeStream === meta.stream && meta.seq <= this.routeSeq) return;
      this.routeStream = meta.stream; this.routeSeq = meta.seq;
      if (meta.capturedAt <= this.movementAt || meta.capturedAt > now) return;
      const scene = this.routeScene;
      if (!scene || scene.meta.stream !== meta.stream) return;
      const t = scene.p.target, access = scene.p.access || {};
      if (!t?.visible || t.confidence < this.config.confidence || this.reachCount > 0) return;
      // Don't steer to old image coordinates after a substantial turn.
      for (const pose of [meta.orientation, scene.meta.orientation]) {
        if (pose?.valid && orientation?.valid && (pose.reference !== orientation.reference || pose.screen !== orientation.screen || Math.abs(delta(pose.heading,orientation.heading)) >= this.config.rotationLimit)) {
          this.routeScene = null;
          return this.cue('HOLD','Hold this view while I locate the item again.','route:relocalize',now);
        }
      }
      const routes = result.pathPlan?.routes || [];
      const desired = t.direction || 'CENTER';
      const ranked = [...routes].sort((a,b)=>(a.direction===desired?-2:a.direction==='CENTER'?-1:0)-(b.direction===desired?-2:b.direction==='CENTER'?-1:0));
      const route = ranked[0];
      this.snapshot({pathPlan:result.pathPlan, selectedRoute:route || null, routeWidth:result.width, routeHeight:result.height, routeFrame:meta.seq});
      if (!route) {
        this.routeActionCount = 0;
        const obstruction = (scene.p.obstacles || []).find(o => o.confidence >= this.config.confidence && o.proximity === 'appears_close' && o.proximityConfidence >= .85 && ['approach','both'].includes(o.intrusion) && o.bbox && o.bbox[0] < .6 && o.bbox[2] > .4 && o.bbox[3] > .75);
        if (obstruction) return this.cue('HOLD',`Stop. ${obstruction.label || 'An obstacle'} is blocking the floor path ahead.`, 'route:obstacle',now,meta,0,true,false,'hazard');
        return this.cue('HOLD','Stay here. I cannot find a connected floor path in this view. Show the floor ahead.','route:blocked',now,meta,1);
      }
      // Two masks agree before a turn; one-frame segmentation jitter stays quiet.
      this.routeActionCount = this.lastRouteAction === route.action ? this.routeActionCount+1 : 1;
      this.lastRouteAction = route.action;
      if (route.action !== 'FORWARD' && this.routeActionCount < 2) return;
      const turn = route.action === 'TURN_LEFT' ? 'left' : 'right';
      const text = route.action === 'FORWARD' ? `Take one small step along the open floor toward the ${t.label || this.target}, then pause.` : `Turn slightly ${turn} to follow the open floor, then pause.`;
      const output = this.cue(route.action === 'FORWARD' ? 'APPROACH' : 'ALIGN',text,`route:${route.action}`,now,meta,2,true);
      if (output && route.action === 'FORWARD' && this.reachRejected) this.reachRetryAfter = now;
      return output;
    }
    tick(now, orientation) {
      if (this.hazard) return false;
      const m = this.memory;
      if (!m || now-m.at > this.config.memoryMs || !orientation?.valid || now-orientation.at > this.config.sensorMs
        || orientation.reference !== m.reference || orientation.screen !== m.screen) {
        this.invalidate('Recovery memory or sensor unavailable'); return false;
      }
      const error = delta(m.heading,orientation.heading);
      if (Math.abs(error) < this.config.recoveryLeave) {
        this.recoverySide = '';
        if (this.stage === 'RECOVER') this.cue('RECOVER','Hold this view while I look for the item again.','recover-wait',now);
        return this.stage === 'RECOVER';
      }
      if (Math.abs(error) <= this.config.recoveryEnter) return this.stage === 'RECOVER';
      const side = error < 0 ? 'left' : 'right';
      if (side !== this.recoverySide) { this.recoverySide = side; this.recoverySince = now; }
      this.stage = 'RECOVER';
      if (now-this.recoverySince >= this.config.recoveryDwellMs && now-this.lastRecoveryAt >= this.config.recoveryRepeatMs) {
        this.lastRecoveryAt = now;
        this.cue('RECOVER',`A little ${side}, toward where I last saw it.`,`recover:${side}`,now,null,2,false,true);
      }
      return true;
    }
    command(text, now) {
      const cmd = text.toLowerCase().trim().replace(/[.!?]+$/,'').replace(/’/g,"'");
      if (/^(got it|i picked it up|done)$/.test(cmd)) {
        if (this.pickupPending) { this.pickupPending = false; this.memory = null; this.cue('COMPLETE','Got it. Ready when you want to find something else.','complete',now,null,2,false,true); return 'complete'; }
        this.cue(this.stage,'Have you picked up the item? I have not confirmed a pickup position yet.','clarify-complete',now,null,2,false,true); return 'handled';
      }
      if (/^(can't reach it|cannot reach it|i can't reach it|too far|it's too far|it is too far|i'm too far|move closer|closer)$/.test(cmd)) { this.pickupPending=false; this.reachRejected=true; this.reachRetryAfter=null; this.reachCount=0; this.movementAt=now; this.cue('HOLD','Understood. Show the floor toward the item so I can guide you closer.','cannot-reach',now,null,2,false,true); return 'handled'; }
      if (/^(lost it|no)$/.test(cmd) && (cmd === 'lost it' || this.pickupPending)) { this.pickupPending=false; this.reachCount=0; this.stage='SEARCH'; this.lastKey=''; return 'handled'; }
      if (/^(stop|pause)$/.test(cmd)) return 'pause';
      if (cmd === 'repeat') { if (this.lastOutput && (this.lastOutput.expiresAt === null || this.lastOutput.expiresAt > now)) this.emit({...this.lastOutput,id:`${this.revision}:${++this.counter}`}); else this.cue('HOLD','Stay in place while I get a fresh view.','repeat-expired',now,null,2,false,true); return 'handled'; }
      return null;
    }
  }
  root.NavigationController = NavigationController;
  if (typeof module !== 'undefined') module.exports = {NavigationController, DEFAULTS, delta};
})(typeof window !== 'undefined' ? window : globalThis);
