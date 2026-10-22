import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readSharePicker, writeSharePicker } from "./linux-picker.ts";

for (const newline of ["\n", "\r\n"]) test(`picker changes preserve config and first backup (${JSON.stringify(newline)})`, async t => {
    const directory = await mkdtemp(join(tmpdir(), "fockytv-picker-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "xdph.conf");
    const config = ["# personal settings", "screencopy {", "    allow_token_by_default = true", "    custom_picker_binary = hyprland-preview-share-picker # keep this", "}", ""].join(newline);
    await writeFile(path, config);
    assert.equal(await readSharePicker(path), "hyprland-preview-share-picker");
    assert.equal(await writeSharePicker(path, "hyprland-share-picker"), true);
    assert.equal(await readSharePicker(path), "hyprland-share-picker");
    assert.equal(await readFile(path, "utf8"), config.replace("hyprland-preview-share-picker", "hyprland-share-picker"));
    assert.equal(await writeSharePicker(path, "hyprland-share-picker"), false);
    await writeSharePicker(path, "hyprland-preview-share-picker");
    assert.equal(await readFile(`${path}.fockytv.bak`, "utf8"), config);
    await assert.rejects(writeSharePicker(path, "bad;command"), /inválido/);
    assert.equal(await readFile(path, "utf8"), config);
});

test("unsupported and ambiguous configs are left untouched", async t => {
    const directory = await mkdtemp(join(tmpdir(), "fockytv-picker-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "xdph.conf");
    for (const config of ["", "screencopy {}", "screencopy {}\nscreencopy {}", "screencopy {\ncustom_picker_binary = a\ncustom_picker_binary = b\n}"]) {
        await writeFile(path, config);
        await assert.rejects(writeSharePicker(path, "hyprland-share-picker"), /ausente ou ambígu/);
        assert.equal(await readFile(path, "utf8"), config);
        await assert.rejects(readFile(`${path}.fockytv.bak`), { code: "ENOENT" });
    }
});

test("native controls validate choices and only restart after a change", async () => {
    const source = await readFile(new URL("./native.ts", import.meta.url), "utf8");
    const section = source.slice(source.indexOf("const pickerConfig ="), source.indexOf("// Sessões WHIP"));
    const create = new Function("process", "join", "homedir", "readSharePicker", "writeSharePicker", "sharePickers", "access", "constants", "promisify", "execFile",
        stripTypeScriptTypes(section).replaceAll("export ", "") + ";return {getLinuxSharePicker,setLinuxSharePicker};");
    const process = { platform: "linux", env: { HYPRLAND_INSTANCE_SIGNATURE: "test", XDG_CONFIG_HOME: "/config" } };
    let current = "hyprland-preview-share-picker", restarts = 0, failRestart = false;
    const api = create(process, join, () => "/home/test", async path => {
        assert.equal(path, "/config/hypr/xdph.conf"); return current;
    }, async (_path, picker) => { const changed = current !== picker; current = picker; return changed; },
    ["hyprland-share-picker", "hyprland-preview-share-picker"], async path => assert.match(path, /^\/usr\/bin\/hyprland-/), { X_OK: 1 },
    () => async (file, args) => {
        assert.equal(file, "systemctl");
        assert.deepEqual(args, ["--user", "restart", "xdg-desktop-portal-hyprland.service"]);
        restarts++;
        if (failRestart) throw Error("restart failed");
    }, () => {});
    assert.equal((await api.getLinuxSharePicker({})).picker, current);
    await assert.rejects(api.setLinuxSharePicker({}, "bad;command"), /inválido/);
    await api.setLinuxSharePicker({}, "hyprland-share-picker");
    await api.setLinuxSharePicker({}, "hyprland-share-picker");
    assert.equal(restarts, 1);
    failRestart = true;
    await assert.rejects(api.setLinuxSharePicker({}, "hyprland-preview-share-picker"), /Seletor salvo/);
    assert.equal(current, "hyprland-preview-share-picker");
    process.platform = "win32";
    assert.equal(await api.getLinuxSharePicker({}), null);
    await assert.rejects(api.setLinuxSharePicker({}, "hyprland-share-picker"), /apenas no Hyprland/);
    assert.equal(restarts, 2);
});
