import 'dotenv/config';
import dotenv from 'dotenv';
import express from 'express';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { WebSocketServer, WebSocket } from 'ws';
import sharp from 'sharp';
import { z } from 'zod';
import { Engine, chooseCandidate } from './engine.js';
import { GeminiService, GeminiTransientError } from './gemini.js';
import { PacedCycle } from './paced.js';
import { CueGate } from './cueGate.js';
import { canCarryObservationForward } from './gates.js';
import type { Frame, Metrics, Observation, ServerMessage } from '../shared/protocol.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const requestedPort=process.env.PORT;
dotenv.config({path:path.join(root,'.env.local'),override:true});
const gemini=new GeminiService();
const app=express(); app.disable('x-powered-by');
app.use(express.json({limit:'4kb'}));
const server=createServer(app);
const accessCode=process.env.DEMO_ACCESS_CODE || '';
const tokens=new Map<string,number>();
const attempts=new Map<string,{count:number;until:number}>();
const authorized=(cookie='')=>{const t=cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('demo='))?.slice(5);return !!t&&(tokens.get(t)||0)>Date.now();};
app.get('/api/health',(_req,res)=>res.json({configured:gemini.configured&&!!accessCode}));
app.post('/api/login',(req,res)=>{
 const ip=req.socket.remoteAddress||'local'; let a=attempts.get(ip); if(!a||a.until<Date.now()){a={count:0,until:Date.now()+60000};attempts.set(ip,a);} if(++a.count>10){res.status(429).json({error:'Wait a minute before trying again.'});return;}
 const code=typeof req.body?.code==='string'?req.body.code:'';
 const x=Buffer.from(code), y=Buffer.from(accessCode);
 if(!accessCode||x.length!==y.length||!timingSafeEqual(x,y)){res.status(401).json({error:'Check the demo access code.'});return;}
 const token=randomBytes(32).toString('hex');tokens.set(token,Date.now()+12*3600000);
 res.setHeader('Set-Cookie',`demo=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${req.headers['x-forwarded-proto']==='https'?'; Secure':''}`);res.json({ok:true});
});
const wss=new WebSocketServer({noServer:true,maxPayload:400000});
server.on('upgrade',(req,socket,head)=>{
 let sameOrigin=false;try{sameOrigin=new URL(req.headers.origin||'').host===req.headers.host;}catch{}
 if(req.url!=='/stream'||!authorized(req.headers.cookie)||!sameOrigin||wss.clients.size>=2){socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');socket.destroy();return;}
 wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
});
const frameSchema=z.object({type:z.literal('frame'),id:z.number().int().nonnegative(),capturedAt:z.number().nonnegative().finite(),jpeg:z.string().max(380000),revision:z.number().int().nonnegative(),cycleId:z.number().int().nonnegative(),purpose:z.enum(['analysis','verification']),stable:z.boolean()}).strict();
const controlSchema=z.discriminatedUnion('type',[z.object({type:z.literal('start'),query:z.string().trim().min(1).max(120),hand:z.enum(['left','right'])}).strict(),...(['pause','resume','found','another'] as const).map(type=>z.object({type:z.literal(type)}).strict())]);
let globalBusy=0;
wss.on('connection',ws=>{
 const engine=new Engine(),cycle=new PacedCycle(),cueGate=new CueGate();
 const metrics:Metrics={frames:0,visualCalls:0,reasonCalls:0,visualSkipped:0,reasonSkipped:0,tokens:0,visionMs:0,reasonMs:0};
 let disposed=false,busy=false,lastHeartbeat=Date.now(),controlCount=0,controlWindow=Date.now();
 let analysis:{frame:Frame;gray:Buffer;observation:Observation}|null=null;
 const send=(m:ServerMessage)=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(m));};
 const publish=()=>{send({type:'state',state:engine.snapshot(metrics)});send({type:'cycle',cycle:cycle.snapshot(Date.now())});};
 const active=()=>!disposed&&!['paused','complete'].includes(engine.phase)&&!!engine.query;
 const schedule=(delay=4000,retry=false)=>{cycle.schedule(delay,Date.now(),retry);publish();};
 const request=(purpose:'analysis'|'verification')=>{const m=cycle.request(purpose,Date.now());publish();send(m);};
 send({type:'ready',configured:gemini.configured&&!!accessCode});publish();
 ws.on('message',data=>{
  void(async()=>{
   let messageRevision=engine.revision;
   try{
    const raw=JSON.parse(data.toString());
    if(raw.type==='frame')messageRevision=raw.revision;
    if(raw.type==='heartbeat'){if(Object.keys(raw).length===1)lastHeartbeat=Date.now();return;}
    if(raw.type==='frame'){
     // Reject unsolicited, duplicate and obsolete frames before decoding.
     if(!cycle.pending||raw.revision!==engine.revision||raw.cycleId!==cycle.id||raw.purpose!==cycle.pending.purpose)return;
     const m=frameSchema.parse(raw);if(!cycle.accept(m)||!active())return;
     const rev=engine.revision,id=cycle.id;
     const current=()=>active()&&engine.revision===rev&&cycle.current(id,rev);
     const frame:Frame={id:m.id,capturedAt:m.capturedAt,jpeg:m.jpeg,revision:rev,receivedAt:Date.now()};
     metrics.frames++;
     if(!/^[A-Za-z0-9+/]+={0,2}$/.test(frame.jpeg))throw Error('Invalid image.');
     const bytes=Buffer.from(frame.jpeg,'base64');
     const meta=await sharp(bytes,{limitInputPixels:2000000}).metadata();
     if(meta.format!=='jpeg'||!meta.width||!meta.height)throw Error('Invalid image.');
     const gray=await sharp(bytes,{limitInputPixels:2000000}).resize(32,24,{fit:'fill'}).grayscale().raw().toBuffer();
     if(!current())return;
     if(m.purpose==='verification'){
      const saved=analysis;analysis=null;
      if(!saved||!m.stable||!canCarryObservationForward(saved.gray,gray,rev,rev,frame.receivedAt,Date.now())){
       engine.wait('View changed; hold still for a new check.');schedule();return;
      }
      engine.decide(saved.observation,frame,Date.now());metrics.reasonSkipped++;
      const action=engine.command?.action;
      const movement=action&&(action.startsWith('ALIGN_')||action.startsWith('HAND_')||action==='STEP_FORWARD');
      if(movement&&!cueGate.allow(action,Date.now())){engine.wait('Repeated instruction suppressed; reassessing quietly.');schedule();return;}
      schedule();return;
     }
     if(busy||globalBusy>=2){engine.wait('Waiting for available analysis.');schedule();return;}
     busy=true;globalBusy++;metrics.visualCalls++;
     try{
      const started=Date.now();
      const result=await gemini.observe({frame,recent:[],target:engine.target,query:engine.query,hand:engine.hand,phase:engine.phase});
      metrics.visionMs=Date.now()-started;metrics.tokens+=result.tokens;
      if(!current())return;
      if(!engine.target){
       const c=chooseCandidate(result.observation.candidates);
       if(c&&result.observation.view==='usable'){
        const left=Math.floor(c.box.left*meta.width),top=Math.floor(c.box.top*meta.height);
        const width=Math.max(1,Math.min(meta.width-left,Math.ceil((c.box.right-c.box.left)*meta.width)));
        const height=Math.max(1,Math.min(meta.height-top,Math.ceil((c.box.bottom-c.box.top)*meta.height)));
        const referenceJpeg=(await sharp(bytes).extract({left,top,width,height}).resize({width:384,height:384,fit:'inside'}).jpeg().toBuffer()).toString('base64');
        if(!current())return;
        engine.lockTarget({id:randomBytes(8).toString('hex'),...c,referenceJpeg});
       }
       engine.observation=result.observation;engine.wait('Target selection checked; next assessment follows.');schedule();return;
      }
      analysis={frame,gray,observation:result.observation};request('verification');
     }catch(error){
      if(!current())return;
      analysis=null;
      if(error instanceof GeminiTransientError){engine.wait('Gemini is busy; hold still until retry.');schedule(error.retryAfterMs,true);return;}
      console.warn('Analysis failed; guidance paused.');
      engine.pause();cycle.reset(engine.revision,false,Date.now());send({type:'error',message:'Analysis unavailable. Guidance paused; retry when ready.'});publish();
     }finally{busy=false;globalBusy--;}
     return;
    }
    if(Date.now()-controlWindow>1000){controlWindow=Date.now();controlCount=0;}if(++controlCount>10)return;
    const m=controlSchema.parse(raw);
    if(m.type==='start')engine.start(m.query,m.hand);else if(m.type==='pause')engine.pause();else if(m.type==='resume')engine.resume();else if(m.type==='found')engine.found();else engine.another();
    analysis=null;cueGate.reset();lastHeartbeat=Date.now();cycle.reset(engine.revision,active(),Date.now());publish();
   }catch{if(disposed||messageRevision!==engine.revision)return;engine.pause();analysis=null;cycle.reset(engine.revision,false,Date.now());send({type:'error',message:'Invalid message. Guidance paused.'});publish();}
  })();
 });
 const timer=setInterval(()=>{
  if(!active())return;
  if(Date.now()-lastHeartbeat>3500){engine.pause();analysis=null;cycle.reset(engine.revision,false,Date.now());publish();return;}
  if(engine.tick(Date.now()))publish();
  if(cycle.pending&&Date.now()>=cycle.due){analysis=null;engine.wait('Camera capture timed out; hold still.');schedule();return;}
  if(['waiting','retry_wait'].includes(cycle.status)&&Date.now()>=cycle.due&&!busy&&globalBusy<2)request('analysis');
 },100);
 ws.on('close',()=>{disposed=true;analysis=null;clearInterval(timer);engine.pause();cycle.reset(engine.revision,false,Date.now());});
 ws.on('error',()=>ws.close());
});
app.use(express.static(path.join(root,'dist')));
app.get('*',(req,res)=>{if(existsSync(path.join(root,'dist/index.html')))res.sendFile(path.join(root,'dist/index.html'));else res.status(503).send('Build the frontend with pnpm build first.');});
app.use((_err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(400).json({error:'Invalid request.'}));
const port=Number(requestedPort||process.env.PORT||3000);
server.listen(port,'127.0.0.1',()=>console.log(`Find & Reach: http://127.0.0.1:${port} | Gemini ${gemini.configured?'configured':'key missing'} | access code ${accessCode?'configured':'missing'}`));
