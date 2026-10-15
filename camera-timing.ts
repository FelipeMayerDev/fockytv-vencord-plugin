// SPDX-License-Identifier: GPL-3.0-or-later
export function retimeCamera(source: MediaStreamTrack) {
    const Processor = window.MediaStreamTrackProcessor;
    const Generator = window.MediaStreamTrackGenerator;
    if (!Processor || !Generator || !window.VideoFrame)
        throw new Error("Este Chromium não suporta o vídeo processado da câmera.");
    const track: MediaStreamTrack & { writable: WritableStream<VideoFrame>; } = new Generator({ kind: "video" });
    const input = source.clone();
    let reader: ReadableStreamDefaultReader<VideoFrame>;
    try {
        reader = new Processor({ track: input }).readable.getReader();
    } catch (error) { input.stop(); track.stop(); throw error; }
    const writer = track.writable.getWriter();
    let stopped = false, timestamp = -1;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        input.stop();
        track.stop();
        void reader.cancel().catch(() => {});
        void writer.close().catch(() => {});
    };
    void (async () => {
        try {
            while (!stopped) {
                const { value: frame, done } = await reader.read();
                if (done) break;
                let timed: VideoFrame | undefined;
                try {
                    if (stopped) break;
                    // A saída nativa usa timestamp zero: o receptor congela mesmo com 30 FPS enviados.
                    timestamp = Math.max(timestamp + 1, Math.round(performance.now() * 1000));
                    timed = new VideoFrame(frame, { timestamp });
                    await writer.write(timed);
                } finally { frame.close(); timed?.close(); }
            }
        } catch (error) {
            if (!stopped) console.error("FockyTV: processamento da câmera", error);
        } finally {
            const ended = !stopped;
            stop();
            if (ended) track.dispatchEvent(new Event("ended"));
        }
    })();
    return { track, stop };
}
