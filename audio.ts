// SPDX-License-Identifier: GPL-3.0-or-later
interface NativeAudio {
    startAudio(sourceId: string): Promise<{ id: string; rate: number; channels: number; }>;
    readAudio(id: string): Promise<Uint8Array>;
    stopAudio(id: string): Promise<void>;
}

export async function captureAudio(native: NativeAudio, sourceId: string, onError: (error: unknown) => void) {
    // AudioData/TrackGenerator preservam o rate e os canais do capturador WASAPI.
    const Generator = window.MediaStreamTrackGenerator;
    const Frame = window.AudioData;
    if (!Generator || !Frame) throw new Error("Este Chromium não suporta captura de áudio PCM.");
    const track: MediaStreamTrack & { writable: WritableStream; } = new Generator({ kind: "audio" });
    let metadata: Awaited<ReturnType<NativeAudio["startAudio"]>>;
    try { metadata = await native.startAudio(sourceId); }
    catch (error) { track.stop(); throw error; }
    const { id, rate, channels } = metadata;
    const writer = track.writable.getWriter();
    let stopped = false, framesWritten = 0, received = 0, playing = false, startedAt = 0;
    const queue: Uint8Array[] = [];
    const lead = rate * 0.25, maxLag = rate * 0.6;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        track.stop();
        void writer.close().catch(() => {});
        void native.stopAudio(id).catch(error => console.warn("FockyTV: encerrar áudio", error));
    };
    const pump = async () => {
        try {
            while (!stopped) {
                const bytes = await native.readAudio(id);
                if (stopped) break;
                const frames = bytes.length / (channels * 4);
                if (frames) { queue.push(bytes); received += frames; }
                while (received - framesWritten > maxLag && queue.length > 1) {
                    framesWritten += queue.shift()!.length / (channels * 4);
                }
                if (!playing && received - framesWritten >= lead) {
                    playing = true;
                    startedAt = performance.now() - framesWritten / rate * 1000;
                }
                if (playing) {
                    const target = (performance.now() - startedAt) / 1000 * rate;
                    while (queue.length && framesWritten < target && !stopped) {
                        const bytes = queue.shift()!;
                        const frames = bytes.length / (channels * 4);
                        const frame = new Frame({ format: "f32", sampleRate: rate, numberOfFrames: frames, numberOfChannels: channels, timestamp: Math.round(framesWritten / rate * 1e6), data: Uint8Array.from(bytes) });
                        try { await writer.write(frame); }
                        finally { frame.close(); }
                        framesWritten += frames;
                    }
                    if (framesWritten < target) playing = false;
                }
                await new Promise(resolve => setTimeout(resolve, 20));
            }
        } catch (error) { if (!stopped) onError(error); stop(); }
    };
    void pump();
    return { track, stop };
}
