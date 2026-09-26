import test from 'node:test';
import assert from 'node:assert/strict';
import {PacedCycle} from '../server/paced.js';

test('one requested frame per stage; duplicates and unsolicited verification rejected',()=>{
 const c=new PacedCycle();c.reset(1,true,0);
 const analysis=c.request('analysis',0);
 assert.equal(c.accept({...analysis,purpose:'verification'}),false);
 assert.equal(c.accept(analysis),true);assert.equal(c.accept(analysis),false);
 const verification=c.request('verification',4000);
 assert.equal(verification.cycleId,analysis.cycleId);
 assert.equal(c.accept(verification),true);assert.equal(c.accept(verification),false);
 c.schedule(4000,4100);assert.equal(c.status,'waiting');assert.equal(c.due,8100);
 assert.equal(c.snapshot(5100).delayMs,3000);
});

test('pause, completion and reset invalidate captures and late model responses',()=>{
 const c=new PacedCycle();c.reset(3,true,0);const request=c.request('analysis',0);
 c.reset(4,false,500);
 assert.equal(c.accept(request),false);assert.equal(c.current(request.cycleId,3),false);
 assert.equal(c.status,'idle');assert.equal(c.snapshot(500).delayMs,0);
 c.reset(5,true,1000);assert.equal(c.accept(request),false);
});

test('retry schedules no capture until its due time',()=>{
 const c=new PacedCycle();c.reset(1,true,0);c.request('analysis',0);c.schedule(10000,12000,true);
 assert.equal(c.pending,null);assert.equal(c.status,'retry_wait');assert.equal(c.due,22000);
 assert.equal(c.snapshot(12000).delayMs,10000);
});
