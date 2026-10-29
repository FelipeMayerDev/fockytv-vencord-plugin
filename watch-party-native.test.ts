// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transformSync } from "esbuild";
import { serverUrl } from "./protocol";

const source = readFileSync(new URL("./native.ts", import.meta.url), "utf8");
const code = source.slice(source.indexOf("export async function musicFetch("), source.indexOf("// HMONITOR"));
const create = new Function("fetch", "serverUrl", "Buffer", transformSync(code.replace("export ", ""), { loader: "ts" }).code + "\nreturn musicFetch;");

test("transporte nativo mantém allowlist sem rota de vídeo", async () => {
    const requests: any[] = [];
    const meta = JSON.stringify({ title: "B", duration: 100, url: "https://rr1.example.googlevideo.com/videoplayback?x=1" });
    const fetch = async (url: URL, options: any) => {
        requests.push({ url, options });
        return { status: 200, headers: new Headers({ "Content-Type": "application/json" }), arrayBuffer: async () => new TextEncoder().encode(meta).buffer as ArrayBuffer };
    };
    const musicFetch = create(fetch, serverUrl, Buffer);
    const response = await musicFetch({}, "https://tv.example/api/fixed/jam/yt?id=aaaaaaaaaaa&video=1");
    assert.equal(response.type, "application/json");
    assert.equal(new TextDecoder().decode(response.body), meta);
    assert.equal(requests[0].options.redirect, "error");
    // O vídeo não passa pelo transporte nativo: o <video> toca a stream direto.
    for (const path of ["/api/fixed/jam/yt/video", "/api/fixed/jam/yt/video/extra", "/api/fixed/jam/yt/stream", "/api/fixed/jam", "/other"])
        await assert.rejects(musicFetch({}, "https://tv.example" + path), /inválida/);
    await assert.rejects(musicFetch({}, "https://user:pass@tv.example/api/fixed/jam/yt"), /inválida/);
    assert.equal(requests.length, 1, "rotas rejeitadas não chegam ao fetch");
});

test("falha de rede propaga sem resposta parcial", async () => {
    const musicFetch = create(async () => { throw new Error("offline"); }, serverUrl, Buffer);
    await assert.rejects(musicFetch({}, "https://tv.example/api/fixed/jam/yt?id=aaaaaaaaaaa&video=1"), /offline/);
});
