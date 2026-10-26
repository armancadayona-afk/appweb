const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  let reqUrl = req.url.split('?')[0];
  let filePath = path.join(PUBLIC_DIR, reqUrl === '/' ? 'index.html' : reqUrl);

  // Security check: prevent directory traversal
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
const rooms = new Map();

const send = (ws, msg) => {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
};

wss.on('connection', ws => {
  let room = null;
  ws.on('message', buffer => {
    let data;
    try { data = JSON.parse(String(buffer)); } catch { return; }

    if (data.type === 'join') {
      const id = String(data.room || '');
      if (room || !/^[a-zA-Z0-9_-]{8,64}$/.test(id)) {
        return send(ws, { type: 'error', message: 'Invalid room (must be 8-64 letters/numbers)' });
      }
      let peers = rooms.get(id);
      if (!peers) {
        peers = new Set();
        rooms.set(id, peers);
      }
      if (peers.size >= 2) {
        return send(ws, { type: 'error', message: 'Room full (max 2 callers per room)' });
      }
      const initiator = (peers.size === 0);
      room = id;
      peers.add(ws);
      send(ws, { type: 'joined' });
      if (peers.size === 2) {
        for (const peer of peers) {
          send(peer, { type: 'ready', initiator: peer === ws });
        }
      }
      return;
    }

    if (!room || !['offer', 'answer', 'candidate', 'hangup'].includes(data.type)) return;
    for (const peer of (rooms.get(room) || [])) {
      if (peer !== ws) send(peer, { type: data.type, payload: data.payload });
    }
  });

  ws.on('close', () => {
    if (!room) return;
    const peers = rooms.get(room);
    if (!peers) return;
    peers.delete(ws);
    for (const peer of peers) send(peer, { type: 'peer-left' });
    if (!peers.size) rooms.delete(room);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Web App & Signaling Server running on http://localhost:${PORT}`);
});
