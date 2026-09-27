/* Separate foreground-only experiment; the Standard phone controller is unchanged. */
const hf={socket:null,stream:null,context:null,node:null,source:null,dashboard:false,ready:false,connecting:false,revision:0,running:false,seq:0,dropped:0,window:false,prompt:null};
const element=id=>document.getElementById(id), video=element('phone-video'), canvas=document.createElement('canvas');
const session=new URLSearchParams(location.search).get('session');
const streamId=`hf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const gate=new HandsfreeAudio.VoiceGate();
function send(message) {if(hf.socket?.readyState===WebSocket.OPEN)hf.socket.send(JSON.stringify(message));}
function report(values) {send({type:'phone_status',...Object.fromEntries(Object.entries(values).map(([k,v])=>[k,String(v)]))});}
function closeWindow(invalidate=true) {hf.window=false;hf.prompt=null;if(invalidate)gate.until=0;send({type:'listening',active:false});report({command_window:'closed'});}
function recover(message) {
  hf.ready=false;queue.clear();hf.node?.port.postMessage('reset');closeWindow();feedback.cancel();send({type:'control',action:'pause'});
  element('setup').hidden=false;element('status').textContent=message;
}
const speech=new WayfinderSpeech((state,detail)=>{
  report({speech:state,detail:detail || ''});
  if(state==='blocked')recover('Tap Enable hands-free to activate spoken audio again.');
});
const speakOriginal=speech.speak.bind(speech);
speech.speak=(text,valid)=>{
  // Never speak the trigger, including a target name containing it.
  text=text.replace(/hey\s+way\s?finder/gi,'Wayfinder');
  gate.remember(text,performance.now());return speakOriginal(text,valid);
};
const orientation=new PhoneOrientation(detail=>report({orientation:detail}));
const feedback=new PhoneFeedback(speech,(kind,detail)=>report({[kind==='haptics'?'haptics':'detail']:detail}),()=>{},()=>{
  queue.clear();hf.node?.port.postMessage('reset');closeWindow();
});
function openWindow(prompt) {
  feedback.cancel();hf.window=true;hf.prompt=prompt;hf.ackDeadline=performance.now()+4000;
  send({type:'listening',active:true});report({command_window:'waiting for dashboard acknowledgement'});
}
function playPrompt() {
  const prompt=hf.prompt;hf.prompt=null;gate.open(performance.now());
  report({command_window:'open for 8 seconds'});speech.speak(prompt);
}
const queue=new HandsfreeAudio.ClipQueue(async (clip,signal)=>{
  const start=performance.now(),form=new FormData();
  form.append('file',new Blob([HandsfreeAudio.wav(clip.samples,clip.rate)],{type:'audio/wav'}),'command.wav');
  report({clip_ms:Math.round(clip.samples.length/clip.rate*1000)});
  const response=await fetch('/api/transcribe',{method:'POST',body:form,signal});
  if(!response.ok)throw new Error('Transcription unavailable');
  const result=await response.json();return {text:result.text,ms:performance.now()-start};
},(result,clip)=>{
  if(!hf.ready || !hf.dashboard)return;
  const decision=gate.accept(result.text,performance.now(),clip.at);
  report({transcription_ms:Math.round(result.ms),wake:decision.kind,echo:decision.kind==='echo'?'rejected':'no'});
  if(decision.kind==='ignored' || decision.kind==='echo')return;
  feedback.cancel();
  if(decision.kind==='wake') {openWindow('Listening.');return;}
  closeWindow();report({parsed_intent:JSON.stringify(parseIntent(decision.text))});
  send({type:'transcript',text:decision.text});
},()=>{report({dropped_clips:++hf.dropped});},()=>report({detail:'Transcription failed; say your request again.'}));
function permissions() {
  const audio=hf.stream?.getAudioTracks()[0];
  report({camera:hf.stream?.getVideoTracks()[0]?.readyState || 'not ready',microphone:audio?.readyState || 'not ready',audio_settings:JSON.stringify(audio?.getSettings() || {})});
}
function connect() {
  const socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws/pair/${session}?role=mobile`);hf.socket=socket;
  socket.onopen=permissions;
  socket.onmessage=event=>{
    if(hf.socket!==socket)return;
    const message=JSON.parse(event.data);
    if(message.type==='peer_status') {
      hf.dashboard=message.connected;
      if(!message.connected)recover('Computer disconnected. Hold your position, then enable again once connected.');
      permissions();
    } else if(message.type==='session_state') {
      hf.running=message.running;hf.revision=message.revision??hf.revision;feedback.session(hf.revision,streamId,hf.running);
    } else if(message.type==='stop_speech') {
      feedback.cancel();if(hf.prompt)playPrompt();
    } else if(message.type==='cancel_hazard') {navigator.vibrate?.(0);
    } else if(message.type==='hazard') {
      // Let PhoneFeedback validate the session before cancelling pending voice input.
      feedback.accept(message);
    } else if(message.type==='guidance' && hf.ready) {
      if(/^which item\??$/i.test(message.text.trim())) {openWindow('Which item?');return;}
      if(hf.window)return;
      if(message.id)feedback.accept(message);else speech.speak(message.text);
    }
  };
  socket.onclose=()=>{if(hf.socket!==socket)return;hf.dashboard=false;recover('Connection ended. Hold your position. Tap Enable hands-free to reconnect.');};
}
setInterval(()=>{
  if(hf.window && ((hf.prompt && performance.now()>hf.ackDeadline) || (!hf.prompt && performance.now()>=gate.until)))closeWindow(false);
  if(!hf.ready || !hf.dashboard || hf.socket?.bufferedAmount!==0)return;
  const sample=orientation.current();if(sample)send({type:'orientation',stream:streamId,orientation:sample});
},100);
setInterval(()=>{
  if(!hf.ready || !hf.dashboard || hf.socket?.bufferedAmount!==0 || !video.videoWidth)return;
  const scale=Math.min(1,960/Math.max(video.videoWidth,video.videoHeight));canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);
  canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
  send({type:'frame',image_base64:canvas.toDataURL('image/jpeg',.65),meta:{stream:streamId,seq:++hf.seq,capturedAt:performance.now(),orientation:orientation.current() || null}});
},200);
element('allow-permissions').addEventListener('click',async()=>{
  if(hf.connecting)return;
  if(!session || !window.isSecureContext) {element('status').textContent='Open the secure Hands-free QR link from the dashboard.';return;}
  hf.connecting=true;
  try {
    speech.unlock();feedback.unlock();orientation.enable();
    hf.context ||= new (window.AudioContext || window.webkitAudioContext)();
    await hf.context.resume();
    hf.context.onstatechange=()=>{if(hf.ready && hf.context.state!=='running')recover('Audio paused. Tap Enable hands-free to reactivate it.');};
    if(!hf.stream || hf.stream.getTracks().some(track=>track.readyState!=='live')) {
      hf.stream?.getTracks().forEach(track=>track.stop());
      hf.stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      video.srcObject=hf.stream;await video.play();
      for(const track of hf.stream.getTracks())track.onended=()=>recover('Camera or microphone permission ended. Allow access and enable again.');
      hf.source?.disconnect();hf.node?.disconnect();
      await hf.context.audioWorklet.addModule('/handsfree-worklet.js');
      hf.node=new AudioWorkletNode(hf.context,'handsfree-capture');
      hf.source=hf.context.createMediaStreamSource(hf.stream);hf.source.connect(hf.node);hf.node.connect(hf.context.destination);
      hf.node.port.onmessage=event=>{
        if(!hf.ready || !hf.dashboard)return;
        const data=event.data;
        if(data.type==='activity')report({audio_activity:data.activity});
        else if(data.type==='clip')queue.push({...data,at:performance.now()-data.samples.length/data.rate*1000});
      };
    }
    hf.node.port.postMessage('reset');hf.ready=true;element('setup').hidden=true;
    if(!hf.socket || hf.socket.readyState>WebSocket.OPEN)connect();permissions();
  } catch(error) {recover(error.name==='NotAllowedError'?'Allow camera and microphone in site settings, then try again.':'Could not start hands-free audio. Check permissions and try again.');}
  finally {hf.connecting=false;}
});
window.addEventListener('pagehide',()=>{recover('Tap Enable hands-free to reconnect.');hf.stream?.getTracks().forEach(track=>track.stop());hf.socket?.close();hf.context?.suspend();});
if(session)connect();else element('status').textContent='Scan the Hands-free QR code on the dashboard.';
