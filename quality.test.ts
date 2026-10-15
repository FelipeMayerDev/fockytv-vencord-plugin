// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { discordPatches, captureConstraints } from "./discord";
import { qualityConstraints, shareQuality } from "./quality";
import { Session } from "./session";

test("Discord values override defaults, including source resolution and 5 FPS", () => {
    const defaults = { fps: 60, resolution: 1080, soundshareEnabled: true };
    const selected = shareQuality({ fps: 5, resolution: 0 }, defaults);
    assert.equal(selected.fps, 5);
    assert.equal(selected.resolution, 0);
    assert.equal(shareQuality({ resolution: 1440 }, defaults).fps, 60);
    assert.deepEqual(qualityConstraints(selected), { frameRate: { ideal: 5, max: 5 } });
    assert.equal(captureConstraints({ id: "screen:0:0" }, selected.fps, selected.resolution).video.mandatory.maxFrameRate, 5);
    for (const value of [{ fps: NaN }, { fps: 0 }, { resolution: -1 }, { resolution: 8000 }])
        assert.throws(() => shareQuality(value, defaults));
});

test("quality changes keep the WHIP connection, audio and tracks; failures roll back", async () => {
    const originals = { RTCPeerConnection: globalThis.RTCPeerConnection, MediaStream: globalThis.MediaStream, RTCRtpSender: globalThis.RTCRtpSender };
    let released = 0, posts = 0, stopped = 0, failEncoding = false;
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
        track: video,
        parameters: { encodings: [{ maxFramerate: 30, scaleResolutionDownBy: 1, maxBitrate: 32_000_000 }] },
        getParameters() { return structuredClone(this.parameters); },
        async setParameters(value: { encodings: { maxFramerate: number; scaleResolutionDownBy: number; maxBitrate: number; }[] }) {
            if (failEncoding) { failEncoding = false; throw new Error("encoder failed"); }
            this.parameters = structuredClone(value);
        }
    };
    const capture = { getVideoTracks: () => [video], getAudioTracks: () => [audio], getTracks: () => [video, audio] };
    class Peer {
        closed = false;
        getSenders() { return [sender]; }
        getTransceivers() { return []; }
        addTransceiver() { return { sender }; }
        close() { this.closed = true; }
    }
    Object.assign(globalThis, { RTCPeerConnection: Peer, MediaStream: class {}, RTCRtpSender: { getCapabilities: () => ({ codecs: [] }) } });
    try {
        const session = new Session(async () => { posts++; throw new Error("Must not renegotiate"); }, "publisher", capture as unknown as MediaStream, () => released++);
        const pc = session.pc;
        await Promise.all([session.setQuality({ fps: 60, resolution: 1080 }), session.setQuality({ fps: 15, resolution: 480 })]);
        assert.equal(video.history.length, 2);
        assert.deepEqual(video.constraints, qualityConstraints({ fps: 15, resolution: 480 }));
        assert.equal(sender.parameters.encodings[0].maxFramerate, 15);
        await session.setQuality({ fps: 60, resolution: 0 });
        assert.equal(video.constraints.height, undefined, "Source removes the previous height cap");
        const before = structuredClone(sender.parameters);
        failEncoding = true;
        await assert.rejects(session.setQuality({ fps: 30, resolution: 720 }), /encoder failed/);
        assert.deepEqual(sender.parameters, before);
        assert.deepEqual(video.constraints, qualityConstraints({ fps: 60, resolution: 0 }));
        await session.setQuality({ fps: 30, resolution: 720 });
        assert.equal(session.pc, pc);
        assert.equal(released, 0);
        assert.equal(stopped, 0);
        assert.equal(posts, 0);
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
        assert.equal(stopped, 2);
        await assert.rejects(session.setQuality({ fps: 60, resolution: 1080 }), /encerrada/);
    } finally { Object.assign(globalThis, originals); }
});

test("web capture receives Discord quality and native menu commits only after success", async () => {
    const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
    const openCapture = source.slice(source.indexOf("async function openCapture("), source.indexOf("function watchEnded("));
    const requested: MediaStreamConstraints[] = [];
    const createCapture = new Function("shareQuality", "qualityConstraints", "captureConstraints", "navigator", `
        const discordShare = {}, StreamingSettings = { getState: () => ({ fps: 30, resolution: 720, soundshareEnabled: false }) };
        const settings = { store: { fps: 15, height: 480 } }, Native = {}, IS_WINDOWS = false;
        const screenAudio = async () => () => {};
        ${stripTypeScriptTypes(openCapture)}
        return openCapture;`);
    const capture = createCapture(shareQuality, qualityConstraints, captureConstraints, { mediaDevices: {
        getDisplayMedia: async (value: MediaStreamConstraints) => { requested.push(value); return {}; },
        getUserMedia: async (value: MediaStreamConstraints) => { requested.push(value); return {}; }
    } });
    await capture("screen", undefined, { fps: 60, resolution: 1440 });
    assert.deepEqual(requested[0].video, qualityConstraints({ fps: 60, resolution: 1440 }));
    await capture("screen");
    assert.deepEqual(requested[1].video, qualityConstraints({ fps: 30, resolution: 720 }));
    await capture("screen", { id: "window:1234:0" }, { fps: 5, resolution: 0 });
    assert.equal((requested[2].video as any).mandatory.maxFrameRate, 5);
    assert.equal((requested[2].video as any).mandatory.maxHeight, undefined);

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
        discordStream: () => ({}), updateDiscordQuality: (value: unknown) => { received = value; return true; }
    });
    result.P(true, 1440, 60, "resolution");
    assert.deepEqual(received, { resolution: 1440, frameRate: 60, preset: 3 });
    assert.equal(result.J.id, "stream-settings");
});
