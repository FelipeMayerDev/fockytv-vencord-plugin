// SPDX-License-Identifier: GPL-3.0-or-later
import { desktopCapturer, type IpcMainInvokeEvent } from "electron";

import { serverUrl, streamKey } from "./protocol";

// Sinalização no processo nativo evita o CSP do Discord sem alterar seus headers.
export async function request(_: IpcMainInvokeEvent, address: string, method: "GET" | "POST" | "DELETE", key = "", body = "") {
    const url = new URL(address);
    serverUrl(url.origin);
    if (key) streamKey(key);
    if (url.username || url.password || !["GET", "POST", "DELETE"].includes(method) ||
        !/^\/api\/(status|presence|livekit\/join|(?:livekit\/)?whip(?:\/[\w-]+)?|whep(?:\/[\w-]+)?)$/.test(url.pathname))
        throw new Error("Requisição FockyTV inválida.");
    const response = await fetch(url, {
        method,
        headers: { "Content-Type": url.pathname === "/api/livekit/join" ? "application/json" : "application/sdp", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: method === "POST" ? body : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(20_000)
    });
    return { status: response.status, body: await response.text(), location: response.headers.get("Location") };
}

// O seletor novo do Discord no Windows entrega o HMONITOR ("screen-handle:65537"), que o Chromium não aceita.
export async function screenSource(_: IpcMainInvokeEvent, handle: string, name = "") {
    if (!/^\d+$/.test(handle)) throw new Error("Tela inválida.");
    const screens = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
    // ponytail: com vários monitores e captura sem WGC, depende do nome bater; mapear HMONITOR→índice se falhar
    const match = screens.find(screen => screen.id.split(":")[1] === handle)
        ?? (screens.length === 1 ? screens[0] : screens.find(screen => screen.name === name));
    if (!match) throw new Error(`Tela ${name || handle} não encontrada (${screens.map(screen => `${screen.id}=${screen.name}`).join(", ")}).`);
    return match.id;
}

export { readAudio, startAudio, stopAudio } from "./native-audio";
export { socketClose, socketOpen, socketRead, socketSend } from "./native-socket";
