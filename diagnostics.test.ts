// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { logVideoEvent, videoElementsSnapshot, videoEvents, videoStats } from "./diagnostics";

const report = (...rows: any[]): RTCStatsReport => new Map(rows.map(row => [row.id, row]));
const outbound = { id: "out", ssrc: 1, type: "outbound-rtp", kind: "video", mediaSourceId: "source", codecId: "codec", transportId: "transport", remoteId: "remote" };

test("sender measurements separate capture, encoding and sending using linked stats", () => {
    const before = report(
        { ...outbound, timestamp: 1000, framesEncoded: 10, framesSent: 10, totalEncodeTime: 0.1, bytesSent: 1000, packetsSent: 10, totalPacketSendDelay: 0.1 },
        { id: "source", type: "media-source", timestamp: 1000, frames: 60 }
    );
    const current = report(
        { ...outbound, timestamp: 3000, framesEncoded: 30, framesSent: 28, totalEncodeTime: 0.3, bytesSent: 4_001_000, packetsSent: 30, totalPacketSendDelay: 0.3, encoderImplementation: "ExternalEncoder", powerEfficientEncoder: false, qualityLimitationReason: "cpu" },
        { id: "unrelated", type: "media-source", timestamp: 3000, framesPerSecond: 99 },
        { id: "source", type: "media-source", timestamp: 3000, frames: 180 },
        { id: "codec", mimeType: "video/H264" },
        { id: "transport", selectedCandidatePairId: "pair" },
        { id: "pair", currentRoundTripTime: 0.04, localCandidateId: "private" },
        { id: "private", address: "192.0.2.1", port: 1234 },
        { id: "remote", type: "remote-inbound-rtp", packetsLost: 3 },
        { ...outbound, id: "rtx-out", codecId: "rtx" }, { id: "rtx", mimeType: "video/rtx" },
        { id: "audio", type: "outbound-rtp", kind: "audio" }
    );
    const rows = videoStats(current, before);
    assert.equal(rows.length, 1, "Audio and repair streams must not look like extra video encoders");
    const row = rows[0];
    assert.equal(row.captureFps, 60);
    assert.equal(row.encodedFps, 10);
    assert.equal(row.sentFps, 9);
    assert.equal(row.mbps, 16);
    assert.ok(Math.abs(row.processingMs! - 10) < 1e-8);
    assert.ok(Math.abs(row.sendDelayMs! - 10) < 1e-8);
    assert.equal(row.encoder, "ExternalEncoder");
    assert.equal(row.powerEfficientEncoder, false, "False is a valid measurement");
    assert.equal(row.limitation, "cpu");
    assert.equal(row.rttMs, 40);
    assert.equal(row.receiverReportedPacketsLost, 3);
    assert.equal(row.codec, "video/H264");
    assert.ok(!JSON.stringify(rows).includes("192.0.2.1"), "Export only measured metrics, never ICE addresses");
});

test("receiver reports delivered FPS, decoded FPS, loss and interval freezes", () => {
    const inbound = { id: "in", type: "inbound-rtp", kind: "video", ssrc: 2 };
    const before = report({ ...inbound, timestamp: 1000, framesReceived: 100, framesDecoded: 90, framesDropped: 10, bytesReceived: 0, packetsReceived: 100, packetsLost: 0, freezeCount: 1, totalFreezesDuration: 1, totalDecodeTime: 1, jitterBufferDelay: 10, jitterBufferEmittedCount: 90 });
    const current = report({ ...inbound, timestamp: 3000, framesReceived: 160, framesDecoded: 130, framesDropped: 30, bytesReceived: 2_000_000, packetsReceived: 190, packetsLost: 10, freezeCount: 3, totalFreezesDuration: 1.5, totalDecodeTime: 1.2, jitterBufferDelay: 14, jitterBufferEmittedCount: 130, decoderImplementation: "D3D11VideoDecoder", powerEfficientDecoder: true });
    const [row] = videoStats(current, before);
    assert.equal(row.receivedFps, 30);
    assert.equal(row.decodedFps, 20);
    assert.equal(row.droppedFrames, 20);
    assert.equal(row.lossPercent, 10);
    assert.equal(row.freezes, 2);
    assert.equal(row.freezeSeconds, 0.5);
    assert.equal(row.jitterBufferMs, 100);
    assert.ok(Math.abs(row.processingMs! - 5) < 1e-8);
    assert.equal(row.captureFps, null);
    assert.equal(row.encoder, null);
    assert.equal(row.decoder, "D3D11VideoDecoder");
    assert.equal(row.powerEfficientDecoder, true);
});

test("missing stats stay unknown; zero FPS is retained; replaced tracks and reset counters never produce negative rates", () => {
    const before = report({ ...outbound, timestamp: 1000, framesEncoded: 100, bytesSent: 1000 });
    for (const change of [{ ssrc: 2 }, { timestamp: 500 }, { timestamp: NaN }, { framesEncoded: 90 }]) {
        const [row] = videoStats(report({ ...outbound, timestamp: 2000, framesEncoded: 110, ...change }), before);
        assert.equal(row.encodedFps, null);
    }
    const [missing] = videoStats(report({ ...outbound, timestamp: 1000 }));
    assert.equal(missing.captureFps, null);
    assert.equal(missing.encodedFps, null);
    assert.equal(missing.mbps, null);
    assert.equal(missing.powerEfficientEncoder, null);
    const [zero] = videoStats(report({ ...outbound, timestamp: 2000, framesEncoded: 100 }, { id: "source", timestamp: 2000, framesPerSecond: 0 }), before);
    assert.equal(zero.captureFps, 0);
    assert.equal(zero.encodedFps, 0);
    assert.deepEqual(videoStats(report()), []);
});

test("panel sampling does not overlap and cancels pending updates, timers and automatic collection", async () => {
    const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("function StreamDiagnostics("), source.indexOf("    const report = JSON.stringify(", source.indexOf("function StreamDiagnostics(")));
    const create = new Function("useState", "useEffect", "setInterval", "clearInterval", "setTimeout", "clearTimeout", "videoStats", "publishers", "watching", "Session",
        `const cameraViewers = new Map(), SelectedChannelStore = { getVoiceChannelId: () => 'voice' };
        const Native = { runtimeDiagnostics: async () => ({ platform: 'win32', processes: [] }) };
        const settings = { store: { liveStyle: 'neon' } }, liveStyle = x => x, watch = { snapshot: () => ({ watching: false }) };
        const document = { querySelectorAll: () => [] }, partyVideo = null, videoElementsSnapshot = () => [];
        ` + stripTypeScriptTypes(body + "}\n") + ";return StreamDiagnostics;");
    let resolve!: (report: RTCStatsReport) => void;
    let calls = 0, samples: any[] = [], stopped = false, cleanup: () => void;
    const timers = new Map<string, () => void>();
    const sources = [{ label: "Envio", getStats: () => { calls++; return new Promise<RTCStatsReport>(done => resolve = done); } }];
    let hook = 0;
    const component = create(
        () => hook++ === 0 ? [sources, (value: unknown) => { if (value === null) { stopped = true; cleanup(); } }] : [[], (update: (value: any[]) => any[]) => samples = update(samples)],
        (effect: () => () => void) => cleanup = effect(),
        (callback: () => void, ms: number) => { assert.equal(ms, 1000); timers.set("interval", callback); return "interval"; },
        (id: string) => timers.delete(id),
        (callback: () => void, ms: number) => { assert.equal(ms, 30_000); timers.set("stop", callback); return "stop"; },
        (id: string) => timers.delete(id), videoStats, new Map(), new Map(), class {}
    );
    component({ player: null });
    timers.get("interval")!();
    assert.equal(calls, 1, "A pending read must not start another poll");
    resolve(report({ ...outbound, timestamp: 1000, framesEncoded: 10 }));
    await new Promise(done => setImmediate(done));
    assert.equal(samples.length, 1);
    assert.equal(samples[0].state.inVoiceChannel, true);
    assert.equal(samples[0].state.screenConnections, 0);
    assert.equal(samples[0].runtime.platform, "win32");
    timers.get("interval")!();
    assert.equal(calls, 2);
    timers.get("stop")!();
    assert.ok(stopped);
    assert.equal(timers.size, 0, "Closing or stopping the diagnostic clears both timers");
    resolve(report({ ...outbound, timestamp: 2000, framesEncoded: 20 }));
    await new Promise(done => setImmediate(done));
    assert.equal(samples.length, 1, "In-flight reads must not update a stopped or unmounted panel");
    sources.length = 0;
    samples = []; hook = 0;
    component({ player: null });
    await new Promise(done => setImmediate(done));
    assert.equal(samples.length, 1, "An idle client can collect a baseline with no video source");
    assert.deepEqual(samples[0].streams, []);
    assert.equal(samples[0].state.screenConnections, 0);
    cleanup();
    assert.equal(timers.size, 0);
});

test("video lifecycle log is bounded and uses local IDs without serializing connection data", () => {
    videoEvents.length = 0;
    const connection = { token: "secret", url: "https://private.example" };
    logVideoEvent("screen-open", connection);
    logVideoEvent("screen-close", connection);
    assert.equal(videoEvents[0].connectionId, videoEvents[1].connectionId);
    assert.match(videoEvents[0].at, /^\d{4}-\d{2}-\d{2}T/);
    for (let i = 0; i < 205; i++) logVideoEvent("preview-skipped");
    assert.equal(videoEvents.length, 200);
    assert.doesNotMatch(JSON.stringify(videoEvents), /secret|private/);
});

test("video element counters omit URLs, stream IDs and track labels", () => {
    const original = globalThis.MediaStream;
    class Media { getVideoTracks() { return [{ readyState: "live", label: "private-camera" }]; } }
    globalThis.MediaStream = Media as any;
    try {
        const [snapshot] = videoElementsSnapshot([{
            paused: false, readyState: 4, videoWidth: 1920, videoHeight: 1080, srcObject: new Media(),
            currentSrc: "https://private.example/video", getVideoPlaybackQuality: () => ({ totalVideoFrames: 30, droppedVideoFrames: 2 })
        } as unknown as HTMLVideoElement]);
        assert.deepEqual(snapshot, { paused: false, readyState: 4, width: 1920, height: 1080, totalFrames: 30, droppedFrames: 2, liveTracks: 1 });
        assert.doesNotMatch(JSON.stringify(snapshot), /private|label|currentSrc/);
    } finally { globalThis.MediaStream = original; }
});

test("native diagnostic reports CPU and GPU feature status without process names or paths", () => {
    const source = readFileSync(new URL("./native.ts", import.meta.url), "utf8");
    const runtime = new Function("app", "process", stripTypeScriptTypes(
        source.slice(source.indexOf("export function runtimeDiagnostics("), source.indexOf("export function githubAlerts("))
    ).replace("export ", "") + "return runtimeDiagnostics;")({
        getGPUFeatureStatus: () => ({ video_decode: "enabled" }),
        getAppMetrics: () => [{ pid: 123, type: "GPU", cpu: { percentCPUUsage: 2 }, memory: { workingSetSize: 1024 }, name: "private", path: "secret" }]
    }, { platform: "win32", versions: { electron: "1", chrome: "2" } });
    const report = runtime({});
    assert.deepEqual(report.processes, [{ pid: 123, type: "GPU", cpuPercent: 2, memoryKB: 1024 }]);
    assert.equal(report.gpuFeatures.video_decode, "enabled");
    assert.doesNotMatch(JSON.stringify(report), /private|secret/);
});
