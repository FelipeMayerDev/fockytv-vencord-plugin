// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transformSync } from "esbuild";
import { serverUrl } from "./protocol";

const source = readFileSync(new URL("./native.ts", import.meta.url), "utf8");
const code = source.slice(source.indexOf("export async function musicFetch("), source.indexOf("// HMONITOR"));
const create = new Function("fetch", "serverUrl", "Buffer", transformSync(code.replace("export ", ""), { loader: "ts" }).code + "\nreturn musicFetch;");

test("transporte nativo do jam mantém allowlist e lê vídeo em bytes", async () => {
    const requests: any[] = [];
    let cancelled = false;
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3])];
    const fetch = async (url: URL, options: any) => {
        requests.push({ url, options });
        return { status: 200, headers: new Headers({ "Content-Type": "video/mp4" }), body: { getReader: () => ({
            async read() { const value = chunks.shift(); return { done: !value, value }; },
            async cancel() { cancelled = true; }
        }) } };
    };
    const musicFetch = create(fetch, serverUrl, Buffer);
    const response = await musicFetch({}, "https://tv.example/api/fixed/jam/yt/video?id=aaaaaaaaaaa");
    assert.equal(response.type, "video/mp4");
    assert.deepEqual([...response.body], [1, 2, 3]);
    assert.ok(cancelled);
    assert.equal(requests[0].options.redirect, "error");
    for (const path of ["/api/fixed/jam/yt/video/extra", "/api/fixed/jam/yt/stream", "/api/fixed/jam", "/other"])
        await assert.rejects(musicFetch({}, "https://tv.example" + path), /inválida/);
    await assert.rejects(musicFetch({}, "https://user:pass@tv.example/api/fixed/jam/yt"), /inválida/);
    assert.equal(requests.length, 1, "rotas rejeitadas não chegam ao fetch");
});

test("vídeo grande e falha de rede encerram leitura sem devolver blob parcial", async () => {
    for (const fail of [false, true]) {
        let cancelled = false;
        const musicFetch = create(async () => ({ status: 200, headers: new Headers(), body: { getReader: () => ({
            async read() { if (fail) throw new Error("offline"); return { done: false, value: { byteLength: 512 * 1024 * 1024 + 1 } }; },
            async cancel() { cancelled = true; }
        }) } }), serverUrl, Buffer);
        await assert.rejects(musicFetch({}, "https://tv.example/api/fixed/jam/yt/video"), fail ? /offline/ : /512 MiB/);
        assert.ok(cancelled);
    }
});
