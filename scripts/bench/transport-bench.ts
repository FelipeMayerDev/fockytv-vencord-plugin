// SPDX-License-Identifier: GPL-3.0-or-later
// Uso: /home/focky/Vencord/node_modules/.bin/tsx scripts/bench/transport-bench.ts [--runs 3] [--seconds 20] [--warmup 6] [--fps 30]
//      [--scenarios clean,loss1,burst,jitter] [--transports webrtc,native,udp,webrtc-steady] [--steady-warmup 90] [--append] [--out docs/transportes/benchmark-results.json]
// webrtc-steady: o mesmo WebRTC medido depois de --steady-warmup s, quando a rampa de banda já terminou. --append soma ao JSON existente.
// Compara os 3 transportes de tela no Insider (LAN). Cada quadro leva o relógio do PC num código de barras; o espectador
// (Chromium headless) lê o código por quadro e mede glass-to-glass, FPS, travadas e perdas. Rede ruim: netem no servidor
// (ssh servidor, sudo -n tc), só no sentido servidor → este PC (BENCH_IP). Precisa de esbuild/puppeteer-core em $VENCORD.
// No Windows (sessão interativa): captura real do plugin (gfxcapture + NVENC, BENCH_FFMPEG) de uma página-relógio em tela cheia
// no Edge (CHROMIUM_PATH); o WebRTC captura a mesma aba com getDisplayMedia. Lá o netem fica por conta de quem chama.
import { execFileSync, spawn } from "node:child_process";
import { randomFillSync } from "node:crypto";
import { createWriteStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cpus, hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { startCapture } from "../../native-capture";
import { UDP_SERVER, udpReceiver, udpSink } from "../../native-udp";

const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const RUNS = Number(arg("runs", "3")), SECONDS = Number(arg("seconds", "20")), WARMUP = Number(arg("warmup", "6")), STEADY = Number(arg("steady-warmup", "90")), FPS = Number(arg("fps", "30"));
const WIN = process.platform === "win32", FFMPEG = process.env.BENCH_FFMPEG ?? "ffmpeg", BITRATE = Number(arg("bitrate", "8"));
const LABEL = FPS === 30 && BITRATE === 8 ? "" : ` ${FPS}fps ${BITRATE}M`;
const W = 1920, H = 1080, BLOCK = 32, IFACE = "enp0s31f6", ME = process.env.BENCH_IP ?? "192.168.1.6";
const NETEM: Record<string, string> = { clean: "", loss1: "loss random 1%", burst: "loss gemodel 0.1% 20%", jitter: "delay 40ms 20ms" };
const scenarios = arg("scenarios", Object.keys(NETEM).join(",")).split(","), transports = arg("transports", "webrtc,native,udp").split(",");
const OUT = resolve(arg("out", "docs/transportes/benchmark-results.json"));
const WRAPPER = resolve("scripts/bench/ffmpeg-libx264.sh"), TMP = mkdtempSync(join(tmpdir(), "fockytv-bench-"));
// Fonte "window:" do plugin vigia a janela com o audio-helper: usa o mais novo da pasta do FFmpeg do plugin.
const HELPER = () => readdirSync(dirname(FFMPEG)).filter(f => /^audio-helper.*\.exe$/.test(f)).map(f => join(dirname(FFMPEG), f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
const LOGS = process.env.BENCH_LOGS ?? TMP, NO_TC = WIN || !!process.env.BENCH_NO_TC;
// native-rtx2048: o muxer WHIP real com "-rtp_history 2048" (o padrão do FFmpeg é 512) — injetado no spawn do startCapture.
const childProcess = require("node:child_process"), realSpawn = childProcess.spawn;
// native-cap60: captura a 2× o FPS e o filtro fps reduz ao FPS pedido (o limitador do gfxcapture num monitor de 144 Hz perde quadros).
let whipExtra: string[] = [], cap60 = false;
const capture60 = (args: string[]) => args.flatMap(a => a.startsWith("gfxcapture=") ? [a.replace(`max_framerate=${FPS}`, `max_framerate=${2 * FPS}`)] : a === "-c:v" ? ["-vf", `fps=${FPS}`, a] : [a]);
childProcess.spawn = (file: string, args: string[], options: any) => realSpawn(file, args.includes("whip") ? [...args.slice(0, -1 - 4), ...whipExtra, ...args.slice(-1 - 4)]
    : cap60 && args.some(a => a.startsWith("gfxcapture=")) ? capture60(args) : args, options);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Mesmo request do processo nativo (native.ts), sem a validação de IPC.
async function request(url: string, method: string, key = "", body = "") {
    const json = /^\/api\/livekit\/(join|whip\/[\w-]+\/(?:quality|announce))$/.test(new URL(url).pathname);
    const response = await fetch(url, { method, headers: { "Content-Type": json ? "application/json" : "application/sdp", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: method === "POST" ? body : undefined, redirect: "error", signal: AbortSignal.timeout(20_000) });
    return { status: response.status, body: await response.text(), location: response.headers.get("Location") };
}

// netem num ramo prio que só recebe pacotes para este PC; o dead-man devolve o pfifo_fast se o script morrer.
const ssh = (command: string) => execFileSync("ssh", ["servidor", command], { encoding: "utf8", timeout: 30_000 });
let deadman = "";
function impair(netem: string) {
    const tc = `sudo -n tc`;
    deadman = ssh(`${tc} qdisc replace dev ${IFACE} root handle 1: prio bands 4 priomap 1 2 2 2 1 2 0 0 1 1 1 1 1 1 1 1 && ${tc} qdisc add dev ${IFACE} parent 1:4 handle 40: netem ${netem} && ` +
        `${tc} filter add dev ${IFACE} parent 1: protocol ip prio 1 u32 match ip dst ${ME}/32 flowid 1:4 && { setsid sh -c 'sleep 1500; sudo -n tc qdisc replace dev ${IFACE} root pfifo_fast' >/dev/null 2>&1 </dev/null & echo $!; }`).trim();
}
const restore = () => ssh(`${deadman ? `kill -- -${deadman} 2>/dev/null; ` : ""}sudo -n tc qdisc replace dev ${IFACE} root pfifo_fast; tc qdisc show dev ${IFACE}`);

// Código de barras: 32 bits do Date.now() + 16 de verificação, blocos de 32 px no topo (alinhados aos macroblocos).
const check = (low: number) => ((low >>> 16) ^ (low & 0xffff) ^ 0x5a5a) & 0xffff;
const bits = (ts: number) => { const low = ts >>> 0, c = check(low); return Array.from({ length: 48 }, (_, b) => b < 32 ? (low >>> (31 - b)) & 1 : (c >>> (47 - b)) & 1); };

// Fonte crua: testsrc2 rolando 16 px por quadro + caixa de ruído 640x360 nova a cada quadro (força o encoder a gastar bitrate).
function generator(fifo: string, base: Buffer) {
    const out = createWriteStream(fifo, { highWaterMark: base.length });
    let n = 0, skipped = 0, stopped = false, timer: NodeJS.Timeout | undefined, start = 0;
    const planes = [[0, W, H], [W * H, W / 2, H / 2], [W * H * 5 / 4, W / 2, H / 2]];
    const tick = () => {
        if (stopped) return;
        if (out.writableNeedDrain) skipped++;
        else {
            const frame = Buffer.allocUnsafe(base.length), off = (n * 16) % W;
            planes.forEach(([at, w, h], p) => {
                const o = p ? off / 2 : off;
                for (let y = 0; y < h; y++) { const row = at + y * w; base.copy(frame, row, row + o, row + w); base.copy(frame, row + w - o, row, row + o); }
            });
            for (let y = 360; y < 720; y++) randomFillSync(frame, y * W + 640, 640);
            for (const at of [W * H, W * H * 5 / 4]) {
                for (let y = 180; y < 360; y++) frame.fill(128, at + y * W / 2 + 320, at + y * W / 2 + 640);
                for (let y = 0; y < BLOCK / 2; y++) frame.fill(128, at + y * W / 2, at + y * W / 2 + 24 * BLOCK);
            }
            bits(Date.now()).forEach((bit, b) => { for (let y = 0; y < BLOCK; y++) frame.fill(bit ? 235 : 16, y * W + b * BLOCK, y * W + (b + 1) * BLOCK); });
            out.write(frame);
        }
        n++;
        timer = setTimeout(tick, Math.max(0, start + n * 1000 / FPS - performance.now()));
    };
    out.on("error", () => {});
    out.once("open", () => { start = performance.now(); tick(); });
    return { stop() { stopped = true; clearTimeout(timer); out.destroy(); }, stats: () => ({ frames: n, skipped }) };
}

// Fonte no navegador: testsrc2 rolando + ruído + código de barras num canvas (invisível no Linux, tela cheia no Windows).
async function startSource(png: string, fps: number, visible: boolean) {
    const w = window as any, img = new Image(); img.src = png; await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = visible ? Math.round(innerWidth * devicePixelRatio) : 1920; canvas.height = visible ? Math.round(innerHeight * devicePixelRatio) : 1080;
    if (visible) { document.body.style.margin = "0"; document.body.style.overflow = "hidden"; canvas.style.cssText = "display:block;width:100vw;height:100vh"; document.body.append(canvas); }
    const ctx = canvas.getContext("2d")!, k = canvas.height / 1080, noise = ctx.createImageData(640, 360), pixels = new Uint32Array(noise.data.buffer);
    let n = 0; const start = performance.now();
    const draw = () => {
        const off = (n * 16) % 1920;
        for (let x = -off; x < canvas.width; x += 1920 * k) ctx.drawImage(img, x, 0, 1920 * k, canvas.height);
        for (let i = 0; i < pixels.length; i++) pixels[i] = 0xff000000 | (Math.random() * 256 | 0) * 0x010101;
        ctx.putImageData(noise, Math.round(640 * k), Math.round(360 * k));
        const low = Date.now() >>> 0, c = ((low >>> 16) ^ (low & 0xffff) ^ 0x5a5a) & 0xffff;
        for (let b = 0; b < 48; b++) { ctx.fillStyle = (b < 32 ? (low >>> (31 - b)) & 1 : (c >>> (47 - b)) & 1) ? "#fff" : "#000"; ctx.fillRect(b * 32 * k, 0, 32 * k, 32 * k); }
        n++; setTimeout(draw, Math.max(0, start + n * 1000 / fps - performance.now()));
    };
    draw();
    w.source = { canvas, frames: () => n };
}

// Publicador WebRTC: o canvas (captureStream) ou a própria aba (getDisplayMedia, como uma captura do Chromium) → LivePublisher real.
async function publishCanvas(key: string, base: string, fps: number, bitrate: number, tab: boolean, livekit: string, motion = false) {
    const w = window as any;
    // tab: captura real da tela inteira (getDisplayMedia, escolhida sozinha por --auto-select-desktop-capture-source), como o Chromium do Discord.
    const stream = tab ? await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: fps, displaySurface: "monitor" }, audio: false } as any) : w.source.canvas.captureStream(fps);
    // motion (webrtc-screen-mf): contentHint "motion" + degradationPreference "maintain-framerate" no lugar de "balanced" (sem mexer no session.ts).
    if (motion) stream.getVideoTracks()[0].contentHint = "motion";
    const session = new w.Bench.LivePublisher(w.Bench.loadLivekit(livekit, WebSocket), w.benchRequest, key, false, stream);
    if (motion) {
        const lp = session.room.localParticipant, publishTrack = lp.publishTrack.bind(lp);
        lp.publishTrack = (track: any, options: any) => publishTrack(track, track.kind === "video" ? { ...options, degradationPreference: "maintain-framerate" } : options);
    }
    w.pub = { session, frames: w.source.frames, stop: () => session.close() };
    await session.connect(base, fps);
    let qualityError;
    try { await session.setQuality({ fps, resolution: 1080 }); } catch (error) { qualityError = String(error); }
    // O plugin usa teto de 12 Mbps (MAX_BITRATE); aqui o mesmo --bitrate dos outros transportes.
    const sender = session.tracks.get("video").sender, parameters = sender.getParameters();
    parameters.encodings[0].maxBitrate = bitrate * 1e6;
    if (motion) parameters.degradationPreference = "maintain-framerate";
    await sender.setParameters(parameters);
    // Evidência para a rampa de banda: que feedback de congestionamento o SFU negociou.
    const sdp = (await session.room.engine.pcManager?.publisher?.getRemoteDescription?.())?.sdp ?? "";
    const feedback = sdp.split(/\r?\n/).filter((l: string) => /^a=(rtcp-fb|extmap):/.test(l) && /transport-cc|goog-remb|transport-wide/.test(l));
    return { qualityError, feedback: [...new Set(feedback)] };
}

async function publisherStats() {
    const all = [...(await (window as any).pub.session.getStats()).values()] as any[];
    const o = all.find(s => s.type === "outbound-rtp" && s.kind === "video") ?? {};
    return { bytes: (o.bytesSent ?? 0) + (o.headerBytesSent ?? 0), retransmitted: o.retransmittedBytesSent, width: o.frameWidth, height: o.frameHeight, fps: o.framesPerSecond,
        encoder: o.encoderImplementation, codec: all.find(s => s.id === o.codecId)?.mimeType, limitation: o.qualityLimitationReason, limitationDurations: o.qualityLimitationDurations,
        target: o.targetBitrate, nack: o.nackCount, pli: o.pliCount, frames: (window as any).pub.frames() };
}

// Espectador: o caminho real do plugin (watchLive com livekit-client ou watchUdp com MSE), lendo o código de cada quadro.
// No UDP lê também o <video> MSE interno do watchUdp (mse): separa o transporte do captureStream() que o plugin usa por cima.
async function watch(transport: string, key: string, base: string, livekit: string) {
    const w = window as any, controller = new AbortController(), bench: any = { frames: [] as number[], mse: [] as number[], ended: 0 };
    w.bench = bench;
    const read = (video: HTMLVideoElement, frames: number[]) => {
        const strip = document.createElement("canvas"); strip.width = 1536; strip.height = 32;
        const ctx = strip.getContext("2d", { willReadFrequently: true })!;
        const frame = () => {
            const now = Date.now();
            const k = video.videoHeight / 1080;
            ctx.drawImage(video, 0, 0, 1536 * k, 32 * k, 0, 0, 1536, 32);
            const data = ctx.getImageData(0, 12, 1536, 8).data;
            let low = 0, c = 0;
            for (let b = 0; b < 48; b++) {
                let sum = 0;
                for (let y = 0; y < 8; y++) for (let x = b * 32 + 8; x < b * 32 + 24; x++) sum += data[(y * 1536 + x) * 4];
                const bit = sum / 128 > 128 ? 1 : 0;
                if (b < 32) low = low * 2 + bit; else c = c * 2 + bit;
            }
            frames.push(now, (((low >>> 16) ^ (low & 0xffff) ^ 0x5a5a) & 0xffff) === c ? low : -1);
            video.requestVideoFrameCallback(frame);
        };
        video.requestVideoFrameCallback(frame);
    };
    const create = document.createElement;
    if (transport === "udp") (document as any).createElement = (tag: string) => {
        const node = create.call(document, tag);
        if (tag === "video") { document.createElement = create; read(node as HTMLVideoElement, bench.mse); }
        return node;
    };
    const ended = () => { bench.ended = Date.now(); };
    // SRT → MediaMTX: espectador WHEP simples (recvonly) pelo /api/whep do live-api.
    const whep = async (key: string, base: string) => {
        const pc = new RTCPeerConnection(), media = new MediaStream();
        pc.addTransceiver("video", { direction: "recvonly" }); pc.addTransceiver("audio", { direction: "recvonly" });
        pc.ontrack = event => media.addTrack(event.track);
        await pc.setLocalDescription(await pc.createOffer());
        await new Promise<void>(resolve => { if (pc.iceGatheringState === "complete") resolve(); pc.onicegatheringstatechange = () => pc.iceGatheringState === "complete" && resolve(); setTimeout(resolve, 3000); });
        let answer: any;
        // A stream SRT aparece no MediaMTX alguns instantes depois do encoder começar.
        for (let i = 0; i < 20 && (answer = await w.benchRequest(`${base}/api/whep`, "POST", key, pc.localDescription!.sdp)).status === 404; i++) await new Promise(r => setTimeout(r, 500));
        if (answer.status !== 201) throw new Error(`WHEP ${answer.status}: ${answer.body.slice(0, 200)}`);
        await pc.setRemoteDescription({ type: "answer", sdp: answer.body });
        return { media, getStats: () => pc.getStats(), close: () => { pc.close(); if (answer.location) void w.benchRequest(new URL(answer.location, base).href, "DELETE", key); } };
    };
    const native = { startUdpWatch: w.startUdpWatch, stopUdpWatch: w.stopUdpWatch, readUdpWatch: async (id: string) => {
        const r = await w.readUdpWatch(id);
        return { ...r, data: (Uint8Array as any).fromBase64 ? (Uint8Array as any).fromBase64(r.data) : Uint8Array.from(atob(r.data), c => c.charCodeAt(0)) };
    } };
    try {
        bench.viewing = transport.startsWith("srt") ? await whep(key, base)
            : transport === "udp" ? await w.Bench.watchUdp(native, key, "bench-viewer", ended, controller.signal)
            : await w.Bench.watchLive(w.Bench.loadLivekit(livekit, WebSocket), w.benchRequest, base, key, "bench-viewer", ended, controller.signal);
    } finally { document.createElement = create; }
    bench.close = () => { controller.abort(); bench.viewing.close(); };
    const video = document.createElement("video"); video.muted = true; video.srcObject = bench.viewing.media; document.body.append(video);
    read(video, bench.frames);
    bench.video = video;
    await video.play();
}

async function viewerStats() {
    const all = [...(await (window as any).bench.viewing.getStats()).values()] as any[];
    const pairId = all.find(s => s.type === "transport")?.selectedCandidatePairId;
    const pair = all.find(s => s.id === pairId) ?? all.find(s => s.type === "candidate-pair" && s.nominated && s.state === "succeeded") ?? {};
    const local = all.find(s => s.id === pair.localCandidateId), remote = all.find(s => s.id === pair.remoteCandidateId);
    const v = all.find(s => s.type === "inbound-rtp" && s.kind === "video") ?? {};
    return { wireBytes: pair.bytesReceived, path: `${local?.address}(${local?.candidateType}) ← ${remote?.address}:${remote?.port}/${remote?.protocol}`, rtt: pair.currentRoundTripTime,
        packetsReceived: v.packetsReceived, packetsLost: v.packetsLost, nack: v.nackCount, pli: v.pliCount, framesDecoded: v.framesDecoded, framesDropped: v.framesDropped,
        freezeCount: v.freezeCount, freezeSeconds: v.totalFreezesDuration, codec: all.find(s => s.id === v.codecId)?.mimeType, width: v.frameWidth, height: v.frameHeight,
        jitterBufferMs: v.jitterBufferEmittedCount ? 1000 * v.jitterBufferDelay / v.jitterBufferEmittedCount : undefined };
}

// CPU por /proc (ticks de 10 ms): árvore de um processo ou filhos ffmpeg do node separados pelo papel.
function procs() {
    return readdirSync("/proc").filter(d => /^\d+$/.test(d)).flatMap(pid => {
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8"), f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
            return [{ pid: Number(pid), ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]), cmd: readFileSync(`/proc/${pid}/cmdline`, "utf8") }];
        } catch { return []; }
    });
}
function cpu(roots: number[]) {
    if (WIN) return { at: performance.now(), node: process.cpuUsage(), browsers: [0, 0], encoder: 0, muxer: 0, receiver: 0, wchar: 0 };
    const all = procs(), tree = (root: number): number => { const p = all.find(x => x.pid === root); return (p?.ticks ?? 0) + all.filter(x => x.ppid === root).reduce((s, x) => s + tree(x.pid), 0); };
    const mine = all.filter(p => p.ppid === process.pid), ticks = (re: RegExp) => mine.filter(p => re.test(p.cmd)).reduce((s, p) => s + p.ticks, 0);
    const encoder = mine.find(p => /rawvideo/.test(p.cmd));
    let wchar = 0; try { wchar = Number(/wchar: (\d+)/.exec(readFileSync(`/proc/${encoder?.pid}/io`, "utf8"))![1]); } catch { /* encoder já saiu */ }
    return { at: performance.now(), node: process.cpuUsage(), browsers: roots.map(tree), encoder: ticks(/rawvideo/), muxer: ticks(/\0whip\0/), receiver: ticks(/empty_moov/), wchar };
}

const pct = (sorted: number[], p: number) => sorted[Math.max(0, Math.ceil(p / 100 * sorted.length) - 1)];
function analyze(frames: number[], from: number, to: number) {
    const interval = 1000 / FPS, g2g: number[] = [];
    let presented = 0, dup = 0, corrupt = 0, lost = 0, reordered = 0, stalls100 = 0, stalls500 = 0, maxGap = 0, prevT: number | undefined, prevTs: number | undefined;
    for (let i = 0; i < frames.length; i += 2) {
        const t = frames[i], ts = frames[i + 1];
        if (t < from || t > to) continue;
        presented++;
        if (prevT !== undefined) { const gap = t - prevT; if (gap > 100) stalls100++; if (gap > 500) stalls500++; maxGap = Math.max(maxGap, gap); }
        prevT = t;
        if (ts < 0) { corrupt++; continue; }
        if (ts === prevTs) { dup++; continue; }
        const delay = ((t >>> 0) - ts) >>> 0;
        if (delay > 60_000) { corrupt++; continue; }
        if (prevTs !== undefined) { const d = (ts - prevTs) >>> 0; if (d < 2 ** 31) lost += Math.max(0, Math.round(d / interval) - 1); else reordered++; }
        g2g.push(delay); prevTs = ts;
    }
    const sorted = [...g2g].sort((a, b) => a - b), seconds = (to - from) / 1000;
    // Estabilidade: quadros distintos por segundo de relógio do espectador; "abaixo" = < 90% do FPS pedido.
    const perSecond = Array.from({ length: Math.floor(seconds) }, () => 0);
    for (let i = 0, prev = -2; i < frames.length; i += 2) {
        const slot = Math.floor((frames[i] - from) / 1000);
        if (slot >= 0 && slot < perSecond.length && frames[i + 1] >= 0 && frames[i + 1] !== prev) perSecond[slot]++;
        if (frames[i + 1] >= 0) prev = frames[i + 1];
    }
    const mean = perSecond.reduce((a, b) => a + b, 0) / Math.max(1, perSecond.length);
    const fpsStd = Math.sqrt(perSecond.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, perSecond.length));
    const below = 100 * perSecond.filter(n => n < 0.9 * FPS).length / Math.max(1, perSecond.length);
    return { presented, unique: g2g.length, fps: g2g.length / seconds, fpsStd, belowPct: below, perSecond, dup, corrupt, lost, lostPct: 100 * lost / Math.max(1, lost + g2g.length), reordered, stalls100, stalls500, maxGap,
        g2gP50: pct(sorted, 50), g2gP95: pct(sorted, 95), g2gMax: sorted.at(-1), g2g };
}

async function run(transport: string, scenario: string, index: number, ctx: any) {
    const webrtc = transport.startsWith("webrtc"), warmup = transport === "webrtc-steady" ? STEADY : WARMUP;
    const key = `bench-${transport.slice(0, 9)}-${Date.now()}`, result: any = { transport, label: transport + LABEL, machine: hostname(), fps: FPS, bitrate: BITRATE, scenario, run: index, key, warmup, startedAt: new Date().toISOString() };
    const cleanup: (() => unknown)[] = [];
    let udpStats: any, pubPage: any, source: ReturnType<typeof generator> | undefined, sinkBytes = 0;
    const t0 = Date.now();
    whipExtra = transport === "native-rtx2048" ? ["-rtp_history", "2048"] : [];
    cap60 = transport.endsWith("cap60");
    try {
        if (webrtc) {
            if (WIN) pubPage = ctx.sourcePage;
            else {
                pubPage = await ctx.pubBrowser.newPage(); cleanup.push(() => pubPage.close());
                await pubPage.exposeFunction("benchRequest", request);
                await pubPage.setContent("<!doctype html><html><body></body></html>");
                await pubPage.evaluate("globalThis.__name = fn => fn"); await pubPage.addScriptTag({ content: ctx.bundle });
                await pubPage.evaluate(startSource, ctx.png, FPS, false);
            }
            cleanup.push(() => pubPage.evaluate(() => (window as any).pub?.stop()));
            // Captura de aba numa sessão bloqueada sai a ~1 FPS: no Windows também publica o canvas (LivePublisher real, encoder do Edge).
            result.publish = await pubPage.evaluate(publishCanvas, key, UDP_SERVER, FPS, BITRATE, transport.startsWith("webrtc-screen") || !!process.env.BENCH_TAB, ctx.livekit, transport === "webrtc-screen-mf");
        } else {
            if (!WIN) {
                const fifo = join(TMP, `${key}.yuv`); execFileSync("mkfifo", [fifo]); cleanup.push(() => rmSync(fifo, { force: true }));
                Object.assign(process.env, { BENCH_FIFO: fifo, BENCH_SIZE: `${W}x${H}`, BENCH_FPS: String(FPS) });
                source = generator(fifo, ctx.raw); cleanup.push(() => source!.stop());
            }
            const udp = transport === "udp", srt = transport.startsWith("srt");
            // SRT: o mesmo encoder do plugin (MPEG-TS) repassado por um FFmpeg "-c copy" ao MediaMTX do Insider (porta 8890/udp).
            let sink: any = udp ? await udpSink(key, { resolution: H, fps: FPS }, BITRATE) : undefined;
            if (srt) {
                const relay = spawn(FFMPEG, ["-hide_banner", "-loglevel", "warning", "-probesize", "200000", "-analyzeduration", "500000", "-f", "mpegts", "-i", "pipe:0", "-c", "copy", "-f", "mpegts",
                    `srt://${process.env.BENCH_SRT_HOST ?? "192.168.1.129"}:8890?streamid=publish:${key}:liveapi:fockytv-internal&latency=${process.env.BENCH_SRT_LATENCY ?? "200000"}&pkt_size=1316`], { stdio: ["pipe", "ignore", "pipe"] });
                relay.stderr!.on("data", chunk => { result.srtLog = ((result.srtLog ?? "") + chunk).slice(-1500); });
                relay.stdin!.on("error", () => {});
                sink = { input: relay.stdin, stop: () => relay.kill(), quality: async () => {}, notify: async () => ({ status: 501, body: "", location: null }) };
            }
            cleanup.push(() => sink?.stop());
            // Saída do encoder no UDP = o que entra no sink (no Windows não há /proc para medir o processo).
            if (sink) { const write = sink.input.write.bind(sink.input); sink.input.write = ((chunk: Buffer, ...rest: any[]) => { sinkBytes += chunk.length; return write(chunk, ...rest); }) as any; }
            const log = join(LOGS, `${key}.log`);
            const capture = await startCapture({ source: process.env.BENCH_SOURCE ?? "monitor:0", fps: FPS, resolution: H, bitrate: BITRATE, audio: false, key, transport: udp ? "udp" : undefined,
                endpoint: udp ? `${UDP_SERVER}/api/udp/publish` : `${UDP_SERVER}/api/livekit/whip`}, WIN ? FFMPEG : WRAPPER, WIN ? HELPER() : "", request as any, log, undefined, sink);
            // Estado final da captura (erro do FFmpeg/muxer) e fim do log do muxer, antes de parar.
            cleanup.push(() => { result.capture = { ...capture.state }; try { result.muxerLog = readFileSync(log, "utf8").split("\n").filter(l => /error|fail|timeout|consent|closed|exit/i.test(l)).slice(-6); } catch { /* sem log */ } capture.stop(); });
            while (capture.state.state === "starting" && Date.now() - t0 < 30_000) await sleep(20);
            if (capture.state.state !== "live") throw new Error(capture.state.error ?? "Captura não conectou em 30 s.");
        }
        result.connectMs = Date.now() - t0;
        const page = await ctx.viewBrowser.newPage(); cleanup.push(() => page.close());
        page.on("pageerror", (error: Error) => { result.pageErrors = [...result.pageErrors ?? [], error.message].slice(-5); });
        await page.exposeFunction("benchRequest", request);
        const receivers: any[] = [];
        await page.exposeFunction("startUdpWatch", async (k: string, viewer: string) => { receivers.push(await udpReceiver(FFMPEG, k, viewer)); return String(receivers.length - 1); });
        await page.exposeFunction("readUdpWatch", (id: string) => { let r; try { r = receivers[Number(id)].read(); } catch (error: any) { result.udpError ??= error.message; throw error; } udpStats = { ...r.stats, generation: r.generation }; return { ...r, data: Buffer.from(r.data).toString("base64") }; });
        await page.exposeFunction("stopUdpWatch", (id: string) => receivers[Number(id)]?.close());
        cleanup.push(() => receivers.forEach(r => r.close()));
        await page.setContent("<!doctype html><html><body></body></html>");
        await page.evaluate("globalThis.__name = fn => fn"); await page.addScriptTag({ content: ctx.bundle });
        cleanup.push(() => page.evaluate(() => (window as any).bench?.close?.()));
        const viewStart = Date.now();
        await page.evaluate(watch, transport, key, UDP_SERVER, ctx.livekit);
        result.watchReadyMs = Date.now() - viewStart;
        const first = await (await page.waitForFunction(() => (window as any).bench.frames[0] ?? 0, { timeout: 20_000, polling: 20 })).jsonValue();
        result.firstFrameMs = first - t0; result.joinToFirstFrameMs = first - viewStart;
        // BENCH_SHOT: guarda um quadro recebido (confere o que a captura enxergou).
        if (process.env.BENCH_SHOT) await sleep(1500).then(() => page.evaluate(() => { const v = (window as any).bench.video, c = document.createElement("canvas"); c.width = v.videoWidth / 2; c.height = v.videoHeight / 2; c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height); return c.toDataURL("image/jpeg", 0.8); }))
            .then((url: string) => writeFileSync(join(LOGS, `${key}.jpg`), Buffer.from(url.split(",")[1], "base64")));
        // Rampa de banda do WebRTC (o publicador começa baixo e sobe pelo feedback do servidor): [s desde publicar, Mbps, largura, FPS, alvo kbps].
        if (pubPage) {
            result.ramp = [];
            let last: any, lastAt = 0;
            const timer = setInterval(() => void pubPage.evaluate(publisherStats).then((s: any) => {
                const now = Date.now();
                if (last) result.ramp.push([Math.round((now - t0) / 1000), +((s.bytes - last.bytes) * 8 / (now - lastAt) / 1e3).toFixed(2), s.width, s.fps, Math.round(s.target / 1e3)]);
                last = s; lastAt = now;
            }).catch(() => {}), 2000);
            cleanup.push(() => clearInterval(timer));
        }
        await sleep(warmup * 1000);
        const sample = async () => ({ cpu: cpu([ctx.pubBrowser.process().pid, ctx.viewBrowser.process().pid]), gen: source?.stats(), sinkBytes, udp: udpStats && { ...udpStats },
            viewer: transport === "udp" ? undefined : await page.evaluate(viewerStats), pub: pubPage ? await pubPage.evaluate(publisherStats) : undefined });
        const a = await sample(), from = Date.now();
        await sleep(SECONDS * 1000);
        const b = await sample(), to = Date.now();
        const bench = await page.evaluate(() => ({ frames: (window as any).bench.frames, mse: (window as any).bench.mse, ended: (window as any).bench.ended }));
        const seconds = (b.cpu.at - a.cpu.at) / 1000, share = (ticks: number) => ticks / seconds;
        const mbps = (bytes: number) => bytes * 8 / seconds / 1e6;
        result.viewer = analyze(bench.frames, from, to);
        if (bench.mse.length) { result.viewerMse = analyze(bench.mse, from, to); result.firstFrameMseMs = bench.mse[0] - t0; result.joinToFirstFrameMseMs = bench.mse[0] - viewStart; }
        if (bench.ended) result.viewerEndedAt = bench.ended - t0;
        if (!WIN) result.cpu = {
            publisher: share(webrtc ? b.cpu.browsers[0] - a.cpu.browsers[0] : b.cpu.encoder - a.cpu.encoder + b.cpu.muxer - a.cpu.muxer),
            viewer: share(b.cpu.browsers[1] - a.cpu.browsers[1] + b.cpu.receiver - a.cpu.receiver),
            node: (b.cpu.node.user + b.cpu.node.system - a.cpu.node.user - a.cpu.node.system) / 1e4 / seconds
        };
        result.publisher = webrtc ? { ...b.pub, mbps: mbps(b.pub.bytes - a.pub.bytes) }
            : WIN ? { mbps: transport === "udp" ? mbps(b.sinkBytes - a.sinkBytes) : NaN, captureFps: result.capture?.fps }
                : { mbps: mbps(b.cpu.wchar - a.cpu.wchar), sourceFrames: b.gen!.frames - a.gen!.frames, sourceSkipped: b.gen!.skipped - a.gen!.skipped };
        if (transport === "udp") {
            // Pacote = cabeçalho 26 + shard 1130 + tag GCM 16 (sem IP/UDP); conta só os que chegaram.
            result.udp = { ...b.udp, recovered: b.udp.recovered - a.udp.recovered, lostGroups: b.udp.lostGroups - a.udp.lostGroups, resets: b.udp.generation - a.udp.generation };
            result.wireMbps = mbps((b.udp.received - a.udp.received) * 1172);
        } else {
            const lost = b.viewer.packetsLost - a.viewer.packetsLost, received = b.viewer.packetsReceived - a.viewer.packetsReceived;
            result.webrtc = { ...b.viewer, packetsLost: lost, packetsReceived: received, lossPct: 100 * lost / Math.max(1, lost + received), nack: b.viewer.nack - a.viewer.nack,
                pli: b.viewer.pli - a.viewer.pli, framesDecoded: b.viewer.framesDecoded - a.viewer.framesDecoded, framesDropped: b.viewer.framesDropped - a.viewer.framesDropped, freezeCount: b.viewer.freezeCount - a.viewer.freezeCount, freezeSeconds: b.viewer.freezeSeconds - a.viewer.freezeSeconds };
            result.wireMbps = mbps(b.viewer.wireBytes - a.viewer.wireBytes);
        }
        result.overheadPct = 100 * (result.wireMbps / result.publisher.mbps - 1);
    } catch (error: any) { result.error = String(error?.message ?? error).slice(0, 300); }
    finally {
        for (const fn of cleanup.reverse()) await Promise.resolve().then(fn).catch(() => {});
        await sleep(2000);
    }
    const { g2g, ...viewer } = result.viewer ?? {}, { g2g: _, ...mse } = result.viewerMse ?? {};
    console.log(JSON.stringify({ ...result, viewer, viewerMse: mse }));
    return result;
}

// "udp-mse": as mesmas rodadas UDP medidas no <video> MSE interno, antes do captureStream().
const order = (runs: any[], field: string) => [...new Set(runs.map(r => r[field] as string))];
function summarize(runs: any[]) {
    runs = runs.map(r => ({ ...r, label: r.label ?? r.transport }));
    const rows = order(runs, "label").flatMap(t => t.startsWith("udp") ? [t, t.replace("udp", "udp-mse")] : [t]);
    return order(runs, "scenario").flatMap(scenario => rows.map(transport => {
        const mse = transport.startsWith("udp-mse"), all = runs.filter(r => r.scenario === scenario && r.label === transport.replace("udp-mse", "udp")), ok = all.filter(r => !r.error);
        const view = (r: any) => mse ? r.viewerMse ?? {} : r.viewer;
        const stat = (f: (r: any) => number) => {
            const v = ok.map(f).filter(x => Number.isFinite(x)).sort((a, b) => a - b);
            return v.length ? { median: pct(v, 50), p95: pct(v, 95) } : undefined;
        };
        const g2g = ok.flatMap(r => view(r).g2g ?? []).sort((a, b) => a - b);
        return { scenario, transport, runs: all.length, ok: ok.length, errors: all.filter(r => r.error).map(r => r.error),
            connectMs: stat(r => r.connectMs), firstFrameMs: stat(r => mse ? r.firstFrameMseMs : r.firstFrameMs), joinToFirstFrameMs: stat(r => mse ? r.joinToFirstFrameMseMs : r.joinToFirstFrameMs),
            g2gMs: g2g.length ? { median: pct(g2g, 50), p95: pct(g2g, 95) } : undefined, fps: stat(r => view(r).fps),
            stalls100: stat(r => view(r).stalls100), stalls500: stat(r => view(r).stalls500), maxGapMs: stat(r => view(r).maxGap),
            lostPct: stat(r => view(r).lostPct), dup: stat(r => view(r).dup), corrupt: stat(r => view(r).corrupt),
            wireMbps: stat(r => r.wireMbps), publisherMbps: stat(r => r.publisher.mbps), overheadPct: stat(r => r.overheadPct),
            cpuPublisher: stat(r => r.cpu?.publisher), cpuViewer: stat(r => r.cpu?.viewer), cpuNode: stat(r => r.cpu?.node),
            packetLossPct: stat(r => r.webrtc?.lossPct), nack: stat(r => r.webrtc?.nack), freezes: stat(r => r.webrtc?.freezeCount),
            udpRecovered: stat(r => r.udp?.recovered), udpLostGroups: stat(r => r.udp?.lostGroups), udpResets: stat(r => r.udp?.resets) };
    })).filter(row => row.runs);
}

function table(summary: any[]) {
    const scenarios = order(summary, "scenario");
    const f = (s: any, digits = 0) => s ? `${s.median.toFixed(digits)} / ${s.p95.toFixed(digits)}` : "—", m = (s: any, digits = 0) => s ? s.median.toFixed(digits) : "—";
    return scenarios.map(scenario => {
        const rows = summary.filter(s => s.scenario === scenario);
        return [`### ${scenario}${NETEM[scenario] ? ` (\`netem ${NETEM[scenario]}\`)` : ""}`, "", "Mediana / p95:", "",
            "| Transporte | OK | 1º quadro desde publicar (ms) | Entrada→1º quadro (ms) | Glass-to-glass (ms) | FPS entregue | Travadas >100 ms | Travadas >500 ms | Quadros perdidos (%) | Congelados (repetidos) |",
            "|---|---|---|---|---|---|---|---|---|---|",
            ...rows.map(s => `| ${s.transport} | ${s.ok}/${s.runs} | ${f(s.firstFrameMs)} | ${f(s.joinToFirstFrameMs)} | ${f(s.g2gMs)} | ${f(s.fps, 1)} | ${f(s.stalls100)} | ${f(s.stalls500)} | ${f(s.lostPct, 1)} | ${f(s.dup)} |`), "",
            "| Transporte | Fio no espectador (Mbps) | Saída do encoder (Mbps) | Overhead (%) | CPU publicador (% de 1 núcleo) | CPU espectador | Perda RTP (%) | NACKs | FEC recuperados | Grupos perdidos | Reinícios do remux |",
            "|---|---|---|---|---|---|---|---|---|---|---|",
            ...rows.filter(s => !s.transport.startsWith("udp-mse")).map(s => `| ${s.transport} | ${f(s.wireMbps, 2)} | ${f(s.publisherMbps, 2)} | ${f(s.overheadPct, 1)} | ${m(s.cpuPublisher)} | ${m(s.cpuViewer)} | ${f(s.packetLossPct, 2)} | ${f(s.nack)} | ${f(s.udpRecovered)} | ${f(s.udpLostGroups)} | ${f(s.udpResets)} |`), ""].join("\n");
    }).join("\n");
}

async function main() {
    const require = createRequire(resolve(process.env.VENCORD ?? "/home/focky/Vencord", "package.json"));
    const { build } = require("esbuild"), puppeteer = require("puppeteer-core");
    const bundle = (await build({ stdin: { contents: `export { LivePublisher } from "./session"; export { watchLive, loadLivekit } from "./viewer"; export { watchUdp } from "./udp-viewer";`, resolveDir: resolve("."), loader: "ts" },
        bundle: true, format: "iife", globalName: "Bench", write: false })).outputFiles[0].text;
    const frameArgs = ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=${W}x${H}`, "-frames:v", "1"];
    const raw = WIN ? undefined : execFileSync("ffmpeg", [...frameArgs, "-pix_fmt", "yuv420p", "-f", "rawvideo", "pipe:1"], { maxBuffer: 16 << 20 });
    const png = `data:image/png;base64,${execFileSync(FFMPEG, [...frameArgs, "-f", "image2", "-c:v", "png", "pipe:1"], { maxBuffer: 16 << 20 }).toString("base64")}`;
    const launch = (visible = false) => puppeteer.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: !visible, defaultViewport: visible ? null : undefined, ignoreDefaultArgs: visible ? ["--enable-automation"] : undefined,
        args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--disable-features=WebRtcHideLocalIpsWithMdns,CalculateNativeWinOcclusion", "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", ...visible ? ["--kiosk", "--auto-accept-this-tab-capture", "--use-fake-ui-for-media-stream", `--auto-select-desktop-capture-source=${process.env.BENCH_SCREEN ?? "Entire screen"}`] : []] });
    // No Windows a fonte é uma janela de verdade, em tela cheia, que a captura do plugin enxerga.
    const pubBrowser = await launch(WIN), viewBrowser = await launch();
    let sourcePage;
    if (WIN) {
        sourcePage = (await pubBrowser.pages())[0] ?? await pubBrowser.newPage();
        await sourcePage.exposeFunction("benchRequest", request);
        // file:// é contexto seguro (getDisplayMedia); o título acha a janela para a captura por HWND.
        const blank = join(LOGS, "source.html"); writeFileSync(blank, "<!doctype html><title>fockytv-bench-source</title><body></body>");
        await sourcePage.goto(pathToFileURL(blank).href);
        // Tela cheia de verdade (sem abas/barra): a captura de janela pega só a página.
        const cdp = await sourcePage.createCDPSession(), { windowId } = await cdp.send("Browser.getWindowForTarget");
        await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "fullscreen" } });
        await sleep(1500);
        await sourcePage.evaluate("globalThis.__name = fn => fn"); await sourcePage.addScriptTag({ content: bundle });
        // BENCH_SOURCE_FPS: a página pode girar mais rápido que a live (jogo a 60 FPS numa live de 30).
        await sourcePage.evaluate(startSource, png, Number(process.env.BENCH_SOURCE_FPS ?? FPS), true);
        await sleep(2000);
        // Sessão bloqueada mostra a tela de bloqueio no monitor: a captura de janela (WGC) continua recebendo a página.
        process.env.BENCH_SOURCE ??= `window:${execFileSync("powershell", ["-NoProfile", "-Command", "(Get-Process msedge | ? { $_.MainWindowTitle -like 'fockytv-bench-source*' } | Select -First 1).MainWindowHandle"], { encoding: "utf8" }).trim()}`;
        console.error("fonte:", process.env.BENCH_SOURCE);
    }
    const ctx = { bundle, raw, png, livekit: readFileSync(resolve("livekit-client.umd.js"), "utf8"), pubBrowser, viewBrowser, sourcePage };
    const meta = { date: new Date().toISOString(), server: UDP_SERVER, viewerIp: ME, chromium: await viewBrowser.version(), ffmpeg: execFileSync(FFMPEG, ["-version"], { encoding: "utf8" }).split("\n")[0],
        machine: hostname(), cpu: cpus()[0]?.model, source: WIN ? await sourcePage.evaluate(() => `janela ${innerWidth}x${innerHeight}@${devicePixelRatio}`) : `${W}x${H} sintético`, config: { width: W, height: H, fps: FPS, bitrateMbps: BITRATE, runs: RUNS, seconds: SECONDS, warmup: WARMUP }, netem: NETEM };
    const runs: any[] = process.argv.includes("--append") && existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")).runs : [];
    let impaired = false;
    const onSignal = () => { if (impaired) console.error(restore()); process.exit(130); };
    process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
    try {
        for (const scenario of scenarios) {
            if (NETEM[scenario] === undefined) throw new Error(`Cenário desconhecido: ${scenario}`);
            try {
                if (NETEM[scenario] && !NO_TC) { impaired = true; impair(NETEM[scenario]); console.error(`netem ${scenario}:`, ssh(`tc qdisc show dev ${IFACE}`).trim()); }
                // Intercala os transportes em cada rodada: a variação do Wi-Fi atinge todos por igual.
                for (let i = 1; i <= RUNS; i++) for (const transport of transports) {
                    runs.push(await run(transport, scenario, i, ctx));
                    writeFileSync(OUT, JSON.stringify({ meta, summary: summarize(runs), runs }, null, 1));
                }
            } finally { if (impaired) { console.error("restaurado:", restore().trim()); impaired = false; deadman = ""; } }
        }
    } finally { await pubBrowser.close(); await viewBrowser.close(); rmSync(TMP, { recursive: true, force: true }); }
    const summary = summarize(runs);
    writeFileSync(OUT, JSON.stringify({ meta, summary, runs }, null, 1));
    console.log(table(summary));
    if (!NO_TC) console.error("qdisc final:", ssh(`tc qdisc show dev ${IFACE}`).trim());
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
