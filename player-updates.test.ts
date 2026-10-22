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
const nodes = (tree: any): any[] => tree && typeof tree === "object" ? [tree, ...tree.children.flatMap(nodes)] : [];

test("webcam and screen tiles expose PiP for their own media; replay stays on screen shares", () => {
    const pip: unknown[] = [], replays: string[] = [];
    const webcam = {}, screen = {};
    const create = new Function("React", "useRef", "useEffect", "cameraViewers", "watching", "publishers", "togglePictureInPicture", "saveReplay", `
        const setWatchVolume = () => {};
        const lyricsStreamId = 'fockytv-lyrics', partyStreamId = 'fockytv-watch-party', watch = 'watch', WatchControls = 'WatchControls';
        const localTiles = new Map([[partyStreamId, { media: {} }]]);
        const cameraStreamId = 'fockytv-camera', watchCameraPrefix = 'fockytv-camera:', watchStreamPrefix = 'fockytv-watch:';
        ${javascript(source.slice(source.indexOf("function PreviewVideo("), source.indexOf("// Picture-in-picture num")))}
        return PreviewVideo;
    `);
    const preview = create(React, () => ({ current: null }), () => {},
        new Map([["user", { viewing: { media: webcam } }]]),
        new Map([["live", { viewing: { media: screen }, replay: {} }]]), new Map(),
        (media: unknown) => pip.push(media), (key: string) => replays.push(key));
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


test("GitHub notifications open the validated PR or workflow link on click", () => {
    const alerts: any[] = [], opened: string[] = [];
    const start = source.indexOf("stopUpdateEvents = watchPluginUpdates(");
    const end = source.indexOf("\n        });", start) + "\n        });".length;
    const connect = new Function("watchPluginUpdates", "proxySocket", "Native", "settings", "notifyUpdate", "showNotification", "VencordNative", `let stopUpdateEvents; ${javascript(source.slice(start, end))}`);
    const notification = { title: "FockyTV: PR aberto", body: "#42 · Fix CI", url: "https://github.com/FelipeMayerDev/fockytv-vencord-plugin/pull/42" };
    connect((_socket: unknown, _base: string, _update: unknown, onGithub: (value: typeof notification) => void) => onGithub(notification),
        () => ({}), {}, { store: { url: "https://tv.example" } }, () => {}, (alert: unknown) => alerts.push(alert),
        { native: { openExternal: (url: string) => opened.push(url) } });
    assert.equal(alerts[0].title, notification.title);
    assert.equal(alerts[0].body, notification.body);
    assert.deepEqual(opened, [], "Receiving an event must not open the browser");
    alerts[0].onClick();
    assert.deepEqual(opened, [notification.url]);
});

test("watch party button stays active while watching and canvas controls change local volume or leave", () => {
    let watching = true, volume = 0, next = 0;
    const player = { snapshot: () => ({ watching, connected: true, state: { playing: true, queue: [{}, {}] }, volume: 0.5 }),
        duration: () => 100, position: () => 20, next: () => next++, listen: (on: boolean) => { watching = on; } };
    const createButton = new Function("React", "Tooltip", "useWatch", "watch", "openWatch", `${javascript(source.slice(source.indexOf("function WatchButton("), source.indexOf("function openPanel(")))}; return WatchButton;`);
    const button = createButton(React, "tooltip", () => player.snapshot(), player, () => {});
    const active = button().children[0]({});
    assert.equal(active.props["aria-pressed"], true);
    assert.match(active.props.className, /is-playing/);
    const panelSource = readFileSync(new URL("./watch-party-panel.tsx", import.meta.url), "utf8");
    const createControls = new Function("React", "useWatch", "useState", "useRef", "useEffect", "formatTime", `${javascript(panelSource.slice(panelSource.indexOf("export function WatchControls("), panelSource.indexOf("export function WatchPartyPanel(")).replace("export ", ""))}; return WatchControls;`);
    const lastVolume = { current: 0.5 };
    const controls = createControls(React, () => player.snapshot(), () => [undefined, () => {}], () => lastVolume, (effect: () => void) => effect(), String);
    const tree = controls({ player, setVolume: (value: number) => { volume = value; } });
    assert.equal(tree.children.filter((node: any) => node?.type === "div").length, 1, "todos os controles ficam na mesma linha");
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
    assert.equal(button().children[0]({}).props["aria-pressed"], false);
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
