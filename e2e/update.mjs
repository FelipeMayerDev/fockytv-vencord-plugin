// SPDX-License-Identifier: GPL-3.0-or-later
// Teste funcional da atualização, num HOME isolado com um Vesktop falso (Linux):
// 1. instalação inicial com o instalador e o código deste checkout (pega build e self-check quebrados antes do push);
// 2. o mesmo caminho do botão "Atualizar": checkUpdate/installUpdate do updater.ts baixam o instalador do GitHub
//    e atualizam para o último commit do canal (pega o que já foi publicado).
// pgrep/pkill falsos no PATH: o instalador fecha o cliente pelo nome do processo e mataria o seu Vesktop.
//
// Uso: node e2e/update.mjs [insider|main]
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const branch = process.argv[2] ?? "insider";
const sandbox = mkdtempSync(join(tmpdir(), "fockytv-e2e-update-"));
const bin = join(sandbox, "bin"), profile = join(sandbox, "config", "vesktop");
mkdirSync(bin, { recursive: true });
mkdirSync(profile, { recursive: true });
writeFileSync(join(profile, "state.json"), "{}");
for (const [name, code] of [["pgrep", 1], ["pkill", 0], ["notify-send", 0]]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nexit ${code}\n`);
    chmodSync(join(bin, name), 0o755);
}
Object.assign(process.env, {
    HOME: join(sandbox, "home"), XDG_CONFIG_HOME: join(sandbox, "config"), XDG_DATA_HOME: join(sandbox, "data"),
    PATH: `${bin}:${process.env.PATH}`,
    // Reaproveita o cache do pnpm da máquina: sem ele cada rodada baixa todas as dependências do Vencord.
    npm_config_store_dir: process.env.npm_config_store_dir ?? join(homedir(), ".local", "share", "pnpm", "store")
});
const step = (ok, message) => { console.log(`${ok ? "ok" : "FALHOU"} ${message}`); if (!ok) throw Object.assign(new Error(message), { reported: true }); };
const dist = () => JSON.parse(readFileSync(join(profile, "state.json"), "utf8")).vencordDir;
const renderer = () => readFileSync(join(dist(), "vencordDesktopRenderer.js"), "utf8");

try {
    console.log(`Sandbox: ${sandbox}`);
    const install = spawnSync(process.execPath, [join(root, "installer", "install.mjs"), "--client", "vesktop", "--target", profile], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    if (install.status !== 0) console.log((install.stdout + install.stderr).split("\n").slice(-25).join("\n"));
    step(install.status === 0, "instalação inicial com o código local (self-check e build)");
    step(!!dist() && renderer().includes("FockyTV"), "Vesktop aponta para a build com o FockyTV");

    // Finge uma versão antiga instalada para o botão ter o que atualizar.
    const stateFile = join(dist(), "fockytv-update.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    writeFileSync(stateFile, JSON.stringify({ ...state, revision: "0".repeat(40), branch }));
    const { checkUpdate, installUpdate } = await import(join(root, "updater.ts"));
    const check = await checkUpdate(dist(), branch);
    step(check.available, `botão vê a atualização do canal ${branch} (${check.revision.slice(0, 7)})`);
    // O updater reabre o cliente com o próprio executável; aqui é este node, que sai na hora.
    step((await installUpdate(dist(), branch)).started, "botão inicia a instalação");
    const log = join(state.source, ".fockytv-updater", "update.log");
    const deadline = Date.now() + 10 * 60_000;
    // O botão dispara o instalador destacado; espera o processo dele sair (pgrep real, o do PATH é falso).
    const installer = join(state.source, ".fockytv-updater", "install.mjs");
    while (Date.now() < deadline && spawnSync("/usr/bin/pgrep", ["-f", installer]).status === 0)
        await new Promise(resolve => setTimeout(resolve, 1000));
    const output = existsSync(log) ? readFileSync(log, "utf8") : "";
    if (!output.includes("FockyTV instalado")) console.log(output.split("\n").slice(-25).join("\n"));
    step(output.includes("FockyTV instalado"), "instalação pelo botão terminou");
    const updated = JSON.parse(readFileSync(join(dist(), "fockytv-update.json"), "utf8"));
    step(updated.revision === check.revision && updated.branch === branch, `versão instalada = ${branch} ${check.revision.slice(0, 7)}`);
    step(renderer().includes("FockyTV") && !(await checkUpdate(dist(), branch)).available, "depois de atualizar, o botão diz que está em dia");
} catch (error) {
    if (!error.reported) console.log(`FALHOU ${error.message}`);
    process.exitCode = 1;
} finally {
    if (process.exitCode) console.log(`Sandbox mantido para investigar: ${sandbox}`);
    else rmSync(sandbox, { recursive: true, force: true });
}
