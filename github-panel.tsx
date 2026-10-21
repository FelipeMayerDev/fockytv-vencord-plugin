// SPDX-License-Identifier: GPL-3.0-or-later
import { copyToClipboard } from "@utils/clipboard";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, React, useEffect, useRef, useState } from "@webpack/common";

import { defaultRepository, GithubComment, GithubFetch, GithubItem, GithubPages, GithubRepository, GithubReview, GithubRun, GithubTab, githubUrl, itemState, loadGithub, loadGithubDetail, matchesGithub, repositoryName } from "./github";
import { relativeTime } from "./jira";

export interface GithubContext { request: GithubFetch; repository: string; authenticated: boolean; setRepository(value: string): void; }
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const external = (url: string) => void VencordNative.native.openExternal(url);
const tabNames = { pulls: "Pull requests", issues: "Issues", actions: "Actions / CI" };
const reviewNames: Record<string, string> = { APPROVED: "Aprovado", CHANGES_REQUESTED: "Alterações solicitadas" };
const conclusions: Record<string, string> = { success: "Passou", failure: "Falhou", cancelled: "Cancelado", skipped: "Ignorado", timed_out: "Tempo esgotado", action_required: "Ação necessária", neutral: "Neutro", stale: "Expirado", startup_failure: "Falha ao iniciar" };
const runLabel = (run: GithubRun) => run.conclusion ? conclusions[run.conclusion] ?? run.conclusion : run.status === "in_progress" ? "Em execução" : "Na fila";
function Mark({ kind, size = 18 }: { kind: GithubTab; size?: number; }) {
    return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {kind === "pulls" ? <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M14 3l-3 3 3 3M11 6h4a3 3 0 0 1 3 3v8" /><circle cx="18" cy="19" r="2" /></>
            : kind === "issues" ? <><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 17h.01" /></>
                : <><circle cx="12" cy="12" r="9" /><path d="m10 8 6 4-6 4z" /></>}
    </svg>;
}
function State({ value }: { value: string; }) {
    return <span className="fockytv-gh-state" data-state={value}>{value}</span>;
}
function ErrorNotice({ children }: { children: React.ReactNode; }) {
    return <div className="fockytv-jira-notice fockytv-jira-notice-error" role="alert">{children}</div>;
}

function ItemDetail({ context, repository, item, kind, onBack, version }: { context: GithubContext; repository: string; item: GithubItem; kind: "pulls" | "issues"; onBack(): void; version: number; }) {
    const [detail, setDetail] = useState(item);
    const [comments, setComments] = useState<GithubComment[]>([]);
    const [reviews, setReviews] = useState<GithubReview[]>([]);
    const [error, setError] = useState("");
    const [copied, setCopied] = useState(false);
    const [loading, setLoading] = useState(true);
    const url = githubUrl(repository, `/${kind === "pulls" ? "pull" : "issues"}/${item.number}`);
    useEffect(() => {
        let alive = true;
        setLoading(true);
        setError("");
        loadGithubDetail(context.request, repository, kind, item.number).then(result => {
            if (!alive) return;
            setDetail(result.detail); setComments(result.comments); setReviews(result.reviews); setError(result.error);
        }, cause => { if (alive) setError(message(cause)); }).finally(() => { if (alive) setLoading(false); });
        return () => { alive = false; };
    }, [repository, item.number, version]);
    return <section className="fockytv-jira-detail" aria-busy={loading}>
        <div className="fockytv-jira-detail-bar">
            <button type="button" className="fockytv-jira-button-secondary" onClick={onBack}>← Voltar</button>
            <span className="fockytv-jira-spacer" />
            <button type="button" className="fockytv-jira-button-secondary" onClick={() => { copyToClipboard(url); setCopied(true); }}>{copied ? "Link copiado ✓" : "Copiar link"}</button>
            <button type="button" className="fockytv-jira-button-primary" onClick={() => external(url)}>Abrir no GitHub ↗</button>
        </div>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        <div className="fockytv-gh-detail-heading"><State value={itemState(detail)} /><span className="fockytv-jira-muted">{kind === "pulls" ? "PR" : "Issue"} #{detail.number}</span><h2>{detail.title}</h2></div>
        {detail.head && <div className="fockytv-gh-branch"><code>{detail.head.ref}</code> → <code>{detail.base?.ref}</code>{detail.additions !== undefined && <span><b className="fockytv-gh-positive">+{detail.additions}</b> / <b className="fockytv-gh-negative">−{detail.deletions}</b> · {detail.changed_files} arquivos</span>}</div>}
        <div className="fockytv-gh-detail-grid">
            <div>
                <section className="fockytv-gh-box"><h3>Descrição</h3><p className="fockytv-gh-body">{detail.body || "Nenhuma descrição adicionada."}</p></section>
                <section className="fockytv-gh-box"><h3>Conversa <span className="fockytv-jira-count">{detail.comments ?? comments.length}</span></h3>
                    <p className="fockytv-jira-muted">Página mais recente dos comentários gerais. Para responder, ver reviews em linha ou o histórico completo, abra no GitHub.</p>
                    {loading && <p role="status">Atualizando detalhes…</p>}
                    {comments.map(comment => <article key={comment.id} className="fockytv-gh-comment"><strong>{comment.user?.login ?? "Conta removida"}</strong><time dateTime={comment.created_at}>{relativeTime(comment.created_at)}</time><p className="fockytv-gh-body">{comment.body}</p></article>)}
                    {!loading && !comments.length && <p className="fockytv-jira-empty">Sem comentários nesta página.</p>}
                </section>
            </div>
            <aside className="fockytv-gh-box"><h3>Pessoas e contexto</h3>
                <dl className="fockytv-gh-meta"><dt>Autor</dt><dd>{detail.user?.login ?? "Conta removida"}</dd><dt>Responsáveis</dt><dd>{detail.assignees.map(user => user.login).join(", ") || "Ninguém atribuído"}</dd>
                    <dt>Atualizado</dt><dd>{relativeTime(detail.updated_at)}</dd><dt>Milestone</dt><dd>{detail.milestone?.title ?? "Sem milestone"}</dd>
                    {kind === "pulls" && <><dt>Review solicitado</dt><dd>{detail.requested_reviewers?.map(user => user.login).join(", ") || "Nenhum revisor individual pendente"}</dd></>}
                </dl>
                <div className="fockytv-gh-labels">{detail.labels.map(label => <span key={label.name} className="fockytv-gh-label">{label.name}</span>)}</div>
                {reviews.length > 0 && <><h3>Reviews</h3>{reviews.map(review => <p key={review.id}>{review.user?.login}<br /><State value={reviewNames[review.state] ?? review.state} /></p>)}</>}
            </aside>
        </div>
    </section>;
}

export function GithubPanel({ context, ...props }: RenderModalProps & { context: GithubContext; }) {
    const [repository, setRepository] = useState(context.repository || defaultRepository);
    const [repositories, setRepositories] = useState<GithubRepository[]>([]);
    const [repoPage, setRepoPage] = useState(1);
    const [moreRepos, setMoreRepos] = useState(false);
    const [reposLoading, setReposLoading] = useState(false);
    const [reposError, setReposError] = useState("");
    const [reposVersion, setReposVersion] = useState(0);
    const [login, setLogin] = useState("");
    const [custom, setCustom] = useState("");
    const [tab, setTab] = useState<GithubTab>("pulls");
    const [state, setState] = useState("open");
    const [query, setQuery] = useState("");
    const [mine, setMine] = useState(false);
    const [reviewOnly, setReviewOnly] = useState(false);
    const [automatic, setAutomatic] = useState(true);
    const [version, setVersion] = useState(0);
    const [pages, setPages] = useState<GithubPages>({ pulls: 1, issues: 1, actions: 1 });
    const [data, setData] = useState<Awaited<ReturnType<typeof loadGithub>> | null>(null);
    const [loading, setLoading] = useState(false);
    const [updated, setUpdated] = useState<number | null>(null);
    const [selected, setSelected] = useState<{ item: GithubItem; kind: "pulls" | "issues"; } | null>(null);
    const busy = useRef(false);
    const scroller = useRef<HTMLDivElement>(null);
    useEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [selected, repository]);
    useEffect(() => {
        if (!context.authenticated) return;
        let alive = true;
        context.request<{ login: string; }>("/user").then(user => { if (alive) setLogin(user.login); }, cause => { if (alive) setReposError(message(cause)); });
        return () => { alive = false; };
    }, [reposVersion]);
    useEffect(() => {
        if (!context.authenticated) return;
        let alive = true;
        setReposLoading(true);
        setReposError("");
        context.request<GithubRepository[]>(`/user/repos?sort=updated&per_page=100&page=${repoPage}`).then(list => {
            if (!alive) return;
            setRepositories(previous => [...new Map([...previous, ...list].map(repo => [repo.full_name, repo])).values()]);
            setMoreRepos(list.length === 100);
        }, cause => { if (alive) setReposError(message(cause)); }).finally(() => { if (alive) setReposLoading(false); });
        return () => { alive = false; };
    }, [repoPage, reposVersion]);
    useEffect(() => {
        let alive = true;
        busy.current = true;
        setLoading(true);
        loadGithub(context.request, repository, state, pages).then(next => {
            if (!alive) return;
            setData(next);
            if (next.errors.some(Boolean)) setAutomatic(false);
            if (next.pulls || next.issues || next.actions) setUpdated(Date.now());
        }, cause => {
            if (alive) { setData({ pulls: null, issues: null, actions: null, errors: [message(cause), message(cause), message(cause)] }); setAutomatic(false); }
        }).finally(() => { if (alive) { setLoading(false); busy.current = false; } });
        return () => { alive = false; };
    }, [repository, state, pages, version]);
    useEffect(() => {
        if (!automatic) return;
        const timer = setInterval(() => { if (!document.hidden && !busy.current) setVersion(value => value + 1); }, 60_000);
        return () => clearInterval(timer);
    }, [automatic]);
    const chooseRepository = (value: string) => {
        try {
            const name = repositoryName(value);
            setRepository(name); context.setRepository(name); setCustom(""); setData(null); setUpdated(null); setSelected(null);
            setPages({ pulls: 1, issues: 1, actions: 1 }); setReposError("");
        } catch (cause) { setReposError(message(cause)); }
    };
    const currentRepo = repositories.find(repo => repo.full_name === repository);
    const list = tab === "actions" ? [] : data?.[tab]?.items ?? [];
    const visible = list.filter(item => matchesGithub(item, query, (mine || reviewOnly && tab === "pulls") ? login : "", reviewOnly && tab === "pulls"));
    const runs = (data?.actions?.items ?? []).filter(run => `${run.name} ${run.display_title} ${run.head_branch}`.toLowerCase().includes(query.toLowerCase()));
    const error = data?.errors[["pulls", "issues", "actions"].indexOf(tab)];
    const refresh = () => setVersion(value => value + 1);
    return <Modal {...props} title="GitHub" subtitle={repository} size="xxl" scrollerRef={scroller}>
        <div className="fockytv-jira fockytv-github">
            <header className="fockytv-gh-hero"><div className="fockytv-gh-hero-icon"><Mark kind="pulls" size={28} /></div><div><span className="fockytv-gh-eyebrow">SEU PROJETO, EM FOCO</span><h2>{repository.split("/")[1]}</h2><p>{currentRepo?.description ?? "PRs, issues e pipelines sem sair do Discord."}</p></div><span className="fockytv-gh-visibility">{currentRepo ? currentRepo.private ? "Privado" : "Público" : "GitHub"}</span></header>
            <div className="fockytv-jira-toolbar">
                <label className="fockytv-gh-project-label">Projeto / repositório<select className="fockytv-jira-input" value={repository} onChange={event => chooseRepository(event.currentTarget.value)}>
                    {!repositories.some(repo => repo.full_name === repository) && <option value={repository}>{repository}</option>}
                    {repositories.map(repo => <option key={repo.full_name} value={repo.full_name}>{repo.full_name}{repo.private ? " · privado" : ""}</option>)}
                </select></label>
                {context.authenticated && (reposLoading || moreRepos) && <button type="button" className="fockytv-jira-button-secondary" disabled={reposLoading} onClick={() => setRepoPage(value => value + 1)}>{reposLoading ? "Buscando projetos…" : "Mais projetos"}</button>}
                <span className="fockytv-jira-spacer" />
                <button type="button" className="fockytv-jira-chip" aria-pressed={automatic} onClick={() => setAutomatic(value => !value)}><span className={`fockytv-gh-live${automatic ? " is-on" : ""}`} />{automatic ? "Auto · 60 s" : "Auto pausado"}</button>
                <button type="button" className="fockytv-jira-button-secondary" disabled={loading} onClick={refresh}>{loading ? "Atualizando…" : "↻ Atualizar"}</button>
            </div>
            <details className="fockytv-gh-add"><summary>Abrir outro repositório</summary><form onSubmit={event => { event.preventDefault(); chooseRepository(custom); }}><input className="fockytv-jira-input" aria-label="Dono/repositório ou URL do GitHub" placeholder="dono/repositório ou link do GitHub" value={custom} onChange={event => setCustom(event.currentTarget.value)} required /><button type="submit" className="fockytv-jira-button-secondary">Abrir projeto</button></form></details>
            {reposError && <ErrorNotice>{reposError} <button type="button" className="fockytv-jira-button-secondary" onClick={() => setReposVersion(value => value + 1)}>Tentar novamente</button></ErrorNotice>}
            {!context.authenticated && <p className="fockytv-gh-hint">Acesso público. Adicione um token nas configurações do FockyTV para listar seus projetos, acessar repositórios privados e filtrar seus itens.</p>}
            {selected ? <ItemDetail key={`${repository}-${selected.kind}-${selected.item.number}`} context={context} repository={repository} {...selected} onBack={() => setSelected(null)} version={version} /> : <>
                <div className="fockytv-gh-stats" aria-label="Resumo dos itens carregados">
                    {(["pulls", "issues", "actions"] as GithubTab[]).map(kind => <button type="button" key={kind} className={`fockytv-gh-stat${tab === kind ? " is-selected" : ""}`} aria-pressed={tab === kind} onClick={() => setTab(kind)}><Mark kind={kind} /><span>{tabNames[kind]}<strong>{data?.[kind] ? `${data[kind]!.items.length}${data[kind]!.more ? "+" : ""}` : "—"}</strong><small>{kind === "actions" ? "execuções recentes" : `${state === "open" ? "abertos" : state === "closed" ? "fechados" : "todos"} · carregados`}</small></span></button>)}
                </div>
                <div className="fockytv-gh-filters">
                    <label className="fockytv-jira-search"><span aria-hidden="true">⌕</span><input type="search" aria-label="Buscar itens" placeholder={tab === "actions" ? "Buscar workflow ou branch…" : "Buscar título, #número, autor ou label…"} value={query} onChange={event => setQuery(event.currentTarget.value)} /></label>
                    {tab !== "actions" && <><select className="fockytv-jira-input" aria-label="Estado dos PRs e issues" value={state} onChange={event => { setState(event.currentTarget.value); setData(null); setPages({ pulls: 1, issues: 1, actions: 1 }); }}><option value="open">Abertos</option><option value="closed">Fechados / mesclados</option><option value="all">Todos os estados</option></select>
                        <button type="button" className={`fockytv-jira-chip${mine ? " fockytv-jira-chip-on" : ""}`} disabled={!login} title="Criados por você ou atribuídos a você" aria-pressed={mine} onClick={() => { setMine(value => !value); setReviewOnly(false); }}>Meus itens</button>
                        {tab === "pulls" && <button type="button" className={`fockytv-jira-chip${reviewOnly ? " fockytv-jira-chip-on" : ""}`} disabled={!login} aria-pressed={reviewOnly} onClick={() => { setReviewOnly(value => !value); setMine(false); }}>Meu review pendente</button>}</>}
                </div>
                <div className="fockytv-gh-list-head"><strong>{tabNames[tab]}</strong><span className="fockytv-jira-muted" role="status">{loading ? "Atualizando…" : updated ? `Consulta às ${new Date(updated).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}` : "Aguardando dados"}</span></div>
                {error && <ErrorNotice>{error} <button type="button" className="fockytv-jira-button-secondary" onClick={refresh} disabled={loading}>Tentar novamente</button></ErrorNotice>}
                <div className="fockytv-gh-list" aria-busy={loading}>
                    {!data && loading && <div className="fockytv-gh-loading" role="status"><span className="fockytv-jira-skeleton fockytv-jira-skeleton-card" /><span className="fockytv-jira-skeleton fockytv-jira-skeleton-card" />Carregando o projeto…</div>}
                    {tab !== "actions" && visible.map(item => <button type="button" className="fockytv-gh-row" key={item.id} onClick={() => setSelected({ item, kind: tab as "pulls" | "issues" })}><span className="fockytv-gh-item-icon" data-state={itemState(item)}><Mark kind={tab} /></span><span className="fockytv-gh-row-main"><strong>{item.title}</strong><span className="fockytv-gh-row-meta">#{item.number} · {item.user?.login ?? "Conta removida"} · {relativeTime(item.updated_at)}{item.assignees.length > 0 && ` · → ${item.assignees.map(user => user.login).join(", ")}`}</span><span className="fockytv-gh-labels">{item.labels.map(label => <span className="fockytv-gh-label" key={label.name}>{label.name}</span>)}</span></span><State value={itemState(item)} /><span className="fockytv-gh-row-arrow" aria-hidden="true">›</span></button>)}
                    {tab === "actions" && runs.map(run => <button type="button" className="fockytv-gh-row" key={run.id} onClick={() => external(githubUrl(repository, `/actions/runs/${run.id}`))}><span className="fockytv-gh-item-icon"><Mark kind="actions" /></span><span className="fockytv-gh-row-main"><strong>{run.display_title || run.name}</strong><span className="fockytv-gh-row-meta">{run.name} #{run.run_number} · {run.head_branch} · {relativeTime(run.updated_at)}</span></span><State value={runLabel(run)} /><span aria-hidden="true">↗</span></button>)}
                    {data && !error && !(tab === "actions" ? runs : visible).length && <div className="fockytv-gh-empty"><Mark kind={tab} size={32} /><h3>{query || mine || reviewOnly && tab === "pulls" ? "Nenhum resultado com esses filtros" : "Tudo tranquilo por aqui"}</h3><p>{query || mine || reviewOnly && tab === "pulls" ? "Tente outra busca ou remova os filtros. A busca considera os itens carregados." : `Nenhum item em ${tabNames[tab]} para esta seleção.`}</p></div>}
                </div>
                {data?.[tab]?.more && <button type="button" className="fockytv-jira-button-secondary fockytv-gh-more" disabled={loading} onClick={() => setPages(previous => ({ ...previous, [tab]: previous[tab] + 1 }))}>Carregar mais {tabNames[tab]}</button>}
                <footer className="fockytv-gh-footer"><span>Ordenado por atualização · filtros nos itens carregados</span><button type="button" onClick={() => external(githubUrl(repository))}>Ver projeto no GitHub ↗</button></footer>
            </>}
        </div>
    </Modal>;
}
