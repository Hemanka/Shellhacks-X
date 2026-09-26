import type {CycleStatus,CaptureRequest} from '../shared/protocol.js';

/** One requested capture at a time; cycle/revision pairs invalidate late work. */
export class PacedCycle {
 id=0;revision=0;status:CycleStatus['status']='idle';due=Infinity;
 pending:CaptureRequest|null=null;
 reset(revision:number,active:boolean,now:number){this.id++;this.revision=revision;this.pending=null;this.status=active?'waiting':'idle';this.due=active?now:Infinity;}
 schedule(delayMs:number,now:number,retry=false){this.pending=null;this.status=retry?'retry_wait':'waiting';this.due=now+delayMs;}
 snapshot(now:number):CycleStatus{return {id:this.id,revision:this.revision,status:this.status,delayMs:Number.isFinite(this.due)?Math.max(0,this.due-now):0};}
 request(purpose:CaptureRequest['purpose'],now:number):CaptureRequest{
  if(purpose==='analysis')this.id++;
  this.status=purpose==='analysis'?'analyzing':'verifying';this.due=now+5000;
  return this.pending={type:'capture',cycleId:this.id,revision:this.revision,purpose};
 }
 accept(frame:{cycleId:number;revision:number;purpose:string}):boolean{
  const p=this.pending;
  if(!p||p.cycleId!==frame.cycleId||p.revision!==frame.revision||p.purpose!==frame.purpose)return false;
  this.pending=null;this.due=Infinity;return true;
 }
 current(id:number,revision:number){return this.id===id&&this.revision===revision&&this.status!=='idle';}
}
