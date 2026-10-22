// SPDX-License-Identifier: GPL-3.0-or-later
import { catchUpRate } from "./music";
import type { musicPlayer } from "./music";

export interface WatchTrack { uid: string; id: string; title: string; }
export interface WatchState { uid?: string; queue?: WatchTrack[]; type: "yt"; action: "state"; videoId: string; playing: boolean; pos: number; }
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
    let volume = 0.5, output = 1, watching = false;
    let viewers: string[] = [];
    let retryAt = 0;
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
        if (!watching || !media || !state) return;
        if (!blob) { if (!loading && performance.now() >= retryAt) void load(); return; }
        if (media.readyState < 1) return;
        const target = Math.min(position(), Number.isFinite(media.duration) ? media.duration : Infinity);
        const rate = catchUpRate(target - media.currentTime);
        if (rate === null || (!state.playing && Math.abs(target - media.currentTime) > 0.05)) media.currentTime = target;
        media.playbackRate = rate ?? 1;
        if (!connected || !state.playing) media.pause();
        else if (media.paused && !media.ended) void media.play().then(() => { if (error) { error = ""; notify(); } }).catch(cause => { error = `Não deu para iniciar o vídeo: ${cause.message}`; notify(); });
    }
    async function load() {
        if (!watching || !media || !state || requested === state.videoId) return;
        unload();
        requested = state.videoId;
        const token = generation, id = requested;
        loading = true;
        error = "";
        notify();
        try {
            // O título é só rótulo: não atrasa nem derruba o download.
            void fetch(`${base()}/api/fixed/jam/yt?${new URLSearchParams({ id })}`).then(response => {
                if (token !== generation || response.status !== 200) return;
                title = JSON.parse(new TextDecoder().decode(response.body)).title;
                notify();
            }).catch(() => {});
            const response = await fetch(`${base()}/api/fixed/jam/yt/video?${new URLSearchParams({ id })}`);
            if (token !== generation || !media) return;
            if (response.status !== 200) {
                let reason = `HTTP ${response.status}`;
                try { reason = JSON.parse(new TextDecoder().decode(response.body)).error ?? reason; } catch { }
                throw new Error(`Não deu para baixar o vídeo: ${reason}`);
            }
            blob = URL.createObjectURL(new Blob([response.body as Uint8Array<ArrayBuffer>], { type: response.type }));
            media.src = blob;
            media.load();
        } catch (cause: any) {
            if (token === generation) { error = String(cause?.message ?? cause); requested = ""; retryAt = performance.now() + 5000; }
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
            send({ type: "yt", action: "listen", on: watching });
            notify();
        };
        ws.onmessage = event => {
            if (socket !== ws) return;
            let message;
            try { message = JSON.parse(String(event.data)); } catch { return; }
            if (message?.type === "yt" && message.action === "members") {
                if (Array.isArray(message.viewers) && message.viewers.every((id: unknown) => typeof id === "string" && /^\d{5,25}$/.test(id))) {
                    viewers = message.viewers;
                    notify();
                }
                return;
            }
            if (message?.type !== "yt" || message.action !== "state" || typeof message.videoId !== "string" || !/^[\w-]{11}$/.test(message.videoId) ||
                typeof message.playing !== "boolean" || !Number.isFinite(message.pos) || message.pos < 0) return;
            if (message.uid !== undefined && typeof message.uid !== "string") return;
            if (message.queue !== undefined && (!Array.isArray(message.queue) || message.queue.length > 100 || message.queue.some((track: any) =>
                !track || typeof track.uid !== "string" || typeof track.id !== "string" || !/^[\w-]{11}$/.test(track.id) || typeof track.title !== "string"))) return;
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
            viewers = [];
            socket = undefined;
            state = null;
            title = "";
            unload();
            notify();
            reconnect = setTimeout(open, 3000);
        };
    }
    function next() { if (state?.uid) send({ type: "yt", action: "next", uid: state.uid }); }
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
            watching = false;
            viewers = [];
            retryAt = 0;
            connected = false;
            title = error = "";
            channel = channelId;
            user = me;
            if (channel && user) open();
            notify();
        },
        attach(video?: HTMLVideoElement) {
            clearInterval(ticker);
            if (media) { media.onloadedmetadata = media.onerror = media.onended = null; }
            unload();
            media = video;
            if (media) {
                media.volume = Math.min(1, volume * output);
                media.preservesPitch = false;
                media.onloadedmetadata = () => { error = ""; sync(); notify(); };
                media.onended = () => { if (watching && state?.playing) next(); };
                media.onerror = () => { unload(); retryAt = performance.now() + 5000; error = "Não deu para reproduzir o vídeo. Tentando novamente…"; notify(); };
                ticker = setInterval(sync, 1000);
                void load();
            }
        },
        snapshot: () => ({ channel, state, connected, title, error, loading, watching, viewers, volume }),
        subscribe(fn: () => void) { subscribers.add(fn); return () => { subscribers.delete(fn); }; },
        position,
        duration: () => Number.isFinite(media?.duration) ? media!.duration : 0,
        load(id: string) { if (/^[\w-]{11}$/.test(id)) send({ type: "yt", action: "load", videoId: id }); },
        control(playing: boolean, pos = position()) {
            if (state) send({ type: "yt", action: "state", videoId: state.videoId, playing, pos });
        },
        listen(on: boolean) {
            watching = on;
            send({ type: "yt", action: "listen", on });
            if (on) { retryAt = 0; void load(); sync(); } else unload();
            notify();
        },
        add(id: string, label = id) {
            if (/^[\w-]{11}$/.test(id)) send({ type: "yt", action: "add", videoId: id, title: label });
        },
        next,
        setVolume(value: number, outputValue = output) {
            volume = Math.min(1, Math.max(0, value)); output = Math.min(1, Math.max(0, outputValue));
            if (media) media.volume = volume * output;
            notify();
        }
    };
}
