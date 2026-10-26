const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json'
};

const server = http.createServer((req, res) => {
  let reqUrl = req.url.split('?')[0];
  let filePath = path.join(PUBLIC_DIR, reqUrl === '/' ? 'index.html' : reqUrl);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Internal Server Error');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

const wss = new WebSocketServer({ server, maxPayload: 65536 });

// Map<roomCode, { adminId: string, nextWorkerNum: number, peers: Map<peerId, { ws, role, displayName }> }>
const rooms = new Map();

function generatePeerId() {
  return Math.random().toString(36).substring(2, 10);
}

const send = (ws, msg) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
};

wss.on('connection', ws => {
  let currentRoom = null;
  let currentPeerId = null;

  ws.on('message', buffer => {
    let data;
    try { data = JSON.parse(String(buffer)); } catch { return; }

    const { type, room, target, payload, text, time } = data;

    if (type === 'create-room') {
      const roomCode = String(room || '').trim();
      if (!/^[a-zA-Z0-9_-]{4,64}$/.test(roomCode)) {
        return send(ws, { type: 'error', message: 'Room code must be 4–64 letters or numbers' });
      }
      if (rooms.has(roomCode)) {
        return send(ws, { type: 'error', message: 'Room already exists. Choose a different room code or join as client.' });
      }

      currentPeerId = 'admin_' + generatePeerId();
      currentRoom = roomCode;

      const roomData = {
        adminId: currentPeerId,
        nextWorkerNum: 1,
        peers: new Map()
      };
      const peerInfo = { ws, role: 'admin', displayName: 'Admin' };
      roomData.peers.set(currentPeerId, peerInfo);
      rooms.set(roomCode, roomData);

      send(ws, {
        type: 'created',
        peerId: currentPeerId,
        room: roomCode,
        role: 'admin',
        displayName: 'Admin',
        peers: []
      });
      return;
    }

    if (type === 'join-room') {
      const roomCode = String(room || '').trim();
      if (!rooms.has(roomCode)) {
        return send(ws, { type: 'error', message: 'Room does not exist. Only an admin can create a room.' });
      }

      const roomData = rooms.get(roomCode);
      if (roomData.peers.size >= 5) {
        return send(ws, { type: 'error', message: 'Room is full (maximum 4 workers allowed).' });
      }

      const workerNum = roomData.nextWorkerNum++;
      const displayName = `Worker ${workerNum}`;
      currentPeerId = 'client_' + generatePeerId();
      currentRoom = roomCode;

      const existingPeers = Array.from(roomData.peers.entries()).map(([id, info]) => ({
        peerId: id,
        role: info.role,
        displayName: info.displayName
      }));

      const peerInfo = { ws, role: 'client', displayName };
      roomData.peers.set(currentPeerId, peerInfo);

      send(ws, {
        type: 'joined',
        peerId: currentPeerId,
        room: roomCode,
        role: 'client',
        displayName,
        peers: existingPeers
      });

      for (const [id, info] of roomData.peers) {
        if (id !== currentPeerId) {
          send(info.ws, {
            type: 'peer-joined',
            peerId: currentPeerId,
            role: 'client',
            displayName
          });
        }
      }
      return;
    }

    if (type === 'chat') {
      if (!currentRoom || !rooms.has(currentRoom)) return;
      const roomData = rooms.get(currentRoom);
      const senderInfo = roomData.peers.get(currentPeerId);
      if (!senderInfo) return;

      const chatMsg = {
        type: 'chat',
        sender: currentPeerId,
        displayName: senderInfo.displayName,
        role: senderInfo.role,
        text: String(text || '').trim(),
        time: time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };

      for (const [id, info] of roomData.peers) {
        send(info.ws, chatMsg);
      }
      return;
    }

    if (['offer', 'answer', 'candidate'].includes(type)) {
      if (!currentRoom || !rooms.has(currentRoom)) return;
      const roomData = rooms.get(currentRoom);
      const targetPeer = roomData.peers.get(target);
      if (targetPeer) {
        send(targetPeer.ws, {
          type,
          sender: currentPeerId,
          payload
        });
      }
      return;
    }

    if (type === 'hangup') {
      leaveRoom();
    }
  });

  function leaveRoom() {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const roomData = rooms.get(currentRoom);
    roomData.peers.delete(currentPeerId);

    for (const [id, info] of roomData.peers) {
      send(info.ws, {
        type: 'peer-left',
        peerId: currentPeerId
      });
    }

    if (roomData.peers.size === 0) {
      rooms.delete(currentRoom);
    }
    currentRoom = null;
    currentPeerId = null;
  }

  ws.on('close', () => {
    leaveRoom();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Admin-Client Web App & Signaling Server running on port ${PORT}`);
});
