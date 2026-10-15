// SPDX-License-Identifier: GPL-3.0-or-later
export function streamAudio(media: MediaStream) {
    const audio = new Audio();
    const context = new AudioContext();
    const source = context.createMediaElementSource(audio);
    const gain = context.createGain();
    source.connect(gain);
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
        close() {
            audio.pause();
            audio.srcObject = null;
            source.disconnect();
            gain.disconnect();
            void context.close().catch(() => {});
        }
    };
}
