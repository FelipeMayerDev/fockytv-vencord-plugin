import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";

const source = readFileSync(new URL("./native-capture.ts", import.meta.url), "utf8");
const create = new Function("spawn", "createServer", "setInterval", "clearInterval", "setTimeout", "clearTimeout",
    "muxerArgs", "encoderArgs", "preferLocalCandidates", "preferred", "CODECS", "report",
    stripTypeScriptTypes(source.slice(source.indexOf("export async function startCapture"))).replace("export ", "") + ";return startCapture;");

test("native audio and video retain their real start offset instead of each starting at zero", t => {
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
    assert.equal(args[args.indexOf("-isync") + 1], "0");
    const silent = encoderArgs({ ...options, audio: false }, 0);
    assert.equal(silent.includes("-isync"), false, "Synthetic silence has no capture clock");
    assert.equal(silent.includes("-use_wallclock_as_timestamps"), false);

    if (spawnSync("ffmpeg", ["-version"]).error?.code === "ENOENT" || spawnSync("ffprobe", ["-version"]).error?.code === "ENOENT")
        return t.skip("FFmpeg and ffprobe are required for the real timestamp check");
    // Stand in for paced WASAPI PCM; video deliberately starts 300 ms later.
    args.splice(args.indexOf("-probesize"), firstInput + 2 - args.indexOf("-probesize"),
        "-use_wallclock_as_timestamps", "1", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo,arealtime");
    args.splice(args.lastIndexOf("-f"), 0, "-t", "1");
    const encoded = spawnSync("ffmpeg", args, { timeout: 10000 });
    assert.equal(encoded.status, 0, encoded.stderr.toString());
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
        "nvenc", ["nvenc", "amf"], () => "");
    const state = await start({ source, audio, fps: 60, resolution: 1080, key: "test", endpoint: "https://tv.example/whip" },
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
