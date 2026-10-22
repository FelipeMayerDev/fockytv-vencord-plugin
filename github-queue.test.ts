// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transformSync } from "esbuild";
import { fetchGithubMergeQueue, GithubQueueItem, GithubQueuePage, GithubQueueRequest, GithubQueueSnapshot, loadGithubQueue, mergeQueueQuery, mergeQueueState, watchGithubQueue } from "./github-queue";
import { githubUrl } from "./github";

const item = (number = 1, state = "QUEUED", position = 1): GithubQueueItem => ({ number, title: `PR ${number}`, baseRefName: "main", mergeQueueEntry: {
    state, position, enqueuedAt: "2026-10-22T12:00:00Z", estimatedTimeToMerge: 90,
    headCommit: { oid: "a".repeat(40), statusCheckRollup: { state: "PENDING", contexts: { totalCount: 2, nodes: [{ name: "Build", status: "IN_PROGRESS", conclusion: null }, { context: "Tests", state: "SUCCESS" }] } } }
} });
const page = (nodes: GithubQueueItem[], hasNextPage = false, endCursor: string | null = null): GithubQueuePage => ({ nodes, pageInfo: { hasNextPage, endCursor } });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// A boundary fixture; no real token or network is used.
test("native Merge Queue query is fixed, authenticated and cannot redirect the token", async () => {
    const original = globalThis.fetch;
    const calls: { url: string; options?: RequestInit; }[] = [];
    let result: unknown = { data: { repository: { pullRequests: page([item()]) } } }, status = 200;
    globalThis.fetch = async (url, options) => { calls.push({ url: String(url), options }); return Response.json(result, { status }); };
    try {
        assert.deepEqual(await fetchGithubMergeQueue("secret", "dona/projeto", null), page([item()]));
        assert.equal(calls[0].url, "https://api.github.com/graphql");
        assert.equal(calls[0].options?.method, "POST");
        assert.equal(calls[0].options?.redirect, "error");
        assert.equal((calls[0].options?.headers as Record<string, string>).Authorization, "Bearer secret");
        assert.deepEqual(JSON.parse(String(calls[0].options?.body)), { query: mergeQueueQuery, variables: { owner: "dona", name: "projeto", cursor: null } });
        assert.ok(!/\bmutation\b/.test(mergeQueueQuery));
        for (const [token, repository, cursor] of [["", "dona/projeto", null], ["bad\r\nsecret", "dona/projeto", null], ["secret", "https://evil.example/a/b", null], ["secret", "dona/projeto", "x".repeat(1025)]])
            await assert.rejects(fetchGithubMergeQueue(token!, repository!, cursor));
        assert.equal(calls.length, 1);
        result = { errors: [{ message: "Do not expose this response" }], data: { repository: { pullRequests: page([]) } } };
        await assert.rejects(fetchGithubMergeQueue("secret", "dona/projeto", null), /permissões de leitura/);
        result = { data: { repository: null } };
        await assert.rejects(fetchGithubMergeQueue("secret", "dona/projeto", null), /indisponível/);
        status = 401;
        await assert.rejects(fetchGithubMergeQueue("secret", "dona/projeto", null), /inválido ou expirado/);
        status = 429;
        await assert.rejects(fetchGithubMergeQueue("secret", "dona/projeto", null), /Limite/);
    } finally { globalThis.fetch = original; }
});

test("Merge Queue includes only real entries, paginates, deduplicates and orders positions per branch", async () => {
    const calls: (string | null)[] = [];
    const items = await loadGithubQueue(async (_repo, cursor) => {
        calls.push(cursor);
        return cursor ? page([item(3, "AWAITING_CHECKS", 2), item(2), { ...item(4), baseRefName: "release" }])
            : page([{ ...item(10), mergeQueueEntry: null }, item(3, "QUEUED", 3)], true, "next");
    }, "dona/projeto");
    assert.deepEqual(calls, [null, "next"]);
    assert.deepEqual(items.map(value => [value.number, value.mergeQueueEntry?.position]), [[2, 1], [3, 2], [4, 1]]);
    for (const [state, label] of [["QUEUED", "Na fila"], ["AWAITING_CHECKS", "Aguardando checks"], ["MERGEABLE", "Pronto para merge"], ["UNMERGEABLE", "Bloqueado para merge"], ["LOCKED", "Fila bloqueada"]])
        assert.equal(mergeQueueState(item(1, state)), label);
    await assert.rejects(loadGithubQueue(async () => page([], true, null), "dona/projeto"), /Paginação/);
});

test("icon and modal share polling, follow queue changes, pause when hidden, back off and clean up", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    const visibility = { hidden: false };
    Object.defineProperty(globalThis, "document", { value: visibility, configurable: true });
    t.after(() => { if (original) Object.defineProperty(globalThis, "document", original); else delete (globalThis as any).document; });
    let calls = 0, fail = false, release: ((value: GithubQueuePage) => void) | undefined;
    const request: GithubQueueRequest = async () => {
        calls++;
        if (fail) throw Error("Limite de requisições");
        if (calls === 4) return new Promise(resolve => { release = resolve; });
        return page(calls === 1 ? [item()] : [item(1, "AWAITING_CHECKS")]);
    };
    const icon: GithubQueueSnapshot[] = [], modal: GithubQueueSnapshot[] = [];
    const stopIcon = watchGithubQueue(request, "dona/projeto", snapshot => icon.push(snapshot));
    await flush();
    const stopModal = watchGithubQueue(request, "dona/projeto", snapshot => modal.push(snapshot));
    assert.equal(calls, 1, "Opening the modal reuses the icon's request and snapshot");
    assert.equal(modal.at(-1), icon.at(-1));
    t.mock.timers.tick(30_000); await flush();
    assert.equal(icon.at(-1)?.items[0].mergeQueueEntry?.state, "AWAITING_CHECKS");
    assert.equal(icon.at(-1), modal.at(-1));
    visibility.hidden = true;
    t.mock.timers.tick(30_000); await flush(); assert.equal(calls, 2);
    visibility.hidden = false; fail = true;
    t.mock.timers.tick(30_000); await flush();
    assert.equal(calls, 3);
    assert.match(icon.at(-1)!.error, /Limite/);
    assert.equal(icon.at(-1)?.items.length, 1, "Failed refresh retains the last known queue and marks it stale");
    fail = false;
    t.mock.timers.tick(30_000); await flush(); assert.equal(calls, 3, "Failures back off");
    t.mock.timers.tick(30_000); await flush(); assert.equal(calls, 4);
    t.mock.timers.tick(300_000); await flush(); assert.equal(calls, 4, "No overlapping requests");
    release!(page([])); await flush();
    assert.equal(icon.at(-1)?.items.length, 0, "Merged/removed PRs leave the badge");
    assert.equal(icon.at(-1)?.error, "");
    stopIcon();
    t.mock.timers.tick(30_000); await flush(); assert.equal(calls, 5, "Modal keeps the shared watch alive");
    stopModal();
    t.mock.timers.tick(300_000); await flush(); assert.equal(calls, 5);
});

test("stopping an in-flight queue watch prevents late updates and timers", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { value: { hidden: false }, configurable: true });
    t.after(() => { if (original) Object.defineProperty(globalThis, "document", original); else delete (globalThis as any).document; });
    let release: ((value: GithubQueuePage) => void) | undefined, calls = 0;
    const snapshots: GithubQueueSnapshot[] = [];
    const stop = watchGithubQueue(async () => { calls++; return new Promise(resolve => { release = resolve; }); }, "dona/projeto", snapshot => snapshots.push(snapshot));
    stop(); release!(page([item()])); await flush();
    t.mock.timers.tick(300_000); await flush();
    assert.equal(snapshots.length, 1, "Only the initial empty snapshot was published");
    assert.equal(calls, 1);
});

const source = readFileSync(new URL("./github-panel.tsx", import.meta.url), "utf8");
const javascript = (code: string) => transformSync(code, { loader: "tsx", jsxFactory: "React.createElement" }).code;
const React = { createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props: props ?? {}, children }) };
const nodes = (tree: any): any[] => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === "object" ? [tree, ...nodes(tree.children)] : [];

test("modal shows queue position, group checks, estimate and canonical PR link", () => {
    const opened: string[] = [];
    const render = new Function("React", "ErrorNotice", "mergeQueueState", "githubUrl", "external", `${javascript(source.slice(source.indexOf("function MergeQueueDetails("), source.indexOf("function PullActions(")))}; return MergeQueueDetails;`)(React, "ErrorNotice", mergeQueueState, githubUrl, (url: string) => opened.push(url));
    const tree = render({ queue: { items: [item()], updated: 1000, error: "" }, repository: "dona/projeto" });
    const text = JSON.stringify(tree);
    for (const expected of ["Merge Queue", "Posição ", "Na fila", "Build: IN_PROGRESS", "Tests: SUCCESS", "Estimativa: 2 min"])
        assert.ok(text.includes(expected), expected);
    nodes(tree).find(node => node.type === "button").props.onClick();
    assert.deepEqual(opened, ["https://github.com/dona/projeto/pull/1"]);
});
