// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";

import { applyOverlayRules, isHyprland, OVERLAY_TITLE, placeOverlay } from "./hyprland";

type Call = string[];
const recorder = (clients: unknown, ...failOns: string[]) => {
    const calls: Call[] = [];
    const exec = async (_file: string, args: string[]) => {
        if (failOns.some(fail => args.join(" ").includes(fail))) throw new Error("unsupported");
        calls.push(args);
        return { stdout: JSON.stringify(clients) };
    };
    return { calls, exec };
};

test("isHyprland follows the compositor environment", () => {
    assert.equal(isHyprland({ HYPRLAND_INSTANCE_SIGNATURE: "x" } as NodeJS.ProcessEnv), true);
    assert.equal(isHyprland({} as NodeJS.ProcessEnv), false);
});

test("rules apply as a named Lua rule, falling back to windowrulev2 on old Hyprland", async () => {
    let { calls, exec } = recorder([]);
    await applyOverlayRules(exec);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "eval");
    assert.match(calls[0][1], /hl\.window_rule\(\{ name = 'fockytv-ink'/);
    for (const effect of ["float = true", "pin = true", "no_focus = true", "no_screen_share = true"])
        assert.ok(calls[0][1].includes(effect), `rule carries ${effect}`);
    assert.match(calls[0][1], new RegExp(`match = \\{ title = "${OVERLAY_TITLE}" \\}`));

    ({ calls, exec } = recorder([], "eval"));
    await applyOverlayRules(exec);
    assert.equal(calls.length, 4, "Old Hyprland receives the legacy keyword rules");
    assert.deepEqual(calls.map(args => args[2]), [
        `float, title:"${OVERLAY_TITLE}"`,
        `pin, title:"${OVERLAY_TITLE}"`,
        `nofocus, title:"${OVERLAY_TITLE}"`,
        `noscreenshare, title:"${OVERLAY_TITLE}"`
    ]);

    ({ calls, exec } = recorder([], "eval", "noscreenshare"));
    await applyOverlayRules(exec);
    assert.equal(calls.length, 4);
    assert.equal(calls.at(-1)![2], `no_screencopy, title:"${OVERLAY_TITLE}"`, "Pre-rename Hyprland receives no_screencopy");
});

test("placement aligns the overlay to the shared display via the Lua dispatchers", async () => {
    const { calls, exec } = recorder([{ address: "0xabc", title: OVERLAY_TITLE, floating: false }]);
    const placed = await placeOverlay({ x: 1920, y: 0, width: 2560, height: 1440 }, exec);
    assert.equal(placed, true);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], ["-j", "clients"]);
    assert.equal(calls[1][0], "eval");
    assert.match(calls[1][1], /hl\.dsp\.window\.resize\(\{ x = 2560, y = 1440, window = 'address:0xabc' \}\)/);
    assert.equal(calls[2][0], "eval");
    assert.match(calls[2][1], /hl\.dsp\.window\.move\(\{ x = 1920, y = 0, window = 'address:0xabc' \}\)/);

    const missing = recorder([{ address: "0xabc", title: "outro" }]);
    assert.equal(await placeOverlay({ x: 0, y: 0, width: 100, height: 100 }, missing.exec), false);
    assert.equal(missing.calls.length, 1, "A missing overlay window skips the geometry dispatches");

    const legacy = recorder([{ address: "0xabc", title: OVERLAY_TITLE, floating: false }], "eval");
    assert.equal(await placeOverlay({ x: 10, y: 20, width: 300, height: 400 }, legacy.exec), true);
    assert.deepEqual(legacy.calls.slice(1), [
        ["dispatch", "resizewindowpixel", "exact 300 400,address:0xabc"],
        ["dispatch", "movewindowpixel", "exact 10 20,address:0xabc"]
    ], "Old Hyprland receives the classic dispatchers");
});
