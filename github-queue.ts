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
export interface GithubQueuePage { viewer: string; nodes: GithubQueueItem[]; pageInfo: { hasNextPage: boolean; endCursor: string | null; }; }
export type GithubQueueRequest = (repository: string, cursor: string | null) => Promise<GithubQueuePage>;
export interface GithubQueueSnapshot { items: GithubQueueItem[]; merged: GithubQueueItem[]; error: string; updated: number | null; }

// shortcut: detalhes dos primeiros 100 checks por PR; paginar se precisar exibir todos no Discord.
export const mergeQueueQuery = `query FockyTVMergeQueue($owner: String!, $name: String!, $cursor: String) {
    viewer { login }
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
        body: JSON.stringify({ query: mergeQueueQuery, variables: { owner, name, cursor } }),
        redirect: "error", signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new Error(githubError({ status: response.status, body: "", remaining: response.headers.get("x-ratelimit-remaining"), retryAfter: response.headers.get("retry-after") }));
    const result = await response.json();
    if (result.errors?.length || !result.data?.repository) throw new Error("Merge Queue indisponível. Confira as permissões de leitura do token e o acesso ao repositório.");
    return { viewer: result.data.viewer.login, ...result.data.repository.pullRequests } as GithubQueuePage;
}

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
    const items = new Map<number, GithubQueueItem>(), open = new Set<number>();
    let cursor: string | null = null;
    do {
        const page = await request(repository, cursor);
        // Só os PRs do dono do token: a fila dos outros não interessa no Discord.
        for (const item of page.nodes) if (item && item.author?.login === page.viewer) {
            open.add(item.number);
            if (item.mergeQueueEntry) items.set(item.number, item);
        }
        if (!page.pageInfo.hasNextPage) break;
        if (!page.pageInfo.endCursor || page.pageInfo.endCursor === cursor) throw new Error("Paginação inválida da Merge Queue.");
        cursor = page.pageInfo.endCursor;
    } while (true);
    return { open, items: [...items.values()].sort((a, b) => a.baseRefName.localeCompare(b.baseRefName) || a.mergeQueueEntry!.position - b.mergeQueueEntry!.position) };
}

export const MERGED_VISIBLE_MS = 15 * 60_000;

type QueueSubscription = { subscribe(listener: (snapshot: GithubQueueSnapshot) => void): () => void; seen(): void; };
const watchers = new Map<GithubQueueRequest, Map<string, QueueSubscription>>();

// Ícone e modal compartilham a consulta; o próximo ciclo só começa após a consulta anterior terminar.
export function watchGithubQueue(request: GithubQueueRequest, repository: string, onChange: (snapshot: GithubQueueSnapshot) => void) {
    const repositories = watchers.get(request) ?? new Map<string, QueueSubscription>();
    watchers.set(request, repositories);
    const existing = repositories.get(repository);
    if (existing) return existing.subscribe(onChange);
    const listeners = new Set<(snapshot: GithubQueueSnapshot) => void>();
    let stopped = false, delay = 30_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let snapshot: GithubQueueSnapshot = { items: [], merged: [], error: "", updated: null };
    // PRs mesclados ficam visíveis por pelo menos 15 min e até o painel ser aberto depois do merge.
    const merged = new Map<number, { item: GithubQueueItem; at: number; seen: boolean; }>();
    const recent = () => {
        for (const [number, entry] of merged) if (entry.seen && Date.now() - entry.at >= MERGED_VISIBLE_MS) merged.delete(number);
        return [...merged.values()].map(entry => entry.item);
    };
    const refresh = async () => {
        if (!document.hidden) {
            try {
                const { items, open } = await loadGithubQueue(request, repository);
                // ponytail: sair da fila e deixar de estar aberto conta como merge; PR fechado sem merge também ficaria verde.
                for (const item of snapshot.items) if (!open.has(item.number)) merged.set(item.number, { item, at: Date.now(), seen: false });
                snapshot = { items, merged: recent(), error: "", updated: Date.now() };
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
        merged.forEach(entry => { entry.seen = true; });
        snapshot = { ...snapshot, merged: recent() };
        listeners.forEach(listener => listener(snapshot));
    } };
    repositories.set(repository, entry);
    const unsubscribe = entry.subscribe(onChange);
    void refresh();
    return unsubscribe;
}

export function markGithubQueueSeen() {
    watchers.forEach(repositories => repositories.forEach(entry => entry.seen()));
}
