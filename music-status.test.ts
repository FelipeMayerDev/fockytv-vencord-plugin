// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transformSync } from "esbuild";

test("voice music status follows listeners, playback, channel and local exit", () => {
    const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
    const start = source.indexOf("function MusicStatus(");
    const component = transformSync(source.slice(start, source.indexOf("\n}", start) + 2), { loader: "tsx", jsxFactory: "React.createElement" }).code;
    const user = { id: "remote", username: "username", globalName: "Pessoa" };
    const snapshot = {
        channel: "call", listening: true,
        current: { title: "Música", channel: "Artista" },
        state: { playing: true, ready: true, listeners: ["Pessoa"] }
    };
    let voiceChannel = "call", listener: (() => void) | undefined, updates = 0;
    const effects: (() => void)[] = [];
    const create = new Function("React", "useState", "useEffect", "music", "VoiceStateStore", "UserStore", `${component}; return MusicStatus;`);
    const render = create({ createElement: (_: string, props: unknown, ...children: unknown[]) => ({ props, children }) },
        () => [0, () => updates++], (fn: () => () => void) => effects.push(fn()),
        { snapshot: () => snapshot, subscribe: (fn: () => void) => { listener = fn; return () => { listener = undefined; }; } },
        { getVoiceStateForUser: () => ({ channelId: voiceChannel }) }, { getCurrentUser: () => ({ id: "me" }) });

    assert.deepEqual(render({ user }), {
        props: { className: "fockytv-music-status", title: "Ouvindo Música — Artista" }, children: ["🎵 Ouvindo música"]
    });
    listener?.();
    assert.equal(updates, 1, "Server state changes request a re-render");
    snapshot.state.listeners = [];
    assert.equal(render({ user }), null);
    snapshot.state.listeners = ["username"];
    assert.ok(render({ user: { ...user, globalName: undefined } }), "Users without a global name use their username");
    assert.ok(render({ user: { ...user, id: "me" } }), "Local listening updates without waiting for the server");
    snapshot.listening = false;
    assert.equal(render({ user: { ...user, id: "me" } }), null);
    snapshot.state.listeners = ["Pessoa"];
    snapshot.state.playing = false;
    assert.equal(render({ user }), null);
    snapshot.state.playing = true;
    snapshot.state.ready = false;
    assert.equal(render({ user }), null);
    snapshot.state.ready = true;
    voiceChannel = "other";
    assert.equal(render({ user }), null);
    voiceChannel = "call";
    assert.equal(render({ user: { ...user, globalName: "Outra pessoa" } }), null);
    snapshot.channel = "";
    assert.equal(render({ user }), null);
    effects.forEach(cleanup => cleanup());
    assert.equal(listener, undefined, "Unmounting removes the player subscription");
});
