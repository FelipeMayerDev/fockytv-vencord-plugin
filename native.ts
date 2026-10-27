// SPDX-License-Identifier: GPL-3.0-or-later
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { app, desktopCapturer, type IpcMainInvokeEvent, shell, type WebContents } from "electron";

import { fetchGithubAlerts } from "./github-alerts";
import { fetchGithubMergeQueue } from "./github-queue";
import { fetchGithub } from "./github";
import { jiraSite } from "./jira";
import { readSharePicker, sharePickers, SharePicker, writeSharePicker } from "./linux-picker";
import { helperPath } from "./native-audio";
import { CaptureOptions, CaptureState, ffmpegPath, ffmpegReady, startCapture } from "./native-capture";
import { liveStyle, serverUrl, sessionUrl, streamKey } from "./protocol";
import { MAX_BITRATE } from "./quality";
import { checkUpdate as check, installUpdate as install } from "./updater";

export function checkUpdate(_: IpcMainInvokeEvent) { return check(__dirname); }
export function installUpdate(_: IpcMainInvokeEvent) { return install(__dirname); }
export function githubAlerts(_: IpcMainInvokeEvent, token: string, repository: string, since: string) { return fetchGithubAlerts(token, repository, since); }
export function githubMergeQueue(_: IpcMainInvokeEvent, token: string, repository: string, cursor: string | null) { return fetchGithubMergeQueue(token, repository, cursor); }
export function githubRequest(_: IpcMainInvokeEvent, token: string, path: string) { return fetchGithub(token, path); }

const pipOwners = new WeakSet<WebContents>();
export function preparePictureInPicture({ sender }: IpcMainInvokeEvent) {
    if (pipOwners.has(sender)) return;
    pipOwners.add(sender);
    sender.on("did-create-window", (popup, { url, frameName }) => {
        if (url !== "about:blank" || !/^fockytv-pip-[\da-f-]{36}$/.test(frameName)) return;
        popup.setAlwaysOnTop(true);
        popup.setMenuBarVisibility(false);
        popup.setMinimumSize(160, 90);
    });
}

const pickerConfig = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "hypr", "xdph.conf");
export async function getLinuxSharePicker(_: IpcMainInvokeEvent) {
    if (process.platform !== "linux" || !process.env.HYPRLAND_INSTANCE_SIGNATURE) return null;
    try { return { picker: await readSharePicker(pickerConfig()) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export async function setLinuxSharePicker(event: IpcMainInvokeEvent, picker: SharePicker) {
    if (!sharePickers.includes(picker)) throw new Error("Seletor de compartilhamento inválido.");
    if (!await getLinuxSharePicker(event)) throw new Error("Disponível apenas no Hyprland com xdph.conf configurado.");
    await access(join("/usr/bin", picker), constants.X_OK);
    if (await writeSharePicker(pickerConfig(), picker)) {
        try { await promisify(execFile)("systemctl", ["--user", "restart", "xdg-desktop-portal-hyprland.service"], { timeout: 15_000 }); }
        catch { throw new Error("Seletor salvo, mas não foi possível reiniciar o portal. A alteração será aplicada no próximo login."); }
    }
    return { picker: await readSharePicker(pickerConfig()) };
}

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

// Jira Cloud pelo processo nativo: a API não libera CORS para o Discord. O token só vai para *.atlassian.net.
export async function jiraRequest(_: IpcMainInvokeEvent, site: string, email: string, token: string, path: string, method: "GET" | "POST" = "GET", body?: string) {
    const base = jiraSite(site);
    if (typeof email !== "string" || !email || typeof token !== "string" || !token || !["GET", "POST"].includes(method) ||
        !/^\/rest\/(api\/3|agile\/1\.0)\/[\w/.-]+(\?[^#\s]*)?$/.test(path) || path.includes(".."))
        throw new Error("Requisição Jira inválida.");
    const response = await fetch(base + path, {
        method,
        headers: { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        body: method === "POST" ? body : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(20_000)
    });
    return { status: response.status, body: await response.text() };
}

// Player de música da call: busca, capas e o áudio da faixa em bytes (o CSP do Discord só aceita blob: no <audio>).
export async function musicFetch(_: IpcMainInvokeEvent, address: string) {
    const url = new URL(address);
    serverUrl(url.origin);
    if (url.username || url.password || !/^\/api\/fixed\/(search|img|jam\/yt(?:\/video|\/lyrics)?|radio\/\d{5,25}\/[\w-]+)$/.test(url.pathname))
        throw new Error("Requisição de música inválida.");
    const video = url.pathname === "/api/fixed/jam/yt/video";
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(video ? 300_000 : 60_000) });
    if (!video) return { status: response.status, type: response.headers.get("Content-Type") ?? "", body: new Uint8Array(await response.arrayBuffer()) };
    // shortcut: vídeo inteiro em blob até 512 MiB, usar streaming local para vídeos maiores.
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    try {
        while (reader) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 512 * 1024 * 1024) throw new Error("Vídeo maior que 512 MiB. Escolha um vídeo menor.");
            chunks.push(value);
        }
    } finally { await reader?.cancel(); }
    return { status: response.status, type: response.headers.get("Content-Type") ?? "", body: new Uint8Array(Buffer.concat(chunks)) };
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

const shares = new Map<number, { id: string; } & Awaited<ReturnType<typeof startCapture>>>();
const validSource = (source: unknown) => typeof source === "string" && /^(window|hmonitor|monitor):\d+$/.test(source);
const validFps = (fps: unknown) => Number.isInteger(fps) && (fps as number) >= 1 && (fps as number) <= 240;
// 0 = fonte; altura par (o encoder recusa ímpar), dentro do que o Discord oferece.
const validResolution = (resolution: unknown) => Number.isInteger(resolution) && (resolution === 0 || ((resolution as number) >= 144 && (resolution as number) <= 4320 && (resolution as number) % 2 === 0));
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
export function restartNativeShare(event: IpcMainInvokeEvent, id: string, changes: { source?: string; fps: number; resolution: number; }) {
    const share = shares.get(event.sender.id);
    if (!share || share.id !== id) throw new Error("Transmissão encerrada.");
    if ((changes.source !== undefined && !validSource(changes.source)) || !validFps(changes.fps) || !validResolution(changes.resolution)) throw new Error("Captura nativa inválida.");
    share.restart({ ...changes.source ? { source: changes.source } : {}, fps: changes.fps, resolution: changes.resolution });
}

// Aviso de live no canal (bot do servidor), autorizado pela sessão WHIP da captura nativa.
export async function announceNativeShare(event: IpcMainInvokeEvent, id: string, body: string) {
    const share = shares.get(event.sender.id);
    if (!share || share.id !== id) throw new Error("Transmissão encerrada.");
    if (typeof body !== "string" || body.length > 600 * 1024) throw new Error("Aviso inválido.");
    return (await share.notify(body)).status;
}

// Replays das lives assistidas: pasta e nome decididos aqui, nunca pelo renderer.
const replayFolder = () => join(app.getPath("videos"), "FockyTV");
export async function saveReplay(_: IpcMainInvokeEvent, owner: string, extension: string, data: Uint8Array) {
    if (!["mp4", "webm"].includes(extension) || !ArrayBuffer.isView(data) || !data.byteLength || data.byteLength > 1024 ** 3) throw new Error("Replay inválido.");
    await mkdir(replayFolder(), { recursive: true });
    const stamp = new Date().toLocaleString("sv").replaceAll(":", "-");
    const file = join(replayFolder(), `Replay ${streamKey(owner)} ${stamp}.${extension}`);
    await writeFile(file, data);
    return file;
}

export function showReplay(_: IpcMainInvokeEvent, file: string) {
    if (typeof file === "string" && dirname(file) === replayFolder()) shell.showItemInFolder(file);
}

// Resolve só depois do WebRTC conectar, como a publicação pelo Chromium.
export async function startNativeShare(event: IpcMainInvokeEvent, options: CaptureOptions) {
    if (process.platform !== "win32") throw new Error("Captura nativa disponível apenas no Windows.");
    const endpoint = new URL(options.endpoint);
    if (!validSource(options.source) || !validFps(options.fps) || !validResolution(options.resolution) ||
        !Number.isInteger(options.bitrate) || options.bitrate < 1 || options.bitrate > 50 ||
        endpoint.href !== `${serverUrl(endpoint.origin)}/api/livekit/whip`) throw new Error("Captura nativa inválida.");
    options = { source: options.source, fps: options.fps, resolution: options.resolution, bitrate: Math.min(options.bitrate, MAX_BITRATE), audio: !!options.audio, key: streamKey(options.key), endpoint: endpoint.href, style: liveStyle(options.style) };
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
