import test from 'node:test';
import assert from 'node:assert/strict';
import { grayscaleDiff, semanticKey, shouldAnalyze, shouldReason, frameIsCurrent, canCarryObservationForward } from '../server/gates.js';
import { Engine } from '../server/engine.js';
import type { Observation, Frame } from '../shared/protocol.js';
const obs:Observation={view:'usable',candidates:[],targetMatch:'matched',targetBox:{left:.3,top:.2,right:.6,bottom:.6},targetScale:'medium',direction:'center',proximity:'far',reachability:'out_of_reach',handVisible:true,handCorrection:'left',uncertain:false,evidence:'visible cup'};
test('pixel gate uses normalized difference with exact threshold and forced/fresh escape',()=>{
 assert.equal(grayscaleDiff(null,new Uint8Array([0])),1);
 assert.equal(grayscaleDiff(new Uint8Array([0]),new Uint8Array([255])),1);
 assert.equal(grayscaleDiff(new Uint8Array([1,2]),new Uint8Array([1,2])),0);
 assert.equal(shouldAnalyze(0,2999,false),false);assert.equal(shouldAnalyze(.04,0,false),true);
 assert.equal(shouldAnalyze(0,3000,false),true);assert.equal(shouldAnalyze(0,0,true),true);
});
test('semantic gate ignores prose jitter but detects every operational state change',()=>{
 const key=semanticKey(obs,'approaching');assert.equal(key,semanticKey({...obs,evidence:'different wording',candidates:[{description:'cup',usable:true,box:{left:0,top:0,right:1,bottom:1}}]},'approaching'));
 for(const change of [{view:'blurred'},{targetMatch:'lost'},{targetScale:'large'},{direction:'left'},{proximity:'near'},{handVisible:false},{handCorrection:'right'},{uncertain:true}])assert.notEqual(key,semanticKey({...obs,...change} as Observation,'approaching'));
 assert.notEqual(key,semanticKey(obs,'reaching'));assert.equal(shouldReason(key,key,false),false);assert.equal(shouldReason(key,key,true),true);
});
test('frame-current gate rejects revision changes, disposal, future and stale receives',()=>{
 assert.equal(frameIsCurrent(1,1,1000,5000),true);assert.equal(frameIsCurrent(1,1,1000,5001),false);
 assert.equal(frameIsCurrent(1,2,1000,1000),false);assert.equal(frameIsCurrent(1,1,1001,1000),false);assert.equal(frameIsCurrent(1,1,1000,1000,true),false);
});
test('stable live pixels can carry a completed observation to a fresh frame',()=>{
 const analyzed=new Uint8Array([20,40,60,80]);
 assert.equal(canCarryObservationForward(analyzed,new Uint8Array([21,41,61,81]),1,1,9000,10000),true);
 assert.equal(canCarryObservationForward(analyzed,new Uint8Array([100,120,140,160]),1,1,9000,10000),false);
 assert.equal(canCarryObservationForward(analyzed,new Uint8Array([21,41,61,81]),2,1,9000,10000),false);
 assert.equal(canCarryObservationForward(analyzed,new Uint8Array([21,41,61,81]),1,1,5000,10000),false);
});
test('expiry discovered inside preflight still forces unchanged pixels and semantics',()=>{
 const e=new Engine();e.start('cup','right');e.lockTarget({id:'cup',description:'cup',box:{left:.2,top:.2,right:.8,bottom:.8},referenceJpeg:''});
 const f:Frame={id:1,jpeg:'',capturedAt:123,receivedAt:1000,revision:e.revision};
 e.apply({action:'STEP_FORWARD',reason:''},obs,f,1000);
 assert.equal(e.preflight(obs,{...f,id:2,receivedAt:2999},3001),false);assert.equal(e.needsFresh,true);
 assert.equal(e.tick(3002),false); // Timer no longer sees the expiry: freshness must drive both gates.
 assert.equal(shouldAnalyze(0,1,e.needsFresh),true);const k=semanticKey(obs,e.phase);assert.equal(shouldReason(k,k,e.needsFresh),true);
});
