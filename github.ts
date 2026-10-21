// SPDX-License-Identifier: GPL-3.0-or-later
export const defaultRepository = "FelipeMayerDev/fockytv-vencord-plugin";
export type GithubFetch = <T>(path: string) => Promise<T>;
export interface GithubUser { login: string; }
export interface GithubRepository { full_name: string; description: string | null; private: boolean; default_branch: string; }
export interface GithubItem {
    id: number; number: number; title: string; state: string; body: string | null; updated_at: string;
    user: GithubUser | null; assignees: GithubUser[]; labels: { name: string; color: string; }[];
    comments?: number; draft?: boolean; merged_at?: string | null; pull_request?: unknown;
    requested_reviewers?: GithubUser[]; head?: { ref: string; }; base?: { ref: string; };
    additions?: number; deletions?: number; changed_files?: number; mergeable_state?: string;
    milestone?: { title: string; } | null;
}
export interface GithubRun {
    id: number; name: string; display_title: string; status: string; conclusion: string | null;
    head_branch: string; updated_at: string; run_number: number;
}
export interface GithubComment { id: number; user: GithubUser | null; body: string; created_at: string; }
export interface GithubReview { id: number; user: GithubUser | null; state: string; submitted_at: string | null; }

export function repositoryName(value: string) {
    const name = value.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\/$/, "").replace(/\.git$/, "");
    if (!/^[a-z\d](?:[a-z\d-]*[a-z\d])?\/[\w.-]+$/i.test(name) || [".", ".."].includes(name.split("/")[1]))
        throw new Error("Use dono/repositório ou um link https://github.com/dono/repositório.");
    return name;
}

// Só rotas de leitura usadas pelo painel; URLs e redirecionamentos nunca recebem o token.
export function githubApiUrl(path: string) {
    if (typeof path !== "string" || /\/\.{1,2}(?:\/|\?|$)/.test(path) || !/^\/(?:user(?:\/repos)?|repos\/[a-z\d-]+\/[\w.-]+(?:\/(?:pulls(?:\/\d+(?:\/reviews)?)?|issues(?:\/\d+(?:\/comments)?)?|actions\/runs))?)(?:\?[a-z\d_=&%-]+)?$/i.test(path))
        throw new Error("Requisição GitHub inválida.");
    return `https://api.github.com${path}`;
}

export async function fetchGithub(token: string, path: string) {
    const url = githubApiUrl(path);
    if (typeof token !== "string" || /[\r\n]/.test(token)) throw new Error("Token GitHub inválido.");
    const response = await fetch(url, {
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "FockyTV", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        redirect: "error", signal: AbortSignal.timeout(20_000)
    });
    return { status: response.status, body: await response.text(), retryAfter: response.headers.get("retry-after"), remaining: response.headers.get("x-ratelimit-remaining"), reset: response.headers.get("x-ratelimit-reset") };
}

export function githubError(response: { status: number; body: string; remaining?: string | null; retryAfter?: string | null; reset?: string | null; }) {
    if (response.status === 401) return "Token GitHub inválido ou expirado. Atualize nas configurações do FockyTV.";
    if (response.status === 429 || response.status === 403 && (response.remaining === "0" || response.retryAfter))
        return "Limite de requisições do GitHub atingido. Pause a atualização automática e tente mais tarde; um token aumenta o limite de acesso público.";
    if (response.status === 403) return "Sem permissão. Confira o acesso do token ao repositório e a autorização SSO da organização.";
    if (response.status === 404) return "Repositório ou recurso não encontrado. Se for privado, confira o acesso do token.";
    return `GitHub respondeu HTTP ${response.status}. Tente novamente.`;
}

export const githubUrl = (repository: string, section = "") => `https://github.com/${repositoryName(repository)}${section}`;
export const itemState = (item: GithubItem) => item.merged_at ? "Mesclado" : item.state === "closed" ? "Fechado" : item.draft ? "Rascunho" : "Aberto";
export function matchesGithub(item: GithubItem, query: string, mine = "", reviewOnly = false) {
    if (mine && (reviewOnly ? !item.requested_reviewers?.some(user => user.login === mine)
        : item.user?.login !== mine && !item.assignees.some(user => user.login === mine))) return false;
    const text = query.trim().toLowerCase().replace(/^#/, "");
    return !text || `${item.number} ${item.title} ${item.user?.login ?? ""} ${item.labels.map(label => label.name).join(" ")}`.toLowerCase().includes(text);
}

// Uma pessoa pode revisar várias vezes; só sua última decisão vale, e comentário não revoga aprovação.
export function latestReviews(reviews: GithubReview[]) {
    const latest = new Map<string, GithubReview>();
    for (const review of reviews.filter(review => review.user && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state))
        .sort((a, b) => (a.submitted_at ?? "").localeCompare(b.submitted_at ?? "") || a.id - b.id))
        latest.set(review.user!.login, review);
    return [...latest.values()].filter(review => review.state !== "DISMISSED");
}

export type GithubTab = "pulls" | "issues" | "actions";
export type GithubPages = Record<GithubTab, number>;
export async function loadGithub(request: GithubFetch, repository: string, state: string, pages: GithubPages) {
    const base = `/repos/${repositoryName(repository)}`;
    const list = async <T>(tab: GithubTab) => {
        const results = await Promise.all(Array.from({ length: pages[tab] }, async (_, index) => {
            const path = tab === "actions" ? `${base}/actions/runs?per_page=30&page=${index + 1}`
                : `${base}/${tab}?state=${state}&sort=updated&direction=desc&per_page=100&page=${index + 1}`;
            const result = await request<T[] | { workflow_runs: T[]; }>(path);
            return Array.isArray(result) ? result : result.workflow_runs;
        }));
        return { items: [...new Map(results.flat().map(item => [(item as { id: number; }).id, item])).values()], more: results.at(-1)?.length === (tab === "actions" ? 30 : 100) };
    };
    const [pulls, issues, actions] = await Promise.allSettled([list<GithubItem>("pulls"), list<GithubItem>("issues"), list<GithubRun>("actions")]);
    return {
        pulls: pulls.status === "fulfilled" ? pulls.value : null,
        issues: issues.status === "fulfilled" ? { ...issues.value, items: issues.value.items.filter(item => !item.pull_request) } : null,
        actions: actions.status === "fulfilled" ? actions.value : null,
        errors: [pulls, issues, actions].map(result => result.status === "rejected" ? String(result.reason?.message ?? result.reason) : "")
    };
}

export async function loadGithubDetail(request: GithubFetch, repository: string, kind: "pulls" | "issues", number: number) {
    const base = `/repos/${repositoryName(repository)}`;
    const detail = await request<GithubItem>(`${base}/${kind}/${number}`);
    // Só a página mais recente da conversa; o histórico completo fica no GitHub.
    const commentsPage = Math.max(1, Math.ceil((detail.comments ?? 0) / 100));
    const [comments, reviews] = await Promise.allSettled([
        request<GithubComment[]>(`${base}/issues/${number}/comments?per_page=100&page=${commentsPage}`),
        (async () => {
            const all: GithubReview[] = [];
            if (kind === "pulls") {
                for (let page = 1; ; page++) {
                    const next = await request<GithubReview[]>(`${base}/pulls/${number}/reviews?per_page=100&page=${page}`);
                    all.push(...next);
                    if (next.length < 100) break;
                }
            }
            return latestReviews(all);
        })()
    ]);
    return {
        detail, comments: comments.status === "fulfilled" ? comments.value : [], reviews: reviews.status === "fulfilled" ? reviews.value : [],
        error: [comments, reviews].map(result => result.status === "rejected" ? String(result.reason?.message ?? result.reason) : "").filter(Boolean).join(" ")
    };
}
