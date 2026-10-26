const $ = id => document.getElementById(id);
let ws = null, pc = null, stream = null, facing = 'user', joined = false;
const status = msg => $('status').textContent = msg;

// Auto-fill default WebSocket URL when hosted on web
const savedSignal = localStorage.getItem('signal');
if (savedSignal) {
  $('server').value = savedSignal;
} else if (location.protocol === 'http:' || location.protocol === 'https:') {
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (location.host && location.host !== 'appassets.androidplatform.net') {
    $('server').value = `${wsProtocol}//${location.host}`;
  }
}
$('room').value = localStorage.getItem('room') || '';

const send = (type, payload) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, payload }));
};

async function openCamera() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: { facingMode: facing }
  });
  $('local').srcObject = stream;
}

function makePeer() {
  pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  });
  stream.getTracks().forEach(track => pc.addTrack(track, stream));
  pc.ontrack = ev => {
    $('remote').srcObject = ev.streams[0];
    status('Call connected!');
  };
  pc.onicecandidate = ev => {
    if (ev.candidate) send('candidate', ev.candidate);
  };
  pc.onconnectionstatechange = () => {
    if (pc && ['failed', 'disconnected'].includes(pc.connectionState)) {
      status('Connection ' + pc.connectionState + ' — TURN server may be required for strict NAT/firewalls');
    }
  };
}

async function signal(data) {
  if (data.type === 'joined') {
    joined = true;
    status('Waiting for second phone / caller to join room…');
  }
  if (data.type === 'error') status(data.message);
  if (data.type === 'ready') {
    makePeer();
    if (data.initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send('offer', pc.localDescription);
    } else {
      status('Connecting video stream…');
    }
  }
  if (data.type === 'offer') {
    if (!pc) makePeer();
    await pc.setRemoteDescription(data.payload);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send('answer', pc.localDescription);
  }
  if (data.type === 'answer' && pc) {
    await pc.setRemoteDescription(data.payload);
  }
  if (data.type === 'candidate' && pc) {
    await pc.addIceCandidate(data.payload).catch(console.warn);
  }
  if (data.type === 'hangup' || data.type === 'peer-left') {
    if (pc) { pc.close(); pc = null; }
    $('remote').srcObject = null;
    status('Other participant left the call');
  }
}

$('join').onclick = async () => {
  if (ws) {
    status('Already joined. Hang up before another call.');
    return;
  }
  const url = $('server').value.trim();
  const room = $('room').value.trim();
  if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
    status('Server URL must start with ws:// or wss://');
    return;
  }
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(room)) {
    status('Room code must be 8–64 letters or numbers');
    return;
  }
  try {
    status('Requesting camera & microphone access…');
    await openCamera();
    localStorage.setItem('signal', url);
    localStorage.setItem('room', room);
    ws = new WebSocket(url);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', room }));
    ws.onmessage = e => {
      try {
        Promise.resolve(signal(JSON.parse(e.data))).catch(err => status(err.message));
      } catch (err) {
        status(err.message);
      }
    };
    ws.onerror = () => status('Cannot connect to signaling server at ' + url);
    ws.onclose = () => {
      ws = null;
      joined = false;
      status('Server connection closed');
    };
  } catch (err) {
    status('Camera/microphone error: ' + err.message);
  }
};

function endCall() {
  send('hangup');
  if (ws) ws.close();
  ws = null;
  if (pc) pc.close();
  pc = null;
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
  joined = false;
  $('local').srcObject = null;
  $('remote').srcObject = null;
  status('Call ended');
}

$('hang').onclick = endCall;

$('mute').onclick = () => {
  if (!stream) return;
  const t = stream.getAudioTracks()[0];
  if (t) {
    t.enabled = !t.enabled;
    $('mute').textContent = t.enabled ? 'Mute mic' : 'Unmute mic';
  }
};

$('camera').onclick = () => {
  if (!stream) return;
  const t = stream.getVideoTracks()[0];
  if (t) {
    t.enabled = !t.enabled;
    $('camera').textContent = t.enabled ? 'Camera off' : 'Camera on';
  }
};

$('flip').onclick = async () => {
  if (!stream) return;
  facing = facing === 'user' ? 'environment' : 'user';
  const old = stream.getVideoTracks()[0];
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: facing },
      audio: false
    });
    const replacement = newStream.getVideoTracks()[0];
    if (pc) {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(replacement);
    }
    stream.removeTrack(old);
    old.stop();
    stream.addTrack(replacement);
    $('local').srcObject = stream;
  } catch (err) {
    status('Camera switch failed: ' + err.message);
  }
};
