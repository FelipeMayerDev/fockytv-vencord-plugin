import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
const draw = stripTypeScriptTypes(source.slice(source.indexOf("function drawSpectrum("), source.indexOf("// Botão de música ao lado")));

for (const ratio of [1, 2]) {
    test(`spectrum clears translucent controls at pixel ratio ${ratio}, including after layout changes`, () => {
        const cleared = [];
        let rect = { left: 130, top: 70, width: 40, height: 32 };
        const context = {
            clearRect: (...args) => cleared.push(args),
            createLinearGradient: () => ({ addColorStop() {} }),
            beginPath() {}, moveTo() {}, quadraticCurveTo() {}, lineTo() {}, stroke() {}
        };
        const canvas = {
            clientWidth: 400, clientHeight: 140,
            getContext: () => context,
            getBoundingClientRect: () => ({ left: 100, top: 50 }),
            parentElement: { querySelectorAll: selector => {
                assert.equal(selector, 'button, [role="button"]');
                return [{ getBoundingClientRect: () => rect }];
            } }
        };
        const drawSpectrum = new Function("devicePixelRatio", `${draw}; return drawSpectrum;`)(ratio);
        drawSpectrum(canvas, [0.5, 0.5, 0.5, 0.5]);
        assert.deepEqual(cleared, [[0, 0, 400 * ratio, 140 * ratio], [30 * ratio, 20 * ratio, 40 * ratio, 32 * ratio]]);
        rect = { left: 150, top: 90, width: 50, height: 36 };
        drawSpectrum(canvas, [0.5, 0.5, 0.5, 0.5]);
        assert.deepEqual(cleared.at(-1), [50 * ratio, 40 * ratio, 50 * ratio, 36 * ratio]);
    });
}
