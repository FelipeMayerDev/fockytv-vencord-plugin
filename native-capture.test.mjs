import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";

const source = readFileSync(new URL("./native-capture.ts", import.meta.url), "utf8");
const create = new Function("spawn", "createServer", "setInterval", "clearInterval", "setTimeout", "clearTimeout",
    "muxerArgs", "encoderArgs", "preferLocalCandidates", "preferred", "CODECS", "report", "videoFrameMeter", "qualitySteps",
    stripTypeScriptTypes(source.slice(source.indexOf("export async function startCapture"))).replace("export ", "") + ";return startCapture;");
const { videoFrameMeter, qualitySteps } = new Function(stripTypeScriptTypes(source.slice(source.indexOf("export function qualitySteps("), source.indexOf("// size fixa o tamanho de saída")))
    .replaceAll("export ", "") + ";return { videoFrameMeter, qualitySteps };")();

// Pacotes MPEG-TS de um quadro de vídeo (PID 0x100) com ~bytes de payload; key marca o random_access_indicator.
function videoFrame(bytes, key = false) {
    return Buffer.concat(Array.from({ length: Math.max(1, Math.round(bytes / 184)) }, (_, index) => {
        const packet = Buffer.alloc(188, 0xff);
        packet[0] = 0x47; packet[1] = (index ? 0 : 0x40) | 0x01; packet[2] = 0x00;
        if (!index && key) { packet[3] = 0x30; packet[4] = 1; packet[5] = 0x40; } else packet[3] = 0x10;
        return packet;
    }));
}
const audioPacket = () => { const packet = Buffer.alloc(188, 0xff); packet[0] = 0x47; packet[1] = 0x41; packet[2] = 0x01; packet[3] = 0x10; return packet; };

test("frame meter splits video frames across chunks and leaves keyframes out of the sizes", () => {
    const meter = videoFrameMeter();
    const stream = Buffer.concat([videoFrame(30_000, true), audioPacket(), videoFrame(1_000), videoFrame(9_000), audioPacket(), videoFrame(500)]);
    for (let offset = 0; offset < stream.length; offset += 1000) meter.push(stream.subarray(offset, offset + 1000));
    const { count, sizes } = meter.take();
    assert.equal(count, 3, "The last frame only closes when the next one starts");
    assert.deepEqual(sizes, [184 * 5, 184 * 49]);
    assert.deepEqual(meter.take(), { count: 0, sizes: [] });
});

test("quality steps drop frame rate before resolution and skip steps that change nothing", () => {
    assert.deepEqual(qualitySteps({ fps: 60, resolution: 1080 }), [{ fps: 60, resolution: 1080 }, { fps: 30, resolution: 1080 }, { fps: 30, resolution: 720 }]);
    assert.deepEqual(qualitySteps({ fps: 30, resolution: 1080 }), [{ fps: 30, resolution: 1080 }, { fps: 30, resolution: 720 }]);
    assert.deepEqual(qualitySteps({ fps: 30, resolution: 720 }), [{ fps: 30, resolution: 720 }]);
});

test("raw PCM and video retain a common capture clock even without audio start_time", async t => {
    const encoderArgs = new Function("videoInput", "videoCodec",
        stripTypeScriptTypes(source.slice(source.indexOf("export function encoderArgs("), source.indexOf("// Preview local e miniatura:")))
            .replace("export ", "") + ";return encoderArgs;")(
        () => "testsrc2=size=64x64:rate=30,realtime,trim=start=0.3,setpts=PTS-STARTPTS",
        () => ["-c:v", "libx264", "-preset", "ultrafast", "-bf", "0"]);
    const options = { audio: true, fps: 30, bitrate: 8 };
    const args = encoderArgs(options, 0);
    const firstInput = args.indexOf("-i");
    assert.ok(args.slice(0, firstInput).includes("-use_wallclock_as_timestamps"));
    assert.ok(args.slice(firstInput + 2, args.lastIndexOf("-i")).includes("-use_wallclock_as_timestamps"));
    assert.equal(args.includes("-isync"), false, "Raw PCM has no start_time for -isync to use");
    assert.ok(args.includes("-copyts"));
    const clocks = args.flatMap((arg, index) => arg === "-itsoffset" ? [args[index + 1]] : []);
    assert.equal(clocks.length, 2);
    assert.equal(clocks[0], clocks[1], "Both inputs must subtract the exact same wall-clock origin");
    const restarted = encoderArgs(options, 12.5);
    assert.equal(restarted[restarted.indexOf("-output_ts_offset") + 1], "12.500", "Encoder restarts keep the session timeline");
    const silent = encoderArgs({ ...options, audio: false }, 0);
    assert.equal(silent.includes("-isync"), false, "Synthetic silence has no capture clock");
    assert.equal(silent.includes("-use_wallclock_as_timestamps"), false);
    assert.equal(silent.includes("-copyts"), false);

    if (spawnSync("ffmpeg", ["-version"]).error?.code === "ENOENT" || spawnSync("ffprobe", ["-version"]).error?.code === "ENOENT")
        return t.skip("FFmpeg and ffprobe are required for the real timestamp check");
    // Feed actual raw PCM, like WASAPI: a lavfi audio substitute hides the missing start_time bug.
    args.splice(args.lastIndexOf("-f"), 0, "-t", "1");
    const encoded = await new Promise((resolve, reject) => {
        const child = spawn("ffmpeg", args, { timeout: 10000 });
        const output = [], errors = [];
        child.stdout.on("data", chunk => output.push(chunk));
        child.stderr.on("data", chunk => errors.push(chunk));
        child.stdin.on("error", () => {});
        const pump = setInterval(() => { if (!child.stdin.destroyed && !child.stdin.writableNeedDrain) child.stdin.write(Buffer.alloc(480 * 2 * 4)); }, 10);
        child.once("error", error => { clearInterval(pump); reject(error); });
        child.once("close", status => { clearInterval(pump); resolve({ status, stdout: Buffer.concat(output), stderr: Buffer.concat(errors) }); });
        t.after(() => { clearInterval(pump); child.kill(); });
    });
    assert.equal(encoded.status, 0, encoded.stderr.toString());
    assert.doesNotMatch(encoded.stderr.toString(), /Unable to identify start times|No sync adjustment made/);
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "packet=codec_type,pts_time", "-of", "json", "pipe:0"], { input: encoded.stdout, timeout: 10000 });
    assert.equal(probe.status, 0, probe.stderr.toString());
    const packets = JSON.parse(probe.stdout).packets;
    const first = kind => Number(packets.find(packet => packet.codec_type === kind).pts_time);
    const offset = first("video") - first("audio");
    assert.ok(offset >= 0.2 && offset < 0.6, `Expected ~300 ms start offset, got ${offset}s`);
});

async function capture(t, source = "window:123", audio = false, late = false) {
    const children = [], timers = new Set(), calls = [];
    let server, respond;
    const spawn = (file, args) => {
        const child = Object.assign(new EventEmitter(), {
            file, args, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
            exitCode: null, killed: false,
            kill() { this.killed = true; }
        });
        children.push(child);
        return child;
    };
    const start = create(spawn, handler => server = createServer(handler),
        callback => { timers.add(callback); return callback; }, timer => timers.delete(timer),
        () => 0, () => {}, (_key, url) => [url], options => [options.source], sdp => sdp,
        "nvenc", ["nvenc", "amf"], () => "", videoFrameMeter, qualitySteps);
    const state = await start({ source, audio, fps: 60, resolution: 1080, bitrate: 8, key: "test", endpoint: "https://tv.example/whip" },
        "ffmpeg", "helper", async (url, method) => {
            calls.push([method, url]);
            if (method === "POST") {
                if (late) await new Promise(resolve => respond = resolve);
                return { status: 201, body: "answer", location: "/session/123" };
            }
            return { status: 204, body: "", location: null };
        }, "capture.log");
    const muxer = children[0];
    t.after(() => {
        state.stop();
        muxer.emit("exit", 0);
        server.closeAllConnections();
        children.forEach(child => [child.stdin, child.stdout, child.stderr].forEach(stream => stream.destroy()));
    });
    const post = fetch(muxer.args[0], { method: "POST", body: "offer" });
    if (late) {
        while (!respond) await new Promise(resolve => setImmediate(resolve));
    } else await (await post).text();
    muxer.stderr.emit("data", "WHIP muxer SRTP setup done");
    return { ...state, muxer, children, timers, calls, post, respond };
}

for (const audio of [false, true]) test(`closing a window ends the native session with audio=${audio}`, async t => {
    const live = await capture(t, "window:123", audio);
    assert.equal(live.state.state, "live");
    const window = live.children.find(child => child.args[0] === "--watch-window");
    assert.deepEqual(window.args, ["--watch-window", "123"]);
    // No new frames (a minimized game) must leave the session running.
    live.timers.forEach(callback => callback());
    assert.equal(live.state.state, "live");
    window.emit("exit", 0);
    assert.equal(live.state.state, "ended", "Do not wait for FFmpeg to exit");
    assert.equal(live.state.error, undefined);
    assert.deepEqual(live.calls.filter(([method]) => method === "DELETE"), [["DELETE", "https://tv.example/session/123"]]);
    assert.equal(live.timers.size, 0);
    live.children.slice(1).forEach(child => assert.equal(child.killed || child.stdout.destroyed, true));
    live.stop();
    live.muxer.emit("exit", 0);
    assert.equal(live.calls.filter(([method]) => method === "DELETE").length, 1);
});

test("switching sources ignores a late exit from the previous window watcher", async t => {
    const live = await capture(t);
    const oldWindow = live.children.find(child => child.args[0] === "--watch-window");
    live.restart({ source: "window:456" });
    assert.equal(oldWindow.killed, true);
    oldWindow.emit("exit", 0);
    assert.equal(live.state.state, "live");
    const nextWindow = live.children.find(child => child.args[1] === "456");
    nextWindow.emit("exit", 0);
    assert.equal(live.state.state, "ended");
});

test("monitor capture does not start a window watcher", async t => {
    const live = await capture(t, "monitor:0");
    assert.equal(live.children.some(child => child.args[0] === "--watch-window"), false);
    live.stop();
    assert.equal(live.state.state, "ended");
});

test("a session created after closing the window is also deleted", async t => {
    const live = await capture(t, "window:123", false, true);
    live.children.find(child => child.args[0] === "--watch-window").emit("exit", 0);
    live.respond();
    await (await live.post).text();
    assert.equal(live.state.state, "ended");
    assert.deepEqual(live.calls.filter(([method]) => method === "DELETE"), [["DELETE", "https://tv.example/session/123"]]);
});

test("a failed window watcher closes the session instead of leaving it unattended", async t => {
    const live = await capture(t);
    live.children.find(child => child.args[0] === "--watch-window").emit("error", new Error("spawn failed"));
    assert.equal(live.state.state, "ended");
    assert.match(live.state.error, /Monitor da janela: spawn failed/);
    assert.equal(live.calls.filter(([method]) => method === "DELETE").length, 1);
});

// Cinco segundos de saída do encoder: frames quadros de bytes cada; keyEvery marca keyframes como o encoder real
// (forçados a cada 0,5 s: a 4 FPS, um quadro sim, outro não).
const encoders = live => live.children.filter(child => child.args[0] !== "--watch-window" && child !== live.muxer);
function window(live, frames, bytes, keyEvery = 0) {
    live.muxer.stdin.resume();
    const encoder = encoders(live).at(-1);
    encoder.stderr.emit("data", "frame=1\n");
    for (let index = 0; index < frames; index++) encoder.stdout.emit("data", videoFrame(bytes, keyEvery > 0 && index % keyEvery === 0));
    for (let second = 0; second < 5; second++) live.timers.forEach(callback => callback());
    return encoder;
}

test("starved capture steps down to 30 FPS and then 720p, and climbs back after the ramp-up delay", async t => {
    const now = performance.now;
    let clock = 0;
    performance.now = () => clock;
    t.after(() => { performance.now = now; });
    const live = await capture(t, "monitor:0");
    // Binhuo: 60 FPS pedidos, 4 quadros por segundo de ~110 KB (fatia de 8 Mbps a 60 FPS = ~17 KB).
    window(live, 20, 110_000, 2);
    window(live, 20, 110_000, 2);
    assert.equal(live.state.notice, undefined, "First window is ignored and one bad check is not enough");
    window(live, 20, 110_000, 2);
    assert.equal(encoders(live).length, 2, "The encoder restarts at the next step");
    assert.match(live.state.notice, /1080p 30 FPS/);
    for (let check = 0; check < 3; check++) window(live, 20, 110_000, 2);
    assert.match(live.state.notice, /720p 30 FPS/);
    // Na resolução mínima não desce mais, e antes da espera não tenta voltar.
    window(live, 20, 110_000, 2);
    assert.equal(encoders(live).length, 3);
    clock = 40_000;
    window(live, 150, 20_000, 15);
    assert.equal(encoders(live).length, 4, "Recovering climbs one step at a time");
    assert.match(live.state.notice, /720p/, "The notice only changes when quality drops");
    clock = 80_000;
    window(live, 150, 20_000, 15);
    window(live, 150, 20_000, 15);
    assert.equal(encoders(live).length, 5);
    assert.equal(live.state.notice, undefined, "Back at the chosen quality");
});

test("dropping right after climbing back doubles the wait before the next climb", async t => {
    const now = performance.now;
    let clock = 0;
    performance.now = () => clock;
    t.after(() => { performance.now = now; });
    const live = await capture(t, "monitor:0");
    for (let check = 0; check < 3; check++) window(live, 20, 110_000, 2);
    assert.equal(encoders(live).length, 2, "Down to 30 FPS");
    clock = 40_000;
    window(live, 150, 20_000, 15);
    window(live, 150, 20_000, 15);
    assert.equal(encoders(live).length, 3, "Healthy for 40 s: back to 60 FPS");
    for (let check = 0; check < 3; check++) window(live, 20, 110_000, 2);
    assert.equal(encoders(live).length, 4, "Starved again right away: down again");
    clock = 80_000;
    for (let check = 0; check < 2; check++) window(live, 150, 20_000, 15);
    assert.equal(encoders(live).length, 4, "40 s is no longer enough");
    clock = 120_000;
    window(live, 150, 20_000, 15);
    assert.equal(encoders(live).length, 5, "Climbs after the doubled 80 s");
});

test("a still screen with few small frames or only keyframes keeps the chosen quality", async t => {
    const live = await capture(t, "monitor:0");
    for (let check = 0; check < 4; check++) window(live, 20, 2_000);
    for (let check = 0; check < 4; check++) window(live, 10, 60_000, 1);
    assert.equal(live.state.notice, undefined);
    assert.equal(encoders(live).length, 1, "No encoder restart");
});

test("a game capped at 30 FPS or a 24 FPS video in a 60 FPS live is content, not overload", async t => {
    const live = await capture(t, "monitor:0");
    for (let check = 0; check < 4; check++) window(live, 150, 40_000, 15);
    for (let check = 0; check < 4; check++) window(live, 120, 40_000, 12);
    assert.equal(live.state.notice, undefined);
    assert.equal(encoders(live).length, 1, "No encoder restart");
});

test("changing quality by hand resets the detector to the new choice", async t => {
    const live = await capture(t, "monitor:0");
    for (let check = 0; check < 3; check++) window(live, 20, 110_000, 2);
    assert.match(live.state.notice, /30 FPS/);
    live.restart({ fps: 30, resolution: 720 });
    assert.equal(live.state.notice, undefined);
    for (let check = 0; check < 4; check++) window(live, 10, 110_000, 2);
    assert.equal(encoders(live).length, 3, "30 FPS 720p has no lower step");
});
