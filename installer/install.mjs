// SPDX-License-Identifier: GPL-3.0-or-later
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { spawnSync as spawnProcess } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

// A atualização pelo plugin roda sem console: no Windows, cada git/pnpm/powershell abriria uma janela própria.
const spawnSync = (command, args, options = {}) => spawnProcess(command, args, { windowsHide: true, ...options });

const PLUGIN_REPO = "https://github.com/FelipeMayerDev/fockytv-vencord-plugin.git";
const home = process.env.USERPROFILE || process.env.HOME || homedir();
const config = process.env.APPDATA || process.env.XDG_CONFIG_HOME || join(home, ".config");
const workspace = process.platform === "win32"
    ? join(process.env.LOCALAPPDATA, "FockyTV", "build")
    : join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "fockytv", "build");
const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
const win = process.platform === "win32";
// Equicord is a Vencord fork with its own build layout, data folder and installer (Equilotl).
export const MODS = {
    vencord: {
        name: "Vencord",
        repo: "https://github.com/Vendicated/Vencord.git",
        installer: `https://github.com/Vencord/Installer/releases/latest/download/${win ? "VencordInstallerCli.exe" : "VencordInstallerCli-linux"}`,
        files: ["patcher.js", "vencordDesktopMain.js", "vencordDesktopRenderer.js", "vencordDesktopPreload.js", "vencordDesktopRenderer.css"],
        patcher: source => join(source, "dist", "patcher.js"),
        env: source => ({ VENCORD_USER_DATA_DIR: source, VENCORD_DEV_INSTALL: "1" }),
        settings: client => client.settings
    },
    equicord: {
        name: "Equicord",
        repo: "https://github.com/Equicord/Equicord.git",
        installer: `https://github.com/Equicord/Equilotl/releases/latest/download/${win ? "EquilotlCli.exe" : "EquilotlCli-linux"}`,
        files: [join("desktop", "patcher.js"), join("desktop", "renderer.js"), join("desktop", "preload.js"), join("desktop", "renderer.css")],
        patcher: source => join(source, "dist", "desktop"),
        env: source => ({ EQUICORD_USER_DATA_DIR: source, EQUICORD_DIRECTORY: join(source, "dist", "desktop"), EQUICORD_DEV_INSTALL: "1" }),
        settings: client => join(process.env.EQUICORD_USER_DATA_DIR || join(client.data, "Equicord"), "settings", "settings.json")
    }
};

// Accepts a source checkout or an injected build path.
export function modFor(path) {
    return path && (existsSync(join(path, "src", "equicordplugins")) || /[/\\]equicord\.asar$/i.test(path)) ? MODS.equicord : MODS.vencord;
}

// A app-* mais nova que esteja completa: durante uma atualização o Discord já criou a pasta nova, ainda vazia.
function latestResources(location) {
    return entries(location).filter(name => /^app-\d/.test(name)).sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
        .map(version => join(location, version, "resources")).find(resources => existsSync(join(resources, "app.asar")) || existsSync(join(resources, "_app.asar")));
}

function entries(directory) {
    try { return readdirSync(directory); }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return []; throw error; }
}

export function readJSON(file) {
    if (!existsSync(file)) return {};
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`JSON invalido: ${file}`);
    return data;
}

export function saveJSON(file, data) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) copyFileSync(file, `${file}.fockytv-backup-${stamp}`);
    const temporary = `${file}.fockytv-${process.pid}.tmp`;
    try {
        writeFileSync(temporary, JSON.stringify(data, null, 4) + "\n", { mode: 0o600 });
        renameSync(temporary, file);
    } finally { rmSync(temporary, { force: true }); }
}

export function sourceFromBuild(build) {
    if (!build) return;
    let directory = resolve(build);
    for (let i = 0; i < 4; i++, directory = dirname(directory)) {
        if (existsSync(join(directory, "scripts", "build", "build.mjs")) && existsSync(join(directory, "src", "webpack"))) return directory;
    }
}

export function injectedBuild(resources) {
    // The Vencord/Equicord patcher re-injects after Discord host updates by turning app.asar into a folder.
    for (const file of [join(resources, "app", "index.js"), join(resources, "app.asar", "index.js"), join(resources, "app.asar")]) {
        if (!existsSync(file) || !statSync(file).isFile() || statSync(file).size > 65536) continue;
        const text = readFileSync(file, "utf8");
        for (const match of text.matchAll(/require\(("(?:\\.|[^"\\])*")\)/g)) {
            const path = JSON.parse(match[1]);
            if (/[/\\](?:patcher\.js|desktop|vencord\.asar|equicord\.asar)$/.test(path)) return path;
        }
    }
}

function executable(name) {
    const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
    for (const directory of (process.env.PATH || "").split(delimiter)) {
        for (const extension of extensions) {
            const file = join(directory, name + extension);
            try { accessSync(file, constants.X_OK); if (statSync(file).isFile()) return file; } catch {}
        }
    }
}

export function discoverClients(env = process.env) {
    const userHome = env.USERPROFILE || env.HOME || homedir();
    const userConfig = env.APPDATA || env.XDG_CONFIG_HOME || join(userHome, ".config");
    const found = [];
    const seen = new Set();
    const addDiscord = (resources, location, name, flatpak) => {
        if ((!existsSync(join(resources, "app.asar")) && !existsSync(join(resources, "_app.asar"))) || seen.has(resolve(resources))) return;
        seen.add(resolve(resources));
        const build = injectedBuild(resources);
        const data = flatpak ? join(userHome, ".var", "app", flatpak, "config") : userConfig;
        const settings = env.VENCORD_USER_DATA_DIR || join(data, "Vencord");
        found.push({ id: "discord", name, resources, location, flatpak, build, data, source: sourceFromBuild(build), settings: join(settings, "settings", "settings.json") });
    };
    if (process.platform === "win32") {
        for (const name of ["Discord", "DiscordPTB", "DiscordCanary"]) {
            const location = join(env.LOCALAPPDATA || join(userHome, "AppData", "Local"), name);
            const resources = latestResources(location);
            if (resources) addDiscord(resources, location, name);
        }
    } else {
        for (const name of ["discord", "discordptb", "discordcanary"]) {
            const location = join(userConfig, name);
            const resources = latestResources(location);
            if (resources) addDiscord(resources, location, name);
        }
        for (const prefix of ["/usr/share", "/usr/lib", "/usr/lib64", "/opt", join(userHome, ".local", "share")]) {
            for (const name of ["discord", "Discord", "discord-ptb", "discord-canary"]) {
                const location = join(prefix, name);
                addDiscord(join(location, "resources"), location, name);
                addDiscord(location, location, name);
            }
        }
        for (const id of ["com.discordapp.Discord", "com.discordapp.DiscordPTB", "com.discordapp.DiscordCanary"]) {
            const location = join(userHome, ".var", "app", id, "config", "discord");
            const resources = latestResources(location);
            if (resources) addDiscord(resources, location, id, id);
        }
        for (const prefix of [join(userHome, ".local", "share", "flatpak", "app"), "/var/lib/flatpak/app"]) {
            for (const id of ["com.discordapp.Discord", "com.discordapp.DiscordPTB", "com.discordapp.DiscordCanary"]) {
                const location = join(prefix, id);
                const files = join(location, "current", "active", "files");
                addDiscord(join(files, "discord", "resources"), location, id, id);
                addDiscord(join(files, "discord"), location, id, id);
                for (const version of entries(join(files, "discord")).filter(name => /^app-\d/.test(name)))
                    addDiscord(join(files, "discord", version, "resources"), location, id, id);
            }
        }
    }
    const vesktopProfiles = [join(userConfig, "vesktop"), join(userConfig, "Vesktop")];
    if (process.platform === "linux") vesktopProfiles.push(join(userHome, ".var", "app", "dev.vencord.Vesktop", "config", "vesktop"));
    for (const profile of vesktopProfiles) {
        const flatpak = profile.includes(`${join(".var", "app")}`) ? "dev.vencord.Vesktop" : undefined;
        const key = process.platform === "win32" ? resolve(profile).toLowerCase() : resolve(profile);
        if (!existsSync(profile) || seen.has(key)) continue;
        seen.add(key);
        const stateFile = join(profile, "state.json");
        const state = readJSON(stateFile);
        found.push({ id: "vesktop", name: `Vesktop${flatpak ? " (Flatpak)" : ""}`, profile, stateFile, flatpak, build: state.vencordDir, source: sourceFromBuild(state.vencordDir), settings: join(profile, "settings", "settings.json") });
    }
    const vesktopExecutable = executable("vesktop") || (process.platform === "win32" && [
        join(env.LOCALAPPDATA || join(userHome, "AppData", "Local"), "Programs", "Vesktop", "Vesktop.exe"),
        join(env.LOCALAPPDATA || join(userHome, "AppData", "Local"), "vesktop", "Vesktop.exe"), // instalador por usuário (1.6+)
        join(env.ProgramFiles || "C:\\Program Files", "Vesktop", "Vesktop.exe")
    ].find(file => existsSync(file)));
    if (!found.some(client => client.id === "vesktop") && vesktopExecutable) {
        const profile = join(userConfig, "vesktop");
        found.push({ id: "vesktop", name: "Vesktop", profile, stateFile: join(profile, "state.json"), settings: join(profile, "settings", "settings.json") });
    }
    return found;
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { stdio: "inherit", ...options });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Falhou (${result.status}): ${basename(command)} ${args.join(" ")}`);
}

async function download(url, file) {
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Download HTTP ${response.status}: ${url}`);
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.download`;
    try { writeFileSync(temporary, Buffer.from(await response.arrayBuffer())); renameSync(temporary, file); }
    finally { rmSync(temporary, { force: true }); }
}

export async function portableGit(directory) {
    const git = join(directory, "cmd", "git.exe");
    if (existsSync(git)) return git;
    console.log("Baixando Git portatil para o FockyTV (sem alterar o Git do sistema)...");
    const response = await fetch("https://api.github.com/repos/git-for-windows/git/releases/latest", { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Manifesto Git HTTP ${response.status}.`);
    const release = await response.json();
    const asset = release.assets?.find(asset => /^MinGit-[\d.]+-64-bit\.zip$/.test(asset.name));
    if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest) ||
        !asset.browser_download_url?.startsWith("https://github.com/git-for-windows/git/releases/download/"))
        throw new Error("Manifesto Git invalido ou sem SHA-256.");
    mkdirSync(dirname(directory), { recursive: true });
    const stage = mkdtempSync(`${directory}.stage-`);
    try {
        const zip = join(stage, "git.zip"), extracted = join(stage, "git");
        await download(asset.browser_download_url, zip);
        if (`sha256:${createHash("sha256").update(readFileSync(zip)).digest("hex")}` !== asset.digest)
            throw new Error("Checksum Git invalido.");
        run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $env:FOCKYTV_GIT_ZIP -DestinationPath $env:FOCKYTV_GIT_TARGET"], {
            env: { ...process.env, FOCKYTV_GIT_ZIP: zip, FOCKYTV_GIT_TARGET: extracted }
        });
        run(join(extracted, "cmd", "git.exe"), ["--version"]);
        rmSync(directory, { recursive: true, force: true });
        renameSync(extracted, directory);
    } finally { rmSync(stage, { recursive: true, force: true }); }
    return git;
}

export async function ensureGit() {
    let git = executable("git");
    if (git) return git;
    console.log("Git nao encontrado; instalando a dependencia de compilacao.");
    if (process.platform === "win32") {
        const portable = join(workspace, "tools", "git");
        if (existsSync(join(portable, "cmd", "git.exe"))) git = await portableGit(portable);
        else if (executable("winget")) {
            try {
                run("winget.exe", ["install", "--id", "Git.Git", "-e", "--silent", "--accept-source-agreements", "--accept-package-agreements"]);
            } catch (error) { console.warn(`winget indisponivel: ${error.message}. Usando Git portatil.`); }
            for (const prefix of [process.env.ProgramFiles, join(process.env.LOCALAPPDATA, "Programs")].filter(Boolean)) {
                const file = join(prefix, "Git", "cmd", "git.exe");
                if (existsSync(file)) { git = file; break; }
            }
        }
        git ??= await portableGit(portable);
    } else {
        const commands = [["apt-get", ["install", "-y", "git"]], ["dnf", ["install", "-y", "git"]], ["pacman", ["-S", "--needed", "--noconfirm", "git"]], ["zypper", ["--non-interactive", "install", "git"]]];
        const manager = commands.find(([name]) => executable(name));
        if (!manager) throw new Error("Instale Git pelo gerenciador da sua distribuicao e execute novamente.");
        run("sudo", [manager[0], ...manager[1]]);
        git = executable("git");
    }
    if (!git) throw new Error("Git instalado, mas nao localizado. Reabra o terminal e tente novamente.");
    process.env.PATH = dirname(git) + delimiter + process.env.PATH;
    return git;
}

async function pnpmFor(source) {
    const manager = readJSON(join(source, "package.json")).packageManager;
    const version = /^pnpm@(\d+\.\d+\.\d+)(?:\+.*)?$/.exec(manager || "")?.[1];
    if (!version) throw new Error("O checkout nao informa uma versao valida de pnpm.");
    const tools = join(workspace, "tools", version);
    // pnpm <=10 ships bin/pnpm.cjs; pnpm >=11 ships bin/pnpm.mjs (wrapper for the native binary)
    const entry = () => ["pnpm.cjs", "pnpm.mjs"].map(file => join(tools, "node_modules", "pnpm", "bin", file)).find(file => existsSync(file));
    if (!entry()) {
        const npm = [
            join(dirname(process.execPath), process.platform === "win32" ? "node_modules" : "../lib/node_modules", "npm", "bin", "npm-cli.js"),
            "/usr/share/nodejs/npm/bin/npm-cli.js"
        ].find(file => existsSync(file));
        if (!npm) throw new Error("npm nao encontrado. Use o instalador bootstrap para obter Node completo.");
        run(process.execPath, [npm, "install", "--prefix", tools, "--no-audit", "--no-fund", "--ignore-scripts", `pnpm@${version}`]);
    }
    const pnpm = entry();
    if (!pnpm) throw new Error(`pnpm@${version} instalado, mas sem ponto de entrada conhecido.`);
    return args => run(process.execPath, [pnpm, ...args], { cwd: source });
}

export function stopClient(client) {
    console.log(`Fechando ${client.name} para aplicar o plugin...`);
    if (client.flatpak && process.platform === "linux") {
        spawnSync("flatpak", ["kill", client.flatpak], { stdio: "ignore" });
        return;
    }
    const names = client.id === "vesktop" ? ["vesktop", "Vesktop"]
        : client.name.toLowerCase().includes("canary") ? ["DiscordCanary", "discordcanary", "discord-canary"]
            : client.name.toLowerCase().includes("ptb") ? ["DiscordPTB", "discordptb", "discord-ptb"] : ["Discord", "discord"];
    const active = () => names.some(name => {
        const result = process.platform === "win32"
            ? spawnSync("tasklist.exe", ["/FI", `IMAGENAME eq ${name}.exe`, "/FO", "CSV", "/NH"], { encoding: "utf8" })
            : spawnSync("pgrep", ["-x", name]);
        if (result.error || result.status === null || result.status > (process.platform === "win32" ? 0 : 1))
            throw new Error(`Nao foi possivel verificar processos do ${client.name}; feche o cliente e verifique tasklist/pgrep.`);
        return process.platform === "win32" ? result.stdout.toLowerCase().includes(`"${name.toLowerCase()}.exe"`) : result.status === 0;
    });
    if (!active()) return;
    for (const name of names) {
        // /T mataria também o instalador Node iniciado pelo cliente; /F evita minimizar para a bandeja.
        if (process.platform === "win32") spawnSync("taskkill.exe", ["/IM", `${name}.exe`, "/F"], { stdio: "ignore" });
        else spawnSync("pkill", ["-TERM", "-x", name], { stdio: "ignore" });
    }
    const deadline = Date.now() + 10_000;
    while (active() && Date.now() < deadline) spawnSync(process.execPath, ["-e", "setTimeout(()=>{},200)"]);
    if (active()) throw new Error(`Feche ${client.name} completamente pela bandeja e execute novamente.`);
}

export function enablePlugin(settings) {
    settings.plugins ??= {};
    settings.plugins.FockyTV = { ...settings.plugins.FockyTV, enabled: true };
    settings.plugins.FakeNitro = { ...settings.plugins.FakeNitro, enabled: true };
    if (!settings.plugins.FockyTV.url || settings.plugins.FockyTV.url === "https://tv.huestavo.com")
        settings.plugins.FockyTV.url = "https://fockytv.felipemayer.com.br";
    return settings;
}

export function saveUpdateState(source, client, revision) {
    if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Revisao do plugin invalida.");
    const directory = modFor(source) === MODS.equicord ? join(source, "dist", "desktop") : join(source, "dist");
    writeFileSync(join(directory, "fockytv-update.json"), JSON.stringify({ source, client: client.id, target: client.location || client.profile, revision, node: process.execPath }));
}

// O Vencord/Equicord reinjeta após updates do Discord apontando para o patcher.js dentro da build.
export function sameBuild(build, source, mod) {
    const patcher = resolve(mod.patcher(source));
    return !!build && [patcher, join(patcher, "patcher.js")].includes(resolve(build));
}

// O Equilotl falha calado ao ler o app.asar em pasta dessa reinjeção: desfaz o patch antes do instalador oficial.
export function unpatchFolder(resources) {
    const app = join(resources, "app.asar"), original = join(resources, "_app.asar");
    if (!existsSync(original) || !statSync(app, { throwIfNoEntry: false })?.isDirectory()) return;
    rmSync(app, { recursive: true });
    renameSync(original, app);
}

export async function injectDiscord(client, source, mod) {
    const binary = join(workspace, basename(mod.installer));
    await download(mod.installer, binary);
    if (process.platform !== "win32") (await import("node:fs")).chmodSync(binary, 0o755);
    const args = ["--install", "--location", client.location];
    const variables = mod.env(source);
    let writable = true;
    try { accessSync(client.resources, constants.W_OK); } catch { writable = false; }
    if (writable) unpatchFolder(client.resources);
    if (!writable && process.platform === "linux") {
        console.log("A instalacao do Discord pertence ao sistema; sudo sera usado somente para a injecao oficial.");
        run("sudo", ["env", ...Object.entries(variables).map(([key, value]) => `${key}=${value}`), binary, ...args]);
    } else run(binary, args, { env: { ...process.env, ...variables } });
    if (!sameBuild(injectedBuild(client.resources), source, mod))
        throw new Error("O instalador oficial nao confirmou a injecao desta build. A configuracao do plugin nao foi alterada.");
}

// Cada build tem dezenas de MB: guarda só as mais recentes para desfazer uma atualização.
export function pruneBackups(directory, prefix, keep = 3) {
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory).filter(name => name.startsWith(prefix)).sort().slice(0, -keep))
        rmSync(join(directory, name), { recursive: true, force: true });
}

export function buildPlugin(source, plugin, pnpm) {
    const destination = join(source, "src", "userplugins", "fockytv");
    const pluginBackup = join(source, ".fockytv-backups", stamp, "plugin");
    const dist = join(source, "dist");
    const distBackup = `${dist}.fockytv-backup-${stamp}`;
    let pluginPrepared = false, distPrepared = false;
    try {
        if (existsSync(destination)) { mkdirSync(dirname(pluginBackup), { recursive: true }); renameSync(destination, pluginBackup); }
        pluginPrepared = true;
        if (existsSync(dist)) renameSync(dist, distBackup);
        distPrepared = true;
        mkdirSync(destination, { recursive: true });
        for (const entry of readdirSync(plugin, { withFileTypes: true })) {
            if (entry.isFile() && (/\.(?:tsx?|js|css|exe|cpp|png|mp3)$/.test(entry.name) || ["LICENSE", "README.md"].includes(entry.name))) copyFileSync(join(plugin, entry.name), join(destination, entry.name));
        }
        pnpm(["exec", "tsx", join(destination, "self-check.ts")]);
        pnpm(["build", "--disable-updater"]);
        for (const file of modFor(source).files)
            if (!existsSync(join(dist, file))) throw new Error(`Build incompleta: ${file}`);
        pruneBackups(source, "dist.fockytv-backup-");
        pruneBackups(join(source, ".fockytv-backups"), "");
    } catch (error) {
        if (pluginPrepared) {
            rmSync(destination, { recursive: true, force: true });
            if (existsSync(pluginBackup)) renameSync(pluginBackup, destination);
        }
        if (distPrepared) {
            rmSync(dist, { recursive: true, force: true });
            if (existsSync(distBackup)) renameSync(distBackup, dist);
        }
        throw error;
    }
    return dist;
}

// Best-effort desktop notification; a missing notifier never fails the install.
function notify(message) {
    if (process.platform === "win32") {
        const script = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText01)
$xml.GetElementsByTagName('text').Item(0).InnerText = '${message}'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($xml))`;
        spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore" });
    } else spawnSync("notify-send", ["FockyTV", message], { stdio: "ignore" });
}

export async function main(args = process.argv.slice(2)) {
    if (!["linux", "win32"].includes(process.platform) || process.arch !== "x64") throw new Error("Este instalador suporta Windows e Linux x64.");
    if (process.getuid?.() === 0) throw new Error("Execute como usuario normal; sudo sera solicitado apenas quando necessario.");
    const options = {};
    for (let i = 0; i < args.length; i++) {
        if (!["--client", "--source", "--target"].includes(args[i]) || !args[i + 1]) throw new Error("Uso: install.mjs [--client discord|vesktop] [--source caminho-do-Vencord-ou-Equicord] [--target caminho-do-cliente]");
        options[args[i].slice(2)] = args[++i];
    }
    if (options.client && !["discord", "vesktop"].includes(options.client)) throw new Error("Cliente invalido: escolha discord ou vesktop.");
    const clients = discoverClients().filter(client => (!options.client || client.id === options.client) &&
        (!options.target || resolve(client.location || client.profile) === resolve(options.target)));
    if (!clients.length) throw new Error("Discord/Vesktop nao encontrado. Instale e abra o cliente uma vez antes de continuar. Snap nao e suportado.");
    clients.forEach((client, i) => {
        const name = modFor(client.source || client.build).name;
        console.log(`${i + 1}. ${client.name}: ${client.source ? `${name} com fonte` : client.id === "vesktop" || client.build ? `${name} instalado` : "sem Vencord"}`);
    });
    let client = clients[0];
    if (clients.length > 1) {
        if (!process.stdin.isTTY) throw new Error("Mais de um cliente encontrado. Execute em um terminal interativo para escolher.");
        const input = createInterface({ input: process.stdin, output: process.stdout });
        try { const choice = await input.question("Em qual cliente instalar? "); client = clients[Number(choice) - 1]; }
        finally { input.close(); }
        if (!client) throw new Error("Escolha invalida.");
    }
    if (client.stateFile) readJSON(client.stateFile);
    if (client.id === "discord" && (existsSync(join(client.resources, "_app.asar")) || existsSync(join(client.resources, "app", "index.js"))) && !client.build)
        throw new Error("Cliente modificado por outro loader. Restaure-o pelo instalador original antes de instalar Vencord/Equicord.");
    const installed = modFor(client.source || client.build);
    if (client.build && !client.source && !options.source) {
        console.log(`${installed.name} binario detectado. A build anterior e as configuracoes serao preservadas; plugins personalizados sem fonte precisam ser adicionados ao novo checkout.`);
    }
    const git = await ensureGit();
    mkdirSync(workspace, { recursive: true });
    let source = options.source ? resolve(options.source) : client.source;
    if (!source) {
        for (const directory of [join(home, installed.name), join(home, "Projects", installed.name), join(home, "Documents", installed.name)]) {
            if (sourceFromBuild(directory)) { source = directory; break; }
        }
    }
    if (source && sourceFromBuild(source) !== source) throw new Error(`Fonte Vencord/Equicord invalida: ${source}`);
    if (!source) {
        source = join(workspace, installed.name);
        if (!existsSync(source)) run(git, ["clone", "--depth", "1", installed.repo, source]);
        else run(git, ["-C", source, "pull", "--ff-only"]);
    }
    const mod = modFor(source);
    if (client.id === "vesktop" && mod === MODS.equicord) throw new Error("Vesktop usa Vencord; para Equicord instale no Discord.");
    const settings = mod.settings(client);
    readJSON(settings);
    console.log(`Compilando em: ${source}`);
    let plugin = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    if (!existsSync(join(plugin, "index.tsx"))) {
        plugin = join(workspace, "plugin-source");
        if (!existsSync(plugin)) run(git, ["clone", "--depth", "1", "--branch", "main", PLUGIN_REPO, plugin]);
        else run(git, ["-C", plugin, "pull", "--ff-only"]);
    }
    const version = spawnSync(git, ["-C", plugin, "rev-parse", "HEAD"], { encoding: "utf8" });
    if (version.status !== 0 || !/^[a-f0-9]{40}$/.test(version.stdout.trim())) throw new Error("Nao foi possivel identificar a versao do plugin.");
    const pnpm = await pnpmFor(source);
    pnpm(["install", "--frozen-lockfile"]);
    stopClient(client);
    const dist = buildPlugin(source, plugin, pnpm);
    if (client.id === "vesktop") {
        // O Vesktop baixa o Vencord oficial por cima da pasta se faltar algum destes arquivos (package.json desde a 1.6.7).
        // A build do Vencord não gera o package.json; e um Vesktop aberto durante a build (ex.: pelo setup) também baixaria.
        stopClient(client);
        writeFileSync(join(dist, "package.json"), "{}");
        if (!readFileSync(join(dist, "vencordDesktopRenderer.js"), "utf8").includes("FockyTV"))
            throw new Error("O Vesktop foi aberto durante a compilacao e substituiu a build. Feche o Vesktop e execute novamente.");
        if (client.flatpak) run("flatpak", ["override", "--user", `--filesystem=${dist}:ro`, client.flatpak]);
        const state = readJSON(client.stateFile);
        state.vencordDir = dist;
        saveJSON(client.stateFile, state);
    } else if (!sameBuild(client.build, source, mod)) {
        await injectDiscord(client, source, mod);
    }
    saveUpdateState(source, client, version.stdout.trim());
    saveJSON(settings, enablePlugin(readJSON(settings)));
    console.log(`FockyTV instalado e ativo no ${client.name}. Abra o cliente para usar.`);
    console.log(`Backups preservados em ${source} e junto aos arquivos de configuracao.`);
    notify("FockyTV instalado!");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => {
        console.error(`FockyTV: ${error.message}`);
        notify("Falha na instalacao do FockyTV. Execute o instalador no terminal para ver o erro.");
        process.exitCode = 1;
    });
}
