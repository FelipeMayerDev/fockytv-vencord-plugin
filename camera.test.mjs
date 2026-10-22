import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

// Exercise the camera lifecycle without loading Discord or opening real media connections.
const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
const lifecycle = source.slice(source.indexOf("const cameraViewers ="), source.indexOf("let livePoll:"));

test("remote cameras publish to the voice tile and close without stale reconnects", async () => {
    const events = [], pending = [], closedPip = [];
    let closed = 0;
    const create = new Function("FluxDispatcher", "ChannelStore", "VoiceStateStore", "watchLive", "closePictureInPicture",
        `let livekit = {}; const request = null, settings = { store: { url: 'https://tv.example' } };
        const serverUrl = x => x, nickname = () => 'viewer', watchCameraPrefix = 'fockytv-camera:';
        ${stripTypeScriptTypes(lifecycle)}
        return { cameraViewers, watchCamera, endCamera };`);
    const api = create({ dispatch: event => events.push(event) },
        { getChannel: () => ({ guild_id: "guild" }) },
        { getVoiceStateForUser: () => ({ userId: "user", channelId: "channel", selfVideo: true }) },
        (...args) => new Promise(resolve => pending.push({ resolve, ended: args.at(-1) })), media => closedPip.push(media));
    const media = {};
    const first = api.watchCamera("user", "user-cam", "channel");
    pending[0].resolve({ media, close: () => closed++ });
    await first;
    assert.equal(api.cameraViewers.get("user").viewing.media, media);
    assert.deepEqual(events[0], { type: "RTC_CONNECTION_VIDEO", guildId: "guild", channelId: "channel", userId: "user", streamId: "fockytv-camera:user", rtcServerId: null, context: "default" });
    api.endCamera("user");
    assert.equal(closed, 1);
    assert.deepEqual(closedPip, [media], "Ending a webcam closes its picture-in-picture");
    assert.equal(events.at(-2).streamId, null);
    assert.equal(events.at(-1).voiceStates[0].selfVideo, false);
    const cancelled = api.watchCamera("user", "user-cam", "channel");
    api.endCamera("user");
    assert.equal(closedPip.length, 1, "A pending camera must not close another stream's picture-in-picture");
    const replacement = api.watchCamera("user", "user-cam", "channel");
    pending[1].ended();
    assert.ok(api.cameraViewers.has("user"), "Old callbacks must not close a replacement");
    pending[1].resolve({ media, close: () => closed++ });
    await cancelled;
    assert.equal(closed, 2, "Connections completed after leaving must close");
    pending[2].resolve({ media, close: () => closed++ });
    await replacement;
    pending[2].ended();
    assert.equal(closed, 3);
    assert.equal(api.cameraViewers.size, 0);
});

test("call renegotiation clearing the native video restores FockyTV camera tiles", () => {
    const events = [];
    const create = new Function("FluxDispatcher", "ChannelStore", "VoiceStateStore", "SelectedChannelStore", "UserStore", "publishers",
        `const watchCameraPrefix = 'fockytv-camera:', cameraStreamId = 'fockytv-camera';
        ${stripTypeScriptTypes(lifecycle)}
        return { cameraViewers, restoreCamera };`);
    const publishers = new Map([["camera", {}]]);
    const api = create({ dispatch: event => events.push(event) }, { getChannel: () => ({ guild_id: "guild" }) },
        { getVoiceStateForUser: () => null }, { getVoiceChannelId: () => "channel" }, { getCurrentUser: () => ({ id: "me" }) }, publishers);
    api.cameraViewers.set("friend", { room: "friend-cam", channelId: "channel", viewing: {} });
    api.restoreCamera("me", "channel");
    api.restoreCamera("friend", "channel");
    assert.deepEqual(events.map(event => [event.userId, event.streamId, event.context]), [["me", "fockytv-camera", "default"], ["friend", "fockytv-camera:friend", "default"]]);
    publishers.clear();
    api.cameraViewers.clear();
    api.restoreCamera("me", "channel");
    api.restoreCamera("friend", "channel");
    api.restoreCamera("me", "other");
    assert.equal(events.length, 2, "Stopped cameras and other channels stay cleared");
});
