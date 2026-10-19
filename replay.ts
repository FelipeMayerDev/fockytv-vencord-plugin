// SPDX-License-Identifier: GPL-3.0-or-later
// Replay da live assistida: dois gravadores defasados em 30 s, então o mais antigo sempre tem de 30 a 60 s.
const types = ["video/mp4;codecs=avc1,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"];

export function replayBuffer(media: MediaStream, segment = 30_000) {
    const mimeType = types.find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error("Este Discord não consegue gravar vídeo.");
    const recorders: { recorder: MediaRecorder; chunks: Blob[]; }[] = [];
    // Cada gravador novo também pega faixas que chegaram depois (o áudio pode vir após o vídeo).
    const start = () => {
        const entry = { recorder: new MediaRecorder(media, { mimeType, videoBitsPerSecond: 8_000_000 }), chunks: [] as Blob[] };
        entry.recorder.ondataavailable = event => { if (event.data.size) entry.chunks.push(event.data); };
        entry.recorder.start(1000);
        recorders.push(entry);
        if (recorders.length > 2) recorders.shift()!.recorder.stop();
    };
    start();
    const timer = setInterval(start, segment);
    return {
        extension: mimeType.startsWith("video/mp4") ? "mp4" : "webm",
        // O arquivo é o que o gravador mais antigo tem até agora; ele continua gravando.
        async save() {
            const { recorder, chunks } = recorders[0];
            if (recorder.state === "recording")
                await new Promise(resolve => { recorder.addEventListener("dataavailable", resolve, { once: true }); recorder.requestData(); });
            return new Blob(chunks, { type: mimeType });
        },
        stop() {
            clearInterval(timer);
            for (const { recorder } of recorders.splice(0)) if (recorder.state !== "inactive") recorder.stop();
        }
    };
}
