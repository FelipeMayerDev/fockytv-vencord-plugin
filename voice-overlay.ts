// SPDX-License-Identifier: GPL-3.0-or-later
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";

import { app, BrowserWindow, globalShortcut, type IpcMainInvokeEvent, screen, type WebContents } from "electron";

export interface VoiceOverlayState {
    channel: string;
    interactive: boolean;
    shortcut: string;
    opacity: number;
    members: { name: string; speaking: boolean; muted: boolean; deafened: boolean; }[];
}

const overlayHTML = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
html,body{margin:0;background:transparent;color:white;font:14px system-ui;overflow:hidden}
main{padding:8px;display:flex;flex-direction:column;gap:4px}
h1{margin:0 0 4px;padding:4px;font-size:12px;text-shadow:0 1px 3px black;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;-webkit-app-region:drag;cursor:move}
.member{display:flex;align-items:center;gap:8px;padding:6px 10px;border:2px solid transparent;border-radius:10px;background:rgba(20,20,24,.8)}
.member.speaking{border-color:#43b581;background:rgba(25,65,42,.9)}
.dot{width:8px;height:8px;flex:none;border-radius:50%;background:#80848e}
.speaking .dot{background:#43b581;box-shadow:0 0 8px #43b581}
.name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.status{font-size:10px;color:#ddd}
</style></head><body><main></main></body></html>`;

function renderOverlay(state: VoiceOverlayState) {
    document.body.style.opacity = String(state.opacity);
    const main = document.querySelector("main")!;
    const title = document.createElement("h1");
    title.textContent = state.channel;
    main.replaceChildren(title);
    for (const member of state.members) {
        const row = document.createElement("div");
        row.className = `member${member.speaking ? " speaking" : ""}`;
        const dot = document.createElement("span");
        dot.className = "dot";
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = member.name;
        const status = document.createElement("span");
        status.className = "status";
        status.textContent = member.deafened ? "Sem áudio" : member.muted ? "Mutado" : "";
        row.append(dot, name, status);
        main.append(row);
    }
}

const overlays = new Map<WebContents, { window: BrowserWindow; ready: Promise<void>; interactive: boolean; cameras: Set<BrowserWindow>; visible: boolean; shortcut: string; }>();
const overlayOwners = new WeakSet<WebContents>();

function closeOverlay(sender: WebContents) {
    const entry = overlays.get(sender);
    overlays.delete(sender);
    if (entry?.shortcut) globalShortcut.unregister(entry.shortcut);
    if (entry && !entry.window.isDestroyed()) entry.window.destroy();
    entry?.cameras.forEach(popup => popup.destroy());
    if (!overlays.size) {
        if (toggleServer) {
            toggleServer.close();
            toggleServer = null;
        }
        overlayRulesRegistered = false;
    }
}

function setOverlayVisible(entry: NonNullable<ReturnType<typeof overlays.get>>, visible: boolean) {
    entry.visible = visible;
    let index = 0;
    for (const popup of [entry.window, ...entry.cameras]) {
        if (visible) {
            popup.showInactive();
            placeOverlayWhenTitled(popup, index++);
        } else popup.hide();
        popup.setIgnoreMouseEvents(!entry.interactive);
    }
}

// Em Wayland o atalho global do Electron não recebe teclas com outro aplicativo em foco.
// Enquanto houver overlay, um servidor só de loopback deixa o toggle virar um bind do
// compositor (hyprland.conf/sway config); o header impede que páginas web o disparem.
const TOGGLE_PORT = 31971;
let toggleServer: Server | null = null;

function startToggleServer(attempt = 0) {
    const port = TOGGLE_PORT + (/vesktop/i.test(app.name) ? 1 : 0) + attempt;
    const server = createServer((request, response) => {
        if (request.url !== "/toggle" || request.headers["x-fockytv"] !== "toggle") {
            response.writeHead(request.url === "/toggle" ? 403 : 404).end();
            return;
        }
        for (const entry of overlays.values()) setOverlayVisible(entry, !entry.visible);
        response.writeHead(204).end();
    });
    server.once("error", error => {
        server.close();
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE" && attempt < 8) startToggleServer(attempt + 1);
        else console.warn("FockyTV: toggle do overlay por bind indisponível:", error);
    });
    server.listen(port, "127.0.0.1", () => {
        toggleServer = server;
        if (attempt) console.warn(`FockyTV: portas do toggle ocupadas; bind do overlay em http://127.0.0.1:${port}/toggle`);
    });
}

// Hyprland: sem regras, a janela transparente é tratada como tile comum (borda, taskbar,
// foco, animação). As regras são registradas por IPC na sessão atual — um reload do config
// as derruba até o próximo overlay; o README documenta as equivalentes permanentes.
const overlayEffects = "border_size = 0, rounding = 0, no_anim = true, no_focus = true, no_shadow = true, no_dim = true";

function hyprlandSocket() {
    const signature = process.env.HYPRLAND_INSTANCE_SIGNATURE, runtime = process.env.XDG_RUNTIME_DIR;
    return signature && runtime ? join(runtime, "hypr", signature, ".socket.sock") : null;
}

function hyprlandCommand(command: string) {
    const path = hyprlandSocket();
    if (!path) return;
    // Melhor esforço: fora do Hyprland (X11, outra sessão) segue o fluxo normal do Electron.
    const socket = connect(path);
    socket.on("error", () => { });
    socket.end(`${command}\n`);
}

let overlayRulesRegistered = false;
function registerOverlayRules() {
    if (overlayRulesRegistered) return;
    overlayRulesRegistered = true;
    if (!hyprlandSocket()) return;
    hyprlandCommand(`eval hl.window_rule({ name = "fockytv-overlay-list", match = { title = "^FockyTV Voice Overlay$" }, float = true, pin = true, no_initial_focus = true, move = { 20, 20 }, ${overlayEffects} })`);
    hyprlandCommand(`eval hl.window_rule({ name = "fockytv-overlay-camera", match = { title = "^FockyTV Webcam Overlay" }, float = true, pin = true, no_initial_focus = true, ${overlayEffects} })`);
}

// Wayland ignora as coordenadas de criação do Electron: a posição só chega via dispatcher,
// na primeira exibição (depois disso o usuário pode arrastar; esconder/mostrar preserva).
const positionedWindows = new WeakSet<BrowserWindow>();
const regexEscape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// O título das webcams só chega ao processo principal logo após a criação (window.open +
// document.title): aguardar algumas tentativas antes de desistir do posicionamento.
function placeOverlayWhenTitled(popup: BrowserWindow, index: number, attempts = 10) {
    if (!hyprlandSocket() || positionedWindows.has(popup) || popup.isDestroyed()) return;
    const title = popup.getTitle();
    if (!title) return;
    if (title.startsWith("FockyTV")) {
        placeOverlayWindow(popup, index);
        return;
    }
    if (attempts > 0) setTimeout(() => placeOverlayWhenTitled(popup, index, attempts - 1), 100);
}

function placeOverlayWindow(popup: BrowserWindow, index: number) {
    if (!hyprlandSocket()) return;
    positionedWindows.add(popup);
    const window = `title:^${regexEscape(popup.getTitle())}$`;
    const [x, y] = index === 0 ? [20, 20] : [300, 20 + (index - 1) * 230];
    hyprlandCommand(`dispatch hl.dsp.window.float({ window = "${window}", action = "on" })`);
    hyprlandCommand(`dispatch hl.dsp.window.pin({ window = "${window}", action = "on" })`);
    hyprlandCommand(`dispatch hl.dsp.window.move({ window = "${window}", x = ${x}, y = ${y} })`);
    // O dispatcher só aceita booleanos como string ("true"), não como literal Lua.
    for (const [prop, value] of [["border_size", "0"], ["rounding", "0"], ["no_shadow", "true"], ["no_anim", "true"], ["no_focus", "true"], ["no_dim", "true"]] as const)
        hyprlandCommand(`dispatch hl.dsp.window.set_prop({ window = "${window}", prop = "${prop}", value = "${value}" })`);
}

export async function updateVoiceOverlay({ sender }: IpcMainInvokeEvent, state: VoiceOverlayState | null) {
    if (state !== null && (!state || typeof state.channel !== "string" || state.channel.length > 100
        || typeof state.interactive !== "boolean"
        || typeof state.shortcut !== "string" || !state.shortcut.trim() || state.shortcut.length > 80
        || !Number.isFinite(state.opacity) || state.opacity < 0 || state.opacity > 1
        || !Array.isArray(state.members) || state.members.length > 1000 || state.members.some(member => !member
            || typeof member.name !== "string" || member.name.length > 100
            || typeof member.speaking !== "boolean" || typeof member.muted !== "boolean" || typeof member.deafened !== "boolean")))
        throw new Error("Participantes do overlay inválidos.");
    let entry = overlays.get(sender);
    if (!state || !state.members.length) {
        closeOverlay(sender);
        return;
    }
    if (!overlayOwners.has(sender)) {
        overlayOwners.add(sender);
        const close = () => closeOverlay(sender);
        sender.on("render-process-gone", close);
        sender.once("destroyed", close);
        sender.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => { if (isMainFrame && !inPlace) close(); });
        sender.on("did-create-window", (popup, { url, frameName }) => {
            if (url !== "about:blank" || !/^fockytv-overlay-camera-[\da-f-]{36}$/.test(frameName)) return;
            const current = overlays.get(sender);
            if (!current) { popup.destroy(); return; }
            current.cameras.add(popup);
            popup.once("closed", () => current.cameras.delete(popup));
            popup.setAlwaysOnTop(true, "screen-saver");
            popup.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
            popup.setFocusable(current.interactive);
            popup.setMenuBarVisibility(false);
            popup.setResizable(false);
            if (current.visible) {
                popup.showInactive();
                placeOverlayWhenTitled(popup, current.cameras.size);
            }
            popup.setIgnoreMouseEvents(!current.interactive);
        });
    }
    const area = screen.getPrimaryDisplay().workArea;
    // shortcut: salas muito grandes ficam limitadas à altura do monitor; paginar se esse uso aparecer.
    const height = Math.min(area.height - 40, 44 + state.members.length * 38);
    try {
        if (!entry) {
            const popup = new BrowserWindow({
                title: "FockyTV Voice Overlay", x: area.x + 20, y: area.y + 20, width: 260, height,
                frame: false, transparent: true, backgroundColor: "#00000000", show: false,
                focusable: false, resizable: false, skipTaskbar: true, hasShadow: false,
                webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
            });
            entry = { window: popup, ready: Promise.resolve(), interactive: state.interactive, cameras: new Set(), visible: false, shortcut: "" };
            overlays.set(sender, entry);
            popup.once("closed", () => { if (overlays.get(sender)?.window === popup) closeOverlay(sender); });
            popup.setAlwaysOnTop(true, "screen-saver");
            popup.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
            popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
            popup.webContents.on("will-navigate", event => event.preventDefault());
            entry.ready = popup.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayHTML)}`);
            registerOverlayRules();
            if (!toggleServer) startToggleServer();
        }
        if (entry.shortcut !== state.shortcut) {
            if (!globalShortcut.register(state.shortcut, () => {
                const current = overlays.get(sender);
                if (current) setOverlayVisible(current, !current.visible);
            })) throw new Error(`Não foi possível registrar o atalho ${state.shortcut}. Escolha outra combinação nas configurações do FockyTV.`);
            if (entry.shortcut) globalShortcut.unregister(entry.shortcut);
            entry.shortcut = state.shortcut;
        }
        entry.interactive = state.interactive;
        for (const popup of entry.cameras) {
            popup.setFocusable(state.interactive);
            popup.setIgnoreMouseEvents(!state.interactive);
        }
        await entry.ready;
        if (overlays.get(sender) !== entry) return;
        await entry.window.webContents.executeJavaScript(`(${renderOverlay.toString()})(${JSON.stringify(state)})`);
        if (overlays.get(sender) !== entry) return;
        entry.window.setSize(260, height);
        entry.window.setFocusable(state.interactive);
        setOverlayVisible(entry, entry.visible);
    } catch (error) {
        if (!entry) throw error;
        if (overlays.get(sender) !== entry) return;
        closeOverlay(sender);
        throw error;
    }
}
