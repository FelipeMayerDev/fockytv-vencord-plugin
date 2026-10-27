// SPDX-License-Identifier: GPL-3.0-or-later
import { serverUrl } from "./protocol";
import type { proxySocket } from "./viewer";

// O evento de update só dispara uma checagem: revisão e instalador continuam sendo verificados no GitHub.
// Os avisos de PR/CI migraram para o polling do repositório selecionado (github-alerts.ts); github-event é ignorado.
export function watchPluginUpdates(Socket: ReturnType<typeof proxySocket>, base: string, onUpdate: () => void) {
    const url = `${serverUrl(base).replace(/^http/, "ws")}/api/fixed/ws/plugin-updates`;
    let socket: InstanceType<typeof Socket> | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let stopped = false, delay = 1000, seen = "";
    const connect = () => {
        if (stopped) return;
        const ws = socket = new Socket(url);
        ws.onopen = () => {
            if (stopped) return;
            delay = 1000;
            onUpdate(); // Recupera pushes ocorridos enquanto o cliente estava desconectado.
            heartbeat = setInterval(() => { if (ws.readyState === Socket.OPEN) ws.send('{"type":"ping"}'); }, 25_000);
        };
        ws.onmessage = event => {
            try {
                const data = JSON.parse(String(event.data));
                if (data?.type !== "plugin-update" || typeof data.revision !== "string" || !/^[a-f0-9]{40}$/.test(data.revision) || data.revision === seen) return;
                seen = data.revision;
                onUpdate();
            } catch { /* Mensagem fora do protocolo. */ }
        };
        ws.onerror = () => ws.close();
        ws.onclose = () => {
            clearInterval(heartbeat);
            if (!stopped) { reconnect = setTimeout(connect, delay); delay = Math.min(delay * 2, 30_000); }
        };
    };
    connect();
    return () => {
        stopped = true;
        clearTimeout(reconnect);
        clearInterval(heartbeat);
        if (socket) { socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null; socket.close(); }
    };
}
