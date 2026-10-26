const $ = id => document.getElementById(id);

let ws = null;
let stream = null;
let broadcastFileUrl = null;
let broadcasting = false;
let broadcastTracks = { video: null, audio: null };
let broadcastBusy = false;
const broadcastStatus = message => { const el = $('broadcast-status'); if (el) el.textContent = message; };

let facing = 'user';
let myPeerId = null;
let myRole = window.ONT_ROLE || 'client'; // fixed by route
let myDisplayName = 'Admin';
let currentRoom = null;

// Timer state
let timerInterval = null;
let timerSeconds = 0;

// Map<peerId, { pc: RTCPeerConnection, role: string, displayName: string, stream: MediaStream, videoEl: HTMLVideoElement }>
const peers = new Map();

window.setRole = function() {}; // Role is determined by the server page

window.switchTab = function(tab) {
  if (tab === 'chat') {
    $('tab-chat-btn').classList.add('active');
    $('tab-parts-btn').classList.remove('active');
    $('view-chat').style.display = 'block';
    $('view-participants').style.display = 'none';
  } else {
    $('tab-parts-btn').classList.add('active');
    $('tab-chat-btn').classList.remove('active');
    $('view-chat').style.display = 'none';
    $('view-participants').style.display = 'block';
  }
};

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerSeconds = 0;
  updateTimerUI();
  timerInterval = setInterval(() => {
    timerSeconds++;
    updateTimerUI();
  }, 1000);
}

function updateTimerUI() {
  const h = String(Math.floor(timerSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((timerSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(timerSeconds % 60).padStart(2, '0');
  $('call-timer').textContent = `${h}:${m}:${s}`;
}

window.resetTimer = function() {
  timerSeconds = 0;
  updateTimerUI();
};

const sendSignal = (type, data = {}) => {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type, ...data }));
  }
};

// Keep a valid outgoing video sender even when the device has no camera.
// The placeholder is a black canvas, not a simulated camera feed.
let placeholderCanvas = null;
let placeholderInterval = null;
function placeholderVideoTrack() {
  if (!HTMLCanvasElement.prototype.captureStream) return null;
  placeholderCanvas = document.createElement('canvas');
  placeholderCanvas.width = 640;
  placeholderCanvas.height = 360;
  const ctx = placeholderCanvas.getContext('2d');
  const draw = () => {
    ctx.fillStyle = '#06101e'; ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = '#aabbd1'; ctx.font = '22px sans-serif';
    ctx.textAlign = 'center'; ctx.fillText('Camera unavailable', 320, 180);
  };
  draw();
  placeholderInterval = setInterval(draw, 1000);
  return placeholderCanvas.captureStream(2).getVideoTracks()[0] || null;
}
async function openCamera() {
  if (stream) return stream;
  const tracks = [];
  const issues = [];
  if (navigator.mediaDevices?.getUserMedia) {
    // Independent requests ensure a missing camera does not prevent microphone use.
    try {
      const video = await navigator.mediaDevices.getUserMedia({video: {facingMode: facing}, audio: false});
      tracks.push(...video.getVideoTracks());
    } catch (error) { issues.push('Camera: ' + error.message); }
    try {
      const audio = await navigator.mediaDevices.getUserMedia({audio: true, video: false});
      tracks.push(...audio.getAudioTracks());
    } catch (error) { issues.push('Microphone: ' + error.message); }
  } else {
    issues.push('Camera and microphone APIs unavailable (HTTPS required outside localhost).');
  }
  if (!tracks.some(track => track.kind === 'video')) {
    const placeholder = placeholderVideoTrack();
    if (placeholder) tracks.push(placeholder);
  }
  stream = new MediaStream(tracks);
  if (issues.length) {
    const status = $('modal-status');
    if (status) status.textContent = issues.join(' | ') + ' — You can still join.';
  }
  return stream;
}

function renderVideoLayout() {
  const container = $('video-container');
  container.innerHTML = '';

  if (myRole === 'admin') {
    // Admin View: 2x2 Grid Layout (Image 2 Template)
    container.className = 'admin-grid';
    $('header-brand-sub').textContent = 'Admin Monitoring Dashboard';
    $('admin-nav').style.display = 'flex';
    $('admin-actions').style.display = 'block';
    $('admin-video-broadcast').style.display = 'block';

    const totalSlots = 4;
    const allPeersList = Array.from(peers.values());

    for (let i = 0; i < totalSlots; i++) {
      const card = document.createElement('div');
      card.className = 'video-card';
      card.id = `slot-${i}`;

      const videoEl = document.createElement('video');
      videoEl.autoplay = true;
      videoEl.playsInline = true;

      const topBadge = document.createElement('div');
      topBadge.className = 'card-badge-top';

      const botBadge = document.createElement('div');
      botBadge.className = 'card-badge-bottom';

      if (i < allPeersList.length) {
        const peer = allPeersList[i];
        topBadge.innerHTML = `<span class="dot-online"></span> ${peer.displayName} • On Call`;
        botBadge.textContent = peer.displayName;
        if (peer.stream) videoEl.srcObject = peer.stream;
        peer.videoEl = videoEl;
      } else if (i === allPeersList.length) {
        // My camera slot
        topBadge.innerHTML = `<span class="dot-online"></span> ${myDisplayName} (Admin View)`;
        botBadge.textContent = myDisplayName;
        if (stream) videoEl.srcObject = stream;
        videoEl.muted = true;
      } else {
        // Empty slot waiting for worker
        topBadge.innerHTML = `<span style="opacity:0.5;">● Offline</span> Worker ${i + 1}`;
        botBadge.textContent = `Worker ${i + 1} (Waiting...)`;
      }

      card.appendChild(videoEl);
      card.appendChild(topBadge);
      card.appendChild(botBadge);
      container.appendChild(card);
    }
  } else {
    // Client View: Focused Main Video (Image 1 Template)
    container.className = 'client-focus';
    $('header-brand-sub').textContent = `${myDisplayName} • Monitoring`;
    $('admin-nav').style.display = 'none';
    $('admin-actions').style.display = 'none';
    $('admin-video-broadcast').style.display = 'none';

    const card = document.createElement('div');
    card.className = 'video-card';
    card.style.height = '100%';

    const videoEl = document.createElement('video');
    videoEl.autoplay = true;
    videoEl.playsInline = true;

    const topBadge = document.createElement('div');
    topBadge.className = 'card-badge-top';

    const botBadge = document.createElement('div');
    botBadge.className = 'card-badge-bottom';

    const adminPeer = Array.from(peers.values()).find(p => p.role === 'admin') || Array.from(peers.values())[0];

    if (adminPeer && adminPeer.stream) {
      videoEl.srcObject = adminPeer.stream;
      topBadge.innerHTML = `<span class="dot-online"></span> ${adminPeer.displayName} (Live View)`;
      botBadge.textContent = adminPeer.displayName;
    } else if (stream) {
      videoEl.srcObject = stream;
      videoEl.muted = true;
      topBadge.innerHTML = `<span class="dot-online"></span> ${myDisplayName} (My Camera)`;
      botBadge.textContent = myDisplayName;
    }

    card.appendChild(videoEl);
    card.appendChild(topBadge);
    card.appendChild(botBadge);
    container.appendChild(card);
  }

  updateParticipantsUI();
}

function updateParticipantsUI() {
  const container = $('participants-container');
  container.innerHTML = '';

  const list = [
    { peerId: myPeerId, role: myRole, displayName: myDisplayName, isSelf: true },
    ...Array.from(peers.entries()).map(([id, p]) => ({ peerId: id, role: p.role, displayName: p.displayName, isSelf: false }))
  ];

  $('part-count').textContent = list.length;

  list.forEach(p => {
    const row = document.createElement('div');
    row.className = 'participant-row';
    row.innerHTML = `
      <div class="part-info">
        <div class="part-icon">${p.role === 'admin' ? '🛡️' : '👤'}</div>
        <div>${p.displayName} ${p.isSelf ? '(You)' : ''}</div>
      </div>
      <div style="font-size:12px; color:#10b981; display:flex; align-items:center; gap:4px;">
        ● Online 📶
      </div>
    `;
    container.appendChild(row);
  });
}

function createPeerConnection(peerId, peerRole, peerDisplayName, isInitiator) {
  if (peers.has(peerId)) {
    return peers.get(peerId).pc;
  }

  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  });

  const peerObj = { pc, role: peerRole, displayName: peerDisplayName, stream: null, videoEl: null };
  peers.set(peerId, peerObj);

  if (stream) {
    stream.getTracks().forEach(track => {
      const outgoing = broadcasting ? (broadcastTracks[track.kind] || track) : track;
      pc.addTrack(outgoing, stream);
    });
  }

  pc.ontrack = ev => {
    peerObj.stream = ev.streams[0];
    renderVideoLayout();
  };

  pc.onicecandidate = ev => {
    if (ev.candidate) {
      sendSignal('candidate', { target: peerId, payload: ev.candidate });
    }
  };

  if (isInitiator) {
    pc.createOffer().then(offer => pc.setLocalDescription(offer))
      .then(() => sendSignal('offer', { target: peerId, payload: pc.localDescription }))
      .catch(console.warn);
  }

  renderVideoLayout();
  return pc;
}

function removePeer(peerId) {
  if (peers.has(peerId)) {
    const p = peers.get(peerId);
    p.pc.close();
    peers.delete(peerId);
    renderVideoLayout();
  }
}

window.sendChat = function() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  sendSignal('chat', { text, time });
};

function addChatMessage(senderName, text, time, isMine) {
  const box = $('chat-messages');
  const msgDiv = document.createElement('div');
  msgDiv.className = `chat-msg ${isMine ? 'mine' : ''}`;

  msgDiv.innerHTML = `
    <div class="chat-avatar">${senderName.charAt(0)}</div>
    <div class="chat-content">
      <div class="chat-meta">${senderName} • ${time}</div>
      <div class="chat-bubble">${escapeHtml(text)}</div>
    </div>
  `;

  box.appendChild(msgDiv);
  box.scrollTop = box.scrollHeight;
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function handleSignal(data) {
  const { type, peerId, role, displayName, room, peers: existingPeers, sender, payload, text, time, message } = data;

  if (type === 'error') {
    $('modal-status').textContent = message;
    if (ws) { ws.close(); ws = null; }
    return;
  }

  if (type === 'created' || type === 'joined') {
    myPeerId = peerId;
    myDisplayName = displayName;
    currentRoom = room;

    $('setup-modal').style.display = 'none';
    startTimer();

    existingPeers.forEach(p => {
      createPeerConnection(p.peerId, p.role, p.displayName, true);
    });

    renderVideoLayout();
  }

  if (type === 'peer-joined') {
    createPeerConnection(peerId, role, displayName, false);
  }

  if (type === 'chat') {
    const isMine = sender === myPeerId;
    addChatMessage(data.displayName || 'User', text, time, isMine);
  }

  if (type === 'offer') {
    let pc = peers.get(sender)?.pc;
    if (!pc) {
      pc = createPeerConnection(sender, sender.startsWith('admin') ? 'admin' : 'client', 'Peer', false);
    }
    await pc.setRemoteDescription(payload);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal('answer', { target: sender, payload: pc.localDescription });
  }

  if (type === 'answer') {
    const p = peers.get(sender);
    if (p && p.pc) {
      await p.pc.setRemoteDescription(payload);
    }
  }

  if (type === 'candidate') {
    const p = peers.get(sender);
    if (p && p.pc) {
      await p.pc.addIceCandidate(payload).catch(console.warn);
    }
  }

  if (type === 'peer-left') {
    removePeer(peerId);
  }
}

window.connectCall = async function() {
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  const room = $('room-code').value.trim();

  if (!url.startsWith('ws://') && !url.startsWith('wss://')) {
    $('modal-status').textContent = 'Server URL must start with ws:// or wss://';
    return;
  }

  if (!/^[a-zA-Z0-9_-]{4,64}$/.test(room)) {
    $('modal-status').textContent = 'Room code must be 4–64 letters or numbers';
    return;
  }

  try {
    $('modal-status').textContent = 'Accessing camera & microphone...';
    await openCamera();

    localStorage.setItem('signal', url);
    localStorage.setItem('room', room);

    ws = new WebSocket(url);

    ws.onopen = () => {
      if (myRole === 'admin') {
        sendSignal('create-room', { room });
      } else {
        sendSignal('join-room', { room });
      }
    };

    ws.onmessage = e => {
      try {
        Promise.resolve(handleSignal(JSON.parse(e.data))).catch(err => console.warn(err));
      } catch (err) {
        console.warn(err);
      }
    };

    ws.onerror = () => {
      $('modal-status').textContent = 'Cannot connect to signaling server at ' + url;
    };

    ws.onclose = () => {
      ws = null;
    };
  } catch (err) {
    $('modal-status').textContent = 'Unable to join: ' + err.message;
  }
};

// Broadcast a local video through the existing WebRTC connections. Admin only.
function localVideoElement() { return $('broadcast-preview'); }
function selectedSenders(kind) {
  return [...peers.values()].flatMap(p => p.pc.getSenders().filter(sender => sender.track?.kind === kind));
}
async function replaceOutgoingTracks(kind, track) {
  const senders = selectedSenders(kind);
  const done = [];
  try {
    for (const sender of senders) {
      const previous = sender.track;
      await sender.replaceTrack(track);
      done.push({ sender, previous });
    }
  } catch (error) {
    await Promise.allSettled(done.map(({sender, previous}) => sender.replaceTrack(previous)));
    throw error;
  }
}
window.startLocalVideoBroadcast = async function() {
  if (myRole !== 'admin' || broadcastBusy) return;
  if (!currentRoom) return broadcastStatus('Create a room first. A camera is not required.');
  const video = localVideoElement();
  if (!video.src) return broadcastStatus('Choose a video file first.');
  if (typeof video.captureStream !== 'function') return broadcastStatus('This browser does not support video captureStream. Try desktop Chrome.');
  broadcastBusy = true;
  try {
    await video.play();
    // Some browsers create tracks only after playback begins.
    let captured = video.captureStream();
    let videoTrack = captured.getVideoTracks()[0];
    if (!videoTrack) {
      await new Promise(resolve => setTimeout(resolve, 300));
      captured = video.captureStream();
      videoTrack = captured.getVideoTracks()[0];
    }
    if (!videoTrack) throw new Error('Video capture did not produce a video track. Check file/browser compatibility.');
    const cameraVideo = stream.getVideoTracks()[0];
    if (!cameraVideo) throw new Error('No outgoing video track is available in this browser.');
    const fileAudio = captured.getAudioTracks()[0] || null;
    const cameraAudio = stream.getAudioTracks()[0] || null;
    if (broadcasting) await stopLocalVideoBroadcast();
    await replaceOutgoingTracks('video', videoTrack);
    try {
      if (fileAudio && cameraAudio) await replaceOutgoingTracks('audio', fileAudio);
    } catch (error) {
      await replaceOutgoingTracks('video', cameraVideo);
      throw error;
    }
    broadcastTracks = {video: videoTrack, audio: fileAudio && cameraAudio ? fileAudio : null};
    broadcasting = true;
    broadcastStatus(fileAudio && cameraAudio ? 'Broadcasting local video with file audio.' : 'Broadcasting local video. File audio is unavailable; microphone audio remains active.');
  } catch (error) {
    video.pause();
    broadcastStatus('Broadcast failed: ' + error.message);
  } finally { broadcastBusy = false; }
};
window.stopLocalVideoBroadcast = async function() {
  if (myRole !== 'admin') return;
  const video = localVideoElement();
  if (!broadcasting) { if(video) video.pause(); return; }
  try {
    const camVideo = stream?.getVideoTracks()[0];
    const camAudio = stream?.getAudioTracks()[0];
    if (camVideo) await replaceOutgoingTracks('video', camVideo);
    if (broadcastTracks.audio && camAudio) await replaceOutgoingTracks('audio', camAudio);
    broadcasting = false;
    broadcastTracks = {video:null,audio:null};
    video.pause();
    broadcastStatus(camVideo ? 'Camera or placeholder broadcasting restored.' : 'Video stopped; no camera is available.');
  } catch(error) { broadcastStatus('Could not restore camera: ' + error.message); }
};
window.addEventListener('DOMContentLoaded', () => {
  const file = $('broadcast-file');
  if (!file) return;
  file.addEventListener('change', async () => {
    if (broadcasting) await stopLocalVideoBroadcast();
    const video = localVideoElement();
    video.pause();
    if (broadcastFileUrl) URL.revokeObjectURL(broadcastFileUrl);
    broadcastFileUrl = null;
    const chosen = file.files?.[0];
    if (!chosen) { video.removeAttribute('src'); video.style.display='none'; return; }
    broadcastFileUrl = URL.createObjectURL(chosen);
    video.src = broadcastFileUrl;
    video.style.display='block';
    broadcastStatus('Selected: ' + chosen.name + '. Press Broadcast Video to start.');
  });
  $('broadcast-preview').addEventListener('ended', () => { if (broadcasting) stopLocalVideoBroadcast(); });
});

window.endCall = function() {
  if (myRole === 'admin') { broadcasting = false; broadcastTracks = {video:null,audio:null}; const preview=localVideoElement(); if(preview) preview.pause(); }
  if (ws) {
    sendSignal('hangup');
    ws.close();
    ws = null;
  }
  peers.forEach((_, id) => removePeer(id));
  if (placeholderInterval) { clearInterval(placeholderInterval); placeholderInterval = null; }
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  if (timerInterval) clearInterval(timerInterval);
  $('setup-modal').style.display = 'flex';
  $('modal-status').textContent = 'Call ended.';
};

window.toggleAudio = function() {
  if (!stream) return;
  const t = stream.getAudioTracks()[0];
  if (t) {
    t.enabled = !t.enabled;
    $('btn-audio').classList.toggle('active', !t.enabled);
    $('lbl-audio').textContent = t.enabled ? 'Audio' : 'Muted';
  }
};

window.toggleRecord = function() {
  $('btn-record').classList.toggle('active');
};

window.toggleZoom = function() {
  $('btn-zoom').classList.toggle('active');
};

window.toggleFullscreen = function() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
};

window.addEventListener('DOMContentLoaded', () => { myRole = window.ONT_ROLE || 'client'; const r=new URLSearchParams(location.search).get('room'); if(r) document.getElementById('room-code').value=r; });
