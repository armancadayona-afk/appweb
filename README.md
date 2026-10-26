# RealSMS Video Call - Web Application & Signaling Server

This standalone web application provides a browser-based WebRTC video calling client and WebSocket signaling server.

## Features
- **WebRTC Video Calls**: Peer-to-peer audio/video calling directly in web browsers (Chrome, Safari, Firefox, Edge, Mobile Web).
- **Embedded Signaling Server**: Combined Node.js HTTP web server and WebSocket signaling server running on port 3000 (or `PORT` environment variable).
- **Auto Server Connection**: Automatically connects to `wss://` on the current domain when hosted live.
- **Cross-Platform Interoperability**: Compatible with the Android app (`VideoCallActivity`).

## How to Run Locally
1. Navigate to the `webapp` folder:
   ```bash
   cd webapp
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the server:
   ```bash
   npm start
   ```
4. Open `http://localhost:3000` in two browser windows or on separate devices on the same local network.
5. Enter the same 8+ character room code (e.g., `room123456`) and click **Join / Start Call**.

## Hosting & Deployment
You can deploy this `webapp` folder to any Node.js cloud host:
- **Render**: Create a Web Service, connect your repository, set Root Directory to `webapp`, build command `npm install`, start command `npm start`.
- **Railway / Heroku / Fly.io**: Deploy directly using the provided `package.json` and `server.js`.
