// SPDX-License-Identifier: GPL-3.0-or-later
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, React, useEffect, useRef, useState } from "@webpack/common";

import { formatTime, musicPlayer } from "./music";
import { Search } from "./music-panel";
import { watchParty, youtubeId } from "./watch-party";

export function WatchPartyPanel({ player, music, volume, setVolume, ...props }: RenderModalProps & {
    player: ReturnType<typeof watchParty>; music: ReturnType<typeof musicPlayer>; volume: number; setVolume(value: number): void;
}) {
    const [, render] = useState(0);
    const [link, setLink] = useState("");
    const [localVolume, setLocalVolume] = useState(volume);
    const video = useRef<HTMLVideoElement>(null);
    const { channel, state, connected, title, error, loading } = player.snapshot();
    useEffect(() => {
        const unsubscribe = player.subscribe(() => render(value => value + 1));
        const timer = setInterval(() => render(value => value + 1), 1000);
        player.attach(video.current!);
        return () => { unsubscribe(); clearInterval(timer); player.attach(); };
    }, [player]);
    const openedChannel = useRef(channel);
    useEffect(() => { if (!channel || channel !== openedChannel.current) props.onClose(); }, [channel]);
    const duration = Number.isFinite(video.current?.duration) ? video.current!.duration : 0;
    return <Modal {...props} title="Watch party do YouTube" subtitle={connected ? "Todos na call podem controlar o vídeo" : "Conectando ao servidor…"} size="xl">
        <div className="fockytv-watch">
            <video ref={video} playsInline aria-label={title || "Vídeo da watch party"} />
            <strong>{loading ? `Carregando vídeo… ${title}` : title || "Escolha um vídeo para assistir com a call"}</strong>
            {error && <p className="fockytv-music-error" role="alert">{error}</p>}
            <div className="fockytv-music-controls">
                <button type="button" className="fockytv-music-control" disabled={!connected || !state} onClick={() => player.control(!state!.playing)}>{state?.playing ? "Pausar" : "Continuar"}</button>
                <button type="button" className="fockytv-music-control" disabled={!state || loading} onClick={() => player.retry()}>Sincronizar</button>
                <label className="fockytv-music-volume">Volume <input type="range" min={0} max={100} value={Math.round(localVolume * 100)} onChange={event => {
                    const value = Number(event.currentTarget.value) / 100; setLocalVolume(value); setVolume(value);
                }} /></label>
            </div>
            <label>Posição {formatTime(player.position())} / {formatTime(duration)}
                <input aria-label="Posição do vídeo para todos" type="range" min={0} max={duration} step={0.1} disabled={!connected || !duration || !state} value={Math.min(duration, player.position())} onChange={event => player.control(state!.playing, Number(event.currentTarget.value))} />
            </label>
            <form onSubmit={event => { event.preventDefault(); const id = youtubeId(link); if (id) player.load(id); }}>
                <input className="fockytv-music-input" aria-label="Link do YouTube ou ID do vídeo" placeholder="Cole um link do YouTube" value={link} onChange={event => setLink(event.currentTarget.value)} />
                <button type="submit" className="fockytv-music-control" disabled={!connected || !youtubeId(link)}>Assistir</button>
            </form>
            <Search player={music} onChoose={id => player.load(id)} />
        </div>
    </Modal>;
}
