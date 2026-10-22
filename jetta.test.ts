import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const image = readFileSync(new URL("./jetta.png", import.meta.url));
const sound = readFileSync(new URL("./jetta.mp3", import.meta.url));
const source = readFileSync(new URL("./jetta.ts", import.meta.url), "utf8");
const { JETTA_COOLDOWN, JETTA_DURATION, jettaEntrance, showJetta, bragaAbsence } = new Function("jettaImage", "jettaAudio",
    stripTypeScriptTypes(source.replace(/^import .*;\n/gm, "")).replace(/^export /gm, "")
    + ";return {JETTA_COOLDOWN,JETTA_DURATION,jettaEntrance,showJetta,bragaAbsence};")(image.toString("base64"), sound.toString("base64"));

test("Discord integration matches the account username and ignores other users and rooms", () => {
    const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
    const code = source.slice(source.indexOf("let stopJetta:"), source.indexOf("export default definePlugin("));
    let channel: string | null = "room", played = 0, stopped = 0;
    let states: { userId: string; }[] = [];
    const users = {
        target: { username: "huestavo" },
        nickname: { username: "someone", globalName: "huestavo" }
    };
    const store = { bragaLastArrival: 0, bragaLastDeparture: 0 };
    const welcomes: { away: number | null; arrived: number; }[] = [];
    let complete: () => void = () => {};
    const { syncJetta: sync, triggerJetta } = new Function("jettaEntrance", "showJetta", "SelectedChannelStore", "VoiceStateStore", "UserStore", "settings", "openBragaWelcome", `${stripTypeScriptTypes(code)}; return { syncJetta, triggerJetta };`)(
        (play: () => void, now: () => number, observe: (event: string, time: number) => void) => {
            const update = jettaEntrance(play, now, observe);
            return (channelId: string | null, ids: string[], selfId: string) => {
                assert.equal(selfId, "nickname", "Discord passes the current account ID to the entrance detector");
                update(channelId, ids, selfId);
            };
        }, (onComplete: () => void) => { played++; complete = onComplete; return () => { stopped++; }; },
        { getVoiceChannelId: () => channel },
        { getVoiceStatesForChannel: (id: string) => { assert.equal(id, channel); return states; } },
        { getUser: (id: keyof typeof users) => users[id], getCurrentUser: () => ({ id: "nickname" }) },
        { store }, (away: number | null, arrived: number) => welcomes.push({ away, arrived })
    );
    sync();
    states = [{ userId: "nickname" }, { userId: "unknown" }];
    sync();
    assert.equal(played, 0);
    states.push({ userId: "target" });
    sync();
    sync();
    assert.equal(played, 1);
    assert.equal(welcomes.length, 0, "Welcome waits for the animation to end");
    assert.ok(store.bragaLastArrival > 0, "Arrival date persists in plugin settings");
    complete();
    assert.deepEqual(welcomes, [{ away: null, arrived: store.bragaLastArrival }]);
    channel = null;
    sync();
    assert.equal(played, 1);
    const savedArrival = store.bragaLastArrival;
    triggerJetta();
    triggerJetta();
    assert.equal(played, 3, "Settings preview works outside a call without waiting for cooldown");
    assert.equal(stopped, 2, "Repeated clicks stop the previous effect before restarting");
    assert.equal(store.bragaLastArrival, savedArrival, "Settings preview does not change arrival history");
});

test("absence text includes days, hours and minutes, with singular and short durations", () => {
    assert.equal(bragaAbsence(0), "menos de um minuto");
    assert.equal(bragaAbsence(-1), "menos de um minuto");
    assert.equal(bragaAbsence(60_000), "1 minuto");
    assert.equal(bragaAbsence(86400_000), "1 dia");
    assert.equal(bragaAbsence((2 * 1440 + 3 * 60 + 4) * 60_000), "2 dias, 3 horas, 4 minutos");
});

test("observations track departures and every arrival independently of the animation cooldown", () => {
    let time = 1000, played = 0;
    const events: [string, number][] = [];
    const update = jettaEntrance(() => played++, () => time, (event: string, at: number) => events.push([event, at]));
    update("call", ["target"]);
    update("call", ["target"]);
    update(null, [], "observer");
    assert.deepEqual(events, [], "Startup, mute, and the observer leaving are not target events");
    update("call", ["target"]);
    update("call", []);
    time = 2000;
    update("call", ["target"]);
    update("call", []);
    time = 3000;
    update("call", ["target"]);
    assert.equal(played, 1);
    assert.deepEqual(events, [["departure", 1000], ["arrival", 2000], ["departure", 2000], ["arrival", 3000]]);
    update(null, [], "target");
    assert.deepEqual(events.at(-1), ["departure", 3000], "The target records its own disconnect");
});

test("saved departures survive restart and are consumed on return", () => {
    const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
    const code = source.slice(source.indexOf("let stopJetta:"), source.indexOf("function triggerJetta("));
    const store = { bragaLastArrival: 0, bragaLastDeparture: 0 };
    const load = () => new Function("settings", `${stripTypeScriptTypes(code)}; return { trackBraga, away: () => bragaAway };`)({ store });
    load().trackBraga("departure", 1000);
    const restarted = load();
    restarted.trackBraga("arrival", 86401_000);
    assert.equal(restarted.away(), 86400_000);
    assert.equal(store.bragaLastArrival, 86401_000);
    assert.equal(store.bragaLastDeparture, 0);
    restarted.trackBraga("arrival", 86402_000);
    assert.equal(restarted.away(), null, "No absence is invented without an observed departure");
    restarted.trackBraga("departure", 100_000_000);
    restarted.trackBraga("arrival", 86403_000);
    assert.equal(restarted.away(), null, "Clock changes do not produce negative absence");
});

test("initial absence starts at two days and its fixed date survives restarts", () => {
    const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
    const initialDate = source.match(/bragaLastDeparture:.*default: Date.parse\("([^"]+)"\)/)![1];
    const departure = Date.parse(initialDate);
    const reported = Date.parse("2026-10-22T16:14:40Z");
    assert.equal(bragaAbsence(reported - departure), "2 dias");
    const store = { bragaLastArrival: 0, bragaLastDeparture: departure };
    const code = source.slice(source.indexOf("let stopJetta:"), source.indexOf("function triggerJetta("));
    const load = () => new Function("settings", `${stripTypeScriptTypes(code)}; return { trackBraga, away: () => bragaAway };`)({ store });
    const restarted = load();
    restarted.trackBraga("arrival", reported + 3600_000);
    assert.equal(bragaAbsence(restarted.away()), "2 dias, 1 hora");
    load().trackBraga("arrival", reported + 7200_000);
    assert.equal(store.bragaLastDeparture, 0, "The initial two days are not reapplied after returning");
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

test("overlay and bundled video excerpt end after three seconds, and can be stopped early", async () => {
    const originals = { document: globalThis.document, Audio: globalThis.Audio, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    let appended = 0, removed = 0, closed = 0;
    const overlays: { innerHTML?: string; }[] = [];
    let expire: () => void = () => {};
    let played = 0, rejectPlay = false;
    Object.assign(globalThis, {
        document: { createElement: () => ({ setAttribute() {}, remove() { removed++; } }), body: { append(overlay: { innerHTML?: string; }) { overlays.push(overlay); appended++; } } },
        Audio: class {
            constructor(src: string) { assert.equal(src, `data:audio/mpeg;base64,${sound.toString("base64")}`); }
            async play() { played++; if (rejectPlay) throw new Error("Playback unavailable"); }
            pause() { closed++; }
            removeAttribute(name: string) { assert.equal(name, "src"); }
        },
        setTimeout(callback: () => void, delay: number) { assert.equal(delay, JETTA_DURATION); expire = callback; return 1; },
        clearTimeout() {}
    });
    try {
        let completed = 0;
        showJetta(() => completed++);
        assert.equal(appended, 1);
        assert.match(source, /import jettaImage from "file:\/\/\.\/jetta\.png\?base64"/);
        assert.ok(overlays[0].innerHTML?.includes(`src="data:image/png;base64,${image.toString("base64")}"`), "Uses the supplied image offline");
        assert.equal(overlays[0].innerHTML?.includes("<svg"), false);
        assert.equal(played, 1, "Plays the bundled excerpt without a network request");
        expire();
        assert.equal(removed, 1);
        assert.equal(closed, 1);
        assert.equal(completed, 1, "Natural end opens the welcome");
        const stop = showJetta(() => completed++);
        stop();
        assert.equal(completed, 1, "Stopping early cancels the welcome");
        assert.equal(removed, 2);
        assert.equal(closed, 2, "Disabling the plugin closes audio immediately");
        rejectPlay = true;
        const warn = console.warn;
        console.warn = () => {};
        try {
            showJetta();
            await Promise.resolve();
            expire();
            assert.equal(removed, 3, "Audio failure still cleans up the visible effect");
        } finally { console.warn = warn; }
    } finally { Object.assign(globalThis, originals); }
});
