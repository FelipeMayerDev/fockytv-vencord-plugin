// SPDX-License-Identifier: GPL-3.0-or-later
import { githubError, repositoryName } from "./github";

export interface GithubQueueItem {
    number: number; title: string; baseRefName: string; author: { login: string; } | null;
    mergeQueueEntry: {
        position: number; state: string; enqueuedAt: string; estimatedTimeToMerge: number | null;
        headCommit: { oid: string; statusCheckRollup: {
            state: string;
            contexts: { totalCount: number; nodes: ({ name: string; status: string; conclusion: string | null; } | { context: string; state: string; })[]; };
        } | null; } | null;
    } | null;
}
export interface GithubMergedPr { number: number; title: string; mergedAt: string; }
export interface GithubQueuePage { viewer: string; merged: GithubMergedPr[]; nodes: GithubQueueItem[]; pageInfo: { hasNextPage: boolean; endCursor: string | null; }; }
export type GithubQueueRequest = (repository: string, cursor: string | null) => Promise<GithubQueuePage>;
export interface GithubQueueSnapshot { items: GithubQueueItem[]; history: GithubMergedPr[]; merged: GithubMergedPr[]; error: string; updated: number | null; }

// shortcut: detalhes dos primeiros 100 checks por PR; paginar se precisar exibir todos no Discord.
// ponytail: até 50 merges do dia; paginar a busca se alguém mesclar mais que isso.
export const mergeQueueQuery = `query FockyTVMergeQueue($owner: String!, $name: String!, $cursor: String, $merged: String!) {
    viewer { login }
    merged: search(query: $merged, type: ISSUE, first: 50) { nodes { ... on PullRequest { number title mergedAt } } }
    repository(owner: $owner, name: $name) {
        pullRequests(states: OPEN, first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { number title baseRefName author { login } mergeQueueEntry {
                position state enqueuedAt estimatedTimeToMerge
                headCommit { oid statusCheckRollup { state contexts(first: 100) {
                    totalCount nodes {
                        ... on CheckRun { name status conclusion }
                        ... on StatusContext { context state }
                    }
                } } }
            } }
        }
    }
}`;

// Consulta fixa de leitura: o renderer só escolhe repositório e cursor, nunca o GraphQL.
export async function fetchGithubMergeQueue(token: string, repository: string, cursor: string | null) {
    const [owner, name] = repositoryName(repository).split("/");
    if (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token)) throw new Error("Configure um token GitHub para acompanhar a Merge Queue.");
    if (cursor !== null && (typeof cursor !== "string" || cursor.length > 1024)) throw new Error("Cursor GitHub inválido.");
    const response = await fetch("https://api.github.com/graphql", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "User-Agent": "FockyTV" },
        body: JSON.stringify({ query: mergeQueueQuery, variables: { owner, name, cursor, merged: mergedTodayQuery(owner, name) } }),
        redirect: "error", signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new Error(githubError({ status: response.status, body: "", remaining: response.headers.get("x-ratelimit-remaining"), retryAfter: response.headers.get("retry-after") }));
    const result = await response.json();
    if (result.errors?.length || !result.data?.repository) throw new Error("Merge Queue indisponível. Confira as permissões de leitura do token e o acesso ao repositório.");
    return { ...result.data.repository.pullRequests, viewer: result.data.viewer.login, merged: result.data.merged?.nodes.filter((pr: GithubMergedPr) => pr?.mergedAt) ?? [] } as GithubQueuePage;
}

// Meus PRs mesclados desde a meia-noite local; o histórico zera a cada dia.
export const mergedTodayQuery = (owner: string, name: string, now = new Date()) =>
    `repo:${owner}/${name} is:pr is:merged author:@me merged:>=${new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString().slice(0, 19)}Z sort:updated-desc`;

export const mergeQueueState = (item: GithubQueueItem) => ({ QUEUED: "Na fila", AWAITING_CHECKS: "Aguardando checks", MERGEABLE: "Pronto para merge", UNMERGEABLE: "Bloqueado para merge", LOCKED: "Fila bloqueada" }[item.mergeQueueEntry!.state] ?? item.mergeQueueEntry!.state);

export function githubCheckStatus(value: string) {
    switch (value.toLowerCase()) {
        case "success": return "success";
        case "failure": case "error": case "timed_out": case "startup_failure": return "failure";
        case "in_progress": return "running";
        case "queued": case "pending": case "requested": case "waiting": case "action_required": return "waiting";
        case "neutral": case "skipped": case "cancelled": return "neutral";
        default: return "unknown";
    }
}

export async function loadGithubQueue(request: GithubQueueRequest, repository: string) {
    const items = new Map<number, GithubQueueItem>();
    let cursor: string | null = null, history: GithubMergedPr[] | undefined;
    do {
        const page = await request(repository, cursor);
        history ??= [...page.merged].sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
        // Só os PRs do dono do token: a fila dos outros não interessa no Discord.
        for (const item of page.nodes) if (item?.mergeQueueEntry && item.author?.login === page.viewer) items.set(item.number, item);
        if (!page.pageInfo.hasNextPage) break;
        if (!page.pageInfo.endCursor || page.pageInfo.endCursor === cursor) throw new Error("Paginação inválida da Merge Queue.");
        cursor = page.pageInfo.endCursor;
    } while (true);
    return { history: history ?? [], items: [...items.values()].sort((a, b) => a.baseRefName.localeCompare(b.baseRefName) || a.mergeQueueEntry!.position - b.mergeQueueEntry!.position) };
}

export const MERGED_VISIBLE_MS = 15 * 60_000;

type QueueSubscription = { subscribe(listener: (snapshot: GithubQueueSnapshot) => void): () => void; seen(): void; };
const watchers = new Map<GithubQueueRequest, Map<string, QueueSubscription>>();
let seenAt = 0;

// Ícone e modal compartilham a consulta; o próximo ciclo só começa após a consulta anterior terminar.
export function watchGithubQueue(request: GithubQueueRequest, repository: string, onChange: (snapshot: GithubQueueSnapshot) => void) {
    const repositories = watchers.get(request) ?? new Map<string, QueueSubscription>();
    watchers.set(request, repositories);
    const existing = repositories.get(repository);
    if (existing) return existing.subscribe(onChange);
    const listeners = new Set<(snapshot: GithubQueueSnapshot) => void>();
    let stopped = false, delay = 30_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let snapshot: GithubQueueSnapshot = { items: [], history: [], merged: [], error: "", updated: null };
    // No hover, um merge fica por pelo menos 15 min e até o painel ser aberto depois dele.
    // ponytail: "visto" vive só na memória; ao reiniciar o Discord, os merges do dia voltam ao hover até abrir o painel.
    const recent = (history: GithubMergedPr[]) => history.filter(pr => Date.now() - Date.parse(pr.mergedAt) < MERGED_VISIBLE_MS || seenAt < Date.parse(pr.mergedAt));
    const refresh = async () => {
        if (!document.hidden) {
            try {
                const { items, history } = await loadGithubQueue(request, repository);
                snapshot = { items, history, merged: recent(history), error: "", updated: Date.now() };
                delay = 30_000;
            } catch (cause) {
                snapshot = { ...snapshot, error: String((cause as Error)?.message ?? cause) };
                delay = Math.min(delay * 2, 300_000);
            }
            if (!stopped) listeners.forEach(listener => listener(snapshot));
        }
        if (!stopped) timer = setTimeout(refresh, delay);
    };
    const entry = { subscribe(listener: (snapshot: GithubQueueSnapshot) => void) {
        listeners.add(listener);
        listener(snapshot);
        return () => {
            listeners.delete(listener);
            if (listeners.size) return;
            stopped = true;
            clearTimeout(timer);
            repositories.delete(repository);
            if (!repositories.size) watchers.delete(request);
        };
    }, seen() {
        snapshot = { ...snapshot, merged: recent(snapshot.history) };
        listeners.forEach(listener => listener(snapshot));
    } };
    repositories.set(repository, entry);
    const unsubscribe = entry.subscribe(onChange);
    void refresh();
    return unsubscribe;
}

export function markGithubQueueSeen() {
    seenAt = Date.now();
    watchers.forEach(repositories => repositories.forEach(entry => entry.seen()));
}
