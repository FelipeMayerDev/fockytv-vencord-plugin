// SPDX-License-Identifier: GPL-3.0-or-later
import { sessionUrl, streamKey } from "./protocol";
import { MAX_BITRATE, qualityConstraints, shareQuality, ShareQuality } from "./quality";
import { joinRoom } from "./viewer";

type Response = { status: number; body: string; location: string | null; };
export type Request = (url: string, method: "GET" | "POST" | "DELETE", key?: string, body?: string) => Promise<Response>;

// Som de tela é música/jogo: o padrão do WebRTC é voz mono (~32 kbps, com DTX). Pede estéreo a 128 kbps sem DTX.
export const MUSIC_AUDIO_BITRATE = 128_000;

// Player WHEP do painel para lives antigas (não LiveKit): só recebe.
export class Session {
    readonly pc = new RTCPeerConnection();
    readonly media = new MediaStream();
    private location?: string;
    private closed = false;

    constructor(private request: Request, private key: string) {
        streamKey(key);
        this.pc.ontrack = event => this.media.addTrack(event.track);
        this.pc.onconnectionstatechange = () => {
            if (["failed", "closed"].includes(this.pc.connectionState)) void this.close();
        };
        this.pc.addTransceiver("video", { direction: "recvonly" });
        this.pc.addTransceiver("audio", { direction: "recvonly" });
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

    async close() {
        this.closed = true;
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

// Live WebRTC direto no SFU do LiveKit (livekit-client): negocia transport-cc e a banda sobe em segundos;
// o ingress WHIP só negociava goog-remb e levava ~50 s até o bitrate cheio.
export class LivePublisher {
    private readonly room: any;
    private readonly tracks = new Map<string, any>(); // "video"/"audio" → LocalTrack publicado
    private closed = false;
    private qualityChange: Promise<void> = Promise.resolve();
    style = "";

    // onFailed: a live caiu sem passar por close() (conexão perdida ou captura morta); a live já foi encerrada.
    constructor(private sdk: any, private request: Request, private key: string, private camera: boolean, readonly capture: MediaStream,
        private releaseAudio?: () => void, private releaseVideo?: () => void, private onFailed?: () => void) {
        streamKey(key);
        this.room = new sdk.Room();
        this.room.on(sdk.RoomEvent.Disconnected, () => { if (!this.closed) { void this.close(); this.onFailed?.(); } });
        this.watchCapture();
    }

    // A fonte de captura morrer (jogo fechou, captura derrubada pelo driver) encerra a live sem o dono pedir: avisa igual a uma queda.
    private watchCapture() {
        this.capture.getVideoTracks()[0]?.addEventListener("ended", () => {
            if (this.closed) return;
            void this.close();
            this.onFailed?.();
        }, { once: true });
    }

    async connect(base: string, fps: number) {
        try {
            const { url, token } = await joinRoom(this.request, base, { room: this.key, role: "publisher" });
            if (this.closed) throw new Error("Transmissão cancelada.");
            await this.room.connect(url, token, { autoSubscribe: false });
            for (const track of this.capture.getTracks()) await this.publish(track, fps);
            if (this.closed) throw new Error("Transmissão cancelada.");
        } catch (error) {
            const cancelled = this.closed;
            await this.close();
            throw cancelled ? new Error("Transmissão cancelada.") : error;
        }
    }

    private async publish(track: MediaStreamTrack, fps?: number) {
        const { Source } = this.sdk.Track;
        // Sem simulcast nem codec reserva (ver quality.ts); sem screenShareEncoding o LiveKit limita a tela a 1080p 15 FPS.
        const encoding = { maxBitrate: MAX_BITRATE * 1_000_000, maxFramerate: fps };
        // Jogo/vídeo: "motion" + maintain-framerate baixa a resolução antes do FPS. Com "balanced" a tela real
        // (encoder H.264 por software) caía para ~4 FPS no benchmark do Windows; assim segura 29 FPS (benchmark.md).
        if (track.kind === "video" && !this.camera) track.contentHint = "motion";
        const publication = await this.room.localParticipant.publishTrack(track, track.kind === "video"
            ? { source: this.camera ? Source.Camera : Source.ScreenShare, videoCodec: "h264", backupCodec: false, simulcast: false, degradationPreference: "maintain-framerate", videoEncoding: encoding, screenShareEncoding: encoding }
            : { source: Source.ScreenShareAudio, dtx: false, red: false, forceStereo: true, audioPreset: { maxBitrate: MUSIC_AUDIO_BITRATE } });
        this.tracks.set(track.kind, publication.track);
    }

    // Aviso de live no canal: o bot só aceita a sessão WHIP do dono, que este caminho não tem.
    async announce(_body: string): Promise<number> {
        throw new Error("Aviso de live indisponível na transmissão WebRTC.");
    }

    setQuality(quality: ShareQuality) {
        const change = this.qualityChange.catch(() => {}).then(async () => {
            quality = shareQuality(quality, {});
            const track = this.capture.getVideoTracks()[0];
            const sender: RTCRtpSender | undefined = this.tracks.get("video")?.sender;
            if (this.closed || !track || !sender) throw new Error("Transmissão encerrada.");
            const constraints = track.getConstraints();
            const previous = sender.getParameters();
            try {
                await track.applyConstraints(qualityConstraints(quality));
                if (this.closed) throw new Error("Transmissão encerrada.");
                const parameters = sender.getParameters();
                if (!parameters.encodings.length) throw new Error("Encoder sem parâmetros de vídeo.");
                // Sob pressão (banda ou encoder) cai a resolução, não o FPS.
                parameters.degradationPreference = "maintain-framerate";
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
            // O selo "1080P 60FPS" dos outros usuários vem do metadata do publicador (validado pelo servidor); falhar nele não derruba a live.
            this.room.localParticipant.setMetadata(JSON.stringify({ resolution: quality.resolution, fps: quality.fps, style: this.style }))
                .catch((error: unknown) => console.warn("FockyTV: anunciar qualidade", error));
        });
        this.qualityChange = change;
        return change;
    }

    stopAudio() {
        this.releaseAudio?.();
        this.releaseAudio = undefined;
    }

    // Mesma sala: troca as faixas sem renegociar; áudio que aparece ou some é publicado/despublicado.
    async replace(capture: MediaStream, releaseAudio?: () => void) {
        if (this.closed) throw new Error("Transmissão encerrada.");
        const video = capture.getVideoTracks()[0], audio = capture.getAudioTracks()[0];
        await this.tracks.get("video").replaceTrack(video, true);
        const current = this.tracks.get("audio");
        if (current && audio) await current.replaceTrack(audio, true);
        else if (current) { this.tracks.delete("audio"); await this.room.localParticipant.unpublishTrack(current, false); }
        else if (audio) await this.publish(audio);
        capture.getTracks().filter(track => track !== video && track !== audio).forEach(track => track.stop());
        this.releaseAudio?.();
        this.releaseAudio = releaseAudio;
        if (!audio) this.stopAudio();
        for (const track of this.capture.getTracks()) { track.stop(); this.capture.removeTrack(track); }
        [video, audio].forEach(track => track && this.capture.addTrack(track));
        this.watchCapture();
    }

    async getStats(): Promise<RTCStatsReport> {
        return await this.tracks.get("video")?.getRTCStatsReport() ?? new Map();
    }

    async close() {
        if (this.closed) return;
        this.closed = true;
        this.releaseVideo?.();
        this.releaseVideo = undefined;
        this.stopAudio();
        this.capture.getTracks().forEach(track => track.stop());
        await this.room.disconnect().catch((error: unknown) => console.warn("FockyTV: encerrar live", error));
    }
}
