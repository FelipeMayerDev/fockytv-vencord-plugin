// SPDX-License-Identifier: GPL-3.0-or-later
// Modal do player de música da call: busca no YouTube à esquerda, o que está tocando e a fila à direita.
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, React, useEffect, useState } from "@webpack/common";

import { formatTime, musicPlayer, MusicTrack, SearchResult } from "./music";

type Player = ReturnType<typeof musicPlayer>;
export interface MusicContext { player: Player; me: string; volume: number; setVolume(value: number): void; }

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

// Re-renderiza a cada mudança do player e, tocando, a cada segundo (barra de progresso).
export function useMusic(player: Player) {
    const [, setVersion] = useState(0);
    const snapshot = player.snapshot();
    useEffect(() => player.subscribe(() => setVersion(value => value + 1)), [player]);
    const ticking = !!snapshot.state?.playing && !!snapshot.state.ready && !!snapshot.current;
    useEffect(() => {
        if (!ticking) return;
        const timer = setInterval(() => setVersion(value => value + 1), 1000);
        return () => clearInterval(timer);
    }, [ticking]);
    return snapshot;
}

function Thumb({ player, url }: { player: Player; url: string; }) {
    const [src, setSrc] = useState("");
    useEffect(() => {
        let alive = true;
        player.thumb(url).then(value => alive && setSrc(value), () => {});
        return () => { alive = false; };
    }, [url]);
    return <div className="fockytv-music-thumb" style={src ? { backgroundImage: `url(${src})` } : undefined} />;
}

function NowPlaying({ context }: { context: MusicContext; }) {
    const { player } = context;
    const { state, current, listening } = useMusic(player);
    const [volume, setVolume] = useState(context.volume);
    if (!current || !state) return <div className="fockytv-music-now fockytv-music-empty">Nada tocando. Busque uma música e adicione à fila.</div>;
    const position = Math.min(player.position(), current.duration);
    return <div className="fockytv-music-now">
        <Thumb player={player} url={current.thumb} />
        <div className="fockytv-music-now-info">
            <strong title={current.title}>{current.title}</strong>
            <span>{current.channel} · adicionada por {current.byName}</span>
            <div className="fockytv-music-progress" role="progressbar" aria-valuemin={0} aria-valuemax={current.duration} aria-valuenow={Math.round(position)}>
                <div style={{ width: `${position / current.duration * 100}%` }} />
            </div>
            <span className="fockytv-music-time">{state.ready ? `${formatTime(position)} / ${formatTime(current.duration)}` : "Baixando…"}</span>
            <div className="fockytv-music-controls">
                <button type="button" className="fockytv-music-control" onClick={() => player.command({ type: state.playing ? "pause" : "resume" })}>
                    {state.playing ? "Pausar" : "Continuar"}
                </button>
                <button type="button" className="fockytv-music-control" onClick={() => player.command({ type: "next" })}>Próxima</button>
                <label className="fockytv-music-volume">
                    Volume
                    <input type="range" min={0} max={100} value={Math.round(volume * 100)} disabled={!listening} onChange={event => {
                        const value = Number(event.currentTarget.value) / 100;
                        setVolume(value);
                        context.setVolume(value);
                    }} />
                </label>
            </div>
        </div>
    </div>;
}

export function Search({ player, onChoose }: { player: Player; onChoose?: (id: string) => void; }) {
    const [query, setQuery] = useState("");
    const [results, setResults] = useState<SearchResult[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [added, setAdded] = useState<string[]>([]);
    const search = async (event: React.FormEvent) => {
        event.preventDefault();
        if (query.trim().length < 2) return;
        setLoading(true);
        setError("");
        try { setResults(await player.search(query.trim())); }
        catch (cause: any) { setError(String(cause?.message ?? cause)); }
        finally { setLoading(false); }
    };
    return <section className="fockytv-music-search">
        <form onSubmit={search}>
            <input className="fockytv-music-input" type="search" placeholder="Buscar no YouTube" aria-label="Buscar no YouTube" value={query} onChange={event => setQuery(event.currentTarget.value)} />
            <button type="submit" className="fockytv-music-control fockytv-music-primary" disabled={loading}>{loading ? "Buscando…" : "Buscar"}</button>
        </form>
        {error && <p className="fockytv-music-error">{error}</p>}
        {results && !results.length && <p className="fockytv-music-hint">Nenhum resultado.</p>}
        <ul className="fockytv-music-list">
            {results?.map(result => <li key={result.id} className="fockytv-music-item">
                <Thumb player={player} url={result.thumb} />
                <div className="fockytv-music-item-info">
                    <strong title={result.title}>{result.title}</strong>
                    <span>{result.channel} · {formatTime(result.duration)}</span>
                </div>
                <button type="button" className="fockytv-music-control" onClick={() => { if (onChoose) onChoose(result.id); else { player.command({ type: "add", track: result }); setAdded(ids => [...ids, result.id]); } }}>
                    {onChoose ? "Assistir" : added.includes(result.id) ? "Adicionada" : "Adicionar"}
                </button>
            </li>)}
        </ul>
    </section>;
}

function Queue({ context }: { context: MusicContext; }) {
    const { player, me } = context;
    const { state } = useMusic(player);
    const queue = state?.queue ?? [];
    return <aside className="fockytv-music-queue">
        <h3>Fila <span>{queue.length}</span></h3>
        {!queue.length && <p className="fockytv-music-hint">A fila está vazia.</p>}
        <ol className="fockytv-music-list">
            {queue.map((track: MusicTrack, index) => <li key={track.uid} className={cx("fockytv-music-item", index === state!.index && "is-current", index < state!.index && "is-played")}>
                <button type="button" className="fockytv-music-item-play" title="Tocar agora" onClick={() => player.command({ type: "play", uid: track.uid })}>
                    <Thumb player={player} url={track.thumb} />
                    <div className="fockytv-music-item-info">
                        <strong title={track.title}>{track.title}</strong>
                        <span>{formatTime(track.duration)} · {track.byName}</span>
                    </div>
                </button>
                {track.by === me && <button type="button" className="fockytv-music-remove" aria-label={`Remover ${track.title}`} title="Remover da fila" onClick={() => player.command({ type: "remove", uid: track.uid })}>✕</button>}
            </li>)}
        </ol>
    </aside>;
}

export function MusicPanel({ context, ...props }: RenderModalProps & { context: MusicContext; }) {
    const { player } = context;
    const { channel, state, listening, error, connected } = useMusic(player);
    // Saiu da call: o player desliga e o modal fecha junto.
    useEffect(() => { if (!channel) props.onClose(); }, [channel]);
    const listeners = state?.listeners.length ? `Ouvindo: ${state.listeners.join(", ")}` : "Ninguém ouvindo";
    return <Modal {...props} title="Música da call" subtitle={connected ? listeners : "Conectando ao servidor…"} size="xl">
        <div className="fockytv-music">
            <div className="fockytv-music-main">
                <div className="fockytv-music-bar">
                    {error && <p className="fockytv-music-error">{error}</p>}
                    <button type="button" className={cx("fockytv-music-control", !listening && "fockytv-music-primary")} onClick={() => player.listen(!listening)}>
                        {listening ? "Sair da música" : "Entrar na música"}
                    </button>
                </div>
                <NowPlaying context={context} />
                <Search player={player} />
            </div>
            <Queue context={context} />
        </div>
    </Modal>;
}
