// SPDX-License-Identifier: GPL-3.0-or-later
import { githubError, repositoryName } from "./github";
import { githubCheckStatus } from "./github-queue";

export interface GithubAlertsOpenPr { number: number; title: string; author: { login: string; } | null; statusCheckRollup: { state: string; } | null; }
export interface GithubAlertsMergedPr { number: number; title: string; mergedAt: string; }
export interface GithubAlertsPage { viewer: string; open: GithubAlertsOpenPr[]; merged: GithubAlertsMergedPr[]; }
export type GithubAlertsRequest = (repository: string, since: string) => Promise<GithubAlertsPage>;
export interface GithubAlert { title: string; body: string; url: string; }

// ponytail: os 100 PRs abertos mais recentes podem esconder um PR antigo em repositórios muito movimentados; paginar se preciso.
export const pullAlertsQuery = `query FockyTVPrAlerts($owner: String!, $name: String!, $merged: String!) {
    viewer { login }
    repository(owner: $owner, name: $name) {
        pullRequests(states: OPEN, first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
            nodes { number title author { login } statusCheckRollup { state } }
        }
    }
    merged: search(query: $merged, type: ISSUE, first: 20) { nodes { ... on PullRequest { number title mergedAt } } }
}`;

export const mergedSinceQuery = (owner: string, name: string, since: string) =>
    `repo:${owner}/${name} is:pr is:merged author:@me merged:>=${since} sort:updated-desc`;

// Consulta fixa de leitura: o renderer só escolhe repositório, nunca o GraphQL.
export async function fetchGithubAlerts(token: string, repository: string, since: string) {
    const [owner, name] = repositoryName(repository).split("/");
    if (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token)) throw new Error("Configure um token GitHub para receber os alertas de PR.");
    if (typeof since !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(since) || Number.isNaN(Date.parse(since))) throw new Error("Janela de alertas inválida.");
    const response = await fetch("https://api.github.com/graphql", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "User-Agent": "FockyTV" },
        body: JSON.stringify({ query: pullAlertsQuery, variables: { owner, name, merged: mergedSinceQuery(owner, name, since) } }),
        redirect: "error", signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new Error(githubError({ status: response.status, body: "", remaining: response.headers.get("x-ratelimit-remaining"), retryAfter: response.headers.get("retry-after") }));
    const result = await response.json();
    if (result.errors?.length || !result.data?.repository || !result.data.viewer?.login) throw new Error("Alertas de PR indisponíveis. Confira as permissões de leitura do token e o acesso ao repositório.");
    return {
        viewer: String(result.data.viewer.login),
        open: (result.data.repository.pullRequests?.nodes ?? []).filter((pr: GithubAlertsOpenPr) => pr),
        merged: (result.data.merged?.nodes ?? []).filter((pr: GithubAlertsMergedPr) => pr?.mergedAt)
    } as GithubAlertsPage;
}

// Alertas do repositório selecionado para quem tem token: PR meu mergeado e CI do meu PR falhando.
// Diferente da Merge Queue, o poll continua com a aba oculta — avisar em segundo plano é o propósito.
export function watchGithubAlerts(request: GithubAlertsRequest, getRepository: () => string, onAlert: (alert: GithubAlert) => void) {
    let stopped = false, delay = 30_000, repository = "", since = "", baseline = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rollup = new Map<number, string>(), merged = new Set<number>();
    const rememberMerged = (number: number) => {
        merged.add(number);
        if (merged.size > 500) merged.delete(merged.values().next().value!);
    };
    const normalize = (value: string) => {
        try { return repositoryName(value ?? ""); } catch { return ""; }
    };
    const notify = (kind: "merged" | "failed", pr: { number: number; title: string; }, target: string) => onAlert({
        title: `FockyTV: ${kind === "merged" ? "PR mergeado" : "Actions falhou no PR"}`,
        body: `#${pr.number} · ${pr.title}`,
        url: `https://github.com/${target}/pull/${pr.number}`
    });
    const refresh = async () => {
        try {
            const target = normalize(getRepository());
            if (target !== repository) {
                repository = target;
                baseline = true, since = "", rollup.clear(), merged.clear();
            }
            if (target) {
                const startedAt = `${new Date().toISOString().slice(0, 19)}Z`;
                const page = await request(target, since || startedAt);
                if (stopped) return; // Resultado tardio após parar o plugin: descarta sem alertar.
                since = startedAt;
                const mine = page.open.filter(pr => pr.author?.login === page.viewer);
                if (baseline) {
                    for (const pr of mine) rollup.set(pr.number, pr.statusCheckRollup ? githubCheckStatus(pr.statusCheckRollup.state) : "unknown");
                    for (const pr of page.merged) rememberMerged(pr.number);
                    baseline = false;
                } else {
                    for (const pr of page.merged) if (!merged.has(pr.number)) {
                        rememberMerged(pr.number);
                        notify("merged", pr, target);
                    }
                    for (const pr of mine) {
                        const state = pr.statusCheckRollup ? githubCheckStatus(pr.statusCheckRollup.state) : "unknown";
                        const previous = rollup.get(pr.number);
                        rollup.set(pr.number, state);
                        if (previous !== undefined && previous !== "failure" && state === "failure") notify("failed", pr, target);
                    }
                    const open = new Set(mine.map(pr => pr.number));
                    for (const number of [...rollup.keys()]) if (!open.has(number)) rollup.delete(number);
                }
                delay = 30_000;
            }
        } catch { delay = Math.min(delay * 2, 300_000); }
        if (!stopped) timer = setTimeout(refresh, delay);
    };
    void refresh();
    return () => {
        stopped = true;
        clearTimeout(timer);
    };
}
