import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transformSync } from "esbuild";
import { liveStyle, liveStyles } from "./protocol";

const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
const javascript = (code: string) => transformSync(code, { loader: "tsx", jsxFactory: "React.createElement" }).code;

test("settings sections keep existing storage keys and native controls", () => {
    const definitions = new Function("definePluginSettings", "OptionType", javascript(
        source.slice(source.indexOf("const settings ="), source.indexOf("// Token como senha"))
    ) + "return settings;")((value: unknown) => value, { COMPONENT: "component", BOOLEAN: "boolean", SELECT: "select", STRING: "string", NUMBER: "number" });
    const keys = Object.keys(definitions);
    assert.ok(keys.indexOf("sharingSection") < keys.indexOf("nativeCapture"));
    assert.ok(keys.indexOf("experienceSection") < keys.indexOf("liveStyle"));
    assert.ok(keys.indexOf("integrationsSection") < keys.indexOf("githubToken"));
    assert.ok(keys.indexOf("advancedSection") < keys.indexOf("updateBranch"));
    assert.equal(definitions.url, undefined, "The server follows the channel instead of a client setting");
    assert.equal(definitions.nativeCapture.default, true);
    assert.equal(definitions.liveStyle.default, "rainbow");
    assert.equal(definitions.replayBuffer.default, false);
    assert.equal(definitions.nativeBitrate.options.find((option: any) => option.default).value, 8);
    assert.equal(definitions.githubToken.default, "");
    assert.equal(definitions.updateBranch.type, "select");
    assert.deepEqual(definitions.updateBranch.options.map((option: any) => option.value), ["main", "insider"]);
    assert.equal(definitions.updateBranch.options.find((option: any) => option.default).value, "main");
    assert.equal(definitions.bragaLastDeparture.hidden, true);
    assert.equal(definitions.liveTitle.type, "string", "Native field retains its existing persistence behavior");
});

test("style picker has a visible preview and accessible selection without changing preferences on mount", () => {
    let selected = "rainbow";
    const changes: string[] = [];
    const React = { createElement(type: any, props: any, ...children: any[]): any {
        if (type === "tooltip") return children[0]({});
        if (typeof type === "function") return type({ ...props, children });
        return { type, props: props ?? {}, children };
    } };
    const component = new Function("React", "useState", "settings", "liveStyle", "liveStyles", "Tooltip", "UserStore", javascript(
        source.slice(source.indexOf("function LiveStylePreview("), source.indexOf("const Native ="))
    ) + "return LiveStylePicker;")(
        React, () => [selected, (value: string) => selected = value], { store: { liveStyle: selected } }, liveStyle, liveStyles, "tooltip",
        { getCurrentUser: () => ({ globalName: "Pessoa", getAvatarURL: () => "" }) });
    const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === "object" ? [node, ...node.children.flatMap(nodes)] : [];
    let rendered = nodes(component({ setValue: (value: string) => changes.push(value) }));
    assert.equal(changes.length, 0);
    const buttons = rendered.filter(node => node.type === "button");
    assert.equal(buttons.length, Object.keys(liveStyles).length);
    assert.equal(buttons.filter(node => node.props["aria-pressed"]).length, 1);
    assert.ok(rendered.some(node => node.props.className === "fockytv-style-selected"));
    buttons.at(-1).props.onClick();
    assert.deepEqual(changes, ["noir"]);
    rendered = nodes(component({ setValue: (value: string) => changes.push(value) }));
    assert.equal(rendered.filter(node => node.type === "button").at(-1).props["aria-pressed"], true);
    assert.ok(rendered.some(node => node.type === "strong" && node.children.includes("Noir")));
});

test("server follows the plugin channel and update alerts always use main", () => {
    const store = { updateBranch: "main" };
    const { SERVERS, serverBase } = new Function("settings", `${source.slice(source.indexOf("const SERVERS ="), source.indexOf("\nfunction openPanel()"))}; return { SERVERS, serverBase };`)({ store });
    assert.equal(serverBase(), "https://fockytv.felipemayer.com.br");
    store.updateBranch = "insider";
    assert.equal(serverBase(), "https://fockytv-insider.felipemayer.com.br");
    store.updateBranch = "unknown";
    assert.equal(serverBase(), SERVERS.main);
    assert.match(source, /watchPluginUpdates\(proxySocket\(Native\), SERVERS\.main,/);
});
