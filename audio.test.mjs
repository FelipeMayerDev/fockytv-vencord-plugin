import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

// strip-only não aceita parameter properties (PcmBuffer).
const load = file => stripTypeScriptTypes(readFileSync(new URL(file, import.meta.url), "utf8").replace(/^import .*;\n/gm, "")
    .replace(/constructor\(private (\w+): number, private (\w+): number\) \{ \}/, "private $1: number; private $2: number; constructor($1: number, $2: number) { this.$1 = $1; this.$2 = $2; }")).replaceAll("export ", "");

test("Windows screen audio keeps flowing when the capturer runs ahead of the clock", async () => {
    const written = [];
    globalThis.window = {
        MediaStreamTrackGenerator: class { writable = { getWriter: () => ({ write: async frame => { written.push(frame.numberOfFrames); }, close: async () => {} }) }; stop() {} },
        AudioData: class { constructor(init) { this.numberOfFrames = init.numberOfFrames; } close() {} }
    };
    const { captureAudio } = new Function(load("./pcm.ts") + load("./audio.ts") + ";return {captureAudio};")();
    // O capturador entrega um pouco mais rápido que o relógio do renderer: o excesso tem que ser descartado sem parar o som.
    let last = performance.now(), calls = 0;
    const native = {
        startAudio: async () => ({ id: "a", rate: 48000, channels: 2 }),
        readAudio: async () => {
            calls++;
            const now = performance.now(), frames = Math.round((now - last) * 48 * 1.04); // capturador 4% acima do tempo real (medido ao vivo)
            last = now;
            return new Uint8Array(frames * 8);
        },
        stopAudio: async () => {}
    };
    const audio = await captureAudio(native, "screen:0:0", error => { throw error; });
    const total = () => written.reduce((sum, frames) => sum + frames, 0) / 48000;
    await new Promise(resolve => setTimeout(resolve, 1500));
    const before = total();
    await new Promise(resolve => setTimeout(resolve, 2000));
    audio.stop();
    // Depois do primeiro descarte o som travava: nos últimos 2 s tem que sair ~2 s de áudio.
    assert.ok(total() - before > 1.6, `only ${(total() - before).toFixed(2)} s written in 2 s`);
});
