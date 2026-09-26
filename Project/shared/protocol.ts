import { z } from 'zod';
export const boxSchema = z.object({left:z.number().min(0).max(1),top:z.number().min(0).max(1),right:z.number().min(0).max(1),bottom:z.number().min(0).max(1)}).strict().refine(b=>b.right>b.left&&b.bottom>b.top);
export const candidateSchema=z.object({description:z.string().max(240),box:boxSchema,usable:z.boolean()}).strict();
export const observationSchema=z.object({view:z.enum(['usable','blurred','obstructed']),candidates:z.array(candidateSchema).max(12),targetMatch:z.enum(['matched','ambiguous','lost']),targetBox:boxSchema.nullable(),targetScale:z.enum(['none','small','medium','large']),direction:z.enum(['left','center','right','unknown']),proximity:z.enum(['far','approaching','near','uncertain']),reachability:z.enum(['within_reach','out_of_reach','uncertain']),handVisible:z.boolean(),handCorrection:z.enum(['left','right','up','down','forward','back','hold','adjust_view','unknown']),uncertain:z.boolean(),evidence:z.string().max(400)}).strict();
export const actions=['STOP','ALIGN_LEFT','ALIGN_RIGHT','STEP_FORWARD','HAND_LEFT','HAND_RIGHT','HAND_UP','HAND_DOWN','HAND_FORWARD','HAND_BACK','HOLD','ADJUST_VIEW','NO_CHANGE','COMPLETE'] as const;
export const proposalSchema=z.object({action:z.enum(actions),reason:z.string().max(300)}).strict();
export type Observation=z.infer<typeof observationSchema>;
export type Candidate=z.infer<typeof candidateSchema>;
export type Proposal=z.infer<typeof proposalSchema>;
export type Action=typeof actions[number];
export type Phase='searching'|'approaching'|'stopping'|'reaching'|'complete'|'paused'|'recovering';
export interface Frame {id:number;capturedAt:number;jpeg:string;receivedAt:number;revision:number}
export interface Target {id:string;description:string;box:Candidate['box'];referenceJpeg:string}
export interface Command {id:number;frameId:number;capturedAt:number;revision:number;phase:Phase;action:Action;text:string;reason:string;expiresInMs:number}
export interface Metrics {frames:number;visualCalls:number;reasonCalls:number;visualSkipped:number;reasonSkipped:number;tokens:number;visionMs:number;reasonMs:number}
export interface Snapshot {revision:number;phase:Phase;target:Omit<Target,'referenceJpeg'>|null;command:Command|null;observation:Observation|null;metrics:Metrics}
export interface CycleStatus {id:number;revision:number;status:'idle'|'waiting'|'analyzing'|'verifying'|'retry_wait';delayMs:number}
export type CaptureRequest={type:'capture';cycleId:number;revision:number;purpose:'analysis'|'verification'};
export type ClientMessage={type:'start';query:string;hand:'left'|'right'}|{type:'frame';id:number;capturedAt:number;jpeg:string;revision:number;cycleId:number;purpose:'analysis'|'verification';stable:boolean}|{type:'heartbeat'}|{type:'pause'|'resume'|'found'|'another'};
export type ServerMessage={type:'state';state:Snapshot}|{type:'cycle';cycle:CycleStatus}|CaptureRequest|{type:'error';message:string}|{type:'ready';configured:boolean};
