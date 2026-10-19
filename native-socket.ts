// SPDX-License-Identifier: GPL-3.0-or-later
// WebSockets do LiveKit e do player de música no processo nativo: o CSP do Discord bloqueia connect-src para o servidor FockyTV.
import type { IpcMainInvokeEvent } from "electron";

import { serverUrl } from "./protocol";

export type SocketEvent =
    | { type: "open"; }
    | { type: "message"; data: string | Uint8Array; }
    | { type: "error"; }
    | { type: "close"; code: number; reason: string; };

interface Socket { ws: WebSocket; owner: number; queue: SocketEvent[]; wake?: () => void; }
const sockets = new Map<number, Socket>();
let lastId = 0;

function socketFor(event: IpcMainInvokeEvent, id: number) {
    const socket = sockets.get(id);
    return socket?.owner === event.sender.id ? socket : undefined;
}

export function socketOpen(event: IpcMainInvokeEvent, address: string, protocols: string[] = []) {
    const url = new URL(address);
    if (!["ws:", "wss:"].includes(url.protocol) || url.pathname !== "/livekit/rtc" && !url.pathname.startsWith("/livekit/rtc/") && url.pathname !== "/api/fixed/ws/radio")
        throw new Error("WebSocket FockyTV inválido.");
    serverUrl(`${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`);
    if (typeof WebSocket !== "function") throw new Error("Este Discord não oferece WebSocket no processo nativo (requer Electron com Node 22+).");
    const id = ++lastId;
    const ws = new WebSocket(url, protocols);
    ws.binaryType = "arraybuffer";
    const socket: Socket = { ws, owner: event.sender.id, queue: [] };
    const push = (item: SocketEvent) => { socket.queue.push(item); socket.wake?.(); };
    ws.onopen = () => push({ type: "open" });
    ws.onmessage = message => push({ type: "message", data: typeof message.data === "string" ? message.data : new Uint8Array(message.data as ArrayBuffer) });
    ws.onerror = () => push({ type: "error" });
    ws.onclose = close => push({ type: "close", code: close.code, reason: close.reason });
    sockets.set(id, socket);
    // Recarregar o Discord não pode deixar conexões órfãs.
    event.sender.once("destroyed", () => { if (sockets.delete(id)) ws.close(); });
    return id;
}

// Long-poll: retorna assim que houver eventos (ou a cada 25 s, vazio).
export async function socketRead(event: IpcMainInvokeEvent, id: number): Promise<SocketEvent[]> {
    const socket = socketFor(event, id);
    if (!socket) return [{ type: "close", code: 1006, reason: "" }];
    if (!socket.queue.length) await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 25_000);
        socket.wake = () => { clearTimeout(timer); resolve(); };
    });
    socket.wake = undefined;
    const events = socket.queue.splice(0);
    if (events.some(item => item.type === "close")) sockets.delete(id);
    return events;
}

export function socketSend(event: IpcMainInvokeEvent, id: number, data: string | Uint8Array) {
    const socket = socketFor(event, id);
    if (socket?.ws.readyState === WebSocket.OPEN) socket.ws.send(data as string | Uint8Array<ArrayBuffer>); // clone do IPC: nunca SharedArrayBuffer
}

export function socketClose(event: IpcMainInvokeEvent, id: number, code?: number, reason?: string) {
    socketFor(event, id)?.ws.close(code, reason);
}
