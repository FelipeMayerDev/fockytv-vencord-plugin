// SPDX-License-Identifier: GPL-3.0-or-later
import type { Viewing } from "./viewer";

interface UdpNative {
    startUdpWatch(key: string, viewer: string): Promise<string>;
    readUdpWatch(id: string): Promise<{ data: Uint8Array; generation: number; stats: { received: number; recovered: number; lostGroups: number; rejected: number; }; }>;
    stopUdpWatch(id: string): Promise<void>;
}

export async function watchUdp(native: UdpNative, key: string, viewer: string, onEnded: () => void, signal: AbortSignal): Promise<Viewing> {
    signal.throwIfAborted();
    const source = new MediaSource(), video = document.createElement("video") as HTMLVideoElement & { captureStream(): MediaStream; };
    if (typeof video.captureStream !== "function") throw new Error("Este cliente não suporta reprodução UDP.");
    const url = URL.createObjectURL(source);
    video.src = url; video.muted = true; video.autoplay = true;
    const lifetime = new AbortController();
    let rejectReady: ((error: unknown) => void) | undefined;
    let id: string | undefined, closed = false, connected = false, buffer: SourceBuffer | undefined, media: MediaStream | undefined;
    const close = () => {
        if (closed) return;
        closed = true; lifetime.abort(); rejectReady?.(new Error("Reprodução UDP encerrada.")); signal.removeEventListener("abort", close);
        video.pause(); video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url);
        media?.getTracks().forEach(track => track.stop());
        if (id) void native.stopUdpWatch(id).catch(() => {});
    };
    signal.addEventListener("abort", close, { once: true });
    const update = (action: () => void) => new Promise<void>((resolve, reject) => {
        const done = () => { cleanup(); resolve(); };
        const fail = () => { cleanup(); reject(new Error("O decoder rejeitou a transmissão UDP.")); };
        const cleanup = () => { buffer!.removeEventListener("updateend", done); buffer!.removeEventListener("error", fail); buffer!.removeEventListener("abort", fail); lifetime.signal.removeEventListener("abort", fail); };
        buffer!.addEventListener("updateend", done, { once: true }); buffer!.addEventListener("error", fail, { once: true }); buffer!.addEventListener("abort", fail, { once: true }); lifetime.signal.addEventListener("abort", fail, { once: true });
        try { action(); } catch (error) { cleanup(); reject(new Error(video.error?.message || String(error))); }
    });
    let resolveReady: () => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const opened = new Promise<void>((resolve, reject) => {
        source.addEventListener("sourceopen", () => resolve(), { once: true });
        lifetime.signal.addEventListener("abort", () => reject(new Error("Reprodução cancelada.")), { once: true });
    });
    void opened.catch(() => {});
    const timeout = setTimeout(() => { rejectReady?.(new Error("A transmissão UDP não enviou vídeo decodificável em 15 s.")); close(); }, 15_000);
    // O catch é instalado antes do handshake nativo, que também pode falhar.
    void ready.catch(() => {});
    try {
        id = await native.startUdpWatch(key, viewer);
        if (closed) { await native.stopUdpWatch(id); throw new Error("Reprodução cancelada."); }
        const failed = (error: unknown) => { if (!closed) { rejectReady?.(error); close(); if (connected) onEnded(); } };
        const pump = async () => {
            let initial: Uint8Array[] = [], initialBytes = 0, generation: number | undefined, playbackStarted = false, playing = false;
            while (!closed) {
                const result = await native.readUdpWatch(id!);
                if (closed) return;
                if (generation !== undefined && generation !== result.generation) {
                    initial = []; initialBytes = 0;
                    if (buffer) {
                        buffer.abort();
                        buffer.timestampOffset = video.buffered.length ? video.buffered.end(video.buffered.length - 1) : video.currentTime;
                    }
                }
                generation = result.generation;
                let bytes = result.data;
                if (bytes.length) {
                    if (!buffer) {
                        initial.push(bytes); initialBytes += bytes.length;
                        if (initialBytes > 4 << 20) throw new Error("Cabeçalho de vídeo UDP inválido.");
                        const joined = new Uint8Array(initialBytes); let offset = 0;
                        initial.forEach(part => { joined.set(part, offset); offset += part.length; });
                        // avcC contém profile/compatibility/level reais; não presume nível de H.264 para 4K.
                        let avc = -1;
                        for (let i = 4; i + 8 < joined.length; i++)
                            if (joined[i] === 97 && joined[i + 1] === 118 && joined[i + 2] === 99 && joined[i + 3] === 67) { avc = i; break; }
                        if (avc < 0) { await new Promise(resolve => setTimeout(resolve, 10)); continue; }
                        const codec = [...joined.subarray(avc + 5, avc + 8)].map(value => value.toString(16).padStart(2, "0")).join("");
                        const mime = `video/mp4; codecs="avc1.${codec},opus"`;
                        if (!MediaSource.isTypeSupported(mime)) throw new Error("Este Chromium não suporta H.264/Opus em MP4 para o transporte UDP.");
                        await opened;
                        if (closed) return;
                        buffer = source.addSourceBuffer(mime); bytes = joined; initial = [];
                    }
                    await update(() => buffer!.appendBuffer(Uint8Array.from(bytes).buffer));
                    if (!playbackStarted) { playbackStarted = true; void video.play().then(() => { playing = true; }).catch(failed); }
                    if (video.buffered.length) {
                        const end = video.buffered.end(video.buffered.length - 1), lag = end - video.currentTime;
                        if (connected && video.readyState >= 2 && !video.seeking && lag > 0.4) video.currentTime = Math.max(video.buffered.start(video.buffered.length - 1), end - 0.15);
                        if (video.currentTime > 3 && video.buffered.start(0) < video.currentTime - 3)
                            await update(() => buffer!.remove(0, video.currentTime - 2));
                    }
                }
                if (playing && video.readyState >= 2) {
                    media ??= video.captureStream();
                    if (media.getVideoTracks().length) resolveReady();
                }
                if (video.error) throw new Error(`Falha ao reproduzir UDP (${video.error.code}).`);
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        };
        void pump().catch(failed);
        await ready; clearTimeout(timeout);
        if (closed) throw new Error("Reprodução cancelada.");
        connected = true;
        return { media: media!, close, async getStats() { return new Map() as RTCStatsReport; } };
    } catch (error) { clearTimeout(timeout); close(); throw error; }
}
