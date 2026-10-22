// SPDX-License-Identifier: GPL-3.0-or-later
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, React, useEffect, useState } from "@webpack/common";

import { formatTime, musicPlayer } from "./music";
import { Search } from "./music-panel";
import { watchParty, youtubeId } from "./watch-party";

function useWatch(player: ReturnType<typeof watchParty>) {
    const [, render] = useState(0);
    useEffect(() => {
        const unsubscribe = player.subscribe(() => render(value => value + 1));
        const timer = setInterval(() => render(value => value + 1), 1000);
        return () => { unsubscribe(); clearInterval(timer); };
    }, [player]);
    return player.snapshot();
}

// Play/pausa e posição valem para todos na call; a barra só envia ao soltar para não inundar a sala.
export function WatchControls({ player }: { player: ReturnType<typeof watchParty>; }) {
    const { state, connected, title, loading, error } = useWatch(player);
    const [seek, setSeek] = useState<number>();
    const duration = player.duration();
    const position = Math.min(duration, seek ?? player.position());
    const commit = () => { if (seek !== undefined && state) player.control(state.playing, seek); setSeek(undefined); };
    const stop = (event: React.SyntheticEvent) => event.stopPropagation();
    return <div className="fockytv-watch-controls" onClick={stop} onDoubleClick={stop} onMouseDown={stop} onPointerDown={stop}>
        <span className="fockytv-watch-status" role={error ? "alert" : undefined}>{error || (loading ? `Baixando… ${title}` : title)}</span>
        <div>
            <button type="button" className="fockytv-player-button" disabled={!connected || !state} onClick={() => player.control(!state!.playing)}>{state?.playing ? "Pausar" : "Play"}</button>
            <input type="range" aria-label="Posição do vídeo para todos" min={0} max={duration} step={0.1} disabled={!connected || !duration || !state}
                value={position} onChange={event => setSeek(Number(event.currentTarget.value))} onPointerUp={commit} onKeyUp={commit} />
            <span>{formatTime(position)} / {formatTime(duration)}</span>
        </div>
    </div>;
}

export function WatchPartyPanel({ player, music, volume, setVolume, ...props }: RenderModalProps & {
    player: ReturnType<typeof watchParty>; music: ReturnType<typeof musicPlayer>; volume: number; setVolume(value: number): void;
}) {
    const [link, setLink] = useState("");
    const [localVolume, setLocalVolume] = useState(volume);
    const { channel, state, connected, loading } = useWatch(player);
    useEffect(() => { if (!channel) props.onClose(); }, [channel]);
    return <Modal {...props} title="Watch party do YouTube" subtitle={connected ? "O vídeo aparece na grade da call; todos podem controlar" : "Conectando ao servidor…"} size="md">
        <div className="fockytv-watch">
            <WatchControls player={player} />
            <div className="fockytv-music-controls">
                <button type="button" className="fockytv-music-control" disabled={!state || loading} onClick={() => player.retry()}>Sincronizar</button>
                <label className="fockytv-music-volume">Volume <input type="range" min={0} max={100} value={Math.round(localVolume * 100)} onChange={event => {
                    const value = Number(event.currentTarget.value) / 100; setLocalVolume(value); setVolume(value);
                }} /></label>
            </div>
            <form onSubmit={event => { event.preventDefault(); const id = youtubeId(link); if (id) player.load(id); }}>
                <input className="fockytv-music-input" aria-label="Link do YouTube ou ID do vídeo" placeholder="Cole um link do YouTube" value={link} onChange={event => setLink(event.currentTarget.value)} />
                <button type="submit" className="fockytv-music-control" disabled={!connected || !youtubeId(link)}>Assistir</button>
            </form>
            <Search player={music} onChoose={id => player.load(id)} />
        </div>
    </Modal>;
}
