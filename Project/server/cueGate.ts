import type {Action} from '../shared/protocol.js';

/** Repeated movement is a new action, so it must be paced rather than replayed. */
export class CueGate {
 private last:Action|null=null;private at=-Infinity;
 reset(){this.last=null;this.at=-Infinity;}
 allow(action:Action,now:number){
  if(action===this.last&&now-this.at<8000)return false;
  this.last=action;this.at=now;return true;
 }
}
