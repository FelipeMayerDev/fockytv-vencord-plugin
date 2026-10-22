// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { watchParty, watchPosition, youtubeId } from "./watch-party";

test("links do YouTube e posição usam apenas hosts válidos e tempo decorrido", () => {
    for (const link of ["aaaaaaaaaaa", "https://youtu.be/aaaaaaaaaaa?t=3", "https://www.youtube.com/watch?v=aaaaaaaaaaa", "https://youtube.com/shorts/aaaaaaaaaaa", "https://m.youtube.com/live/aaaaaaaaaaa"])
        assert.equal(youtubeId(link), "aaaaaaaaaaa");
    for (const link of ["https://evil.test/watch?v=aaaaaaaaaaa", "https://youtube.com.evil.test/watch?v=aaaaaaaaaaa", "https://youtu.be/short", "javascript:aaaaaaaaaaa", "nope"])
        assert.equal(youtubeId(link), null);
    const state = { type: "yt", action: "state", videoId: "aaaaaaaaaaa", playing: true, pos: 20 } as const;
    assert.equal(watchPosition(state, 2500), 22.5);
    assert.equal(watchPosition({ ...state, playing: false }, 2500), 20);
    assert.equal(watchPosition(null, 1000), 0);
});

test("jam aplica snapshot tardio, controles, troca durante download e limpeza", async context => {
    let clock = 1000;
    context.mock.method(performance, "now", () => clock);
    context.mock.timers.enable({ apis: ["setInterval"] });
    const sockets: any[] = [];
    const sent: any[] = [];
    class Socket {
        readyState = 1;
        onopen?: () => void;
        onmessage?: (event: any) => void;
        onclose?: () => void;
        constructor(public url: string) { sockets.push(this); }
        send(text: string) { sent.push(JSON.parse(text)); }
        close() { this.onclose?.(); }
    }
    const media: any = {
        readyState: 1, duration: 100, currentTime: 0, paused: true, ended: false, src: "",
        pause() { this.paused = true; }, load() {}, removeAttribute() { this.src = ""; },
        async play() { this.paused = false; }
    };
    let failNext = false;
    let resolveFirst!: (response: any) => void;
    const fetch = async (url: string) => {
        if (url.includes("/video?") && failNext) { failNext = false; throw new Error("temporary failure"); }
        if (url.includes("id=aaaaaaaaaaa")) return new Promise<any>(resolve => { resolveFirst = resolve; });
        const data = url.includes("/video?") ? "video" : JSON.stringify({ title: "B" });
        return { status: 200, type: "video/mp4", body: new TextEncoder().encode(data) };
    };
    const player = watchParty({ base: () => "https://tv.example", fetch, Socket: Socket as any });
    const message = (videoId: string, playing = true, pos = 30) => sockets.at(-1).onmessage({ data: JSON.stringify({ type: "yt", action: "state", videoId, playing, pos }) });
    const flush = async () => { await new Promise(resolve => setImmediate(resolve)); };
    try {
        player.connect("123456", { id: "111111", name: "Ana" });
        assert.match(sockets[0].url, /watch%3A123456/);
        sockets[0].onopen();
        player.attach(media);
        message("bbbbbbbbbbb");
        await flush();
        assert.equal(media.src, "", "entrar na call não começa a assistir");
        player.listen(true);
        assert.deepEqual(sent.at(-1), { type: "yt", action: "listen", on: true });
        message("aaaaaaaaaaa");
        message("bbbbbbbbbbb", false, 40);
        await flush();
        media.onloadedmetadata();
        assert.equal(media.currentTime, 40, "snapshot pausado ajusta a posição");
        assert.ok(media.paused);
        const secondSrc = media.src;
        assert.equal(player.snapshot().title, "B");
        assert.equal(player.duration(), 100);
        resolveFirst({ status: 200, body: new TextEncoder().encode("old video") });
        await flush();
        assert.equal(media.src, secondSrc, "download anterior não sobrescreve vídeo novo");
        message("bbbbbbbbbbb", true, 50);
        assert.ok(media.currentTime >= 50 && media.currentTime < 51);
        assert.equal(media.paused, false);
        player.control(false, 60);
        assert.deepEqual(sent.at(-1), { type: "yt", action: "state", videoId: "bbbbbbbbbbb", playing: false, pos: 60 });
        player.load("ccccccccccc");
        assert.equal(sent.at(-1).action, "load");
        sockets[0].onmessage({ data: "null" });
        sockets[0].onmessage({ data: "malformed" });
        assert.equal(player.snapshot().state?.videoId, "bbbbbbbbbbb");
        player.setVolume(0.8, 0.5);
        assert.equal(media.volume, 0.4);
        assert.equal(player.snapshot().volume, 0.8);
        sockets[0].onmessage({ data: JSON.stringify({ type: "yt", action: "members", viewers: ["111111", "222222"] }) });
        assert.deepEqual(player.snapshot().viewers, ["111111", "222222"]);
        sockets[0].onmessage({ data: JSON.stringify({ type: "yt", action: "members", viewers: [null] }) });
        assert.deepEqual(player.snapshot().viewers, ["111111", "222222"], "presença inválida é ignorada");
        sockets[0].onmessage({ data: JSON.stringify({ type: "yt", action: "state", uid: "track-1", queue: [{ uid: "track-1", id: "bbbbbbbbbbb", title: "B" }], videoId: "bbbbbbbbbbb", playing: true, pos: 50 }) });
        media.onended();
        assert.deepEqual(sent.at(-1), { type: "yt", action: "next", uid: "track-1" });
        player.add("ccccccccccc", "C");
        assert.deepEqual(sent.at(-1), { type: "yt", action: "add", videoId: "ccccccccccc", title: "C" });
        player.listen(false);
        assert.equal(media.src, "");
        assert.equal(media.paused, true);
        assert.equal(player.snapshot().watching, false);
        message("bbbbbbbbbbb", true, 55);
        await flush();
        assert.equal(media.src, "", "sair continua recebendo o estado sem baixar ou tocar vídeo");
        player.listen(true);
        await flush();
        media.onloadedmetadata();
        assert.ok(media.currentTime >= 55, "reentrar sincroniza automaticamente");
        failNext = true;
        media.onerror();
        clock += 6000;
        context.mock.timers.tick(1000);
        await flush();
        assert.match(player.snapshot().error, /temporary failure/);
        clock += 6000;
        context.mock.timers.tick(1000);
        await flush();
        media.onloadedmetadata();
        assert.equal(player.snapshot().error, "");
        assert.ok(media.src, "download com falha é repetido automaticamente");
        sockets[0].onclose();
        assert.equal(media.paused, true, "desconectado não segue tocando sem sincronismo");
        player.connect("654321", { id: "111111", name: "Ana" });
        assert.equal(player.snapshot().state, null);
        assert.equal(media.src, "");
        assert.match(sockets[1].url, /watch%3A654321/);
    } finally { player.connect(); player.attach(); }
});
