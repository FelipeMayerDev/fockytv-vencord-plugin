// SPDX-License-Identifier: GPL-3.0-or-later
import type { musicPlayer } from "./music";

export interface Lyrics { lines: { t: number; text: string; }[]; plain: string[]; }

export function readLyrics(body: unknown): Lyrics {
    const data = body as { lines?: unknown; plainLyrics?: unknown; } | null;
    const rows = Array.isArray(data?.lines) ? data.lines : [];
    const lines = rows.filter(row => row && typeof row.text === "string" && typeof row.t === "number" && Number.isFinite(row.t) && row.t >= 0)
        .map(({ t, text }) => ({ t, text })).sort((a, b) => a.t - b.t);
    const plain = typeof data?.plainLyrics === "string" ? data.plainLyrics.split("\n")
        : rows.flatMap(row => typeof row === "string" ? [row] : row && typeof row.text === "string" ? [row.text] : []);
    return { lines, plain: plain.filter(line => line.trim()) };
}

export function lyricIndex(lines: Lyrics["lines"], position: number) {
    return lines.findLastIndex(line => line.t <= position);
}

// O stream só é entregue ao preview local: nunca entra nas sessões de publicação.
export function lyricsCanvas(player: Pick<ReturnType<typeof musicPlayer>, "snapshot" | "playbackPosition" | "subscribe">,
    load: (id: string) => Promise<unknown>, show: (media: MediaStream | null, channel?: string) => void) {
    let active: { uid: string; channel: string; media: MediaStream; lyrics: Lyrics; loading: boolean; retry?: ReturnType<typeof setTimeout>; } | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let canvas: HTMLCanvasElement;
    let context: CanvasRenderingContext2D;

    function clear() {
        clearInterval(timer);
        timer = undefined;
        if (!active) return;
        const old = active;
        active = undefined;
        clearTimeout(old.retry);
        show(null, old.channel);
        old.media.getTracks().forEach(track => track.stop());
    }

    function update() {
        const { listening, current, channel, state } = player.snapshot();
        const position = player.playbackPosition();
        if (!listening || !current || !channel || (state?.ready && position >= current.duration)) return clear();
        if (active?.uid !== current.uid || active.channel !== channel) {
            clear();
            canvas = document.createElement("canvas");
            canvas.width = 1280;
            canvas.height = 720;
            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            context = ctx;
            const entry: NonNullable<typeof active> = { uid: current.uid, channel, media: canvas.captureStream(5), lyrics: { lines: [], plain: [] }, loading: true };
            active = entry;
            show(entry.media, channel);
            timer = setInterval(update, 200);
            const fetch = (attempt: number) => void load(current.id).then(body => {
                if (active !== entry) return;
                entry.lyrics = readLyrics(body);
                entry.loading = false;
                update();
            }, () => {
                if (active !== entry) return;
                // O LRCLIB vive sobrecarregado (503): tenta de novo antes de mostrar "Sem letra".
                if (attempt < 3) entry.retry = setTimeout(() => fetch(attempt + 1), 5000 * (attempt + 1));
                else { entry.loading = false; update(); }
            });
            fetch(0);
        }
        const { lyrics, loading } = active;
        context.fillStyle = "#151722";
        context.fillRect(0, 0, 1280, 720);
        context.textAlign = "center";
        context.font = "bold 32px sans-serif";
        context.fillStyle = "#ffffff";
        context.fillText(current.title, 640, 64, 1160);
        context.font = "22px sans-serif";
        context.fillStyle = "#b8bbca";
        context.fillText(`Letra · só você${!state?.ready ? " · Baixando…" : !state.playing ? " · Pausada" : ""}${!lyrics.lines.length && lyrics.plain.length ? " · sem sincronização" : ""}`, 640, 108, 1160);
        if (!lyrics.lines.length && !lyrics.plain.length) {
            context.font = "36px sans-serif";
            context.fillText(loading ? "Buscando letra…" : "Sem letra", 640, 380);
            return;
        }
        const index = lyricIndex(lyrics.lines, position);
        const first = lyrics.lines.length ? Math.max(0, index - 2)
            : Math.floor(Math.max(0, lyrics.plain.length - 7) * Math.min(1, Math.max(0, position / current.duration)));
        const texts = lyrics.lines.length ? lyrics.lines.map(line => line.text) : lyrics.plain;
        texts.slice(first, first + 7).forEach((text, offset) => {
            const highlighted = !!lyrics.lines.length && first + offset === index;
            context.font = `${highlighted ? "bold 42" : "30"}px sans-serif`;
            context.fillStyle = highlighted ? "#82efb1" : "#b8bbca";
            context.fillText(text, 640, 200 + offset * 70, 1160);
        });
    }

    const unsubscribe = player.subscribe(update);
    update();
    return () => { unsubscribe(); clear(); };
}
