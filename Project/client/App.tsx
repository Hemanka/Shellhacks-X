import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { ClientMessage, Command, ServerMessage, Snapshot, Phase, CaptureRequest, CycleStatus } from '../shared/protocol';
import { acceptsCommand, commandDeadline, fallbackGuidance, isMovement } from './guidanceSafety';

const EMPTY: Snapshot = { revision: 0, phase: 'paused', target: null, command: null, observation: null, metrics: { frames: 0, visualCalls: 0, reasonCalls: 0, visualSkipped: 0, reasonSkipped: 0, tokens: 0, visionMs: 0, reasonMs: 0 } };
const PHASE_LABEL: Record<Phase, string> = { searching: 'Finding your object', approaching: 'Approaching', stopping: 'Stopping', reaching: 'Reaching', complete: 'Object found', paused: 'Paused', recovering: 'Checking the view' };
type Hold = 'paused' | 'complete' | 'waiting' | null;
type WakeLock = { release: () => Promise<void>; addEventListener: (name: string, fn: () => void) => void };

function Icon({ name, size = 20 }: { name: 'focus' | 'camera' | 'arrow' | 'pause' | 'play' | 'check' | 'signal' | 'shield' | 'refresh'; size?: number }) {
  const paths = {
    focus: <><path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3" /><circle cx="12" cy="12" r="3" /></>,
    camera: <><path d="M3 7h4l2-3h6l2 3h4v13H3z" /><circle cx="12" cy="13" r="4" /></>,
    arrow: <><path d="M5 12h14m-6-6 6 6-6 6" /></>,
    pause: <><path d="M8 5v14m8-14v14" /></>,
    play: <path d="m8 5 11 7-11 7z" />,
    check: <path d="m5 12 4 4L19 6" />,
    signal: <><path d="M5 19v-4m5 4v-8m5 8V7m5 12V3" /></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z" /><path d="m8 12 3 3 5-6" /></>,
    refresh: <><path d="M20 10a8 8 0 1 0-2 8M20 4v6h-6" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const snapshotRef = useRef<Snapshot>(EMPTY);
  const minRevisionRef = useRef(0);
  const holdRef = useRef<Hold>('paused');
  const activeRef = useRef(false);
  const commandRef = useRef<{ command: Command; until: number } | null>(null);
  const lastCommandKeyRef = useRef('');
  const freshAfterRef = useRef(0);
  const commandTimerRef = useRef<number | null>(null);
  const lastVideoAtRef = useRef(0);
  const frameIdRef = useRef(0);
  const captureRef = useRef<CaptureRequest|null>(null);
  const sampleRef = useRef<Uint8Array|null>(null);
  const stableRef = useRef(true);
  const cycleRef = useRef<CycleStatus|null>(null);
  const [cycle,setCycle] = useState<CycleStatus|null>(null);
  const [lastCue,setLastCue] = useState('');
  const [announcement,setAnnouncement] = useState({id:0,text:''});
  const lastAnnouncementRef=useRef('');
  const cycleDeadlineRef = useRef(0);
  const wakeRef = useRef<WakeLock | null>(null);
  const mountedRef = useRef(true);
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  const [authenticated, setAuthenticated] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [connection, setConnection] = useState<'offline' | 'connecting' | 'online'>('offline');
  const [camera, setCamera] = useState<'off' | 'starting' | 'on'>('off');
  const [query, setQuery] = useState('');
  const [hand, setHand] = useState<'left' | 'right'>('right');
  const [code, setCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [notice, setNotice] = useState('');
  const [hold, setHold] = useState<Hold>('paused');
  const [stopReason, setStopReason] = useState('Start your camera to begin.');
  const [clock, setClock] = useState(0);
  const [wakeStatus, setWakeStatus] = useState('Not requested');
  const [transport, setTransport] = useState({ sent: 0, dropped: 0, width: 0, height: 0 });

  const send = useCallback((message: ClientMessage) => {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(message)); return true; }
    return false;
  }, []);

  const releaseWake = useCallback(() => {
    void wakeRef.current?.release().catch(() => undefined);
    wakeRef.current = null;
  }, []);

  const stop = useCallback((reason: string, control: 'pause' | 'found' = 'pause') => {
    if (holdRef.current === 'complete' && control === 'pause') return;
    activeRef.current = false;
    captureRef.current=null;sampleRef.current=null;cycleRef.current=null;setCycle(null);
    commandRef.current = null;
    if (commandTimerRef.current !== null) window.clearTimeout(commandTimerRef.current);
    holdRef.current = control === 'found' ? 'complete' : 'paused';
    setHold(holdRef.current);
    setStopReason(reason);
    if (send({ type: control })) minRevisionRef.current = Math.max(minRevisionRef.current, snapshotRef.current.revision) + 1;
    releaseWake();
  }, [send, releaseWake]);

  const acquireWake = useCallback(async () => {
    try {
      const nav = navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<WakeLock> } };
      if (!nav.wakeLock) { setWakeStatus('Keep screen awake manually'); return; }
      const lock = await nav.wakeLock.request('screen');
      if (!activeRef.current) { await lock.release(); return; }
      wakeRef.current = lock;
      setWakeStatus('Screen stays awake');
      lock.addEventListener('release', () => { if (wakeRef.current === lock) { wakeRef.current = null; setWakeStatus('Released'); } });
    } catch { setWakeStatus('Keep screen awake manually'); }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const abort = new AbortController();
    void fetch('/api/health', { signal: abort.signal }).then(r => r.ok ? r.json() : Promise.reject(new Error('unavailable'))).then((data: { configured: boolean }) => setConfigured(data.configured)).catch(() => { if (!abort.signal.aborted) setNotice('The guidance server is unavailable. Check the connection and try again.'); });
    return () => { abort.abort(); mountedRef.current = false; streamRef.current?.getTracks().forEach(t => t.stop()); socketRef.current?.close(); if (commandTimerRef.current !== null) window.clearTimeout(commandTimerRef.current); releaseWake(); };
  }, [releaseWake]);

  const connect = useCallback(() => {
    activeRef.current = false;
    commandRef.current = null;
    lastCommandKeyRef.current = '';
    freshAfterRef.current = performance.now();
    minRevisionRef.current = 0;
    snapshotRef.current = EMPTY;
    setSnapshot(EMPTY);
    setHasSession(false);
    if (holdRef.current !== 'complete') { holdRef.current = 'paused'; setHold('paused'); setStopReason('Connected session will start paused.'); }
    socketRef.current?.close();
    setConnection('connecting');
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/stream`);
    socketRef.current = ws;
    ws.onopen = () => { if (socketRef.current === ws) setConnection('online'); };
    ws.onmessage = event => {
      if (socketRef.current !== ws || !mountedRef.current) return;
      try {
        const message = JSON.parse(String(event.data)) as ServerMessage;
        if (message.type === 'ready') { setConfigured(message.configured); return; }
        if (message.type === 'error') { setNotice(message.message); stop('Guidance paused. Check the message below.'); return; }
        if(message.type==='cycle'){
          if(message.cycle.revision<minRevisionRef.current||!activeRef.current)return;
          cycleRef.current=message.cycle;setCycle(message.cycle);cycleDeadlineRef.current=performance.now()+message.cycle.delayMs;
          if(message.cycle.status==='analyzing'||message.cycle.status==='verifying')commandRef.current=null;
          return;
        }
        if(message.type==='capture'){
          if(!activeRef.current||message.revision!==snapshotRef.current.revision||message.revision<minRevisionRef.current)return;
          captureRef.current=message;
          if(message.purpose==='analysis'){sampleRef.current=null;stableRef.current=true;}
          return;
        }
        if (message.type !== 'state') return;
        const next = message.state;
        if (!Number.isFinite(next.revision) || next.revision < minRevisionRef.current || next.revision < snapshotRef.current.revision) return;
        snapshotRef.current = next;
        setSnapshot(next);
        if (holdRef.current === 'complete') return;
        if (holdRef.current === 'waiting' && next.phase !== 'paused' && next.phase !== 'complete') { holdRef.current = null; setHold(null); }
        if (next.phase === 'paused' || next.phase === 'complete') {
          activeRef.current = false;
          commandRef.current = null;
          holdRef.current = next.phase === 'complete' ? 'complete' : 'paused';
          setHold(holdRef.current);
          setStopReason(next.phase === 'complete' ? 'Object found. You’re all set.' : 'Guidance is paused.');
          return;
        }
        if (!activeRef.current || holdRef.current !== null) return;
        const cmd = next.command;
        const now = performance.now();
        if (commandRef.current && now >= commandRef.current.until) {
          freshAfterRef.current = Math.max(freshAfterRef.current, now);
          commandRef.current = null;
        }
        if (!acceptsCommand(cmd, next, now, freshAfterRef.current)) {
          commandRef.current = null;
          setStopReason('Waiting for a fresh, confirmed view.');
          return;
        }
        const key = `${cmd.revision}:${cmd.id}`;
        if (key !== lastCommandKeyRef.current) {
          lastCommandKeyRef.current = key;
          if(cmd.text&&cmd.action!=='HOLD'&&cmd.action!=='NO_CHANGE'&&cmd.reason!=='Movement expired; waiting for fresh frame.'&&cmd.reason!=='New search started.'){
            const cue=cmd.action==='ADJUST_VIEW'&&next.phase==='stopping'?'Show your hand and target.':cmd.text;
            setLastCue(cue);
            if(isMovement(cmd)||cue!==lastAnnouncementRef.current){lastAnnouncementRef.current=cue;setAnnouncement({id:cmd.id,text:cue});}
          }
          commandRef.current = { command: cmd, until: commandDeadline(cmd, now) };
          if (commandTimerRef.current !== null) window.clearTimeout(commandTimerRef.current);
          commandTimerRef.current = Number.isFinite(commandRef.current.until) ? window.setTimeout(() => {
            if (commandRef.current?.command.id !== cmd.id || commandRef.current.command.revision !== cmd.revision) return;
            const expiredAt = performance.now();
            freshAfterRef.current = Math.max(freshAfterRef.current, expiredAt);
            commandRef.current = null;
            setStopReason('That instruction expired. Waiting for a fresh view.');
            setClock(expiredAt);
          }, Math.max(0, commandRef.current.until - now)) : null;
        }
        setClock(now);
      } catch { setNotice('An unreadable server response was received.'); stop('Guidance paused. Reconnect to continue.'); }
    };
    ws.onclose = () => { if (socketRef.current === ws && mountedRef.current) { setConnection('offline'); stop('Connection lost. Stay still and reconnect.'); } };
    ws.onerror = () => { if (socketRef.current === ws && mountedRef.current) { setNotice('The live connection could not be established.'); stop('Connection unavailable.'); } };
  }, [stop]);

  async function join(event: FormEvent) {
    event.preventDefault();
    if (joining) return;
    setJoining(true); setNotice('');
    try {
      const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ code }) });
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'That access code wasn’t accepted. Try again.' : 'Unable to join. Check that the server is running.');
      setCode(''); setAuthenticated(true); connect();
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Unable to join.'); }
    finally { setJoining(false); }
  }

  async function startCamera() {
    setCamera('starting'); setNotice('');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access requires a secure HTTPS connection.');
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 30 } }, audio: false });
      streamRef.current?.getTracks().forEach(t => t.stop());
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) { stream.getTracks().forEach(t => t.stop()); throw new Error('The camera preview is not ready. Try again.'); }
      video.srcObject = stream;
      await video.play();
      stream.getVideoTracks().forEach(track => {
        track.onended = () => { if (streamRef.current === stream) { setCamera('off'); stop('Camera disconnected. Guidance stopped.'); } };
        track.onmute = () => { if (streamRef.current === stream && activeRef.current) stop('Camera view interrupted. Guidance stopped.'); };
      });
      lastVideoAtRef.current = performance.now();
      setCamera('on'); setStopReason('Choose an object, then start guidance.');
    } catch (error) {
      setCamera('off'); stop('Camera unavailable.');
      setNotice(error instanceof Error ? error.message : 'Allow camera access and try again.');
    }
  }

  const control = useCallback((type: 'start' | 'resume' | 'another') => {
    if (camera !== 'on' || connection !== 'online' || !configured) return;
    if (type === 'start' && !query.trim()) { setNotice('Describe the object you want to find.'); return; }
    commandRef.current = null;
    holdRef.current = 'waiting'; setHold('waiting');
    const nextRevision = Math.max(minRevisionRef.current, snapshotRef.current.revision) + 1;
    activeRef.current = true;
    setNotice(''); setStopReason('Checking the current view before guiding you.');
    if (!send(type === 'start' ? { type, query: query.trim(), hand } : { type })) { stop('Connection lost. Reconnect to continue.'); return; }
    minRevisionRef.current = nextRevision;
    freshAfterRef.current = performance.now();
    if (type === 'start') setHasSession(true);
    if(type==='start'||type==='another'){setLastCue('');setAnnouncement({id:0,text:''});lastAnnouncementRef.current='';}
    void acquireWake();
  }, [camera, connection, configured, query, hand, send, stop, acquireWake]);

  useEffect(() => {
    const onVisibility = () => { if (document.hidden && activeRef.current) stop('App hidden. Guidance stopped. Return and resume when ready.'); };
    const onPageHide = () => { if (activeRef.current) stop('Page interrupted. Guidance stopped.'); };
    const onOffline = () => { if (activeRef.current) stop('Network disconnected. Guidance stopped.'); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('offline', onOffline);
    return () => { document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('pagehide', onPageHide); window.removeEventListener('offline', onOffline); };
  }, [stop]);

  useEffect(() => {
    const canvas = document.createElement('canvas');
    const sampleCanvas=document.createElement('canvas');sampleCanvas.width=32;sampleCanvas.height=24;
    let encoding = false;
    let lastTime = -1;
    let lastHeartbeat=0;
    const timer = window.setInterval(() => {
      const now = performance.now();
      setClock(now);
      if (commandRef.current && now >= commandRef.current.until) {
        freshAfterRef.current = Math.max(freshAfterRef.current, now);
        commandRef.current = null;
        setStopReason('That instruction expired. Waiting for a fresh view.');
      }
      const video = videoRef.current;
      if (video && video.currentTime !== lastTime && video.readyState >= 2) { lastTime = video.currentTime; lastVideoAtRef.current = now; }
      if (!activeRef.current) return;
      if (!video || !streamRef.current?.active || video.readyState < 2 || now - lastVideoAtRef.current > 1500) { stop('Live camera frames stopped. Guidance paused.'); return; }
      if (document.hidden) { stop('App hidden. Guidance stopped.'); return; }
      const ws = socketRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) { stop('Connection lost. Guidance stopped.'); return; }
      if(now-lastHeartbeat>=1000){ws.send(JSON.stringify({type:'heartbeat'} satisfies ClientMessage));lastHeartbeat=now;}
      if(['analyzing','verifying'].includes(cycleRef.current?.status??'')){
        const sampleContext=sampleCanvas.getContext('2d',{willReadFrequently:true});
        if(sampleContext){sampleContext.drawImage(video,0,0,32,24);const pixels=sampleContext.getImageData(0,0,32,24).data;const gray=new Uint8Array(768);for(let i=0;i<gray.length;i++)gray[i]=Math.round((pixels[i*4]+pixels[i*4+1]+pixels[i*4+2])/3);
          if(sampleRef.current){let diff=0;for(let i=0;i<gray.length;i++)diff+=Math.abs(gray[i]-sampleRef.current[i]);if(diff/(gray.length*255)>=.025)stableRef.current=false;}else sampleRef.current=gray;
        }
      }
      const requested=captureRef.current;
      if(!requested)return;
      if (encoding || ws.bufferedAmount > 128 * 1024) { setTransport(t => ({ ...t, dropped: t.dropped + 1 })); return; }
      captureRef.current=null;
      const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
      const width = Math.round(video.videoWidth * scale);
      if (width <= 0 || video.videoHeight <= 0) return;
      canvas.width = width;
      canvas.height = Math.round(video.videoHeight * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) { stop('The camera frame could not be processed.'); return; }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const capturedAt = performance.now();
      const revision = snapshotRef.current.revision;
      encoding = true;
      canvas.toBlob(blob => {
        if (!blob || blob.size > 285000) { encoding = false; setTransport(t => ({ ...t, dropped: t.dropped + 1 })); return; }
        const reader = new FileReader();
        reader.onloadend = () => {
          encoding = false;
          if (!activeRef.current || document.hidden || socketRef.current !== ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 128 * 1024 || revision !== snapshotRef.current.revision || performance.now() - capturedAt > 500) { setTransport(t => ({ ...t, dropped: t.dropped + 1 })); return; }
          const data = typeof reader.result === 'string' ? reader.result.split(',')[1] : '';
          if (!data) return;
          if(requested.revision!==revision||cycleRef.current?.id!==requested.cycleId)return;
          ws.send(JSON.stringify({ type: 'frame', id: ++frameIdRef.current, capturedAt, jpeg: data, revision,cycleId:requested.cycleId,purpose:requested.purpose,stable:stableRef.current } satisfies ClientMessage));
          setTransport(t => ({ ...t, sent: t.sent + 1, width: canvas.width, height: canvas.height }));
        };
        reader.readAsDataURL(blob);
      }, 'image/jpeg', 0.72);
    }, 200);
    return () => window.clearInterval(timer);
  }, [stop]);

  const accepted = commandRef.current;
  const validCommand = hold === null && activeRef.current && accepted && clock < accepted.until && acceptsCommand(accepted.command, snapshot, clock, freshAfterRef.current) ? accepted.command : null;
  const completed = hold === 'complete';
  const waiting = hold === 'waiting';
  const phase = hold === 'complete' ? 'complete' : hold === 'paused' ? 'paused' : snapshot.phase;
  const expired = hold === null && accepted !== null && clock >= accepted.until;
  const observedFallback = fallbackGuidance(snapshot);
  const confirmedNear = snapshot.observation && (snapshot.observation.proximity === 'near' || (snapshot.observation.targetBox && (snapshot.observation.targetBox.right - snapshot.observation.targetBox.left >= .7 || snapshot.observation.targetBox.bottom - snapshot.observation.targetBox.top >= .7)));
  const displayedCommand = validCommand && (isMovement(validCommand) || confirmedNear) ? validCommand : null;
  const checking=activeRef.current&&cycle&&(['analyzing','verifying'].includes(cycle.status)||clock>=cycleDeadlineRef.current);
  const cueActive=validCommand&&validCommand.action!=='HOLD'&&validCommand.action!=='NO_CHANGE'&&validCommand.reason!=='Movement expired; waiting for fresh frame.';
  const commandText = completed ? 'Object found.' : hold==='paused' ? 'Paused.' : lastCue || (snapshot.target?'Target selected.':'Scan slowly, then stop.');
  const reason = completed ? 'You confirmed the object. Guidance has ended.' : displayedCommand ? observedFallback?.reason || displayedCommand.reason : observedFallback?.reason || (expired ? 'That instruction expired. Waiting for a fresh view.' : validCommand?.reason || stopReason);
  const isStop = !displayedCommand || ['STOP', 'HOLD', 'NO_CHANGE', 'ADJUST_VIEW'].includes(displayedCommand.action);
  const connected = connection === 'online';
  const canGuide = camera === 'on' && connected && configured === true;
  const metrics = snapshot.metrics;
  const stage = phase === 'reaching' ? 2 : phase === 'approaching' || phase === 'stopping' ? 1 : phase === 'complete' ? 3 : 0;

  const guidancePanel = <section id="guidance" className={`guidance-card ${completed ? 'complete' : isStop ? 'stop-state' : 'active-state'}`} aria-label="Current guidance" tabIndex={-1}>
            <div className="guidance-top"><span className="eyebrow">{lastCue&&!cueActive?'LAST INSTRUCTION · FINISHED':'YOUR NEXT STEP'}</span><span className="phase-pill">{waiting ? 'Checking view' : PHASE_LABEL[phase]}</span></div>
            <div className="instruction" role="status" aria-live="off" aria-atomic="true"><span className="instruction-symbol" aria-hidden="true">{completed ? <Icon name="check" size={30} /> : validCommand?.action.includes('LEFT') ? '←' : validCommand?.action.includes('RIGHT') ? '→' : validCommand?.action.includes('UP') ? '↑' : validCommand?.action.includes('DOWN') ? '↓' : isStop ? <Icon name="pause" size={28} /> : <Icon name="arrow" size={30} />}</span><h2>{commandText}</h2><p>{completed ? reason : validCommand && isMovement(validCommand) ? 'Then stop.' : 'Wait for the next instruction.'}</p></div>
            {activeRef.current&&cycle&&<p>{checking?'Checking…':cycle.status==='retry_wait'?`Retry in ${Math.round(cycle.delayMs/1000)} seconds.`:`Next check in ${Math.round(cycle.delayMs/1000)} seconds.`}</p>}
            <span aria-live="polite" aria-atomic="true" style={{position:'absolute',width:1,height:1,overflow:'hidden',clipPath:'inset(50%)'}}><span key={announcement.id}>{announcement.text}</span></span>
            <div className="journey" aria-label={`Progress: ${PHASE_LABEL[phase]}`}>{['Find', 'Approach', 'Reach'].map((label, index) => <div key={label} className={stage > index ? 'done' : stage === index ? 'current' : ''}><span>{stage > index ? <Icon name="check" size={12} /> : index + 1}</span>{label}</div>)}</div>
            {authenticated && <div className="guidance-controls"><button className="button pause-button" disabled={!connected || completed || (hold === 'paused' && (!hasSession || !canGuide))} onClick={() => hold === 'paused' ? control('resume') : stop('You paused guidance. Stay still until you resume.')}><Icon name={hold === 'paused' ? 'play' : 'pause'} />{hold === 'paused' ? 'Resume' : 'Pause'}</button><button className="button found-button" disabled={!snapshot.target || completed} onClick={() => stop('Object found. You’re all set.', 'found')}><Icon name="check" />I found it</button></div>}
            {authenticated && snapshot.target && <button className="text-button another-button" disabled={!canGuide} onClick={() => control('another')}><Icon name="refresh" size={15} />Choose another match</button>}
          </section>;

  return <div className={`app-shell ${hasSession ? 'session-started' : ''}`}>
    <a className="skip-link" href="#guidance">Skip to guidance</a>
    <header className="header">
      <a className="brand" href="#" aria-label="Find and Reach home"><span className="brand-mark"><Icon name="focus" size={26} /></span><span>find<span className="amp">&</span>reach<span className="brand-note">A little more independence.</span></span></a>
      <div className={`connection-pill ${connected ? 'connected' : ''}`}><span className="status-dot" />{connected ? 'Connected' : connection === 'connecting' ? 'Connecting' : 'Offline'}</div>
    </header>

    <main>
      <div className="intro"><p className="eyebrow">YOUR WORLD, WITHIN REACH</p><h1>Let’s find what<br className="mobile-break" /> you’re looking for.</h1><p className="intro-copy">A live view. One clear step at a time.</p></div>
      <div className={`workspace ${hasSession ? 'session-guidance' : ''}`}>{hasSession && guidancePanel}
        <section className="view-card" aria-label="Live camera view">
          <div className="view-top"><span><Icon name="camera" size={16} /> YOUR VIEW</span><span className={`live-label ${camera === 'on' ? 'is-live' : ''}`}><i />{camera === 'on' ? 'LIVE' : 'CAMERA OFF'}</span></div>
          <div className={`camera-stage ${camera === 'on' ? 'camera-running' : ''}`}>
            <video ref={videoRef} autoPlay playsInline muted aria-label="Rear camera preview" />
            {camera !== 'on' && <div className="camera-placeholder"><div className="orbit"><Icon name="focus" size={42} /></div><h2>Your view starts here</h2><p>Place your phone with the rear camera<br />facing outward and the lens uncovered.</p>{authenticated && <button className="button primary" onClick={() => void startCamera()} disabled={camera === 'starting'}><Icon name="camera" />{camera === 'starting' ? 'Opening camera…' : 'Enable camera'}</button>}</div>}
            <div className="view-corners" aria-hidden="true"><i /><i /><i /><i /></div>
            {camera === 'on' && <div className="view-bottom"><span><Icon name="shield" size={15} />{activeRef.current ? 'Checking the live view' : 'Preview only · guidance paused'}</span><span>{transport.width ? `${transport.width} × ${transport.height}` : '720p capture'}</span></div>}
          </div>
          <div className="view-caption"><span className="caption-icon"><Icon name="focus" size={18} /></span><p>{snapshot.target ? <><strong>{snapshot.target.description}</strong><span>{snapshot.observation?.targetMatch === 'ambiguous' ? 'Match unclear — guidance will wait.' : snapshot.observation?.targetMatch === 'lost' ? 'Target no longer confirmed in view.' : 'Selected from the camera view.'}</span></> : <><strong>A familiar object. A fresh perspective.</strong><span>Describe what you need to find.</span></>}</p></div>
        </section>

        <div className="right-column">
          {!authenticated ? <section className="panel join-panel"><p className="eyebrow">WELCOME IN</p><h2>Your next step starts here.</h2><p className="muted">Enter the session code from your host to connect your camera securely.</p><form onSubmit={event => void join(event)}><label htmlFor="access-code">Session code</label><input id="access-code" type="password" autoComplete="off" value={code} onChange={e => setCode(e.target.value)} required placeholder="Enter your access code" /><button className="button primary full" disabled={joining || !code.trim()}>{joining ? 'Connecting…' : 'Join session'}<Icon name="arrow" /></button></form><p className="small-note"><Icon name="shield" size={15} />Your camera starts only when you enable it.</p></section> : <section className="panel setup-panel" aria-label="Choose an object"><div className="section-title"><span className="section-number">01</span><h2>What would you like to find?</h2></div><form onSubmit={event => { event.preventDefault(); control('start'); }}><label htmlFor="object-query">Describe your object</label><div className="query-input"><input id="object-query" maxLength={120} value={query} onChange={e => setQuery(e.target.value)} placeholder="The blue mug, or the pizza box…" /><Icon name="focus" size={19} /></div><fieldset className="hand-options"><legend>Which hand will you use?</legend><div>{(['left', 'right'] as const).map(side => <label key={side} className={hand === side ? 'chosen' : ''}><input type="radio" name="hand" checked={hand === side} onChange={() => setHand(side)} /><span>{side === 'left' ? 'Left hand' : 'Right hand'}</span>{hand === side && <Icon name="check" size={16} />}</label>)}</div></fieldset><button className="button primary full" disabled={!canGuide || !query.trim()}>Find my object<Icon name="arrow" /></button></form>{!connected && <button className="text-button" onClick={connect}><Icon name="refresh" size={15} />Reconnect to the session</button>}{configured === false && <p className="setup-message">Your host needs to finish configuring the guidance server.</p>}</section>}

          {!hasSession && guidancePanel}
        </div>
      </div>
      {notice && <div className="notice" role="alert"><Icon name="shield" /><p>{notice}</p><button aria-label="Dismiss message" onClick={() => setNotice('')}>×</button></div>}
      <section className="reassurance"><Icon name="shield" size={19} /><p><strong>You’re always in control.</strong> Guidance waits when the view is uncertain. Pause whenever you need to.</p></section>
      <details className="diagnostics"><summary><span><Icon name="signal" size={17} />Session details</span><span>Live processing & connection</span></summary><div className="metric-grid">{[['Frames received', metrics.frames], ['Frames sent', transport.sent], ['Frames dropped', transport.dropped], ['Visual checks', metrics.visualCalls], ['Reason checks', metrics.reasonCalls], ['Visual checks skipped', metrics.visualSkipped], ['Reason checks skipped', metrics.reasonSkipped], ['Tokens used', metrics.tokens], ['Vision time', `${Math.round(metrics.visionMs)} ms`], ['Reason time', `${Math.round(metrics.reasonMs)} ms`], ['Cycle', cycle?.status || 'idle'], ['Revision', snapshot.revision], ['Instruction age', accepted ? `${Math.max(0, Math.round(clock - accepted.command.capturedAt))} ms` : '—'], ['Screen', wakeStatus]].map(([label, value]) => <div className="metric" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><div className="decision-detail"><h3>Latest observation</h3><pre>{JSON.stringify(snapshot.observation, null, 2)}</pre><h3>Decision reason</h3><p>{snapshot.command?.reason || 'No decision yet.'}</p></div><p className="diagnostic-note">One analysis image per check · one local verification image · movement cues expire after 2 seconds · no distance measurements</p></details>
    </main>
    <footer><span>find<span className="amp">&</span>reach</span><p>Made for the moments that matter.</p><span className="prototype-label">SHELLHACKS PROTOTYPE</span></footer>
  </div>;
}
