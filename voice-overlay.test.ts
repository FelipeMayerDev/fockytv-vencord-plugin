// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transformSync } from "esbuild";

function nativeOverlay() {
    const windows: any[] = [];
    let fail = false;
    class Popup extends EventEmitter {
        options: any;
        webContents = Object.assign(new EventEmitter(), {
            scripts: [] as string[], setWindowOpenHandler() {},
            executeJavaScript: async (script: string) => { if (fail) throw Error("render failed"); this.webContents.scripts.push(script); }
        });
        destroyed = false;
        shown = false;
        ignored = false;
        top = false;
        ready!: () => void;
        html = "";
        constructor(options: any) { super(); this.options = options; windows.push(this); }
        loadURL(url: string) { this.html = decodeURIComponent(url.split(",").slice(1).join(",")); return new Promise<void>(resolve => { this.ready = resolve; }); }
        setFocusable() {}
        setMenuBarVisibility() {}
        setResizable() {}
        setAlwaysOnTop(top: boolean) { this.top = top; }
        setVisibleOnAllWorkspaces() {}
        setSize(width: number, height: number) { Object.assign(this.options, { width, height }); }
        showInactive() { this.shown = true; }
        setIgnoreMouseEvents(ignore: boolean) { this.ignored = ignore; }
        destroy() { this.destroyed = true; this.emit("closed"); }
    }
    const code = transformSync(readFileSync(new URL("./voice-overlay.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs" }).code;
    const module = { exports: {} as any };
    new Function("require", "module", "exports", code)(() => ({ BrowserWindow: Popup, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, height: 1080 } }) } }), module, module.exports);
    return { update: module.exports.updateVoiceOverlay, windows, Popup, fail: () => { fail = true; } };
}

const state = { channel: "Sala", interactive: false, members: [{ name: "Pessoa", speaking: false, muted: false, deafened: false }] };

test("overlay reuses a transparent window, updates speaking and closes on disable/reload", async () => {
    const { update, windows } = nativeOverlay();
    const sender = new EventEmitter();
    const pending = update({ sender }, state);
    const popup = windows[0];
    assert.equal(popup.options.transparent, true);
    assert.equal(popup.options.focusable, false);
    assert.equal(popup.options.webPreferences.nodeIntegration, false);
    assert.equal(popup.options.webPreferences.sandbox, true);
    popup.ready();
    await pending;
    assert.equal(popup.shown, true);
    assert.equal(popup.ignored, true);
    assert.equal(popup.top, true);
    assert.match(popup.html, /default-src 'none'/);
    await update({ sender }, { ...state, members: [{ ...state.members[0], speaking: true }] });
    assert.equal(windows.length, 1);
    assert.match(popup.webContents.scripts.at(-1), /"speaking":true/);
    sender.emit("did-start-navigation", {}, "", false, true);
    assert.equal(popup.destroyed, true);
    const reopen = update({ sender }, state);
    windows[1].ready();
    await reopen;
    await update({ sender }, null);
    assert.equal(windows[1].destroyed, true);
});

test("overlay validates IPC input, cancels pending loads and isolates Discord windows", async () => {
    const { update, windows, fail } = nativeOverlay();
    const sender = new EventEmitter(), other = new EventEmitter();
    await assert.rejects(update({ sender }, { ...state, members: [{ name: "invalid" }] }), /inválidos/);
    await assert.rejects(update({ sender }, { ...state, channel: "x".repeat(101) }), /inválidos/);
    assert.equal(windows.length, 0);
    const pending = update({ sender }, state);
    await update({ sender }, null);
    windows[0].ready();
    await pending;
    assert.equal(windows[0].shown, false);
    const first = update({ sender }, state), second = update({ sender: other }, state);
    windows[1].ready(); windows[2].ready();
    await Promise.all([first, second]);
    sender.emit("destroyed");
    assert.equal(windows[1].destroyed, true);
    assert.equal(windows[2].destroyed, false);
    fail();
    await assert.rejects(update({ sender: other }, state), /render failed/);
    assert.equal(windows[2].destroyed, true);
});

test("webcam blocks follow the move setting and close with their owning overlay", async () => {
    const { update, windows, Popup } = nativeOverlay();
    const sender = new EventEmitter();
    const pending = update({ sender }, state);
    windows[0].ready();
    await pending;
    const webcam = new Popup({});
    sender.emit("did-create-window", webcam, { url: "about:blank", frameName: "fockytv-overlay-camera-12345678-1234-1234-1234-123456789abc" });
    assert.equal(webcam.top, true);
    assert.equal(webcam.ignored, true);
    assert.equal(webcam.shown, true);
    await update({ sender }, { ...state, interactive: true });
    assert.equal(windows[0].ignored, false, "Lista pode ser arrastada no modo de ajuste");
    assert.equal(webcam.ignored, false, "Webcam pode ser arrastada separadamente");
    await update({ sender }, state);
    assert.equal(webcam.ignored, true);
    await update({ sender }, null);
    assert.equal(webcam.destroyed, true);
    const orphan = new Popup({});
    sender.emit("did-create-window", orphan, { url: "about:blank", frameName: "fockytv-overlay-camera-12345678-1234-1234-1234-123456789abc" });
    assert.equal(orphan.destroyed, true, "Desativar durante a abertura não deixa webcam órfã");
});

test("webcam popouts reuse each user's block, render its stream and close individually", () => {
    const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
    const code = transformSync(source.slice(source.indexOf("interface OverlayCamera"), source.indexOf("function syncVoiceOverlay(")), { loader: "tsx", jsxFactory: "React.createElement", jsxFragment: "React.Fragment" }).code;
    const windows: any[] = [], roots: any[] = [];
    let fail = false;
    const React = { Fragment: "fragment", createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) };
    const create = new Function("window", "crypto", "createRoot", "React", "VideoComponent", `${code}; return { syncOverlayCameras, overlayCameras };`);
    const api = create({ open: (_url: string, name: string, features: string) => {
        if (fail) return null;
        const handlers: Record<string, () => void> = {};
        const popup = { name, features, closed: false,
            document: { title: "", head: { append() {} }, body: { append() {} }, createElement: () => ({}) },
            addEventListener: (event: string, callback: () => void) => { handlers[event] = callback; },
            close() { this.closed = true; handlers.pagehide?.(); } };
        windows.push(popup);
        return popup;
    } }, { randomUUID: () => String(windows.length) }, () => {
        const root = { tree: undefined as any, unmounted: 0, render(tree: any) { this.tree = tree; }, unmount() { this.unmounted++; } };
        roots.push(root); return root;
    }, React, "VideoComponent");
    const first = { id: "a", name: "Pessoa A", streamId: "camera-a" }, second = { id: "b", name: "Pessoa B", streamId: "camera-b" };
    api.syncOverlayCameras([first, second]);
    assert.equal(windows.length, 2);
    assert.match(windows[0].features, /frame=false/);
    assert.equal(roots[0].tree.children[0].children[0], "Pessoa A");
    assert.equal(roots[0].tree.children[1].children[0].props.streamId, "camera-a");
    api.syncOverlayCameras([{ ...first, streamId: "replacement" }, second]);
    assert.equal(windows.length, 2, "Atualizar o vídeo preserva a janela e sua posição");
    assert.equal(roots[0].tree.children[1].children[0].props.streamId, "replacement");
    api.syncOverlayCameras([second]);
    assert.equal(windows[0].closed, true);
    assert.equal(windows[1].closed, false);
    assert.equal(roots[0].unmounted, 1);
    windows[1].close();
    assert.equal(api.overlayCameras.size, 0);
    assert.equal(roots[1].unmounted, 1);
    fail = true;
    assert.throws(() => api.syncOverlayCameras([first]), /webcam/);
    assert.equal(api.overlayCameras.size, 0);
});

test("overlay collects active native and FockyTV webcams, excluding auxiliary tiles", async () => {
    const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
    const code = transformSync(source.slice(source.indexOf("function syncVoiceOverlay("), source.indexOf("function configureVoiceOverlay(")), { loader: "ts" }).code;
    const cameras: any[] = [], updates: any[] = [];
    const participants = [
        { user: { id: "me", username: "Eu" }, streamId: "fockytv-camera" },
        { user: { id: "remote", username: "Remoto" }, userNick: "Apelido", streamId: "fockytv-camera:remote" },
        { user: { id: "native", username: "Nativa" }, streamId: "discord-native" },
        { user: { id: "hidden", username: "Oculta" }, streamId: "hidden", localVideoDisabled: true },
        { user: { id: "lyrics", username: "Letra" }, streamId: "lyrics" }
    ];
    const create = new Function("ChannelRTCStore", "Native", "syncOverlayCameras", `
        let routingEnabled = true, lastOverlay = "", overlayListening = false; const overlayStores = [];
        const settings = { store: { voiceOverlay: true, moveVoiceOverlay: false } };
        const SelectedChannelStore = { getVoiceChannelId: () => "call" }, ChannelStore = { getChannel: () => ({ name: "Sala" }) };
        const VoiceStateStore = { getVoiceStatesForChannel: () => ({ me: { userId: "me" } }) };
        const UserStore = { getCurrentUser: () => ({ id: "me" }), getUser: () => ({ username: "Eu" }) }, SpeakingStore = { isSpeaking: () => false };
        const publishers = new Map([["camera", { capture: { id: "local-media" } }]]), cameraViewers = new Map([["remote", { viewing: { media: { id: "remote-media" } } }]]), localTiles = new Map([["lyrics", {}]]);
        ${code}
        return { syncVoiceOverlay, disable: () => { routingEnabled = false; syncVoiceOverlay(); } };
    `);
    const api = create({ getVideoParticipants: () => participants }, { updateVoiceOverlay: async (state: any) => updates.push(state) }, (value: any) => cameras.push(value));
    api.syncVoiceOverlay();
    await Promise.resolve();
    assert.deepEqual(cameras.at(-1).map((camera: any) => camera.id), ["me", "remote", "native"]);
    assert.equal(cameras.at(-1)[0].mediaId, "local-media");
    assert.equal(cameras.at(-1)[1].mediaId, "remote-media");
    assert.equal(cameras.at(-1)[1].name, "Apelido");
    api.disable();
    await Promise.resolve();
    assert.equal(updates.at(-1), null);
    assert.deepEqual(cameras.at(-1), []);
});

test("overlay follows settings, channel members, speaking and suppresses duplicate IPC", async () => {
    const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
    const code = transformSync(source.slice(source.indexOf("let overlayListening ="), source.indexOf("// Seu avatar")), { loader: "tsx" }).code;
    const updates: any[] = [];
    let enabled = true, moving = false, channel: string | undefined = "call", speaking = false;
    const listeners = new Set<() => void>();
    const subscribe = { addChangeListener: (listener: () => void) => listeners.add(listener), removeChangeListener: (listener: () => void) => listeners.delete(listener) };
    const changed = () => { for (const listener of listeners) listener(); };
    const voices = { person: { userId: "person", selfMute: false, selfDeaf: false } };
    const api = new Function("settings", "SelectedChannelStore", "ChannelStore", "VoiceStateStore", "UserStore", "SpeakingStore", "Native", "showNotification", "ChannelRTCStore", `let routingEnabled = true; const overlayStores = [SpeakingStore, VoiceStateStore, SelectedChannelStore, UserStore, ChannelStore, ChannelRTCStore]; const publishers = new Map(), cameraViewers = new Map(), localTiles = new Map(); ${code}; return { configureVoiceOverlay, syncVoiceOverlay, stop: () => { routingEnabled = false; configureVoiceOverlay(); } };`)(
        { store: { get voiceOverlay() { return enabled; }, get moveVoiceOverlay() { return moving; } } }, { ...subscribe, getVoiceChannelId: () => channel }, { ...subscribe, getChannel: () => ({ name: "Sala" }) },
        { ...subscribe, getVoiceStatesForChannel: () => voices }, { ...subscribe, getUser: () => ({ username: "Pessoa" }) }, { ...subscribe, isSpeaking: () => speaking },
        { updateVoiceOverlay: async (state: any) => { updates.push(state); } }, () => {}, { ...subscribe, getVideoParticipants: () => [] });
    api.configureVoiceOverlay();
    assert.equal(updates[0].members[0].name, "Pessoa");
    moving = true;
    api.configureVoiceOverlay();
    assert.equal(updates.at(-1).interactive, true);
    assert.equal(listeners.size, 1);
    changed();
    assert.equal(updates.length, 2);
    speaking = true;
    changed();
    assert.equal(updates.at(-1).members[0].speaking, true);
    voices.person.selfMute = true;
    changed();
    assert.equal(updates.at(-1).members[0].speaking, false);
    assert.equal(updates.at(-1).members[0].muted, true);
    channel = undefined;
    changed();
    assert.equal(updates.at(-1), null);
    channel = "call";
    changed();
    enabled = false;
    api.configureVoiceOverlay();
    assert.equal(updates.at(-1), null);
    assert.equal(listeners.size, 0);
    enabled = true;
    api.configureVoiceOverlay();
    api.stop();
    assert.equal(updates.at(-1), null);
    assert.equal(listeners.size, 0);
});
