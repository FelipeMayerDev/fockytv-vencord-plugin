import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

test("LiveKit notifies playback when audio arrives after video or is republished", async () => {
    const source = readFileSync(new URL("./viewer.ts", import.meta.url), "utf8");
    const create = new Function("MediaStream", "setTimeout",
        stripTypeScriptTypes(source.slice(source.indexOf("export async function watchLive"))).replace("export ", "") + ";return watchLive;");
    class Stream extends EventTarget {
        tracks = [];
        addTrack(track) { this.tracks.push(track); }
        removeTrack(track) { this.tracks = this.tracks.filter(value => value !== track); }
        getTracks() { return this.tracks; }
    }
    let client;
    const sdk = {
        RoomEvent: { TrackSubscribed: "add", TrackUnsubscribed: "remove" },
        Room: class {
            handlers = new Map();
            constructor() { client = this; }
            on(event, handler) { this.handlers.set(event, handler); }
            async connect() { this.handlers.get("add")({ mediaStreamTrack: { kind: "video" } }); }
            async disconnect() {}
        }
    };
    const watchLive = create(Stream, () => 0);
    const viewing = await watchLive(sdk, async () => ({ status: 200, body: '{"token":"test","path":"/livekit"}' }),
        "https://tv.example", "room", "viewer", () => {});
    const changes = [];
    viewing.media.addEventListener("addtrack", () => changes.push("added"));
    viewing.media.addEventListener("removetrack", () => changes.push("removed"));
    const track = { mediaStreamTrack: { kind: "audio" } };
    client.handlers.get("add")(track);
    assert.ok(viewing.media.getTracks().includes(track.mediaStreamTrack));
    client.handlers.get("remove")(track);
    assert.ok(!viewing.media.getTracks().includes(track.mediaStreamTrack));
    client.handlers.get("add")(track);
    assert.deepEqual(changes, ["added", "removed", "added"]);
    viewing.close();
});
