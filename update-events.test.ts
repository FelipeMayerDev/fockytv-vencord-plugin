// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { githubNotification, watchPluginUpdates } from "./update-events";
import type { proxySocket } from "./viewer";

function sockets() {
    const instances: Fake[] = [];
    class Fake {
        static OPEN = 1;
        readyState = 0;
        sent: string[] = [];
        onopen: (() => void) | null = null;
        onmessage: ((event: { data: string; }) => void) | null = null;
        onerror: (() => void) | null = null;
        onclose: (() => void) | null = null;
        constructor(readonly url: string) { instances.push(this); }
        open() { this.readyState = 1; this.onopen?.(); }
        message(data: string) { this.onmessage?.({ data }); }
        send(data: string) { this.sent.push(data); }
        close() { this.readyState = 3; this.onclose?.(); }
    }
    return { Socket: Fake as unknown as ReturnType<typeof proxySocket>, instances };
}

test("push hints validate revisions, deduplicate deliveries, check on reconnect and stop cleanly", t => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const { Socket, instances } = sockets();
    let checks = 0;
    const stop = watchPluginUpdates(Socket, "https://tv.example", () => { checks++; });
    assert.equal(instances[0].url, "wss://tv.example/api/fixed/ws/plugin-updates");
    instances[0].open();
    assert.equal(checks, 1, "Reconnect/start recovers pushes missed while offline");
    for (const data of ["bad JSON", "null", '{"type":"pong"}', '{"type":"plugin-update","revision":"../../bad"}', '{"type":"other","revision":"' + "a".repeat(40) + '"}']) instances[0].message(data);
    assert.equal(checks, 1);
    const hint = JSON.stringify({ type: "plugin-update", revision: "a".repeat(40) });
    instances[0].message(hint); instances[0].message(hint);
    assert.equal(checks, 2);
    instances[0].message(JSON.stringify({ type: "plugin-update", revision: "b".repeat(40), installer: "https://evil.example" }));
    assert.equal(checks, 3, "Payload cannot supply code: callback only triggers the trusted check");
    t.mock.timers.tick(25_000);
    assert.deepEqual(instances[0].sent, ['{"type":"ping"}']);
    instances[0].close();
    t.mock.timers.tick(999); assert.equal(instances.length, 1);
    t.mock.timers.tick(1); assert.equal(instances.length, 2);
    instances[1].open(); assert.equal(checks, 4);
    stop();
    instances[1].message(hint);
    t.mock.timers.tick(100_000);
    assert.equal(checks, 4);
    assert.equal(instances.length, 2);
    assert.equal(instances[1].readyState, 3);
});

test("connection failures back off and stopping cancels a scheduled retry", t => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const { Socket, instances } = sockets();
    const stop = watchPluginUpdates(Socket, "http://localhost:8180", () => assert.fail("No open connection"));
    instances[0].onerror?.();
    t.mock.timers.tick(1000); assert.equal(instances.length, 2);
    instances[1].onerror?.();
    t.mock.timers.tick(1999); assert.equal(instances.length, 2);
    t.mock.timers.tick(1); assert.equal(instances.length, 3);
    instances[2].close(); stop();
    t.mock.timers.tick(60_000); assert.equal(instances.length, 3);
});


test("GitHub alerts validate fields, build trusted links and deduplicate across reconnects", t => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
    const { Socket, instances } = sockets();
    const alerts: unknown[] = [];
    let checks = 0;
    const stop = watchPluginUpdates(Socket, "https://tv.example", () => { checks++; }, alert => alerts.push(alert));
    const event = { type: "github-event", kind: "pr-opened", id: 42, title: "Fix CI", delivery: "pr-42" };
    const url = "https://github.com/FelipeMayerDev/fockytv-vencord-plugin/";
    assert.deepEqual(githubNotification(event), { title: "FockyTV: PR aberto", body: "#42 · Fix CI", url: `${url}pull/42` });
    assert.equal(githubNotification({ ...event, kind: "pr-merged" })?.title, "FockyTV: PR mergeado");
    assert.deepEqual(githubNotification({ ...event, kind: "workflow-failed" }), { title: "FockyTV: Actions falhou na main", body: "Fix CI", url: `${url}actions/runs/42` });
    for (const invalid of [null, {}, { ...event, type: "other" }, { ...event, kind: "__proto__" }, { ...event, kind: "other" },
        { ...event, id: "42" }, { ...event, id: -1 }, { ...event, id: 1.5 }, { ...event, id: Number.MAX_SAFE_INTEGER + 1 },
        { ...event, title: " " }, { ...event, title: "x".repeat(301) }, { ...event, delivery: "" }, { ...event, delivery: "x".repeat(129) }]) {
        assert.equal(githubNotification(invalid), undefined);
        instances[0].message(JSON.stringify(invalid));
    }
    instances[0].message(JSON.stringify({ ...event, url: "https://evil.example" }));
    instances[0].message(JSON.stringify(event));
    assert.deepEqual(alerts, [githubNotification(event)]);
    assert.equal(checks, 0, "PR alerts do not trigger an update check");
    instances[0].close(); t.mock.timers.tick(1000);
    instances[1].message(JSON.stringify(event));
    assert.equal(alerts.length, 1);
    instances[1].message(JSON.stringify({ ...event, kind: "pr-merged", delivery: "merge-42" }));
    assert.equal(alerts.length, 2);
    stop();
    instances[1].message(JSON.stringify({ ...event, delivery: "stopped" }));
    assert.equal(alerts.length, 2);
});
