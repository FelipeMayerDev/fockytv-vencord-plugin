// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

import { fockyActivity } from "./activity";
import type { musicPlayer } from "./music";

const snapshot: ReturnType<ReturnType<typeof musicPlayer>["snapshot"]> = {
    channel: "call", connected: true, listening: true, error: "",
    current: { uid: "1", id: "video", title: "Música", channel: "Artista", duration: 120, thumb: "", by: "user", byName: "User" },
    state: { queue: [], index: 0, playing: true, ready: true, position: 0, listeners: [] }
};

test("music requires listening, playing and ready; a live takes priority", () => {
    assert.deepEqual(fockyActivity(true, snapshot), {
        application_id: "1108588077900898414", name: "Música — Artista", details: "Música", state: "Artista", type: 2, flags: 1
    });
    assert.deepEqual(fockyActivity(true, snapshot, "Pessoa"), {
        application_id: "1108588077900898414", name: "a live de Pessoa", type: 3, flags: 1
    });
    assert.equal(fockyActivity(false, snapshot, "Pessoa"), null);
    for (const change of [
        { listening: false }, { current: undefined }, { state: null },
        { state: { ...snapshot.state!, playing: false } }, { state: { ...snapshot.state!, ready: false } }
    ]) assert.equal(fockyActivity(true, { ...snapshot, ...change }), null);
    assert.equal(fockyActivity(true, { ...snapshot, current: { ...snapshot.current!, title: "a".repeat(200) } })?.name.length, 128);
});

test("local RPC defers Flux dispatch, updates metadata, clears on disable/stop, and resumes music after watching", () => {
    const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
    const start = source.indexOf("function syncActivity()");
    const sync = source.slice(start, source.indexOf("\n}", start) + 2);
    const events: any[] = [];
    let pending: (() => void) | undefined;
    const watching = new Map<string, { viewing?: object; }>();
    const music = { snapshot: () => snapshot };
    const create = new Function("fockyActivity", "music", "watching", "FluxDispatcher", "setTimeout", "clearTimeout", `
        let routingEnabled = true, panelWatching = "", activityTimer, lastActivity = "";
        const settings = { store: { showActivity: true } };
        const ownerOf = key => key.split(":").pop();
        const liveOwners = new Map([["owner", "username"]]);
        const UserStore = { getUser: () => ({ globalName: "Pessoa", username: "username" }) };
        ${stripTypeScriptTypes(sync)}
        return { syncActivity, settings, panel: value => { panelWatching = value; syncActivity(); }, stop: () => { routingEnabled = false; syncActivity(); } };
    `);
    const api = create(fockyActivity, music, watching, { dispatch: (event: unknown) => events.push(event) },
        (fn: () => void) => { pending = fn; }, () => { pending = undefined; });
    const flush = () => { const fn = pending; pending = undefined; fn?.(); };
    api.syncActivity();
    assert.equal(events.length, 0, "Never dispatch inside the originating Flux event");
    flush();
    assert.equal(events.at(-1).type, "LOCAL_ACTIVITY_UPDATE");
    assert.equal(events.at(-1).socketId, "FockyTV");
    assert.equal(events.at(-1).activity.name, "Música — Artista");
    api.syncActivity(); flush();
    assert.equal(events.length, 1, "Unchanged radio messages do not republish RPC");
    music.snapshot = () => ({ ...snapshot, current: { ...snapshot.current!, title: "Outra" } });
    api.syncActivity(); flush();
    assert.equal(events.at(-1).activity.name, "Outra — Artista");
    watching.set("call:channel:owner", {});
    api.syncActivity(); flush();
    assert.equal(events.at(-1).activity.type, 2, "Connecting is not watching yet");
    watching.set("call:channel:owner", { viewing: {} });
    api.syncActivity(); flush();
    assert.equal(events.at(-1).activity.name, "a live de Pessoa");
    watching.clear();
    api.syncActivity(); flush();
    assert.equal(events.at(-1).activity.type, 2);
    api.panel("Streamer"); flush();
    assert.equal(events.at(-1).activity.name, "a live de Streamer");
    api.settings.store.showActivity = false;
    api.syncActivity(); flush();
    assert.equal(events.at(-1).activity, null);
    api.settings.store.showActivity = true;
    api.syncActivity(); flush();
    assert.equal(events.at(-1).activity.type, 3);
    api.panel(""); flush();
    music.snapshot = () => ({ ...snapshot, listening: false });
    api.syncActivity(); flush();
    assert.equal(events.at(-1).activity, null);
    api.panel("Streamer"); flush();
    api.stop(); flush();
    assert.equal(events.at(-1).activity, null);
    api.panel("Late connection"); flush();
    assert.equal(events.at(-1).activity, null, "Late callbacks cannot restore activity after stop");
});
