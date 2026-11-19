// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";

import { discordPatches } from "./discord";
import { discordFixtures } from "./discord-fixtures";

// Mesma verificação do self-check (o portão que o instalador roda antes de compilar):
// cada patch precisa continuar casando com a amostra do código atual do Discord,
// na mesma ordem. Patch trocado sem atualizar a fixture quebra a instalação.
test("cada patch muda a fixture do código atual do Discord, na mesma ordem", () => {
    assert.equal(discordFixtures.length, discordPatches.length, "Uma fixture por patch, na ordem de discordPatches");
    discordPatches.forEach((patch, index) => {
        const replacements = Array.isArray(patch.replacement) ? patch.replacement : [patch.replacement];
        for (const replacement of replacements) {
            const match = typeof replacement.match === "string" ? replacement.match
                : new RegExp(replacement.match.source.replaceAll(String.raw`\i`, String.raw`[A-Za-z_$][\w$]*`), replacement.match.flags);
            const output = discordFixtures[index].replace(match, replacement.replace);
            assert.notEqual(output, discordFixtures[index], `Patch ${index} (${String(patch.find).slice(0, 40)}) precisa mudar a fixture`);
            // Wrappers com $& continuam casando depois de aplicados; o Vencord só aplica uma vez.
            if (match instanceof RegExp && match.global && !replacement.replace.includes("$&"))
                assert.equal(output.replace(match, "").length, output.length);
            if (replacement.replace.includes("$self.")) assert.ok(output.includes("$self."));
            else if (discordFixtures[index].includes("createExperiment")) {
                const experiment = new Function("createExperiment", `return ${output}`)((config: unknown) => config);
                assert.equal(experiment.defaultConfig.videoEnabled, true);
                assert.deepEqual(experiment.variations, {});
            }
        }
    });
});
