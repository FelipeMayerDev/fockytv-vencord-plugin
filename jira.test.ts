// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { adfDoc, adfText, categoryOf, daysLeft, groupByColumn, initials, JiraIssue, jiraError, jiraSite, matchesIssue, progressOf, relativeTime, shareText } from "./jira";

const issue = (key: string, status: string, summary = key, assignee?: string) =>
    ({ id: key, key, fields: { summary, status: { id: status, name: `S${status}` }, assignee: assignee ? { accountId: assignee, displayName: assignee.toUpperCase() } : null } }) as JiraIssue;

test("Only Jira Cloud sites receive the token", () => {
    assert.equal(jiraSite(" https://empresa.atlassian.net/jira/software "), "https://empresa.atlassian.net");
    for (const site of ["http://empresa.atlassian.net", "https://atlassian.net.evil.com", "https://user:x@empresa.atlassian.net", "https://empresa.atlassian.net:8443", "nada"])
        assert.throws(() => jiraSite(site), site);
});

test("Issues land in their board column and unknown statuses in Outros", () => {
    const columns = [{ name: "A fazer", statuses: [{ id: "1" }] }, { name: "Feito", statuses: [{ id: "3" }, { id: "4" }] }];
    const groups = groupByColumn(columns, [issue("X-1", "1"), issue("X-2", "4"), issue("X-3", "9")]);
    assert.deepEqual(groups.map(group => [group.name, group.issues.map(i => i.key)]), [["A fazer", ["X-1"]], ["Feito", ["X-2"]], ["Outros", ["X-3"]]]);
    assert.equal(groupByColumn(columns, [issue("X-1", "1")]).length, 2);
});

test("ADF round trip keeps paragraphs, line breaks and mentions", () => {
    const doc = adfDoc("primeira linha\nsegunda\n\nnovo parágrafo");
    assert.equal(adfText(doc), "primeira linha\nsegunda\nnovo parágrafo\n");
    assert.equal(adfText({ type: "doc", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { text: "@Ana" } }, { type: "text", text: " olha isso" }] }] }), "@Ana olha isso\n");
    assert.equal(adfText(null), "");
});

test("Search, mine filter, share text and API errors", () => {
    assert.ok(matchesIssue(issue("ABC-12", "1", "Corrigir login"), "login"));
    assert.ok(matchesIssue(issue("ABC-12", "1"), "abc-1"));
    assert.ok(!matchesIssue(issue("ABC-12", "1", "x", "ana"), "", "bruno"));
    assert.equal(shareText("https://e.atlassian.net", issue("ABC-1", "1", "Login", "ana")), "**ABC-1** Login\nS1 · ANA\n<https://e.atlassian.net/browse/ABC-1>");
    assert.equal(jiraError(401, ""), "E-mail ou API token do Jira inválido.");
    assert.equal(jiraError(400, JSON.stringify({ errorMessages: ["Board não existe."], errors: { jql: "JQL ruim" } })), "Board não existe. JQL ruim");
    assert.equal(jiraError(500, "<html>"), "Jira respondeu HTTP 500.");
});

test("Sprint progress, initials and relative dates", () => {
    const withCategory = (key: string, category: string) => ({ ...issue(key, "1"), fields: { ...issue(key, "1").fields, status: { id: "1", name: "x", statusCategory: { key: category } } } }) as JiraIssue;
    assert.deepEqual(progressOf([withCategory("A", "done"), withCategory("B", "indeterminate"), withCategory("C", "new"), withCategory("D", "done")]), { new: 1, indeterminate: 1, done: 2, total: 4 });
    assert.equal(categoryOf(undefined), "new");
    assert.equal(initials("Felipe Mayer Souza"), "FM");
    assert.equal(initials(""), "?");
    const now = Date.parse("2026-10-19T12:00:00Z");
    assert.equal(relativeTime("2026-10-19T11:59:30Z", now), "agora");
    assert.equal(relativeTime("2026-10-19T09:00:00Z", now), "há 3 horas");
    assert.equal(relativeTime("2026-10-18T12:00:00Z", now), "ontem");
    assert.equal(daysLeft("2026-10-22T12:00:00Z", now), 3);
});
