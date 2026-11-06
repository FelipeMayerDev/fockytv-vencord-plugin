// SPDX-License-Identifier: GPL-3.0-or-later
// Anotações em tempo real sobre a live (estilo Teams): caneta e laser desenhados numa
// camada local sobre o tile; pelo WebSocket do jam só passam coordenadas normalizadas.
// Um board por live (target = id do Discord do dono). Os traços são efêmeros — só vê
// quem está na sala na hora; do servidor vem apenas o estado do toggle
// "Permitir anotações" de cada live.

export type AnnotationTool = "pen" | "laser";

export interface AnnotationStroke { id: string; from: string; color: number; pts: number[]; at: number; } // at = último ponto
export interface LaserTrail { from: string; pts: { x: number; y: number; at: number; }[]; }
export interface AnnotationSnapshot {
    allowed: boolean;
    isOwner: boolean;
    annotating: boolean;
    tool: AnnotationTool;
    color: number;
    strokes: AnnotationStroke[];
    lasers: LaserTrail[];
}

export const annotationColors = ["#f23f43", "#faa61a", "#3ba55d", "#5865f2", "#eb459e"];
const MAX_STROKES = 64, MAX_POINTS = 250;
// ms até sumir: o laser é um rastro curto; a caneta fica alguns segundos e esmaece no último.
export const ANNOTATION_TTL = { laser: 700, stroke: 3000, fade: 1000 };

export function annotationBoard(target: string, self: string, send: (message: object) => void) {
    const subscribers = new Set<() => void>();
    const notify = () => subscribers.forEach(fn => fn());
    let allowed = true, annotating = false, tool: AnnotationTool = "pen", color = 0;
    const strokes: AnnotationStroke[] = [];
    const lasers = new Map<string, LaserTrail>();
    // Caneta: o traço em andamento é local (eco imediato); os pontos saem em lotes.
    let current: AnnotationStroke | undefined;
    let outbox: number[] = [], outboxId = "", flushTimer: ReturnType<typeof setTimeout> | undefined;
    let lastLaser = 0;

    const clamp = (value: number) => Math.min(1, Math.max(0, value));
    const rounded = (value: number) => Math.round(value * 100) / 100;
    const canDraw = () => annotating && (allowed || self === target);
    const strokeOf = (id: string, from: string) => strokes.find(stroke => stroke.id === id && stroke.from === from);
    function trail(from: string) {
        let entry = lasers.get(from);
        if (!entry) { entry = { from, pts: [] }; lasers.set(from, entry); }
        return entry.pts;
    }

    function flush() {
        flushTimer = undefined;
        // O outboxId vale enquanto o traço está em andamento (só o cancelCurrent limpa).
        if (outbox.length && outboxId) send({ type: "draw", target, action: "points", id: outboxId, pts: outbox.splice(0) });
    }
    function cancelCurrent() {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
        // Pontos pendentes do traço vão antes do end — o traço parcial fica igual para todos.
        if (outbox.length && outboxId) send({ type: "draw", target, action: "points", id: outboxId, pts: outbox.splice(0) });
        outboxId = "";
        const id = current?.id;
        current = undefined;
        outbox = [];
        if (id) send({ type: "draw", target, action: "end", id });
    }

    return {
        snapshot(): AnnotationSnapshot {
            return {
                allowed, isOwner: self === target,
                annotating: canDraw(), tool, color,
                strokes: [...strokes], lasers: [...lasers.values()]
            };
        },
        subscribe(fn: () => void) { subscribers.add(fn); return () => { subscribers.delete(fn); }; },
        setAnnotating(on: boolean) {
            annotating = on;
            // Sair no meio do traço solta o que estava sendo desenhado (o traço parcial fica para todos).
            if (!on && current) cancelCurrent();
            notify();
        },
        setTool(value: AnnotationTool) { tool = value; notify(); },
        setColor(value: number) { if (value >= 0 && value < annotationColors.length) color = value; notify(); },
        allow(on: boolean) {
            if (self !== target || typeof on !== "boolean" || allowed === on) return;
            allowed = on;
            send({ type: "draw", target, action: "allow", on });
            notify();
        },
        begin(x: number, y: number) {
            if (!canDraw()) return;
            const id = crypto.randomUUID().slice(0, 8);
            current = { id, from: self, color, pts: [rounded(clamp(x)), rounded(clamp(y))], at: performance.now() };
            strokes.push(current);
            while (strokes.length > MAX_STROKES && strokes[0] !== current) strokes.shift();
            outbox = []; outboxId = id;
            send({ type: "draw", target, action: "begin", id, color });
            notify();
        },
        extend(x: number, y: number) {
            if (!current) return;
            if (current.pts.length >= MAX_POINTS) return;
            current.pts.push(rounded(clamp(x)), rounded(clamp(y)));
            current.at = performance.now();
            outbox.push(...current.pts.slice(-2));
            flushTimer ??= setTimeout(flush, 80);
            notify();
        },
        finish() {
            const stroke = current;
            cancelCurrent();
            if (!stroke) return;
            notify();
        },
        undo() {
            if (!canDraw()) return;
            for (let index = strokes.length - 1; index >= 0; index--)
                if (strokes[index].from === self) { strokes.splice(index, 1); break; }
            send({ type: "draw", target, action: "undo" });
            notify();
        },
        clear() {
            if (!canDraw()) return;
            const all = self === target; // o dono apaga tudo; espectador apaga só o próprio
            for (let index = strokes.length - 1; index >= 0; index--)
                if (all || strokes[index].from === self) strokes.splice(index, 1);
            send({ type: "draw", target, action: "clear" });
            notify();
        },
        laser(x: number, y: number) {
            if (!canDraw()) return;
            const now = performance.now();
            if (now - lastLaser < 33) return;
            lastLaser = now;
            trail(self).push({ x: clamp(x), y: clamp(y), at: now });
            send({ type: "draw", target, action: "laser", pts: [rounded(clamp(x)), rounded(clamp(y))] });
            notify();
        },
        // Laser e traços envelhecem; quem pinta chama enquanto houver algo na tela.
        tick() {
            const now = performance.now();
            let changed = false;
            // O traço que estou desenhando não some na minha mão.
            for (let index = strokes.length - 1; index >= 0; index--)
                if (strokes[index] !== current && now - strokes[index].at >= ANNOTATION_TTL.stroke) { strokes.splice(index, 1); changed = true; }
            for (const [from, entry] of lasers) {
                const alive = entry.pts.filter(point => now - point.at < ANNOTATION_TTL.laser);
                if (alive.length !== entry.pts.length) { entry.pts = alive; changed = true; }
                if (!alive.length) { lasers.delete(from); changed = true; }
            }
            if (changed) notify();
        },
        // Mensagens do broadcast da sala (from = quem desenhou) e do sync ao entrar.
        apply(raw: unknown) {
            const message = raw as Record<string, unknown>;
            if (!message || message.type !== "draw" || message.target !== target || typeof message.action !== "string") return;
            // O sync chega direto do servidor, sem remetente; todo o resto precisa de from.
            const from = typeof message.from === "string" ? message.from : "";
            if (!from && message.action !== "sync") return;
            const pts = message.pts;
            switch (message.action) {
                case "sync": {
                    // Efêmero por design: o sync só traz o toggle — traços (de servidores
                    // antigos) são ignorados, e o desenho local não é tocado.
                    if (!Array.isArray(message.targets)) return;
                    for (const entry of message.targets as any[])
                        if (entry && entry.target === target && typeof entry.allowed === "boolean") allowed = entry.allowed;
                    break;
                }
                case "begin": {
                    const id = typeof message.id === "string" ? message.id.slice(0, 40) : "";
                    const color = message.color;
                    if (!id || !Number.isInteger(color) || color < 0 || color >= annotationColors.length || strokeOf(id, from)) return;
                    strokes.push({ id, from, color, pts: [], at: performance.now() });
                    while (strokes.length > MAX_STROKES) strokes.shift();
                    break;
                }
                case "points": {
                    const stroke = typeof message.id === "string" ? strokeOf(message.id, from) : undefined;
                    if (!stroke || !Array.isArray(pts) || pts.length > 200 || pts.length % 2) return;
                    for (let index = 0; index + 1 < pts.length; index += 2) {
                        if (typeof pts[index] !== "number" || !Number.isFinite(pts[index]) || typeof pts[index + 1] !== "number" || !Number.isFinite(pts[index + 1])) return;
                        if (stroke.pts.length < MAX_POINTS) stroke.pts.push(clamp(pts[index] as number), clamp(pts[index + 1] as number));
                    }
                    stroke.at = performance.now();
                    break;
                }
                case "end": {
                    const stroke = typeof message.id === "string" ? strokeOf(message.id, from) : undefined;
                    if (stroke && !stroke.pts.length) strokes.splice(strokes.indexOf(stroke), 1);
                    break;
                }
                case "undo":
                    for (let index = strokes.length - 1; index >= 0; index--)
                        if (strokes[index].from === from) { strokes.splice(index, 1); break; }
                    break;
                case "clear":
                    for (let index = strokes.length - 1; index >= 0; index--)
                        if (from === target || strokes[index].from === from) strokes.splice(index, 1);
                    break;
                case "allow":
                    if (from !== target || typeof message.on !== "boolean") return;
                    allowed = message.on;
                    break;
                case "laser":
                    if (!Array.isArray(pts) || pts.length !== 2 || typeof pts[0] !== "number" || typeof pts[1] !== "number" ||
                        !Number.isFinite(pts[0]) || !Number.isFinite(pts[1])) return;
                    trail(from).push({ x: clamp(pts[0]), y: clamp(pts[1]), at: performance.now() });
                    break;
                default: return;
            }
            notify();
        },
        // Quem abre o tile depois pede o estado atual (o sync completo só chega ao entrar na sala).
        resync() { send({ type: "draw", target, action: "resync" }); }
    };
}

export type AnnotationBoard = ReturnType<typeof annotationBoard>;

export interface AnnotationFrame { x: number; y: number; width: number; height: number; }

// Pintura: traço suavizado como o espectro (curvas pelos pontos médios) e laser com rastro que some.
// Autocontida (sem nomes de fora): o overlay da tela do apresentador roda o texto desta função.
export function drawAnnotations(context: CanvasRenderingContext2D, snapshot: Pick<AnnotationSnapshot, "strokes" | "lasers">, now: number, frame: AnnotationFrame, colors: readonly string[], ttl: typeof ANNOTATION_TTL) {
    const { strokes, lasers } = snapshot;
    if (!strokes.length && !lasers.length) return false;
    const ratio = context.canvas.width / Math.max(1, context.canvas.clientWidth);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.lineCap = context.lineJoin = "round";
    const px = (value: number) => frame.x + value * frame.width;
    const py = (value: number) => frame.y + value * frame.height;
    for (const stroke of strokes) {
        context.globalAlpha = Math.min(1, Math.max(0, (ttl.stroke - (now - stroke.at)) / ttl.fade));
        context.strokeStyle = context.fillStyle = colors[stroke.color] ?? colors[0];
        context.lineWidth = 2.5;
        if (stroke.pts.length < 4) {
            // Clique solto: um ponto no lugar.
            context.beginPath();
            context.arc(px(stroke.pts[0] ?? 0), py(stroke.pts[1] ?? 0), 1.6, 0, Math.PI * 2);
            context.fill();
            continue;
        }
        context.beginPath();
        context.moveTo(px(stroke.pts[0]), py(stroke.pts[1]));
        for (let index = 2; index + 3 < stroke.pts.length; index += 2)
            context.quadraticCurveTo(px(stroke.pts[index]), py(stroke.pts[index + 1]),
                (px(stroke.pts[index]) + px(stroke.pts[index + 2])) / 2, (py(stroke.pts[index + 1]) + py(stroke.pts[index + 3])) / 2);
        context.lineTo(px(stroke.pts.at(-2)!), py(stroke.pts.at(-1)!));
        context.stroke();
    }
    // Laser sempre na primeira cor (vermelho).
    context.fillStyle = colors[0];
    for (const laser of lasers) {
        for (const point of laser.pts) {
            const age = Math.min(1, Math.max(0, (now - point.at) / ttl.laser));
            context.globalAlpha = 1 - age;
            context.beginPath();
            context.arc(px(point.x), py(point.y), 3.5 - age * 1.5, 0, Math.PI * 2);
            context.fill();
        }
    }
    context.globalAlpha = 1;
    context.setTransform(1, 0, 0, 1, 0, 0);
    return true;
}

// drawAnnotations como texto para outra janela; esbuild com keepNames (tsx) embrulha as funções internas em __name.
export const drawAnnotationsSource = () => `(() => { const __name = fn => fn; return ${drawAnnotations}; })()`;
