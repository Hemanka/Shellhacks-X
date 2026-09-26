import test from 'node:test';
import assert from 'node:assert/strict';
import {Engine,chooseCandidate,expectedMovement,shouldStopApproach} from '../server/engine.js';
import type {Frame,Observation,Target,Metrics} from '../shared/protocol.js';
const target:Target={id:'cup-1',description:'red cup',box:{left:.3,top:.2,right:.7,bottom:.8},referenceJpeg:'private-reference'};
const base:Observation={view:'usable',candidates:[],targetMatch:'matched',targetBox:{left:.3,top:.2,right:.6,bottom:.6},targetScale:'medium',direction:'center',proximity:'far',reachability:'out_of_reach',handVisible:true,handCorrection:'left',uncertain:false,evidence:'Visible cup.'};
const metrics:Metrics={frames:0,visualCalls:0,reasonCalls:0,visualSkipped:0,reasonSkipped:0,tokens:0,visionMs:0,reasonMs:0};
test('deterministic movement mapping uses only validated observation categories',()=>{
 assert.equal(expectedMovement(base,'approaching'),'STEP_FORWARD');
 assert.equal(expectedMovement({...base,direction:'left'},'approaching'),'ALIGN_LEFT');
 assert.equal(expectedMovement({...base,direction:'right'},'approaching'),'ALIGN_RIGHT');
 assert.equal(expectedMovement({...base,direction:'unknown'},'approaching'),null);
 assert.equal(expectedMovement(base,'reaching'),'HAND_LEFT');
 assert.equal(expectedMovement({...base,handCorrection:'hold'},'reaching'),null);
 assert.equal(expectedMovement(base,'paused'),null);
});
function ready(){const e=new Engine();e.start('red cup','left');e.lockTarget(target);return e;}
function frame(e:Engine,receivedAt:number,id=1):Frame{return {id,receivedAt,capturedAt:91.25,jpeg:'jpeg',revision:e.revision};}
function reach(e:Engine){e.preflight({...base,proximity:'near',reachability:'within_reach',targetScale:'large'},frame(e,1000),1000);e.preflight({...base,proximity:'near',reachability:'within_reach',targetScale:'large'},frame(e,3001,2),3001);assert.equal(e.phase,'reaching');}
test('candidate selection ignores unusable targets and honors geometry',()=>{
 const c=[{description:'left',usable:true,box:{left:0,top:0,right:.2,bottom:.2}},{description:'middle',usable:true,box:{left:.4,top:0,right:.6,bottom:.4}},{description:'largest',usable:true,box:{left:.6,top:0,right:1,bottom:1}},{description:'unusable',usable:false,box:{left:0,top:0,right:1,bottom:1}}];
 assert.equal(chooseCandidate(c)?.description,'middle');assert.equal(chooseCandidate(c,'left')?.description,'left');assert.equal(chooseCandidate(c,'area')?.description,'largest');assert.equal(chooseCandidate([]),null);
});
test('engine owns text and rejects proposal action inconsistent with visual evidence',()=>{
 const e=ready();e.apply({action:'ALIGN_RIGHT',reason:'walk across road'},{...base,direction:'left'},frame(e,1000),1000);assert.equal(e.command?.action,'STOP');
 e.apply({action:'ALIGN_LEFT',reason:'walk across road'},{...base,direction:'left'},frame(e,1001),1001);assert.equal(e.command?.text,'Turn left, then stop.');assert.equal(e.command?.capturedAt,91.25);assert.equal(e.command?.expiresInMs,2000);
});
test('movement expires without frames, cannot be extended by updates, and old in-flight frame cannot restart it',()=>{
 const e=ready();e.apply({action:'STEP_FORWARD',reason:''},base,frame(e,1000),1000);const id=e.command?.id;
 e.apply({action:'STEP_FORWARD',reason:''},base,frame(e,1500,2),1500);assert.equal(e.command?.id,id);
 assert.equal(e.tick(2999),false);assert.equal(e.tick(3000),true);assert.equal(e.command?.action,'STOP');assert.equal(e.needsFresh,true);assert.equal(e.tick(3001),false);
 e.apply({action:'STEP_FORWARD',reason:''},base,frame(e,2999,3),3001);assert.equal(e.command?.action,'STOP');
 e.apply({action:'STEP_FORWARD',reason:''},base,frame(e,3002,4),3002);assert.equal(e.command?.action,'STEP_FORWARD');assert.equal(e.needsFresh,false);
});
test('near stops immediately; elapsed timer alone and pre-stop frame cannot enter reaching',()=>{
 const e=ready();e.apply({action:'STEP_FORWARD',reason:''},base,frame(e,500),500);
 assert.equal(shouldStopApproach({...base,targetScale:'small'}),false);
 assert.equal(shouldStopApproach({...base,proximity:'approaching',targetBox:{left:.1,top:.1,right:.85,bottom:.5}}),true);
 e.preflight({...base,proximity:'approaching',targetScale:'medium'},frame(e,900),900);assert.equal(e.phase,'approaching');
 const e2=ready();e2.apply({action:'STEP_FORWARD',reason:''},base,frame(e2,500),500);
 e2.preflight({...base,proximity:'near',reachability:'within_reach',targetScale:'large'},frame(e2,1000),1000);assert.equal(e2.phase,'stopping');assert.equal(e2.command?.action,'STOP');
 e2.preflight({...base,proximity:'near',reachability:'within_reach',targetScale:'large'},frame(e2,2999),3001);assert.equal(e2.phase,'stopping');
 e2.preflight({...base,proximity:'near',reachability:'within_reach',targetScale:'large'},frame(e2,3002,3),3002);assert.equal(e2.phase,'reaching');assert.equal(e2.command?.action,'HOLD');
});
test('reaching recovery retains reaching and never permits walking even if distance changes',()=>{
 const e=ready();reach(e);
 e.preflight({...base,targetMatch:'lost'},frame(e,3100),3100);assert.equal(e.phase,'recovering');assert.equal(e.command?.action,'STOP');
 e.apply({action:'STEP_FORWARD',reason:''},base,frame(e,3200),3200);assert.equal(e.phase,'reaching');assert.equal(e.command?.action,'STOP');
 e.apply({action:'HAND_LEFT',reason:''},base,frame(e,3300),3300);assert.equal(e.command?.action,'HAND_LEFT');
 e.preflight({...base,handVisible:false},frame(e,3400),3400);assert.equal(e.command?.action,'ADJUST_VIEW');assert.equal(e.phase,'reaching');
});
test('uncertainty, unusable view, stale frame, and unknown hand block movement',()=>{
 for(const obs of [{...base,uncertain:true},{...base,view:'blurred' as const},{...base,targetMatch:'ambiguous' as const}]){const e=ready();assert.equal(e.preflight(obs,frame(e,1000),1000),false);assert.notEqual(e.command?.action,'STEP_FORWARD');}
 const e=ready();assert.equal(e.preflight(base,frame(e,1000),5001),false);assert.equal(e.phase,'recovering');
 const r=ready();reach(r);r.apply({action:'HAND_FORWARD',reason:''},{...base,handCorrection:'unknown'},frame(r,3100),3100);assert.equal(r.command?.action,'ADJUST_VIEW');
});
test('pause/resume revision invalidates results and preserves reaching; only found completes',()=>{
 const e=ready();reach(e);const old=frame(e,3100);e.pause();assert.equal(e.phase,'paused');const pausedId=e.command?.id;
 e.apply({action:'HAND_LEFT',reason:''},base,old,3100);assert.equal(e.command?.id,pausedId);
 e.resume();assert.equal(e.phase,'reaching');e.apply({action:'COMPLETE',reason:''},base,frame(e,3200),3200);assert.equal(e.phase,'reaching');assert.equal(e.command?.action,'STOP');
 e.found();assert.equal(e.phase,'complete');assert.equal(e.command?.action,'COMPLETE');e.another();assert.equal(e.phase,'searching');assert.equal(e.target,null);assert.equal(e.query,'red cup');
});
test('temporary inference waits hold position without pausing or changing revision',()=>{
 const e=ready();const revision=e.revision;e.wait('Retrying shortly.');assert.equal(e.phase,'approaching');assert.equal(e.revision,revision);assert.equal(e.command?.action,'HOLD');
});
test('snapshot does not leak reference image or mutable state',()=>{
 const e=ready();e.preflight(base,frame(e,1000),1000);const s=e.snapshot(metrics);assert.equal('referenceJpeg' in s.target!,false);s.target!.box.left=.9;s.metrics.frames=100;assert.equal(e.target?.box.left,.3);assert.equal(metrics.frames,0);
});

test('near alone and a missing hand never establish arrival; out of reach allows a final step',()=>{
 const e=ready();
 e.decide({...base,proximity:'near',reachability:'uncertain',handVisible:false},frame(e,1000,1),1000);
 assert.equal(e.phase,'stopping');assert.equal(e.command?.action,'ADJUST_VIEW');
 e.decide({...base,proximity:'near',reachability:'within_reach',handVisible:false},frame(e,3100,2),3100);
 assert.equal(e.phase,'stopping');
 e.decide({...base,proximity:'near',reachability:'out_of_reach'},frame(e,5100,3),5100);
 assert.equal(e.phase,'approaching');assert.equal(e.command?.action,'STEP_FORWARD');
});

test('Reach requires two distinct fresh observations with a visible selected hand',()=>{
 const e=ready();const obs={...base,proximity:'near' as const,reachability:'within_reach' as const};
 e.decide(obs,frame(e,1000,1),1000);assert.equal(e.phase,'stopping');
 e.decide(obs,frame(e,3100,1),3100);assert.equal(e.phase,'stopping');
 e.decide(obs,frame(e,5100,2),5100);assert.equal(e.phase,'reaching');
 e.decide({...base,handCorrection:'down'},frame(e,7100,3),7100);assert.equal(e.command?.action,'HAND_DOWN');
});
