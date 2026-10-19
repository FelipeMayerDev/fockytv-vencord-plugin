// SPDX-License-Identifier: GPL-3.0-or-later
// Integração com o Jira Cloud: o que não depende do Discord (testado em jira.test.ts).
export interface JiraIssue {
    id: string;
    key: string;
    fields: {
        summary: string;
        status: { id: string; name: string; statusCategory?: { key: string; }; };
        assignee?: JiraUser | null;
        issuetype?: { name: string; } | null;
        priority?: { name: string; } | null;
    };
}

export interface JiraUser { accountId: string; displayName: string; avatarUrls?: Record<string, string>; }
export type StatusCategory = "new" | "indeterminate" | "done";

export const issueFields = "summary,status,assignee,issuetype,priority";

// Só Jira Cloud: o token vai junto em cada requisição, então nada fora de *.atlassian.net.
export function jiraSite(value: string) {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || !/^[a-z0-9-]+\.atlassian\.net$/i.test(url.hostname) || url.username || url.password || url.port)
        throw new Error("Use o endereço do Jira Cloud, como https://empresa.atlassian.net.");
    return url.origin;
}

export function jiraError(status: number, body: string) {
    if (status === 401) return "E-mail ou API token do Jira inválido.";
    if (status === 403) return "Sem permissão no Jira para isso.";
    try {
        const { errorMessages, errors } = JSON.parse(body) as { errorMessages?: string[]; errors?: Record<string, string>; };
        const messages = [...errorMessages ?? [], ...Object.values(errors ?? {})];
        if (messages.length) return messages.join(" ");
    } catch { /* corpo sem JSON */ }
    return `Jira respondeu HTTP ${status}.`;
}

// Colunas do board com as tarefas de cada uma; status que não está em coluna nenhuma vai para "Outros".
export function groupByColumn(columns: { name: string; statuses: { id: string; }[]; }[], issues: JiraIssue[]) {
    const groups = columns.map(column => ({ name: column.name, ids: new Set(column.statuses.map(status => status.id)), issues: [] as JiraIssue[] }));
    const others: JiraIssue[] = [];
    for (const issue of issues) (groups.find(group => group.ids.has(issue.fields.status.id))?.issues ?? others).push(issue);
    return [...groups.map(({ name, issues }) => ({ name, issues })), ...others.length ? [{ name: "Outros", issues: others }] : []];
}

// Atlassian Document Format → texto: parágrafos e itens em linhas, menções e emojis pelo texto.
type AdfNode = { type?: string; text?: string; attrs?: { text?: string; shortName?: string; url?: string; }; content?: AdfNode[]; };
export function adfText(node: AdfNode | null | undefined): string {
    if (!node) return "";
    if (node.type === "text") return node.text ?? "";
    if (node.type === "hardBreak") return "\n";
    if (node.type === "mention" || node.type === "emoji") return node.attrs?.text ?? node.attrs?.shortName ?? "";
    if (node.type === "inlineCard") return node.attrs?.url ?? "";
    const inner = (node.content ?? []).map(adfText).join("");
    return ["paragraph", "heading", "listItem", "codeBlock", "blockquote", "rule"].includes(node.type ?? "") ? `${inner}\n` : inner;
}

export function adfDoc(text: string) {
    return {
        type: "doc",
        version: 1,
        content: text.trim().split(/\n{2,}/).map(paragraph => ({
            type: "paragraph",
            content: paragraph.split("\n").flatMap((line, index) => [...index ? [{ type: "hardBreak" }] : [], ...line ? [{ type: "text", text: line }] : []])
        }))
    };
}

export const issueUrl = (site: string, key: string) => `${jiraSite(site)}/browse/${encodeURIComponent(key)}`;

export function shareText(site: string, issue: JiraIssue) {
    const { summary, status, assignee } = issue.fields;
    return `**${issue.key}** ${summary}\n${status.name} · ${assignee?.displayName ?? "Sem responsável"}\n<${issueUrl(site, issue.key)}>`;
}

export function matchesIssue(issue: JiraIssue, query: string, onlyAccount?: string) {
    if (onlyAccount && issue.fields.assignee?.accountId !== onlyAccount) return false;
    const text = query.trim().toLowerCase();
    return !text || issue.key.toLowerCase().includes(text) || issue.fields.summary.toLowerCase().includes(text);
}

export const categoryOf = (status?: { statusCategory?: { key: string; }; }): StatusCategory =>
    status?.statusCategory?.key === "done" ? "done" : status?.statusCategory?.key === "indeterminate" ? "indeterminate" : "new";

// Quanto da sprint já andou, pelas categorias de status do Jira (a fazer / em andamento / concluído).
export function progressOf(issues: JiraIssue[]) {
    const count = { new: 0, indeterminate: 0, done: 0 };
    for (const issue of issues) count[categoryOf(issue.fields.status)]++;
    return { ...count, total: issues.length };
}

export const initials = (name = "?") => name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase() || "?";

export function relativeTime(value: string | number, now = Date.now()) {
    const seconds = Math.round((new Date(value).getTime() - now) / 1000);
    const units: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
    const format = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
    for (const [unit, size] of units) if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
    return "agora";
}

// Dias até o fim da sprint, contando o dia de hoje como 0.
export const daysLeft = (end: string, now = Date.now()) => Math.ceil((new Date(end).getTime() - now) / 86400000);
