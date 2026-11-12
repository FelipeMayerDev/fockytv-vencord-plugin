// SPDX-License-Identifier: GPL-3.0-or-later
// Regenera o FockyTV-vencord.zip na raiz do repositório: snapshot de código-fonte
// sem testes, docs e binários. Determinístico: lista ordenada e data fixa (1980),
// então o mesmo conteúdo produz exatamente os mesmos bytes.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const zip = join(root, "FockyTV-vencord.zip");
const stage = mkdtempSync(join(tmpdir(), "fockytv-pack-"));
const temporary = `${zip}.tmp`;

// Pastas e arquivos que não vão para a distribuição.
const skipDirectories = new Set([".git", ".zcode", "docs"]);
const skipFile = name => /\.test\.(?:ts|mjs)$/.test(name) || name === "audio-helper.exe" || name === "audio-helper.cpp" ||
    /^FockyTV-vencord\.zip(?:\.tmp)?$/.test(name);

function collect(directory, prefix = "") {
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!skipDirectories.has(entry.name)) files.push(...collect(join(directory, entry.name), `${prefix}${entry.name}/`));
        } else if (entry.isFile() && !skipFile(entry.name)) files.push(prefix + entry.name);
    }
    return files;
}

const files = collect(root).sort();
const stamp = new Date(1980, 0, 1);
try {
    for (const file of files) {
        const target = join(stage, file);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(root, file), target);
        utimesSync(target, stamp, stamp);
    }
    const packed = spawnSync("zip", ["-X", "-q", temporary, ...files], { cwd: stage, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
    if (packed.error) throw packed.error;
    if (packed.status !== 0) throw new Error(`zip falhou (${packed.status}): ${(packed.stderr || "").trim()}`);
    renameSync(temporary, zip);
    console.log(`FockyTV-vencord.zip: ${files.length} arquivos, ${statSync(zip).size} bytes`);
} finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(temporary, { force: true });
}
