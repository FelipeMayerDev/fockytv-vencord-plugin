// SPDX-License-Identifier: GPL-3.0-or-later
// Captura nativa no Windows: Windows Graphics Capture → NVENC no FFmpeg, publicando por WHIP.
// Os quadros ficam na GPU do início ao fim; o Chromium não toca no vídeo.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

const FFMPEG_ZIP = "https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip";
const FFMPEG_SHA256 = "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba";
const FFMPEG_ENTRY = "ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe";

type Request = (url: string, method: "POST" | "DELETE", key: string, body?: string) => Promise<{ status: number; body: string; location: string | null; }>;
export interface CaptureOptions { source: string; fps: number; resolution: number; bitrate: number; audio: boolean; key: string; endpoint: string; }
export interface CaptureState { state: "starting" | "live" | "ended"; error?: string; fps?: number; }

let download: Promise<string> | undefined;
// Baixa uma vez (~110 MB) para a pasta privada do cliente; o hash fixa exatamente a build validada.
const binary = (directory: string) => join(directory, `ffmpeg-${FFMPEG_SHA256.slice(0, 16)}.exe`);
export const ffmpegReady = (directory: string) => existsSync(binary(directory));
export function ffmpegPath(directory: string) {
    const path = binary(directory);
    if (existsSync(path)) return Promise.resolve(path);
    return download ??= (async () => {
        mkdirSync(directory, { recursive: true });
        const zip = join(directory, "ffmpeg.zip"), extracted = join(directory, "ffmpeg-extract");
        try {
            const response = await fetch(FFMPEG_ZIP, { signal: AbortSignal.timeout(600_000) });
            if (!response.ok) throw new Error(`Download do FFmpeg falhou (${response.status}).`);
            const bytes = Buffer.from(await response.arrayBuffer());
            if (createHash("sha256").update(bytes).digest("hex") !== FFMPEG_SHA256) throw new Error("FFmpeg baixado com hash inválido.");
            await writeFile(zip, bytes);
            rmSync(extracted, { recursive: true, force: true });
            mkdirSync(extracted);
            await run("tar.exe", ["-xf", zip, "-C", extracted, FFMPEG_ENTRY]);
            renameSync(join(extracted, FFMPEG_ENTRY), path);
            return path;
        } finally {
            download = undefined;
            rmSync(zip, { force: true });
            rmSync(extracted, { recursive: true, force: true });
        }
    })();
}

function run(file: string, args: string[]) {
    return new Promise<void>((resolve, reject) => {
        const child = spawn(file, args, { windowsHide: true, stdio: "ignore" });
        child.on("error", reject);
        child.on("exit", code => code === 0 ? resolve() : reject(new Error(`${file} encerrou (${code}).`)));
    });
}

// O FFmpeg usa só o primeiro candidato ICE. Com o servidor na mesma rede, o IP público
// costuma falhar (sem hairpin NAT): candidatos da sub-rede local vão para a frente.
export function preferLocalCandidates(sdp: string, addresses = Object.values(networkInterfaces()).flat()) {
    const toInt = (ip: string) => ip.split(".").reduce((value, part) => (value << 8) + Number(part), 0) >>> 0;
    const local = addresses.filter(address => address && address.family === "IPv4" && !address.internal);
    const near = (line: string) => {
        const ip = line.split(" ")[4];
        return /^\d+\.\d+\.\d+\.\d+$/.test(ip) && local.some(address => ((toInt(ip) ^ toInt(address!.address)) & toInt(address!.netmask)) === 0);
    };
    return sdp.replace(/(?:a=candidate:[^\r\n]*\r?\n)+/g, block => {
        const lines = block.match(/[^\n]*\n/g)!;
        return [...lines.filter(near), ...lines.filter(line => !near(line))].join("");
    });
}

// ponytail: sem limite de resolução — scale_d3d11 não aceita os quadros do gfxcapture e o redimensionamento
// do próprio gfxcapture põe tarjas; limitar exige saber o tamanho da fonte antes de abrir a captura.
// size fixa o tamanho de saída: um jogo minimizado (ao clicar no Discord) daria 160x28, que o NVENC recusa.
export function videoInput({ source, fps }: CaptureOptions, size?: { width: number; height: number; }) {
    const [kind, id] = source.split(":");
    const target = kind === "window" ? `hwnd=${id}` : kind === "hmonitor" ? `hmonitor=${id}` : `monitor_idx=${id}`;
    return `gfxcapture=${target}:max_framerate=${fps}${size ? `:width=${size.width}:height=${size.height}:resize_mode=scale_aspect` : ""}`;
}

// Captura + codificação. Sai em MPEG-TS para o muxer; trocar fonte/FPS reinicia só este processo.
export function encoderArgs(options: CaptureOptions, offset: number, size?: { width: number; height: number; }) {
    return [
        "-hide_banner", "-nostats", "-loglevel", "info",
        // Sempre com áudio (silêncio se desligado): o muxer não aceita mudar o conjunto de faixas no meio da live.
        ...(options.audio ? ["-probesize", "32", "-analyzeduration", "0", "-thread_queue_size", "512", "-f", "f32le", "-ar", "48000", "-ac", "2", "-i", "pipe:0"] : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]),
        "-f", "lavfi", "-i", videoInput(options, size),
        "-map", "1:v", "-map", "0:a",
        // CBR baixa latência, sem B-frames, keyframe a cada ~0,5 s. Sem simulcast: o LiveKit pausa o vídeo de quem
        // não tem banda para o bitrate inteiro, e cada espectador custa esse bitrate no upload do servidor.
        // Baseline como o encoder do Chromium: o WebRTC do Discord não decodifica todo perfil High que o navegador aceita.
        "-c:v", "h264_nvenc", "-profile:v", "baseline", "-preset", "p4", "-tune", "ull", "-rc", "cbr", "-b:v", `${options.bitrate}M`, "-maxrate", `${options.bitrate}M`, "-bufsize", "333k",
        "-bf", "0", "-g", String(Math.max(1, Math.round(options.fps / 2))), "-fps_mode:v", "passthrough", "-enc_time_base:v", "1:1000000",
        "-c:a", "libopus", "-application", "lowdelay", "-b:a", "128k", "-af", "aresample=async=1:first_pts=0",
        // Continua o relógio do processo anterior: o muxer vê uma única sequência de timestamps.
        "-output_ts_offset", offset.toFixed(3), "-muxdelay", "0", "-muxpreload", "0", "-flush_packets", "1", "-f", "mpegts", "pipe:1"
    ];
}

// Preview local e miniatura: decodifica só os keyframes da mesma saída, em outro processo. Copiar quadros da GPU
// dentro do encoder travava o envio e causava perda de pacotes para quem assiste.
export function stillArgs(still: string) {
    return [
        "-hide_banner", "-loglevel", "error", "-y", "-skip_frame", "nokey", "-f", "mpegts", "-i", "pipe:0", "-map", "0:v",
        "-vf", "fps=1,scale=640:-2", "-q:v", "5", "-update", "1", "-atomic_writing", "1", "-f", "image2", still
    ];
}

// Mantém a sessão WebRTC entre reinícios do encoder; termina sozinho se o plugin morrer (fim da entrada).
export function muxerArgs(key: string, url: string) {
    return [
        "-hide_banner", "-nostdin", "-loglevel", "verbose", "-stats_period", "1", "-progress", "pipe:1",
        "-probesize", "200000", "-analyzeduration", "500000", "-f", "mpegts", "-i", "pipe:0", "-map", "0:v", "-map", "0:a", "-c", "copy",
        // Keyframes a 20 Mbps estouram o buffer UDP padrão do muxer.
        "-ts_buffer_size", String(8 << 20), "-authorization", key, "-f", "whip", url
    ];
}

const report = (file: string) => `file=${file.replace(/\\/g, "/").replace(/:/g, "\\:")}:level=40`;

export async function startCapture(options: CaptureOptions, ffmpeg: string, audioHelper: string, request: Request, logFile: string, still?: string) {
    const state: CaptureState = { state: "starting" };
    let session: string | undefined, stopping = false, stderr = "";
    // WHIP local: o plugin conversa com o servidor (mesma validação e DELETE ao fechar o cliente).
    const proxy = createServer((req, res) => {
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", async () => {
            try {
                if (req.method === "POST") {
                    const answer = await request(options.endpoint, "POST", options.key, body);
                    if (answer.status === 201 && answer.location) session = new URL(answer.location, options.endpoint).href;
                    // Content-Length explícito: o cliente HTTP do FFmpeg não lê a resposta em chunks.
                    const sdp = answer.status === 201 ? preferLocalCandidates(answer.body) : answer.body;
                    res.writeHead(answer.status, { "Content-Type": "application/sdp", "Content-Length": Buffer.byteLength(sdp), ...(answer.status === 201 ? { Location: "/session" } : {}) });
                    res.end(sdp);
                    if (answer.status !== 201) state.error = `FockyTV (${answer.status}): ${answer.body.slice(0, 300)}`;
                } else if (req.method === "DELETE" && session) {
                    const url = session;
                    session = undefined;
                    res.writeHead((await request(url, "DELETE", options.key)).status, { "Content-Length": 0 }).end();
                } else res.writeHead(404, { "Content-Length": 0 }).end();
            } catch (error) { state.error ??= String(error); res.writeHead(502, { "Content-Length": 0 }).end(); }
        });
    });
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/whip`;

    const muxer = spawn(ffmpeg, muxerArgs(options.key, url), {
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        // Log completo da última transmissão, para investigar falhas.
        env: { ...process.env, FFREPORT: report(logFile) }
    });
    muxer.stdin!.on("error", () => {});
    let frames = 0, lastFrames = 0;
    muxer.stdout!.on("data", chunk => {
        const frame = /frame=(\d+)/.exec(chunk.toString())?.[1];
        if (frame) frames = Number(frame);
    });
    muxer.stderr!.on("data", chunk => {
        stderr = (stderr + chunk).slice(-4000);
        // O muxer só escreve pacotes depois de ICE + DTLS: a primeira saída marca a live conectada.
        if (state.state === "starting" && /WHIP muxer.*SRTP setup done/.test(stderr)) {
            state.state = "live";
            announce();
        }
    });
    const fpsTimer = setInterval(() => { state.fps = frames - lastFrames; lastFrames = frames; }, 1000);
    // Selo de qualidade para quem assiste; sem redimensionar, a resolução é a da fonte.
    const announce = () => { if (session) void request(`${session}/quality`, "POST", options.key, JSON.stringify({ resolution: 0, fps: options.fps })).catch(() => {}); };

    const stills = still ? spawn(ffmpeg, stillArgs(still), { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] }) : undefined;
    stills?.stdin!.on("error", () => {});
    stills?.on("error", () => {});

    const started = performance.now();
    let current: ReturnType<typeof encode> | undefined;
    // Último tamanho real da fonte atual; reinícios na mesma fonte mantêm a resolução transmitida.
    let size: { source: string; width: number; height: number; } | undefined;
    function encode(settings: CaptureOptions) {
        const keep = size?.source === settings.source ? size : undefined;
        const encoder = spawn(ffmpeg, encoderArgs(settings, (performance.now() - started) / 1000, keep), {
            windowsHide: true, stdio: [settings.audio ? "pipe" : "ignore", "pipe", "pipe"],
            env: { ...process.env, FFREPORT: report(logFile.replace(/\.log$/, "-encoder.log")) }
        });
        let errors = "", replaced = false;
        encoder.stderr!.on("data", chunk => {
            errors = (errors + chunk).slice(-2000);
            for (const [, width, height] of chunk.toString().matchAll(/(?:Video: wrapped_avframe.*?|Capture size changed to )(\d{2,5})x(\d{2,5})/g))
                if (!keep && Number(width) >= 320 && Number(height) >= 180) size = { source: settings.source, width: Number(width), height: Number(height) };
        });
        encoder.stdout!.pipe(muxer.stdin!, { end: false });
        // Sem esperar o preview: se ele atrasar, perde pedaços (e se ressincroniza), nunca segura a live.
        encoder.stdout!.on("data", chunk => { if (stills && !stills.stdin!.writableNeedDrain) stills.stdin!.write(chunk); });
        const helper = settings.audio ? spawn(audioHelper, settings.source.startsWith("window:")
            ? ["--hwnd", settings.source.split(":")[1]]
            : ["--mix-except", "Discord,DiscordCanary,DiscordPTB,Vesktop,Vencord,Equibop,FockyTV"], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }) : undefined;
        const fail = (message: string) => { if (!replaced && !stopping) { state.error ??= message; stop(); } };

        // Áudio WASAPI em tempo real: silêncio preenche lacunas para o FFmpeg não esperar pelo processo.
        let pump: NodeJS.Timeout | undefined;
        if (helper && encoder.stdin) {
            const stdin = encoder.stdin;
            stdin.on("error", () => {});
            let header = Buffer.alloc(0), queue = Buffer.alloc(0), ready = false, emitted = 0, startedAt = 0;
            const second = 48000 * 2 * 4;
            helper.stdout!.on("data", (chunk: Buffer) => {
                if (!ready) {
                    header = Buffer.concat([header, chunk]);
                    if (header.length < 16) return;
                    if (header.subarray(0, 4).toString() !== "FPCM" || header.readUInt32LE(4) !== 48000 || header.readUInt32LE(8) !== 2)
                        return fail("Capturador de áudio com formato incompatível.");
                    ready = true; startedAt = performance.now(); chunk = header.subarray(16);
                }
                queue = Buffer.concat([queue, chunk]);
                if (queue.length > second / 5) queue = queue.subarray(queue.length - second / 5);
            });
            helper.on("exit", code => fail(`Capturador de áudio encerrou (${code}).`));
            pump = setInterval(() => {
                if (!ready || stdin.destroyed || stdin.writableNeedDrain) return;
                const due = Math.floor((performance.now() - startedAt) * 48) * 8 - emitted;
                const bytes = Math.min(second / 5, Math.max(0, due));
                if (!bytes) return;
                const out = Buffer.alloc(bytes);
                queue.copy(out, 0, 0, Math.min(bytes, queue.length));
                queue = queue.subarray(Math.min(bytes, queue.length));
                emitted += bytes;
                stdin.write(out);
            }, 10);
        }
        encoder.on("error", error => fail(error.message));
        encoder.on("exit", code => {
            clearInterval(pump);
            helper?.kill();
            // Fonte fechada (ex.: o jogo) também encerra a live.
            fail(code ? `FFmpeg encerrou (${code}): ${errors.trim().split(/\r?\n/).slice(-3).join(" | ")}` : "A fonte da captura foi encerrada.");
        });
        return {
            // Fecha a saída em vez de matar: o FFmpeg encerra sozinho ao não conseguir escrever, liberando NVENC e WGC.
            end() {
                replaced = true;
                helper?.kill();
                encoder.stdout!.unpipe(muxer.stdin!);
                encoder.stdout!.destroy();
                setTimeout(() => { if (encoder.exitCode === null) encoder.kill(); }, 3000);
            }
        };
    }
    current = encode(options);

    muxer.on("error", error => { state.error ??= error.message; stop(); });
    muxer.on("exit", code => {
        if (!stopping && code !== 0) state.error ??= `FFmpeg encerrou (${code}): ${stderr.split(/\r?\n/).filter(line => /error|fail|invalid|cannot|could not/i.test(line)).slice(-3).join(" | ") || stderr.slice(-300)}`;
        state.state = "ended";
        clearInterval(fpsTimer);
        stop();
        proxy.close();
        if (session) void request(session, "DELETE", options.key).catch(() => {});
        session = undefined;
    });

    function stop() {
        if (stopping) return;
        stopping = true;
        current?.end();
        stills?.kill();
        // Fim da entrada: o muxer termina e envia DELETE; o proxy repete se o FFmpeg não chegar a enviar.
        muxer.stdin!.end();
        setTimeout(() => { if (muxer.exitCode === null) muxer.kill(); }, 3000);
    }

    // Troca fonte/FPS sem derrubar a sessão WebRTC de quem assiste.
    function restart(changes: Partial<Pick<CaptureOptions, "source" | "fps" | "bitrate">>) {
        if (stopping) throw new Error("Transmissão encerrada.");
        options = { ...options, ...changes };
        current?.end();
        current = encode(options);
        announce();
    }
    return { state, stop, restart };
}
