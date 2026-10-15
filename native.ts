// SPDX-License-Identifier: GPL-3.0-or-later
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { app, desktopCapturer, type IpcMainInvokeEvent } from "electron";

import { serverUrl, sessionUrl, streamKey } from "./protocol";
import { checkUpdate as check, installUpdate as install } from "./updater";

export function checkUpdate(_: IpcMainInvokeEvent) { return check(__dirname); }
export function installUpdate(_: IpcMainInvokeEvent) { return install(__dirname); }

// Sessões WHIP abertas por janela: fechar ou recarregar o Discord encerra a live na hora,
// em vez de o servidor esperar a conexão WebRTC expirar.
// ponytail: processo morto à força (crash, kill) ainda depende da expiração no servidor
const openSessions = new Map<number, Map<string, string>>(); // janela → URL da sessão → stream key
const closing = new Set<Promise<unknown>>();

function deleteSession(url: string, key: string) {
    const done = fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(3000) })
        .catch(error => console.warn("FockyTV: DELETE ao fechar", error))
        .finally(() => closing.delete(done));
    closing.add(done);
}

function rememberSession(event: IpcMainInvokeEvent, url: string, key: string) {
    const owner = event.sender.id;
    if (!openSessions.has(owner)) {
        openSessions.set(owner, new Map());
        event.sender.once("destroyed", () => {
            openSessions.get(owner)?.forEach((sessionKey, sessionUrl) => deleteSession(sessionUrl, sessionKey));
            openSessions.delete(owner);
        });
    }
    openSessions.get(owner)!.set(url, key);
}

// Ao sair do app, segura o encerramento até os DELETEs terminarem (no máximo 3 s).
app.on("will-quit", event => {
    if (!closing.size) return;
    event.preventDefault();
    void Promise.race([Promise.allSettled([...closing]), new Promise(resolve => setTimeout(resolve, 3000))])
        .then(() => { closing.clear(); app.quit(); });
});

// Sinalização no processo nativo evita o CSP do Discord sem alterar seus headers.
export async function request(event: IpcMainInvokeEvent, address: string, method: "GET" | "POST" | "DELETE", key = "", body = "") {
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
    const location = response.headers.get("Location");
    if (method === "POST" && /\/whip$/.test(url.pathname) && response.status === 201 && location)
        rememberSession(event, sessionUrl(location, url.href), key);
    if (method === "DELETE") openSessions.get(event.sender.id)?.delete(url.href);
    return { status: response.status, body: await response.text(), location };
}

// HMONITOR → índice do EnumDisplayDevices, que é o id de tela do Chromium ("screen:<índice>:0") sem WGC.
const MONITOR_INDEX = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FockyMonitor {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct MonitorInfo { public int Size; public int L, T, R, B, WL, WT, WR, WB; public uint Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Device; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct DisplayDevice { public int Size; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Name; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Label; public uint Flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Id; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string Key; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfoW(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplayDevicesW(string device, uint index, ref DisplayDevice info, uint flags);
    public static int Index(long handle) {
        var info = new MonitorInfo(); info.Size = Marshal.SizeOf(info);
        if (!GetMonitorInfoW(new IntPtr(handle), ref info)) return -1;
        var device = new DisplayDevice(); device.Size = Marshal.SizeOf(device);
        for (uint i = 0; EnumDisplayDevicesW(null, i, ref device, 0); i++) if (device.Name == info.Device) return (int)i;
        return -1;
    }
}
'@
[FockyMonitor]::Index([long]$env:FOCKYTV_MONITOR)`;

async function monitorIndex(handle: string) {
    const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(MONITOR_INDEX, "utf16le").toString("base64")], {
        env: { ...process.env, FOCKYTV_MONITOR: handle }, timeout: 15_000, windowsHide: true
    });
    return stdout.trim();
}

// O seletor novo do Discord no Windows entrega o HMONITOR ("screen-handle:65537"), que o Chromium não aceita.
export async function screenSource(_: IpcMainInvokeEvent, handle: string, name = "") {
    if (!/^\d+$/.test(handle)) throw new Error("Tela inválida.");
    const screens = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
    let index: string | undefined;
    let match = screens.find(screen => screen.id.split(":")[1] === handle) ?? (screens.length === 1 ? screens[0] : undefined);
    // O nome do seletor ("Tela 1") é traduzido e segue a ordem do Discord, não a do Chromium: só o dispositivo identifica a tela.
    if (!match && process.platform === "win32") {
        index = await monitorIndex(handle);
        match = screens.find(screen => screen.id.split(":")[1] === index);
    }
    if (!match) throw new Error(`Tela ${name || handle} não encontrada (monitor ${handle}${index ? ` → ${index}` : ""}; ${screens.map(screen => `${screen.id}=${screen.name}`).join(", ")}).`);
    return match.id;
}

export { readAudio, startAudio, stopAudio } from "./native-audio";
export { socketClose, socketOpen, socketRead, socketSend } from "./native-socket";
