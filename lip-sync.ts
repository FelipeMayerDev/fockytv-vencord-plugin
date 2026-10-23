// SPDX-License-Identifier: GPL-3.0-or-later
// O LiveKit entrega áudio e vídeo em grupos de sincronia diferentes, e no Discord o som ainda passa
// por um AudioContext (playback.ts): sem ajuste ele sai atrás da imagem. Segura o vídeo até baterem.
const MAX_MS = 500, DEADBAND_MS = 20;

// estimatedPlayoutTimestamp é o instante (relógio de quem transmite) do que está tocando agora;
// som mais velho que a imagem = áudio atrás. Meio passo por vez: o atraso real só responde depois.
export function videoDelay(current: number, video: number, audio: number, outputMs: number) {
    const lag = video - audio + outputMs;
    if (!Number.isFinite(lag) || Math.abs(lag) < DEADBAND_MS) return current;
    return Math.min(MAX_MS, Math.max(0, Math.round(current + lag / 2)));
}

async function playout(receiver: RTCRtpReceiver) {
    for (const stat of (await receiver.getStats()).values())
        if (stat.type === "inbound-rtp") return stat.estimatedPlayoutTimestamp as number | undefined;
}

export function lipSync(receivers: () => { audio?: RTCRtpReceiver; video?: RTCRtpReceiver; }, outputMs: () => number) {
    let synced: RTCRtpReceiver | undefined, current = 0, busy = false;
    const timer = setInterval(async () => {
        const { audio, video } = receivers();
        if (busy || !audio || !video || !("jitterBufferTarget" in video)) return;
        // Vídeo republicado chega num receiver novo, sem o alvo anterior.
        if (video !== synced) { synced = video; current = 0; }
        busy = true;
        try {
            const [a, v] = await Promise.all([playout(audio), playout(video)]);
            if (!a || !v) return; // sem RTCP SR do publicador não há relógio comum
            const next = videoDelay(current, v, a, outputMs());
            if (next !== current) video.jitterBufferTarget = current = next;
        } catch { } finally { busy = false; }
    }, 1000);
    return () => clearInterval(timer);
}
