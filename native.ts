// SPDX-License-Identifier: GPL-3.0-or-later
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { app, desktopCapturer, type IpcMainInvokeEvent } from "electron";

import { helperPath } from "./native-audio";
import { CaptureOptions, CaptureState, ffmpegPath, ffmpegReady, startCapture } from "./native-capture";
import { liveStyle, serverUrl, sessionUrl, streamKey } from "./protocol";
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
        !/^\/api\/(status|presence|livekit\/join|(?:livekit\/)?whip(?:\/[\w-]+)?|livekit\/whip\/[\w-]+\/quality|whep(?:\/[\w-]+)?)$/.test(url.pathname))
        throw new Error("Requisição FockyTV inválida.");
    const response = await fetch(url, {
        method,
        headers: { "Content-Type": /^\/api\/livekit\/(join|whip\/[\w-]+\/quality)$/.test(url.pathname) ? "application/json" : "application/sdp", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
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

const shares = new Map<number, { id: string; state: CaptureState; stop: () => void; restart: (changes: { source?: string; fps?: number; }) => void; }>();
const validSource = (source: unknown) => typeof source === "string" && /^(window|hmonitor|monitor):\d+$/.test(source);
const validFps = (fps: unknown) => Number.isInteger(fps) && (fps as number) >= 1 && (fps as number) <= 240;
const nativeDirectory = () => join(app.getPath("userData"), "FockyTV");
const still = () => join(nativeDirectory(), "preview.jpg");

// Última imagem da captura nativa, para o preview local e a miniatura da live.
export async function nativeShareThumbnail(event: IpcMainInvokeEvent, id: string) {
    if (shares.get(event.sender.id)?.id !== id) return null;
    try { return `data:image/jpeg;base64,${(await readFile(still())).toString("base64")}`; }
    catch { return null; }
}

export function nativeEncoderReady(_: IpcMainInvokeEvent) {
    return ffmpegReady(nativeDirectory());
}

export function stopNativeShare(event: IpcMainInvokeEvent, id: string) {
    const share = shares.get(event.sender.id);
    if (!share || share.id !== id) return;
    shares.delete(event.sender.id);
    share.stop();
}

export function nativeShareState(event: IpcMainInvokeEvent, id: string): CaptureState {
    const share = shares.get(event.sender.id);
    return share?.id === id ? { ...share.state } : { state: "ended" };
}

// Troca fonte/FPS reiniciando só o encoder: quem assiste continua conectado.
export function restartNativeShare(event: IpcMainInvokeEvent, id: string, changes: { source?: string; fps: number; }) {
    const share = shares.get(event.sender.id);
    if (!share || share.id !== id) throw new Error("Transmissão encerrada.");
    if ((changes.source !== undefined && !validSource(changes.source)) || !validFps(changes.fps)) throw new Error("Captura nativa inválida.");
    share.restart(changes.source ? { source: changes.source, fps: changes.fps } : { fps: changes.fps });
}

// Resolve só depois do WebRTC conectar, como a publicação pelo Chromium.
export async function startNativeShare(event: IpcMainInvokeEvent, options: CaptureOptions) {
    if (process.platform !== "win32") throw new Error("Captura nativa disponível apenas no Windows.");
    const endpoint = new URL(options.endpoint);
    if (!validSource(options.source) || !validFps(options.fps) ||
        !Number.isInteger(options.bitrate) || options.bitrate < 1 || options.bitrate > 50 ||
        endpoint.href !== `${serverUrl(endpoint.origin)}/api/livekit/whip`) throw new Error("Captura nativa inválida.");
    options = { source: options.source, fps: options.fps, resolution: 0, bitrate: options.bitrate, audio: !!options.audio, key: streamKey(options.key), endpoint: endpoint.href, style: liveStyle(options.style) };
    const previous = shares.get(event.sender.id);
    if (previous) stopNativeShare(event, previous.id);
    const ffmpeg = await ffmpegPath(nativeDirectory());
    // A imagem da live anterior não pode aparecer como preview desta.
    await rm(still(), { force: true });
    const capture = await startCapture(options, ffmpeg, helperPath(), (url, method, key, body) => request(event, url, method, key, body), join(nativeDirectory(), "ffmpeg.log"), still());
    const id = randomUUID();
    shares.set(event.sender.id, { id, ...capture });
    const destroyed = () => stopNativeShare(event, id);
    event.sender.once("destroyed", destroyed);
    event.sender.once("render-process-gone", destroyed);
    const started = Date.now();
    // 30 s: inclui testar encoders que travam sem erro (8 s cada) antes do que funciona.
    while (capture.state.state === "starting" && Date.now() - started < 30_000) await new Promise(resolve => setTimeout(resolve, 100));
    if (capture.state.state !== "live") {
        stopNativeShare(event, id);
        throw new Error(capture.state.error ?? `Tempo esgotado ao conectar a captura nativa ao FockyTV${capture.state.detail ? ` (${capture.state.detail})` : ""}.`);
    }
    return id;
}

export { readAudio, startAudio, stopAudio } from "./native-audio";
export { socketClose, socketOpen, socketRead, socketSend } from "./native-socket";
