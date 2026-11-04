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
    "muxerArgs", "encoderArgs", "preferLocalCandidates", "preferred", "CODECS", "report",
    stripTypeScriptTypes(source.slice(source.indexOf("export async function startCapture"))).replace("export ", "") + ";return startCapture;");

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
