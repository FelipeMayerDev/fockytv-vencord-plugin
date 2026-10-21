import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

import { JETTA_COOLDOWN, JETTA_DURATION, jettaEntrance, showJetta } from "./jetta.ts";

test("Discord integration matches the account username and ignores other users and rooms", () => {
    const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
    const code = source.slice(source.indexOf("let stopJetta:"), source.indexOf("export default definePlugin("));
    let channel: string | null = "room", played = 0, stopped = 0;
    let states: { userId: string; }[] = [];
    const users = {
        target: { username: "huestavo" },
        nickname: { username: "someone", globalName: "huestavo" }
    };
    const { syncJetta: sync, triggerJetta } = new Function("jettaEntrance", "showJetta", "SelectedChannelStore", "VoiceStateStore", "UserStore", `${stripTypeScriptTypes(code)}; return { syncJetta, triggerJetta };`)(
        (play: () => void) => {
            const update = jettaEntrance(play);
            return (channelId: string | null, ids: string[], selfId: string) => {
                assert.equal(selfId, "nickname", "Discord passes the current account ID to the entrance detector");
                update(channelId, ids, selfId);
            };
        }, () => { played++; return () => { stopped++; }; },
        { getVoiceChannelId: () => channel },
        { getVoiceStatesForChannel: (id: string) => { assert.equal(id, channel); return states; } },
        { getUser: (id: keyof typeof users) => users[id], getCurrentUser: () => ({ id: "nickname" }) }
    );
    sync();
    states = [{ userId: "nickname" }, { userId: "unknown" }];
    sync();
    assert.equal(played, 0);
    states.push({ userId: "target" });
    sync();
    sync();
    assert.equal(played, 1);
    channel = null;
    sync();
    assert.equal(played, 1);
    triggerJetta();
    triggerJetta();
    assert.equal(played, 3, "Settings preview works outside a call without waiting for cooldown");
    assert.equal(stopped, 2, "Repeated clicks stop the previous effect before restarting");
});

test("the arriving account sees its own effect, including room moves, with the same cooldown", () => {
    let time = 0, played = 0;
    const update = jettaEntrance(() => played++, () => time);
    update("existing-call", ["target"], "target");
    assert.equal(played, 0, "Enabling the plugin while connected is silent");
    update(null, [], "target");
    update("call", ["target"], "target");
    assert.equal(played, 1, "The arriving account sees its own entrance");
    update("call", ["target"], "target");
    update("other-call", ["target"], "target");
    assert.equal(played, 1, "Mute updates and moving during cooldown do not replay");
    time = JETTA_COOLDOWN;
    update("third-call", ["target"], "target");
    assert.equal(played, 2, "The arriving account sees moves after cooldown");
    update(null, [], "target");
    time += JETTA_COOLDOWN;
    update("call", [], "target");
    update("call", ["target"], "target");
    assert.equal(played, 3, "Handles the selected channel updating before voice states");
    update(null, [], "someone-else");
    time += JETTA_COOLDOWN;
    update("call", ["target"], "someone-else");
    assert.equal(played, 3, "Other users joining an occupied call stay silent");
});

test("only a new arrival in the current call plays, with a 60-second cooldown across channels", () => {
    let time = 0, played = 0;
    const update = jettaEntrance(() => played++, () => time);
    update(null, []);
    update("call", ["huestavo-id"]);
    assert.equal(played, 0, "Joining an occupied call or enabling the plugin is silent");
    update("call", []);
    update("call", ["huestavo-id"]);
    assert.equal(played, 1);
    time = JETTA_COOLDOWN;
    update("call", ["huestavo-id"]);
    assert.equal(played, 1, "Mute, camera and synthetic updates are not arrivals");
    update("call", []);
    time = JETTA_COOLDOWN - 1;
    update("call", ["huestavo-id"]);
    assert.equal(played, 1);
    update("other-call", []);
    update("other-call", ["huestavo-id"]);
    assert.equal(played, 1, "Changing rooms does not reset the cooldown");
    update("other-call", []);
    time = JETTA_COOLDOWN;
    update("other-call", ["huestavo-id"]);
    assert.equal(played, 2, "Plays at the exact cooldown boundary");
    update(null, []);
    time += JETTA_COOLDOWN;
    update("other-call", ["huestavo-id"]);
    assert.equal(played, 2, "Reconnecting to an occupied room is silent");
});

test("overlay and synthesized audio end after three seconds, and can be stopped early", () => {
    const originals = { document: globalThis.document, AudioContext: globalThis.AudioContext, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    let appended = 0, removed = 0, closed = 0;
    let expire: () => void = () => {};
    const stopped: number[] = [];
    const parameter = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} });
    const node = () => ({ frequency: parameter(), gain: parameter(), connect() { return this; }, start() {}, stop(time: number) { stopped.push(time); } });
    Object.assign(globalThis, {
        document: { createElement: () => ({ setAttribute() {}, remove() { removed++; } }), body: { append() { appended++; } } },
        AudioContext: class {
            currentTime = 10;
            state = "running";
            destination = {};
            createOscillator = node;
            createBiquadFilter = node;
            createGain = node;
            async resume() {}
            async close() { this.state = "closed"; closed++; }
        },
        setTimeout(callback: () => void, delay: number) { assert.equal(delay, JETTA_DURATION); expire = callback; return 1; },
        clearTimeout() {}
    });
    try {
        showJetta();
        assert.equal(appended, 1);
        assert.deepEqual(stopped, [12.9, 12.9]);
        expire();
        assert.equal(removed, 1);
        assert.equal(closed, 1);
        const stop = showJetta();
        stop();
        assert.equal(removed, 2);
        assert.equal(closed, 2, "Disabling the plugin closes audio immediately");
        Object.assign(globalThis, { AudioContext: class { constructor() { throw new Error("Audio unavailable"); } } });
        const warn = console.warn;
        console.warn = () => {};
        try {
            showJetta();
            expire();
            assert.equal(removed, 3, "Audio failure still cleans up the visible effect");
        } finally { console.warn = warn; }
    } finally { Object.assign(globalThis, originals); }
});
