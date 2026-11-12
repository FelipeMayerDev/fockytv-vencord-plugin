import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

test("native camera clones Discord output, refreshes filters and releases failures", async () => {
    const source = readFileSync(new URL("./camera.ts", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
    const code = stripTypeScriptTypes(source).replaceAll("export ", "");
    let option = 9, released = 0, originalStopped = 0, cloneStopped = 0, fail = false;
    const applied = [];
    const original = { clone: () => ({ stop: () => cloneStopped++ }), stop: () => originalStopped++ };
    const findByCodeLazy = (...patterns) => patterns.includes("addDirectVideoOutputSink")
        ? () => { let closed = false; return { stream: { getVideoTracks: () => [original] }, release: () => { if (!closed) released++; closed = true; } }; }
        : patterns.includes("CAMERA_BACKGROUND_PREVIEW")
            ? async (value, id, options) => { applied.push({ value, id, options }); if (fail) throw Error("filter failed"); }
            : () => option;
    const create = new Function("findByCodeLazy", "UserStore", "MediaStream", "document", "retimeCamera", code + ";return {captureNativeCamera,syncCameraFilter};");
    const api = create(findByCodeLazy, { getCurrentUser: () => ({ id: "user" }) },
        class { constructor(tracks) { this.tracks = tracks; } getTracks() { return this.tracks; } },
        { createElement: () => ({ videoWidth: 1280, videoHeight: 720, play: async () => {}, pause() {} }) },
        track => ({ track: track.clone(), stop() {} }));
    const camera = await api.captureNativeCamera("selected-camera");
    assert.deepEqual(applied[0], { value: 9, id: "selected-camera", options: { track: false } });
    assert.notEqual(camera.capture.getTracks()[0], original);
    await Promise.all([api.syncCameraFilter(), api.syncCameraFilter(), api.syncCameraFilter()]);
    assert.equal(applied.length, 1, "Unrelated settings updates must not restart the filter");
    option = "blur";
    await api.syncCameraFilter();
    assert.equal(applied.at(-1).value, "blur");
    option = 0;
    fail = true;
    await assert.rejects(api.syncCameraFilter(), /filter failed/);
    fail = false;
    await api.syncCameraFilter();
    assert.equal(applied.at(-1).value, 0, "Failed changes remain retryable");
    camera.capture.getTracks().forEach(track => track.stop());
    camera.releaseVideo();
    camera.releaseVideo();
    const count = applied.length;
    await api.syncCameraFilter();
    assert.equal(applied.length, count);
    assert.equal(released, 1);
    assert.equal(cloneStopped, 1);
    assert.equal(originalStopped, 0, "Discord owns the original preview track");
    fail = true;
    await assert.rejects(api.captureNativeCamera("selected-camera"), /filter failed/);
    assert.equal(released, 2);
    fail = false;
    const retry = await api.captureNativeCamera("selected-camera");
    retry.capture.getTracks().forEach(track => track.stop());
    retry.releaseVideo();
    assert.equal(released, 3);
});
