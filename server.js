const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!ADMIN_PASSWORD || !SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error('Set ADMIN_PASSWORD and SESSION_SECRET (32+ characters) before starting.');
  process.exit(1);
}
const loginAttempts = new Map();
function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').map(v => v.trim().split(/=(.*)/s).slice(0,2)).filter(v => v.length === 2)); }
function signature(payload) { return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex'); }
function isAdmin(req) {
  const token = cookies(req).ontour_session;
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 2 || !/^\d+$/.test(parts[0])) return false;
  const expected = signature(parts[0]);
  if (parts[1].length !== expected.length || !crypto.timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected))) return false;
  return Number(parts[0]) > Date.now();
}
function respond(res, code, body, headers = {}) { res.writeHead(code, { 'Content-Type':'application/json', 'Cache-Control':'no-store', ...headers }); res.end(JSON.stringify(body)); }


const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json'
};

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/api/admin/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    const entry = loginAttempts.get(ip) || { count: 0, until: 0 };
    if (entry.until > Date.now()) return respond(res, 429, { error: 'Too many attempts. Try again later.' });
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > 4096) req.destroy(); });
    req.on('end', () => {
      let pass = ''; try { pass = String(JSON.parse(raw).password || ''); } catch {}
      const a = crypto.createHash('sha256').update(pass).digest();
      const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
      if (!crypto.timingSafeEqual(a,b)) {
        entry.count++; if (entry.count >= 6) { entry.until = Date.now() + 15*60*1000; entry.count = 0; }
        loginAttempts.set(ip,entry);
        return respond(res,401,{ error:'Incorrect password' });
      }
      loginAttempts.delete(ip);
      const exp = String(Date.now() + 12*60*60*1000);
      const secure = (req.headers['x-forwarded-proto'] === 'https') ? '; Secure' : '';
      respond(res,200,{ ok:true },{ 'Set-Cookie':`ontour_session=${exp}.${signature(exp)}; Path=/; HttpOnly; SameSite=Lax${secure}` });
    }); return;
  }
  if (pathname === '/api/admin/logout' && req.method === 'POST') return respond(res,200,{ok:true},{'Set-Cookie':'ontour_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'});
  if (pathname === '/api/admin/status') return respond(res,200,{ authenticated:isAdmin(req) });
  if (pathname === '/admin') {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store'});
    res.end(isAdmin(req) ? fs.readFileSync(path.join(PUBLIC_DIR,'call.html'),'utf8') : fs.readFileSync(path.join(PUBLIC_DIR,'login.html'),'utf8'));
    return;
  }
  const allowed = {'/':'index.html','/client':'call.html','/call.js':'call.js'};
  const file = allowed[pathname];
  if (!file) { res.writeHead(404); res.end('Not Found'); return; }
  const ext = path.extname(file).toLowerCase();
  fs.readFile(path.join(PUBLIC_DIR,file), (err, content) => {
    if (err) { res.writeHead(500); res.end('Server Error'); return; }
    res.writeHead(200, {'Content-Type': MIME_TYPES[ext] || 'text/html; charset=utf-8', 'Cache-Control':'no-store'});
    res.end(content);
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

wss.on('connection', (ws, req) => {
  const adminAuthenticated = isAdmin(req);
  let currentRoom = null;
  let currentPeerId = null;

  ws.on('message', buffer => {
    let data;
    try { data = JSON.parse(String(buffer)); } catch { return; }

    const { type, room, target, payload, text, time } = data;

    if (type === 'create-room') {
      if (!adminAuthenticated) return send(ws, { type:'error', message:'Admin authentication required' });
      if (currentRoom) return send(ws,{type:'error',message:'Already in a room'});
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
      if (currentRoom) return send(ws,{type:'error',message:'Already in a room'});
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
      if (targetPeer && roomData.peers.has(currentPeerId) && target !== currentPeerId) {
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

    if (currentPeerId === roomData.adminId) {
      for (const info of roomData.peers.values()) send(info.ws,{type:'error',message:'Admin closed the room'});
      rooms.delete(currentRoom);
    } else if (roomData.peers.size === 0) {
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
