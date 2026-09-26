import test from 'node:test';
import assert from 'node:assert/strict';
import {CueGate} from '../server/cueGate.js';
test('repeated cues are paced; changed direction can update immediately',()=>{
 const gate=new CueGate();assert.equal(gate.allow('ALIGN_RIGHT',0),true);
 assert.equal(gate.allow('ALIGN_RIGHT',3000),false);
 assert.equal(gate.allow('ALIGN_RIGHT',8000),true);
 assert.equal(gate.allow('ALIGN_LEFT',8500),true);
 gate.reset();assert.equal(gate.allow('ALIGN_LEFT',8600),true);
});
