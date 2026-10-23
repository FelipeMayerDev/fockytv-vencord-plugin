// SPDX-License-Identifier: GPL-3.0-or-later
export function streamAudio(media: MediaStream) {
    const audio = new Audio();
    audio.muted = true;
    const context = new AudioContext();
    const gain = context.createGain();
    let source: MediaStreamAudioSourceNode | undefined;
    const syncTracks = () => {
        source?.disconnect();
        source = undefined;
        if (media.getAudioTracks().length) {
            // MediaElementAudioSource recebe silêncio para áudio WebRTC no Chromium.
            source = context.createMediaStreamSource(media);
            source.connect(gain);
        }
    };
    media.addEventListener("addtrack", syncTracks);
    media.addEventListener("removetrack", syncTracks);
    syncTracks();
    gain.connect(context.destination);
    audio.srcObject = media;
    gain.gain.value = 0;
    void audio.play().catch(() => {});
    void context.resume().catch(() => {});
    return {
        update(volume: number, output: number, muted: boolean) {
            const value = volume / 100 * output / 100;
            gain.gain.value = muted || !Number.isFinite(value) ? 0 : Math.max(0, value);
        },
        // O que o AudioContext soma depois do WebRTC, em ms (o lip sync desconta do vídeo).
        latencyMs: () => ((context.baseLatency || 0) + (context.outputLatency || 0)) * 1000,
        close() {
            audio.pause();
            audio.srcObject = null;
            media.removeEventListener("addtrack", syncTracks);
            media.removeEventListener("removetrack", syncTracks);
            source?.disconnect();
            gain.disconnect();
            void context.close().catch(() => {});
        }
    };
}
