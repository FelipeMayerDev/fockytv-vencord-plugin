import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
const captureParty = new Function(`${stripTypeScriptTypes(source.slice(source.indexOf("function captureParty("), source.indexOf("// O <video> da watch party fica fora do DOM")))}; return captureParty;`)();

function fakeVideo() {
    const tracks = [];
    let added;
    const media = {
        getTracks: () => [...tracks],
        removeTrack(track) { tracks.splice(tracks.indexOf(track), 1); },
        addEventListener(type, listener) { assert.equal(type, "addtrack"); added = listener; }
    };
    const track = kind => ({ kind, stopped: false, stop() { this.stopped = true; } });
    return {
        video: { captureStream: () => media },
        add(kind) { const value = track(kind); tracks.push(value); added({ track: value }); return value; }
    };
}

test("o vídeo da watch party pede CORS antes de receber a stream de outra origem", () => {
    const start = source.slice(source.indexOf('partyVideo = document.createElement("video")'));
    assert.ok(start.indexOf('partyVideo.crossOrigin = "anonymous"') >= 0);
    assert.ok(start.indexOf('partyVideo.crossOrigin = "anonymous"') < start.indexOf("watch.attach(partyVideo)"));
});

test("trocar de vídeo deixa no tile só a track nova de cada tipo", () => {
    const { video, add } = fakeVideo();
    const media = captureParty(video);
    const firstVideo = add("video"), firstAudio = add("audio");
    assert.deepEqual(media.getTracks(), [firstVideo, firstAudio]);
    const nextVideo = add("video");
    assert.deepEqual(media.getTracks(), [firstAudio, nextVideo]);
    assert.equal(firstVideo.stopped, true);
    assert.equal(firstAudio.stopped, false);
    const nextAudio = add("audio");
    assert.deepEqual(media.getTracks(), [nextVideo, nextAudio]);
    assert.equal(firstAudio.stopped, true);
});
