// SPDX-License-Identifier: GPL-3.0-or-later
import { sessionUrl, streamKey } from "./protocol";

type Response = { status: number; body: string; location: string | null; };
export type Request = (url: string, method: "GET" | "POST" | "DELETE", key?: string, body?: string) => Promise<Response>;

export class Session {
    readonly pc = new RTCPeerConnection();
    readonly media = new MediaStream();
    private location?: string;
    private closed = false;

    constructor(private request: Request, private key: string, readonly capture?: MediaStream, private releaseAudio?: () => void) {
        streamKey(key);
        this.pc.ontrack = event => this.media.addTrack(event.track);
        this.pc.onconnectionstatechange = () => {
            if (["failed", "closed"].includes(this.pc.connectionState)) void this.close();
        };
        if (capture) {
            [...capture.getVideoTracks(), ...capture.getAudioTracks()].forEach(track => {
                const sender = this.pc.addTrack(track, capture);
                if (track.kind === "video") {
                    const codecs = RTCRtpSender.getCapabilities("video")?.codecs;
                    const transceiver = this.pc.getTransceivers().find(t => t.sender === sender);
                    if (codecs && transceiver) {
                        const h264 = codecs.filter(c => c.mimeType.toLowerCase() === "video/h264");
                        if (h264.length) transceiver.setCodecPreferences(h264);
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
                const timer = setTimeout(() => { cleanup(); reject(new Error("Tempo esgotado ao negociar ICE.")); }, 10_000);
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
        } catch (error) {
            await this.close();
            throw error;
        }
    }

    async close() {
        this.closed = true;
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
