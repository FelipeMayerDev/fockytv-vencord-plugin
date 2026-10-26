// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { transformSync } from "esbuild";

const realRequire = createRequire(import.meta.url);

function nativeOverlay({ appName = "discord" }: { appName?: string; } = {}) {
    const windows: any[] = [];
    let fail = false;
    const shortcuts = new Map<string, () => void>();
    const globalShortcut = { register: (key: string, callback: () => void) => { if (shortcuts.has(key)) return false; shortcuts.set(key, callback); return true; }, unregister: (key: string) => { shortcuts.delete(key); } };
    const servers: any[] = [];
    const sockets: string[][] = [];
    const busyPorts = new Set<number>();
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
        constructor(options: any) { super(); this.options = options ?? {}; windows.push(this); }
        loadURL(url: string) { this.html = decodeURIComponent(url.split(",").slice(1).join(",")); return new Promise<void>(resolve => { this.ready = resolve; }); }
        getTitle() { return this.options.title ?? ""; }
        setFocusable() {}
        setMenuBarVisibility() {}
        setResizable() {}
        setAlwaysOnTop(top: boolean) { this.top = top; }
        setVisibleOnAllWorkspaces() {}
        setSize(width: number, height: number) { Object.assign(this.options, { width, height }); }
        showInactive() { this.shown = true; }
        hide() { this.shown = false; }
        isDestroyed() { return this.destroyed; }
        setIgnoreMouseEvents(ignore: boolean) { this.ignored = ignore; }
        destroy() { this.destroyed = true; this.emit("closed"); }
    }
    const createServer = (handler: (request: any, response: any) => void) => {
        const server: any = { handler, port: 0, closed: false, onError: undefined as ((error: NodeJS.ErrnoException) => void) | undefined,
            once(_event: string, listener: (error: NodeJS.ErrnoException) => void) { server.onError = listener; },
            listen(port: number, _host: string, onListen?: () => void) {
                server.port = port;
                if (busyPorts.has(port)) { queueMicrotask(() => server.onError?.(Object.assign(new Error("port in use"), { code: "EADDRINUSE" }))); return; }
                onListen?.();
            },
            close() { server.closed = true; } };
        servers.push(server);
        return server;
    };
    const connect = (_path: string) => {
        const commands: string[] = [];
        sockets.push(commands);
        return { write: (command: string) => { commands.push(command); }, end: (data?: string) => { if (data) commands.push(data.trim()); }, on() {} };
    };
    const code = transformSync(readFileSync(new URL("./voice-overlay.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs" }).code;
    const module = { exports: {} as any };
    new Function("require", "module", "exports", code)((id: string) => {
        if (id === "electron") return { app: { name: appName }, BrowserWindow: Popup, globalShortcut, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, height: 1080 } }) } };
        if (id === "node:http") return { createServer };
        if (id === "node:net") return { connect };
        return realRequire(id);
    }, module, module.exports);
    return { update: module.exports.updateVoiceOverlay, windows, Popup, shortcuts, servers, sockets, busyPorts, trigger: (key = "Alt+'") => { const callback = shortcuts.get(key); assert.ok(callback); callback(); }, fail: () => { fail = true; } };
}

const state = { channel: "Sala", interactive: false, shortcut: "Alt+'", opacity: 1, members: [{ name: "Pessoa", speaking: false, muted: false, deafened: false }] };

test("overlay reuses a transparent window, updates speaking and closes on disable/reload", async () => {
    const { update, windows, trigger } = nativeOverlay();
    const sender = new EventEmitter();
    const pending = update({ sender }, state);
    const popup = windows[0];
    assert.equal(popup.options.transparent, true);
    assert.equal(popup.options.focusable, false);
    assert.equal(popup.options.webPreferences.nodeIntegration, false);
    assert.equal(popup.options.webPreferences.sandbox, true);
    popup.ready();
    await pending;
    assert.equal(popup.shown, false, "Overlay começa oculto");
    trigger();
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
    await assert.rejects(update({ sender }, { ...state, opacity: NaN }), /inválidos/);
    await assert.rejects(update({ sender }, { ...state, opacity: 1.1 }), /inválidos/);
    await assert.rejects(update({ sender }, { ...state, shortcut: "" }), /inválidos/);
    assert.equal(windows.length, 0);
    const pending = update({ sender }, state);
    await update({ sender }, null);
    windows[0].ready();
    await pending;
    assert.equal(windows[0].shown, false);
    const first = update({ sender }, state), second = update({ sender: other }, { ...state, shortcut: "Ctrl+Alt+O" });
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
    const { update, windows, Popup, trigger } = nativeOverlay();
    const sender = new EventEmitter();
    const pending = update({ sender }, state);
    windows[0].ready();
    await pending;
    const webcam = new Popup({});
    sender.emit("did-create-window", webcam, { url: "about:blank", frameName: "fockytv-overlay-camera-12345678-1234-1234-1234-123456789abc" });
    assert.equal(webcam.top, true);
    assert.equal(webcam.ignored, true);
    assert.equal(webcam.shown, false);
    trigger();
    assert.equal(webcam.shown, true);
    assert.equal(windows[0].shown, true);
    await update({ sender }, { ...state, interactive: true });
    assert.equal(windows[0].ignored, false, "Lista pode ser arrastada no modo de ajuste");
    assert.equal(webcam.ignored, false, "Webcam pode ser arrastada separadamente");
    await update({ sender }, state);
    assert.equal(webcam.ignored, true);
    trigger();
    assert.equal(webcam.shown, false);
    assert.equal(windows[0].shown, false);
    await update({ sender }, { ...state, opacity: 0.6 });
    assert.equal(webcam.shown, false, "Atualizações não mostram o overlay oculto");
    await update({ sender }, null);
    assert.equal(webcam.destroyed, true);
    const orphan = new Popup({});
    sender.emit("did-create-window", orphan, { url: "about:blank", frameName: "fockytv-overlay-camera-12345678-1234-1234-1234-123456789abc" });
    assert.equal(orphan.destroyed, true, "Desativar durante a abertura não deixa webcam órfã");
});

test("global shortcut can change, reports conflicts and releases only its own binding", async () => {
    const { update, windows, trigger, shortcuts } = nativeOverlay();
    const sender = new EventEmitter();
    shortcuts.set("Ctrl+K", () => {});
    const pending = update({ sender }, state);
    windows[0].ready();
    await pending;
    assert.equal(windows[0].shown, false);
    trigger();
    await update({ sender }, { ...state, shortcut: "Ctrl+Shift+O" });
    assert.equal(shortcuts.has("Alt+'"), false);
    assert.equal(windows[0].shown, true, "Trocar o atalho preserva a visibilidade e a janela");
    trigger("Ctrl+Shift+O");
    assert.equal(windows[0].shown, false);
    await assert.rejects(update({ sender }, { ...state, shortcut: "Ctrl+K" }), /atalho/);
    assert.equal(windows[0].destroyed, true);
    assert.equal(shortcuts.has("Ctrl+Shift+O"), false);
    assert.equal(shortcuts.has("Ctrl+K"), true, "Atalhos alheios não são removidos");
    const reopen = update({ sender }, state);
    windows[1].ready();
    await reopen;
    await update({ sender }, null);
    assert.equal(shortcuts.has("Alt+'"), false);
});

test("Wayland: bind do compositor alterna o overlay por HTTP e o servidor fecha com o overlay", async () => {
    const { update, windows, servers } = nativeOverlay();
    const sender = new EventEmitter();
    const pending = update({ sender }, state);
    windows[0].ready();
    await pending;
    const server = servers.at(-1);
    assert.equal(server.port, 31971, "Discord usa a porta base");
    assert.equal(server.closed, false);
    const request = (url: string, header?: string) => {
        let status = -1;
        server.handler({ url, headers: header ? { "x-fockytv": header } : {} }, { writeHead(code: number) { status = code; return this; }, end() {} });
        return status;
    };
    assert.equal(windows[0].shown, false);
    assert.equal(request("/toggle"), 403, "Sem o header, páginas web não disparam o toggle");
    assert.equal(request("/outra", "toggle"), 404);
    assert.equal(windows[0].shown, false);
    assert.equal(request("/toggle", "toggle"), 204);
    assert.equal(windows[0].shown, true);
    assert.equal(request("/toggle", "toggle"), 204);
    assert.equal(windows[0].shown, false);
    await update({ sender }, null);
    assert.equal(server.closed, true, "Sem overlays não fica um servidor aberto");
});

test("Wayland: Vesktop usa a porta seguinte e portas ocupadas caem para a próxima livre", async () => {
    const vesktop = nativeOverlay({ appName: "Vesktop" });
    const sender = new EventEmitter();
    const pending = vesktop.update({ sender }, state);
    vesktop.windows[0].ready();
    await pending;
    assert.equal(vesktop.servers.at(-1).port, 31972);
    await vesktop.update({ sender }, null);
    const busy = nativeOverlay();
    busy.busyPorts.add(31971);
    busy.busyPorts.add(31972);
    const pendingFallback = busy.update({ sender: new EventEmitter() }, state);
    busy.windows[0].ready();
    await pendingFallback;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(busy.servers.length, 3, "Duas portas ocupadas antes de funcionar");
    assert.equal(busy.servers[0].closed, true);
    assert.equal(busy.servers[1].closed, true);
    assert.equal(busy.servers[2].port, 31973);
    assert.equal(busy.servers[2].closed, false);
});

test("Hyprland: regras de janela via IPC e posicionamento apenas na primeira exibição", async () => {
    const savedSignature = process.env.HYPRLAND_INSTANCE_SIGNATURE, savedRuntime = process.env.XDG_RUNTIME_DIR;
    process.env.HYPRLAND_INSTANCE_SIGNATURE = "fockytv-test";
    process.env.XDG_RUNTIME_DIR ||= "/tmp";
    try {
        const { update, windows, sockets, trigger, Popup } = nativeOverlay();
        const sender = new EventEmitter();
        const pending = update({ sender }, state);
        windows[0].ready();
        await pending;
        const commands = () => sockets.map(([command]) => command);
        const moves = () => commands().filter(command => command.includes("hl.dsp.window.move"));
        assert.ok(commands().some(command => command.includes('eval hl.window_rule({ name = "fockytv-overlay-list"') && command.includes("float = true, pin = true")), "Regra da lista registrada");
        assert.ok(commands().some(command => command.includes('name = "fockytv-overlay-camera"')), "Regra das webcams registrada");
        assert.equal(moves().length, 0, "Nada posicionado enquanto oculto");
        trigger();
        assert.equal(moves().length, 1, "Lista posicionada na primeira exibição");
        assert.match(moves()[0], /window = "title:\^FockyTV Voice Overlay\$"/);
        assert.match(moves()[0], /x = 20, y = 20/);
        trigger();
        trigger();
        assert.equal(moves().length, 1, "Posição não é refeita a cada exibição");
        const webcam = new Popup({ title: "FockyTV Webcam Overlay 123456789012345678" });
        sender.emit("did-create-window", webcam, { url: "about:blank", frameName: "fockytv-overlay-camera-12345678-1234-1234-1234-123456789abc" });
        assert.equal(webcam.shown, true);
        assert.equal(moves().length, 2, "Webcam visível já nasce posicionada");
        assert.match(moves()[1], /title:\^FockyTV Webcam Overlay 123456789012345678\$/);
        assert.match(moves()[1], /x = 300, y = 20/);
        assert.ok(commands().some(command => command.includes("hl.dsp.window.set_prop({ window = ") && command.includes('prop = "no_focus"')));
    } finally {
        if (savedSignature === undefined) delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
        else process.env.HYPRLAND_INSTANCE_SIGNATURE = savedSignature;
        if (savedRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
        else process.env.XDG_RUNTIME_DIR = savedRuntime;
    }
});

test("webcam popouts reuse each user's block, render its stream and close individually", () => {
    const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
    const code = transformSync(source.slice(source.indexOf("interface OverlayCamera"), source.indexOf("async function syncVoiceOverlay(")), { loader: "tsx", jsxFactory: "React.createElement", jsxFragment: "React.Fragment" }).code;
    const windows: any[] = [], roots: any[] = [];
    let fail = false;
    const React = { Fragment: "fragment", createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }) };
    const create = new Function("window", "crypto", "createRoot", "React", "VideoComponent", `${code}; return { syncOverlayCameras, overlayCameras };`);
    const api = create({ open: (_url: string, name: string, features: string) => {
        if (fail) return null;
        const handlers: Record<string, () => void> = {};
        const popup = { name, features, closed: false,
            document: { title: "", head: { append() {} }, body: { style: {}, append() {} }, createElement: () => ({}) },
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
    api.syncOverlayCameras([{ ...first, streamId: "replacement" }, second], 0.4);
    assert.equal(windows[0].document.body.style.opacity, "0.4");
    assert.equal(windows[1].document.body.style.opacity, "0.4");
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
    const code = transformSync(source.slice(source.indexOf("async function syncVoiceOverlay("), source.indexOf("function configureVoiceOverlay(")), { loader: "ts" }).code;
    const cameras: any[] = [], updates: any[] = [];
    const participants = [
        { user: { id: "me", username: "Eu" }, streamId: "fockytv-camera" },
        { user: { id: "remote", username: "Remoto" }, userNick: "Apelido", streamId: "fockytv-camera:remote" },
        { user: { id: "native", username: "Nativa" }, streamId: "discord-native" },
        { user: { id: "hidden", username: "Oculta" }, streamId: "hidden", localVideoDisabled: true },
        { user: { id: "lyrics", username: "Letra" }, streamId: "lyrics" }
    ];
    const create = new Function("ChannelRTCStore", "Native", "syncOverlayCameras", `
        let routingEnabled = true, lastOverlay = "", overlayListening = false; const overlayStores = () => [];
        const settings = { store: { voiceOverlay: true, moveVoiceOverlay: false, voiceOverlayShortcut: "Alt+'", voiceOverlayTransparency: 0 } };
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
    let enabled = true, moving = false, transparency = 0, channel: string | undefined = "call", speaking = false;
    const listeners = new Set<() => void>();
    const subscribe = { addChangeListener: (listener: () => void) => listeners.add(listener), removeChangeListener: (listener: () => void) => listeners.delete(listener) };
    const changed = () => { for (const listener of listeners) listener(); };
    const voices = { person: { userId: "person", selfMute: false, selfDeaf: false } };
    const api = new Function("settings", "SelectedChannelStore", "ChannelStore", "VoiceStateStore", "UserStore", "SpeakingStore", "Native", "showNotification", "ChannelRTCStore", `let routingEnabled = true; const overlayStores = () => [SpeakingStore, VoiceStateStore, SelectedChannelStore, UserStore, ChannelStore, ChannelRTCStore]; const publishers = new Map(), cameraViewers = new Map(), localTiles = new Map(); ${code}; return { configureVoiceOverlay, syncVoiceOverlay, stop: () => { routingEnabled = false; configureVoiceOverlay(); } };`)(
        { store: { get voiceOverlay() { return enabled; }, get moveVoiceOverlay() { return moving; }, voiceOverlayShortcut: "Alt+'", get voiceOverlayTransparency() { return transparency; } } }, { ...subscribe, getVoiceChannelId: () => channel }, { ...subscribe, getChannel: () => ({ name: "Sala" }) },
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
    transparency = 40;
    api.configureVoiceOverlay();
    assert.equal(updates.at(-1).opacity, 0.6);
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


test("optional overlay failures cannot abort plugin startup or prevent its stylesheet loading", async () => {
    const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
    const code = transformSync(source.slice(source.indexOf("let overlayListening ="), source.indexOf("// Seu avatar")), { loader: "tsx" }).code;
    let enabled = false, brokenStore = false;
    const notifications: unknown[] = [];
    const store = {
        addChangeListener() { if (brokenStore) throw Error("Store indisponível"); },
        removeChangeListener() { if (brokenStore) throw Error("Store indisponível"); },
        getVoiceChannelId: () => "call", getChannel: () => ({ name: "Sala" }),
        getVideoParticipants: () => [], getVoiceStatesForChannel: () => ({})
    };
    const create = new Function("settings", "store", "Native", "showNotification", "console", `
        let routingEnabled = true;
        const SelectedChannelStore = store, ChannelStore = store, ChannelRTCStore = store, VoiceStateStore = store;
        const overlayStores = () => [store], publishers = new Map(), cameraViewers = new Map(), localTiles = new Map();
        ${code}
        return configureVoiceOverlay;
    `);
    const configure = create({ store: { get voiceOverlay() { return enabled; }, voiceOverlayShortcut: "Alt+'", voiceOverlayTransparency: 0, moveVoiceOverlay: false } },
        store, {}, (notification: unknown) => notifications.push(notification), { warn() {} });
    assert.doesNotThrow(configure, "Overlay desativado não depende do helper nativo");
    assert.equal(notifications.length, 0);
    enabled = true;
    assert.doesNotThrow(configure, "Helper nativo ausente não interrompe o start do plugin");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(notifications.length, 1);
    brokenStore = true;
    assert.doesNotThrow(configure, "Store ausente também não interrompe o start nem a limpeza");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(notifications.length, 2);
});


test("overlay resolves Discord stores after initialization instead of capturing undefined imports", async () => {
    const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
    const code = transformSync(source.slice(source.indexOf("const overlayStores ="), source.indexOf("// Seu avatar")), { loader: "tsx" }).code;
    const updates: unknown[] = [], notifications: unknown[] = [];
    let subscribed = 0;
    const store = {
        addChangeListener() { subscribed++; }, removeChangeListener() { subscribed--; },
        getVoiceChannelId: () => "call", getChannel: () => ({ name: "Sala" }), getVideoParticipants: () => [],
        getVoiceStatesForChannel: () => ({ person: { userId: "person" } }), getUser: () => ({ username: "Pessoa" }), isSpeaking: () => false
    };
    const create = new Function("store", "Native", "showNotification", "console", `
        let SpeakingStore, VoiceStateStore, SelectedChannelStore, UserStore, ChannelStore, ChannelRTCStore;
        const settings = { store: { voiceOverlay: false, voiceOverlayShortcut: "Alt+'", voiceOverlayTransparency: 0, moveVoiceOverlay: false } };
        const publishers = new Map(), cameraViewers = new Map(), localTiles = new Map();
        let routingEnabled = true;
        ${code}
        return { configureVoiceOverlay, ready: () => {
            SpeakingStore = VoiceStateStore = SelectedChannelStore = UserStore = ChannelStore = ChannelRTCStore = store;
            settings.store.voiceOverlay = true;
        }, stop: () => { routingEnabled = false; configureVoiceOverlay(); } };
    `);
    const api = create(store, { updateVoiceOverlay: async (state: unknown) => updates.push(state) }, (notice: unknown) => notifications.push(notice), { warn() {} });
    api.configureVoiceOverlay();
    assert.equal(subscribed, 0);
    api.ready();
    api.configureVoiceOverlay();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(subscribed, 6, "Todos os stores são encontrados depois que o Discord os carrega");
    assert.equal(notifications.length, 0);
    assert.equal(updates.length, 1);
    api.stop();
    assert.equal(subscribed, 0, "Desativar remove as assinaturas dos stores carregados");
});
