// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transformSync } from "esbuild";

import { discordPatches } from "./discord";
import { lyricIndex, lyricsCanvas, readLyrics } from "./music-lyrics";

// Mesmo expansor de identificadores usado pelo patcher do Vencord.
const expand = (regex: RegExp) => new RegExp(regex.source.replaceAll("\\i", "[A-Za-z_$][\\w$]*"), regex.flags);

test("lyrics validate timestamps, sort lines, preserve gaps and handle plain or missing lyrics", () => {
    const lyrics = readLyrics({ lines: [{ t: 10, text: "Segunda" }, { t: 1.5, text: "Primeira" }, { t: 5, text: "" }, { t: -1, text: "bad" }, { t: Infinity, text: "bad" }, null] });
    assert.deepEqual(lyrics.lines, [{ t: 1.5, text: "Primeira" }, { t: 5, text: "" }, { t: 10, text: "Segunda" }]);
    assert.equal(lyricIndex(lyrics.lines, 0), -1);
    assert.equal(lyricIndex(lyrics.lines, 1.5), 0);
    assert.equal(lyricIndex(lyrics.lines, 5), 1);
    assert.equal(lyricIndex(lyrics.lines, 20), 2);
    assert.equal(lyricIndex(lyrics.lines, 2), 0, "Seeking backwards also updates the line");
    assert.equal(lyricIndex([{ t: 0, text: "a" }, { t: 0, text: "b" }], 0), 1);
    assert.deepEqual(readLyrics({ lines: ["One", { text: "Two" }, {}] }).plain, ["One", "Two"]);
    assert.deepEqual(readLyrics({ plainLyrics: "One\n\nTwo" }).plain, ["One", "Two"]);
    for (const body of [null, {}, "invalid", { lines: [] }]) assert.deepEqual(readLyrics(body), { lines: [], plain: [] });
});

test("canvas lifecycle: local-only video, pause, track/channel changes, stale requests, fallback and cleanup", async () => {
    const original = { document: globalThis.document, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
    let snapshot = { channel: "room", current: { uid: "first", id: "abcdefghijk", title: "First", duration: 100 }, listening: false, state: { ready: true, playing: true } };
    let position = 0, stopped = 0, listener: (() => void) | undefined;
    let interval: (() => void) | undefined;
    const drawn: { text: string; color: string; }[] = [];
    const shown: { media: unknown; channel?: string; }[] = [];
    const pending: { id: string; resolve: (data: unknown) => void; reject: (error: Error) => void; }[] = [];
    const context = { fillStyle: "", textAlign: "", font: "", fillRect() { drawn.length = 0; }, fillText(text: string) { drawn.push({ text, color: this.fillStyle }); } };
    Object.assign(globalThis, {
        document: { createElement(tag: string) {
            assert.equal(tag, "canvas");
            return { getContext: () => context, captureStream(fps: number) {
                assert.equal(fps, 5);
                return { getTracks: () => [{ kind: "video", stop() { stopped++; } }] };
            } };
        } },
        setInterval(fn: () => void) { interval = fn; return 1; },
        clearInterval() { interval = undefined; }
    });
    const player = {
        snapshot: () => snapshot as any,
        playbackPosition: () => position,
        subscribe(fn: () => void) { listener = fn; return () => { listener = undefined; }; }
    };
    let stop: (() => void) | undefined;
    const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
    try {
        stop = lyricsCanvas(player, id => new Promise((resolve, reject) => pending.push({ id, resolve, reject })), (media, channel) => shown.push({ media, channel }));
        assert.equal(shown.length, 0, "Non-listeners do not fetch or see lyrics");
        snapshot.listening = true;
        listener!();
        assert.equal(pending[0].id, snapshot.current.id);
        assert.equal(shown.length, 1);
        assert.ok(drawn.some(row => row.text === "Buscando letra…"));
        pending[0].resolve({ lines: [{ t: 0, text: "Start" }, { t: 5, text: "Next" }] });
        await flush();
        assert.ok(drawn.some(row => row.text === "Start" && row.color === "#82efb1"));
        position = 5;
        interval!();
        assert.ok(drawn.some(row => row.text === "Next" && row.color === "#82efb1"));
        snapshot.state.playing = false;
        listener!();
        assert.equal(shown.length, 1, "Pause retains the same stream");
        assert.ok(drawn.some(row => row.text.includes("Pausada")));
        snapshot.current = { ...snapshot.current, uid: "second", title: "Second" };
        listener!();
        assert.equal(stopped, 1);
        snapshot.channel = "another-room";
        listener!();
        assert.equal(stopped, 2);
        pending[1].resolve({ lines: [{ t: 0, text: "Stale" }] });
        await flush();
        assert.ok(!drawn.some(row => row.text === "Stale"));
        pending[2].resolve({ plainLyrics: "Plain one\nPlain two" });
        await flush();
        assert.ok(drawn.some(row => row.text === "Plain one"));
        assert.ok(drawn.some(row => row.text.includes("sem sincronização")));
        snapshot.listening = false;
        listener!();
        assert.equal(stopped, 3);
        assert.equal(interval, undefined);
        snapshot.listening = true;
        listener!();
        pending[3].reject(new Error("HTTP 503"));
        await flush();
        assert.ok(drawn.some(row => row.text === "Sem letra"));
        position = 100;
        interval!();
        assert.equal(stopped, 4, "Track end removes the tile without waiting for a WS message");
        assert.equal(shown.at(-1)?.media, null);
        position = 0;
        listener!();
        stop();
        assert.equal(stopped, 5);
        pending[4].resolve({ lines: [{ t: 0, text: "Late" }] });
        await flush();
        assert.equal(listener, undefined);
        assert.equal(interval, undefined);
        assert.equal(shown.at(-1)?.media, null, "A late response cannot resurrect the tile");
    } finally { stop?.(); Object.assign(globalThis, original); }
});

test("RTC patches append the local tile and support selection/version/mode without changing real participants", () => {
    const patch = discordPatches.find(patch => patch.find === 'static displayName="ChannelRTCStore"')!;
    let source = `class Store {
        getParticipants(e){return $(e).toArray()??P}
        getFilteredParticipants(e){let t=$(e);return H[e]?t.toArray(1):t.toArray(2)}
        getVideoParticipants(e){return $(e).toArray(3)??P}
        getParticipant(e,t){return $(e).getParticipant(t)}
        getSelectedParticipantId(e){return 'fockytv-lyrics'}
        getSelectedParticipant(e){let t=this.getSelectedParticipantId(e);return null==t?null:$(e).getParticipant(t)}
        getParticipantsVersion(e){return $(e).version}
        getMode(e){return 'voice'}
    }`;
    for (const replacement of patch.replacement as { match: RegExp; replace: string; }[]) {
        assert.ok(expand(replacement.match).test(source), `Patch must match: ${replacement.match}`);
        source = source.replace(expand(replacement.match), replacement.replace.replaceAll("$self", "plugin"));
    }
    const original = { id: "real" }, tile = { id: "fockytv-lyrics" };
    let active = true;
    const local = (channel: string, id?: string) => active && channel === "room" && (id === undefined || id === tile.id) ? tile : undefined;
    const store = new Function("plugin", "$", "P", "H", `${source}; return new Store();`)({
        includeLyrics: (rows: unknown[], channel: string) => local(channel) ? [...rows, tile] : rows,
        lyricsParticipant: local,
        lyricsVersion: (channel: string, version: number) => version + (local(channel) ? 0.5 : 0)
    }, () => ({ toArray: () => [original], getParticipant: () => original, version: 1 }), [], {});
    for (const method of ["getParticipants", "getFilteredParticipants", "getVideoParticipants"]) {
        assert.deepEqual(store[method]("room"), [original, tile]);
        assert.deepEqual(store[method]("other-room"), [original]);
    }
    assert.equal(store.getParticipant("room", tile.id), tile);
    assert.equal(store.getSelectedParticipant("room"), tile);
    assert.equal(store.getParticipantsVersion("room"), 1.5);
    assert.equal(store.getMode("room"), "video");
    active = false;
    assert.equal(store.getParticipantsVersion("room"), 1);
    assert.equal(store.getMode("room"), "voice");
    assert.deepEqual(store.getParticipants("room"), [original]);
});

test("native lyrics access stays within the music allowlist", () => {
    const native = readFileSync(new URL("./native.ts", import.meta.url), "utf8");
    const code = native.slice(native.indexOf("export async function musicFetch("), native.indexOf("// HMONITOR"));
    const validate = new Function("serverUrl", "fetch", `${transformSync(code.replace("export ", ""), { loader: "ts" }).code}; return musicFetch;`)(() => {}, async () => ({ status: 200, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) }));
    return (async () => {
        assert.equal((await validate(null, "https://tv.example/api/fixed/jam/yt/lyrics?id=abcdefghijk")).status, 200);
        for (const path of ["/api/fixed/jam/yt/play", "/api/fixed/jam/yt/lyrics/other", "/admin", "/api/fixed/plugin-updates/webhook"]) {
            await assert.rejects(validate(null, `https://tv.example${path}`), /inválida/);
        }
    })();
});
