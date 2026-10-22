// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transformSync } from "esbuild";
import { repositoryName } from "./github";

const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
const javascript = (code: string) => transformSync(code, { loader: "tsx", jsxFactory: "React.createElement" }).code;
const React = { createElement: (type: unknown, props: unknown) => ({ type, props }) };

test("GitHub starts blank and its button reacts to adding and removing a token", () => {
    const definitions = new Function("definePluginSettings", "OptionType", "repositoryName", `
        ${javascript(source.slice(source.indexOf("const settings ="), source.indexOf("// Token como senha")))}
        return settings;
    `)((value: unknown) => value, {}, repositoryName);
    assert.equal(definitions.githubToken.default, "");
    assert.equal(definitions.githubRepository.default, "");
    assert.equal(definitions.githubRepository.isValid(""), true);
    assert.equal(definitions.githubRepository.isValid("dona/projeto"), true);
    assert.equal(definitions.githubRepository.isValid("invalid"), false);

    const store = { githubToken: "", githubRepository: "dona/projeto" };
    const button = new Function("React", "settings", "PanelButton", "GithubIcon", "openGithub", `
        ${javascript(source.slice(source.indexOf("function GithubButton("), source.indexOf("const jiraRequest:")))}
        return GithubButton;
    `)(React, { use: () => store }, "PanelButton", "GithubIcon", () => {});
    for (const token of ["", "   ", "configured", ""]) {
        store.githubToken = token;
        assert.equal(button({}) !== null, !!token.trim());
        assert.equal(store.githubRepository, "dona/projeto", "Saved choices survive token changes");
    }
});

test("GitHub panel waits for a project and preserves saved repository selections", () => {
    const panelSource = readFileSync(new URL("./github-panel.tsx", import.meta.url), "utf8");
    // Run the real hooks before rendering JSX; no Discord runtime is needed.
    const code = panelSource.slice(panelSource.indexOf("export function GithubPanel("), panelSource.indexOf("    const chooseRepository ="))
        .replace("export function", "function") + "\nreturn repository; } return GithubPanel;";
    for (const repository of ["", "dona/projeto"]) {
        const effects: (() => unknown)[] = [], loaded: string[] = [];
        const panel = new Function("useState", "useEffect", "useRef", "loadGithub", javascript(code))(
            (value: unknown) => [value, () => {}], (effect: () => unknown) => effects.push(effect), () => ({ current: {} }),
            (_request: unknown, name: string) => { loaded.push(name); return Promise.resolve({ errors: [] }); }
        );
        assert.equal(panel({ context: { repository, authenticated: false } }), repository);
        effects[3](); // Project data effect, after scroll, account and repository list effects.
        assert.deepEqual(loaded, repository ? [repository] : []);
    }
});
