import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transformSync } from "esbuild";

import { discordPatches } from "./discord";

const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
const javascript = (code: string) => transformSync(code, { loader: "tsx", jsxFactory: "React.createElement", jsxFragment: "React.Fragment" }).code;
const React = {
    Fragment: "fragment",
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props: props ?? {}, children })
};
const nodes = (tree: any): any[] => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === "object" ? [tree, ...tree.children.flatMap(nodes)] : [];

test("voice badges receive the owner's style before or after the game icon", () => {
    const patch = discordPatches.find(patch => Array.isArray(patch.replacement) && patch.replacement.some(replacement => replacement.replace.includes("liveClass")))!;
    const badge = 'S&&B.push((0,i.jsx)(L.Ay,{size:L.Ay.Sizes.SMALL},"stream"));';
    const eye = 'D&&B.push((0,i.jsx)(T.M,{text:"watch",children:(0,i.jsx)(E.EyeIcon,{size:"xs",color:"currentColor",className:a()(c.x,v)})},"watch"));';
    const game = 'let game=(0,i.jsx)(G,{userId:z.id},`${z.id}-game`);';
    for (const content of [eye + game + badge, eye + badge + game]) {
        let code = `function icons(e){let {user:z,isStreaming:S,isWatching:D}=e,B=[],v="icon";${content}return B;}`;
        for (const replacement of patch.replacement as { match: RegExp; replace: string; }[]) {
            const match = new RegExp(replacement.match.source.replaceAll(String.raw`\i`, String.raw`[A-Za-z_$][\w$]*`), replacement.match.flags);
            code = code.replace(match, replacement.replace);
        }
        const requested: unknown[] = [];
        const render = new Function("$self", `const i={jsx:(type,props,key)=>({type,props,key})},L={Ay:{Sizes:{SMALL:1}}},T={M:'tooltip'},E={EyeIcon:'eye'},G='game',c={x:'class'},a=()=>()=>'';${code}return icons;`)({
            liveClass: (id: string, part: string) => { requested.push([id, part]); return "fockytv-badge fockytv-style-noir"; },
            watchPill: (id: string) => { assert.equal(id, "owner"); return { customWatch: true }; }
        });
        const result = render({ user: { id: "owner" }, isStreaming: true, isWatching: true });
        assert.equal(result[0].customWatch, true);
        assert.equal(result[1].props.className, "fockytv-badge fockytv-style-noir");
        assert.deepEqual(requested, [["owner", "badge"]]);
    }
});

test("live announcement watch button turns gray only for the local viewer and never reconnects an active stream", async () => {
    const watching = new Map(), fockyStreams = new Set();
    let busy = false, calls = 0, finish: () => void = () => {};
    const Button = "Button";
    const component = new Function("React", "Button", "useState", "useStateFromStores", "liveOwners", "watching", "fockyStreams", "startWatch", "keyOf", `
        const ApplicationStreamingStore = {}, ChannelRTCStore = {};
        const SelectedChannelStore = { getVoiceChannelId: () => 'voice' };
        const ChannelStore = { getChannel: () => ({ guild_id: 'guild' }) };
        ${javascript(source.slice(source.indexOf("function LiveAnnouncementButton("), source.indexOf("function WatchTag(")))}
        return LiveAnnouncementButton;
    `)(React, Button, () => [busy, (value: boolean) => busy = value], (_stores: unknown, snapshot: () => unknown) => snapshot(),
        new Map([["owner", "ana"]]), watching, fockyStreams,
        async (key: string) => { calls++; watching.set(key, {}); await new Promise<void>(resolve => finish = resolve); },
        ({ guildId, channelId, ownerId }: any) => `guild:${guildId}:${channelId}:${ownerId}`);
    const render = (channelId = "voice") => component({ room: "ana", channelId });
    assert.equal(render().props.disabled, false);
    assert.equal(render().props.variant, "primary");
    assert.equal(render("other-channel").props.disabled, true);
    const connection = render().props.onClick();
    assert.equal(render().props.disabled, true);
    assert.equal(render().props.variant, "secondary");
    assert.deepEqual(render().children, ["Assistindo"]);
    await render().props.onClick();
    assert.equal(calls, 1);
    assert.equal(fockyStreams.has("guild:guild:voice:owner"), true);
    finish(); await connection;
    assert.equal(render().props.disabled, true);
    watching.clear();
    assert.equal(render().props.disabled, false, "Leaving the stream makes the button available again");
    assert.equal(render().props.variant, "primary");
});

test("only bot announcements with the FockyTV author marker get a watch button", () => {
    const method = source.slice(source.indexOf("    renderMessageAccessory("), source.indexOf("    streamSettings,"));
    const render = new Function("React", "LiveAnnouncementButton", "routingEnabled", javascript(`const plugin = { ${method} };`) + "return plugin.renderMessageAccessory;")(
        React, "watch-button", true);
    const message = { channel_id: "voice", author: { bot: true }, embeds: [{ author: { name: "ana está ao vivo no FockyTV" } }] };
    assert.deepEqual(render({ message }).props, { room: "ana", channelId: "voice" });
    assert.equal(render({ message: { ...message, author: { bot: false } } }), null);
    assert.equal(render({ message: { ...message, embeds: [{ author: { name: "unrelated" } }] } }), null);
    assert.equal(render({ message: { ...message, embeds: [] } }), null);
});

test("simple share switch preserves the current mode and bypasses native capture for the next share", async () => {
    const store = { nativeCapture: true, annotations: true };
    const method = source.slice(source.indexOf("function streamSettings("), source.indexOf("// O bot avisa", source.indexOf("function streamSettings(")));
    const menu = (enabled: boolean, sandbox: Record<string, unknown> = {}) => new Function("React", "Menu", "settings", "routingEnabled", "UserStore", "discordShare", "publishers", "annotationBoardFor",
        javascript(method) + "return streamSettings;")(
        React, { MenuCheckboxItem: "checkbox" }, { store }, enabled,
        sandbox.UserStore ?? { getCurrentUser: () => null }, sandbox.discordShare ?? null,
        sandbox.publishers ?? new Map(), sandbox.annotationBoardFor);
    assert.equal(menu(false)("quality"), "quality");
    const render = menu(true);
    let [original, toggle] = render("quality");
    assert.equal(original, "quality");
    assert.equal(toggle.props.checked, false);
    toggle.props.action();
    assert.equal(store.nativeCapture, false);
    assert.equal(render("quality")[1].props.checked, true);

    // Checkbox de anotações: só transmitindo, e o action alterna o board do dono.
    let allowed = true;
    const board = { snapshot: () => ({ allowed }), allow: (value: boolean) => { allowed = value; } };
    const presenting = menu(true, { UserStore: { getCurrentUser: () => ({ id: "me" }) }, discordShare: { channelId: "voice" },
        publishers: new Map([["screen", {}]]), annotationBoardFor: () => board });
    store.annotations = false;
    assert.equal(presenting("quality").length, 2, "configuração desligada esconde o checkbox");
    store.annotations = true;
    assert.equal(presenting("quality").length, 3);
    assert.equal(presenting("quality")[2].props.checked, true);
    presenting("quality")[2].props.action();
    assert.equal(allowed, false);
    assert.equal(presenting("quality")[2].props.checked, false);
    // Sem transmitir (ou sem dono), o item não aparece.
    assert.equal(render("quality").length, 2);
    assert.equal(menu(true, { UserStore: { getCurrentUser: () => null }, discordShare: { channelId: "voice" }, publishers: new Map([["screen", {}]]) })("quality").length, 2);

    let started = 0;
    const tryNative = new Function("IS_WINDOWS", "settings", "nativeSource", "publishers", "pending", "publishNative",
        javascript(source.slice(source.indexOf("async function tryNative("), source.indexOf("async function publish("))) + "return tryNative;")(
        true, { store }, () => "monitor:0", new Map(), new Set(), async () => { started++; });
    assert.equal(await tryNative({ id: "screen:0:0" }, {}), false);
    assert.equal(started, 0);
    render("quality")[1].props.action();
    assert.equal(await tryNative({ id: "screen:0:0" }, {}), true);
    assert.equal(started, 1);
});

test("sharing mode appears in the source picker and the active stream menu with a label", () => {
    const callback = source.slice(source.indexOf("    contextMenus: {") + "    contextMenus: ".length, source.indexOf("    managedStyle,")).trim().replace(/,$/, "");
    const menus = (enabled: boolean) => new Function("React", "Menu", "routingEnabled", "streamSettings", "callMenu", "cameraMenu",
        javascript(`const menus = ${callback};`) + "return menus;")(React, { MenuGroup: "group" }, enabled, (children: unknown) => [children, "toggle"], () => {}, () => {});
    const children: unknown[] = ["presets", "fps"];
    menus(false)["stream-options"](children);
    assert.equal(children.length, 2);
    menus(true)["stream-options"](children);
    assert.equal(children.length, 3);
    assert.deepEqual(nodes(children).find(node => node.type === "group").children, [[null, "toggle"]]);

    const patch = discordPatches.find(patch => patch.find === '\"stream-settings-fps\"')!;
    const replacement = (patch.replacement as { match: RegExp; replace: string; }[]).find(item => item.replace.includes("streamSettings"))!;
    const match = new RegExp(replacement.match.source.replaceAll(String.raw`\i`, String.raw`[A-Za-z_$][\w$]*`), replacement.match.flags);
    for (const label of ["", 'label:N.intl.string(N.t.ytAD9d),']) {
        const code = `{id:"stream-settings",${label}children:W}`;
        assert.equal(code.replace(match, replacement.replace), `{id:"stream-settings",${label}children:$self.streamSettings(W)}`);
    }
});

test("webcam and screen tiles expose PiP for their own media; replay stays on screen shares", () => {
    const pip: unknown[] = [], replays: string[] = [];
    const webcam = {}, screen = {};
    const create = new Function("React", "useRef", "useEffect", "cameraViewers", "watching", "publishers", "togglePictureInPicture", "saveReplay", "discordShare", "settings", `
        const setWatchVolume = () => {};
        const lyricsStreamId = 'fockytv-lyrics', partyStreamId = 'fockytv-watch-party', watch = 'watch', WatchControls = 'WatchControls';
        const localTiles = new Map([[partyStreamId, { media: {} }]]);
        const cameraStreamId = 'fockytv-camera', watchCameraPrefix = 'fockytv-camera:', watchStreamPrefix = 'fockytv-watch:', previewStreamId = 'fockytv-preview';
        const AnnotationLayer = 'AnnotationLayer';
        const annotationBoardFor = target => ({ target });
        const ownerOf = key => key.split(':').pop();
        const UserStore = { getCurrentUser: () => ({ id: 'me' }) };
        ${javascript(source.slice(source.indexOf("function PreviewVideo("), source.indexOf("// Picture-in-picture num")))}
        return PreviewVideo;
    `);
    const preview = create(React, () => ({ current: null }), () => {},
        new Map([["user", { viewing: { media: webcam } }]]),
        new Map([["live", { viewing: { media: screen }, replay: {} }], ["guild:guild:voice:owner", { viewing: { media: {} } }]]), new Map(),
        (media: unknown) => pip.push(media), (key: string) => replays.push(key), null, { store: { annotations: true } });
    const cameraNodes = nodes(preview({ streamId: "fockytv-camera:user" }));
    cameraNodes.find(node => node.props["aria-label"] === "Picture-in-picture").props.onClick();
    assert.deepEqual(pip, [webcam]);
    assert.equal(cameraNodes.filter(node => node.type === "button").length, 1);
    const screenNodes = nodes(preview({ streamId: "fockytv-watch:live" }));
    screenNodes.find(node => node.props["aria-label"] === "Picture-in-picture").props.onClick();
    screenNodes.find(node => node.props.title?.startsWith("Salvar")).props.onClick();
    assert.deepEqual(pip, [webcam, screen]);
    assert.deepEqual(replays, ["live"]);
    assert.equal(nodes(preview({ streamId: "fockytv-camera:missing" })).some(node => node.type === "button"), false);
    assert.equal(nodes(preview({ streamId: "fockytv-watch-party" })).find(node => node.type === "WatchControls")?.props.player, "watch", "Watch party tile carries play/pause and seek");
    assert.equal(nodes(preview({ streamId: "fockytv-watch:guild:guild:voice:owner" })).find(node => node.type === "AnnotationLayer")?.props.board.target, "owner", "live assistida carrega a camada de anotações do dono");
    assert.equal(nodes(preview({ streamId: "fockytv-preview" })).some(node => node.type === "AnnotationLayer"), false, "sem transmissão o preview não tem camada");
    const presenting = (annotations: boolean) => create(React, () => ({ current: null }), () => {},
        new Map(), new Map(), new Map(), () => {}, () => {}, { channelId: "voice" }, { store: { annotations } });
    assert.deepEqual(nodes(presenting(true)({ streamId: "fockytv-preview" })).find(node => node.type === "AnnotationLayer")?.props.board, { target: "me" }, "preview do apresentador recebe as anotações de quem assiste");
    assert.equal(nodes(presenting(false)({ streamId: "fockytv-preview" })).some(node => node.type === "AnnotationLayer"), false, "anotações desligadas não montam a camada");
});

test("PiP windows stay independent, toggle individually and cancel pending opens", async () => {
    const windows: any[] = [], alerts: unknown[] = [];
    let prepare: () => Promise<void> = async () => {};
    let failOpen = false, failPlay = false;
    const create = new Function("Native", "window", "crypto", "showNotification", "console", `
        ${javascript(source.slice(source.indexOf("const pipWindows ="), source.indexOf("async function saveReplay(")))}
        return { togglePictureInPicture, closePictureInPicture, pipWindows };
    `);
    const api = create({ preparePictureInPicture: () => prepare() }, {
        open: (_url: string, name: string) => {
            if (failOpen) return null;
            const listeners: Record<string, () => void> = {};
            const popup: any = {
                name, closed: false,
                document: { body: { style: {}, append() {} }, createElement: () => ({ style: {}, play: async () => { if (failPlay) throw Error("play failed"); } }) },
                addEventListener: (event: string, callback: () => void) => { listeners[event] = callback; },
                close() { this.closed = true; listeners.pagehide?.(); }
            };
            windows.push(popup);
            return popup;
        }
    }, { randomUUID: () => String(windows.length) }, (alert: unknown) => alerts.push(alert), { warn() {} });
    const camera = {}, screen = {};
    await api.togglePictureInPicture(camera);
    await api.togglePictureInPicture(screen);
    assert.equal(windows.length, 2);
    assert.notEqual(windows[0].name, windows[1].name);
    assert.equal(windows[0].closed, false, "Opening another device keeps the first window");
    const cameraVideo = api.pipWindows.get(camera).video;
    assert.equal(cameraVideo.srcObject, camera);
    assert.equal(cameraVideo.muted, true, "Audio remains in the existing playback path");
    await api.togglePictureInPicture(camera);
    assert.equal(windows[0].closed, true);
    assert.equal(cameraVideo.srcObject, null);
    assert.equal(windows[1].closed, false);
    windows[1].close();
    assert.equal(api.pipWindows.size, 0, "Closing through the window releases its entry");
    await api.togglePictureInPicture(screen);
    await api.togglePictureInPicture(camera);
    api.closePictureInPicture(screen);
    assert.equal(api.pipWindows.has(camera), true, "Ending one stream leaves the other PiP open");
    api.closePictureInPicture();
    assert.equal(api.pipWindows.size, 0);
    assert.ok(windows.every(popup => popup.closed));
    let ready!: () => void;
    prepare = () => new Promise<void>(resolve => { ready = resolve; });
    const pending = api.togglePictureInPicture(camera);
    api.closePictureInPicture(camera);
    ready();
    await pending;
    assert.equal(windows.length, 4, "Cancelled opens cannot create orphan windows");
    prepare = async () => {};
    failOpen = true;
    await api.togglePictureInPicture(camera);
    assert.equal(api.pipWindows.size, 0);
    failOpen = false;
    failPlay = true;
    await api.togglePictureInPicture(camera);
    assert.equal(api.pipWindows.size, 0);
    assert.equal(windows.at(-1).closed, true);
    assert.equal(alerts.length, 2, "Failures notify and allow retrying");
});

test("cancelling a loading screen share does not close other PiPs", () => {
    const closed: unknown[] = [];
    const controller = new AbortController();
    const watching = new Map<string, any>([["pending", { controller }], ["ready", { controller: new AbortController(), viewing: { media: "screen", close() {} } }]]);
    const create = new Function("watching", "closePictureInPicture", `
        const syncActivity = () => {}, logVideoEvent = () => {};
        ${javascript(source.slice(source.indexOf("function closeViewing("), source.indexOf("function endWatch(")))}
        return closeViewing;
    `);
    const close = create(watching, (media: unknown) => closed.push(media));
    assert.equal(close("pending"), true);
    assert.equal(controller.signal.aborted, true);
    assert.equal(watching.get("ready").controller.signal.aborted, false, "Other watched lives keep their connection");
    assert.deepEqual(closed, []);
    assert.equal(close("ready"), true);
    assert.deepEqual(closed, ["screen"]);
});

test("native PiP setup pins only the plugin's blank popouts and registers once", () => {
    const native = readFileSync(new URL("./native.ts", import.meta.url), "utf8");
    const create = new Function(javascript(native.slice(native.indexOf("const pipOwners ="), native.indexOf("const pickerConfig =")).replace("export function", "function")) + "; return preparePictureInPicture;");
    let registrations = 0, listener: any;
    const discordHandler = (details: { url: string; }) => ({ action: details.url === "https://discord.com/popout" ? "allow" : "deny" });
    const sender: any = {
        _windowOpenHandler: discordHandler,
        setWindowOpenHandler(handler: unknown) { this._windowOpenHandler = handler; },
        on: (event: string, callback: unknown) => { assert.equal(event, "did-create-window"); registrations++; listener = callback; }
    };
    const prepare = create();
    prepare({ sender });
    const wrapped = sender._windowOpenHandler;
    prepare({ sender });
    assert.equal(registrations, 1);
    assert.equal(sender._windowOpenHandler, wrapped, "não embrulha o próprio embrulho");
    const open = (url: string, frameName: string) => sender._windowOpenHandler({ url, frameName }).action;
    assert.equal(open("about:blank", "fockytv-pip-12345678-1234-1234-1234-123456789abc"), "allow", "o Discord nega about:blank; o PiP passa");
    assert.equal(open("about:blank", "outro"), "deny");
    assert.equal(open("https://discord.com/popout", "DISCORD_x"), "allow", "o resto segue o handler do Discord");
    sender._windowOpenHandler = discordHandler; // o Discord trocou o handler: o próximo PiP embrulha de novo
    prepare({ sender });
    assert.equal(open("about:blank", "fockytv-pip-12345678-1234-1234-1234-123456789abc"), "allow");
    const calls: unknown[] = [];
    const popup = { setAlwaysOnTop: (value: boolean) => calls.push(value), setMenuBarVisibility: (value: boolean) => calls.push(value), setMinimumSize: (...size: number[]) => calls.push(size) };
    const frameName = "fockytv-pip-12345678-1234-1234-1234-123456789abc";
    listener(popup, { url: "https://example.com", frameName });
    listener(popup, { url: "about:blank", frameName: "unrelated" });
    assert.deepEqual(calls, []);
    listener(popup, { url: "about:blank", frameName });
    assert.deepEqual(calls, [true, false, [160, 90]]);
});

test("update alerts retry failed delivery and notify each new revision once", async () => {
    const alerts: any[] = [];
    let available = true, revision = "new", fail = true, opened = 0;
    const create = new Function("React", "Native", "showNotification", "openPanel", "UpdateNotice", "console", `
        let routingEnabled = true, notifiedRevision = '', updateChecking = false, updateQueued = false;
        const versionLabel = value => 'v' + value;
        ${javascript(source.slice(source.indexOf("async function notifyUpdate("), source.indexOf("function StreamDiagnostics(")))}
        return { notifyUpdate, disable: () => routingEnabled = false };
    `);
    const api = create(React, { checkUpdate: async () => ({ available, revision, version: 10, current: 9, changes: ["Fix"] }) },
        async (alert: unknown) => { if (fail) { fail = false; throw Error("notification failed"); } alerts.push(alert); },
        () => opened++, "UpdateNotice", { warn() {} });
    await api.notifyUpdate();
    assert.equal(alerts.length, 0);
    await api.notifyUpdate();
    assert.equal(alerts.length, 1, "A failed delivery must remain retryable");
    await api.notifyUpdate();
    assert.equal(alerts.length, 1, "Do not repeat the same revision");
    const alert = alerts[0];
    assert.notEqual(alert.permanent, true, "An update must not block Vencord's notification queue");
    assert.equal(alert.richBody.type, "UpdateNotice", "The alert carries the install button");
    alert.onClick();
    assert.equal(opened, 1, "The alert opens the panel with the install controls");
    revision = "newer";
    available = false;
    await api.notifyUpdate();
    assert.equal(alerts.length, 1);
    available = true;
    await api.notifyUpdate();
    assert.equal(alerts.length, 2);
    api.disable();
    revision = "newest";
    await api.notifyUpdate();
    assert.equal(alerts.length, 2);
});

test("push during an update check queues one refresh and never duplicates an alert", async () => {
    let checks = 0, release: (() => void) | undefined;
    const alerts: any[] = [];
    const create = new Function("React", "Native", "showNotification", "openPanel", "UpdateNotice", "console", `
        let routingEnabled = true, notifiedRevision = '', updateChecking = false, updateQueued = false;
        const versionLabel = value => 'v' + value;
        ${javascript(source.slice(source.indexOf("async function notifyUpdate("), source.indexOf("function StreamDiagnostics(")))}
        return { notifyUpdate, disable: () => routingEnabled = false };
    `);
    const api = create(React, { checkUpdate: async () => {
        checks++;
        if (checks === 1) { await new Promise<void>(resolve => { release = resolve; }); return { available: false, revision: "old" }; }
        return { available: true, revision: "new" };
    } }, async (alert: unknown) => { alerts.push(alert); }, () => {}, "UpdateNotice", { warn() {} });
    const first = api.notifyUpdate();
    await api.notifyUpdate(); await api.notifyUpdate();
    assert.equal(checks, 1, "Concurrent hints do not fan out into GitHub requests");
    release!(); await first;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(checks, 2, "A hint received during the check must not be lost");
    assert.equal(alerts.length, 1);
    await api.notifyUpdate();
    assert.equal(alerts.length, 1);
    api.disable(); await api.notifyUpdate();
    assert.equal(checks, 3, "Stopped plugin does not request updates");
});

test("update alert installs directly without nesting a button or opening the panel", async () => {
    let installs = 0, stopped = 0;
    const states: unknown[] = [];
    const create = new Function("React", "useState", "Native", "UpdateDetails", `
        ${javascript(source.slice(source.indexOf("function UpdateNotice("), source.indexOf("function UpdateControls(")))}
        return UpdateNotice;
    `);
    const UpdateNotice = create(React, (initial: unknown) => [initial, (value: unknown) => states.push(value)],
        { installUpdate: async () => { installs++; return { started: true }; } }, "UpdateDetails");
    const tree = nodes(UpdateNotice({ update: { available: true, revision: "new" } }));
    assert.equal(tree.some(node => node.type === "button"), false, "Vencord already renders notifications inside a button");
    const action = tree.find(node => node.props.role === "button");
    assert.equal(action.children.join(""), "Atualizar agora");
    await action.props.onClick({ stopPropagation: () => stopped++, preventDefault() {} });
    assert.equal(installs, 1);
    assert.equal(stopped, 1, "Clicking the button must not trigger the alert's open-panel click");
    assert.deepEqual(states.filter(value => typeof value === "string" && value !== ""), ["busy", "started"]);
});


test("GitHub PR alerts poll the selected repo with the local token and open the PR link on click", async () => {
    const store: Record<string, string> = { githubToken: "configured", githubRepository: "dona/projeto" };
    const calls: unknown[][] = [], notifications: { title: string; body: string; onClick: () => void; }[] = [], opened: string[] = [];
    let wired: { request: (repository: string, since: string) => Promise<unknown>; getRepository: () => string; onAlert: (alert: { title: string; body: string; url: string; }) => void; } | undefined;
    const start = source.indexOf("stopGithubAlerts = watchGithubAlerts(");
    const end = source.indexOf("\n        });", start) + "\n        });".length;
    const wire = new Function("watchGithubAlerts", "githubAlertsRequest", "settings", "showNotification", "VencordNative", `let stopGithubAlerts; ${javascript(source.slice(start, end))}\nreturn stopGithubAlerts;`);
    const stop = wire(
        (request: any, getRepository: () => string, onAlert: any) => { wired = { request, getRepository, onAlert }; return () => {}; },
        (repository: string, since: string) => { calls.push([store.githubToken, repository, since]); return Promise.resolve({}); },
        { store }, (alert: { title: string; body: string; url: string; }) => notifications.push(alert),
        { native: { openExternal: (url: string) => opened.push(url) } });
    assert.ok(wired);
    assert.equal(wired!.getRepository(), "dona/projeto");
    await wired!.request("dona/outro", "2026-10-27T12:00:00Z");
    assert.deepEqual(calls[0], ["configured", "dona/outro", "2026-10-27T12:00:00Z"], "Token and window travel with every request");
    wired!.onAlert({ title: "FockyTV: PR mergeado", body: "#7 · Feito", url: "https://github.com/dona/projeto/pull/7" });
    assert.equal(notifications.length, 1);
    assert.deepEqual(opened, [], "Receiving an alert must not open the browser");
    notifications[0].onClick();
    assert.deepEqual(opened, ["https://github.com/dona/projeto/pull/7"]);
    for (const token of ["", "   "]) {
        store.githubToken = token;
        assert.equal(wired!.getRepository(), "", "No local token: nothing to watch");
        wired!.onAlert({ title: "x", body: "y", url: "https://github.com/dona/projeto/pull/7" });
        assert.equal(notifications.length, 1, "Only clients with a local token show GitHub alerts");
    }
    assert.equal(typeof stop, "function");
    assert.ok(source.includes("stopGithubAlerts?.();\n        stopGithubAlerts = undefined;"), "stop() releases the alert watcher");
});

test("watch party button stays active while watching and canvas controls change local volume or leave", () => {
    let watching = true, volume = 0, next = 0;
    const player = { snapshot: () => ({ watching, connected: true, state: { playing: true, queue: [{}, {}] }, volume: 0.5 }),
        duration: () => 100, position: () => 20, next: () => next++, listen: (on: boolean) => { watching = on; } };
    const createButton = new Function("React", "Tooltip", "useWatch", "watch", "openWatch", `${javascript(source.slice(source.indexOf("function WatchButton("), source.indexOf("function openPanel(")))}; return WatchButton;`);
    const button = createButton(React, "tooltip", () => player.snapshot(), player, () => {});
    const primaryButton = () => button().children[0].children[0]({});
    const active = primaryButton();
    assert.equal(active.props["aria-pressed"], true);
    assert.match(active.props.className, /is-playing/);
    const panelSource = readFileSync(new URL("./watch-party-panel.tsx", import.meta.url), "utf8");
    const createControls = new Function("React", "useWatch", "useState", "useRef", "useEffect", "formatTime", `${javascript(panelSource.slice(panelSource.indexOf("export function WatchControls("), panelSource.indexOf("export function WatchPartyPanel(")).replace("export ", ""))}; return WatchControls;`);
    const lastVolume = { current: 0.5 };
    const controls = createControls(React, () => player.snapshot(), () => [undefined, () => {}], () => lastVolume, (effect: () => void) => effect(), String);
    const tree = controls({ player, setVolume: (value: number) => { volume = value; } });
    const [top, bar] = tree.children.filter((node: any) => node?.type === "div");
    assert.equal(top.children[0].props.className, "fockytv-watch-status", "título fica no topo à esquerda");
    assert.equal(top.children[1].children[0], "Sair da watch party", "sair fica no topo à direita");
    assert.equal(bar.children.at(-1).children[0], "Próximo", "controles de reprodução ficam numa linha embaixo");
    const elements = nodes(tree);
    elements.find(node => node.props["aria-label"] === "Volume do vídeo").props.onChange({ currentTarget: { value: "35" } });
    assert.equal(volume, 0.35);
    elements.find(node => node.props["aria-label"] === "Silenciar vídeo").props.onClick();
    assert.equal(volume, 0);
    const mutedPlayer = { ...player, snapshot: () => ({ ...player.snapshot(), volume: 0 }) };
    const mutedControls = createControls(React, () => mutedPlayer.snapshot(), () => [undefined, () => {}], () => lastVolume, (effect: () => void) => effect(), String);
    nodes(mutedControls({ player: mutedPlayer, setVolume: (value: number) => { volume = value; } })).find(node => node.props["aria-label"] === "Ativar som do vídeo").props.onClick();
    assert.equal(volume, 0.5, "reativar som restaura o último volume");
    elements.find(node => node.type === "button" && node.children[0] === "Próximo").props.onClick();
    assert.equal(next, 1);
    elements.find(node => node.type === "button" && node.children[0] === "Sair da watch party").props.onClick();
    assert.equal(primaryButton().props["aria-pressed"], false);
    assert.equal(nodes(button()).some(node => node.props["aria-label"] === "Sair da watch party"), false);
    player.listen(true);
    nodes(button()).find(node => node.props["aria-label"] === "Sair da watch party").props.onClick();
    assert.equal(watching, false, "Sair no painel de voz encerra a participação sem abrir o modal");
    assert.equal(nodes(button()).some(node => node.props["aria-label"] === "Sair da watch party"), false);
});

test("watch party modal leaves and rejoins without closing and formats the playlist", () => {
    const panelSource = readFileSync(new URL("./watch-party-panel.tsx", import.meta.url), "utf8");
    const snapshot = { channel: "call", watching: true, connected: true, title: "Título atual", state: { queue: [
        { uid: "1", id: "a", title: "Primeiro" }, { uid: "2", id: "b", title: "Segundo" }
    ] } };
    let closed = false;
    const player = { listen: (on: boolean) => { snapshot.watching = on; } };
    const create = new Function("React", "Modal", "Search", "useState", "useEffect", "useWatch", "youtubeId", `
        ${javascript(panelSource.slice(panelSource.indexOf("export function WatchPartyPanel(")).replace("export ", ""))}
        return WatchPartyPanel;
    `);
    const panel = create(React, "modal", "search", () => ["", () => {}], (effect: () => void) => effect(), () => snapshot, () => null);
    const render = () => nodes(panel({ player, music: {}, onClose: () => { closed = true; } }));
    const elements = render();
    elements.find(node => node.type === "button" && node.children[0] === "Sair da watch party").props.onClick();
    assert.equal(snapshot.watching, false);
    assert.equal(closed, false);
    const join = render().find(node => node.type === "button" && node.children[0] === "Entrar na watch party");
    assert.match(join.props.className, /fockytv-music-primary/);
    join.props.onClick();
    assert.equal(snapshot.watching, true);
    assert.deepEqual(elements.filter(node => node.type === "strong").map(node => node.children[0]), ["Título atual", "Segundo"]);
    assert.equal(elements.find(node => node.type === "h3").children[1].children[0], 2);
    assert.equal(elements.filter(node => node.type === "li" && node.props.className.includes("is-current")).length, 1);
    snapshot.state.queue = [];
    assert.ok(render().some(node => node.children[0] === "A playlist está vazia. Adicione um vídeo para começar."));
});

test("voice list watch badge follows server viewers and local departure", () => {
    const snapshot = { viewers: ["222222"], watching: true };
    const create = new Function("React", "useState", "useEffect", "useWatch", "watch", "UserStore", "EyeIcon", `
        const ftvUsers = new Set(), ftvListeners = new Set();
        ${javascript(source.slice(source.indexOf("function WatchTag("), source.indexOf("let modalKey:", source.indexOf("function WatchTag("))))}
        return WatchTag;
    `);
    const joined: boolean[] = [];
    const tag = create(React, () => [0, () => {}], () => {}, () => snapshot, { listen: (on: boolean) => joined.push(on) }, { getCurrentUser: () => ({ id: "111111" }) }, "eye");
    const hasBadge = (id: string) => nodes(tag({ user: { id } })).some(node => node.props["aria-label"] === "Assistindo à watch party");
    assert.equal(hasBadge("111111"), true);
    assert.equal(hasBadge("222222"), true);
    assert.equal(hasBadge("333333"), false);
    snapshot.watching = false;
    const joinButton = nodes(tag({ user: { id: "222222" } })).find(node => node.type === "button" && node.props["aria-label"] === "Juntar-se à watch party");
    assert.ok(joinButton, "quem não participa pode se juntar pelo selo");
    let stopped = false;
    joinButton.props.onClick({ stopPropagation: () => { stopped = true; } });
    assert.deepEqual(joined, [true]);
    assert.equal(stopped, true, "clique não abre o perfil do usuário");
    snapshot.viewers = [];
    assert.equal(hasBadge("111111"), false);
    assert.equal(hasBadge("222222"), false);
});


test("voice list music badge follows listeners and joins the music without opening a profile", () => {
    const snapshot: { state: { listeners: string[]; } | null; listening: boolean; } = { state: { listeners: ["222222", "111111"] }, listening: true };
    const create = new Function("React", "useMusic", "music", "UserStore", "MusicIcon", `
        ${javascript(source.slice(source.indexOf("function MusicTag("), source.indexOf("let modalKey:")))}
        return MusicTag;
    `);
    const joined: boolean[] = [];
    const tag = create(React, () => snapshot, { listen: (on: boolean) => joined.push(on) }, { getCurrentUser: () => ({ id: "111111" }) }, "music");
    const hasBadge = (id: string) => nodes(tag({ user: { id } })).some(node => node.props["aria-label"] === "Ouvindo música na call");
    assert.equal(hasBadge("111111"), true);
    assert.equal(hasBadge("222222"), true);
    assert.equal(hasBadge("333333"), false);
    assert.equal(nodes(tag({ user: { id: "222222" } })).some(node => node.type === "button"), false);
    snapshot.listening = false;
    assert.equal(hasBadge("111111"), false, "local departure overrides stale server listeners");
    const joinButton = nodes(tag({ user: { id: "222222" } })).find(node => node.type === "button" && node.props["aria-label"] === "Juntar-se à música");
    assert.ok(joinButton);
    let stopped = false;
    joinButton.props.onClick({ stopPropagation: () => { stopped = true; } });
    assert.deepEqual(joined, [true]);
    assert.equal(stopped, true);
    snapshot.state = null;
    assert.equal(hasBadge("222222"), false, "leaving the channel clears remote badges");
    assert.match(source, /watchTag:.*<WatchTag user=\{user\} \/><MusicTag user=\{user\} \/>/);
});

test("watch badge is inserted after the Discord name and guild tag wrapper", () => {
    const patch = discordPatches.find(patch => Array.isArray(patch.replacement) && patch.replacement.some(replacement => replacement.replace.includes("$self.watchTag")))!;
    const fixture = 'children:[(n=(0,i.jsxs)("div",{children:[z??W.Ay.getName(et),w?(0,i.jsxs)("span",{children:[" ",intl.GUEST_NAME_SUFFIX]}):""]}),l={primaryGuild:et.primaryGuild,userId:et.id,contextGuildId:K,isOverlay:h,disableTooltip:!0,className:ee.fc},!_||h?(0,i.jsx)(GuildTag,{...l,children:n}):null),(0,i.jsx)(VoiceIcons,{disabled:x,...g,isHovered:ec})]';
    let output = fixture;
    for (const replacement of patch.replacement as { match: RegExp; replace: string; }[]) {
        const match = new RegExp(replacement.match.source.replaceAll(String.raw`\i`, String.raw`[A-Za-z_$][\w$]*`));
        assert.equal([...output.matchAll(new RegExp(match, "g"))].length, 1);
        output = output.replace(match, replacement.replace);
    }
    assert.ok(output.indexOf("$self.ftvTag(et)") < output.indexOf("GuildTag"));
    assert.ok(output.indexOf("GuildTag") < output.indexOf("$self.watchTag(et)"));
    assert.ok(output.indexOf("$self.watchTag(et)") < output.indexOf("VoiceIcons"));
});
