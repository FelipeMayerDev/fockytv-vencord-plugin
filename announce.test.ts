import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");

function announcement(session: any, thumbnail: () => Promise<string>) {
    const share = { guildId: "guild", channelId: "voice" };
    const publishers = new Map([["screen", session]]);
    const delays: number[] = [];
    const announceLive = new Function("publishers", "discordShare", "thumbnail", "setTimeout", `
        const settings = { store: { liveTitle: '' } }, UserStore = { getCurrentUser: () => ({ globalName: 'Ana' }) };
        const liveActivity = { kind: 'game', name: 'Jogo' }, nickname = () => 'ana';
        ${stripTypeScriptTypes(source.slice(source.indexOf("async function announceLive("), source.indexOf("function commitDiscordQuality(")))}
        return announceLive;
    `)(publishers, share, thumbnail, (resolve: () => void, ms: number) => { delays.push(ms); resolve(); });
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
