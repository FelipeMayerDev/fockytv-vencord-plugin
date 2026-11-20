// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { discordPatches, captureConstraints } from "./discord";
import { qualityConstraints, shareQuality } from "./quality";
import { LivePublisher } from "./session";

test("Discord values override defaults, including source resolution and 5 FPS", () => {
    const defaults = { fps: 60, resolution: 1080, soundshareEnabled: true };
    const selected = shareQuality({ fps: 5, resolution: 0 }, defaults);
    assert.equal(selected.fps, 5);
    assert.equal(selected.resolution, 1080, "Source is capped at 1080p");
    assert.equal(shareQuality({ resolution: 2160 }, defaults).resolution, 1080);
    assert.equal(shareQuality({ resolution: 720 }, defaults).resolution, 720);
    assert.equal(shareQuality({ resolution: 1440 }, defaults).fps, 60);
    assert.deepEqual(qualityConstraints(selected), { frameRate: { ideal: 5, max: 5 }, height: { ideal: 1080, max: 1080 } });
    assert.equal(captureConstraints({ id: "screen:0:0" }, selected.fps, selected.resolution).video.mandatory.maxFrameRate, 5);
    for (const value of [{ fps: NaN }, { fps: 0 }, { resolution: -1 }, { resolution: 8000 }])
        assert.throws(() => shareQuality(value, defaults));
});

// livekit-client falso: só o que o LivePublisher usa.
function fakeLivekit(sender: object = {}) {
    const log = { connects: [] as string[], published: [] as { track: MediaStreamTrack; options: any; }[], unpublished: [] as unknown[], metadata: [] as string[], announces: [] as string[], disconnects: 0 };
    const rooms: InstanceType<typeof Room>[] = [];
    class Room {
        handlers: Record<string, () => void> = {};
        localParticipant = {
            publishTrack: async (track: MediaStreamTrack, options: any) => {
                log.published.push({ track, options });
                return { track: { sender: track.kind === "video" ? sender : {}, replaceTrack: async () => {}, getRTCStatsReport: async () => new Map([["out", { type: "outbound-rtp" }]]) } };
            },
            unpublishTrack: async (track: unknown) => { log.unpublished.push(track); },
            setMetadata: async (value: string) => { log.metadata.push(value); }
        };
        constructor() { rooms.push(this); }
        on(event: string, handler: () => void) { this.handlers[event] = handler; }
        async connect(url: string, token: string) { log.connects.push(`${url} ${token}`); }
        async disconnect() { log.disconnects++; this.handlers.disconnected?.(); }
    }
    const sdk = { Room, RoomEvent: { Disconnected: "disconnected" }, Track: { Source: { Camera: "camera", ScreenShare: "screen_share", ScreenShareAudio: "screen_share_audio" } } };
    const join = async (url: string, method: string, key?: string, body?: string) => {
        if (url.endsWith("/announce")) {
            log.announces.push(`${method} ${url} ${key} ${body}`);
            return { status: 201, body: "", location: null };
        }
        assert.equal(`${method} ${url}`, "POST https://tv/api/livekit/join");
        assert.deepEqual(JSON.parse(body!), { room: "publisher", role: "publisher" });
        return { status: 200, body: JSON.stringify({ token: "tok", path: "/livekit" }), location: null };
    };
    return { sdk, log, join, rooms };
}

test("WebRTC publishes straight to LiveKit as H.264 without simulcast, with music audio", async () => {
    (globalThis as any).RTCRtpSender = { getCapabilities: () => ({ codecs: [{ mimeType: "video/H264" }] }) };
    const video = new class extends EventTarget { kind = "video"; stop() {} }(), audio = { kind: "audio", stop() {} };
    const capture = { getVideoTracks: () => [video], getAudioTracks: () => [audio], getTracks: () => [video, audio] } as unknown as MediaStream;
    const { sdk, log, join } = fakeLivekit();
    const session = new LivePublisher(sdk, join, "publisher", false, capture);
    await session.connect("https://tv", 60);
    assert.deepEqual(log.connects, ["wss://tv/livekit tok"]);
    const encoding = { maxBitrate: 12_000_000, maxFramerate: 60 };
    assert.deepEqual(log.published.map(p => p.options), [
        { source: "screen_share", videoCodec: "h264", backupCodec: false, simulcast: false, degradationPreference: "maintain-framerate", videoEncoding: encoding, screenShareEncoding: encoding },
        { source: "screen_share_audio", dtx: false, red: false, forceStereo: true, audioPreset: { maxBitrate: 128_000 } }
    ], "LiveKit's default screen encoding is 1080p 15 FPS");
    assert.equal((video as unknown as MediaStreamTrack).contentHint, "motion", "Screen share keeps FPS before sharpness");
    assert.equal((await session.getStats()).size, 1);
    // Aviso do bot: vai ao servidor da live com a chave do dono como bearer.
    assert.equal(await session.announce("{}"), 201);
    assert.deepEqual(log.announces, ["POST https://tv/api/livekit/announce publisher {}"]);
    await session.close();
    await assert.rejects(session.announce("{}"), /não conectou/);

    // Cliente sem H.264 no WebRTC: anunciar h264 e negociar VP8 deixa a live preta no SFU.
    const noH264 = fakeLivekit();
    (globalThis as any).RTCRtpSender = { getCapabilities: () => ({ codecs: [{ mimeType: "video/VP8" }] }) };
    await new LivePublisher(noH264.sdk, noH264.join, "publisher", false, capture).connect("https://tv", 60);
    assert.equal(noH264.log.published[0].options.videoCodec, "vp8");
    (globalThis as any).RTCRtpSender = { getCapabilities: () => ({ codecs: [{ mimeType: "video/H264" }] }) };

    const camera = fakeLivekit();
    const lens = new class extends EventTarget { kind = "video"; stop() {} }();
    await new LivePublisher(camera.sdk, camera.join, "publisher", true, { getVideoTracks: () => [lens], getAudioTracks: () => [], getTracks: () => [lens] } as unknown as MediaStream).connect("https://tv", 30);
    assert.equal((lens as unknown as MediaStreamTrack).contentHint, undefined, "Camera keeps the browser default hint");
    assert.equal(camera.log.published[0].options.source, "camera");

    let released = 0;
    const busy = fakeLivekit();
    const refused = new LivePublisher(busy.sdk, async () => ({ status: 409, body: "Já existe uma transmissão nesta sala", location: null }), "publisher", false, capture, () => released++);
    await assert.rejects(refused.connect("https://tv", 30), /Já existe/);
    assert.equal(released, 1);
    assert.equal(busy.log.connects.length, 0);
});

test("quality changes keep the LiveKit connection, audio and tracks; failures roll back", async () => {
    let released = 0, releasedVideo = 0, stopped = 0, failEncoding = false;
    const audio = { kind: "audio", stop() { stopped++; } };
    const video = new class extends EventTarget {
        kind = "video";
        constraints: MediaTrackConstraints = qualityConstraints({ fps: 30, resolution: 720 });
        history: MediaTrackConstraints[] = [];
        getConstraints() { return structuredClone(this.constraints); }
        async applyConstraints(value: MediaTrackConstraints) {
            await Promise.resolve();
            this.constraints = structuredClone(value);
            this.history.push(this.constraints);
        }
        stop() { stopped++; }
    }();
    const sender = {
        parameters: { encodings: [{ maxFramerate: 30, scaleResolutionDownBy: 1, maxBitrate: 32_000_000 }] },
        getParameters() { return structuredClone(this.parameters); },
        async setParameters(value: { encodings: { maxFramerate: number; scaleResolutionDownBy: number; maxBitrate: number; }[] }) {
            if (failEncoding) { failEncoding = false; throw new Error("encoder failed"); }
            this.parameters = structuredClone(value);
        }
    };
    const capture = { getVideoTracks: () => [video], getAudioTracks: () => [audio], getTracks: () => [video, audio] };
    const { sdk, log, join } = fakeLivekit(sender);
    let failed = 0;
    const session = new LivePublisher(sdk, join, "publisher", false, capture as unknown as MediaStream, () => released++, () => releasedVideo++, () => failed++);
    await session.connect("https://tv", 30);
    session.style = "rainbow";
    await Promise.all([session.setQuality({ fps: 60, resolution: 1080 }), session.setQuality({ fps: 15, resolution: 480 })]);
    assert.equal(video.history.length, 2);
    assert.deepEqual(video.constraints, qualityConstraints({ fps: 15, resolution: 480 }));
    assert.equal(sender.parameters.encodings[0].maxFramerate, 15);
    await session.setQuality({ fps: 60, resolution: 0 });
    assert.deepEqual(video.constraints.height, { ideal: 1080, max: 1080 }, "Source is capped at 1080p");
    const before = structuredClone(sender.parameters);
    failEncoding = true;
    await assert.rejects(session.setQuality({ fps: 30, resolution: 720 }), /encoder failed/);
    assert.deepEqual(sender.parameters, before);
    assert.deepEqual(video.constraints, qualityConstraints({ fps: 60, resolution: 1080 }));
    await session.setQuality({ fps: 30, resolution: 720 });
    assert.equal(log.connects.length, 1, "Must not reconnect");
    assert.equal(released, 0);
    assert.equal(stopped, 0);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(log.metadata.map(body => JSON.parse(body)), [
        { resolution: 1080, fps: 60 }, { resolution: 480, fps: 15 }, { resolution: 1080, fps: 60 }, { resolution: 720, fps: 30 }
    ].map(quality => ({ ...quality, style: "rainbow" })), "Viewers see only applied qualities, with the owner's live style; a failed change is not announced");
    for (const quality of [{ fps: 60, resolution: 1080 }, { fps: 60, resolution: 2160 }, { fps: 30, resolution: 720 }, { fps: 60, resolution: 0 }]) {
        await session.setQuality(quality);
        assert.equal((sender.parameters as RTCRtpSendParameters).degradationPreference, "maintain-framerate");
        assert.equal(sender.parameters.encodings[0].maxFramerate, quality.fps);
    }
    const apply = video.applyConstraints.bind(video);
    let resume!: () => void, started!: () => void;
    const applying = new Promise<void>(resolve => started = resolve);
    video.applyConstraints = async value => {
        started();
        await new Promise<void>(resolve => resume = resolve);
        await apply(value);
    };
    const changing = session.setQuality({ fps: 60, resolution: 1080 });
    await applying;
    await session.close();
    resume();
    await assert.rejects(changing, /encerrada/);
    assert.equal(released, 1);
    assert.equal(releasedVideo, 1);
    assert.equal(stopped, 2);
    await session.close();
    assert.equal(releasedVideo, 1, "Native camera lease is released once");
    assert.equal(log.disconnects, 1);
    assert.equal(failed, 0, "Our own close is not a connection failure");
    await assert.rejects(session.setQuality({ fps: 60, resolution: 1080 }), /encerrada/);
});

test("a dropped room and a dead capture source both fail the live for the owner", async () => {
    let failed = 0;
    const video = new class extends EventTarget { kind = "video"; stop() {} }();
    const capture = { getVideoTracks: () => [video], getAudioTracks: () => [], getTracks: () => [video] } as unknown as MediaStream;
    const { sdk, log, join, rooms } = fakeLivekit();
    const session = new LivePublisher(sdk, join, "publisher", false, capture, undefined, undefined, () => failed++);
    await session.connect("https://tv", 30);
    rooms[0].handlers.disconnected();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(failed, 1, "The owner is alerted when the room connection drops");
    assert.equal(log.disconnects, 1, "The dropped room is closed");
    video.dispatchEvent(new Event("ended"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(failed, 1, "A live already closed by the drop is not reported twice");

    const again = fakeLivekit();
    const lens = new class extends EventTarget { kind = "video"; stop() {} }();
    const second = new LivePublisher(again.sdk, again.join, "publisher", true,
        { getVideoTracks: () => [lens], getAudioTracks: () => [], getTracks: () => [lens] } as unknown as MediaStream, undefined, undefined, () => failed++);
    await second.connect("https://tv", 30);
    lens.dispatchEvent(new Event("ended"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(failed, 2, "The capture source dying alerts the same way as a dropped connection");
    assert.equal(again.log.disconnects, 1);
    lens.dispatchEvent(new Event("ended"));
    assert.equal(failed, 2, "The once-only listener cannot alert twice");
});

test("web capture receives Discord quality and native menu commits only after success", async () => {
    const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
    const openCapture = source.slice(source.indexOf("async function openCapture("), source.indexOf("function watchEnded("));
    const requested: MediaStreamConstraints[] = [];
    let unmuted = 0;
    const createCapture = new Function("shareQuality", "qualityConstraints", "captureConstraints", "navigator", "Native", `
        const discordShare = {}, StreamingSettings = { getState: () => ({ fps: 30, resolution: 720, soundshareEnabled: false }) };
        const settings = { store: { fps: 15, height: 480 } }, IS_WINDOWS = false;
        const screenAudio = async () => () => {};
        ${stripTypeScriptTypes(openCapture)}
        return openCapture;`);
    const stream = (value: MediaStreamConstraints) => ({ getAudioTracks: () => value.audio ? [{}] : [] });
    const capture = createCapture(shareQuality, qualityConstraints, captureConstraints, { mediaDevices: {
        getDisplayMedia: async (value: MediaStreamConstraints) => { requested.push(value); return stream(value); },
        getUserMedia: async (value: MediaStreamConstraints) => { requested.push(value); return stream(value); }
    } }, { unmuteShareAudio: async () => { unmuted++; return 0; } });
    await capture("screen", undefined, { fps: 60, resolution: 1440 });
    assert.equal(requested[0].audio, false);
    assert.deepEqual(requested[0].video, qualityConstraints({ fps: 60, resolution: 1080 }), "1440p is capped at 1080p");
    await capture("screen");
    assert.deepEqual(requested[1].video, qualityConstraints({ fps: 30, resolution: 720 }));
    await capture("screen", { id: "window:1234:0" }, { fps: 5, resolution: 0 });
    await capture("screen", undefined, { soundshareEnabled: true });
    assert.deepEqual(requested.at(-1)!.audio, { autoGainControl: false, echoCancellation: false, noiseSuppression: false, channelCount: 2 }, "Shared audio is requested without voice processing");
    assert.equal(unmuted, 1, "Linux checks the Vesktop share sink only when screen audio is shared");
    assert.equal((requested[2].video as any).mandatory.maxFrameRate, 5);
    assert.equal((requested[2].video as any).mandatory.maxHeight, 1080, "Source is capped at 1080p");

    const lifecycle = source.slice(source.indexOf("function commitDiscordQuality("), source.indexOf("interface Live {"));
    const events: any[] = [], changed: any[] = [], notifications: any[] = [];
    let fail = false;
    const session = { setQuality: async (value: unknown) => { changed.push(value); if (fail) { fail = false; throw new Error("Unsupported"); } } };
    const create = new Function("shareQuality", "FluxDispatcher", "showNotification", "session", `
        let discordQuality = { fps: 30, resolution: 720 }, shareChanges = Promise.resolve();
        let discordShare = {}; const routingEnabled = true, publishers = new Map([['screen', session]]);
        ${stripTypeScriptTypes(lifecycle)}
        return { updateDiscordQuality, flush: () => shareChanges, quality: () => discordQuality, stop: () => { discordShare = null; publishers.clear(); } };`);
    const api = create(shareQuality, { dispatch: (event: unknown) => events.push(event) }, (value: unknown) => notifications.push(value), session);
    assert.equal(api.updateDiscordQuality({ resolution: 1080, frameRate: 60, preset: 3 }), true);
    assert.equal(events.length, 0);
    await api.flush();
    assert.equal(events.at(-1).frameRate, 60);
    fail = true;
    api.updateDiscordQuality({ resolution: 1440, frameRate: 30 });
    await api.flush();
    assert.equal(events.at(-1).resolution, 1080);
    assert.equal(notifications.length, 1);
    api.updateDiscordQuality({ resolution: 480 });
    api.updateDiscordQuality({ frameRate: 5 });
    await api.flush();
    assert.equal(api.quality().resolution, 480);
    assert.equal(api.quality().fps, 5);
    api.updateDiscordQuality({ frameRate: 60 });
    const count = changed.length;
    api.stop();
    await api.flush();
    assert.equal(changed.length, count);
});

test("native quality callback receives resolution/FPS even without a native RTC source", () => {
    const patch = discordPatches.find(patch => patch.find === '"stream-settings-fps"')!;
    const replacements = Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement];
    let code = 'P=r.useCallback((e,r,a,s)=>{if(e){if(null!=_){throw Error("native");}}},[]);let J=h.isPlatformEmbedded?(0,i.jsx)(s.Dr,{id:"stream-settings",children:j}):null;return {P,J};';
    for (const replacement of replacements) {
        const match = new RegExp((replacement.match as RegExp).source.replaceAll(String.raw`\i`, String.raw`[A-Za-z_$][\w$]*`));
        code = code.replace(match, replacement.replace);
    }
    let received: unknown;
    const result = new Function("$self", `const r={useCallback: f=>f},_=null,h={isPlatformEmbedded:false},i={jsx:(_,props)=>props},s={Dr:0},j='menu';let P;${code}`)({
        discordStream: () => ({}), updateDiscordQuality: (value: unknown) => { received = value; return true; },
        streamSettings: (children: unknown) => [children, "simple-share-switch"]
    });
    result.P(true, 1440, 60, "resolution");
    assert.deepEqual(received, { resolution: 1440, frameRate: 60, preset: 3 });
    assert.equal(result.J.id, "stream-settings");
    assert.deepEqual(result.J.children, ["menu", "simple-share-switch"]);
});

test("a dropped live alerts the owner with the Discord stream-ended sound", async () => {
    const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
    const publishCode = source.slice(source.indexOf("async function publish("), source.indexOf('// "Trocar de tela" do Discord'));
    const sender = {
        parameters: { encodings: [{ maxFramerate: 30, scaleResolutionDownBy: 1 }] },
        getParameters() { return structuredClone(this.parameters); },
        async setParameters(value: { encodings: { maxFramerate: number; scaleResolutionDownBy: number; }[] }) { this.parameters = structuredClone(value); }
    };
    const videos: EventTarget[] = [];
    const makeCapture = () => {
        const video = new class extends EventTarget {
            kind = "video";
            constraints: MediaTrackConstraints = {};
            getConstraints() { return structuredClone(this.constraints); }
            async applyConstraints(value: MediaTrackConstraints) { this.constraints = structuredClone(value); }
            stop() {}
        }();
        videos.push(video);
        return { getVideoTracks: () => [video], getAudioTracks: () => [], getTracks: () => [video] };
    };
    let sounds = 0, notes = 0, cleared = 0;
    const { sdk, rooms } = fakeLivekit(sender);
    const publishers = new Map(), pending = new Set();
    const publish = new Function("publishers", "pending", "generation", "discordShare", "makeCapture", "livekit", "LivePublisher", "showNotification", "playStreamEndSound", "clearDiscordShare", `
        const serverBase = () => 'https://tv', nickname = () => 'ana', cameraKey = key => key + '-cam', liveStyle = () => '';
        const settings = { store: { liveStyle: '' } };
        let previewStreamId = 'preview';
        const updatePreview = () => {}, watchEnded = () => {};
        const openCapture = async () => ({ capture: makeCapture(), releaseAudio: undefined, quality: { fps: 30, resolution: 720 } });
        const request = async () => ({ status: 200, body: '{"token":"tok","path":"/livekit"}', location: null });
        ${stripTypeScriptTypes(publishCode)}
        return publish;
    `)(publishers, pending, 0, { channelId: "voice" }, makeCapture, sdk, LivePublisher,
        () => { notes++; }, () => { sounds++; }, () => { cleared++; });
    await publish("screen", { id: "screen:0:0" }, { fps: 30, resolution: 720 });
    assert.ok(publishers.get("screen"), "The live is publishing");
    await publishers.get("screen")!.close();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sounds, 0, "Stopping the live on purpose is silent");
    assert.equal(notes, 0, "Stopping the live on purpose notifies nobody");
    publishers.clear();

    await publish("screen", { id: "screen:0:0" }, { fps: 30, resolution: 720 });
    rooms.at(-1)!.handlers.disconnected();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sounds, 1, "A dropped connection plays the Discord stream-ended sound");
    assert.equal(notes, 1, "A dropped connection also notifies the owner");
    assert.equal(cleared, 1, "The Discord share state is cleared for the owner");
    assert.equal(publishers.has("screen"), false);

    await publish("screen", { id: "screen:0:0" }, { fps: 30, resolution: 720 });
    assert.ok(publishers.has("screen"), "A live is running again");
    videos.at(-1)!.dispatchEvent(new Event("ended"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sounds, 2, "The capture source dying plays the same alert");
    assert.equal(notes, 2);
    assert.equal(publishers.has("screen"), false);
});
