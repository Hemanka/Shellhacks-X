const test=require('node:test'), assert=require('node:assert/strict');
const {NavigationController,delta}=require('../frontend/navigation-controller.js');
const {cameraHeading}=require('../frontend/orientation.js');
function harness() {
  let now=10000,seq=0; const outputs=[];
  const c=new NavigationController(x=>outputs.push(x)); c.reset('bottle');
  const orientation=(heading=0)=>({valid:true,heading,at:now,reference:'relative:0',screen:0});
  const scene=(patch={})=>({source:'gemini',decision:{action:'HOLD'},perception:{
    target:{visible:true,label:'bottle',direction:'CENTER',confidence:.95,bbox:[.4,.4,.6,.8],support:'floor',pickupSuitable:true},
    access:{approach:'clear',reach:'clear',reachability:'needs_approach',evidence:'Floor before item is visible'},
    sectors:{left:{status:'OPEN',confidence:.95},center:{status:'BLOCKED',confidence:.95},right:{status:'OPEN',confidence:.95}},obstacles:[],...patch}});
  function observe(patch={},age=100,heading=0) {const meta={stream:'s',seq:++seq,capturedAt:now-age,orientation:{...orientation(heading),at:now-age}};const r=scene(patch);c.observe(r,meta,now,orientation(heading));return {r,meta};}
  return {c,outputs,scene,observe,orientation,advance(ms){now+=ms;},now:()=>now,last:()=>outputs.at(-1)};
}
const close=(relationship='separate',label='chair')=>({label,relationship,direction:'CENTER',confidence:.95,proximity:'appears_close',proximityConfidence:.95,intrusion:'approach',evidence:'Object immediately occupies approach'});
test('wide alignment accepts centered target despite occupied target sector',()=>{const h=harness();h.observe();assert.equal(h.last().stage,'APPROACH');assert.match(h.last().text,/one small step/);assert.equal(h.c.memory,null);});
test('two consistent offsets needed and borderline jitter stays quiet',()=>{
  const h=harness();h.observe(); h.advance(1000);
  h.observe({target:{...h.scene().perception.target,bbox:[.72,.4,.82,.8]}});assert.equal(h.outputs.length,1);
  h.observe({target:{...h.scene().perception.target,bbox:[.82,.4,.98,.8]}});assert.notEqual(h.last().key,'align:right');
  h.observe({target:{...h.scene().perception.target,bbox:[.82,.4,.98,.8]}});assert.equal(h.last().key,'align:right');
});
test('duplicate and stale frames never authorize additional physical action',()=>{const h=harness();const {r,meta}=h.observe();const n=h.outputs.length;h.c.observe(r,meta,h.now(),h.orientation());assert.equal(h.outputs.length,n);h.advance(5000);h.observe({},11000);assert.equal(h.last().physical,false);assert.equal(h.last().stage,'HOLD');});
test('two fresh reach assessments enter pickup without hand fields',()=>{const h=harness();const access={approach:'clear',reach:'clear',reachability:'easily_reachable',evidence:'Floor and item reachable from current view'};h.observe({access});assert.notEqual(h.last().stage,'PICKUP');h.advance(500);h.observe({access});assert.equal(h.last().stage,'PICKUP');assert.match(h.last().text,/floor/);assert.equal(h.c.command('got it',h.now()),'complete');});
test('target hazard warns then transitions to pickup rather than looping stop',()=>{const h=harness();const p={access:{approach:'clear',reach:'clear',reachability:'easily_reachable',evidence:'Reach area visible'},obstacles:[close('target_itself','bottle')]};h.observe(p);assert.equal(h.last().type,'hazard');h.advance(500);h.observe(p);assert.equal(h.last().stage,'PICKUP');});
test('separate close obstruction prevents pickup and names obstacle',()=>{const h=harness();const p={access:{approach:'blocked',reach:'blocked',reachability:'easily_reachable',evidence:'Chair blocks reach'},obstacles:[close()]};h.observe(p);h.advance(500);h.observe(p);assert.equal(h.c.stage,'HOLD');assert.match(h.last().text,/chair/);});
test('hazards repeat only on newer evidence at four second intervals',()=>{const h=harness();h.observe({obstacles:[close()]});h.advance(500);h.observe({obstacles:[close()]});assert.equal(h.outputs.length,1);h.advance(4000);h.observe({obstacles:[close()]});assert.equal(h.outputs.length,2);});
test('hazard clearing needs two clear assessments',()=>{const h=harness();h.observe({obstacles:[close()]});h.advance(500);h.observe();assert.ok(h.c.hazard);h.advance(500);h.observe();assert.equal(h.c.hazard,null);assert.ok(h.outputs.some(x=>x.type==='cancel_hazard'));});
test('unknown identity is not invented and target is named as target',()=>{const h=harness();h.observe({obstacles:[close('separate','')]});assert.match(h.last().text,/an obstacle/);});
test('pickup loss asks for confirmation, not automatic success',()=>{const h=harness();h.c.pickupPending=true;h.c.stage='PICKUP';h.observe({target:{visible:false}});assert.match(h.last().text,/Did you pick it up/);assert.equal(h.c.stage,'PICKUP');h.c.command('lost it',h.now());assert.equal(h.c.pickupPending,false);});
test('cannot reach exits pickup; done outside pickup does not change target',()=>{const h=harness();h.c.pickupPending=true;assert.equal(h.c.command("can't reach it",h.now()),'handled');assert.equal(h.c.pickupPending,false);assert.equal(h.c.command('done',h.now()),'handled');assert.equal(h.c.target,'bottle');assert.notEqual(h.c.stage,'COMPLETE');});
test('door and big bbox alone do not establish pickup',()=>{const h=harness();h.observe({target:{...h.scene().perception.target,pickupSuitable:false,bbox:[0,0,1,1]},access:{approach:'clear',reach:'clear',reachability:'uncertain',evidence:'Door occupies image'}});assert.notEqual(h.c.stage,'PICKUP');});
test('recent viewing orientation corrects right overshoot left without another model',()=>{const h=harness();h.observe({access:{approach:'uncertain'}});h.advance(500);h.observe({target:{visible:false}},100,30);h.advance(301);h.c.tick(h.now(),h.orientation(30));assert.equal(h.last().stage,'RECOVER');assert.match(h.last().text,/left/);});
test('recovery reverses for left overshoot and handles north wrap',()=>{assert.equal(delta(359,1),-2);const h=harness();h.observe({access:{approach:'uncertain'}},100,30);h.advance(500);h.observe({target:{visible:false}},100,0);h.advance(301);h.c.tick(h.now(),h.orientation(0));assert.match(h.last().text,/right/);});
test('sensor reset, stale sensors, walking and age invalidate memory',()=>{for(const mode of ['reset','stale','age','walking']){const h=harness();h.observe({access:{approach:'uncertain'}});if(mode==='walking')h.c.invalidate('Walking instruction issued');else {if(mode==='age')h.advance(13000);const o=h.orientation();if(mode==='reset')o.reference='relative:1';if(mode==='stale')o.at-=501;h.c.tick(h.now(),o);}assert.equal(h.c.memory,null,mode);}});
test('camera azimuth supports upright portrait, landscape, and rejects vertical',()=>{assert.equal(cameraHeading(0,90,0),0);assert.equal(cameraHeading(90,90,0),270);assert.equal(cameraHeading(0,0,0),null);assert.equal(cameraHeading(0,0,90),270);assert.equal(cameraHeading(null,0,0),null);});
test('sessions keep independent targets and history',()=>{const a=harness(),b=harness();a.observe();assert.equal(b.c.history.length,0);b.c.reset('keys');assert.equal(a.c.target,'bottle');});


test('slow results remain valid when no movement instruction intervened',()=>{
 const h=harness();h.observe({},6000);assert.equal(h.last().stage,'APPROACH');assert.equal(h.last().physical,true);
 h.advance(22000);h.observe({},21000);assert.equal(h.last().physical,true);assert.equal(h.last().expiresAt,null);
});
test('blank camera prompts a clearer view rather than blaming latency',()=>{
 const h=harness();const meta={stream:'s',seq:1,capturedAt:h.now()-50,orientation:null};
 h.c.observe({...h.scene(),source:'insufficient_image'},meta,h.now(),h.orientation());
 assert.equal(h.last().key,'camera-detail');assert.match(h.last().text,/too little detail/);
});
test('old target-missing result encourages search without walking',()=>{
 const h=harness();h.observe({target:{visible:false}},11000);
 assert.equal(h.last().stage,'SEARCH');assert.equal(h.last().physical,false);assert.match(h.last().text,/look around/);
});

test('uncertain proximity never announces a distant object as close',()=>{
 const h=harness();h.observe({obstacles:[{...close(),proximityConfidence:.4}]});
 assert.notEqual(h.last().type,'hazard');assert.doesNotMatch(h.last().text,/is close/);
});
test('cup on trash can reaches pickup while support still blocks walking',()=>{
 const h=harness();const obstacles=[close('target_support','trash can')];
 h.observe({obstacles,access:{approach:'blocked',reach:'clear',reachability:'needs_approach',evidence:'Can occupies destination'}});
 assert.notEqual(h.last().stage,'APPROACH');
 const access={approach:'blocked',reach:'clear',reachability:'easily_reachable',evidence:'Cup on top with clear reach'};
 h.advance(500);h.observe({obstacles,access});h.advance(500);h.observe({obstacles,access});
 assert.equal(h.last().stage,'PICKUP');assert.match(h.last().text,/on the trash can/);
});
test('support does not hide separate close obstruction during pickup',()=>{
 const h=harness();const p={obstacles:[close('target_support','trash can'),close('separate','chair')],access:{approach:'blocked',reach:'blocked',reachability:'easily_reachable',evidence:'Chair obstructs reach'}};
 h.observe(p);h.advance(500);h.observe(p);assert.equal(h.last().type,'hazard');assert.match(h.last().text,/chair/);
});

for (const label of ['table','counter','shelf','chair','cabinet','trash can','unfamiliar stand']) {
 test(`approach distant ${label}, stop at support, then reach item`,()=>{
  const h=harness();const support={...close('target_support',label),proximity:'not_close'};
  h.observe({obstacles:[support]});assert.equal(h.last().stage,'APPROACH');
  h.advance(1000);h.observe({obstacles:[{...support,proximity:'appears_close'}],access:{approach:'blocked',reach:'clear',reachability:'easily_reachable',evidence:'Item accessible on support'}});
  assert.equal(h.last().type,'hazard');
  h.advance(1000);h.observe({obstacles:[{...support,proximity:'appears_close'}],access:{approach:'blocked',reach:'clear',reachability:'easily_reachable',evidence:'Item accessible on support'}});
  assert.equal(h.last().stage,'PICKUP');assert.ok(h.last().text.includes(`on the ${label}`));
 });
}
test('distant support does not override blocked or uncertain approach',()=>{
 for(const approach of ['blocked','uncertain']) {
  const h=harness();h.observe({obstacles:[{...close('target_support','table'),proximity:'not_close'}],access:{approach,reach:'uncertain',reachability:'needs_approach',evidence:'Approach is not established'}});
  assert.notEqual(h.last().stage,'APPROACH');
 }
});
test('separate obstacle still blocks the path to a distant support',()=>{
 const h=harness();h.observe({obstacles:[{...close('target_support','counter'),proximity:'not_close'},{...close('separate','box'),proximity:'not_close'}]});
 assert.notEqual(h.last().stage,'APPROACH');assert.match(h.last().text,/box/);
});
test('near support with blocked reach never authorizes pickup',()=>{
 const h=harness();const p={obstacles:[close('target_support','cabinet')],access:{approach:'blocked',reach:'blocked',reachability:'uncertain',evidence:'Item behind glass'}};
 h.observe(p);h.advance(1000);h.observe(p);assert.notEqual(h.last().stage,'PICKUP');assert.notEqual(h.last().stage,'APPROACH');
});

test('new frame captured before last instruction cannot authorize another step',()=>{
 const h=harness();h.observe();h.advance(15000);h.observe({},16000);
 assert.equal(h.last().key,'await-post-movement-view');assert.equal(h.last().physical,false);
 h.advance(1000);h.observe();assert.equal(h.last().stage,'APPROACH');
});
test('major rotation invalidates pending result but small jitter does not',()=>{
 for (const heading of [3,35]) {
  const h=harness();const meta={stream:'s',seq:1,capturedAt:h.now()-15000,orientation:{...h.orientation(0),at:h.now()-15000}};
  h.c.observe(h.scene(),meta,h.now(),h.orientation(heading));
  assert.equal(h.last().stage,heading===3?'APPROACH':'HOLD');
 }
});

function routeHarness() {
 const h=harness();h.c.config.routeMode=true;
 h.mask=(routes=[{direction:'CENTER',action:'FORWARD',points:[[.5,.95],[.5,.6]]}])=>h.c.observeRoute({pathPlan:{routes}},{stream:'s',seq:Math.floor(h.now()),capturedAt:h.now()-20,orientation:h.orientation()},h.now(),h.orientation());
 return h;
}
test('NVIDIA route overrides broad Gemini approach warning',()=>{
 const h=routeHarness();h.observe({access:{approach:'blocked',reach:'uncertain',reachability:'needs_approach'},obstacles:[close()]});
 h.mask();assert.equal(h.last().stage,'APPROACH');assert.equal(h.last().source,'nvidia_route');
});
test('no floor route holds even if Gemini thinks approach is open',()=>{
 const h=routeHarness();h.observe();h.mask([]);assert.equal(h.last().key,'route:blocked');
});
test('NVIDIA continues without another Gemini response and cannot reuse pre-step frame',()=>{
 const h=routeHarness();h.observe();h.mask();const n=h.outputs.length;h.mask();assert.equal(h.outputs.length,n);
 h.advance(9000);h.mask();assert.equal(h.outputs.length,n+1);assert.equal(h.last().source,'nvidia_route');
});
test('mask route cannot bypass pickup or move without a target',()=>{
 const h=routeHarness();h.mask();assert.equal(h.outputs.length,0);
 const access={approach:'blocked',reach:'clear',reachability:'easily_reachable',evidence:'Reach is clear'};
 h.observe({access});h.advance(500);h.observe({access});assert.equal(h.last().stage,'PICKUP');
 const n=h.outputs.length;h.advance(9000);h.mask();assert.equal(h.outputs.length,n);
});
test('NVIDIA turns need two consistent masks',()=>{
 const h=routeHarness();h.observe();const r=[{direction:'LEFT',action:'TURN_LEFT'}];h.mask(r);assert.equal(h.outputs.length,0);
 h.advance(500);h.mask(r);assert.equal(h.last().stage,'ALIGN');
});

test('named warning needs blocked floor path and near-center obstacle overlap',()=>{
 const h=routeHarness();h.observe({obstacles:[{...close('separate','chair'),bbox:[.4,.4,.7,.95]}]});
 h.mask([]);assert.equal(h.last().type,'hazard');assert.match(h.last().text,/chair/);
});
test('lost target suspends mask walking until reacquired',()=>{
 const h=routeHarness();h.observe();h.mask();h.advance(1000);h.observe({target:{visible:false}});
 const n=h.outputs.length;h.advance(9000);h.mask();assert.equal(h.outputs.length,n);
});
test('turning away from remembered target prevents NVIDIA following old target coordinates',()=>{
 const h=routeHarness();h.observe();h.advance(1000);
 h.c.observeRoute({pathPlan:{routes:[{direction:'CENTER',action:'FORWARD'}]}},{stream:'s',seq:10,capturedAt:h.now()-20,orientation:h.orientation(40)},h.now(),h.orientation(40));
 assert.equal(h.last().key,'route:relocalize');assert.equal(h.c.routeScene,null);
});

test('incomplete reach assessment cannot latch out a valid NVIDIA approach',()=>{
 const h=routeHarness();h.observe({access:{approach:'clear',reach:'uncertain',reachability:'easily_reachable',evidence:''}});
 h.mask();assert.equal(h.last().stage,'APPROACH');
});
test('too far releases early reach hold and rechecks pickup after another step',()=>{
 const h=routeHarness();const access={approach:'clear',reach:'clear',reachability:'easily_reachable',evidence:'Appears reachable'};
 h.observe({access});assert.equal(h.last().key,'check-reach');
 h.c.command('too far',h.now());h.advance(500);h.observe({access});h.mask();
 assert.equal(h.last().stage,'APPROACH');assert.equal(h.c.reachRejected,true);
 h.advance(1000);h.observe({access});assert.equal(h.c.reachRejected,false);assert.equal(h.c.reachCount,1);
 h.advance(500);h.observe({access});assert.equal(h.last().stage,'PICKUP');
});
test('too far cannot force movement through a blocked NVIDIA route',()=>{
 const h=routeHarness();h.observe();h.c.command("can't reach it",h.now());h.advance(500);h.mask([]);
 assert.equal(h.last().key,'route:blocked');
});
test('inconsistent reach assessment releases hold rather than repeating it forever',()=>{
 const h=routeHarness();h.observe({access:{reach:'clear',reachability:'easily_reachable',evidence:'Reach appears clear'}});
 h.advance(1000);h.observe({access:{reach:'uncertain',reachability:'easily_reachable',evidence:'Unsure of reach'}});h.mask();
 assert.equal(h.last().stage,'APPROACH');
});

test('likely reachable never authorizes pickup or stalls a clear NVIDIA route',()=>{
 const h=routeHarness();const access={approach:'clear',reach:'clear',reachability:'likely_reachable',evidence:'Possible at full arm extension'};
 h.observe({access});h.advance(500);h.observe({access});assert.equal(h.c.reachCount,0);assert.equal(h.c.pickupPending,false);
 h.mask();assert.equal(h.last().stage,'APPROACH');
});
test('legacy guidance also requires easy reach, not merely likely reach',()=>{
 const h=harness();const access={approach:'clear',reach:'clear',reachability:'likely_reachable',evidence:'Could maybe reach'};
 h.observe({access});h.advance(500);h.observe({access});assert.notEqual(h.last().stage,'PICKUP');
});
