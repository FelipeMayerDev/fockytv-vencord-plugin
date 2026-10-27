// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transformSync } from "esbuild";
import { fetchGithubMergeQueue, GithubMergedPr, GithubQueueItem, mergedTodayQuery, markGithubQueueSeen, MERGED_VISIBLE_MS, GithubQueuePage, GithubQueueRequest, GithubQueueSnapshot, loadGithubQueue, githubCheckStatus, mergeQueueQuery, mergeQueueState, watchGithubQueue } from "./github-queue";
import { githubUrl } from "./github";

const item = (number = 1, state = "QUEUED", position = 1): GithubQueueItem => ({ number, title: `PR ${number}`, baseRefName: "main", author: { login: "dona" }, mergeQueueEntry: {
    state, position, enqueuedAt: "2026-10-22T12:00:00Z", estimatedTimeToMerge: 90,
    headCommit: { oid: "a".repeat(40), statusCheckRollup: { state: "PENDING", contexts: { totalCount: 2, nodes: [{ name: "Build", status: "IN_PROGRESS", conclusion: null }, { context: "Tests", state: "SUCCESS" }] } } }
} });
const page = (nodes: GithubQueueItem[], hasNextPage = false, endCursor: string | null = null, merged: GithubMergedPr[] = []): GithubQueuePage => ({ viewer: "dona", merged, nodes, pageInfo: { hasNextPage, endCursor } });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// A boundary fixture; no real token or network is used.
test("native Merge Queue query is fixed, authenticated and cannot redirect the token", async () => {
    const original = globalThis.fetch;
    const calls: { url: string; options?: RequestInit; }[] = [];
    let result: unknown = { data: { viewer: { login: "dona" }, merged: { nodes: [{}, { number: 9, title: "Feito", mergedAt: "2026-10-22T15:00:00Z" }] }, repository: { pullRequests: page([item()]) } } }, status = 200;
    globalThis.fetch = async (url, options) => { calls.push({ url: String(url), options }); return Response.json(result, { status }); };
    try {
        assert.deepEqual(await fetchGithubMergeQueue("secret", "dona/projeto", null), page([item()], false, null, [{ number: 9, title: "Feito", mergedAt: "2026-10-22T15:00:00Z" }]));
        assert.equal(calls[0].url, "https://api.github.com/graphql");
        assert.equal(calls[0].options?.method, "POST");
        assert.equal(calls[0].options?.redirect, "error");
        assert.equal((calls[0].options?.headers as Record<string, string>).Authorization, "Bearer secret");
        assert.deepEqual(JSON.parse(String(calls[0].options?.body)), { query: mergeQueueQuery, variables: { owner: "dona", name: "projeto", cursor: null, merged: mergedTodayQuery("dona", "projeto") } });
        assert.equal(mergedTodayQuery("dona", "projeto", new Date(2026, 9, 22, 16, 30)), `repo:dona/projeto is:pr is:merged author:@me merged:>=${new Date(2026, 9, 22).toISOString().slice(0, 19)}Z sort:updated-desc`);
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

test("Merge Queue includes only the viewer's real entries, paginates, deduplicates and orders positions per branch", async () => {
    const calls: (string | null)[] = [];
    const { items, history } = await loadGithubQueue(async (_repo, cursor) => {
        calls.push(cursor);
        return cursor ? page([item(3, "AWAITING_CHECKS", 2), item(2), { ...item(4), baseRefName: "release" }])
            : page([{ ...item(10), mergeQueueEntry: null }, { ...item(11), author: { login: "outra" } }, { ...item(12), author: null }, item(3, "QUEUED", 3)], true, "next",
                [{ number: 7, title: "Antes", mergedAt: "2026-10-22T10:00:00Z" }, { number: 8, title: "Depois", mergedAt: "2026-10-22T14:00:00Z" }]);
    }, "dona/projeto");
    assert.deepEqual(calls, [null, "next"]);
    assert.deepEqual(items.map(value => [value.number, value.mergeQueueEntry?.position]), [[2, 1], [3, 2], [4, 1]]);
    assert.deepEqual(history.map(pr => pr.number), [8, 7], "Today's merges come from the first page, newest first");
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

test("today's merges stay in history; the hover keeps them 15 minutes and until the panel is opened", async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-10-22T15:00:00Z") });
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { value: { hidden: false }, configurable: true });
    t.after(() => { if (original) Object.defineProperty(globalThis, "document", original); else delete (globalThis as any).document; });
    const merge = (number: number) => ({ number, title: `PR ${number}`, mergedAt: new Date(Date.now()).toISOString() });
    let next = page([item(1)]);
    const snapshots: GithubQueueSnapshot[] = [];
    const last = () => snapshots.at(-1)!;
    const stop = watchGithubQueue(async () => next, "dona/merged", snapshot => snapshots.push(snapshot));
    await flush();
    const first = merge(1);
    next = page([], false, null, [first]);
    t.mock.timers.tick(30_000); await flush();
    assert.deepEqual(last().merged.map(pr => pr.number), [1]);
    assert.equal(last().items.length, 0);
    t.mock.timers.tick(MERGED_VISIBLE_MS); await flush();
    assert.deepEqual(last().merged.map(pr => pr.number), [1], "Unseen merges stay after 15 minutes");
    markGithubQueueSeen();
    assert.deepEqual(last().merged, [], "Seen after 15 minutes: leaves the hover");
    assert.deepEqual(last().history.map(pr => pr.number), [1], "...but stays in today's history");
    t.mock.timers.tick(60_000); await flush();
    next = page([], false, null, [first, merge(3)]);
    t.mock.timers.tick(30_000); await flush();
    markGithubQueueSeen();
    assert.deepEqual(last().merged.map(pr => pr.number), [3], "Seen early: stays for the full 15 minutes");
    t.mock.timers.tick(MERGED_VISIBLE_MS); await flush();
    assert.deepEqual(last().merged, []);
    assert.deepEqual(last().history.map(pr => pr.number), [3, 1]);
    stop();
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
const React = { createElement: (type: any, props: any, ...children: unknown[]): any => typeof type === "function" ? type({ ...props, children }) : ({ type, props: props ?? {}, children }) };
const nodes = (tree: any): any[] => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === "object" ? [tree, ...nodes(tree.children)] : [];

test("queue cards show visual check states, preserve progress names and open the right PR", () => {
    const opened: string[] = [];
    const render = new Function("React", "ErrorNotice", "mergeQueueState", "githubCheckStatus", "githubUrl", "relativeTime", "external", `${javascript(source.slice(source.indexOf("function ActionIcon("), source.indexOf("function PullActions(")))}; return MergeQueueDetails;`)(React, "ErrorNotice", mergeQueueState, githubCheckStatus, githubUrl, () => "há 2 min", (url: string) => opened.push(url));
    const first = item();
    first.mergeQueueEntry!.headCommit!.statusCheckRollup!.contexts.nodes[0] = { name: "Tests (3/16)", status: "IN_PROGRESS", conclusion: null };
    const tree = render({ queue: { items: [first, item(2)], history: [{ number: 5, title: "Já foi", mergedAt: "2026-10-22T15:00:00Z" }], merged: [], updated: 1000, error: "" }, repository: "dona/projeto" });
    const all = nodes(tree);
    assert.equal(all.filter(node => node.props.className === "fockytv-gh-queue-card").length, 2);
    assert.ok(all.some(node => node.props["aria-label"] === "Tests (3/16): Em execução"));
    assert.ok(all.some(node => node.props.className === "fockytv-gh-ci-spinner"));
    assert.ok(all.some(node => node.props["data-state"] === "success" && node.props["aria-label"] === "Tests: Passou"));
    assert.ok(all.some(node => node.type === "progress" && node.props.value === 1 && node.props.max === 2));
    const text = JSON.stringify(tree);
    for (const expected of ["Merge Queue", "Fila #", "Na fila", "Tests (3/16)", "~", "checks passaram"])
        assert.ok(text.includes(expected), expected);
    assert.ok(!text.includes("IN_PROGRESS") && !text.includes("SUCCESS"), "Raw API statuses stay out of the card");
    all.find(node => node.type === "button").props.onClick();
    assert.deepEqual(opened, ["https://github.com/dona/projeto/pull/1"]);
    const merged = all.find(node => node.type === "button" && node.props["data-state"] === "merged");
    assert.ok(merged && text.includes("Mesclados hoje") && text.includes("Já foi"), "Today's merges are listed in purple");
    merged.props.onClick();
    assert.equal(opened.at(-1), "https://github.com/dona/projeto/pull/5");
});

test("check states distinguish running, success, failure, waiting and skipped without guessing success", () => {
    for (const [raw, state] of [["IN_PROGRESS", "running"], ["SUCCESS", "success"], ["ERROR", "failure"], ["TIMED_OUT", "failure"], ["QUEUED", "waiting"], ["PENDING", "waiting"], ["SKIPPED", "neutral"], ["CANCELLED", "neutral"], ["COMPLETED", "unknown"]])
        assert.equal(githubCheckStatus(raw), state);
});

test("deploy card joins the stats grid, hides itself when empty and opens the deployments page", async () => {
    const hookStates: { value: unknown; set(value: unknown): void; }[] = [];
    let hookIndex = 0;
    const useState = (initial: unknown) => {
        const entry = hookStates[hookIndex] ??= { value: initial, set(value: unknown) { entry.value = typeof value === "function" ? (value as (previous: unknown) => unknown)(entry.value) : value; } };
        hookIndex++;
        return [entry.value, entry.set.bind(entry)];
    };
    const opened: string[] = [];
    const deploy = (environment: string, state: string) => ({ environment, sha: "abcdef1234567890", createdAt: "2026-10-27T13:00:00Z", actor: "ana", state });
    const mount = (load: () => Promise<unknown>) => {
        hookStates.length = 0;
        const effects: (() => unknown)[] = [];
        const component = new Function("React", "useState", "useEffect", "message", "ErrorNotice", "ActionIcon", "githubUrl", "relativeTime", "external", "loadGithubDeployments",
            `${javascript(source.slice(source.indexOf("const deploymentLabels"), source.indexOf("function PullActions(")))}; return DeployStatus;`)(
            React, useState, (effect: () => void) => { effects.push(effect); }, (cause: unknown) => String(cause),
            "ErrorNotice", ({ state }: { state: string; }) => ({ type: "svg", props: { "data-state": state } }),
            (repo: string, section: string) => `https://github.com/${repo}${section}`, () => "há 2 min",
            (url: string) => { opened.push(url); }, load);
        return { render: () => { hookIndex = 0; return component({ request: async () => ({}), repository: "dona/projeto", version: 1 }); },
            run: async () => { effects.forEach(effect => effect()); await flush(); } };
    };
    const card = mount(async () => [deploy("Production", "running"), deploy("staging", "success")]);
    assert.match(JSON.stringify(card.render()), /Consultando deploys/, "First render consults while the data is not there yet");
    await card.run();
    const tree = card.render();
    const stat = nodes(tree).find(node => node.type === "button" && String(node.props.className ?? "").includes("fockytv-gh-stat"));
    assert.ok(stat, "The deploy card is a stat card like the other three");
    assert.deepEqual(nodes(tree).filter(node => node.props.className === "fockytv-gh-deploy-line").map(node => node.props["data-state"]), ["running", "success"]);
    assert.ok(JSON.stringify(tree).includes("abcdef1"), "Short SHA is visible");
    stat.props.onClick();
    assert.deepEqual(opened, ["https://github.com/dona/projeto/deployments"]);
    const empty = mount(async () => []);
    empty.render();
    await empty.run();
    assert.equal(empty.render(), null, "No prod/staging deployments: the card hides itself");
    const failing = mount(async () => { throw new Error("Sem permissão"); });
    failing.render();
    await failing.run();
    const errored = failing.render();
    assert.ok(JSON.stringify(errored).includes("Sem permissão"), "Errors are visible with a retry, not silent");
    nodes(errored).find(node => node.type === "button" && JSON.stringify(node).includes("Tentar novamente")).props.onClick();
    assert.equal(hookStates[2].value, 1, "Retrying bumps the attempt to refetch");
});
