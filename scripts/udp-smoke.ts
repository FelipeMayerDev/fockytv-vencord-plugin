// SPDX-License-Identifier: GPL-3.0-or-later
// Uso: <Vencord>/node_modules/.bin/tsx scripts/udp-smoke.ts <Vencord>
// Publica uma fonte sintética no Insider e verifica vídeo/áudio no Chromium real.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Socket } from "node:dgram";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { udpReceiver, udpSink } from "../native-udp";

async function main() {
    if (!process.argv[2]) throw new Error("Informe o checkout do Vencord com esbuild e puppeteer-core instalados.");
    const require = createRequire(resolve(process.argv[2], "package.json"));
    const { build } = require("esbuild"), puppeteer = require("puppeteer-core");
    const bundle = await build({ entryPoints: [resolve("udp-viewer.ts")], bundle: true, format: "iife", globalName: "UdpViewer", write: false });
    const hd = process.argv.includes("--hd"), width = hd ? 1920 : 640, height = hd ? 1080 : 360, fps = hd ? 60 : 30;
    const key = `udp-check-${Date.now()}`;
    const lose = process.argv.includes("--loss"), prototype = Socket.prototype as any, originalSend = prototype.send;
    let dropped = 0, lossGroup: number | undefined, streamingAt = 0;
    if (lose) prototype.send = function (...args: any[]) {
        const packet = args[0];
        if (Buffer.isBuffer(packet) && packet.toString("ascii", 0, 4) === "FTVD" && packet[25] >= 3) {
            if (lossGroup === undefined && packet[24] === 0 && streamingAt && performance.now() - streamingAt > 1500) lossGroup = packet.readUInt32BE(20);
            if (packet.readUInt32BE(20) === lossGroup && packet[24] < 2) {
                dropped++; const callback = args.at(-1); queueMicrotask(() => callback(null)); return;
            }
        }
        return originalSend.apply(this, args);
    };
    const sink = await udpSink(key, { resolution: height, fps }, hd ? 12 : 8);
    sink.input.on("error", error => console.error("Publisher:", error.message));
    let receiver: Awaited<ReturnType<typeof udpReceiver>> | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    let browser: any;
    let lastStats: unknown, totalOutput = 0;
    try {
        browser = await puppeteer.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true,
            args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
        const page = await browser.newPage();
        page.on("pageerror", (error: Error) => console.error("Browser:", error.message));
        await page.exposeFunction("startUdpWatch", async () => {
            receiver = await udpReceiver("ffmpeg", key, "udp-check-viewer");
            streamingAt = performance.now();
            child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=${fps}`,
                "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "12", "-c:v", "libx264", "-preset", "ultrafast", "-profile:v", "baseline",
                "-g", String(fps / 2), "-bf", "0", ...(hd ? ["-b:v", "12M", "-maxrate", "12M", "-bufsize", "1M", "-x264-params", "nal-hrd=cbr"] : []), "-c:a", "libopus", "-ac", "2", "-f", "mpegts", "pipe:1"], { stdio: ["ignore", "pipe", "pipe"] });
            child.stdout!.pipe(sink.input); child.stderr!.on("data", chunk => process.stderr.write(chunk));
            return "check";
        });
        await page.exposeFunction("readUdpWatch", () => { const result = receiver!.read(); totalOutput += result.data.length;
            lastStats = { ...result.stats, generation: result.generation, totalOutput }; return { ...result, data: Array.from(result.data) }; });
        await page.exposeFunction("stopUdpWatch", () => receiver?.close());
        await page.setContent("<!doctype html><html><body></body></html>");
        await page.addScriptTag({ content: bundle.outputFiles[0].text });
        await page.evaluate("globalThis.__name = fn => fn");
        const result = await page.evaluate(async () => {
            const w = window as any;
            const native = { startUdpWatch: w.startUdpWatch, stopUdpWatch: w.stopUdpWatch,
                readUdpWatch: async () => { const result = await w.readUdpWatch(); return { ...result, data: new Uint8Array(result.data) }; } };
            const created: HTMLVideoElement[] = [], originalCreate = document.createElement.bind(document);
            (document as any).createElement = (tag: string) => { const node = originalCreate(tag); if (tag === "video") created.push(node as HTMLVideoElement); return node; };
            const controller = new AbortController();
            const viewing = await w.UdpViewer.watchUdp(native, "ignored", "viewer", () => {}, controller.signal);
            const video = document.createElement("video"); video.muted = true; video.srcObject = viewing.media;
            document.body.append(video); await video.play();
            await new Promise(resolve => setTimeout(resolve, 2500));
            const before = video.getVideoPlaybackQuality().totalVideoFrames;
            await new Promise(resolve => setTimeout(resolve, 1500));
            if (video.getVideoPlaybackQuality().totalVideoFrames < before + 20) throw new Error("Vídeo parou após perda de pacotes: " + JSON.stringify(created.map(v => ({ t: v.currentTime, ready: v.readyState, paused: v.paused, error: v.error?.message, frames: v.getVideoPlaybackQuality().totalVideoFrames, ranges: Array.from({ length: v.buffered.length }, (_, i) => [v.buffered.start(i), v.buffered.end(i)]) }))));
            const result = { width: video.videoWidth, height: video.videoHeight, frames: video.getVideoPlaybackQuality().totalVideoFrames,
                videoTracks: viewing.media.getVideoTracks().length, audioTracks: viewing.media.getAudioTracks().length };
            viewing.close(); controller.abort();
            if (viewing.media.getTracks().some((track: MediaStreamTrack) => track.readyState !== "ended")) throw new Error("Faixas não encerraram ao fechar.");
            return result;
        });
        assert.equal(result.width, width); assert.equal(result.height, height);
        assert.ok(result.frames > 20, `Poucos quadros: ${JSON.stringify(result)}`);
        if (lose) assert.equal(dropped, 2, "O teste precisa perder dois pacotes do mesmo grupo");
        assert.equal(result.videoTracks, 1); assert.equal(result.audioTracks, 1);
        console.log("UDP Insider → AES-GCM/FEC → FFmpeg remux → Chromium MSE → MediaStream:", result, { dropped, stats: lastStats });
    } catch (error) { console.error("UDP stats:", lastStats); throw error; } finally { prototype.send = originalSend; child?.stdout?.unpipe(sink.input); child?.stdout?.destroy(); child?.kill("SIGKILL"); receiver?.close(); sink.stop(); sink.input.destroy(); await browser?.close(); }
}
void main().catch(error => { console.error(error.message); process.exitCode = 1; });
