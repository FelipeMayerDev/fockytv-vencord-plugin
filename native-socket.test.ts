// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { socketClose, socketOpen } from "./native-socket";

test("native sockets allow the update subscription but reject unrelated endpoints", () => {
    const previous = globalThis.WebSocket;
    const opened: string[] = [];
    globalThis.WebSocket = class {
        constructor(url: string | URL) { opened.push(String(url)); }
        close() {}
    } as unknown as typeof WebSocket;
    const event = { sender: { id: 42, once() {} } } as any;
    try {
        const path = "wss://tv.example/api/fixed/ws/plugin-updates";
        const id = socketOpen(event, path);
        assert.deepEqual(opened, [path]);
        socketClose(event, id);
        for (const address of ["https://tv.example/api/fixed/ws/plugin-updates", "wss://tv.example/api/fixed/ws/plugin-updates/extra", "wss://tv.example/api/fixed/plugin-updates/webhook", "wss://tv.example/arbitrary"])
            assert.throws(() => socketOpen(event, address), /WebSocket FockyTV inválido/);
        assert.equal(opened.length, 1);
    } finally { globalThis.WebSocket = previous; }
});


test("native sockets allow jam and reject jam subpaths", () => {
    const previous = globalThis.WebSocket;
    globalThis.WebSocket = class { close() {} } as unknown as typeof WebSocket;
    const event = { sender: { id: 43, once() {} } } as any;
    try {
        const id = socketOpen(event, "wss://tv.example/api/fixed/ws/jam?room=watch%3A123456&watch=1");
        socketClose(event, id);
        assert.throws(() => socketOpen(event, "wss://tv.example/api/fixed/ws/jam/extra"), /WebSocket FockyTV inválido/);
    } finally { globalThis.WebSocket = previous; }
});
