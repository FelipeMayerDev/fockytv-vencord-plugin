// SPDX-License-Identifier: GPL-3.0-or-later
// Teste funcional da live: publica uma tela sintética com o LivePublisher real (session.ts) num Chromium
// headless, assiste com o watchLive real (viewer.ts) e exige quadros decodificados, não pretos e mudando.
// Roda duas vezes: com H.264 e sem H.264 nas capacidades do WebRTC (o caso do Discord que deixou as lives pretas em 2026-11-19).
//
// Uso: node e2e/live.mjs [https://fockytv-insider.felipemayer.com.br]
// Requer o checkout do Vencord (puppeteer-core e esbuild) em VENCORD, padrão ~/Projects/Vencord-GoLiveBypass,
// e um Chromium em CHROMIUM, padrão /usr/bin/chromium.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.argv[2] ?? "https://fockytv-insider.felipemayer.com.br";
const vencord = process.env.VENCORD ?? join(homedir(), "Projects", "Vencord-GoLiveBypass");
const require = createRequire(join(vencord, "package.json"));
const puppeteer = require("puppeteer-core");
const esbuild = require("esbuild");

const bundle = esbuild.buildSync({
    stdin: { contents: `export { LivePublisher } from "./session"; export { watchLive } from "./viewer";`, resolveDir: root, loader: "ts" },
    bundle: true, format: "iife", globalName: "FockyTV", write: false, platform: "browser", target: "chrome120"
}).outputFiles[0].text;
const livekit = readFileSync(join(root, "livekit-client.umd.js"), "utf8");

// Mesmo contrato do Native.request do plugin: bearer com a chave, JSON nas rotas do LiveKit.
async function request(url, method, key = "", body = "") {
    const response = await fetch(url, {
        method, body: method === "POST" ? body : undefined, redirect: "error", signal: AbortSignal.timeout(20_000),
        headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) }
    });
    return { status: response.status, body: await response.text(), location: response.headers.get("Location") };
}

async function run(mode, withoutH264) {
    const browser = await puppeteer.launch({
        executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", headless: true,
        args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"]
    });
    try {
        const page = await browser.newPage();
        page.on("console", message => message.type() === "error" && console.log(`  [${mode}] console: ${message.text()}`));
        await page.exposeFunction("fockyRequest", request);
        // Discord sem H.264: o WebRTC dele não lista o codec nem o oferece no SDP, como no cliente que deixou
        // as lives pretas. Tira o H.264 das capacidades e da oferta (com o RTX ligado a ele).
        if (withoutH264) await page.evaluate(() => {
            const isH264 = codec => codec.mimeType.toLowerCase() === "video/h264";
            for (const type of [RTCRtpSender, RTCRtpReceiver]) {
                const original = type.getCapabilities.bind(type);
                type.getCapabilities = kind => {
                    const capabilities = original(kind);
                    return capabilities && { ...capabilities, codecs: capabilities.codecs.filter(codec => !isH264(codec)) };
                };
            }
            const stripH264 = sdp => {
                const h264 = new Set([...sdp.matchAll(/a=rtpmap:(\d+) H264\//g)].map(match => match[1]));
                for (const [, rtx, apt] of sdp.matchAll(/a=fmtp:(\d+) apt=(\d+)/g)) if (h264.has(apt)) h264.add(rtx);
                return sdp.split("\r\n")
                    .filter(line => !h264.has(line.match(/^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)/)?.[1]))
                    .map(line => line.startsWith("m=video") ? line.split(" ").filter((part, index) => index < 3 || !h264.has(part)).join(" ") : line)
                    .join("\r\n");
            };
            const createOffer = RTCPeerConnection.prototype.createOffer;
            RTCPeerConnection.prototype.createOffer = async function (...args) {
                const offer = await createOffer.apply(this, args);
                return { type: offer.type, sdp: stripH264(offer.sdp) };
            };
        });
        await page.addScriptTag({ content: livekit });
        await page.addScriptTag({ content: bundle });
        const room = `e2e-${randomBytes(6).toString("hex")}`;
        return await page.evaluate(async (base, room) => {
            const h264 = RTCRtpSender.getCapabilities("video").codecs.some(codec => codec.mimeType.toLowerCase() === "video/h264");
            // Tela sintética: fundo que muda de cor e um bloco andando, para o quadro nunca ser preto nem parado.
            const canvas = Object.assign(document.createElement("canvas"), { width: 1280, height: 720 });
            const context = canvas.getContext("2d");
            let tick = 0;
            const paint = setInterval(() => {
                tick++;
                context.fillStyle = `hsl(${tick * 7 % 360} 80% 50%)`;
                context.fillRect(0, 0, 1280, 720);
                context.fillStyle = "#fff";
                context.fillRect(tick * 13 % 1180, 300, 100, 100);
            }, 33);
            const audio = new AudioContext(), tone = audio.createOscillator(), sink = audio.createMediaStreamDestination();
            tone.connect(sink); tone.start();
            const capture = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...sink.stream.getAudioTracks()]);
            const publisher = new FockyTV.LivePublisher(LivekitClient, window.fockyRequest, room, false, capture);
            let viewing;
            try {
                await publisher.connect(base, 30);
                viewing = await FockyTV.watchLive(LivekitClient, window.fockyRequest, base, room, "e2e-viewer", () => {});
                const video = Object.assign(document.createElement("video"), { muted: true, autoplay: true, srcObject: viewing.media });
                document.body.append(video);
                await video.play();
                // 5 s de quadros: conta, e amostra o brilho de cada um para provar que não é preto nem congelado.
                const probe = Object.assign(document.createElement("canvas"), { width: 32, height: 18 }).getContext("2d", { willReadFrequently: true });
                const brightness = [];
                let frames = 0;
                await new Promise(resolve => {
                    const end = performance.now() + 5000;
                    const onFrame = () => {
                        frames++;
                        probe.drawImage(video, 0, 0, 32, 18);
                        const pixels = probe.getImageData(0, 0, 32, 18).data;
                        let sum = 0;
                        for (let i = 0; i < pixels.length; i += 4) sum += pixels[i] + pixels[i + 1] + pixels[i + 2];
                        brightness.push(sum / (pixels.length / 4 * 3));
                        if (performance.now() < end) video.requestVideoFrameCallback(onFrame); else resolve();
                    };
                    video.requestVideoFrameCallback(onFrame);
                    setTimeout(resolve, 8000);
                });
                const stats = await viewing.getStats();
                const inbound = [...stats.values()].find(value => value.type === "inbound-rtp" && value.kind === "video");
                const codec = inbound && stats.get(inbound.codecId)?.mimeType;
                return { h264, codec, frames, width: video.videoWidth, maxBrightness: Math.max(0, ...brightness), distinct: new Set(brightness.map(Math.round)).size };
            } finally {
                viewing?.close();
                await publisher.close();
                clearInterval(paint);
                tone.stop();
            }
        }, base, room);
    } finally { await browser.close(); }
}

const modes = [["com H.264", false], ["sem H.264", true]];
let failed = false;
for (const [mode, withoutH264] of modes) {
    try {
        const result = await run(mode, withoutH264);
        const problems = [];
        if (result.h264 === withoutH264) problems.push(`o navegador ${result.h264 ? "tem" : "não tem"} H.264 (cenário não reproduzido)`);
        if (result.frames < 50) problems.push(`só ${result.frames} quadros em 5 s`);
        if (result.maxBrightness < 20) problems.push("vídeo preto");
        if (result.distinct < 3) problems.push("vídeo congelado");
        console.log(`${problems.length ? "FALHOU" : "ok"} live ${mode}: ${result.frames} quadros, ${result.width}px, ${result.codec}, brilho máx ${Math.round(result.maxBrightness)}${problems.length ? ` — ${problems.join("; ")}` : ""}`);
        failed ||= problems.length > 0;
    } catch (error) {
        console.log(`FALHOU live ${mode}: ${error.message}`);
        failed = true;
    }
}
process.exitCode = failed ? 1 : 0;
