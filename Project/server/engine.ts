import type {Action,Candidate,Command,Frame,Metrics,Observation,Phase,Proposal,Snapshot,Target} from '../shared/protocol.js';
const MOTION_MS=2000, MAX_FRAME_AGE_MS=4000;
const moving=new Set<Action>(['ALIGN_LEFT','ALIGN_RIGHT','STEP_FORWARD','HAND_LEFT','HAND_RIGHT','HAND_UP','HAND_DOWN','HAND_FORWARD','HAND_BACK']);
const words:Record<Action,string>={STOP:'Stop.',ALIGN_LEFT:'Turn left, then stop.',ALIGN_RIGHT:'Turn right, then stop.',STEP_FORWARD:'One small step, then stop.',HAND_LEFT:'Hand left.',HAND_RIGHT:'Hand right.',HAND_UP:'Hand up.',HAND_DOWN:'Hand down.',HAND_FORWARD:'Hand forward.',HAND_BACK:'Hand back.',HOLD:'',ADJUST_VIEW:'Adjust the camera.',NO_CHANGE:'',COMPLETE:'Object found. Guidance complete.'};
export function expectedMovement(obs:Observation,phase:Phase):Action|null {
 if(phase==='approaching')return obs.direction==='left'?'ALIGN_LEFT':obs.direction==='right'?'ALIGN_RIGHT':obs.direction==='center'?'STEP_FORWARD':null;
 if(phase==='reaching'){
  const corrections:Partial<Record<Observation['handCorrection'],Action>>={left:'HAND_LEFT',right:'HAND_RIGHT',up:'HAND_UP',down:'HAND_DOWN',forward:'HAND_FORWARD',back:'HAND_BACK'};
  return corrections[obs.handCorrection]??null;
 }
 return null;
}
export function shouldStopApproach(obs:Observation):boolean {
 if(obs.targetMatch!=='matched')return false;
 if(obs.proximity==='near')return true;
 if(obs.targetBox){
  const width=obs.targetBox.right-obs.targetBox.left,height=obs.targetBox.bottom-obs.targetBox.top;
  if(width>=.7||height>=.7)return true;
 }
 return false;
}
export function chooseCandidate(candidates:Candidate[],preference:'center'|'area'|'left'='center'):Candidate|null {
 const area=(c:Candidate)=>(c.box.right-c.box.left)*(c.box.bottom-c.box.top);
 const center=(c:Candidate)=>(c.box.left+c.box.right)/2;
 const score=(c:Candidate)=>preference==='area'?-area(c):preference==='left'?center(c):Math.abs(center(c)-.5);
 return candidates.filter(c=>c.usable).map((c,i)=>({c,i})).sort((a,b)=>score(a.c)-score(b.c)||area(b.c)-area(a.c)||a.c.box.left-b.c.box.left||a.i-b.i)[0]?.c??null;
}
export class Engine {
 revision=0; phase:Phase='searching';target:Target|null=null;observation:Observation|null=null;command:Command|null=null;
 query='';hand:'left'|'right'='right';
 private sequence=0;private restorePhase:Phase='searching';private deadline:number|null=null;private freshAfter=-Infinity;private stoppedAt:number|null=null;
 private freshPending=false;
 private reachConfirmations=0;private lastReachFrame=-1;
 get needsFresh():boolean {return this.freshPending;}
 private emit(action:Action,reason:string,frame?:Frame,now=Date.now()):void {
  this.command={id:++this.sequence,frameId:frame?.id??-1,capturedAt:frame?.capturedAt??0,revision:this.revision,phase:this.phase,action,text:words[action],reason,expiresInMs:moving.has(action)?MOTION_MS:0};
  this.deadline=moving.has(action)?now+MOTION_MS:null;
 }
 start(query:string,hand:'left'|'right'):void {this.revision++;this.query=query;this.hand=hand;this.phase='searching';this.target=null;this.observation=null;this.restorePhase='searching';this.freshAfter=-Infinity;this.freshPending=false;this.stoppedAt=null;this.reachConfirmations=0;this.lastReachFrame=-1;this.emit('STOP','New search started.');}
 pause():void {this.revision++;this.reachConfirmations=0;this.lastReachFrame=-1;if(this.phase!=='paused')this.restorePhase=this.phase==='recovering'?this.restorePhase:this.phase;this.phase='paused';this.emit('STOP','Guidance paused.');}
 wait(reason:string):void {if(this.phase==='paused'||this.phase==='complete')return;this.emit('HOLD',reason);}
 resume():void {this.revision++;if(this.phase==='paused'||this.phase==='recovering')this.phase=this.restorePhase;this.emit('STOP','Guidance resumed; waiting for a new observation.');}
 found():void {this.revision++;this.phase='complete';this.restorePhase='complete';this.emit('COMPLETE','User confirmed object found.');}
 another():void {this.start(this.query,this.hand);}
 lockTarget(target:Target):void {if(this.target||this.phase==='paused'||this.phase==='complete')return;this.target=structuredClone(target);this.phase='approaching';this.restorePhase='approaching';}
 private recover(reason:string,frame:Frame,now:number,adjust=false):false {this.reachConfirmations=0;this.lastReachFrame=-1;if(this.phase!=='recovering')this.restorePhase=this.phase;this.phase='recovering';this.emit(adjust?'ADJUST_VIEW':'STOP',reason,frame,now);return false;}
 preflight(obs:Observation,frame:Frame,now=Date.now()):boolean {
  if(frame.revision!==this.revision)return false;
  this.tick(now);this.observation=structuredClone(obs);
  if(this.phase==='paused'||this.phase==='complete')return false;
  if(frame.receivedAt>now||now-frame.receivedAt>MAX_FRAME_AGE_MS)return this.recover('Observation is stale.',frame,now);
  if(!this.target){this.emit('STOP','Waiting to select a target.',frame,now);return false;}
  if(obs.view!=='usable')return this.recover('Camera view is not usable.',frame,now,true);
  if(obs.targetMatch!=='matched'||obs.uncertain)return this.recover('Target identity is uncertain.',frame,now);
  if(this.phase==='recovering')this.phase=this.restorePhase;
  if(frame.receivedAt<=this.freshAfter){this.emit('STOP','A new frame is required after movement expired.',frame,now);return false;}
  this.freshPending=false;
  if(this.phase==='reaching'){
   if(!obs.handVisible||obs.handCorrection==='unknown'||obs.handCorrection==='adjust_view'){this.emit('ADJUST_VIEW','Hand correction cannot be verified.',frame,now);return false;}
   if(obs.handCorrection==='hold'){this.emit('HOLD','Keep hand still.',frame,now);return false;}
   if(this.deadline!==null)return false;
   return true;
  }
  // Proximity is contextual so this works for both small and large objects.
  // Screen coverage is used only as an emergency stop, never as reachability.
  if(shouldStopApproach(obs)||this.phase==='stopping'||obs.reachability==='within_reach'){
   const entering=this.phase!=='stopping';
   if(entering){this.phase='stopping';this.restorePhase='stopping';this.stoppedAt=now;this.reachConfirmations=0;}
   if(!entering&&frame.receivedAt<=(this.stoppedAt??now)+MOTION_MS){this.emit('STOP','Waiting for a new frame after stopping.',frame,now);return false;}
   if(obs.reachability==='within_reach'&&obs.handVisible){
    if(frame.id!==this.lastReachFrame){this.lastReachFrame=frame.id;this.reachConfirmations++;}
    if(this.reachConfirmations>=2&&now>=(this.stoppedAt??now)+MOTION_MS){this.phase='reaching';this.restorePhase='reaching';this.emit('HOLD','Reach confirmed twice; hand guidance begins.',frame,now);return false;}
    this.emit('STOP','Stop; confirming stationary reach.',frame,now);return false;
   }
   this.reachConfirmations=0;
   if(!entering&&obs.reachability==='out_of_reach'&&obs.direction!=='unknown'){
    const b=obs.targetBox;
    if(b&&(b.right-b.left>=.7||b.bottom-b.top>=.7)){this.emit('ADJUST_VIEW','Target fills view; verify geometry before walking.',frame,now);return false;}
    this.phase='approaching';this.restorePhase='approaching';
   }else{this.emit(obs.reachability==='uncertain'?'ADJUST_VIEW':'STOP','Stop; show the selected hand and target to assess reach.',frame,now);return false;}
  }
  if(obs.proximity==='uncertain'||obs.direction==='unknown')return this.recover('Approach geometry is uncertain.',frame,now);
  if(this.deadline!==null)return false;
  return this.phase==='approaching';
 }
 apply(proposal:Proposal,obs:Observation,frame:Frame,now=Date.now()):void {
  if(!this.preflight(obs,frame,now))return;
  const allowed:Action=expectedMovement(obs,this.phase)??'STOP';
  if(['STOP','HOLD','NO_CHANGE'].includes(proposal.action)){this.emit(proposal.action==='STOP'?'STOP':'HOLD','Reasoner requested no movement.',frame,now);return;}
  if(proposal.action!==allowed){this.emit('STOP','Action does not match observation and phase.',frame,now);return;}
  this.emit(allowed,'Action matches observation and phase.',frame,now);
 }
 decide(obs:Observation,frame:Frame,now=Date.now()):void {
  if(!this.preflight(obs,frame,now))return;
  this.emit(expectedMovement(obs,this.phase)??'HOLD','Action matches observation and phase.',frame,now);
 }
 tick(now=Date.now()):boolean {if(this.deadline===null||now<this.deadline)return false;this.freshAfter=Math.max(this.freshAfter,this.deadline);this.freshPending=true;this.emit('STOP','Movement expired; waiting for fresh frame.',undefined,now);return true;}
 snapshot(metrics:Metrics):Snapshot {const target=this.target?{id:this.target.id,description:this.target.description,box:structuredClone(this.target.box)}:null;return {revision:this.revision,phase:this.phase,target,command:this.command?structuredClone(this.command):null,observation:this.observation?structuredClone(this.observation):null,metrics:{...metrics}};}
}
