import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { serverUrl, streamKey } from "./protocol";
import { NativeShare, Session } from "./session";

const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
const native = readFileSync(new URL("./native.ts", import.meta.url), "utf8");

test("both publishing paths can send the authenticated JSON announcement through the native allowlist", async () => {
    const sent: any[] = [];
    const request = new Function("fetch", "serverUrl", "streamKey", stripTypeScriptTypes(
        native.slice(native.indexOf("export async function request("), native.indexOf("// Jira Cloud pelo processo nativo:"))
    ).replace("export ", "") + "return request;")(
        async (url: URL, options: any) => { sent.push({ url, ...options }); return { status: 204, headers: new Headers(), text: async () => "" }; }, serverUrl, streamKey);
    const location = "https://tv.example/api/livekit/whip/session-id";
    const body = JSON.stringify({ channel: "111111111111111111", title: "Live de Ana", thumbnail: "/9j/" });
    const transport = (url: string, method: string, key: string, body: string) => request({}, url, method, key, body);
    assert.equal(await Session.prototype.announce.call({ location, key: "ana", request: transport }, body), 204);
    const announceNativeShare = new Function("shares", stripTypeScriptTypes(
        native.slice(native.indexOf("export async function announceNativeShare("), native.indexOf("// Replays das lives assistidas:"))
    ).replace("export ", "") + "return announceNativeShare;")(new Map([[1, {
        id: "capture-id", notify: (body: string) => transport(`${location}/announce`, "POST", "ana", body)
    }]]));
    assert.equal(await NativeShare.prototype.announce.call({ native: {
        announceNativeShare: (id: string, body: string) => announceNativeShare({ sender: { id: 1 } }, id, body)
    }, id: "capture-id" }, body), 204);
    for (const sentRequest of sent) {
        assert.equal(sentRequest.url.href, `${location}/announce`);
        assert.equal(sentRequest.headers["Content-Type"], "application/json");
        assert.equal(sentRequest.headers.Authorization, "Bearer ana");
        assert.equal(sentRequest.body, body);
        assert.equal(sentRequest.redirect, "error");
    }
    for (const [path, method, payload] of [
        ["/api/livekit/whip/session-id/announce", "GET", body],
        ["/api/livekit/whip/session-id/announce", "POST", "x".repeat(600 * 1024 + 1)],
        ["/api/livekit/whip/session-id/announce/extra", "POST", body],
        ["/api/unrelated", "POST", body]
    ]) await assert.rejects(request({}, "https://tv.example" + path, method, "ana", payload), /inválida/);
    assert.equal(sent.length, 2, "Rejected requests never reach the network");
    assert.equal(await NativeShare.prototype.thumbnail.call({ id: "capture-id", native: {
        nativeShareThumbnail: async (id: string) => { assert.equal(id, "capture-id"); return "real-capture"; }
    } }), "real-capture");
});

function announcement(session: any, thumbnail: () => Promise<string>) {
    const share = { guildId: "guild", channelId: "voice" };
    const publishers = new Map([["screen", session]]);
    const delays: number[] = [];
    const announceLive = new Function("publishers", "discordShare", "NativeShare", "thumbnail", "setTimeout", `
        const settings = { store: { liveTitle: '' } }, UserStore = { getCurrentUser: () => ({ globalName: 'Ana' }) };
        const liveActivity = { kind: 'game', name: 'Jogo' }, nickname = () => 'ana';
        ${stripTypeScriptTypes(source.slice(source.indexOf("async function announceLive("), source.indexOf("function commitDiscordQuality(")))}
        return announceLive;
    `)(publishers, share, NativeShare, thumbnail, (resolve: () => void, ms: number) => { delays.push(ms); resolve(); });
    return { run: () => announceLive(share), delays, publishers, share };
}

test("screen announcement includes the real thumbnail and stops after one success", async () => {
    const posts: any[] = [];
    const session = { capture: {}, announce: async (body: string) => { posts.push(JSON.parse(body)); return 204; } };
    const live = announcement(session, async () => "data:image/jpeg;base64,real-image");
    await live.run();
    assert.deepEqual(posts, [{ channel: "voice", title: "Live de Ana", detail: "🎮 Jogo", thumbnail: "real-image" }]);
    assert.deepEqual(live.delays, [4000]);
    live.share.guildId = "";
    await live.run();
    assert.equal(posts.length, 1, "Private calls have no server bot announcement");
});

test("GPU announcement waits for the encoder image and retries failed delivery", async () => {
    let images = 0, posts = 0;
    const session = Object.assign(Object.create(NativeShare.prototype), {
        capture: {}, thumbnail: async () => ++images === 1 ? null : "data:image/jpeg;base64,gpu-image",
        announce: async (body: string) => { assert.equal(JSON.parse(body).thumbnail, "gpu-image"); return ++posts === 1 ? 502 : 204; }
    });
    const live = announcement(session, async () => { throw new Error("Do not capture the GPU placeholder canvas"); });
    await live.run();
    assert.equal(images, 3);
    assert.equal(posts, 2);
    assert.deepEqual(live.delays, [4000, 2000, 2000]);
});

test("ended or replaced streams are not announced; image failures have bounded retries", async () => {
    let posts = 0, attempts = 0;
    const session = { capture: {}, announce: async () => { posts++; return 204; } };
    const live = announcement(session, async () => { live.publishers.clear(); return "image"; });
    await live.run();
    assert.equal(posts, 0);
    const failed = announcement(session, async () => { attempts++; throw new Error("No image"); });
    await assert.rejects(failed.run(), /No image/);
    assert.equal(attempts, 3);
    assert.equal(posts, 0);
});
