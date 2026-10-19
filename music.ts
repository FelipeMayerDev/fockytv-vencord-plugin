// SPDX-License-Identifier: GPL-3.0-or-later
// Player de música da call: um WebSocket por canal de voz com a fila e o relógio do servidor,
// e um <audio> local que segue a posição de lá. Entrar no player só liga o som aqui.
import type { proxySocket } from "./viewer";

export interface MusicTrack { uid: string; id: string; title: string; channel: string; duration: number; thumb: string; by: string; byName: string; }
export interface MusicState { queue: MusicTrack[]; index: number; playing: boolean; ready: boolean; position: number; listeners: string[]; }
export interface SearchResult { id: string; title: string; channel: string; duration: number; thumb: string; }
export type MusicCommand =
    | { type: "add"; track: SearchResult; }
    | { type: "remove" | "play"; uid: string; }
    | { type: "pause" | "resume" | "next"; };

type Fetch = (url: string) => Promise<{ status: number; type: string; body: Uint8Array; }>;
type Socket = ReturnType<typeof proxySocket>;
interface Options { base(): string; fetch: Fetch; Socket: Socket; }

// Pular de posição corta o som; diferenças pequenas com o relógio do servidor (o <audio> demora a começar,
// a placa de som anda num relógio próprio) se corrigem acelerando ou freando até 3%, sem mudar o tom.
const SEEK = 2;
export function catchUpRate(drift: number) {
    if (Math.abs(drift) > SEEK) return null;
    if (Math.abs(drift) < 0.05) return 1;
    return 1 + Math.max(-0.03, Math.min(0.03, drift / 10));
}

// Seis faixas do espectro (0–1), do grave ao agudo, cada uma com o dobro de largura da anterior.
export const bands = (bins: ArrayLike<number>) => [1, 2, 4, 8, 16, 32].map(start => {
    let sum = 0;
    for (let i = start; i < start * 2; i++) sum += bins[i] ?? 0;
    return sum / start / 255;
});

export const formatTime = (seconds: number) => {
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = String(total % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};

export function musicPlayer({ base, fetch, Socket }: Options) {
    let socket: InstanceType<Socket> | undefined;
    let channel: string | undefined;
    let user: { id: string; name: string; } | undefined;
    let state: MusicState | null = null;
    let receivedAt = 0;
    let listening = false;
    let error = "";
    let volume = 1, output = 1;
    let loaded: { uid: string; url: string; } | undefined;
    let ticker: ReturnType<typeof setInterval> | undefined;
    const audio = new Audio();
    // O som passa pelo Web Audio para o espectro do painel ler as frequências; o volume fica no ganho.
    let graph: { context: AudioContext; analyser: AnalyserNode; gain: GainNode; } | undefined;
    const level = () => Math.min(1, Math.max(0, volume * output));
    function connectGraph() {
        if (graph) return graph;
        const context = new AudioContext();
        const analyser = context.createAnalyser();
        const gain = context.createGain();
        analyser.fftSize = 256;
        gain.gain.value = level();
        context.createMediaElementSource(audio).connect(analyser);
        analyser.connect(gain).connect(context.destination);
        return graph = { context, analyser, gain };
    }
    // Diagnóstico das travadas: o <audio> tocando um blob em memória só para esperando dados se algo estiver errado.
    for (const type of ["waiting", "stalled"]) audio.addEventListener(type, () => console.warn(`FockyTV: música ${type} em ${audio.currentTime.toFixed(2)} s`));
    const subscribers = new Set<() => void>();
    const thumbs = new Map<string, Promise<string>>();
    const notify = () => subscribers.forEach(fn => fn());

    const current = () => state?.queue[state.index];
    const position = () => state ? state.position + (state.playing && state.ready ? (performance.now() - receivedAt) / 1000 : 0) : 0;
    const send = (message: object) => { if (socket?.readyState === 1) socket.send(JSON.stringify(message)); };

    function unload() {
        audio.pause();
        audio.removeAttribute("src");
        if (loaded) URL.revokeObjectURL(loaded.url);
        loaded = undefined;
    }

    // Uma sincronização por vez: a próxima roda com o estado mais novo.
    let syncing = Promise.resolve();
    const sync = () => {
        syncing = syncing.then(apply).catch(cause => {
            console.error("FockyTV: música", cause);
            error = String(cause?.message ?? cause);
            notify();
        });
    };
    async function apply() {
        const track = current();
        if (!listening || !track) return unload();
        if (!state!.ready) return audio.pause();
        if (loaded?.uid !== track.uid) {
            unload();
            const response = await fetch(`${base()}/api/fixed/radio/${channel}/${track.uid}`);
            if (response.status !== 200) throw new Error(`Não deu para baixar a faixa (${response.status}).`);
            if (!listening || current()?.uid !== track.uid) return;
            loaded = { uid: track.uid, url: URL.createObjectURL(new Blob([response.body as Uint8Array<ArrayBuffer>], { type: response.type })) };
            audio.src = loaded.url;
        }
        if (!state!.playing) return audio.pause();
        const drift = position() - audio.currentTime;
        const rate = audio.paused ? null : catchUpRate(drift);
        if (rate === null) {
            if (!audio.paused) console.info(`FockyTV: música ressincronizada (${drift.toFixed(2)} s)`);
            audio.currentTime = position();
            audio.playbackRate = 1;
        } else audio.playbackRate = rate;
        if (audio.paused) {
            void connectGraph().context.resume().catch(() => {});
            await audio.play();
        }
    }

    function open() {
        const url = new URL(`${base().replace(/^http/, "ws")}/api/fixed/ws/radio`);
        url.search = new URLSearchParams({ room: channel!, user: user!.id, name: user!.name }).toString();
        const ws = new Socket(url.href);
        const since = performance.now();
        socket = ws;
        // A Cloudflare derruba WebSocket parado por ~100 s; o servidor ignora o ping.
        const heartbeat = setInterval(() => { if (ws.readyState === 1) ws.send('{"type":"ping"}'); }, 30_000);
        ws.onopen = () => { if (listening) send({ type: "listen", on: true }); };
        ws.onmessage = event => {
            if (socket !== ws) return;
            const message = JSON.parse(event.data);
            if (message.type === "state") { state = message; receivedAt = performance.now(); sync(); }
            else if (message.type === "error") error = message.message;
            notify();
        };
        ws.onclose = event => {
            clearInterval(heartbeat);
            if (socket !== ws) return;
            console.warn(`FockyTV: conexão da música caiu após ${((performance.now() - since) / 1000).toFixed(0)} s, código ${event.code}${event.reason ? ` (${event.reason})` : ""}`);
            socket = undefined;
            notify();
            // A música segue no último estado até reconectar; o estado novo corrige a posição.
            // ponytail: reconexão fixa em 3 s, sem backoff
            const room = channel;
            setTimeout(() => { if (!socket && channel === room && room) open(); }, 3000);
        };
    }

    function setListening(on: boolean) {
        listening = on;
        error = "";
        clearInterval(ticker);
        if (on) ticker = setInterval(sync, 1000);
        send({ type: "listen", on });
        sync();
        notify();
    }

    return {
        // Canal de voz atual (ou nenhum): troca a sala e para o som da anterior.
        connect(channelId?: string, me?: { id: string; name: string; }) {
            if (channelId === channel) return;
            const old = socket;
            socket = undefined;
            old?.close();
            channel = channelId;
            user = me;
            state = null;
            error = "";
            if (listening) setListening(false);
            if (channel && user) open();
            notify();
        },
        snapshot: () => ({ channel, state, current: current(), listening, error, connected: !!socket && !!state }),
        position,
        subscribe(fn: () => void) { subscribers.add(fn); return () => { subscribers.delete(fn); }; },
        listen: setListening,
        command(message: MusicCommand) { error = ""; send(message); notify(); },
        // Volume do player (0–1) e a saída do Discord (volume geral, ensurdecer).
        setVolume(value: number, outputValue = output) {
            volume = value;
            output = outputValue;
            if (graph) graph.gain.gain.value = level();
        },
        spectrum() {
            if (!graph) return null;
            const bins = new Uint8Array(graph.analyser.frequencyBinCount);
            graph.analyser.getByteFrequencyData(bins);
            return bands(bins);
        },
        async search(query: string): Promise<SearchResult[]> {
            const response = await fetch(`${base()}/api/fixed/search?${new URLSearchParams({ q: query, limit: "10" })}`);
            const body = JSON.parse(new TextDecoder().decode(response.body));
            if (response.status !== 200) throw new Error(body?.error ?? `Servidor respondeu ${response.status}.`);
            return body;
        },
        // Capas pelo proxy do servidor: o CSP do Discord não carrega imagens do YouTube.
        thumb(url: string) {
            let entry = thumbs.get(url);
            if (!entry) {
                if (thumbs.size > 200) { thumbs.forEach(value => void value.then(URL.revokeObjectURL, () => {})); thumbs.clear(); }
                entry = fetch(`${base()}/api/fixed/img?${new URLSearchParams({ url })}`).then(response => {
                    if (response.status !== 200) throw new Error(String(response.status));
                    return URL.createObjectURL(new Blob([response.body as Uint8Array<ArrayBuffer>], { type: response.type }));
                });
                entry.catch(() => thumbs.delete(url));
                thumbs.set(url, entry);
            }
            return entry;
        }
    };
}
