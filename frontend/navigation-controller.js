/* Session-local navigation. No model calls, DOM, or inferred metric distances. */
(function(root) {
  const DEFAULTS = Object.freeze({ routeMode: false, rotationLimit: 25, memoryMs: 12000, sensorMs: 500,
    confidence: .8, repeatMs: 8000, hazardRepeatMs: 4000, recoveryRepeatMs: 3000,
    enterLeft: .30, enterRight: .70, leaveLeft: .20, leaveRight: .80,
    recoveryEnter: 15, recoveryLeave: 8, recoveryDwellMs: 300 });
  const delta = (a, b) => ((a - b + 540) % 360) - 180;
  const sideText = d => ({LEFT:'on your left', RIGHT:'on your right', CENTER:'directly ahead'}[d] || 'nearby');
  function samplePath(points, count=8) {
    if (!Array.isArray(points) || !points.length) return [];
    if (points.length === 1) return Array.from({length:count},()=>points[0]);
    const lengths=[0];
    for(let i=1;i<points.length;i++) lengths.push(lengths[i-1]+Math.hypot(points[i][0]-points[i-1][0],points[i][1]-points[i-1][1]));
    const total=lengths[lengths.length-1];
    if(!total) return Array.from({length:count},()=>points[0]);
    return Array.from({length:count},(_,i)=>{
      const d=total*i/(count-1); let n=1; while(n<lengths.length-1&&lengths[n]<d)n++;
      const span=lengths[n]-lengths[n-1], f=span?(d-lengths[n-1])/span:0;
      return [points[n-1][0]+(points[n][0]-points[n-1][0])*f,points[n-1][1]+(points[n][1]-points[n-1][1])*f];
    });
  }
  function routeChange(previous,next) {
    if(!previous||!next) return Infinity;
    if(previous.action!==next.action) return Infinity;
    const a=samplePath(previous.points),b=samplePath(next.points);
    if(!a.length||!b.length) return Infinity;
    return a.reduce((sum,p,i)=>sum+Math.hypot(p[0]-b[i][0],p[1]-b[i][1]),0)/a.length;
  }
  function maskChange(previous,next) {
    if(!Array.isArray(previous)||!Array.isArray(next)||previous.length!==next.length) return Infinity;
    const a=previous.flat(),b=next.flat();
    if(!a.length||a.length!==b.length) return Infinity;
    let total=0,changed=0;
    for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);total+=d;if(d>.55)changed++;}
    return Math.max(total/a.length,changed/a.length);
  }
  class NavigationController {
    constructor(emit = () => {}, report = () => {}, config = {}) {
      this.emit = emit; this.report = report; this.config = {...DEFAULTS, ...config}; this.revision = 0; this.reset('');
    }
    reset(target) {
      this.routeScene = null; this.routeSeq = -1; this.routeStream = null; this.activeRoute = null; this.activeMask = null; this.movementAt = -Infinity; this.observedSeq = -1; this.observedStream = null;
      this.revision++; this.target = target; this.stage = 'SEARCH'; this.memory = null;
      this.history = []; this.seen = new Set(); this.aligned = false; this.offset = ''; this.offsetCount = 0;
      this.reachCount = 0; this.hazard = null; this.clearCount = 0; this.lastKey = ''; this.lastAt = -Infinity;
      this.lastHazardAt = -Infinity; this.lastRecoveryAt = -Infinity; this.recoverySide = ''; this.recoverySince = 0;
      this.reachRetryAfter = null; this.pickupPending = false; this.reachRejected = false;
      this.extraApproachPending = false; this.extraApproachUsed = false;
      this.awaitingExtraStep = false; this.extraApproachMoved = false; this.extraApproachBaseline = null;
      this.latest = null; this.counter = 0; this.reason = 'New target'; this.snapshot();
    }
    invalidate(reason) { if (/paused|disconnected|stream changed|interrupted/i.test(reason)) { this.lastOutput = null; this.routeScene = null; this.activeRoute=null; this.activeMask=null; } this.memory = null; this.recoverySide = ''; this.reachCount = 0; this.reason = reason; this.snapshot(); }
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
      // Once arrival is announced, freeze all perception-driven movement until
      // the user confirms pickup or says the item is still out of reach.
      if (this.stage === 'COMPLETE' || this.pickupPending) return;
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
      const sceneConfidence = Number(p.sceneConfidence ?? p.scene_confidence);
      const confidentView = Number.isFinite(sceneConfidence) && sceneConfidence >= .65;
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
        if (rotated) {
          this.invalidate('Phone rotated since capture');
          this.activeRoute = null; this.activeMask = null;
          this.snapshot({selectedRoute:null});
        }
        if (this.config.routeMode && beforeMovement && !rotated) return;
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
        if (this.config.routeMode && this.activeRoute) return;
        const blank = result.source === 'insufficient_image';
        const text = blank ? 'Hold still while I check this view again; the camera needs a clearer image.'
          : 'Stay in place. The vision service could not check this view; trying again.';
        return this.cue('HOLD',text,blank ? 'camera-detail' : 'vision-unavailable',now);
      }
      if (this.config.routeMode) {
        this.routeScene = {p,meta};
        if (!visible) {
          if (this.activeRoute) return;
          if (this.pickupPending) return this.cue('PICKUP','Did you pick it up? Say got it, or lost it.','confirm-pickup',now);
          this.reachCount = 0;
          if (!confidentView) return this.cue('HOLD', 'Hold still while I check this view again.', 'search:uncertain-view', now);
          if (this.tick(now,orientation)) return;
          return this.cue('SEARCH', "Turn slightly right, then stop. I haven't spotted the item yet. I'll check the next view.", 'search:turn-right', now);
        }
        const blockedReach = (p.obstacles || []).find(o => o.relationship === 'separate' && o.confidence >= this.config.confidence && ['reach','both'].includes(o.intrusion));
        if (this.reachRejected && this.reachRetryAfter !== null && meta.capturedAt > this.reachRetryAfter) { this.reachRejected=false; this.reachRetryAfter=null; }
        const ready = !this.reachRejected && t.pickupSuitable && access.reachability === 'easily_reachable' && access.reach === 'clear' && access.evidence && !blockedReach;
        if(access.reachability === 'needs_approach') this.reachRejected = false;
        const postFinalStepCheck = this.awaitingExtraStep && this.extraApproachUsed
          && this.extraApproachBaseline && meta.capturedAt > this.extraApproachBaseline.at
          && ready;
        if (postFinalStepCheck) {
          this.awaitingExtraStep = false; this.extraApproachMoved = true;
          this.reason = 'Final step confirmed within reach';
          this.snapshot({finalStepObserved:true});
        }
        this.reachCount = ready && (!this.awaitingExtraStep || this.extraApproachMoved) ? this.reachCount+1 : 0;
        if (this.reachCount >= 1 && this.extraApproachUsed && this.extraApproachMoved) {
          this.pickupPending = true;
          const support = (p.obstacles || []).find(o => o.relationship === 'target_support');
          return this.cue('PICKUP', `You have reached the ${t.label || this.target}${support?.label ? `, on the ${support.label}` : ''}. Stop here and reach out carefully in front of you. Can you feel it? Say yes to confirm, or no if you cannot find it.`, 'pickup', now, meta, 2, true);
        }
        if (this.reachCount >= 2 && !this.extraApproachUsed) {
          this.extraApproachPending = true;
        }
        if ((ready || this.pickupPending) && !this.extraApproachPending) {
          if (this.activeRoute) return;
          return this.cue('HOLD', blockedReach ? `Stay here. ${blockedReach.label || 'An obstacle'} is between you and the item.` : 'The item appears comfortably within reach. Stay here while I confirm, or say too far if you need to move closer.', 'check-reach', now);
        }
        if (this.activeRoute) return;
        this.stage = 'HOLD'; this.reason = 'target-found-route-pending';
        this.snapshot({instruction:`I found the ${t.label || this.target}. Checking the clear path.`,
          evidenceFrame:meta.seq, evidenceAge:now-meta.capturedAt});
        return;
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
        if (!confidentView) return this.cue('HOLD','Hold still while I check this view again.','search:uncertain-view',now);
        if (this.tick(now,orientation)) return;
        return this.cue('SEARCH',"Turn slightly right, then stop. I haven't spotted the item yet. I'll check the next view.",'search:turn-right',now);
      }
      if (this.reachCount >= 2) {
        this.pickupPending = true;
        const support = obstacles.find(o => o.relationship === 'target_support' && o.confidence >= this.config.confidence);
        const surface = support?.label ? `on the ${support.label}` : ['floor','table','shelf'].includes(t.support) ? `on the ${t.support}` : 'nearby';
        return this.cue('PICKUP',`You have reached the ${t.label || this.target}, ${surface} ${sideText(t.direction)}. Stop here and reach out carefully. Say yes to confirm you can feel it, or no if you cannot find it.`,
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
    observeRoute(result, meta, now, orientation, perceptionOverride = null, perceptionMeta = null) {
      if (this.stage === 'COMPLETE' || this.pickupPending) return;
      if (!this.config.routeMode || !meta || this.stage === 'COMPLETE' || this.pickupPending) return;
      if (this.routeStream === meta.stream && meta.seq <= this.routeSeq) return;
      this.routeStream = meta.stream; this.routeSeq = meta.seq;
      if (meta.capturedAt <= this.movementAt || meta.capturedAt > now) return;
      const scene = perceptionOverride && perceptionMeta?.stream === meta.stream
        && meta.capturedAt >= perceptionMeta.capturedAt
        && meta.capturedAt - perceptionMeta.capturedAt <= 5000
        ? {meta:perceptionMeta, perception:perceptionOverride}
        : [...this.history].reverse().find(item =>
          item.meta.stream === meta.stream && item.meta.seq === meta.seq);
      if (!scene) return;
      const p = scene.perception;
      const t = p.target, access = p.access || {};
      if (!t?.visible || t.confidence < this.config.confidence) {
        const routeWasActive = !!this.activeRoute;
        this.activeRoute = null; this.activeMask = result.maskSignature || this.activeMask;
        this.awaitingExtraStep = false; this.extraApproachMoved = false;
        this.extraApproachPending = false; this.extraApproachUsed = false;
        this.extraApproachBaseline = null; this.reachCount = 0;
        this.snapshot({pathPlan:result.pathPlan, selectedRoute:null, routeWidth:result.width,
          routeHeight:result.height, routeFrame:meta.seq});
        if (routeWasActive) return this.cue('HOLD','Stop. I cannot confirm the path now. Hold still while I rebuild it.','route:lost-view',now,meta,0,true,true,'hazard');
        return;
      }
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
        const routeWasActive = !!this.activeRoute;
        this.activeRoute = null; this.activeMask = result.maskSignature || this.activeMask;
        this.awaitingExtraStep = false; this.extraApproachMoved = false;
        this.extraApproachPending = false; this.extraApproachUsed = false;
        this.extraApproachBaseline = null; this.reachCount = 0;
        const obstruction = (p.obstacles || []).find(o => o.confidence >= this.config.confidence && o.proximity === 'appears_close' && o.proximityConfidence >= .85 && ['approach','both'].includes(o.intrusion) && o.bbox && o.bbox[0] < .6 && o.bbox[2] > .4 && o.bbox[3] > .75);
        if (obstruction || routeWasActive) return this.cue('HOLD',`Stop. ${obstruction?.label || 'I cannot confirm a clear path'}. Hold still while I rebuild the route.`, 'route:blocked',now,meta,0,true,true,'hazard');
        return this.cue('HOLD','Hold still while I check for a clear path.','route:blocked',now,meta);
      }
      // If the safe route turns during the final-step check, discard the old
      // step instruction and let the newly planned yellow route lead instead.
      if (this.awaitingExtraStep && !this.extraApproachMoved && route.action !== 'FORWARD') {
        this.awaitingExtraStep = false; this.extraApproachUsed = false;
        this.extraApproachPending = true; this.extraApproachBaseline = null;
        this.reachCount = 0;
      }
      if (this.extraApproachPending && !this.extraApproachUsed) {
        this.activeRoute = route; this.activeMask = result.maskSignature || this.activeMask;
        if (route.action === 'TURN_LEFT' || route.action === 'TURN_RIGHT') {
          const side = route.action === 'TURN_LEFT' ? 'left' : 'right';
          const key = `route:final-align-${side}`;
          if (this.lastKey !== key || now - this.lastAt >= 2500) {
            return this.cue('ALIGN', `Before the final step, turn slightly ${side}, then stop. I will recheck the path and guide one more step toward the ${t.label || this.target}.`, key, now, meta, 1, true, true);
          }
          return;
        }
        if (route.action === 'FORWARD') {
          this.extraApproachPending = false;
          this.extraApproachUsed = true;
          this.awaitingExtraStep = true; this.extraApproachMoved = false;
          this.extraApproachBaseline = {at:meta.capturedAt, bbox:Array.isArray(t.bbox) ? [...t.bbox] : null, lastPromptAt:now};
          this.reachCount = 0;
          const action = 'Take one more short step straight ahead, then stop.';
          const text = route.certainty === 'estimated' ? `Best estimate: ${action}` : action;
          return this.cue('APPROACH', `The yellow path is clear ahead. ${text}`, 'route:final-approach', now, meta, 1, true, true);
        }
      }
      if (this.awaitingExtraStep && !this.extraApproachMoved && route.action === 'FORWARD') {
        this.activeRoute = route; this.activeMask = result.maskSignature || this.activeMask;
        if (now - (this.extraApproachBaseline?.lastPromptAt ?? now) >= 2500) {
          if (this.extraApproachBaseline) this.extraApproachBaseline.lastPromptAt = now;
          const action = 'Take one more short step straight ahead, then stop.';
          const text = route.certainty === 'estimated' ? `Best estimate: ${action}` : action;
          return this.cue('APPROACH', text, 'route:final-approach', now, meta, 1, true, true);
        }
        return;
      }
      const maskDelta = maskChange(this.activeMask,result.maskSignature);
      const pathDelta = routeChange(this.activeRoute,route);
      const actionChanged = !!this.activeRoute && this.activeRoute.action !== route.action;
      const routeChangedGreatly = !this.activeRoute || actionChanged || pathDelta >= .03 || maskDelta >= .15;
      // A significant path or immediate-action change is sent as soon as its
      // mask and target from this exact frame have been analyzed.
      this.activeRoute = route; this.activeMask = result.maskSignature || this.activeMask;
      if (!routeChangedGreatly) return;
      const turn = route.action === 'TURN_LEFT' ? 'left' : 'right';
      const action = route.action === 'FORWARD' ? 'Take one short step straight ahead, then stop.' : `Turn slightly ${turn}, then stop.`;
      const text = route.certainty === 'estimated' ? `Best estimate: ${action}` : action;
      const output = this.cue(route.action === 'FORWARD' ? 'APPROACH' : 'ALIGN',text,`route:${route.action}`,now,meta,actionChanged ? 1 : 2,true,true);
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
        if (this.pickupPending) { this.pickupPending = false; this.memory = null; this.cue('COMPLETE',`Pickup confirmed. You have arrived at the ${this.target || 'target'}. Ready when you want to find something else.`,'complete',now,null,2,false,true); return 'complete'; }
        this.cue(this.stage,'Have you picked up the item? I have not confirmed a pickup position yet.','clarify-complete',now,null,2,false,true); return 'handled';
      }
      if (this.pickupPending && /^(yes\b|yeah\b|yep\b|i can (?:feel|touch)\b|i found it\b)/.test(cmd)) {
        this.cue('PICKUP',`Great. You have reached the ${this.target || 'target'} and confirmed it is within reach. Pick it up, then say got it when it is in your hand. Say no if you cannot touch it.`,'pickup-confirmed',now,null,2,false,true);
        return 'handled';
      }
      if (/^(can't reach it|cannot reach it|i can't reach it|too far|it's too far|it is too far|i'm too far|move closer|closer)$/.test(cmd)) { this.pickupPending=false; this.extraApproachPending=false; this.extraApproachUsed=false; this.awaitingExtraStep=false; this.extraApproachMoved=false; this.extraApproachBaseline=null; this.reachRejected=true; this.reachRetryAfter=null; this.reachCount=0; this.movementAt=now; this.cue('HOLD','I will find another step toward the item. Stay still.','cannot-reach',now,null,2,false,true); return 'handled'; }
      if (this.pickupPending && /^(no\b|lost it\b|not there\b|i (?:cannot|can't) (?:touch|feel|find|reach)\b)/.test(cmd)) {
        this.pickupPending=false; this.extraApproachPending=false; this.extraApproachUsed=false;
        this.awaitingExtraStep=false; this.extraApproachMoved=false; this.extraApproachBaseline=null;
        this.reachRejected=false; this.reachRetryAfter=null; this.reachCount=0;
        this.routeScene=null; this.activeRoute=null; this.activeMask=null; this.movementAt=now;
        this.stage='SEARCH'; this.lastKey='';
        this.cue('SEARCH',`Okay. I will search for the ${this.target || 'item'} again. Hold still while I check this view.`,'pickup-not-found',now,null,2,false,true);
        return 'handled';
      }
      if (/^lost it\b/.test(cmd)) { this.pickupPending=false; this.reachCount=0; this.stage='SEARCH'; this.lastKey=''; return 'handled'; }
      if (/^(stop|pause)$/.test(cmd)) return 'pause';
      if (cmd === 'repeat') { if (this.lastOutput && (this.lastOutput.expiresAt === null || this.lastOutput.expiresAt > now)) this.emit({...this.lastOutput,id:`${this.revision}:${++this.counter}`}); else this.cue('HOLD','Stay in place while I get a fresh view.','repeat-expired',now,null,2,false,true); return 'handled'; }
      return null;
    }
  }
  root.NavigationController = NavigationController;
  if (typeof module !== 'undefined') module.exports = {NavigationController, DEFAULTS, delta};
})(typeof window !== 'undefined' ? window : globalThis);
