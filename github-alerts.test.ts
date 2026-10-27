// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { fetchGithubAlerts, GithubAlert, GithubAlertsMergedPr, GithubAlertsOpenPr, GithubAlertsPage, mergedSinceQuery, pullAlertsQuery, watchGithubAlerts } from "./github-alerts";

const open = (number = 1, login = "dona", state = "SUCCESS"): GithubAlertsOpenPr => ({ number, title: `PR ${number}`, author: { login }, statusCheckRollup: { state } });
const merged = (number: number): GithubAlertsMergedPr => ({ number, title: `PR ${number}`, mergedAt: "2026-10-27T15:00:00Z" });
const page = (openPrs: GithubAlertsOpenPr[] = [], mergedPrs: GithubAlertsMergedPr[] = [], viewer = "dona"): GithubAlertsPage => ({ viewer, open: openPrs, merged: mergedPrs });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test("PR alerts query is fixed, authenticated and rejects bad input without fetching", async () => {
    const original = globalThis.fetch;
    const calls: { url: string; options?: RequestInit; }[] = [];
    let result: unknown = { data: { viewer: { login: "dona" }, repository: { pullRequests: { nodes: [open(2), null] } }, merged: { nodes: [{}, merged(9)] } } }, status = 200;
    globalThis.fetch = async (url, options) => { calls.push({ url: String(url), options }); return Response.json(result, { status }); };
    try {
        assert.deepEqual(await fetchGithubAlerts("secret", "dona/projeto", "2026-10-27T12:00:00Z"), { viewer: "dona", open: [open(2)], merged: [merged(9)] });
        assert.equal(calls[0].url, "https://api.github.com/graphql");
        assert.equal(calls[0].options?.method, "POST");
        assert.equal(calls[0].options?.redirect, "error");
        assert.equal((calls[0].options?.headers as Record<string, string>).Authorization, "Bearer secret");
        assert.deepEqual(JSON.parse(String(calls[0].options?.body)), { query: pullAlertsQuery, variables: { owner: "dona", name: "projeto", merged: mergedSinceQuery("dona", "projeto", "2026-10-27T12:00:00Z") } });
        assert.equal(mergedSinceQuery("dona", "projeto", "2026-10-27T12:00:00Z"), "repo:dona/projeto is:pr is:merged author:@me merged:>=2026-10-27T12:00:00Z sort:updated-desc");
        assert.ok(!/\bmutation\b/.test(pullAlertsQuery));
        for (const [token, repository, since] of [["", "dona/projeto", "2026-10-27T12:00:00Z"], ["bad\r\nsecret", "dona/projeto", "2026-10-27T12:00:00Z"],
            ["secret", "https://evil.example/a/b", "2026-10-27T12:00:00Z"], ["secret", "dona/projeto", "now"], ["secret", "dona/projeto", "2026-13-45T99:00:00Z"]])
            await assert.rejects(fetchGithubAlerts(token!, repository!, since!));
        assert.equal(calls.length, 1, "Invalid input never reaches the network");
        result = { errors: [{ message: "Do not expose this response" }] };
        await assert.rejects(fetchGithubAlerts("secret", "dona/projeto", "2026-10-27T12:00:00Z"), /indisponíveis/);
        result = { data: { repository: null, viewer: { login: "dona" } } };
        await assert.rejects(fetchGithubAlerts("secret", "dona/projeto", "2026-10-27T12:00:00Z"), /indisponíveis/);
        status = 401;
        await assert.rejects(fetchGithubAlerts("secret", "dona/projeto", "2026-10-27T12:00:00Z"), /inválido ou expirado/);
        status = 429;
        await assert.rejects(fetchGithubAlerts("secret", "dona/projeto", "2026-10-27T12:00:00Z"), /Limite/);
    } finally { globalThis.fetch = original; }
});

test("alerts fire once per merge and per CI failure transition, only for my PRs", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let next = page([open(1, "dona", "SUCCESS"), open(5, "outra", "SUCCESS")], [merged(1)]);
    const alerts: GithubAlert[] = [];
    const stop = watchGithubAlerts(async () => next, () => "dona/projeto", alert => alerts.push(alert));
    await flush();
    assert.deepEqual(alerts, [], "Baseline records state without alerting");
    next = page([open(1, "dona", "SUCCESS"), open(5, "outra", "SUCCESS")], [merged(1)]);
    t.mock.timers.tick(30_000); await flush();
    assert.deepEqual(alerts, [], "Repeated snapshots stay silent");
    next = page([open(1, "dona", "SUCCESS"), open(5, "outra", "FAILURE")], []);
    t.mock.timers.tick(30_000); await flush();
    assert.deepEqual(alerts, [], "Another author's failing PR does not alert");
    next = page([open(1, "dona", "FAILURE"), open(5, "outra", "FAILURE")], []);
    t.mock.timers.tick(30_000); await flush();
    assert.deepEqual(alerts.map(alert => [alert.title, alert.body, alert.url]),
        [["FockyTV: Actions falhou no PR", "#1 · PR 1", "https://github.com/dona/projeto/pull/1"]]);
    next = page([open(1, "dona", "FAILURE")], [merged(1), merged(3)]);
    t.mock.timers.tick(30_000); await flush();
    assert.deepEqual(alerts.map(alert => alert.title), ["FockyTV: Actions falhou no PR", "FockyTV: PR mergeado"]);
    assert.equal(alerts[1].body, "#3 · PR 3");
    t.mock.timers.tick(30_000); await flush();
    assert.equal(alerts.length, 2, "A retried window does not duplicate alerts");
    next = page([open(6, "dona", "FAILURE")], []);
    t.mock.timers.tick(30_000); await flush();
    assert.equal(alerts.length, 2, "A PR first seen already failing only baselines");
    next = page([open(6, "dona", "SUCCESS")], [merged(3)]);
    t.mock.timers.tick(30_000); await flush();
    assert.equal(alerts.length, 2, "Failure re-arms after success but a seen merge stays deduplicated");
    stop();
});

test("alerts follow the selected repository, skip unconfigured clients, run hidden and back off", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { value: { hidden: true }, configurable: true });
    t.after(() => { if (original) Object.defineProperty(globalThis, "document", original); else delete (globalThis as any).document; });
    let calls = 0, fail = false, repository = "dona/um";
    const alerts: GithubAlert[] = [];
    const stop = watchGithubAlerts(async () => {
        calls++;
        if (fail) throw new Error("Limite de requisições");
        return page([open(1, "dona", "FAILURE")], []);
    }, () => repository, alert => alerts.push(alert));
    await flush();
    assert.equal(calls, 1);
    assert.deepEqual(alerts, [], "First snapshot of a repository is the baseline");
    t.mock.timers.tick(30_000); await flush();
    assert.equal(calls, 2, "A hidden tab keeps polling: background alerts are the point");
    repository = "dona/dois";
    t.mock.timers.tick(30_000); await flush();
    assert.equal(calls, 3);
    assert.deepEqual(alerts, [], "Changing repositories re-baselines without alerting");
    repository = "bogus";
    t.mock.timers.tick(30_000); await flush();
    assert.equal(calls, 3, "A repository that fails validation is treated as unconfigured");
    repository = "";
    t.mock.timers.tick(30_000); await flush();
    assert.equal(calls, 3, "No repository selected: no request");
    repository = "dona/um";
    fail = true;
    t.mock.timers.tick(30_000); await flush();
    assert.equal(calls, 4);
    t.mock.timers.tick(30_000); await flush();
    assert.equal(calls, 4, "Failures back off");
    fail = false;
    t.mock.timers.tick(30_000); await flush();
    assert.equal(calls, 5);
    assert.deepEqual(alerts, [], "Recovered windows re-baseline instead of alerting in burst");
    stop();
    t.mock.timers.tick(300_000); await flush();
    assert.equal(calls, 5);
});

test("stopping an in-flight alert poll discards the late snapshot", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0, release: ((value: GithubAlertsPage) => void) | undefined;
    const alerts: GithubAlert[] = [];
    const stop = watchGithubAlerts(async () => {
        calls++;
        return new Promise<GithubAlertsPage>(resolve => { release = resolve; });
    }, () => "dona/projeto", alert => alerts.push(alert));
    stop();
    release!(page([open(1, "dona", "FAILURE")], [merged(1)]));
    await flush();
    t.mock.timers.tick(300_000); await flush();
    assert.deepEqual(alerts, [], "Only the discarded snapshot arrived");
    assert.equal(calls, 1, "No rescheduled poll after stopping");
});
