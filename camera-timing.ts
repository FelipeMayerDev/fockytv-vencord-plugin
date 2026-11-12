// SPDX-License-Identifier: GPL-3.0-or-later
// Os frames da câmera nativa chegam ao renderer em rajadas (~17 ms) com buracos de ~300 ms quando a live da tela
// roda junto, mas na média chegam todos. Carimbar a hora de chegada levava os buracos ao viewer (câmera travando):
// espaça pelo intervalo médio, sem passar de agora nem atrasar mais que MAX_LAG.
const MAX_LAG = 500_000;
export function cameraClock() {
    let timestamp = -1, arrival = -1, period = 33_333;
    return (now: number) => {
        if (arrival >= 0) period += (now - arrival - period) * 0.01;
        arrival = now;
        timestamp = timestamp < 0 ? now : Math.min(now, Math.max(timestamp + period, now - MAX_LAG));
        return timestamp = Math.round(timestamp);
    };
}

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
    const clock = cameraClock();
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
                    timestamp = Math.max(timestamp + 1, clock(performance.now() * 1000));
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
