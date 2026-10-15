// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { buildPlugin, discoverClients, enablePlugin, injectedBuild, readJSON, saveJSON, sourceFromBuild } from "./install.mjs";

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), "FockyTV installer test "));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
}
function file(path, data = "") { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); }
function source(root) {
    const directory = join(root, "Vencord");
    file(join(directory, "scripts", "build", "build.mjs"));
    mkdirSync(join(directory, "src", "webpack"), { recursive: true });
    return directory;
}

test("reads Vencord ASAR injection and locates its original checkout", t => {
    const root = fixture(t), checkout = source(root), resources = join(root, "Discord", "resources");
    const patcher = join(checkout, "dist", "patcher.js");
    file(join(resources, "app.asar"), Buffer.concat([Buffer.alloc(32), Buffer.from(`require(${JSON.stringify(patcher)})`)]));
    assert.equal(injectedBuild(resources), patcher);
    assert.equal(sourceFromBuild(patcher), checkout);
    assert.equal(sourceFromBuild(join(root, "missing")), undefined);
});

test("ordinary Discord ASAR is not mistaken for Vencord", t => {
    const root = fixture(t);
    file(join(root, "app.asar"), 'require("./core.asar")');
    assert.equal(injectedBuild(root), undefined);
});

test("client discovery selects newest Discord version and Vesktop state", t => {
    const root = fixture(t), checkout = source(root), config = join(root, "config"), local = join(root, "local");
    const installation = process.platform === "win32" ? join(local, "Discord") : join(config, "discord");
    file(join(installation, "app-1.0.9", "resources", "app.asar"));
    const newest = join(installation, "app-1.0.10", "resources");
    file(join(newest, "app.asar"), `require(${JSON.stringify(join(checkout, "dist", "patcher.js"))})`);
    const profile = join(config, "vesktop");
    file(join(profile, "state.json"), JSON.stringify({ vencordDir: join(checkout, "dist"), maximized: true }));
    const clients = discoverClients({ HOME: root, USERPROFILE: root, APPDATA: config, LOCALAPPDATA: local });
    assert.equal(clients.find(client => client.resources === newest)?.source, checkout);
    assert.equal(clients.some(client => client.resources === join(installation, "app-1.0.9", "resources")), false);
    const vesktop = clients.filter(client => client.profile === profile);
    assert.equal(vesktop.length, 1);
    assert.equal(vesktop[0].source, checkout);
    assert.equal(vesktop[0].settings, join(profile, "settings", "settings.json"));
});

test("Linux discovers Discord and Vesktop Flatpak profiles", { skip: process.platform !== "linux" }, t => {
    const root = fixture(t), config = join(root, "config");
    const location = join(root, ".local", "share", "flatpak", "app", "com.discordapp.Discord");
    file(join(location, "current", "active", "files", "discord", "app-1.0.10", "resources", "app.asar"));
    const profile = join(root, ".var", "app", "dev.vencord.Vesktop", "config", "vesktop");
    file(join(profile, "state.json"), "{}");
    const modern = join(root, ".var", "app", "com.discordapp.DiscordPTB", "config", "discord");
    file(join(modern, "app-1.0.20", "resources", "app.asar"));
    const clients = discoverClients({ HOME: root, XDG_CONFIG_HOME: config });
    assert.equal(clients.find(client => client.location === modern).flatpak, "com.discordapp.DiscordPTB");
    const discord = clients.find(client => client.location === location);
    assert.equal(discord.flatpak, "com.discordapp.Discord");
    assert.equal(discord.settings, join(root, ".var", "app", "com.discordapp.Discord", "config", "Vencord", "settings", "settings.json"));
    assert.equal(clients.find(client => client.profile === profile).flatpak, "dev.vencord.Vesktop");
});

test("activation preserves other plugins and settings, with a recoverable backup", t => {
    const root = fixture(t), settings = join(root, "settings.json");
    const original = { theme: "dark", plugins: { Other: { enabled: true }, FockyTV: { url: "https://tv.example", nick: "Rubi", enabled: false } } };
    file(settings, JSON.stringify(original));
    saveJSON(settings, enablePlugin(readJSON(settings)));
    const updated = readJSON(settings);
    assert.equal(updated.plugins.FockyTV.enabled, true);
    assert.equal(updated.plugins.FockyTV.nick, "Rubi");
    assert.equal(updated.plugins.FockyTV.url, "https://tv.example");
    assert.deepEqual(updated.plugins.Other, original.plugins.Other);
    assert.equal(updated.theme, "dark");
    const backup = readdirSync(root).find(name => name.startsWith("settings.json.fockytv-backup-"));
    assert.deepEqual(readJSON(join(root, backup)), original);
});

test("malformed settings are rejected without overwriting them", t => {
    const root = fixture(t), settings = join(root, "settings.json");
    file(settings, '{"plugins":');
    assert.throws(() => readJSON(settings));
    assert.equal(readFileSync(settings, "utf8"), '{"plugins":');
    file(settings, "[]");
    assert.throws(() => readJSON(settings), /JSON invalido/);
});

for (const failure of ["none", "build", "incomplete"]) {
    test(`build preserves unrelated plugins and restores files on ${failure}`, t => {
        const root = fixture(t), checkout = source(root), plugin = join(root, "plugin");
        const plugins = join(checkout, "src", "userplugins"), destination = join(plugins, "fockytv");
        file(join(destination, "index.tsx"), "old plugin");
        file(join(plugins, "Other", "index.tsx"), "other plugin");
        file(join(checkout, "dist", "patcher.js"), "old build");
        file(join(plugin, "index.tsx"), "new plugin");
        file(join(plugin, "native.ts"), "native helper");
        file(join(plugin, "audio-helper.exe"), "audio helper");
        file(join(plugin, "installer", "install.mjs"), "must not be copied");
        const commands = [];
        const pnpm = args => {
            commands.push(args[0]);
            if (args[0] !== "build") return;
            assert.deepEqual(readdirSync(plugins).sort(), ["Other", "fockytv"]);
            file(join(checkout, "dist", "partial.js"), "partial build");
            if (failure === "build") throw new Error("build failed");
            if (failure === "none") for (const name of ["patcher.js", "vencordDesktopMain.js", "vencordDesktopRenderer.js", "vencordDesktopPreload.js", "vencordDesktopRenderer.css"]) file(join(checkout, "dist", name), "new build");
        };
        if (failure === "none") {
            assert.equal(buildPlugin(checkout, plugin, pnpm), join(checkout, "dist"));
            assert.equal(readFileSync(join(destination, "index.tsx"), "utf8"), "new plugin");
            assert.equal(existsSync(join(destination, "installer")), false);
            assert.equal(existsSync(join(destination, "audio-helper.exe")), true);
        } else {
            assert.throws(() => buildPlugin(checkout, plugin, pnpm), failure === "build" ? /build failed/ : /Build incompleta/);
            assert.equal(readFileSync(join(destination, "index.tsx"), "utf8"), "old plugin");
            assert.equal(readFileSync(join(checkout, "dist", "patcher.js"), "utf8"), "old build");
            assert.equal(existsSync(join(checkout, "dist", "partial.js")), false);
        }
        assert.equal(readFileSync(join(plugins, "Other", "index.tsx"), "utf8"), "other plugin");
        assert.deepEqual(commands, ["exec", "build"]);
    });
}

test("Linux bootstrap rejects a tampered Node archive before extraction", { skip: process.platform !== "linux" }, async t => {
    const { spawnSync } = await import("node:child_process");
    const root = fixture(t), bin = join(root, "bin"), temporary = join(root, "tmp");
    mkdirSync(temporary);
    const stub = (name, text) => { file(join(bin, name), '#!/bin/sh\n' + text); chmodSync(join(bin, name), 0o755); };
    stub("node", "exit 1\n");
    stub("curl", `args="$*"
while [ "$#" -gt 0 ]; do
    if [ "$1" = -o ]; then shift; output="$1"; fi
    shift
done
case "$args" in
    *SHASUMS256.txt*) printf '%064d  node-v24.0.0-linux-x64.tar.xz\\n' 0 > "$output" ;;
    *) printf 'tampered archive' > "$output" ;;
esac
`);
    stub("tar", 'touch "$FOCKYTV_TEST_EXTRACTED"\nexit 99\n');
    const result = spawnSync("bash", [join(import.meta.dirname, "install.sh")], {
        env: { ...process.env, PATH: bin + ":" + process.env.PATH, XDG_DATA_HOME: join(root, "data"), TMPDIR: temporary, FOCKYTV_TEST_EXTRACTED: join(root, "extracted") },
        encoding: "utf8"
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /FAILED|checksum/i);
    assert.equal(existsSync(join(root, "extracted")), false);
    assert.deepEqual(readdirSync(temporary), []);
});
