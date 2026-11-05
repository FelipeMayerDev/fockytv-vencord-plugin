import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { transformSync } from "esbuild";
import { cameraKey, liveStyle } from "./protocol";
import { watchLive } from "./viewer";

const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");

test("room discovery advertises live streams and cameras without opening video connections", async () => {
    let connections = 0, channel: string | undefined = "voice";
    let quality: { resolution: number; fps: number; style?: string; } | undefined = { resolution: 1080, fps: 30, style: "neon" };
    const api = new Function("request", "SelectedChannelStore", "cameraKey", "liveStyle", "watchCamera", `
        const routingEnabled = true, settings = { store: { url: 'https://tv.example' } }, serverUrl = x => x;
        const liveCameras = new Map(), cameraViewers = new Map(), watching = new Map(), liveOwners = new Map();
        const ownerStyles = new Map(), announcedQuality = new Map(), liveViewers = new Map(), webViewers = new Map();
        const annotationBoards = new Map();
        const UserStore = { getCurrentUser: () => ({ id: 'me' }), getUser: id => ({ username: id === 'me' ? 'viewer' : 'ana' }) };
        const VoiceStateStore = { getVoiceStatesForChannel: () => ({ me: {}, remote: {} }), getVoiceStateForUser: () => ({}) };
        const ChannelStore = { getChannel: () => ({ guild_id: 'guild' }) }, FluxDispatcher = { dispatch: () => {} };
        const ApplicationStreamingStore = { emitChange: () => {} }, discordShare = null;
        const keyOf = ({guildId,channelId,ownerId}) => 'guild:'+guildId+':'+channelId+':'+ownerId;
        const endCamera = id => cameraViewers.delete(id), endWatch = key => watching.delete(key);
        ${stripTypeScriptTypes(source.slice(source.indexOf("async function refreshLives("), source.indexOf("function syncAudio(")))}
        const receivedQuality = async () => undefined;
        return { refreshLives, liveCameras, cameraViewers, liveOwners, ownerStyles };
    `)(async () => ({ status: 200, body: JSON.stringify(["ana", "ana-cam"].map(streamKey => ({ streamKey, engine: "livekit", videoTracks: [{}], quality }))) }),
        { getVoiceChannelId: () => channel }, cameraKey, liveStyle, () => connections++);
    await api.refreshLives();
    await api.refreshLives();
    assert.equal(connections, 0);
    assert.equal(api.cameraViewers.size, 0);
    assert.deepEqual(api.liveCameras.get("remote"), { room: "ana-cam", channelId: "voice" });
    assert.equal(api.liveOwners.get("remote"), "ana");
    assert.equal(api.ownerStyles.get("remote"), "neon", "Styles are present without watching any video");
    quality = undefined;
    await api.refreshLives();
    assert.equal(api.ownerStyles.get("remote"), "neon", "A missing quality update must not remove the live effect");
    quality = { resolution: 1080, fps: 30, style: "" };
    await api.refreshLives();
    assert.equal(api.ownerStyles.get("remote"), "", "An explicit disabled style must still be respected");
    assert.equal(connections, 0);
    channel = undefined;
    await api.refreshLives();
    assert.equal(api.liveCameras.size, 0);
});

test("stream preview requests reuse watched media and never join a live for a thumbnail", async () => {
    const events: any[] = [], watching = new Map();
    let thumbnails = 0;
    const method = source.slice(source.indexOf("    fetchFtvPreview("), source.indexOf("    cameraActive:"));
    const preview = new Function("watching", "FluxDispatcher", "thumbnail", `
        const routingEnabled = true, generation = 1, publishers = new Map();
        const logVideoEvent = () => {};
        const UserStore = { getCurrentUser: () => ({ id: 'me' }) }, liveOwners = new Map([['owner','ana']]);
        const ApplicationStreamPreviewStore = { shouldFetchPreview: () => true };
        ${stripTypeScriptTypes(`const plugin = { ${method} };`)} return plugin.fetchFtvPreview;
    `)(watching, { dispatch: (event: unknown) => events.push(event) }, async () => { thumbnails++; return "image"; });
    assert.equal(preview("guild", "voice", "owner"), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(thumbnails, 0);
    assert.deepEqual(events, []);
    watching.set("guild:guild:voice:owner", { viewing: { media: {} } });
    assert.equal(preview("guild", "voice", "owner"), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(thumbnails, 1);
    assert.equal(events.at(-1).type, "STREAM_PREVIEW_FETCH_SUCCESS");
});

test("cameras open and stop only from the explicit user menu action", () => {
    const React = { createElement: (_type: unknown, props: unknown) => props };
    const cameras = new Map([["user", { room: "ana-cam", channelId: "voice" }]]), viewers = new Map();
    let opened = 0, stopped = 0;
    const menu = new Function("React", "Menu", "liveCameras", "cameraViewers", "watchCamera", "endCamera", `
        const routingEnabled = true, SelectedChannelStore = { getVoiceChannelId: () => 'voice' };
        ${transformSync(source.slice(source.indexOf("const cameraMenu:"), source.indexOf("function syncMusic(")), { loader: "tsx", jsxFactory: "React.createElement" }).code}
        return cameraMenu;
    `)(React, { MenuItem: "item" }, cameras, viewers,
        (id: string) => { opened++; viewers.set(id, {}); }, (id: string) => { stopped++; viewers.delete(id); });
    const children: any[] = [];
    menu(children, { user: { id: "user" } });
    assert.equal(opened, 0);
    assert.equal(children[0].label, "Assistir câmera FockyTV");
    children[0].action();
    assert.equal(opened, 1);
    const active: any[] = [];
    menu(active, { user: { id: "user" } });
    assert.equal(active[0].label, "Parar de assistir câmera FockyTV");
    active[0].action();
    assert.equal(stopped, 1);
    cameras.clear();
    children[0].action();
    assert.equal(opened, 1, "A stale menu cannot reconnect after the user leaves");
});

test("stopping a viewer immediately stops its tracks and cancels pending joins", async t => {
    const original = globalThis.MediaStream;
    class Media {
        tracks: any[] = [];
        getTracks() { return [...this.tracks]; }
        addTrack(track: unknown) { this.tracks.push(track); }
        removeTrack(track: unknown) { this.tracks = this.tracks.filter(value => value !== track); }
        dispatchEvent() {}
    }
    globalThis.MediaStream = Media as any;
    t.after(() => { globalThis.MediaStream = original; });
    const rooms: any[] = [];
    let stopped = 0, disconnected = 0;
    class Room {
        handlers: Record<string, Function> = {};
        connect = async () => {};
        constructor() { rooms.push(this); }
        on(event: string, callback: Function) { this.handlers[event] = callback; }
        async disconnect() { disconnected++; }
    }
    const sdk = { Room, RoomEvent: { TrackSubscribed: "track", TrackUnsubscribed: "untrack", ParticipantDisconnected: "left", Disconnected: "closed" } };
    const controller = new AbortController();
    const connecting = watchLive(sdk, async () => ({ status: 200, body: '{"token":"token","path":"/rtc"}', location: null }), "https://tv.example", "ana", "viewer", () => {}, controller.signal);
    await new Promise(resolve => setImmediate(resolve));
    rooms[0].handlers.track({ mediaStreamTrack: { kind: "video", stop: () => stopped++ } });
    const viewing = await connecting;
    controller.abort();
    assert.equal(stopped, 1);
    assert.equal(disconnected, 1);
    assert.equal(viewing.media.getTracks().length, 0);
    viewing.close();
    assert.equal(disconnected, 1);

    const pending = new AbortController();
    let joined = 0, respond!: (value: any) => void;
    const joining = watchLive(sdk, () => { joined++; return new Promise(resolve => respond = resolve); }, "https://tv.example", "ana", "viewer", () => {}, pending.signal);
    pending.abort();
    respond({ status: 200, body: '{"token":"token","path":"/rtc"}', location: null });
    await assert.rejects(joining, /abort/i);
    assert.equal(rooms.length, 1, "No peer connection is created if the join was cancelled");
    await assert.rejects(watchLive(sdk, async () => { joined++; throw Error("Must not request"); }, "https://tv.example", "ana", "viewer", () => {}, pending.signal), /abort/i);
    assert.equal(joined, 1);

    let resume!: () => void;
    class DelayedRoom extends Room {
        connect = () => new Promise<void>(resolve => resume = resolve);
    }
    const loading = new AbortController();
    const opening = watchLive({ ...sdk, Room: DelayedRoom }, async () => ({ status: 200, body: '{"token":"token","path":"/rtc"}', location: null }), "https://tv.example", "ana", "viewer", () => {}, loading.signal);
    await new Promise(resolve => setImmediate(resolve));
    loading.abort();
    assert.equal(disconnected, 2, "Disconnect immediately, before connect() resolves");
    rooms[1].handlers.track({ mediaStreamTrack: { kind: "video", stop: () => stopped++ } });
    assert.equal(stopped, 2, "Tracks arriving after cancellation must also stop");
    resume();
    await assert.rejects(opening, /cancelada/);
    assert.equal(disconnected, 3, "A connection that finishes after cancellation is closed again");
});

test("leaving the room, a publisher departure and logout release viewers without waiting for polling", () => {
    let channel: string | undefined = "voice";
    const states = new Map([["a", "voice"], ["b", "voice"]]);
    const watching = new Map([["guild:guild:voice:a", {}], ["guild:guild:voice:b", {}]]);
    const cameraViewers = new Map([["a", { channelId: "voice" }]]), liveCameras = new Map(cameraViewers);
    const methods = source.slice(source.indexOf("        VOICE_STATE_UPDATES()"), source.indexOf("    patches: discordPatches,"));
    const flux = new Function("SelectedChannelStore", "VoiceStateStore", "watching", "cameraViewers", "liveCameras", `
        const setTimeout = fn => fn(), syncMusic = () => {}, stopPublishing = () => {}, closePanel = null, discordShare = null;
        const music = { connect() {} }, watch = music, ownerOf = key => key.split(':').pop();
        const endWatch = key => watching.delete(key), endCamera = id => cameraViewers.delete(id);
        ${stripTypeScriptTypes(`const plugin = { flux: { ${methods} };`)}
        return plugin.flux;
    `)({ getVoiceChannelId: () => channel }, { getVoiceStateForUser: (id: string) => ({ channelId: states.get(id) }) }, watching, cameraViewers, liveCameras);
    states.delete("a");
    flux.VOICE_STATE_UPDATES();
    assert.equal(watching.has("guild:guild:voice:a"), false);
    assert.equal(watching.has("guild:guild:voice:b"), true, "Keep the other selected live running");
    assert.equal(cameraViewers.size, 0);
    assert.equal(liveCameras.size, 0);
    channel = undefined;
    flux.VOICE_STATE_UPDATES();
    assert.equal(watching.size, 0);
    watching.set("guild:guild:voice:b", {});
    flux.LOGOUT();
    assert.equal(watching.size, 0);
});
