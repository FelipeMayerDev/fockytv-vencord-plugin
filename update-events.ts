// SPDX-License-Identifier: GPL-3.0-or-later
import { defaultRepository } from "./github";
import { serverUrl } from "./protocol";
import type { proxySocket } from "./viewer";

export interface GithubNotification { title: string; body: string; url: string; }

export function githubNotification(data: any): GithubNotification | undefined {
    if (data?.type !== "github-event" || !Number.isSafeInteger(data.id) || data.id <= 0
        || typeof data.title !== "string" || !data.title.trim() || data.title.length > 300
        || typeof data.delivery !== "string" || !data.delivery || data.delivery.length > 128) return;
    const titles: Record<string, string> = { "pr-opened": "PR aberto", "pr-merged": "PR mergeado", "workflow-failed": "Actions falhou na main" };
    if (typeof data.kind !== "string" || !Object.hasOwn(titles, data.kind)) return;
    return {
        title: `FockyTV: ${titles[data.kind]}`,
        body: `${data.kind === "workflow-failed" ? "" : `#${data.id} · `}${data.title}`,
        url: `https://github.com/${defaultRepository}/${data.kind === "workflow-failed" ? "actions/runs" : "pull"}/${data.id}`
    };
}

// O evento de update só dispara uma checagem: revisão e instalador continuam sendo verificados no GitHub.
export function watchPluginUpdates(Socket: ReturnType<typeof proxySocket>, base: string, onUpdate: () => void, onGithub?: (notification: GithubNotification) => void) {
    const url = `${serverUrl(base).replace(/^http/, "ws")}/api/fixed/ws/plugin-updates`;
    let socket: InstanceType<typeof Socket> | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let stopped = false, delay = 1000, seen = "";
    // shortcut: deduplicação das últimas 1000 entregas por sessão; persistir se houver replay após reinício.
    const deliveries = new Set<string>();
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
                if (data?.type === "github-event") {
                    const notification = githubNotification(data);
                    if (!notification || !onGithub || deliveries.has(data.delivery)) return;
                    onGithub(notification);
                    deliveries.add(data.delivery);
                    if (deliveries.size > 1000) deliveries.delete(deliveries.values().next().value!);
                    return;
                }
                if (data.type !== "plugin-update" || typeof data.revision !== "string" || !/^[a-f0-9]{40}$/.test(data.revision) || data.revision === seen) return;
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
