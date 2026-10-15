import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

// Exercise the camera lifecycle without loading Discord or opening real media connections.
const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
const lifecycle = source.slice(source.indexOf("const cameraViewers ="), source.indexOf("let livePoll:"));

test("remote cameras publish to the voice tile and close without stale reconnects", async () => {
    const events = [], pending = [];
    let closed = 0;
    const create = new Function("FluxDispatcher", "ChannelStore", "VoiceStateStore", "watchLive",
        `let livekit = {}; const request = null, settings = { store: { url: 'https://tv.example' } };
        const serverUrl = x => x, nickname = () => 'viewer', watchCameraPrefix = 'fockytv-camera:';
        ${stripTypeScriptTypes(lifecycle)}
        return { cameraViewers, watchCamera, endCamera };`);
    const api = create({ dispatch: event => events.push(event) },
        { getChannel: () => ({ guild_id: "guild" }) },
        { getVoiceStateForUser: () => ({ userId: "user", channelId: "channel", selfVideo: true }) },
        (...args) => new Promise(resolve => pending.push({ resolve, ended: args.at(-1) })));
    const media = {};
    const first = api.watchCamera("user", "user-cam", "channel");
    pending[0].resolve({ media, close: () => closed++ });
    await first;
    assert.equal(api.cameraViewers.get("user").viewing.media, media);
    assert.deepEqual(events[0], { type: "RTC_CONNECTION_VIDEO", guildId: "guild", channelId: "channel", userId: "user", streamId: "fockytv-camera:user", rtcServerId: null, context: "default" });
    api.endCamera("user");
    assert.equal(closed, 1);
    assert.equal(events.at(-2).streamId, null);
    assert.equal(events.at(-1).voiceStates[0].selfVideo, false);
    const cancelled = api.watchCamera("user", "user-cam", "channel");
    api.endCamera("user");
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
