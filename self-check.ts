// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { pcmHeader, PcmBuffer } from "./pcm";
import { captureConstraints, discordPatches } from "./discord";
import { cameraKey, serverUrl, sessionUrl, streamKey } from "./protocol";

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
const fixtures = [
    'if(null==(b="number"==typeof e?s.Ay.getGameForPID(e):e))return[!1,"no source"];',
    'getCurrentUserActiveStream(){return null}',
    'l.h.dispatch({type:"STREAM_STOP",streamKey:e,appContext:"APP"})',
    'getStreamForUser(u,g){return null}getActiveStreamForStreamKey(k){return null}getAllActiveStreams(){return []}getAllActiveStreamsForChannel(c){return []}',
    'getVideoComponent(){return engine.Video}',
    'createExperiment({name:"2026-08-video-guard",kind:"user",defaultConfig:{videoEnabled:!0},variations:{1:{videoEnabled:!1},2:{videoEnabled:!1}}})'
];
discordPatches.forEach((patch, index) => {
    const replacements = Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement];
    for (const replacement of replacements) {
        const match = typeof replacement.match === "string" ? replacement.match
            : new RegExp(replacement.match.source.replaceAll(String.raw`\i`, String.raw`[A-Za-z_$][\w$]*`));
        const output = fixtures[index].replace(match, replacement.replace);
        assert.notEqual(output, fixtures[index]);
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
    const { captureAudio } = await import("./audio");
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
    const audio = await captureAudio({
        startAudio: async () => ({ id: "test", rate: 48000, channels: 2 }),
        readAudio: async id => { assert.equal(id, "test"); return new Uint8Array(960 * 8); },
        stopAudio: async id => { assert.equal(id, "test"); stopped++; }
    }, "screen:0:0", error => { throw error; });
    const timeout = setTimeout(() => notifyFrame(), 2000);
    await firstFrame; clearTimeout(timeout);
    audio.stop(); audio.stop();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(frames.length > 0);
    assert.ok(frames.every(frame => frame.closed));
    assert.ok((audio.track as unknown as Generator).stopped);
    assert.equal(stopped, 1);
    console.log("FockyTV: PCM to audio track and cleanup checks passed");
}
Promise.all([checkSessions(), checkAudioTrack()]).catch(error => { console.error(error); process.exitCode = 1; });
