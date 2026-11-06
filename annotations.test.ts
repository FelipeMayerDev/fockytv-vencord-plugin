// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";

import { annotationBoard, annotationColors, drawAnnotations, drawAnnotationsSource, LASER_TTL } from "./annotations";
import { watchParty } from "./watch-party";

test("caneta: eco local imediato e pontos enviados em lotes", context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const sent: any[] = [];
    const board = annotationBoard("222222", "111111", message => sent.push(message));
    board.setAnnotating(true);
    assert.equal(board.snapshot().annotating, true);
    board.begin(0.1, 0.2);
    const begin = sent.at(-1);
    assert.equal(begin.type, "draw");
    assert.equal(begin.target, "222222");
    assert.equal(begin.action, "begin");
    assert.equal(begin.color, 0);
    assert.equal(begin.id, board.snapshot().strokes[0].id);
    board.extend(0.3, 0.4);
    board.extend(0.5, 0.6);
    assert.equal(sent.filter(message => message.action === "points").length, 0); // nada sai antes do lote
    context.mock.timers.tick(100);
    assert.deepEqual(sent.find(message => message.action === "points"),
        { type: "draw", target: "222222", action: "points", id: begin.id, pts: [0.3, 0.4, 0.5, 0.6] });
    board.extend(0.7, 0.8);
    board.finish(); // flush pendente sai junto com o fim do traço
    assert.deepEqual(sent.filter(message => message.action === "points").at(-1),
        { type: "draw", target: "222222", action: "points", id: begin.id, pts: [0.7, 0.8] });
    assert.deepEqual(sent.at(-1), { type: "draw", target: "222222", action: "end", id: begin.id });
    assert.equal(board.snapshot().strokes.length, 1);
    assert.deepEqual(board.snapshot().strokes[0].pts, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    // Coordenadas são presas em 0..1 e arredondadas para 2 casas.
    board.begin(1.5, -2);
    assert.deepEqual(board.snapshot().strokes[1].pts, [1, 0]);
});

test("sala: traço dos outros, undo próprio, clear por papel e allow só do dono", () => {
    const board = annotationBoard("222222", "111111", () => { });
    board.apply({ type: "draw", target: "222222", action: "begin", id: "s1", color: 2, from: "999999" });
    board.apply({ type: "draw", target: "222222", action: "points", id: "s1", pts: [0, 0, 1, 1], from: "999999" });
    board.apply({ type: "draw", target: "222222", action: "end", id: "s1", from: "999999" });
    assert.equal(board.snapshot().strokes.length, 1);
    // Lixo é ignorado: cor inválida, ponto ímpar, outra live, sem remetente, tipo estranho.
    board.apply({ type: "draw", target: "222222", action: "begin", id: "bad", color: 9, from: "999999" });
    board.apply({ type: "draw", target: "222222", action: "points", id: "s1", pts: [0.5], from: "999999" });
    board.apply({ type: "draw", target: "outra-live", action: "begin", id: "x", color: 0, from: "999999" });
    board.apply({ type: "draw", target: "222222", action: "begin", id: "nofrom", color: 0 });
    board.apply({ type: "yt", action: "state", videoId: "aaaaaaaaaaa", playing: true, pos: 0, from: "999999" });
    assert.equal(board.snapshot().strokes.length, 1);
    // Undo do espectador não apaga o traço de outro.
    board.setAnnotating(true);
    board.begin(0, 0);
    assert.equal(board.snapshot().strokes.length, 2);
    board.apply({ type: "draw", target: "222222", action: "undo", from: "999999" });
    assert.equal(board.snapshot().strokes.length, 1);
    assert.equal(board.snapshot().strokes[0].from, "111111");
    // Clear de espectador apaga só os traços dele; clear do dono apaga tudo.
    board.apply({ type: "draw", target: "222222", action: "begin", id: "s2", color: 1, from: "999999" });
    board.apply({ type: "draw", target: "222222", action: "clear", from: "999999" });
    assert.equal(board.snapshot().strokes.length, 1);
    assert.equal(board.snapshot().strokes[0].from, "111111");
    board.apply({ type: "draw", target: "222222", action: "clear", from: "222222" });
    assert.equal(board.snapshot().strokes.length, 0);
    // Allow só vale vindo do dono da live.
    board.apply({ type: "draw", target: "222222", action: "allow", on: false, from: "999999" });
    assert.equal(board.snapshot().allowed, true);
    board.apply({ type: "draw", target: "222222", action: "allow", on: false, from: "222222" });
    assert.equal(board.snapshot().allowed, false);
});

test("toggle do dono: espectador trava, dono segue livre; allow é enviado", () => {
    const sent: any[] = [];
    const viewer = annotationBoard("222222", "333333", message => sent.push(message));
    viewer.apply({ type: "draw", target: "222222", action: "allow", on: false, from: "222222" });
    viewer.setAnnotating(true);
    assert.equal(viewer.snapshot().annotating, false);
    viewer.begin(0.5, 0.5); // bloqueado: nada sai
    assert.equal(sent.length, 0);
    const owner = annotationBoard("222222", "222222", () => { });
    owner.apply({ type: "draw", target: "222222", action: "allow", on: false, from: "222222" });
    owner.setAnnotating(true);
    assert.equal(owner.snapshot().annotating, true); // dono sempre pode
    const ownerSent: any[] = [];
    const ownerBoard = annotationBoard("222222", "222222", message => ownerSent.push(message));
    ownerBoard.apply({ type: "draw", target: "222222", action: "allow", on: false, from: "222222" });
    ownerBoard.allow(true); // muda o toggle: envia (allow redundante não sai)
    assert.deepEqual(ownerSent, [{ type: "draw", target: "222222", action: "allow", on: true }]);
    const viewerBoard = annotationBoard("222222", "333333", message => sent.push(message));
    viewerBoard.allow(false); // espectador não controla o toggle
    assert.equal(sent.filter(message => message.action === "allow").length, 0);
});

test("laser: rastro efêmero com throttle, fora dos traços; sync substitui tudo", () => {
    const sent: any[] = [];
    const board = annotationBoard("222222", "111111", message => sent.push(message));
    board.setAnnotating(true);
    board.laser(0.5, 0.5);
    board.laser(0.51, 0.51); // segunda chamada imediata cai no throttle
    assert.deepEqual(sent, [{ type: "draw", target: "222222", action: "laser", pts: [0.5, 0.5] }]);
    assert.equal(board.snapshot().strokes.length, 0);
    assert.equal(board.snapshot().lasers.length, 1);
    board.apply({ type: "draw", target: "222222", action: "sync", targets: [{ target: "222222", allowed: false }] });
    assert.equal(board.snapshot().allowed, false);
    // Traços são efêmeros: mesmo um servidor antigo mandando desenhos no sync, o cliente ignora.
    board.apply({ type: "draw", target: "222222", action: "sync", targets: [
        { target: "222222", allowed: true, strokes: [{ id: "a", from: "999999", color: 1, pts: [0, 0, 0.5, 0.5] }] }
    ] });
    assert.equal(board.snapshot().allowed, true);
    assert.equal(board.snapshot().strokes.length, 0);
    board.resync();
    assert.deepEqual(sent.at(-1), { type: "draw", target: "222222", action: "resync" });
});

test("watch-party roteia draw: onDraw recebe do socket e sendDraw só sai conectado", () => {
    const sockets: any[] = [];
    class Socket {
        readyState = 1;
        onopen?: () => void;
        onmessage?: (event: any) => void;
        onclose?: () => void;
        sent: any[] = [];
        constructor(public url: string) { sockets.push(this); }
        send(text: string) { this.sent.push(JSON.parse(text)); }
        close() { this.onclose?.(); }
    }
    const player = watchParty({ base: () => "https://tv.example", fetch: async () => { throw new Error("não deveria baixar vídeo"); }, Socket: Socket as any });
    const received: any[] = [];
    player.onDraw(message => received.push(message));
    player.connect("123456", { id: "111111", name: "Ana" });
    const socket = sockets.at(-1);
    socket.onopen?.();
    socket.onmessage?.({ data: JSON.stringify({ type: "draw", target: "222222", action: "laser", pts: [1, 2], from: "999999" }) });
    socket.onmessage?.({ data: JSON.stringify({ type: "yt", action: "members", viewers: ["111111"] }) });
    assert.deepEqual(received, [{ type: "draw", target: "222222", action: "laser", pts: [1, 2], from: "999999" }]);
    player.sendDraw({ type: "draw", target: "222222", action: "resync" });
    assert.deepEqual(socket.sent.filter(message => message.type === "draw").at(-1), { type: "draw", target: "222222", action: "resync" });
    // Sem conexão, sendDraw não lança e não envia (o handshake do onopen manda um listen, por isso o filtro).
    socket.onclose?.();
    player.sendDraw({ type: "draw", target: "222222", action: "resync" });
    assert.equal(socket.sent.filter(message => message.type === "draw").length, 1);
});

test("drawAnnotations roda pelo próprio texto, como no overlay do apresentador", () => {
    const draw = new Function(`return ${drawAnnotationsSource()}`)() as typeof drawAnnotations;
    const calls: string[] = [];
    const context = new Proxy({ canvas: { width: 200, clientWidth: 100 } } as Record<string, unknown>, {
        get: (target, key) => key in target ? target[key as string] : (...args: unknown[]) => { calls.push(`${String(key)}(${args.join(",")})`); },
        set: (target, key, value) => { target[key as string] = value; return true; }
    }) as unknown as CanvasRenderingContext2D;
    const snapshot = { strokes: [{ id: "a", from: "x", color: 1, pts: [0, 0, 0.5, 0.5, 1, 1] }], lasers: [{ from: "y", pts: [{ x: 0.5, y: 0.5, at: 0 }] }] };
    assert.equal(draw(context, snapshot, 350, { x: 10, y: 0, width: 100, height: 50 }, annotationColors, LASER_TTL), true);
    assert.ok(calls.includes("setTransform(2,0,0,2,0,0)"), "escala pelo devicePixelRatio do canvas");
    assert.ok(calls.includes("moveTo(10,0)") && calls.includes("lineTo(110,50)"), "pontos normalizados viram a área do frame");
    assert.ok(calls.includes(`arc(60,25,${3.5 - 0.5 * 1.5},0,${Math.PI * 2})`), "laser na metade da vida");
    assert.equal(draw(context, { strokes: [], lasers: [] }, 0, { x: 0, y: 0, width: 1, height: 1 }, annotationColors, LASER_TTL), false);
});
