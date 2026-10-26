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
const pendingRequests = new Map();
let waitingForApproval = false;
function renderWaitingRequests() {
  const panel=$('waiting-requests-panel'), list=$('waiting-requests-list');
  if (!panel || !list) return;
  panel.style.display=myRole==='admin'?'block':'none';
  $('waiting-count').textContent='('+pendingRequests.size+')';
  list.replaceChildren();
  for (const [id,name] of pendingRequests) {
    const row=document.createElement('div'); row.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap';
    const label=document.createElement('span');label.textContent=name;row.appendChild(label);
    for (const [title,type,color] of [['Approve','approve-join','#0e9f6e'],['Deny','deny-join','#b42332']]) {
      const btn=document.createElement('button');btn.textContent=title;btn.style.cssText='background:'+color+';color:white;border:0;border-radius:7px;padding:9px;cursor:pointer';
      btn.onclick=()=>{sendSignal(type,{target:id});pendingRequests.delete(id);renderWaitingRequests();};row.appendChild(btn);
    } list.appendChild(row);
  }
}


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
    renderWaitingRequests();

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
        topBadge.innerHTML = `<span class="dot-online"></span> ${escapeHtml(peer.displayName)} • On Call`;
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
    // Client View: Admin presentation plus every approved participant's live video.
    // This uses the existing per-peer WebRTC streams and does not alter signaling.
    container.className = 'client-participant-layout';
    container.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:14px;align-content:start;overflow-y:auto;padding:12px;';
    $('header-brand-sub').textContent = `${myDisplayName} • Live Tour`;
    $('admin-nav').style.display = 'none';
    $('admin-actions').style.display = 'none';
    $('admin-video-broadcast').style.display = 'none';

    const allVideos = [
      ...Array.from(peers.entries()).map(([id, peer]) => ({
        id, name: peer.displayName, role: peer.role, media: peer.stream, peer, self: false
      })),
      { id: myPeerId || 'self', name: myDisplayName, role: 'client', media: stream, self: true }
    ];
    allVideos.sort((a, b) => (a.role === 'admin' ? -1 : b.role === 'admin' ? 1 : 0));

    for (const item of allVideos) {
      const card = document.createElement('div');
      card.className = 'video-card';
      card.style.cssText = 'position:relative;min-height:210px;aspect-ratio:16/10;overflow:hidden;';
      if (item.role === 'admin') card.style.gridColumn = '1 / -1';

      const videoEl = document.createElement('video');
      videoEl.autoplay = true;
      videoEl.playsInline = true;
      videoEl.muted = item.self; // Prevent local audio feedback.
      videoEl.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#071321;';
      if (item.media) videoEl.srcObject = item.media;
      if (item.peer) item.peer.videoEl = videoEl;

      const topBadge = document.createElement('div');
      topBadge.className = 'card-badge-top';
      topBadge.textContent = `${item.name}${item.self ? ' (You)' : ''}${item.role === 'admin' ? ' • Host' : ''}`;
      const botBadge = document.createElement('div');
      botBadge.className = 'card-badge-bottom';
      botBadge.textContent = item.media?.getVideoTracks().some(t => t.readyState === 'live') ? 'Live camera' : 'Waiting for video';

      card.appendChild(videoEl);
      card.appendChild(topBadge);
      card.appendChild(botBadge);
      container.appendChild(card);
      if (item.media && !item.self) videoEl.play().catch(() => {
        botBadge.textContent = 'Tap video to play';
        videoEl.controls = true;
      });
    }
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
        <div>${escapeHtml(p.displayName)} ${p.isSelf ? '(You)' : ''}</div>
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
    <div class="chat-avatar">${escapeHtml(senderName.charAt(0))}</div>
    <div class="chat-content">
      <div class="chat-meta">${escapeHtml(senderName)} • ${escapeHtml(String(time))}</div>
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

  if (type === 'waiting') {
    waitingForApproval = true;
    $('waiting-message').style.display='block';
    $('btn-connect').disabled=true;
    $('btn-connect').textContent='Approval Pending';
    $('modal-status').textContent='Your request was sent to the Admin.';
    return;
  }
  if (type === 'join-request' && myRole === 'admin') {
    pendingRequests.set(peerId, displayName || 'Guest');renderWaitingRequests();return;
  }
  if (type === 'request-cancelled' && myRole === 'admin') {
    pendingRequests.delete(peerId);renderWaitingRequests();return;
  }
  if (type === 'join-denied') {
    waitingForApproval=false;
    $('waiting-message').style.display='none';
    $('btn-connect').disabled=false;$('btn-connect').textContent='Connect / Join Call';
    $('modal-status').textContent=message || 'Request denied.';
    if(ws)ws.close();return;
  }
  if (type === 'created' || type === 'joined') {
    waitingForApproval=false;
    $('waiting-message').style.display='none';
    $('btn-connect').disabled=false;$('btn-connect').textContent='Connect / Join Call';
    myPeerId = peerId;
    myDisplayName = displayName;
    currentRoom = room;

    $('setup-modal').style.display = 'none';
    startTimer();

    if (!stream) await openCamera();
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

  const clientName = myRole === 'client' ? ($('client-display-name').value || '').trim().replace(/\s+/g, ' ') : '';
  if (myRole === 'client' && (clientName.length < 2 || clientName.length > 40 || /[<>\x00-\x1f\x7f]/.test(clientName))) {
    $('modal-status').textContent = 'Please enter your name (2–40 characters).';
    $('client-display-name').focus();
    return;
  }
  try {
    $('modal-status').textContent = myRole === 'admin' ? 'Preparing Admin room...' : 'Requesting admission...';
    if (myRole === 'admin') await openCamera();

    localStorage.setItem('room', room);

    ws = new WebSocket(url);

    ws.onopen = () => {
      if (myRole === 'admin') {
        sendSignal('create-room', { room });
      } else {
        sendSignal('join-room', { room, displayName: clientName });
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
      $('modal-status').textContent = 'Cannot connect to the service.';
    };

    ws.onclose = () => {
      ws = null;
      if(waitingForApproval) {waitingForApproval=false;$('waiting-message').style.display='none';$('btn-connect').disabled=false;$('btn-connect').textContent='Connect / Join Call';$('modal-status').textContent='Disconnected while waiting. Please retry.';}
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
  pendingRequests.clear();renderWaitingRequests();waitingForApproval=false;
  $('waiting-message').style.display='none';$('btn-connect').disabled=false;$('btn-connect').textContent='Connect / Join Call';
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

window.addEventListener('DOMContentLoaded', () => { myRole = window.ONT_ROLE || 'client'; const r=new URLSearchParams(location.search).get('room'); if(r) document.getElementById('room-code').value=r; const nameGroup=document.getElementById('client-name-group'); if(nameGroup) nameGroup.style.display=myRole==='client'?'block':'none'; });
