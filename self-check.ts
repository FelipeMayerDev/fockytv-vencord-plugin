// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { pcmHeader, PcmBuffer } from "./pcm";
import { captureConstraints, discordPatches, matchCamera } from "./discord";
import { cameraKey, serverUrl, sessionUrl, streamKey } from "./protocol";
import { streamAudio } from "./playback";

function checkPlayback() {
    const previousAudio = globalThis.Audio, previousContext = globalThis.AudioContext;
    let paused = 0, disconnected = 0, closed = 0, connected = 0;
    const tracks: MediaStreamTrack[] = [];
    const media = Object.assign(new EventTarget(), { getAudioTracks: () => tracks }) as unknown as MediaStream;
    const audio = { muted: false, srcObject: null as MediaStream | null, play: async () => {}, pause: () => { paused++; } };
    const gain = { gain: { value: -1 }, connect() {}, disconnect() { disconnected++; } };
    Object.assign(globalThis, {
        Audio: class { constructor() { return audio; } },
        AudioContext: class {
            destination = {};
            createMediaStreamSource(stream: unknown) {
                assert.equal(stream, media);
                return { connect(node: unknown) { assert.equal(node, gain); connected++; }, disconnect() { disconnected++; } };
            }
            createGain() { return gain; }
            async resume() {}
            async close() { closed++; }
        }
    });
    try {
        const playback = streamAudio(media);
        assert.equal(audio.srcObject, media);
        assert.equal(audio.muted, true, "The media element must not bypass the gain node");
        assert.equal(connected, 0, "Video may arrive before audio");
        tracks.push({ kind: "audio" } as MediaStreamTrack);
        media.dispatchEvent(new Event("addtrack"));
        assert.equal(connected, 1);
        assert.equal(gain.gain.value, 0, "Start silent until Discord settings are applied");
        for (const [volume, output, muted, expected] of [
            [100, 100, false, 1], [50, 100, false, 0.5], [200, 100, false, 2],
            [200, 50, false, 1], [0, 100, false, 0], [100, 0, false, 0],
            [200, 100, true, 0], [NaN, 100, false, 0], [-100, 100, false, 0]
        ] as const) {
            playback.update(volume, output, muted);
            assert.equal(gain.gain.value, expected);
        }
        playback.update(100, 100, false);
        assert.equal(gain.gain.value, 1, "Unmute restores the saved volume");
        tracks.pop();
        media.dispatchEvent(new Event("removetrack"));
        assert.equal(disconnected, 1);
        tracks.push({ kind: "audio" } as MediaStreamTrack);
        media.dispatchEvent(new Event("addtrack"));
        assert.equal(connected, 2, "Republished audio reconnects without resetting volume");
        assert.equal(gain.gain.value, 1);
        playback.close();
        assert.equal(audio.srcObject, null);
        assert.equal(paused, 1); assert.equal(disconnected, 3); assert.equal(closed, 1);
        media.dispatchEvent(new Event("addtrack"));
        assert.equal(connected, 2, "Closed playback ignores late track events");
    } finally {
        if (previousAudio) globalThis.Audio = previousAudio; else Reflect.deleteProperty(globalThis, "Audio");
        if (previousContext) globalThis.AudioContext = previousContext; else Reflect.deleteProperty(globalThis, "AudioContext");
    }
    console.log("FockyTV: stream volume, boost, mute and playback cleanup checks passed");
}
checkPlayback();

assert.equal(streamKey(" Discord-RUST "), "Discord-RUST");
for (const key of ["", "nick room", "á", "a".repeat(33), "nick/room", "nick\nx"])
    assert.throws(() => streamKey(key));
assert.equal(cameraKey("a".repeat(32)), `${"a".repeat(28)}-cam`);
assert.equal(serverUrl("https://tv.example/"), "https://tv.example");
for (const value of ["file:///tmp/test", "https://user:pass@tv.example", "https://tv.example/?x=1"])
    assert.throws(() => serverUrl(value));
assert.equal(sessionUrl("/api/whip/id", "https://tv.example/api/whip"), "https://tv.example/api/whip/id");
assert.equal(sessionUrl("/api/livekit/whip/id", "https://tv.example/api/livekit/whip"), "https://tv.example/api/livekit/whip/id");
assert.throws(() => sessionUrl("/api/whip/id", "https://tv.example/api/livekit/whip"));
for (const value of ["https://evil.example/api/whip/id", "/api/status", "/api/whip"])
    assert.throws(() => sessionUrl(value, "https://tv.example/api/whip"));
assert.equal(captureConstraints({ id: "screen:0:0" }, 60, 1080).video.mandatory.chromeMediaSourceId, "screen:0:0");
assert.equal(captureConstraints({ id: "screen:0" }, 60, 1080).video.mandatory.chromeMediaSourceId, "screen:0:0");
assert.equal(captureConstraints({ id: "window:1234" }, 60, 1080).video.mandatory.chromeMediaSourceId, "window:1234:0");
assert.equal(captureConstraints({ id: "screen:-1" }, 60, 1080).video.mandatory.chromeMediaSourceId, "screen:-1:0");
assert.equal(captureConstraints({ windowHandle: "1234" }, 30, 0).video.mandatory.chromeMediaSourceId, "window:1234:0");
assert.equal(captureConstraints({ id: "window:4321:0", windowHandle: "1234" }, 30, 720).video.mandatory.chromeMediaSourceId, "window:4321:0");
for (const source of [{}, { id: "camera:1" }, { windowHandle: "../bad" }])
    assert.throws(() => captureConstraints(source, 60, 1080));
assert.throws(() => captureConstraints({ id: "screen:0:0" }, NaN, 1080));
assert.throws(() => captureConstraints({ id: "screen:0:0" }, 60, -1));
const cameras = [{ deviceId: "card", label: "USB3 Video (345f:2131)" }, { deviceId: "cam", label: "USB Live camera (0c45:6366)" }];
assert.equal(matchCamera({ name: "USB Live camera" }, cameras), "cam");
assert.equal(matchCamera({ name: "Webcam", id: "\\\\?\\usb#vid_0c45&pid_6366&mi_00#7&183af011" }, cameras), "cam");
assert.equal(matchCamera({ name: "Outra" }, cameras), undefined);
const fixtures = [
    'if(null==(b="number"==typeof e?s.Ay.getGameForPID(e):e))return[!1,"no source"];',
    'setVideoEnabled(e){e&&(0,u.PX)(),a.h.dispatch({type:"MEDIA_ENGINE_SET_VIDEO_ENABLED",enabled:e})}',
    'isVideoEnabled(){return tm&&tL}isVideoAvailable(){return Object.values(tA).some(e=>!e.disabled)}',
    'getInitialState(){return{selfVideo:I.Ay.isVideoEnabled(),flags:0}}getNextState(e){return{selfVideo:I.Ay.isVideoEnabled()}}',
    'let n={channelId:t.channelId,selfStream:t.selfStream,selfVideo:t.selfVideo,sessionId:t.sessionId,suppress:t.suppress}',
    'streamWatch(e){this.send(e2.STREAM_WATCH,{stream_key:e})}streamDelete(e){this.send(e2.STREAM_DELETE,{stream_key:e})}',
    'getCurrentUserActiveStream(){return null}',
    'l.h.dispatch({type:"STREAM_STOP",streamKey:e,appContext:"APP"})',
    'getStreamForUser(u,g){return null}getActiveStreamForStreamKey(k){return null}getAllActiveStreams(){return []}getAllActiveStreamsForChannel(c){return []}' +
        'VOICE_STATE_UPDATES:function(e){return e.voiceStates.reduce((e,t)=>{let{userId:i,guildId:a,channelId:s,sessionId:o,selfStream:d,discoverable:c}=t;if(d&&null!=s)return!0},!1)}',
    'getVideoComponent(){return engine.Video}',
    'function E(e,t,E){if(u.isPlatformEmbedded)(0,r.openModalLazy)(async()=>{return t=>(0,i.jsx)(e,{...t,analyticsLocations:E})});else{let n=l.A.getChannel(t);d.Ay.getMediaEngine().getDesktopSource(i,!0).then(n=>{(0,a.XI)(e,t,{pid:null,sourceId:n,sourceName:null,analyticsLocations:E})})}}',
    'children:[w??Q.Ay.getName($),z?(0,i.jsxs)("span",{className:en.IW,children:["\\xa0",et.intl.string(et.t["pFO/Ph"])]}):""]',
    'createExperiment({name:"2026-08-video-guard",kind:"user",defaultConfig:{videoEnabled:!0},variations:{1:{videoEnabled:!1},2:{videoEnabled:!1}}})',
    'async function w(g,c,u){if(!s.A.shouldFetchPreview(g,c,u))return;d.h.dispatch({type:"STREAM_PREVIEW_FETCH_START",streamKey:"key"})}',
    'P=r.useCallback((e,r,a,s)=>{if(e){if(null!=_){}}},[]);let J=h.isPlatformEmbedded?(0,i.jsx)(s.Dr,{id:"stream-settings",children:j}):null;',
    'function x(e){!0!==e.noTrack&&(0,S.K2)(e.preset,e.resolution,e.frameRate,e.soundshareEnabled),l.h.dispatch({type:"STREAM_UPDATE_SETTINGS",...e})}'
];
discordPatches.forEach((patch, index) => {
    const replacements = Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement];
    for (const replacement of replacements) {
        const match = typeof replacement.match === "string" ? replacement.match
            : new RegExp(replacement.match.source.replaceAll(String.raw`\i`, String.raw`[A-Za-z_$][\w$]*`), replacement.match.flags);
        const output = fixtures[index].replace(match, replacement.replace);
        assert.notEqual(output, fixtures[index]);
        if (match instanceof RegExp && match.global) assert.equal(output.replace(match, "").length, output.length);
        if (replacement.replace.includes("$self.")) assert.ok(output.includes("$self."));
        else {
            const experiment = new Function("createExperiment", `return ${output}`)((config: unknown) => config);
            assert.equal(experiment.defaultConfig.videoEnabled, true);
            assert.deepEqual(experiment.variations, {});
        }
    }
});
const pcm = new PcmBuffer(8, 32);
pcm.push(new Uint8Array([1, 2, 3]));
assert.equal(pcm.drain().length, 0);
pcm.push(new Uint8Array([4, 5, 6, 7, 8, 9]));
assert.deepEqual([...pcm.drain()], [1, 2, 3, 4, 5, 6, 7, 8]);
pcm.push(new Uint8Array([10, 11, 12, 13, 14, 15, 16]));
assert.deepEqual([...pcm.drain()], [9, 10, 11, 12, 13, 14, 15, 16]);
pcm.push(new Uint8Array(81).map((_, i) => i));
assert.deepEqual([...pcm.drain()], Array.from({ length: 24 }, (_, i) => i + 56));
const header = new Uint8Array(16);
header.set([70, 80, 67, 77]);
const view = new DataView(header.buffer);
view.setUint32(4, 48000, true); view.setUint32(8, 2, true);
assert.deepEqual(pcmHeader(header), { rate: 48000, channels: 2 });
view.setUint32(8, 100, true); assert.throws(() => pcmHeader(header));
console.log("FockyTV: protocol, capture, preview patches and PCM frame checks passed");

async function checkSessions() {
    const { Session } = await import("./session");
    let stopped = 0;
    const addedKinds: string[] = [];
    class Stream {
        getTracks() { return [{ stop: () => stopped++ }]; }
        getVideoTracks() { return []; }
        getAudioTracks() { return []; }
        addTrack() { }
    }
    class Peer extends EventTarget {
        iceGatheringState = "complete";
        connectionState = "new";
        localDescription: RTCSessionDescriptionInit | null = null;
        remoteDescription: RTCSessionDescriptionInit | null = null;
        closed = false;
        ontrack: unknown;
        onconnectionstatechange: unknown;
        constructor(configuration?: RTCConfiguration) {
            super();
            assert.equal(configuration, undefined, "Do not add a mandatory external STUN dependency");
        }
        addTransceiver(track: MediaStreamTrack | string, options: RTCRtpTransceiverInit) {
            if (typeof track !== "string") {
                assert.equal(options.direction, "sendonly");
                assert.ok(options.streams?.length);
                if (track.kind === "video") assert.deepEqual(options.sendEncodings, [{ maxBitrate: 32_000_000 }]);
                else assert.equal(options.sendEncodings, undefined);
                addedKinds.push(track.kind);
            }
            return { sender: {} };
        }
        getTransceivers() { return []; }
        async createOffer() { return { type: "offer", sdp: "offer" }; }
        async setLocalDescription(value: RTCSessionDescriptionInit) { this.localDescription = value; }
        async setRemoteDescription(value: RTCSessionDescriptionInit) {
            this.remoteDescription = value;
            if (value.sdp === "answer") this.connectionState = "connected";
        }
        close() { this.closed = true; this.connectionState = "closed"; this.dispatchEvent(new Event("connectionstatechange")); }
    }
    Object.assign(globalThis, {
        RTCPeerConnection: Peer, MediaStream: Stream,
        RTCRtpSender: { getCapabilities: () => ({ codecs: [] }) }
    });
    const calls: string[] = [];
    const session = new Session(async (url, method, key, body) => {
        calls.push(`${method} ${url}`);
        assert.equal(key, "alice");
        if (method === "POST") assert.equal(body, "offer");
        return { status: method === "POST" ? 201 : 204, body: "answer", location: "/api/whip/test" };
    }, "alice", new Stream() as unknown as MediaStream);
    await session.connect("https://tv.example/api/whip");
    await session.close(); await session.close();
    assert.equal(stopped, 2);
    assert.deepEqual(calls, ["POST https://tv.example/api/whip", "DELETE https://tv.example/api/whip/test"]);
    assert.equal((session.pc as unknown as Peer).closed, true);
    let audioReleased = 0;
    class Track extends EventTarget {
        stopped = false;
        constructor(public kind: string) { super(); }
        stop() { this.stopped = true; }
    }
    const onlyVideo = new Track("video");
    const videoOnly = new Session(async () => ({ status: 204, body: "", location: null }), "alice", {
        getVideoTracks: () => [onlyVideo], getAudioTracks: () => [], getTracks: () => [onlyVideo]
    } as unknown as MediaStream);
    assert.deepEqual(addedKinds, ["video"], "Video-only WHIP must not advertise an audio sender without packets");
    await videoOnly.close();
    assert.ok(onlyVideo.stopped);
    addedKinds.length = 0;
    const videoTrack = new Track("video"), audioTrack = new Track("audio");
    const capture = {
        getVideoTracks: () => [videoTrack], getAudioTracks: () => [audioTrack],
        getTracks: () => [audioTrack, videoTrack]
    } as unknown as MediaStream;
    const withAudio = new Session(async () => ({ status: 204, body: "", location: null }), "alice", capture, () => audioReleased++);
    assert.deepEqual(addedKinds, ["video", "audio"]);
    await withAudio.close(); await withAudio.close();
    assert.equal(audioReleased, 1);
    assert.ok(videoTrack.stopped && audioTrack.stopped);

    let respond: (value: { status: number; body: string; location: string; }) => void;
    let posted: () => void;
    const postStarted = new Promise<void>(resolve => posted = resolve);
    const deleted: string[] = [];
    const cancelled = new Session(async (url, method) => {
        if (method === "POST") {
            posted();
            return new Promise(resolve => respond = resolve);
        }
        deleted.push(url);
        return { status: 204, body: "", location: null };
    }, "alice");
    const connecting = cancelled.connect("https://tv.example/api/whep");
    const rejected = assert.rejects(connecting, /cancelada/);
    await postStarted;
    await cancelled.close();
    respond!({ status: 201, body: "answer", location: "/api/whep/late" });
    await rejected;
    assert.deepEqual(deleted, ["https://tv.example/api/whep/late"]);

    const negotiating = new Session(async (_url, method) => ({ status: method === "POST" ? 201 : 204, body: "pending", location: "/api/whip/pending" }), "alice");
    let connected = false;
    const waiting = negotiating.connect("https://tv.example/api/whip").then(() => { connected = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(connected, false, "HTTP 201 must not confirm a WebRTC connection");
    const peer = negotiating.pc as unknown as Peer;
    peer.connectionState = "connected";
    peer.dispatchEvent(new Event("connectionstatechange"));
    await waiting;
    await negotiating.close();

    const interrupted = new Session(async (_url, method) => ({ status: method === "POST" ? 201 : 204, body: "pending", location: "/api/whip/interrupted" }), "alice");
    const interruptedConnect = assert.rejects(interrupted.connect("https://tv.example/api/whip"), /cancelada/);
    await new Promise(resolve => setTimeout(resolve, 0));
    await interrupted.close();
    await interruptedConnect;

    const originalTimeout = globalThis.setTimeout;
    const timedOut = new Session(async (_url, method) => ({ status: method === "POST" ? 201 : 204, body: "pending", location: "/api/whip/timeout" }), "alice");
    try {
        globalThis.setTimeout = ((callback, ms, ...args) => originalTimeout(callback, ms === 20_000 ? 0 : ms, ...args)) as typeof setTimeout;
        await assert.rejects(timedOut.connect("https://tv.example/api/whip"), /Tempo esgotado ao conectar/);
        assert.equal((timedOut.pc as unknown as Peer).closed, true);
    } finally { globalThis.setTimeout = originalTimeout; }

    try {
        globalThis.setTimeout = ((callback, ms, ...args) => originalTimeout(callback, ms === 10_000 ? 0 : ms, ...args)) as typeof setTimeout;
        for (const hasCandidate of [true, false]) {
            const offer = "v=0\r\n" + (hasCandidate ? "a=candidate:1 1 UDP 2122260223 192.0.2.1 50000 typ host\r\n" : "");
            let posted = false;
            const gathering = new Session(async (_url, method, _key, body) => {
                if (method === "POST") { posted = true; assert.equal(body, offer); }
                return { status: method === "POST" ? 201 : 204, body: "answer", location: "/api/whip/gathering" };
            }, "alice");
            const gatheringPeer = gathering.pc as unknown as Peer;
            gatheringPeer.iceGatheringState = "gathering";
            gatheringPeer.createOffer = async () => ({ type: "offer", sdp: offer });
            if (hasCandidate) await gathering.connect("https://tv.example/api/whip");
            else await assert.rejects(gathering.connect("https://tv.example/api/whip"), /Nenhum candidato ICE/);
            assert.equal(posted, hasCandidate, "Only signal an incomplete offer if it has candidates");
            await gathering.close();
        }
    } finally { globalThis.setTimeout = originalTimeout; }

    const livekitCalls: string[] = [];
    const livekit = new Session(async (url, method, key) => {
        assert.equal(key, "alice");
        livekitCalls.push(`${method} ${url}`);
        return { status: method === "POST" ? 201 : 204, body: "answer", location: "/api/livekit/whip/livekit" };
    }, "alice");
    await livekit.connect("https://tv.example/api/livekit/whip");
    await livekit.close();
    assert.deepEqual(livekitCalls, ["POST https://tv.example/api/livekit/whip", "DELETE https://tv.example/api/livekit/whip/livekit"]);

    const failed = new Session(async () => ({ status: 400, body: "host active", location: null }), "alice");
    await assert.rejects(failed.connect("https://tv.example/api/whip"), /host active/);
    assert.equal((failed.pc as unknown as Peer).closed, true);
    console.log("FockyTV: session lifecycle checks passed");
}
async function checkAudioTrack() {
    const { screenAudio } = await import("./audio");
    const existingAudio = { stopped: false, stop(this: { stopped: boolean; }) { this.stopped = true; } } as unknown as MediaStreamTrack;
    const nativeTracks = [existingAudio];
    const nativeCapture = {
        getAudioTracks: () => nativeTracks,
        removeTrack: (track: MediaStreamTrack) => nativeTracks.splice(nativeTracks.indexOf(track), 1)
    } as unknown as MediaStream;
    const unsupported = {
        startAudio: async () => { throw new Error("The Windows helper must not be called"); },
        readAudio: async () => new Uint8Array(), stopAudio: async () => {}
    };
    const fail = (error: unknown) => { throw error; };
    await screenAudio(unsupported, nativeCapture, "screen:0:0", true, false, fail);
    await screenAudio(unsupported, nativeCapture, "screen:0:0", true, true, fail);
    assert.deepEqual(nativeTracks, [existingAudio], "Keep audio supplied by the client's picker");
    await screenAudio(unsupported, nativeCapture, "screen:0:0", false, false, fail);
    assert.equal(nativeTracks.length, 0, "Disabled sound must remove picker-provided audio");
    assert.equal((existingAudio as unknown as { stopped: boolean; }).stopped, true);
    await screenAudio(unsupported, nativeCapture, "screen:0:0", true, false, fail);
    const frames: Array<{ timestamp: number; closed: boolean; }> = [];
    let notifyFrame: () => void;
    const firstFrame = new Promise<void>(resolve => notifyFrame = resolve);
    class Generator {
        kind = "audio";
        stopped = false;
        writable = new WritableStream({ write(frame) { frames.push(frame); notifyFrame(); } });
        stop() { this.stopped = true; }
    }
    class Frame {
        closed = false;
        timestamp: number;
        constructor(data: { numberOfFrames: number; numberOfChannels: number; sampleRate: number; timestamp: number; data: Uint8Array; }) {
            assert.equal(data.sampleRate, 48000); assert.equal(data.numberOfChannels, 2);
            assert.equal(data.data.length, data.numberOfFrames * 8);
            this.timestamp = data.timestamp;
        }
        close() { this.closed = true; }
    }
    Object.assign(globalThis, { window: { MediaStreamTrackGenerator: Generator, AudioData: Frame } });
    let stopped = 0;
    let addedTrack: MediaStreamTrack;
    const stop = await screenAudio({
        startAudio: async () => ({ id: "test", rate: 48000, channels: 2 }),
        readAudio: async id => { assert.equal(id, "test"); return new Uint8Array(960 * 8); },
        stopAudio: async id => { assert.equal(id, "test"); stopped++; }
    }, { getAudioTracks: () => [], addTrack: (track: MediaStreamTrack) => { addedTrack = track; } } as unknown as MediaStream, "screen:0:0", true, true, fail);
    const timeout = setTimeout(() => notifyFrame(), 2000);
    await firstFrame; clearTimeout(timeout);
    stop!(); stop!();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(frames.length > 0);
    assert.ok(frames.every(frame => frame.closed));
    assert.ok((addedTrack! as unknown as Generator).stopped);
    assert.equal(stopped, 1);
    console.log("FockyTV: PCM to audio track and cleanup checks passed");
}
async function checkViewer() {
    // Node 22 (aceito pelo instalador) ainda não tem CloseEvent; o renderer do Discord tem.
    globalThis.CloseEvent ??= class extends Event {
        code: number; reason: string; wasClean: boolean;
        constructor(type: string, init: CloseEventInit = {}) { super(type); this.code = init.code ?? 0; this.reason = init.reason ?? ""; this.wasClean = init.wasClean ?? false; }
    } as typeof CloseEvent;
    const { loadLivekit, proxySocket } = await import("./viewer");
    const sent: unknown[] = [];
    let closed: unknown[] | undefined;
    const pending = [[{ type: "open" }, { type: "message", data: new Uint8Array([1, 2, 3]) }, { type: "message", data: "text" }], [{ type: "close", code: 1000, reason: "bye" }]];
    const Socket = proxySocket({
        socketOpen: async (url, protocols) => { assert.equal(url, "wss://tv.example/livekit/rtc"); assert.deepEqual(protocols, []); return 7; },
        // Como o nativo (long-poll): sem eventos, a leitura fica pendente.
        socketRead: id => { assert.equal(id, 7); return pending.length ? Promise.resolve(pending.shift() as never) : new Promise(() => {}); },
        socketSend: async (id, data) => { sent.push(data); },
        socketClose: async (id, ...args) => { closed = args; }
    });
    // O UMD do LiveKit usa `new WebSocket(...)` livre; deve pegar o proxy, não o global.
    const sdk = loadLivekit("exports.Room=function(){};exports.socket=new WebSocket('wss://tv.example/livekit/rtc')", Socket);
    const socket = sdk.socket as InstanceType<typeof Socket>;
    const events: string[] = [];
    socket.onopen = () => events.push("open");
    socket.addEventListener("message", event => events.push((event as MessageEvent).data instanceof ArrayBuffer ? `bin:${[...new Uint8Array((event as MessageEvent).data)]}` : `txt:${(event as MessageEvent).data}`));
    socket.onclose = event => events.push(`close:${event.code}:${event.reason}`);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(events, ["open", "bin:1,2,3", "txt:text", "close:1000:bye"]);
    assert.equal(socket.readyState, Socket.CLOSED);
    const second = new Socket("wss://tv.example/livekit/rtc");
    second.send(new Uint8Array([9, 8, 7]).subarray(1));
    second.send(new Uint8Array([5]).buffer);
    second.close(1000, "done"); second.close();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(sent.map(data => [...(data as Uint8Array)]), [[8, 7], [5]]);
    assert.deepEqual(closed, [1000, "done"]);
    assert.throws(() => loadLivekit("exports.nothing=1", Socket), /SDK LiveKit/);
    console.log("FockyTV: LiveKit socket proxy and SDK loader checks passed");
}
async function checkThumbnails() {
    const { thumbnail } = await import("./thumbnail");
    const previous = globalThis.document;
    let broken = false, paused = 0, drawn = 0;
    const video = {
        muted: false, playsInline: false, videoWidth: 640, videoHeight: 480,
        srcObject: null as MediaStream | null, onloadeddata: null as (() => void) | null, onerror: null as (() => void) | null,
        play() {
            if (broken) return Promise.reject(new Error("No frames"));
            queueMicrotask(() => this.onloadeddata?.());
            return Promise.resolve();
        },
        pause() { paused++; }
    };
    const canvas = { width: 0, height: 0,
        getContext: () => ({ fillStyle: "", fillRect() {}, drawImage(element: unknown, ...rect: number[]) {
            assert.equal(element, video); assert.deepEqual(rect, [40, 0, 240, 180]); drawn++;
        } }),
        toDataURL(type: string, quality: number) { assert.equal(type, "image/jpeg"); assert.equal(quality, 0.7); return "data:image/jpeg;base64,test"; }
    };
    Object.assign(globalThis, { document: { createElement: (tag: string) => tag === "video" ? video : canvas } });
    try {
        const media = {} as MediaStream;
        assert.equal(await thumbnail(media), "data:image/jpeg;base64,test");
        assert.equal(video.muted, true);
        assert.equal(drawn, 1);
        assert.equal(canvas.width, 320); assert.equal(canvas.height, 180);
        assert.equal(video.srcObject, null); assert.equal(paused, 1);
        broken = true;
        await assert.rejects(thumbnail(media), /No frames/);
        assert.equal(video.srcObject, null); assert.equal(paused, 2);
    } finally { if (previous) globalThis.document = previous; else Reflect.deleteProperty(globalThis, "document"); }
    console.log("FockyTV: muted thumbnails, aspect ratio and cleanup checks passed");
}

async function checkUpdates() {
    const { checkUpdate, installUpdate } = await import("./updater");
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "fockytv update ! "));
    const directory = join(root, "dist"); mkdirSync(directory);
    const metadata = join(directory, "fockytv-update.json");
    const state = { source: root, client: "vesktop", target: root, node: process.execPath, revision: "1".repeat(40) };
    const previousFetch = globalThis.fetch;
    let revision = state.revision, http = 200, downloads = 0;
    const installer = 'import {writeFileSync} from "node:fs";setTimeout(()=>writeFileSync(new URL("./finished.json",import.meta.url),JSON.stringify(process.argv.slice(2))),150);';
    globalThis.fetch = async input => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/repos/FelipeMayerDev/fockytv-vencord-plugin/commits/main")) return Response.json({ sha: revision }, { status: http });
        assert.equal(url, `https://raw.githubusercontent.com/FelipeMayerDev/fockytv-vencord-plugin/${revision}/installer/install.mjs`);
        downloads++;
        return new Response(installer);
    };
    try {
        await assert.rejects(checkUpdate(directory), /Execute o instalador/);
        writeFileSync(join(root, "package.json"), "{}");
        writeFileSync(metadata, JSON.stringify(state));
        assert.equal((await checkUpdate(directory)).available, false);
        assert.deepEqual(await installUpdate(directory), { started: false });
        assert.equal(downloads, 0, "Checking must never download or execute an installer");
        revision = "2".repeat(40);
        assert.equal((await checkUpdate(directory)).available, true);
        assert.equal(downloads, 0);
        revision = "../../invalid";
        await assert.rejects(checkUpdate(directory), /Versão de atualização inválida/);
        assert.equal(downloads, 0);
        revision = "2".repeat(40);
        http = 503;
        await assert.rejects(installUpdate(directory), /HTTP 503/);
        http = 200;
        assert.deepEqual(await installUpdate(directory), { started: true });
        await assert.rejects(installUpdate(directory), /em andamento/);
        const finished = join(root, ".fockytv-updater", "finished.json");
        for (let i = 0; i < 100 && !existsSync(finished); i++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.deepEqual(JSON.parse(readFileSync(finished, "utf8")), ["--client", "vesktop", "--source", root, "--target", root]);
        writeFileSync(metadata, JSON.stringify({ ...state, node: "relative-node" }));
        await assert.rejects(checkUpdate(directory), /Dados da instalação inválidos/);
    } finally { globalThis.fetch = previousFetch; rmSync(root, { recursive: true, force: true }); }
    console.log("FockyTV: update checks, explicit install, pinned source and safe argv checks passed");
}

Promise.all([checkSessions(), checkAudioTrack(), checkViewer(), checkThumbnails(), checkUpdates()]).catch(error => { console.error(error); process.exitCode = 1; });
