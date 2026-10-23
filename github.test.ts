// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { fetchGithub, GithubFetch, GithubItem, GithubReview, GithubRun, githubApiUrl, githubError, githubUrl, itemState, latestReviews, loadGithub, loadGithubDetail, loadPullActions, matchesGithub, repositoryName } from "./github";

const item = (number = 1, extra: Partial<GithubItem> = {}): GithubItem => ({ id: number, number, title: "Corrigir login", state: "open", body: "Descrição", updated_at: "2026-10-21T12:00:00Z", user: { login: "ana" }, labels: [{ name: "bug", color: "ff0000" }], assignees: [{ login: "bia" }], ...extra });

test("Repository names accept GitHub links, reject other origins and traversal", () => {
    for (const name of [" dona/projeto ", "https://github.com/dona/projeto/", "https://github.com/dona/projeto.git"])
        assert.equal(repositoryName(name), "dona/projeto");
    for (const name of ["", "dona", "https://evil.com/a/b", "https://github.com.evil.com/a/b", "dona/..", "dona/.", "dona/a/b", "dona/projeto?x=1", "https://user:pass@github.com/a/b"])
        assert.throws(() => repositoryName(name), name);
    assert.equal(githubUrl("dona/projeto", "/pull/42"), "https://github.com/dona/projeto/pull/42");
});

test("Native API boundary only accepts the panel's read routes on api.github.com", async () => {
    for (const path of ["/user", "/user/repos?sort=updated&per_page=100&page=1", "/repos/dona/projeto", "/repos/dona/projeto..v2", "/repos/dona/projeto/pulls?state=all&sort=updated", "/repos/dona/projeto/pulls/1/reviews?per_page=100&page=2", "/repos/dona/projeto/issues/1/comments", "/repos/dona/projeto/actions/runs?per_page=30", "/repos/dona/projeto/actions/runs/123/jobs?filter=latest&per_page=100&page=2"])
        assert.equal(githubApiUrl(path), `https://api.github.com${path}`);
    for (const path of ["https://evil.com", "//evil.com/user", "/user#x", "/repos/a/../issues", "/repos/a/b/../../user", "/repos/a/b/issues/1/comments\r\nX: a", "/repos/a/b/hooks", "/repos/a/b/actions/runs/1/rerun", "/repos/a/b/actions/runs/1/jobs/2", "/repos/a/b?redirect=https://evil.com", "/repos/a/%2e%2e/issues"])
        assert.throws(() => githubApiUrl(path), path);
    const original = globalThis.fetch;
    const calls: { url: string; options?: RequestInit; }[] = [];
    globalThis.fetch = async (input, options) => { calls.push({ url: String(input), options }); return new Response("{}", { headers: { "x-ratelimit-remaining": "42" } }); };
    try {
        const response = await fetchGithub("secret", "/user");
        assert.equal(response.remaining, "42");
        assert.equal(calls[0].url, "https://api.github.com/user");
        assert.equal(calls[0].options?.redirect, "error");
        assert.equal(calls[0].options?.method, undefined, "GET only; no write method accepted");
        assert.equal((calls[0].options?.headers as Record<string, string>).Authorization, "Bearer secret");
        await fetchGithub("", "/repos/dona/projeto");
        assert.equal((calls[1].options?.headers as Record<string, string>).Authorization, undefined);
        await assert.rejects(fetchGithub("secret", "//evil.com/user"));
        await assert.rejects(fetchGithub("secret\r\nX: bad", "/user"));
        assert.equal(calls.length, 2, "Invalid calls never reach fetch");
    } finally { globalThis.fetch = original; }
});

test("Filters, draft/merged status and latest review decisions", () => {
    assert.ok(matchesGithub(item(), "#1"));
    assert.ok(matchesGithub(item(), "LOGIN"));
    assert.ok(matchesGithub(item(), "bug"));
    assert.ok(matchesGithub(item(), "", "ana"));
    assert.ok(matchesGithub(item(), "", "bia"));
    assert.ok(!matchesGithub(item(), "", "carla"));
    assert.ok(!matchesGithub(item(), "", "ana", true));
    assert.ok(matchesGithub(item(1, { requested_reviewers: [{ login: "ana" }] }), "", "ana", true));
    assert.equal(itemState(item(1, { draft: true })), "Rascunho");
    assert.equal(itemState(item(1, { state: "closed", draft: true })), "Fechado");
    assert.equal(itemState(item(1, { state: "closed", merged_at: "today" })), "Mesclado");
    const review = (id: number, login: string, state: string) => ({ id, user: { login }, state, submitted_at: `2026-10-${id.toString().padStart(2, "0")}T12:00:00Z` }) as GithubReview;
    assert.deepEqual(latestReviews([{ ...review(9, "ana", "PENDING"), submitted_at: null }, review(4, "ana", "COMMENTED"), review(1, "ana", "CHANGES_REQUESTED"), review(2, "bia", "APPROVED"), review(3, "ana", "APPROVED"), review(5, "bia", "DISMISSED")]).map(r => [r.user?.login, r.state]), [["ana", "APPROVED"]]);
});

test("Pagination excludes PRs from issues, removes duplicates and isolates Actions failures", async () => {
    const requests: string[] = [];
    const request: GithubFetch = async <T>(path: string) => {
        requests.push(path);
        if (path.includes("/actions/")) throw new Error("Sem Actions");
        if (path.includes("/issues?")) return [item(10), item(20, { pull_request: {} })] as T;
        return (path.includes("page=2") ? [item(100), item(101)] : Array.from({ length: 100 }, (_, i) => item(i + 1))) as T;
    };
    const data = await loadGithub(request, "dona/projeto", "all", { pulls: 2, issues: 1, actions: 1 });
    assert.equal(data.pulls?.items.length, 101);
    assert.equal(data.pulls?.more, false);
    assert.deepEqual(data.issues?.items.map(i => i.number), [10]);
    assert.equal(data.actions, null);
    assert.deepEqual(data.errors, ["", "", "Sem Actions"]);
    assert.equal(requests.length, 4);
    assert.ok(requests.some(path => path.includes("state=all") && path.endsWith("page=2")));
    const first = await loadGithub(request, "dona/projeto", "open", { pulls: 1, issues: 1, actions: 1 });
    assert.equal(first.pulls?.more, true);
});

test("Detail loads latest comment page and paginates reviews before choosing decisions", async () => {
    const paths: string[] = [];
    const request: GithubFetch = async <T>(path: string) => {
        paths.push(path);
        if (path.endsWith("/pulls/1")) return item(1, { comments: 201 }) as T;
        if (path.includes("/comments?")) return [{ id: 1, body: "Last comment" }] as T;
        if (path.endsWith("page=1")) return Array.from({ length: 100 }, (_, id) => ({ id, user: { login: "ana" }, state: "APPROVED", submitted_at: "2026-10-20" })) as T;
        return [{ id: 101, user: { login: "ana" }, state: "CHANGES_REQUESTED", submitted_at: "2026-10-21" }] as T;
    };
    const result = await loadGithubDetail(request, "dona/projeto", "pulls", 1);
    assert.equal(result.reviews[0].state, "CHANGES_REQUESTED");
    assert.equal(result.comments.length, 1);
    assert.ok(paths.some(path => path.includes("comments?per_page=100&page=3")));
    assert.equal(result.error, "");
    const partial = await loadGithubDetail(async <T>(path: string) => { if (path.includes("/comments?")) throw new Error("Comentários indisponíveis"); return item() as T; }, "dona/projeto", "issues", 1);
    assert.equal(partial.detail.number, 1);
    assert.equal(partial.error, "Comentários indisponíveis");
});

test("Auth, missing access and rate limits have actionable errors without echoing server content", () => {
    assert.match(githubError({ status: 401, body: "secret" }), /inválido ou expirado/);
    assert.match(githubError({ status: 404, body: "" }), /privado/);
    assert.match(githubError({ status: 403, body: "" }), /SSO/);
    assert.match(githubError({ status: 403, body: "", remaining: "0" }), /Limite/);
    assert.match(githubError({ status: 403, body: "", retryAfter: "30" }), /Limite/);
    assert.match(githubError({ status: 429, body: "" }), /Limite/);
    assert.equal(githubError({ status: 502, body: "secret" }), "GitHub respondeu HTTP 502. Tente novamente.");
});

const pull = () => item(7, { head: { ref: "feature/github", sha: "abc123", repo: { full_name: "dona/projeto" } } });
const run = (extra: Partial<GithubRun> = {}): GithubRun => ({ id: 10, workflow_id: 1, name: "CI", display_title: "Build", status: "in_progress", conclusion: null, head_sha: "abc123", head_branch: "feature/github", head_repository: { full_name: "dona/projeto" }, pull_requests: [{ number: 7 }], updated_at: "2026-10-21", run_number: 1, event: "pull_request", ...extra });

test("PR Actions matches the current commit and reports the active job and step", async () => {
    const paths: string[] = [];
    const status = await loadPullActions(async <T>(path: string) => {
        paths.push(path);
        return (path.includes("/jobs?") ? { jobs: [{ name: "Linux / Node 22", status: "in_progress", conclusion: null, steps: [
            { name: "Checkout", number: 1, status: "completed", conclusion: "success" },
            { name: "Testes unitários", number: 16, status: "in_progress", conclusion: null }
        ] }] } : { workflow_runs: [run(), run({ id: 11, head_sha: "old", conclusion: "success", status: "completed" }), run({ id: 12, pull_requests: [{ number: 8 }] })] }) as T;
    }, "dona/projeto", pull());
    assert.equal(status.state, "running");
    assert.equal(status.label, "Linux / Node 22 → Testes unitários (2/2)");
    assert.match(status.details, /CI: Em execução/);
    assert.equal(paths.length, 2);
    assert.equal(paths[0], "/repos/dona/projeto/actions/runs?head_sha=abc123&per_page=100&page=1");
    assert.match(paths[1], /runs\/10\/jobs\?filter=latest/);
});

test("PR Actions uses the latest run per workflow and does not confuse forks with identical branches", async () => {
    const result = await loadPullActions(async <T>() => ({ workflow_runs: [
        run({ id: 1, status: "completed", conclusion: "failure" }),
        run({ id: 2, status: "completed", conclusion: "success" }),
        run({ id: 3, workflow_id: 2, pull_requests: [], head_repository: { full_name: "other/fork" } })
    ] }) as T, "dona/projeto", pull());
    assert.equal(result.state, "success");
    assert.equal(result.label, "Passou");
    const fork = { ...pull(), head: { ...pull().head!, repo: { full_name: "other/fork" } } };
    const matching = await loadPullActions(async <T>() => ({ workflow_runs: [run({ status: "completed", conclusion: "success", pull_requests: [], head_repository: { full_name: "other/fork" } })] }) as T, "dona/projeto", fork);
    assert.equal(matching.state, "success", "Forks may omit pull_requests but still match their source repository and SHA");
});

test("PR Actions combines workflows and prioritizes failures while showing parallel stages", async () => {
    const result = await loadPullActions(async <T>(path: string) => {
        if (!path.includes("/jobs?")) return { workflow_runs: [run(), run({ id: 20, workflow_id: 2, name: "Deploy", status: "completed", conclusion: "failure" })] } as T;
        const failed = path.includes("/20/");
        return { jobs: [{ name: failed ? "Produção" : "Testes", status: failed ? "completed" : "in_progress", conclusion: failed ? "failure" : null,
            steps: [{ name: failed ? "Publicar" : "Executar testes", number: 1, status: failed ? "completed" : "in_progress", conclusion: failed ? "failure" : null }] }] } as T;
    }, "dona/projeto", pull());
    assert.equal(result.state, "failure");
    assert.match(result.label, /Produção → Publicar/);
    assert.match(result.details, /CI: Em execução/);
    assert.match(result.details, /Deploy: Falhou/);
});

test("PR Actions paginates runs and jobs, and stage access errors retain workflow status", async () => {
    const paths: string[] = [];
    const result = await loadPullActions(async <T>(path: string) => {
        paths.push(path);
        if (path.includes("/jobs?")) return { jobs: path.endsWith("page=1") ? Array.from({ length: 100 }, () => ({ name: "Finished", status: "completed", conclusion: "success" })) : [{ name: "Last matrix job", status: "in_progress", conclusion: null }] } as T;
        return { workflow_runs: path.endsWith("page=1") ? Array.from({ length: 100 }, (_, i) => run({ id: i, head_sha: "old" })) : [run()] } as T;
    }, "dona/projeto", pull());
    assert.equal(result.label, "Last matrix job");
    assert.equal(paths.length, 4);
    const partial = await loadPullActions(async <T>(path: string) => {
        if (path.includes("/jobs?")) throw new Error("Sem permissão nos jobs");
        return { workflow_runs: [run()] } as T;
    }, "dona/projeto", pull());
    assert.equal(partial.state, "running");
    assert.match(partial.details, /Etapas indisponíveis/);
});

test("PR Actions distinguishes no workflow, missing SHA, approvals, cancelled and skipped runs", async () => {
    assert.equal((await loadPullActions(async <T>() => ({ workflow_runs: [] }) as T, "dona/projeto", pull())).state, "none");
    assert.equal((await loadPullActions(async () => { throw new Error("Must not request without SHA"); }, "dona/projeto", item())).state, "unknown");
    for (const [status, conclusion, expected] of [["queued", null, "waiting"], ["waiting", null, "waiting"], ["completed", "action_required", "waiting"], ["completed", "cancelled", "cancelled"], ["completed", "skipped", "neutral"], ["completed", null, "unknown"], ["completed", "stale", "unknown"]]) {
        const result = await loadPullActions(async <T>() => ({ workflow_runs: [run({ status: status!, conclusion })] }) as T, "dona/projeto", pull());
        assert.equal(result.state, expected);
    }
    await assert.rejects(loadPullActions(async () => { throw new Error("Sem Actions"); }, "dona/projeto", pull()), /Sem Actions/);
});


test("active job labels preserve the current step out of sixteen", async () => {
    const status = await loadPullActions(async <T>(path: string) => (path.includes("/jobs?") ? { jobs: [{
        name: "Tests (1/6)", status: "in_progress", conclusion: null,
        steps: Array.from({ length: 16 }, (_, index) => ({ name: `Etapa ${index + 1}`, number: index + 1,
            status: index < 2 ? "completed" : index === 2 ? "in_progress" : "queued", conclusion: index < 2 ? "success" : null }))
    }] } : { workflow_runs: [run()] }) as T, "dona/projeto", pull());
    assert.equal(status.label, "Tests (1/6) → Etapa 3 (3/16)");
});
