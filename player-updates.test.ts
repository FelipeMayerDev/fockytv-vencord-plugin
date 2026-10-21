import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transformSync } from "esbuild";

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
});

test("update alerts retry failed delivery and notify each new revision once", async () => {
    const alerts: any[] = [];
    let available = true, revision = "new", fail = true, opened = 0;
    const create = new Function("React", "Native", "showNotification", "openPanel", "UpdateDetails", "console", `
        let routingEnabled = true, notifiedRevision = '';
        const versionLabel = value => 'v' + value;
        ${javascript(source.slice(source.indexOf("async function notifyUpdate("), source.indexOf("function StreamDiagnostics(")))}
        return { notifyUpdate, disable: () => routingEnabled = false };
    `);
    const api = create(React, { checkUpdate: async () => ({ available, revision, version: 10, current: 9, changes: ["Fix"] }) },
        async (alert: unknown) => { if (fail) { fail = false; throw Error("notification failed"); } alerts.push(alert); },
        () => opened++, "UpdateDetails", { warn() {} });
    await api.notifyUpdate();
    assert.equal(alerts.length, 0);
    await api.notifyUpdate();
    assert.equal(alerts.length, 1, "A failed delivery must remain retryable");
    await api.notifyUpdate();
    assert.equal(alerts.length, 1, "Do not repeat the same revision");
    const alert = alerts[0];
    assert.notEqual(alert.permanent, true, "An update must not block Vencord's notification queue");
    assert.equal(nodes(alert.richBody).some(node => node.type === "button"), false, "Vencord already renders notifications inside a button");
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
