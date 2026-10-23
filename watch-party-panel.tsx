// SPDX-License-Identifier: GPL-3.0-or-later
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, React, useEffect, useRef, useState } from "@webpack/common";

import { formatTime, musicPlayer } from "./music";
import { Search } from "./music-panel";
import { watchParty, youtubeId } from "./watch-party";

export function useWatch(player: ReturnType<typeof watchParty>, ticking = false) {
    const [, render] = useState(0);
    useEffect(() => {
        const unsubscribe = player.subscribe(() => render(value => value + 1));
        const timer = ticking ? setInterval(() => render(value => value + 1), 1000) : undefined;
        return () => { unsubscribe(); clearInterval(timer); };
    }, [player, ticking]);
    return player.snapshot();
}

// Play/pausa e posição valem para todos na call; a barra só envia ao soltar para não inundar a sala.
export function WatchControls({ player, setVolume }: { player: ReturnType<typeof watchParty>; setVolume(value: number): void; }) {
    const { state, connected, title, loading, error, volume } = useWatch(player, true);
    const [seek, setSeek] = useState<number>();
    const unmutedVolume = useRef(volume || 0.5);
    useEffect(() => { if (volume > 0) unmutedVolume.current = volume; }, [volume]);
    const duration = player.duration();
    const position = Math.min(duration, seek ?? player.position());
    const commit = () => { if (seek !== undefined && state) player.control(state.playing, seek); setSeek(undefined); };
    const stop = (event: React.SyntheticEvent) => event.stopPropagation();
    return <div className="fockytv-watch-controls" onClick={stop} onDoubleClick={stop} onMouseDown={stop} onPointerDown={stop}>
        <div>
            <span className="fockytv-watch-status" role={error ? "alert" : undefined}>{error || (loading ? `Baixando… ${title}` : title)}</span>
            <button type="button" className="fockytv-player-button" onClick={() => player.listen(false)}>Sair da watch party</button>
        </div>
        <div>
            <button type="button" className="fockytv-player-button" disabled={!connected || !state} onClick={() => player.control(!state!.playing)}>{state?.playing ? "Pausar" : "Play"}</button>
            <input type="range" aria-label="Posição do vídeo para todos" min={0} max={duration} step={0.1} disabled={!connected || !duration || !state}
                value={position} onChange={event => setSeek(Number(event.currentTarget.value))} onPointerUp={commit} onKeyUp={commit} />
            <span className="fockytv-watch-time">{formatTime(position)} / {formatTime(duration)}</span>
            <div className="fockytv-watch-volume">
                <button type="button" className="fockytv-player-button" aria-label={volume > 0 ? "Silenciar vídeo" : "Ativar som do vídeo"} aria-pressed={volume === 0}
                    onClick={() => setVolume(volume > 0 ? 0 : unmutedVolume.current)}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4Z" />
                        {volume > 0 ? <path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" /> : <path d="m16 9 6 6m0-6-6 6" />}
                    </svg>
                </button>
                <div className="fockytv-watch-volume-slider">
                    <input type="range" aria-label="Volume do vídeo" min={0} max={100} value={Math.round(volume * 100)}
                        onChange={event => setVolume(Number(event.currentTarget.value) / 100)} />
                </div>
            </div>
            <button type="button" className="fockytv-player-button" disabled={!connected || !state?.queue || state.queue.length < 2} onClick={() => player.next()}>Próximo</button>
        </div>
    </div>;
}

export function WatchPartyPanel({ player, music, ...props }: RenderModalProps & {
    player: ReturnType<typeof watchParty>; music: ReturnType<typeof musicPlayer>;
}) {
    const [link, setLink] = useState("");
    const { channel, state, connected, title, watching } = useWatch(player);
    useEffect(() => { if (!channel) props.onClose(); }, [channel]);
    const add = (id: string, title?: string) => { player.listen(true); player.add(id, title); };
    return <Modal {...props} title="Watch party do YouTube" subtitle={connected ? "Adicione vídeos à playlist da call; a sincronização é automática" : "Conectando ao servidor…"} size="md">
        <div className="fockytv-watch">
            <div className="fockytv-music-bar">
                <button type="button" className={`fockytv-music-control${!watching ? " fockytv-music-primary" : ""}`} onClick={() => player.listen(!watching)}>
                    {watching ? "Sair da watch party" : "Entrar na watch party"}
                </button>
            </div>
            <form onSubmit={event => { event.preventDefault(); const id = youtubeId(link); if (id) { add(id); setLink(""); } }}>
                <input className="fockytv-music-input" aria-label="Link do YouTube ou ID do vídeo" placeholder="Cole um link do YouTube" value={link} onChange={event => setLink(event.currentTarget.value)} />
                <button type="submit" className="fockytv-music-control fockytv-music-primary" disabled={!connected || !youtubeId(link) || (state?.queue?.length ?? 0) >= 100}>Adicionar à playlist</button>
            </form>
            {connected && (state?.queue?.length ?? 0) < 100 && <Search player={music} onChoose={add} />}
            {(state?.queue?.length ?? 0) >= 100 && <p className="fockytv-music-hint">A playlist está cheia (100 vídeos).</p>}
            <section className="fockytv-music-queue" aria-label="Playlist da watch party">
                <h3>Playlist <span>{state?.queue?.length ?? 0}</span></h3>
                {!state?.queue?.length && <p className="fockytv-music-hint">A playlist está vazia. Adicione um vídeo para começar.</p>}
                <ol className="fockytv-music-list">
                    {state?.queue?.map((track, index) => <li key={track.uid} className={`fockytv-music-item${index === 0 ? " is-current" : ""}`}>
                        <span className="fockytv-watch-index" aria-hidden="true">{index + 1}</span>
                        <div className="fockytv-music-item-info">
                            <strong title={index === 0 ? title || track.title : track.title}>{index === 0 ? title || track.title : track.title}</strong>
                            {index === 0 && <span>Vídeo atual</span>}
                        </div>
                    </li>)}
                </ol>
            </section>
        </div>
    </Modal>;
}
