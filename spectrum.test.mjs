import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
const draw = stripTypeScriptTypes(source.slice(source.indexOf("function drawSpectrum("), source.indexOf("// Botão de música ao lado")));

for (const ratio of [1, 2]) {
    test(`spectrum clears translucent controls from cached holes at pixel ratio ${ratio}, with a cached gradient`, () => {
        const cleared = [];
        let gradients = 0;
        const context = {
            clearRect: (...args) => cleared.push(args),
            createLinearGradient: () => { gradients++; return { addColorStop() {} }; },
            beginPath() {}, moveTo() {}, quadraticCurveTo() {}, lineTo() {}, stroke() {}
        };
        const canvas = {
            clientWidth: 400, clientHeight: 140, width: 0, height: 0,
            getContext: () => context
        };
        // O cache do gradiente é estado do módulo; o sandbox precisa declará-lo junto do trecho extraído.
        const drawSpectrum = new Function("devicePixelRatio", `let spectrumKey = ""; let spectrumGradient; ${draw}; return drawSpectrum;`)(ratio);
        // Os buracos dos botões chegam já medidos em pixels do canvas: um clearRect do fundo e um por buraco.
        drawSpectrum(canvas, [0.5, 0.5, 0.5, 0.5], [{ x: 30 * ratio, y: 20 * ratio, w: 40 * ratio, h: 32 * ratio }]);
        assert.deepEqual(cleared, [[0, 0, 400 * ratio, 140 * ratio], [30 * ratio, 20 * ratio, 40 * ratio, 32 * ratio]]);
        cleared.length = 0;
        drawSpectrum(canvas, [0.5, 0.5, 0.5, 0.5], [{ x: 50 * ratio, y: 40 * ratio, w: 50 * ratio, h: 36 * ratio }]);
        assert.deepEqual(cleared.at(-1), [50 * ratio, 40 * ratio, 50 * ratio, 36 * ratio]);
        // O gradiente é recriado só quando o passo de cor ou a largura mudam; dois quadros seguidos
        // podem cruzar uma virada de 500ms, então no máximo dois.
        assert.ok(gradients <= 2);
    });
}
