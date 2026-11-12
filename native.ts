// SPDX-License-Identifier: GPL-3.0-or-later
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { app, BrowserWindow, desktopCapturer, type IpcMainInvokeEvent, screen, shell, type WebContents } from "electron";

import { annotationColors, drawAnnotationsSource, ANNOTATION_TTL } from "./annotations";
import { bootGuardVerdict, disablePluginSettings } from "./boot-guard";
import { fetchGithubAlerts } from "./github-alerts";
import { fetchGithubMergeQueue } from "./github-queue";
import { fetchGithub } from "./github";
import { applyOverlayRules, isHyprland, OVERLAY_TITLE, placeOverlay } from "./hyprland";
import { jiraSite } from "./jira";
import { mutedShareSinks, readSharePicker, sharePickers, SharePicker, writeSharePicker } from "./linux-picker";
import { serverUrl, streamKey } from "./protocol";
import { checkUpdate as check, installUpdate as install } from "./updater";

export function checkUpdate(_: IpcMainInvokeEvent, branch = "main") { return check(__dirname, branch); }
export function installUpdate(_: IpcMainInvokeEvent, branch = "main") { return install(__dirname, branch); }

// ── Guarda de boot: queda seguida de queda na inicialização desativa o plugin, nunca o Discord ──
// Este módulo é carregado no boot do main, antes de o renderer ler as configurações: a
// desativação escrita no settings.json do Vencord já vale para esta inicialização.
const guardFile = () => join(app.getPath("userData"), "fockytv-boot-guard.json");

function vencordSettingsFile() {
    // Mesma resolução do DATA_DIR do Vencord, com o layout antigo (instalador oficial) como coadjuvante.
    if (process.env.VENCORD_USER_DATA_DIR) return join(process.env.VENCORD_USER_DATA_DIR, "settings", "settings.json");
    if (process.env.DISCORD_USER_DATA_DIR) return join(process.env.DISCORD_USER_DATA_DIR, "..", "VencordData", "settings", "settings.json");
    return join(app.getPath("userData"), "..", "Vencord", "settings", "settings.json");
}

export async function bootGuardHealthy() {
    await rm(guardFile(), { force: true }).catch(() => {});
}

async function disablePluginInSettings() {
    try {
        const file = vencordSettingsFile();
        const data = await readFile(file, "utf8").then(JSON.parse).catch(() => null);
        await writeFile(file, JSON.stringify(disablePluginSettings(data), null, 2));
    } catch (error) { console.warn("FockyTV: guarda de boot não conseguiu desativar", error); }
}

void (async () => {
    try {
        const guard = await readFile(guardFile(), "utf8").then(raw => JSON.parse(raw) as { strikes?: number; }).catch(() => null);
        const verdict = bootGuardVerdict(guard);
        await rm(guardFile(), { force: true });
        if (verdict.disable) await disablePluginInSettings();
        else await writeFile(guardFile(), JSON.stringify({ strikes: verdict.strikes }));
    } catch (error) { console.warn("FockyTV: guarda de boot", error); }
})();

app.once("will-quit", () => { rm(guardFile(), { force: true }).catch(() => {}); });

export function runtimeDiagnostics(_: IpcMainInvokeEvent) {
    return {
        platform: process.platform, electron: process.versions.electron, chromium: process.versions.chrome,
        gpuFeatures: app.getGPUFeatureStatus(),
        processes: app.getAppMetrics().map(({ pid, type, cpu, memory }) => ({
            pid, type, cpuPercent: cpu.percentCPUUsage, memoryKB: memory.workingSetSize
        }))
    };
}
export function githubAlerts(_: IpcMainInvokeEvent, token: string, repository: string, since: string) { return fetchGithubAlerts(token, repository, since); }
export function githubMergeQueue(_: IpcMainInvokeEvent, token: string, repository: string, cursor: string | null) { return fetchGithubMergeQueue(token, repository, cursor); }
export function githubRequest(_: IpcMainInvokeEvent, token: string, path: string) { return fetchGithub(token, path); }

const pipOwners = new WeakSet<WebContents>();
const isPipPopup = (url: string, frameName: string) => url === "about:blank" && /^fockytv-pip-[\da-f-]{36}$/.test(frameName);
const pipHandler = Symbol("fockytv-pip");
type OpenHandler = Parameters<WebContents["setWindowOpenHandler"]>[0] & { [pipHandler]?: true; };
export function preparePictureInPicture({ sender }: IpcMainInvokeEvent) {
    // O Discord (core de 11/2026) nega todo popup que não seja DISCORD_*/popout. Embrulha o handler dele
    // (o Electron guarda em _windowOpenHandler) liberando só o popup do PiP; refaz se ele trocar o handler.
    const contents = sender as WebContents & { _windowOpenHandler?: OpenHandler | null; };
    const original = contents._windowOpenHandler;
    if (!original?.[pipHandler]) {
        const handler: OpenHandler = details => isPipPopup(details.url, details.frameName) ? { action: "allow" } : original ? original(details) : { action: "allow" };
        handler[pipHandler] = true;
        contents.setWindowOpenHandler(handler);
    }
    if (pipOwners.has(sender)) return;
    pipOwners.add(sender);
    sender.on("did-create-window", (popup, { url, frameName }) => {
        if (!isPipPopup(url, frameName)) return;
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

// Vesktop no Linux: desmuta o sink do venmic ao transmitir; sem pw-dump/pw-cli não há o que fazer.
export async function unmuteShareAudio(_: IpcMainInvokeEvent) {
    if (process.platform !== "linux") return 0;
    const { stdout } = await promisify(execFile)("pw-dump", [], { timeout: 5_000, maxBuffer: 64 << 20 });
    const ids = mutedShareSinks(JSON.parse(stdout));
    for (const id of ids) await promisify(execFile)("pw-cli", ["set-param", String(id), "Props", "{ mute: false, monitorMute: false }"], { timeout: 5_000 });
    return ids.length;
}

// Sinalização no processo nativo evita o CSP do Discord sem alterar seus headers.
export async function request(_: IpcMainInvokeEvent, address: string, method: "GET" | "POST" | "DELETE", key = "", body = "") {
    const url = new URL(address);
    serverUrl(url.origin);
    if (key) streamKey(key);
    if (url.username || url.password || !["GET", "POST", "DELETE"].includes(method) ||
        !/^\/api\/(status|presence|livekit\/join|whep(?:\/[\w-]+)?)$/.test(url.pathname))
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

// Transporte de metadados da música/watch party (busca, capas, meta do yt, letras e
// rádio): o CSP do Discord não libera connect-src para o servidor do FockyTV. O vídeo
// da watch party não passa por aqui — toca direto no <video> via media-src (regra CSP).
export async function musicFetch(_: IpcMainInvokeEvent, address: string) {
    const url = new URL(address);
    serverUrl(url.origin);
    if (url.username || url.password || !/^\/api\/fixed\/(search|img|jam\/yt(?:\/lyrics)?|radio\/\d{5,25}\/[\w-]+)$/.test(url.pathname))
        throw new Error("Requisição de música inválida.");
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
    return { status: response.status, type: response.headers.get("Content-Type") ?? "", body: new Uint8Array(await response.arrayBuffer()) };
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

// Anotações na tela de quem transmite: janela transparente sobre o monitor compartilhado, que ignora o mouse
// e fica fora da captura (Windows: setContentProtection → WDA_EXCLUDEFROMCAPTURE; Hyprland: regra noscreenshare
// via hyprctl, que também fixa e posiciona a janela no Wayland), senão a live mostraria o desenho em dobro.
// O texto de drawAnnotations roda dentro dela; traços e laser chegam com a idade (relógios de processos diferentes).
const OVERLAY_HTML = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden;background:transparent}canvas{display:block;width:100vw;height:100vh}</style>
<canvas></canvas><script>
const draw = ${drawAnnotationsSource()}, colors = ${JSON.stringify(annotationColors)}, ttl = ${JSON.stringify(ANNOTATION_TTL)}, canvas = document.querySelector("canvas");
let state = { strokes: [], lasers: [] }, frame = 0;
function paint() {
    frame = 0;
    const now = performance.now(), width = Math.round(innerWidth * devicePixelRatio), height = Math.round(innerHeight * devicePixelRatio);
    if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, width, height);
    state.strokes = state.strokes.filter(stroke => now - stroke.at < ttl.stroke);
    state.lasers = state.lasers.map(laser => ({ pts: laser.pts.filter(point => now - point.at < ttl.laser) })).filter(laser => laser.pts.length);
    draw(context, state, now, { x: 0, y: 0, width: innerWidth, height: innerHeight }, colors, ttl);
    if (state.lasers.length || state.strokes.length) frame = requestAnimationFrame(paint);
}
function update(next) {
    const now = performance.now();
    state = { strokes: next.strokes.map(stroke => ({ color: stroke.color, pts: stroke.pts, at: now - stroke.age })), lasers: next.lasers.map(laser => ({ pts: laser.pts.map(point => ({ x: point.x, y: point.y, at: now - point.age })) })) };
    frame ||= requestAnimationFrame(paint);
}
addEventListener("resize", () => { frame ||= requestAnimationFrame(paint); });
</script>`;
let overlay: BrowserWindow | undefined;
let overlayRules = false;

// Só tela inteira: de uma janela compartilhada não há retângulo para alinhar o desenho.
async function overlayDisplay(source: string) {
    const handle = /^screen-handle:(\d+)$/.exec(source)?.[1];
    const id = handle ? await screenSource(undefined as never, handle) : source;
    const index = /^screen:(\d+)/.exec(id)?.[1];
    if (index === undefined) return;
    const screens = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
    const displayId = screens.find(item => item.id.split(":")[1] === index)?.display_id;
    const displays = screen.getAllDisplays();
    return displays.find(display => String(display.id) === displayId) ?? (displays.length === 1 ? displays[0] : undefined);
}

// No Vesktop a captura vem do portal sem id: o monitor é casado pelo frame físico compartilhado.
// A qualidade pode escalar o frame (max-height do pedido), então a proporção manda sobre o tamanho.
function overlayDisplayBySize(width: number, height: number) {
    const displays = screen.getAllDisplays();
    if (displays.length === 1) return displays[0];
    const aspect = width / Math.max(1, height);
    const exact = displays.filter(display => Math.round(display.bounds.width * display.scaleFactor) === width && Math.round(display.bounds.height * display.scaleFactor) === height);
    if (exact.length === 1) return exact[0];
    return displays.filter(display => Math.abs(display.bounds.width / display.bounds.height - aspect) < 0.02)[0];
}

export async function annotationOverlay(_: IpcMainInvokeEvent, state: string | { width: number; height: number; } | null) {
    const display = typeof state === "string" ? await overlayDisplay(state).catch(() => undefined)
        : state ? overlayDisplayBySize(state.width, state.height) : undefined;
    if (!display) { overlay?.destroy(); overlay = undefined; return false; }
    if (!overlay || overlay.isDestroyed()) {
        const window = overlay = new BrowserWindow({
            ...display.bounds, show: false, frame: false, transparent: true, backgroundColor: "#00000000", focusable: false, skipTaskbar: true,
            resizable: false, movable: false, minimizable: false, maximizable: false, hasShadow: false, enableLargerThanScreen: true,
            title: OVERLAY_TITLE,
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
        });
        window.setIgnoreMouseEvents(true);
        window.setAlwaysOnTop(true, "screen-saver");
        window.setContentProtection(true);
        if (isHyprland() && !overlayRules) { overlayRules = true; await applyOverlayRules().catch(() => {}); }
        await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY_HTML)}`);
        if (overlay !== window || window.isDestroyed()) return false;
    }
    overlay.setBounds(display.bounds);
    overlay.showInactive();
    // Wayland não obedece ao setBounds do Electron: o Hyprland alinha por dispatch.
    if (isHyprland()) await placeOverlay(display.bounds).catch(() => {});
    return true;
}

export function annotationDraw(_: IpcMainInvokeEvent, state: { strokes: { color: number; pts: number[]; age: number; }[]; lasers: { pts: { x: number; y: number; age: number; }[]; }[]; }) {
    // JSON é literal válido de JS: o estado (com pontos de outros usuários) não vira código.
    if (overlay && !overlay.isDestroyed()) overlay.webContents.executeJavaScript(`update(${JSON.stringify(state)})`).catch(() => {});
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

export { readAudio, startAudio, stopAudio } from "./native-audio";
export { socketClose, socketOpen, socketRead, socketSend } from "./native-socket";
