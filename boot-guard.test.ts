// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";

import { bootGuardVerdict, disablePluginSettings } from "./boot-guard";

test("the boot guard needs two consecutive unclean boots before disabling", () => {
    assert.deepEqual(bootGuardVerdict(null), { strikes: 0, disable: false }, "A fresh boot starts being watched without strikes");
    assert.deepEqual(bootGuardVerdict({ strikes: 0 }), { strikes: 1, disable: false }, "One crash — or a single forced kill or power loss — disables nothing yet");
    assert.deepEqual(bootGuardVerdict({ strikes: 1 }), { strikes: 2, disable: true }, "The second consecutive unclean boot disables the plugin");
    assert.deepEqual(bootGuardVerdict({}), { strikes: 1, disable: false }, "A corrupted guard file counts as the first strike");
});

test("disabling preserves other settings and marks the reason", () => {
    const data: unknown = { autoUpdate: true, plugins: { FockyTV: { enabled: true, liveTitle: "oi" }, Other: { enabled: true } } };
    const out = disablePluginSettings(data);
    assert.equal(out, data, "Mutates the parsed settings in place, keeping every other key");
    const plugin = (out as any).plugins.FockyTV;
    assert.equal(plugin.enabled, false);
    assert.equal(plugin.crashDisabled, true);
    assert.equal(plugin.liveTitle, "oi");
    assert.deepEqual((out as any).plugins.Other, { enabled: true }, "Other plugins are untouched");
    assert.equal((disablePluginSettings(null) as any).plugins.FockyTV.enabled, false, "A missing or corrupt file becomes a fresh settings object");
});
