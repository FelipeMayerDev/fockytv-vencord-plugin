// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { watchPluginUpdates } from "./update-events";
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
