// SPDX-License-Identifier: GPL-3.0-or-later
import { sessionUrl, streamKey } from "./protocol";
import { qualityConstraints, shareQuality, ShareQuality } from "./quality";

type Response = { status: number; body: string; location: string | null; };
export type Request = (url: string, method: "GET" | "POST" | "DELETE", key?: string, body?: string) => Promise<Response>;

export class Session {
    readonly pc = new RTCPeerConnection();
    readonly media = new MediaStream();
    private location?: string;
    private closed = false;
    private qualityChange: Promise<void> = Promise.resolve();

    constructor(private request: Request, private key: string, readonly capture?: MediaStream, private releaseAudio?: () => void, private releaseVideo?: () => void) {
        streamKey(key);
        this.pc.ontrack = event => this.media.addTrack(event.track);
        this.pc.onconnectionstatechange = () => {
            if (["failed", "closed"].includes(this.pc.connectionState)) void this.close();
        };
        if (capture) {
            [...capture.getVideoTracks(), ...capture.getAudioTracks()].forEach(track => {
                const sender = this.pc.addTransceiver(track, {
                    direction: "sendonly", streams: [capture],
                    // Mesmo teto do publicador FockyTV; o controle de congestionamento decide o uso real.
                    ...(track.kind === "video" ? { sendEncodings: [{ maxBitrate: 32_000_000 }] } : {})
                }).sender;
                if (track.kind === "video") {
                    const codecs = RTCRtpSender.getCapabilities("video")?.codecs;
                    const transceiver = this.pc.getTransceivers().find(t => t.sender === sender);
                    if (codecs && transceiver) {
                        const h264 = codecs.filter(c => c.mimeType.toLowerCase() === "video/h264");
                        // Preserva a recuperação de pacotes perdidos ao restringir o vídeo a H.264.
                        const recovery = codecs.filter(c => /^video\/(rtx|red|ulpfec|flexfec-03)$/i.test(c.mimeType));
                        if (h264.length) transceiver.setCodecPreferences([...h264, ...recovery]);
                    }
                    track.addEventListener("ended", () => void this.close(), { once: true });
                }
            });
        } else {
            this.pc.addTransceiver("video", { direction: "recvonly" });
            this.pc.addTransceiver("audio", { direction: "recvonly" });
        }
    }

    async connect(endpoint: string) {
        try {
            await this.pc.setLocalDescription(await this.pc.createOffer());
            await new Promise<void>((resolve, reject) => {
                if (this.pc.iceGatheringState === "complete") return resolve();
                const timer = setTimeout(() => {
                    cleanup();
                    // Não deixa uma interface lenta bloquear candidatos já coletados.
                    if (/^a=candidate:/m.test(this.pc.localDescription?.sdp ?? "")) resolve();
                    else reject(new Error("Nenhum candidato ICE foi coletado. Verifique a rede/VPN e as permissões WebRTC do cliente."));
                }, 10_000);
                const changed = () => {
                    if (this.pc.iceGatheringState === "complete") { cleanup(); resolve(); }
                };
                const cleanup = () => { clearTimeout(timer); this.pc.removeEventListener("icegatheringstatechange", changed); };
                this.pc.addEventListener("icegatheringstatechange", changed);
            });
            if (this.closed) throw new Error("Transmissão cancelada.");
            const response = await this.request(endpoint, "POST", this.key, this.pc.localDescription!.sdp);
            if (response.status !== 201) throw new Error(`FockyTV (${response.status}): ${response.body.slice(0, 300)}`);
            if (!response.location) throw new Error("O servidor não retornou a sessão.");
            this.location = sessionUrl(response.location, endpoint);
            if (this.closed) {
                await this.close();
                throw new Error("Transmissão cancelada.");
            }
            await this.pc.setRemoteDescription({ type: "answer", sdp: response.body });
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                    cleanup();
                    reject(new Error("Tempo esgotado ao conectar ao FockyTV. Verifique a rede/VPN e a porta de mídia do servidor."));
                }, 20_000);
                const changed = () => {
                    if (this.pc.connectionState === "connected") { cleanup(); resolve(); }
                    else if (this.closed || ["failed", "closed"].includes(this.pc.connectionState)) {
                        cleanup();
                        reject(new Error(this.closed ? "Transmissão cancelada." : "Falha na conexão WebRTC com o FockyTV."));
                    }
                };
                const cleanup = () => { clearTimeout(timer); this.pc.removeEventListener("connectionstatechange", changed); };
                this.pc.addEventListener("connectionstatechange", changed);
                changed();
            });
        } catch (error) {
            await this.close();
            throw error;
        }
    }

    setQuality(quality: ShareQuality) {
        const change = this.qualityChange.catch(() => {}).then(async () => {
            quality = shareQuality(quality, {});
            const track = this.capture?.getVideoTracks()[0];
            const sender = this.pc.getSenders().find(sender => sender.track === track);
            if (this.closed || !track || !sender) throw new Error("Transmissão encerrada.");
            const constraints = track.getConstraints();
            const previous = sender.getParameters();
            try {
                await track.applyConstraints(qualityConstraints(quality));
                if (this.closed) throw new Error("Transmissão encerrada.");
                const parameters = sender.getParameters();
                if (!parameters.encodings.length) throw new Error("Encoder sem parâmetros de vídeo.");
                // Permite aliviar resolução e FPS quando o encoder disputa recursos com o jogo.
                parameters.degradationPreference = "balanced";
                for (const encoding of parameters.encodings) {
                    encoding.maxFramerate = quality.fps;
                    encoding.scaleResolutionDownBy = 1;
                }
                await sender.setParameters(parameters);
                if (this.closed) throw new Error("Transmissão encerrada.");
            } catch (error) {
                if (!this.closed) {
                    try {
                        await track.applyConstraints(constraints);
                        const parameters = sender.getParameters();
                        parameters.encodings.forEach((encoding, index) => {
                            const saved = previous.encodings[index];
                            if (!saved) throw new Error("Os parâmetros do encoder mudaram durante a alteração.");
                            if (saved.maxFramerate === undefined) delete encoding.maxFramerate;
                            else encoding.maxFramerate = saved.maxFramerate;
                            if (saved.scaleResolutionDownBy === undefined) delete encoding.scaleResolutionDownBy;
                            else encoding.scaleResolutionDownBy = saved.scaleResolutionDownBy;
                        });
                        if (previous.degradationPreference === undefined) delete parameters.degradationPreference;
                        else parameters.degradationPreference = previous.degradationPreference;
                        await sender.setParameters(parameters);
                    } catch (rollback) { throw new AggregateError([error, rollback], "Falha ao alterar e restaurar a qualidade."); }
                }
                throw error;
            }
            // O selo "1080P 60FPS" dos outros usuários vem desse anúncio; falhar nele não derruba a live.
            if (this.location?.includes("/api/livekit/whip/"))
                void this.request(`${this.location}/quality`, "POST", this.key, JSON.stringify({ resolution: quality.resolution, fps: quality.fps }))
                    .catch(error => console.warn("FockyTV: anunciar qualidade", error));
        });
        this.qualityChange = change;
        return change;
    }

    stopAudio() {
        this.releaseAudio?.();
        this.releaseAudio = undefined;
    }

    // shortcut: ligar áudio após começar sem áudio exige reiniciar a live; renegociar quando WHIP permitir.
    async replace(capture: MediaStream, releaseAudio?: () => void) {
        if (!this.capture || this.closed) throw new Error("Transmissão encerrada.");
        const used = new Set<MediaStreamTrack>();
        await Promise.all(this.pc.getTransceivers().map(transceiver => {
            const track = capture.getTracks().find(t => t.kind === transceiver.receiver.track.kind) ?? null;
            if (track) used.add(track);
            return transceiver.sender.replaceTrack(track);
        }));
        capture.getTracks().filter(track => !used.has(track)).forEach(track => track.stop());
        this.releaseAudio?.();
        this.releaseAudio = releaseAudio;
        if (![...used].some(track => track.kind === "audio")) { this.releaseAudio?.(); this.releaseAudio = undefined; }
        for (const track of this.capture.getTracks()) { track.stop(); this.capture.removeTrack(track); }
        used.forEach(track => this.capture!.addTrack(track));
        const video = capture.getVideoTracks()[0];
        video?.addEventListener("ended", () => void this.close(), { once: true });
    }

    async close() {
        this.closed = true;
        this.releaseVideo?.();
        this.releaseVideo = undefined;
        this.releaseAudio?.();
        this.releaseAudio = undefined;
        this.capture?.getTracks().forEach(track => track.stop());
        this.pc.close();
        const location = this.location;
        this.location = undefined;
        if (location) {
            try {
                const response = await this.request(location, "DELETE", this.key);
                if (![200, 204, 404].includes(response.status)) console.warn("FockyTV: DELETE", response.status);
            } catch (error) { console.warn("FockyTV: falha ao encerrar sessão", error); }
        }
    }
}
