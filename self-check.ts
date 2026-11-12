// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { pcmHeader, PcmBuffer } from "./pcm";
import { captureConstraints, discordPatches, matchCamera } from "./discord";
import { catchUpRate, spectrumPoints } from "./music";
import { detectProfile } from "./profile";
import { cameraKey, liveStyle, liveStyles, serverUrl, sessionUrl, streamKey } from "./protocol";
import { replayBuffer } from "./replay";
import { streamAudio } from "./playback";
import { receivedQuality } from "./viewer";

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
    assert.equal(catchUpRate(0.02), 1, "Music: tiny drift is left alone");
    assert.equal(catchUpRate(0.9), 1.005, "Music: behind catches up at most 0.5% faster, no seek");
    assert.equal(catchUpRate(-0.2), 0.995, "Music: ahead slows down");
    assert.equal(catchUpRate(2.5), null, "Music: far off seeks");
    const bins = new Uint8Array(1024);
    bins[2] = 255;
    const line = spectrumPoints(bins, 48);
    assert.equal(line.length, 48);
    assert.equal(line[0], 1, "Music: spectrum starts at the bass");
    assert.ok(line.slice(1).every(value => value === 0), "Music: each bin lands in one point only");
    assert.ok(spectrumPoints(bins.fill(255), 48).every(value => value === 1), "Music: no empty point up to 15 kHz");
}
checkPlayback();

{
    const stats = (entries: object[]) => ({ getStats: async () => new Map(entries.map((entry, index) => [String(index), entry])) as unknown as RTCStatsReport });
    void Promise.all([
        receivedQuality(stats([{ type: "inbound-rtp", kind: "audio" }, { type: "inbound-rtp", kind: "video", frameHeight: 1080, framesPerSecond: 52 }])),
        receivedQuality(stats([{ type: "inbound-rtp", kind: "video", frameHeight: 720, framesPerSecond: 27 }]), 60),
        receivedQuality(stats([{ type: "inbound-rtp", kind: "video" }])),
        receivedQuality(undefined)
    ]).then(([measured, announced, empty, none]) => {
        assert.deepEqual(measured, { resolution: 1080, fps: 60 }, "Measured FPS snaps to 15/30/60 so the badge does not flicker");
        assert.deepEqual(announced, { resolution: 720, fps: 60 }, "An announced FPS wins over the measurement");
        assert.equal(empty, undefined);
        assert.equal(none, undefined);
        console.log("FockyTV: received quality badge fallback checks passed");
    }).catch(error => { console.error(error); process.exitCode = 1; });
}

// O JSX do Vencord chama o React do Discord: no topo do módulo ele roda antes de existir e o Vencord inteiro não carrega.
for (const file of readdirSync(new URL(".", import.meta.url)).filter(name => name.endsWith(".tsx")))
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), /^(?:export )?(?:const|let|var) [^=(]+= *</m, `${file}: JSX at module scope`);
assert.equal(streamKey(" Discord-RUST "), "Discord-RUST");
assert.deepEqual(["rainbow", "", "toString", "<b>", 1].map(liveStyle), ["rainbow", "", "", "", ""]);
for (const style of Object.keys(liveStyles).filter(Boolean)) {
    assert.match(style, /^[a-z]{1,16}$/, "Style IDs must match the server's quality validation");
    assert.equal(liveStyle(style), style);
    assert.ok(readFileSync(new URL("./style.css", import.meta.url), "utf8").includes(`.fockytv-style-${style} {`), `${style}: missing CSS`);
}
{
    const games = [{ name: "Valorant", windowHandle: "4242" }];
    assert.deepEqual(detectProfile({ id: "window:4242:0", name: "VALORANT  " }, games), { kind: "game", name: "Valorant" }, "Game by window handle");
    assert.deepEqual(detectProfile({ id: "window:1:0", name: "Valorant - Ranked" }, games), { kind: "game", name: "Valorant" }, "Game by window title");
    assert.deepEqual(detectProfile({ pid: 7, name: "Minecraft" }), { kind: "game", name: "Minecraft" }, "Game picked in Discord's picker");
    assert.deepEqual(detectProfile({ id: "screen:0:0", name: "Tela 1" }, [], { name: "Elden Ring" }), { kind: "game", name: "Elden Ring" }, "Whole screen with a game in front");
    assert.deepEqual(detectProfile({ id: "window:9:0", name: "Netflix - Google Chrome" }, games), { kind: "video", name: "Netflix - Google Chrome" });
    assert.deepEqual(detectProfile({ id: "screen:0:0", name: "Tela 1" }), { kind: "screen", name: "Tela 1" });
    assert.deepEqual(detectProfile(), { kind: "screen", name: undefined });
}
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
    'canUseSoundboardEverywhere:function(e){return(0,r.I5)(e,o.PremiumTypes.TIER_2)}',
    'case"GUILD_SOUNDBOARD_SOUND_CREATE":return{type:"GUILD_SOUNDBOARD_SOUND_CREATE",sound:{soundId:e.sound_id,available:e.available}}',
    'let u=null!=t&&(s.Ay.can(c.Pl.USE_EXTERNAL_SOUNDS,t)||n),d=canUseSoundboardEverywhere(e)',
    'let L=(0,l.I5)(e,c.PremiumTypes.TIER_2),x=r.default.isPremium(e,c.PremiumTypes.TIER_2);return{isNitroLocked:!L}',
    'function h(e,t,n,r){(0,o.a)(t,e),i.SEND_SOUNDBOARD_SOUND(e)}',
    'if(null==(b="number"==typeof e?s.Ay.getGameForPID(e):e))return[!1,"no source"];',
    'setVideoEnabled(e){e&&(0,u.PX)(),a.h.dispatch({type:"MEDIA_ENGINE_SET_VIDEO_ENABLED",enabled:e})}',
    'isVideoEnabled(){return tm&&tL}isVideoAvailable(){return Object.values(tA).some(e=>!e.disabled)}',
    'getInitialState(){return{selfVideo:I.Ay.isVideoEnabled(),flags:0}}getNextState(e){return{selfVideo:I.Ay.isVideoEnabled()}}',
    'let n={channelId:t.channelId,selfStream:t.selfStream,selfVideo:t.selfVideo,sessionId:t.sessionId,suppress:t.suppress}',
    'streamWatch(e){this.send(e2.STREAM_WATCH,{stream_key:e})}streamDelete(e){this.send(e2.STREAM_DELETE,{stream_key:e})}',
    'getCurrentUserActiveStream(){return null}',
    'l.h.dispatch({type:"STREAM_STOP",streamKey:e,appContext:"APP"})',
    'getStreamForUser(u,g){return null}getActiveStreamForStreamKey(k){return null}getViewerIds(e){return []}getAllActiveStreams(){return []}getAllActiveStreamsForChannel(c){return []}' +
        'VOICE_STATE_UPDATES:function(e){return e.voiceStates.reduce((e,t)=>{let{userId:i,guildId:a,channelId:s,sessionId:o,selfStream:d,discoverable:c}=t;if(d&&null!=s)return!0},!1)}',
    'getVideoComponent(){return engine.Video}',
    'function E(e,t,E){if(u.isPlatformEmbedded)(0,r.mM)(async()=>{return t=>(0,i.jsx)(e,{...t,analyticsLocations:E})});else{let n=l.A.getChannel(t);d.Ay.getMediaEngine().getDesktopSource(i,!0).then(n=>{(0,a.XI)(e,t,{pid:null,sourceId:n,sourceName:null,analyticsLocations:E})})}}',
    'children:[w??Q.Ay.getName($),z?(0,i.jsxs)("span",{className:en.IW,children:["\\xa0",et.intl.string(et.t["pFO/Ph"])]}):""]' +
        ',l={primaryGuild:$.primaryGuild,userId:$.id},(0,i.jsx)(GuildTag,{...l,children:n}),(0,i.jsx)(VoiceIcons,{disabled:x,...g,isHovered:ec})',
    'b&&ei.push((0,i.jsx)(m.m,{text:et.intl.string(et.t["JH1SJ+"]),children:(0,i.jsx)(E.EyeIcon,{size:"xs",color:"currentColor",className:a()(en.Kk,y)})},"watch"));let er=1,ea=(0,i.jsx)(ec,{userId:H.id})},`${H.id}-game`):null;return(X&&null!=ea&&ei.push(ea),_&&!Y&&ei.push((0,i.jsx)(D.Ay,{size:D.Ay.Sizes.SMALL},"stream")));(s=a()(en.my,{[en.Jb]:d===Y.OSZ.LARGE,[en.dT]:d===Y.OSZ.SMALL,[en.DF]:X}),t={backgroundImage:`url(${$.getAvatarURL(U,38)})`})',
    'createExperiment({name:"2026-08-video-guard",kind:"user",defaultConfig:{videoEnabled:!0},variations:{1:{videoEnabled:!1},2:{videoEnabled:!1}}})',
    'async function w(g,c,u){if(!s.A.shouldFetchPreview(g,c,u))return;d.h.dispatch({type:"STREAM_PREVIEW_FETCH_START",streamKey:"key"})}',
    'P=r.useCallback((e,r,a,s)=>{if(e){if(null!=_){}}},[]);let J=h.isPlatformEmbedded?(0,i.jsx)(s.Dr,{id:"stream-settings",children:j}):null;',
    'function x(e){!0!==e.noTrack&&(0,S.K2)(e.preset,e.resolution,e.frameRate,e.soundshareEnabled),l.h.dispatch({type:"STREAM_UPDATE_SETTINGS",...e})}',
    '[B,K]=(0,r.yK)([_.A],()=>[_.A.getStreamForUser(f,s.getGuildId()),_.A.getActiveStreamForUser(f,s.getGuildId())],[s,f]),Y=1;return(0,n.jsx)(V.Ay,{...e,isStreaming:null!=B&&B.channelId===s.id,isWatching:null!=K&&K.state!==P.XYD.ENDED})',
    'if(0===w.length)return null;if(_)return(0,i.jsx)(P,{maxVisibleUsers:A,users:w,guildId:a,channelId:t,className:u,participantType:l.type});let F=o()(w).take(A)',
    'return(0,M.jsxs)("div",{className:DQ.uu,children:[(0,M.jsx)(vP,{channel:t,enableActivities:c,disabled:!r&&i}),(0,M.jsx)(vw,{channel:t,canGoLive:n,enableActivities:c,disabled:!1})]})',
    'children:[(0,s.jsx)(V,{accountContainerRef:B,nameplate:k}),(0,s.jsx)(M,{})]',
    'getParticipants(e){return $(e).toArray()??P}getFilteredParticipants(e){let t=$(e);return H[e]?t.toArray(1):t.toArray(2)}getVideoParticipants(e){return $(e).toArray(3)??P}' +
        'getParticipant(e,t){return $(e).getParticipant(t)}getSelectedParticipant(e){let t=this.getSelectedParticipantId(e);return null==t?null:$(e).getParticipant(t)}getParticipantsVersion(e){return $(e).version}getMode(e){return "voice"}' +
        'function r(e){let n=$(e),[s]=q(e);if(s!==A&&s!==N){let e=n.getParticipant(s);(null==e||e.type===S&&null==g(e.id))&&(s=N)}}',
    // Barra de título (2026-11), já com o Fragment trocado pelo VencordToolbox.
    'trailing:(0,b.jsxs)(Vencord.Plugins.plugins["VencordToolbox"].TrailingWrapper,{children:[l&&(0,b.jsx)(si,{}),n?(0,b.jsx)(af,{focusSectionProps:"HELP"===A?e:void 0}):(0,b.jsx)(al,{focusSectionProps:"HELP"===A?e:void 0}),i&&(0,b.jsx)(sr,{})]})'
];
// O GameActivityToggle insere o botão dele no mesmo lugar antes do FockyTV.
assert.ok(new RegExp((discordPatches.find(patch => patch.find === "#{intl::USER_PROFILE_ACCOUNT_POPOUT_BUTTON_A11Y_LABEL}")!.replacement as { match: RegExp; }).match.source).test('children:[Vencord.Plugins.plugins["GameActivityToggle"].GameActivityToggleButton(arguments[0]),(0,s.jsx)(V,{accountContainerRef:B})'));
// Builds novos do Discord exportam essas funções como métodos anônimos; os dois formatos têm que casar.
for (const [find, sample] of [['type:"STREAM_PREVIEW_FETCH_START"', 'Tp:async function(e,t,n){if(!E.A.shouldFetchPreview(e,t,n))return;'], ['type:"STREAM_UPDATE_SETTINGS"', 'Xd:function(e){!0!==e.noTrack&&(0,S.K2)(e.preset)']]) {
    const { match } = discordPatches.find(patch => patch.find === find)!.replacement as { match: RegExp; };
    assert.ok(new RegExp(match.source.replaceAll(String.raw`\i`, String.raw`[A-Za-z_$][\w$]*`)).test(sample), find);
}
discordPatches.forEach((patch, index) => {
    const replacements = Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement];
    for (const replacement of replacements) {
        const match = typeof replacement.match === "string" ? replacement.match
            : new RegExp(replacement.match.source.replaceAll(String.raw`\i`, String.raw`[A-Za-z_$][\w$]*`), replacement.match.flags);
        const output = fixtures[index].replace(match, replacement.replace);
        assert.notEqual(output, fixtures[index]);
        // Wrappers com $& continuam casando depois de aplicados; o Vencord só aplica uma vez.
        if (match instanceof RegExp && match.global && !replacement.replace.includes("$&")) assert.equal(output.replace(match, "").length, output.length);
        if (replacement.replace.includes("$self.")) assert.ok(output.includes("$self."));
        else if (fixtures[index].includes("createExperiment")) {
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
    const { LivePublisher, Session } = await import("./session");
    // Publicador LiveKit: queda da conexão encerra a live uma vez; trocar de tela publica/despublica o áudio.
    const log: string[] = [];
    let room: { handlers: Record<string, () => void>; } | undefined;
    const local = () => ({ sender: {}, replaceTrack: async (next: { kind: string; }) => { log.push(`replace ${next.kind}`); } });
    const sdk = {
        RoomEvent: { Disconnected: "disconnected" }, Track: { Source: { Camera: "camera", ScreenShare: "screen", ScreenShareAudio: "audio" } },
        Room: class {
            handlers: Record<string, () => void> = {};
            constructor() { room = this; }
            localParticipant = {
                publishTrack: async (track: { kind: string; }) => { log.push(`publish ${track.kind}`); return { track: local() }; },
                unpublishTrack: async () => { log.push("unpublish"); }
            };
            on(event: string, handler: () => void) { this.handlers[event] = handler; }
            async connect() { log.push("connect"); }
            async disconnect() { log.push("disconnect"); }
        }
    };
    class Track extends EventTarget {
        stopped = 0;
        constructor(public kind: string) { super(); }
        stop() { this.stopped++; }
    }
    const media = (...tracks: Track[]) => {
        const list = [...tracks];
        return { getTracks: () => [...list], getVideoTracks: () => list.filter(t => t.kind === "video"), getAudioTracks: () => list.filter(t => t.kind === "audio"),
            addTrack: (t: Track) => list.push(t), removeTrack: (t: Track) => list.splice(list.indexOf(t), 1) } as unknown as MediaStream;
    };
    const join = async () => ({ status: 200, body: JSON.stringify({ token: "t", path: "/livekit" }), location: null });
    const firstVideo = new Track("video");
    let failures = 0, audioReleased = 0;
    const live = new LivePublisher(sdk, join, "alice", false, media(firstVideo));
    await live.connect("https://tv.example", 30);
    const secondVideo = new Track("video"), secondAudio = new Track("audio");
    await live.replace(media(secondVideo, secondAudio), () => audioReleased++);
    assert.equal(firstVideo.stopped, 1);
    const thirdVideo = new Track("video");
    await live.replace(media(thirdVideo));
    assert.equal(audioReleased, 1, "Audio lease released when the new source has no audio");
    assert.equal(secondVideo.stopped + secondAudio.stopped, 2);
    assert.deepEqual(log, ["connect", "publish video", "replace video", "publish audio", "replace video", "unpublish"]);
    const dropped = new LivePublisher(sdk, join, "alice", false, media(new Track("video")), undefined, undefined, () => failures++);
    await dropped.connect("https://tv.example", 30);
    room!.handlers.disconnected();
    room!.handlers.disconnected();
    assert.equal(failures, 1);
    const ended = new Track("video");
    const endedLive = new LivePublisher(sdk, join, "alice", false, media(ended));
    log.length = 0;
    ended.dispatchEvent(new Event("ended"));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(log, ["disconnect"], "Ended capture closes the live");
    await endedLive.close();
    const cancelledLive = new LivePublisher(sdk, async () => { await cancelledLive.close(); return join(); }, "alice", false, media(new Track("video")));
    await assert.rejects(cancelledLive.connect("https://tv.example", 30), /cancelada/);

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
        addTransceiver(_kind: string, options: RTCRtpTransceiverInit) { assert.equal(options.direction, "recvonly"); }
        async createOffer() { return { type: "offer", sdp: "offer" }; }
        async setLocalDescription(value: RTCSessionDescriptionInit) { this.localDescription = value; }
        async setRemoteDescription(value: RTCSessionDescriptionInit) {
            this.remoteDescription = value;
            if (value.sdp === "answer") this.connectionState = "connected";
        }
        close() { this.closed = true; this.connectionState = "closed"; this.dispatchEvent(new Event("connectionstatechange")); }
    }
    Object.assign(globalThis, { RTCPeerConnection: Peer, MediaStream: class { addTrack() { } } });
    const calls: string[] = [];
    const session = new Session(async (url, method, key, body) => {
        calls.push(`${method} ${url}`);
        assert.equal(key, "alice");
        if (method === "POST") assert.equal(body, "offer");
        return { status: method === "POST" ? 201 : 204, body: "answer", location: "/api/whep/test" };
    }, "alice");
    await session.connect("https://tv.example/api/whep");
    await session.close();
    assert.deepEqual(calls, ["POST https://tv.example/api/whep", "DELETE https://tv.example/api/whep/test"]);
    assert.equal((session.pc as unknown as Peer).closed, true);

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

    const failed = new Session(async () => ({ status: 400, body: "host active", location: null }), "alice");
    await assert.rejects(failed.connect("https://tv.example/api/whip"), /host active/);
    assert.equal((failed.pc as unknown as Peer).closed, true);
    console.log("FockyTV: session lifecycle checks passed");
}
async function checkAudioTrack() {
    const { screenAudio } = await import("./audio");
    const existingAudio = { stopped: false, stop(this: { stopped: boolean; }) { this.stopped = true; } } as unknown as MediaStreamTrack;
    const nativeTracks = [existingAudio];
    const pickerCapture = {
        getAudioTracks: () => nativeTracks,
        removeTrack: (track: MediaStreamTrack) => nativeTracks.splice(nativeTracks.indexOf(track), 1)
    } as unknown as MediaStream;
    const unsupported = {
        startAudio: async () => { throw new Error("The Windows helper must not be called"); },
        readAudio: async () => new Uint8Array(), stopAudio: async () => {}
    };
    const fail = (error: unknown) => { throw error; };
    await screenAudio(unsupported, pickerCapture, "screen:0:0", true, false, fail);
    await screenAudio(unsupported, pickerCapture, "screen:0:0", true, true, fail);
    assert.deepEqual(nativeTracks, [existingAudio], "Keep audio supplied by the client's picker");
    await screenAudio(unsupported, pickerCapture, "screen:0:0", false, false, fail);
    assert.equal(nativeTracks.length, 0, "Disabled sound must remove picker-provided audio");
    assert.equal((existingAudio as unknown as { stopped: boolean; }).stopped, true);
    await screenAudio(unsupported, pickerCapture, "screen:0:0", true, false, fail);
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
            assert.equal(data.numberOfFrames, 480, "Always 10 ms blocks: a changing AudioData size makes Chromium drop the WebRTC remainder (crackle)");
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
        // O mix da tela inteira entrega pedaços quebrados (~750 frames).
        readAudio: async id => { assert.equal(id, "test"); return new Uint8Array(750 * 8); },
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

async function checkReplay() {
    const recorders: FakeRecorder[] = [];
    class FakeRecorder {
        static isTypeSupported = (type: string) => type === "video/webm";
        state = "inactive";
        ondataavailable: ((event: { data: Blob; }) => void) | null = null;
        private listeners: (() => void)[] = [];
        constructor(readonly media: unknown, readonly options: { mimeType: string; }) { recorders.push(this); }
        start() { this.state = "recording"; this.emit(); }
        stop() { this.state = "inactive"; }
        requestData() { this.emit(); }
        addEventListener(_: string, listener: () => void) { this.listeners.push(listener); }
        private emit() { this.ondataavailable?.({ data: new Blob([`${recorders.indexOf(this)}`]) }); this.listeners.splice(0).forEach(listener => listener()); }
    }
    const previous = (globalThis as any).MediaRecorder;
    (globalThis as any).MediaRecorder = FakeRecorder;
    let replay: ReturnType<typeof replayBuffer> | undefined;
    try {
        replay = replayBuffer({} as MediaStream, 20);
        assert.equal(replay.extension, "webm");
        for (let i = 0; i < 200 && recorders.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 10));
        // Rotação: no máximo dois gravando; o salvo é sempre o mais antigo ainda ativo.
        assert.ok(recorders.length >= 3);
        assert.equal(recorders.filter(recorder => recorder.state === "recording").length, 2);
        const oldest = recorders.findIndex(recorder => recorder.state === "recording");
        assert.equal(await (await replay.save()).text(), `${oldest}${oldest}`, "Saves the oldest recorder, including the data requested at save time");
        replay.stop();
        assert.ok(recorders.every(recorder => recorder.state === "inactive"));
    } finally { replay?.stop(); (globalThis as any).MediaRecorder = previous; }
    console.log("FockyTV: replay buffer rotation checks passed");
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
    const checkedBranches: string[] = [];
    const installer = 'import {writeFileSync} from "node:fs";setTimeout(()=>writeFileSync(new URL("./finished.json",import.meta.url),JSON.stringify(process.argv.slice(2))),150);';
    globalThis.fetch = async (input, options) => {
        const url = String(input);
        if (/\/commits\/(main|insider)\?/.test(url)) {
            checkedBranches.push(new URL(url).pathname.split("/").at(-1)!);
            assert.equal(options?.cache, "no-store", "A push hint must verify the selected branch without using a cached revision");
            assert.match(new URL(url).searchParams.get("t") ?? "", /^\d+$/, "GitHub CDN caches main for 60 seconds even with no-store");
            return Response.json({ sha: revision }, { status: http });
        }
        if (url === `https://api.github.com/repos/FelipeMayerDev/fockytv-vencord-plugin/commits?sha=${revision}&per_page=1`)
            return Response.json([], { headers: { link: '<https://api.github.com/x?sha=a&per_page=1&page=2>; rel="next", <https://api.github.com/x?sha=a&per_page=1&page=318>; rel="last"' } });
        if (url === `https://api.github.com/repos/FelipeMayerDev/fockytv-vencord-plugin/compare/${state.revision}...${revision}`)
            return Response.json({ status: "ahead", ahead_by: 3, commits: [{ commit: { message: "Old fix\n\nbody" } }, { commit: { message: "Update packaged plugin zip" } }, { commit: { message: "New feature" } }] });
        assert.equal(url, `https://raw.githubusercontent.com/FelipeMayerDev/fockytv-vencord-plugin/${revision}/installer/install.mjs`);
        downloads++;
        return new Response(installer);
    };
    try {
        await assert.rejects(checkUpdate(directory), /Execute o instalador/);
        writeFileSync(join(root, "package.json"), "{}");
        writeFileSync(metadata, JSON.stringify(state));
        assert.deepEqual(await checkUpdate(directory), { available: false, branch: "main", revision: state.revision, version: 318, current: 318 });
        assert.deepEqual(await checkUpdate(directory, "insider"), { available: true, branch: "insider", revision: state.revision, version: 318, current: 318 }, "Switch channels even when both point to the same commit");
        assert.equal(checkedBranches.at(-1), "insider");
        writeFileSync(metadata, JSON.stringify({ ...state, branch: "insider" }));
        assert.equal((await checkUpdate(directory, "main")).available, true, "Returning to main may install the same or an older revision");
        assert.equal(checkedBranches.at(-1), "main");
        assert.equal((await checkUpdate(directory, "insider")).available, false);
        writeFileSync(metadata, JSON.stringify(state));
        await assert.rejects(checkUpdate(directory, "../../bad"), /Canal/);
        assert.deepEqual(await installUpdate(directory), { started: false });
        assert.equal(downloads, 0, "Checking must never download or execute an installer");
        revision = "2".repeat(40);
        assert.deepEqual(await checkUpdate(directory), { available: true, branch: "main", revision, version: 318, current: 315, changes: ["New feature", "Old fix"] },
            "Version from the commit count, newest change first, without packaging commits");
        assert.equal(downloads, 0);
        revision = "../../invalid";
        await assert.rejects(checkUpdate(directory), /Versão de atualização inválida/);
        assert.equal(downloads, 0);
        revision = "2".repeat(40);
        http = 503;
        await assert.rejects(installUpdate(directory), /HTTP 503/);
        http = 200;
        assert.deepEqual(await installUpdate(directory, "insider"), { started: true });
        await assert.rejects(installUpdate(directory), /em andamento/);
        const finished = join(root, ".fockytv-updater", "finished.json");
        for (let i = 0; i < 100 && !existsSync(finished); i++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.deepEqual(JSON.parse(readFileSync(finished, "utf8")), ["--client", "vesktop", "--source", root, "--target", root, "--branch", "insider", "--revision", revision, "--restart", process.env.APPIMAGE || process.execPath]);
        writeFileSync(metadata, JSON.stringify({ ...state, node: "relative-node" }));
        await assert.rejects(checkUpdate(directory), /Dados da instalação inválidos/);
    } finally { globalThis.fetch = previousFetch; rmSync(root, { recursive: true, force: true }); }
    console.log("FockyTV: update checks, explicit install, pinned source and safe argv checks passed");
}

Promise.all([checkSessions(), checkAudioTrack(), checkViewer(), checkThumbnails(), checkUpdates(), checkReplay()]).catch(error => { console.error(error); process.exitCode = 1; });
