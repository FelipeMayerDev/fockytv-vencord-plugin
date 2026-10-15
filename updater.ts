// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

interface Installation { source: string; node: string; client: "discord" | "vesktop"; target: string; revision: string; }
const repository = "FelipeMayerDev/fockytv-vencord-plugin";
let installing = false;

function installation(directory: string): Installation {
    const file = join(directory, "fockytv-update.json");
    if (!existsSync(file)) throw new Error("Execute o instalador novamente para habilitar as atualizações pelo plugin.");
    const state = JSON.parse(readFileSync(file, "utf8")) as Installation;
    if (!/^[a-f0-9]{40}$/.test(state.revision) || !["discord", "vesktop"].includes(state.client) ||
        typeof state.source !== "string" || !isAbsolute(state.source) || typeof state.node !== "string" || !isAbsolute(state.node) ||
        typeof state.target !== "string" || !isAbsolute(state.target) ||
        !existsSync(state.node) || !existsSync(join(state.source, "package.json")))
        throw new Error("Dados da instalação inválidos. Execute o instalador novamente.");
    return state;
}

async function latestRevision() {
    const response = await fetch(`https://api.github.com/repos/${repository}/commits/main`, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Não foi possível verificar atualizações (HTTP ${response.status}).`);
    const { sha } = await response.json();
    if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("Versão de atualização inválida.");
    return sha;
}

export async function checkUpdate(directory: string) {
    const state = installation(directory);
    const revision = await latestRevision();
    return { available: revision !== state.revision, revision };
}

export async function installUpdate(directory: string) {
    if (installing) throw new Error("Uma atualização já está em andamento.");
    installing = true;
    try {
        const state = installation(directory);
        const revision = await latestRevision();
        if (revision === state.revision) { installing = false; return { started: false }; }
        const response = await fetch(`https://raw.githubusercontent.com/${repository}/${revision}/installer/install.mjs`, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Download do instalador falhou (HTTP ${response.status}).`);
        const script = await response.text();
        if (!script.length || Buffer.byteLength(script) > 512 * 1024) throw new Error("Instalador de atualização inválido.");
        const folder = join(state.source, ".fockytv-updater");
        mkdirSync(folder, { recursive: true });
        const file = join(folder, "install.mjs");
        writeFileSync(`${file}.download`, script);
        renameSync(`${file}.download`, file);
        const log = openSync(join(folder, "update.log"), "w", 0o600);
        try {
            const child = spawn(state.node, [file, "--client", state.client, "--source", state.source, "--target", state.target], {
                detached: true, windowsHide: true, stdio: ["ignore", log, log]
            });
            child.once("exit", () => { installing = false; });
            await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
            child.unref();
        } finally { closeSync(log); }
        return { started: true };
    } catch (error) { installing = false; throw error; }
}
