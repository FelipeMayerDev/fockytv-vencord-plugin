import assert from "node:assert/strict";
import test from "node:test";

import { videoDelay } from "./lip-sync";

test("Video waits for audio that plays behind it", () => {
    // som 80 ms mais velho que a imagem + 20 ms do AudioContext: anda meio passo
    assert.equal(videoDelay(0, 10_080, 10_000, 20), 50);
    assert.equal(videoDelay(50, 10_030, 10_000, 20), 75);
});

test("Small offsets keep the current delay", () => {
    assert.equal(videoDelay(60, 10_005, 10_000, 10), 60);
    assert.equal(videoDelay(60, 10_000, 10_000, NaN), 60);
});

test("Audio ahead releases the video delay but never below zero", () => {
    assert.equal(videoDelay(100, 10_000, 10_060, 0), 70);
    assert.equal(videoDelay(10, 10_000, 10_200, 0), 0);
});

test("A broken clock cannot hold the video forever", () => {
    assert.equal(videoDelay(0, 60_000, 0, 0), 500);
});
