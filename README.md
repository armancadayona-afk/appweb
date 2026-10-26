# On-Tour — Homepage + Admin / Client (preserved WebRTC)

This project modifies the uploaded `webapp.zip`, keeping its existing `public/call.js` peer connection implementation and `ws` signaling protocol. It adds a homepage, separate routes, server-enforced Admin password, and removes the hardcoded signaling URL.

## Render deployment
- Create a Node Web Service from this project repository.
- Build: `npm install`
- Start: `npm start`
- Environment variables: `ADMIN_PASSWORD` (choose a strong password), `SESSION_SECRET` (random string at least 32 characters).
- Do not publish these values in source control.

## URLs
- `/` homepage
- `/admin` Admin login, then Admin video dashboard (can create rooms)
- `/client` Client video dashboard (joins existing rooms)

## Testing
1. Open `/admin`, sign in and enter a room code of 4–64 letters, numbers, `_` or `-`.
2. Open `/client` on a separate device and enter the same room code.
3. Allow camera and microphone access on both devices; check video and audio in both directions.
4. Test incorrect password and try creating a room through an unauthenticated WebSocket client; it must be denied.

**Limitations:** This retains the source app's original WebRTC negotiation. Two-device live camera tests, TURN fallback, and load tests have NOT been performed here. A free STUN-only peer connection may fail across restrictive networks. This application stores rooms in memory and expects one Render instance. Do not use as a public production service without additional security and real-device testing.


## Admin local video broadcasting (new)

On `/admin`, join/create a room with camera permission, choose a local MP4 or WebM, and click **Broadcast Video**. The app captures the video element and uses `RTCRtpSender.replaceTrack` to send the file's video track to existing clients without changing rooms. When supported, the file's audio replaces microphone audio during playback; otherwise microphone audio continues. Click **Return to Camera** to restore webcam/microphone. The Admin sees a local playback preview.

This depends on browser `HTMLMediaElement.captureStream()` support and media codecs. Desktop Chrome is recommended. Real multi-device playback has **not** been tested in this environment. Existing `ADMIN_PASSWORD` and `SESSION_SECRET` Render environment variables are still required.


## Camera-optional mode
Both Admin and Client can join without a detected or permitted camera. Video and microphone permissions are requested separately. When no camera is available, a black canvas placeholder creates an outgoing video sender, allowing the Admin to broadcast a selected MP4/WebM file through the existing replaceTrack() implementation. When no microphone is available, the call proceeds without microphone audio. On browsers without canvas captureStream, a file broadcast may be unavailable. Live camera/media connectivity still requires a real-device test.
