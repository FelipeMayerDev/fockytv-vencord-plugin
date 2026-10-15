// SPDX-License-Identifier: GPL-3.0-or-later
// Assistir lives LiveKit: o SDK roda no renderer, mas sua sinalização passa pelo processo nativo.
import type { SocketEvent } from "./native-socket";
import type { Request } from "./session";

export interface SocketNative {
    socketOpen(url: string, protocols: string[]): Promise<number>;
    socketRead(id: number): Promise<SocketEvent[]>;
    socketSend(id: number, data: string | Uint8Array): Promise<void>;
    socketClose(id: number, code?: number, reason?: string): Promise<void>;
}

// Só o que o SignalClient do livekit-client usa de um WebSocket.
export function proxySocket(native: SocketNative) {
    return class ProxySocket extends EventTarget {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;
        readyState = 0;
        binaryType = "arraybuffer";
        bufferedAmount = 0;
        onopen: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        private readonly id: Promise<number>;

        constructor(readonly url: string, protocols: string | string[] = []) {
            super();
            this.id = native.socketOpen(url, [protocols].flat());
            void this.pump();
        }

        private emit(event: Event) {
            this.dispatchEvent(event);
            (this as any)[`on${event.type}`]?.(event);
        }

        private finish(code: number, reason: string) {
            if (this.readyState === 3) return;
            this.readyState = 3;
            this.emit(new CloseEvent("close", { code, reason, wasClean: code === 1000 }));
        }

        private async pump() {
            try {
                const id = await this.id;
                while (this.readyState !== 3) {
                    for (const item of await native.socketRead(id)) {
                        if (item.type === "open") { this.readyState = 1; this.emit(new Event("open")); }
                        else if (item.type === "message") this.emit(new MessageEvent("message", {
                            data: typeof item.data === "string" ? item.data : item.data.buffer.slice(item.data.byteOffset, item.data.byteOffset + item.data.byteLength)
                        }));
                        else if (item.type === "error") this.emit(new Event("error"));
                        else this.finish(item.code, item.reason);
                    }
                }
            } catch (error) {
                console.error("FockyTV: WebSocket", error);
                this.emit(new Event("error"));
                this.finish(1006, String(error));
            }
        }

        send(data: string | ArrayBuffer | ArrayBufferView) {
            const payload = typeof data === "string" ? data
                : data instanceof ArrayBuffer ? new Uint8Array(data)
                    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
            void this.id.then(id => native.socketSend(id, payload));
        }

        close(code?: number, reason?: string) {
            if (this.readyState >= 2) return;
            this.readyState = 2;
            void this.id.then(id => native.socketClose(id, code, reason)).catch(() => this.finish(1006, ""));
        }
    };
}

// O UMD resolve `WebSocket` como identificador livre: o parâmetro da função o substitui só para o SDK.
export function loadLivekit(source: string, Socket: ReturnType<typeof proxySocket>) {
    const module = { exports: {} as any };
    new Function("exports", "module", "WebSocket", source)(module.exports, module, Socket);
    if (typeof module.exports.Room !== "function") throw new Error("SDK LiveKit inválido.");
    return module.exports;
}

export interface Viewing { media: MediaStream; close(): void; }

export async function watchLive(sdk: any, request: Request, base: string, room: string, viewer: string, onEnded: () => void): Promise<Viewing> {
    const response = await request(`${base}/api/livekit/join`, "POST", "", JSON.stringify({ room, role: "viewer", viewer }));
    if (response.status !== 200) throw new Error(response.body.trim() || `Servidor respondeu ${response.status}.`);
    const { token, path } = JSON.parse(response.body) as { token: string; path: string; };
    const url = new URL(base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = path;
    const media = new MediaStream();
    const client = new sdk.Room({ adaptiveStream: false, dynacast: false });
    let closed = false;
    const close = () => { if (closed) return; closed = true; client.disconnect(false).catch(console.warn); media.getTracks().forEach(track => media.removeTrack(track)); };
    let video: () => void;
    const hasVideo = new Promise<void>(resolve => { video = resolve; });
    client.on(sdk.RoomEvent.TrackSubscribed, (track: { mediaStreamTrack: MediaStreamTrack; }) => {
        media.addTrack(track.mediaStreamTrack);
        media.dispatchEvent(new Event("addtrack")); // addTrack() não emite o evento quando chamado por código.
        if (track.mediaStreamTrack.kind === "video") video();
    });
    client.on(sdk.RoomEvent.TrackUnsubscribed, (track: { mediaStreamTrack: MediaStreamTrack; }) => {
        media.removeTrack(track.mediaStreamTrack);
        media.dispatchEvent(new Event("removetrack"));
    });
    // A live acaba quando o publicador sai da sala ou a conexão cai de vez.
    client.on(sdk.RoomEvent.ParticipantDisconnected, (participant: { identity: string; }) => { if (participant.identity === "publisher") { close(); onEnded(); } });
    client.on(sdk.RoomEvent.Disconnected, () => { if (!closed) { close(); onEnded(); } });
    try {
        await client.connect(url.href, token, { autoSubscribe: true });
        await Promise.race([hasVideo, new Promise((_, reject) => setTimeout(() => reject(new Error("A live não enviou vídeo.")), 15_000))]);
    } catch (error) {
        close();
        throw error;
    }
    return { media, close };
}
