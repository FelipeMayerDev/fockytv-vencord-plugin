// SPDX-License-Identifier: GPL-3.0-or-later
import { catchUpRate } from "./music";
import type { musicPlayer } from "./music";

export interface WatchState { type: "yt"; action: "state"; videoId: string; playing: boolean; pos: number; }
export function watchPosition(state: WatchState | null, elapsed: number) {
    return state ? state.pos + (state.playing ? Math.max(0, elapsed) / 1000 : 0) : 0;
}
export function youtubeId(text: string) {
    if (/^[\w-]{11}$/.test(text.trim())) return text.trim();
    try {
        const url = new URL(text);
        if (!["https:", "http:"].includes(url.protocol)) return null;
        if (url.hostname === "youtu.be") return /^[\w-]{11}$/.test(url.pathname.slice(1)) ? url.pathname.slice(1) : null;
        if (!["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)) return null;
        const id = url.searchParams.get("v") ?? url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})\/?$/)?.[1];
        return id && /^[\w-]{11}$/.test(id) ? id : null;
    } catch { return null; }
}

export function watchParty({ base, fetch, Socket }: Parameters<typeof musicPlayer>[0]) {
    let channel: string | undefined, user: { id: string; name: string; } | undefined;
    let socket: InstanceType<typeof Socket> | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined, heartbeat: ReturnType<typeof setInterval> | undefined;
    let ticker: ReturnType<typeof setInterval> | undefined;
    let state: WatchState | null = null, receivedAt = 0, connected = false;
    let media: HTMLVideoElement | undefined, blob = "", requested = "", title = "", error = "", loading = false, generation = 0;
    let volume = 0.5, output = 1;
    const subscribers = new Set<() => void>();
    const notify = () => subscribers.forEach(fn => fn());
    const position = () => watchPosition(state, performance.now() - receivedAt);
    const send = (message: object) => { if (connected && socket?.readyState === 1) socket.send(JSON.stringify(message)); };
    function unload() {
        generation++;
        requested = "";
        loading = false;
        media?.pause();
        media?.removeAttribute("src");
        media?.load();
        if (blob) URL.revokeObjectURL(blob);
        blob = "";
    }
    function sync() {
        if (!media || !blob || !state || media.readyState < 1) return;
        const target = Math.min(position(), Number.isFinite(media.duration) ? media.duration : Infinity);
        const rate = catchUpRate(target - media.currentTime);
        if (rate === null || (!state.playing && Math.abs(target - media.currentTime) > 0.05)) media.currentTime = target;
        media.playbackRate = rate ?? 1;
        if (!connected || !state.playing) media.pause();
        else if (media.paused && !media.ended) void media.play().catch(cause => { error = `Clique em Sincronizar: ${cause.message}`; notify(); });
    }
    async function load() {
        if (!media || !state || requested === state.videoId) return;
        unload();
        requested = state.videoId;
        const token = generation, id = requested;
        loading = true;
        error = "";
        notify();
        try {
            const metaResponse = await fetch(`${base()}/api/fixed/jam/yt?${new URLSearchParams({ id, video: "1" })}`);
            const meta = JSON.parse(new TextDecoder().decode(metaResponse.body));
            if (metaResponse.status !== 200) throw new Error(meta.error ?? `Servidor respondeu ${metaResponse.status}.`);
            if (token !== generation) return;
            title = meta.title;
            notify();
            const response = await fetch(`${base()}/api/fixed/jam/yt/stream?${new URLSearchParams({ u: meta.url, ...(meta.audioUrl ? { a: meta.audioUrl } : {}) })}`);
            if (token !== generation || !media) return;
            if (response.status !== 200) throw new Error(`Não deu para baixar o vídeo (${response.status}).`);
            blob = URL.createObjectURL(new Blob([response.body as Uint8Array<ArrayBuffer>], { type: response.type }));
            media.src = blob;
            media.load();
        } catch (cause: any) {
            if (token === generation) { error = String(cause?.message ?? cause); requested = ""; }
        } finally {
            if (token === generation) { loading = false; notify(); }
        }
    }
    function open() {
        const url = new URL(`${base().replace(/^http/, "ws")}/api/fixed/ws/jam`);
        url.search = new URLSearchParams({ room: `watch:${channel}`, nick: user!.id, watch: "1" }).toString();
        const ws = socket = new Socket(url.href);
        ws.onopen = () => {
            if (socket !== ws) return;
            connected = true;
            heartbeat = setInterval(() => send({ type: "ping" }), 25_000);
            notify();
        };
        ws.onmessage = event => {
            if (socket !== ws) return;
            let message;
            try { message = JSON.parse(String(event.data)); } catch { return; }
            if (message?.type !== "yt" || message.action !== "state" || typeof message.videoId !== "string" || !/^[\w-]{11}$/.test(message.videoId) ||
                typeof message.playing !== "boolean" || !Number.isFinite(message.pos) || message.pos < 0) return;
            state = message;
            receivedAt = performance.now();
            if (requested !== message.videoId) { title = ""; void load(); }
            sync();
            notify();
        };
        ws.onerror = () => ws.close();
        ws.onclose = () => {
            if (socket !== ws) return;
            clearInterval(heartbeat);
            connected = false;
            socket = undefined;
            state = null;
            title = "";
            unload();
            notify();
            reconnect = setTimeout(open, 3000);
        };
    }
    return {
        connect(channelId?: string, me?: { id: string; name: string; }) {
            if (channel === channelId && user?.id === me?.id) return;
            clearTimeout(reconnect);
            clearInterval(heartbeat);
            const old = socket;
            socket = undefined;
            old?.close();
            unload();
            state = null;
            connected = false;
            title = error = "";
            channel = channelId;
            user = me;
            if (channel && user) open();
            notify();
        },
        attach(video?: HTMLVideoElement) {
            clearInterval(ticker);
            if (media) { media.onloadedmetadata = media.onerror = null; }
            unload();
            media = video;
            if (media) {
                media.volume = Math.min(1, volume * output);
                media.preservesPitch = false;
                media.onloadedmetadata = sync;
                media.onerror = () => { error = "Não deu para reproduzir o vídeo. Tente Sincronizar."; notify(); };
                ticker = setInterval(sync, 1000);
                void load();
            }
        },
        snapshot: () => ({ channel, state, connected, title, error, loading }),
        subscribe(fn: () => void) { subscribers.add(fn); return () => { subscribers.delete(fn); }; },
        position,
        load(id: string) { if (/^[\w-]{11}$/.test(id)) send({ type: "yt", action: "load", videoId: id }); },
        control(playing: boolean, pos = position()) {
            if (state) send({ type: "yt", action: "state", videoId: state.videoId, playing, pos });
        },
        retry() { if (media?.error) unload(); if (!blob) void load(); else { error = ""; sync(); notify(); } },
        setVolume(value: number, outputValue = output) {
            volume = Math.min(1, Math.max(0, value)); output = Math.min(1, Math.max(0, outputValue));
            if (media) media.volume = volume * output;
        }
    };
}
