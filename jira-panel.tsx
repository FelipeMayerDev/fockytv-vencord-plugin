// SPDX-License-Identifier: GPL-3.0-or-later
// Modal do Jira: board escolhido com a sprint ativa (ou o kanban) por coluna, o backlog e o detalhe da tarefa.
import { sendMessage } from "@utils/discord";
import { RenderModalProps } from "@vencord/discord-types";
import { Modal, React, SelectedChannelStore, useEffect, useMemo, useRef, useState } from "@webpack/common";

import { adfDoc, adfText, categoryOf, daysLeft, groupByColumn, initials, issueFields, issueUrl, JiraIssue, JiraUser, matchesIssue, progressOf, relativeTime, shareText, StatusCategory } from "./jira";

export type JiraFetch = <T = any>(path: string, method?: "GET" | "POST", body?: unknown) => Promise<T>;
export interface JiraContext { site: string; request: JiraFetch; board?: number; setBoard(id: number): void; }

type Board = { id: number; name: string; type: string; location?: { projectName?: string; }; };
type Sprint = { id: number; name: string; goal?: string; startDate?: string; endDate?: string; };
type Column = { name: string; statuses: { id: string; }[]; };
type BoardData = { columns: Column[]; sprints: (Sprint & { issues: JiraIssue[]; })[]; issues: JiraIssue[]; backlog: JiraIssue[] | null; };
type Paged<K extends string, T> = Record<K, T[]>;

const openExternal = (url: string) => void VencordNative.native.openExternal(url);
const shortDate = (value?: string) => value ? new Date(value).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }).replace(".", "") : "";
const message = (cause: any) => String(cause?.message ?? cause);
const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

async function loadBoard(request: JiraFetch, board: Board): Promise<BoardData> {
    const fields = `fields=${issueFields}&maxResults=200`;
    const config = await request<{ columnConfig: { columns: Column[]; }; }>(`/rest/agile/1.0/board/${board.id}/configuration`);
    let sprints: Sprint[] = [];
    let issues: JiraIssue[] = [];
    // Scrum e board de time ("simple") podem ter sprint; sem sprint ativa (ou kanban), o board inteiro
    // sem o que foi concluído há mais de 2 semanas, senão as 200 primeiras seriam só tarefas antigas.
    // ponytail: até 200 tarefas por sprint/board/backlog; paginar se algum board passar disso.
    if (board.type !== "kanban")
        sprints = await request<Paged<"values", Sprint>>(`/rest/agile/1.0/board/${board.id}/sprint?state=active`).then(page => page.values, () => []);
    const perSprint = await Promise.all(sprints.map(async sprint => ({ ...sprint, issues: (await request<Paged<"issues", JiraIssue>>(`/rest/agile/1.0/sprint/${sprint.id}/issue?${fields}`)).issues })));
    if (perSprint.length) issues = perSprint.flatMap(sprint => sprint.issues);
    else issues = (await request<Paged<"issues", JiraIssue>>(`/rest/agile/1.0/board/${board.id}/issue?${fields}&jql=${encodeURIComponent("statusCategory != Done OR resolved >= -14d")}`)).issues;
    // Kanban sem backlog ligado responde erro: aí o board só não tem essa seção.
    const backlog = await request<Paged<"issues", JiraIssue>>(`/rest/agile/1.0/board/${board.id}/backlog?${fields}`).then(page => page.issues, () => null);
    return { columns: config.columnConfig.columns, sprints: perSprint, issues, backlog };
}

// ── Peças visuais ──────────────────────────────────────────────────────────

const typeColors: Record<string, string> = { bug: "#e5493a", story: "#63ba3c", "história": "#63ba3c", epic: "#904ee2", "épico": "#904ee2", task: "#4bade8", tarefa: "#4bade8", subtask: "#4bade8", "sub-task": "#4bade8", subtarefa: "#4bade8" };
function TypeChip({ name }: { name?: string; }) {
    if (!name) return null;
    return <span className="fockytv-jira-type" style={{ "--fockytv-jira-type": typeColors[name.toLowerCase()] ?? "#8590a2" } as React.CSSProperties} title={name}>{name}</span>;
}

const priorities: Record<string, { color: string; level: number; }> = {
    highest: { color: "#e5493a", level: 2 }, "mais alta": { color: "#e5493a", level: 2 }, high: { color: "#f18d13", level: 1 }, alta: { color: "#f18d13", level: 1 },
    medium: { color: "#e2b203", level: 0 }, "média": { color: "#e2b203", level: 0 }, low: { color: "#4bce97", level: -1 }, baixa: { color: "#4bce97", level: -1 },
    lowest: { color: "#2abb7f", level: -2 }, "mais baixa": { color: "#2abb7f", level: -2 }
};
function PriorityIcon({ name }: { name?: string; }) {
    const priority = name && priorities[name.toLowerCase()];
    if (!name || !priority) return null;
    const up = priority.level > 0, chevrons = Math.abs(priority.level);
    return <svg className="fockytv-jira-priority" viewBox="0 0 16 16" width="16" height="16" aria-label={`Prioridade ${name}`} role="img" style={{ color: priority.color }}>
        <title>{`Prioridade: ${name}`}</title>
        {chevrons === 0
            ? <><path d="M3 6h10" /><path d="M3 10h10" /></>
            : Array.from({ length: chevrons }, (_, index) => <path key={index} d={up ? `M3 ${10 - index * 4}l5-4 5 4` : `M3 ${6 + index * 4}l5 4 5-4`} />)}
    </svg>;
}

// Cor fixa por pessoa: o Discord bloqueia as fotos do Atlassian, então as iniciais precisam se distinguir.
const hueOf = (name: string) => [...name].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 360, 7);

function Avatar({ user, size = 24 }: { user?: JiraUser | { displayName: string; avatarUrls?: Record<string, string>; } | null; size?: number; }) {
    const [broken, setBroken] = useState(false);
    const src = user?.avatarUrls?.["48x48"];
    const style = { width: size, height: size, fontSize: Math.round(size * 0.4), "--fockytv-jira-hue": hueOf(user?.displayName ?? "") } as React.CSSProperties;
    if (!user) return <span className="fockytv-jira-avatar fockytv-jira-avatar-empty" style={style} title="Sem responsável" aria-label="Sem responsável" />;
    return src && !broken
        ? <img className="fockytv-jira-avatar" style={style} src={src} alt="" title={user.displayName} onError={() => setBroken(true)} />
        : <span className="fockytv-jira-avatar" style={style} title={user.displayName} aria-hidden="true">{initials(user.displayName)}</span>;
}

function StatusPill({ name, category }: { name: string; category: StatusCategory; }) {
    return <span className={`fockytv-jira-status fockytv-jira-cat-${category}`}>{name}</span>;
}

const Icon = ({ path, size = 16 }: { path: string; size?: number; }) =>
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={path} /></svg>;
const icons = {
    search: "M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM21 21l-4.35-4.35",
    refresh: "M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5",
    back: "M15 18l-6-6 6-6",
    external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
    share: "M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13",
    chevron: "M9 6l6 6-6 6",
    user: "M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z"
};

function IconButton({ label, path, onClick, disabled, spinning }: { label: string; path: string; onClick(): void; disabled?: boolean; spinning?: boolean; }) {
    return <button type="button" className={cx("fockytv-jira-icon-button", spinning && "fockytv-jira-spin")} aria-label={label} title={label} disabled={disabled} onClick={onClick}><Icon path={path} /></button>;
}

function IssueCard({ issue, onOpen }: { issue: JiraIssue; onOpen(): void; }) {
    const { summary, issuetype, priority, assignee, status } = issue.fields;
    return <button type="button" className={cx("fockytv-jira-card", categoryOf(status) === "done" && "fockytv-jira-card-done")} onClick={onOpen}>
        <span className="fockytv-jira-summary">{summary}</span>
        <span className="fockytv-jira-card-footer">
            <TypeChip name={issuetype?.name} />
            <span className="fockytv-jira-key">{issue.key}</span>
            <span className="fockytv-jira-spacer" />
            <PriorityIcon name={priority?.name} />
            <Avatar user={assignee} size={22} />
        </span>
    </button>;
}

function IssueRow({ issue, onOpen }: { issue: JiraIssue; onOpen(): void; }) {
    const { summary, issuetype, priority, assignee, status } = issue.fields;
    return <button type="button" className="fockytv-jira-row-item" onClick={onOpen}>
        <TypeChip name={issuetype?.name} />
        <span className="fockytv-jira-key">{issue.key}</span>
        <span className="fockytv-jira-row-summary">{summary}</span>
        <StatusPill name={status.name} category={categoryOf(status)} />
        <PriorityIcon name={priority?.name} />
        <Avatar user={assignee} size={22} />
    </button>;
}

function SprintSummary({ sprints, selected, onSelect, issues }: { sprints: Sprint[]; selected: number | null; onSelect(id: number | null): void; issues: JiraIssue[]; }) {
    const progress = progressOf(issues);
    const percent = (value: number) => progress.total ? `${(value / progress.total) * 100}%` : "0%";
    const current = sprints.find(sprint => sprint.id === selected);
    // Várias sprints em paralelo: vale a que termina primeiro.
    const end = current?.endDate ?? sprints.map(sprint => sprint.endDate).filter(Boolean).sort()[0];
    const start = current?.startDate ?? sprints.map(sprint => sprint.startDate).filter(Boolean).sort()[0];
    const left = end ? daysLeft(end) : undefined;
    return <section className="fockytv-jira-sprint">
        <div className="fockytv-jira-sprint-head">
            <strong>{current?.name ?? (sprints.length === 1 ? sprints[0].name : `${sprints.length} sprints ativas`)}</strong>
            {start && end && <span className="fockytv-jira-muted">{shortDate(start)} – {shortDate(end)}</span>}
            {left !== undefined && <span className={cx("fockytv-jira-badge", left < 0 && "fockytv-jira-badge-late")}>
                {left < 0 ? `${-left} ${-left === 1 ? "dia" : "dias"} atrasada` : left === 0 ? "termina hoje" : `${left} ${left === 1 ? "dia restante" : "dias restantes"}`}
            </span>}
            <span className="fockytv-jira-spacer" />
            <span className="fockytv-jira-muted"><strong className="fockytv-jira-strong">{progress.done}</strong> de {progress.total} concluídas</span>
        </div>
        <div className="fockytv-jira-progress" role="img" aria-label={`${progress.done} concluídas, ${progress.indeterminate} em andamento, ${progress.new} a fazer`}>
            <span className="fockytv-jira-cat-bg-done" style={{ width: percent(progress.done) }} />
            <span className="fockytv-jira-cat-bg-indeterminate" style={{ width: percent(progress.indeterminate) }} />
        </div>
        <div className="fockytv-jira-legend">
            <span><i className="fockytv-jira-dot fockytv-jira-cat-bg-done" />{progress.done} concluídas</span>
            <span><i className="fockytv-jira-dot fockytv-jira-cat-bg-indeterminate" />{progress.indeterminate} em andamento</span>
            <span><i className="fockytv-jira-dot fockytv-jira-cat-bg-new" />{progress.new} a fazer</span>
        </div>
        {sprints.length > 1 && <div className="fockytv-jira-tabs" role="tablist" aria-label="Sprint">
            <button type="button" role="tab" aria-selected={selected === null} className={cx("fockytv-jira-tab", selected === null && "fockytv-jira-tab-on")} onClick={() => onSelect(null)}>Todas</button>
            {sprints.map(sprint => <button key={sprint.id} type="button" role="tab" aria-selected={selected === sprint.id} className={cx("fockytv-jira-tab", selected === sprint.id && "fockytv-jira-tab-on")} onClick={() => onSelect(sprint.id)}>{sprint.name}</button>)}
        </div>}
        {current?.goal && <p className="fockytv-jira-sprint-goal">{current.goal}</p>}
    </section>;
}

function Skeleton() {
    return <div className="fockytv-jira-board" aria-busy="true" aria-label="Carregando board">
        {[3, 2, 4].map((cards, column) => <section key={column} className="fockytv-jira-column">
            <span className="fockytv-jira-skeleton fockytv-jira-skeleton-title" />
            {Array.from({ length: cards }, (_, index) => <span key={index} className="fockytv-jira-skeleton fockytv-jira-skeleton-card" />)}
        </section>)}
    </div>;
}

function Notice({ kind, children, onRetry }: { kind: "error" | "success"; children: React.ReactNode; onRetry?(): void; }) {
    return <div className={`fockytv-jira-notice fockytv-jira-notice-${kind}`} role={kind === "error" ? "alert" : "status"}>
        <span>{children}</span>
        {onRetry && <button type="button" className="fockytv-jira-link" onClick={onRetry}>Tentar de novo</button>}
    </div>;
}

// Atlassian Document Format com a formatação que importa (títulos, listas, negrito, código, links);
// mídia e o que não é texto viram um marcador.
type AdfNode = { type: string; text?: string; attrs?: Record<string, any>; marks?: { type: string; attrs?: Record<string, any>; }[]; content?: AdfNode[]; };
function AdfText({ node }: { node: AdfNode; }) {
    let element: React.ReactNode = node.text;
    for (const mark of node.marks ?? []) {
        if (mark.type === "strong") element = <strong>{element}</strong>;
        else if (mark.type === "em") element = <em>{element}</em>;
        else if (mark.type === "strike") element = <s>{element}</s>;
        else if (mark.type === "code") element = <code className="fockytv-jira-code">{element}</code>;
        else if (mark.type === "link" && /^https?:/.test(mark.attrs?.href ?? "")) {
            const href = mark.attrs!.href;
            element = <a href={href} onClick={event => { event.preventDefault(); openExternal(href); }}>{element}</a>;
        }
    }
    return <>{element}</>;
}
function AdfView({ node }: { node?: AdfNode | null; }): React.ReactElement | null {
    if (!node) return null;
    const children = node.content?.map((child, index) => <AdfView key={index} node={child} />);
    switch (node.type) {
        case "doc": return <div className="fockytv-jira-adf">{children}</div>;
        case "paragraph": return <p>{children}</p>;
        case "heading": return <h4>{children}</h4>;
        case "bulletList": return <ul>{children}</ul>;
        case "orderedList": return <ol>{children}</ol>;
        case "listItem": return <li>{children}</li>;
        case "blockquote": case "panel": return <blockquote>{children}</blockquote>;
        case "codeBlock": return <pre className="fockytv-jira-code">{node.content?.map(child => child.text).join("")}</pre>;
        case "rule": return <hr />;
        case "hardBreak": return <br />;
        case "text": return <AdfText node={node} />;
        case "mention": return <span className="fockytv-jira-mention">{node.attrs?.text ?? "@alguém"}</span>;
        case "emoji": return <>{node.attrs?.text ?? node.attrs?.shortName}</>;
        case "inlineCard": case "blockCard": {
            const url = node.attrs?.url;
            return /^https?:/.test(url ?? "") ? <a href={url} onClick={event => { event.preventDefault(); openExternal(url); }}>{url}</a> : null;
        }
        case "mediaSingle": case "mediaGroup": case "media": return <span className="fockytv-jira-muted">[anexo: abra no Jira]</span>;
        case "table": return <div className="fockytv-jira-table">{children}</div>;
        default: return children ? <>{children}</> : null;
    }
}

// ── Detalhe da tarefa ──────────────────────────────────────────────────────

function IssueDetail({ context, issueKey, onBack, onChanged }: { context: JiraContext; issueKey: string; onBack(): void; onChanged(): void; }) {
    type Detail = JiraIssue & { fields: JiraIssue["fields"] & { description?: any; reporter?: JiraUser | null; created?: string; updated?: string; }; };
    type Comment = { id: string; author?: JiraUser; created: string; body: any; };
    type Transition = { id: string; name: string; to?: { name: string; statusCategory?: { key: string; }; }; };
    const [issue, setIssue] = useState<Detail | null>(null);
    const [comments, setComments] = useState<Comment[]>([]);
    const [transitions, setTransitions] = useState<Transition[]>([]);
    const [comment, setComment] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [version, setVersion] = useState(0);
    const path = `/rest/api/3/issue/${encodeURIComponent(issueKey)}`;

    useEffect(() => {
        let alive = true;
        Promise.all([
            context.request<Detail>(`${path}?fields=${issueFields},description,reporter,created,updated`),
            context.request<Paged<"comments", Comment>>(`${path}/comment?orderBy=-created&maxResults=20`),
            context.request<Paged<"transitions", Transition>>(`${path}/transitions`)
        ]).then(([detail, page, moves]) => {
            if (!alive) return;
            setIssue(detail);
            setComments(page.comments);
            setTransitions(moves.transitions);
        }, cause => alive && setError(message(cause)));
        return () => { alive = false; };
    }, [issueKey, version]);

    useEffect(() => {
        if (!notice) return;
        const timer = setTimeout(() => setNotice(""), 3500);
        return () => clearTimeout(timer);
    }, [notice]);

    const run = async (action: () => Promise<string | void>) => {
        setBusy(true);
        setError("");
        try {
            const done = await action();
            if (done) setNotice(done);
        } catch (cause) { setError(message(cause)); }
        finally { setBusy(false); }
    };
    const share = () => run(async () => {
        const channelId = SelectedChannelStore.getVoiceChannelId() ?? SelectedChannelStore.getChannelId();
        if (!channelId) throw new Error("Abra um canal ou entre numa call para compartilhar.");
        await sendMessage(channelId, { content: shareText(context.site, issue!) });
        return "Enviada no chat.";
    });
    const publish = () => run(async () => {
        await context.request(`${path}/comment`, "POST", { body: adfDoc(comment) });
        setComment("");
        setVersion(value => value + 1);
        return "Comentário publicado.";
    });

    const header = <div className="fockytv-jira-detail-bar">
        <button type="button" className="fockytv-jira-back" onClick={onBack}><Icon path={icons.back} />Board</button>
        {issue && <><TypeChip name={issue.fields.issuetype?.name} /><span className="fockytv-jira-key">{issue.key}</span></>}
        <span className="fockytv-jira-spacer" />
        {issue && <>
            <button type="button" className="fockytv-jira-button-secondary" disabled={busy} onClick={share}><Icon path={icons.share} />Compartilhar no chat</button>
            <IconButton label="Abrir no Jira" path={icons.external} onClick={() => openExternal(issueUrl(context.site, issue.key))} />
        </>}
    </div>;

    if (!issue) return <div className="fockytv-jira-detail">
        {header}
        {error ? <Notice kind="error" onRetry={() => { setError(""); setVersion(value => value + 1); }}>{error}</Notice>
            : <div className="fockytv-jira-detail-grid"><div><span className="fockytv-jira-skeleton fockytv-jira-skeleton-title" /><span className="fockytv-jira-skeleton fockytv-jira-skeleton-block" /></div><span className="fockytv-jira-skeleton fockytv-jira-skeleton-block" /></div>}
    </div>;

    const { summary, status, priority, assignee, reporter, description, created, updated } = issue.fields;
    const text = adfText(description).trim();
    return <div className="fockytv-jira-detail">
        {header}
        {notice && <Notice kind="success">{notice}</Notice>}
        {error && <Notice kind="error">{error}</Notice>}
        <div className="fockytv-jira-detail-grid">
            <div className="fockytv-jira-detail-main">
                <h2 className="fockytv-jira-title">{summary}</h2>
                <section>
                    <h3 className="fockytv-jira-heading">Descrição</h3>
                    {text ? <AdfView node={description} /> : <p className="fockytv-jira-muted">Sem descrição.</p>}
                </section>
                <section className="fockytv-jira-comments">
                    <h3 className="fockytv-jira-heading">Comentários <span className="fockytv-jira-count">{comments.length}</span></h3>
                    <div className="fockytv-jira-composer">
                        <textarea className="fockytv-jira-input" rows={3} aria-label="Novo comentário" placeholder="Adicionar um comentário…" value={comment}
                            onChange={event => setComment(event.currentTarget.value)}
                            onKeyDown={event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && comment.trim() && !busy) { event.preventDefault(); void publish(); } }} />
                        <div className="fockytv-jira-composer-bar">
                            <span className="fockytv-jira-muted">Ctrl+Enter para enviar</span>
                            <button type="button" className="fockytv-jira-button-primary" disabled={busy || !comment.trim()} onClick={publish}>Comentar</button>
                        </div>
                    </div>
                    {comments.map(entry => <article key={entry.id} className="fockytv-jira-comment">
                        <Avatar user={entry.author} size={28} />
                        <div>
                            <div className="fockytv-jira-comment-head"><strong>{entry.author?.displayName ?? "Alguém"}</strong><span className="fockytv-jira-muted" title={new Date(entry.created).toLocaleString("pt-BR")}>{relativeTime(entry.created)}</span></div>
                            <AdfView node={entry.body} />
                        </div>
                    </article>)}
                </section>
            </div>
            <aside className="fockytv-jira-sidebar">
                <section className="fockytv-jira-panel">
                    <h3 className="fockytv-jira-heading">Status</h3>
                    <div className="fockytv-jira-status-row">
                        <StatusPill name={status.name} category={categoryOf(status)} />
                        {transitions.length > 0 && <select className="fockytv-jira-input fockytv-jira-move" aria-label="Mover para" value="" disabled={busy} onChange={event => {
                            const move = transitions.find(entry => entry.id === event.currentTarget.value);
                            if (move) void run(async () => {
                                await context.request(`${path}/transitions`, "POST", { transition: { id: move.id } });
                                setVersion(value => value + 1);
                                onChanged();
                                return `Movida para ${move.to?.name ?? move.name}.`;
                            });
                        }}>
                            <option value="" disabled>{busy ? "Movendo…" : "Mover para…"}</option>
                            {transitions.filter(move => move.to?.name !== status.name).map(move => <option key={move.id} value={move.id}>{move.to?.name ?? move.name}</option>)}
                        </select>}
                    </div>
                </section>
                <section className="fockytv-jira-panel">
                    <h3 className="fockytv-jira-heading">Detalhes</h3>
                    <dl className="fockytv-jira-fields">
                        <dt>Responsável</dt><dd><Avatar user={assignee} size={22} />{assignee?.displayName ?? "Ninguém"}</dd>
                        <dt>Relator</dt><dd><Avatar user={reporter} size={22} />{reporter?.displayName ?? "—"}</dd>
                        {priority && <><dt>Prioridade</dt><dd><PriorityIcon name={priority.name} />{priority.name}</dd></>}
                        {created && <><dt>Criada</dt><dd title={new Date(created).toLocaleString("pt-BR")}>{relativeTime(created)}</dd></>}
                        {updated && <><dt>Atualizada</dt><dd title={new Date(updated).toLocaleString("pt-BR")}>{relativeTime(updated)}</dd></>}
                    </dl>
                </section>
            </aside>
        </div>
    </div>;
}

// ── Board ──────────────────────────────────────────────────────────────────

export function JiraPanel({ context, ...props }: RenderModalProps & { context: JiraContext; }) {
    const [boards, setBoards] = useState<Board[] | null>(null);
    const [boardId, setBoardId] = useState(context.board);
    const [me, setMe] = useState("");
    const [data, setData] = useState<BoardData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [query, setQuery] = useState("");
    const [onlyMine, setOnlyMine] = useState(false);
    const [backlogOpen, setBacklogOpen] = useState(false);
    const [sprintId, setSprintId] = useState<number | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [version, setVersion] = useState(0);
    const scroller = useRef<HTMLDivElement>(null);
    // Board ↔ tarefa: cada tela começa do topo, não onde a outra parou.
    useEffect(() => { scroller.current?.scrollTo({ top: 0 }); }, [selected]);

    useEffect(() => {
        Promise.all([
            context.request<Paged<"values", Board>>("/rest/agile/1.0/board?maxResults=100"),
            context.request<{ accountId: string; }>("/rest/api/3/myself")
        ]).then(([page, myself]) => {
            setBoards(page.values);
            setMe(myself.accountId);
            setBoardId(id => page.values.some(board => board.id === id) ? id : page.values[0]?.id);
        }, cause => setError(message(cause)));
    }, []);

    const board = boards?.find(entry => entry.id === boardId);
    useEffect(() => {
        if (!board) return;
        let alive = true;
        setLoading(true);
        setError("");
        loadBoard(context.request, board).then(next => alive && setData(next), cause => alive && setError(message(cause)))
            .finally(() => alive && setLoading(false));
        return () => { alive = false; };
    }, [board?.id, version]);

    const filter = (issues: JiraIssue[]) => issues.filter(issue => matchesIssue(issue, query, onlyMine ? me : undefined));
    const sprintIssues = useMemo(() => data && (data.sprints.find(sprint => sprint.id === sprintId)?.issues ?? data.issues), [data, sprintId]);
    const columns = useMemo(() => data && sprintIssues && groupByColumn(data.columns, filter(sprintIssues)), [data, sprintIssues, query, onlyMine, me]);
    const backlog = useMemo(() => data?.backlog && filter(data.backlog), [data, query, onlyMine, me]);
    const filtering = !!query.trim() || onlyMine;
    const subtitle = board ? [board.location?.projectName, data?.sprints.length ? "Sprint" : board.type === "kanban" ? "Kanban" : undefined].filter(Boolean).join(" · ") : undefined;

    return <Modal {...props} title={board?.name ?? "Jira"} subtitle={subtitle} size="xxl" scrollerRef={scroller}>
        <div className="fockytv-jira">
            {selected
                ? <IssueDetail context={context} issueKey={selected} onBack={() => setSelected(null)} onChanged={() => setVersion(value => value + 1)} />
                : <>
                    <div className="fockytv-jira-toolbar">
                        <select className="fockytv-jira-input fockytv-jira-select" aria-label="Board" value={boardId ?? ""} disabled={!boards?.length} onChange={event => {
                            const id = Number(event.currentTarget.value);
                            setBoardId(id);
                            setData(null);
                            setSprintId(null);
                            context.setBoard(id);
                        }}>
                            {!boards && <option value="">Carregando boards…</option>}
                            {boards?.map(entry => <option key={entry.id} value={entry.id}>{entry.name}{entry.location?.projectName ? ` · ${entry.location.projectName}` : ""}</option>)}
                        </select>
                        <label className="fockytv-jira-search">
                            <Icon path={icons.search} />
                            <input type="search" aria-label="Buscar tarefas" placeholder="Buscar por chave ou título" value={query} onChange={event => setQuery(event.currentTarget.value)} />
                        </label>
                        <button type="button" className={cx("fockytv-jira-chip", onlyMine && "fockytv-jira-chip-on")} aria-pressed={onlyMine} onClick={() => setOnlyMine(value => !value)}>
                            <Icon path={icons.user} size={14} />Só minhas
                        </button>
                        <span className="fockytv-jira-spacer" />
                        <IconButton label="Atualizar" path={icons.refresh} disabled={loading || !board} spinning={loading} onClick={() => setVersion(value => value + 1)} />
                    </div>
                    {error && <Notice kind="error" onRetry={() => setVersion(value => value + 1)}>{error}</Notice>}
                    {boards?.length === 0 && <p className="fockytv-jira-empty">Nenhum board visível para esta conta.</p>}
                    {data && sprintIssues && data.sprints.length > 0 && <SprintSummary sprints={data.sprints} selected={sprintId} onSelect={setSprintId} issues={sprintIssues} />}
                    {!data && !error && (boards === null || loading) ? <Skeleton /> : columns && <div className={cx("fockytv-jira-board", loading && "fockytv-jira-stale")}>
                        {columns.map((column, index) => {
                            const category = column.issues[0] ? categoryOf(column.issues[0].fields.status) : index === 0 ? "new" : index === columns.length - 1 ? "done" : "indeterminate";
                            return <section key={column.name} className="fockytv-jira-column" aria-label={column.name}>
                                <h3 className="fockytv-jira-column-head">
                                    <span className={`fockytv-jira-dot fockytv-jira-cat-bg-${category}`} />
                                    {column.name}
                                    <span className="fockytv-jira-count">{column.issues.length}</span>
                                </h3>
                                <div className="fockytv-jira-column-body">
                                    {column.issues.map(issue => <IssueCard key={issue.id} issue={issue} onOpen={() => setSelected(issue.key)} />)}
                                    {!column.issues.length && <p className="fockytv-jira-placeholder">{filtering ? "Nada com esse filtro" : "Vazio"}</p>}
                                </div>
                            </section>;
                        })}
                    </div>}
                    {backlog && <section className="fockytv-jira-backlog">
                        <button type="button" className="fockytv-jira-backlog-head" aria-expanded={backlogOpen} onClick={() => setBacklogOpen(value => !value)}>
                            <span className={cx("fockytv-jira-caret", backlogOpen && "fockytv-jira-caret-open")}><Icon path={icons.chevron} size={14} /></span>
                            Backlog <span className="fockytv-jira-count">{backlog.length}</span>
                        </button>
                        {backlogOpen && <div className="fockytv-jira-list">
                            {backlog.map(issue => <IssueRow key={issue.id} issue={issue} onOpen={() => setSelected(issue.key)} />)}
                            {!backlog.length && <p className="fockytv-jira-placeholder">{filtering ? "Nada com esse filtro" : "Backlog vazio"}</p>}
                        </div>}
                    </section>}
                </>}
        </div>
    </Modal>;
}
