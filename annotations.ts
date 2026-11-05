// SPDX-License-Identifier: GPL-3.0-or-later
// Anotações em tempo real sobre a live (estilo Teams): caneta e laser desenhados numa
// camada local sobre o tile; pelo WebSocket do jam só passam coordenadas normalizadas.
// Um board por live (target = id do Discord do dono); o servidor guarda os traços para
// quem entrar depois e o estado do toggle "Permitir anotações".

export type AnnotationTool = "pen" | "laser";

export interface AnnotationStroke { id: string; from: string; color: number; pts: number[]; }
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
const LASER_COLOR = "#f23f43";
const MAX_STROKES = 64, MAX_POINTS = 250;
export const LASER_TTL = 700; // ms até o rastro do laser desaparecer

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
            current = { id, from: self, color, pts: [rounded(clamp(x)), rounded(clamp(y))] };
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
        // Rastro do laser envelhece; o rAF da camada chama a cada quadro.
        tick() {
            const now = performance.now();
            let changed = false;
            for (const [from, entry] of lasers) {
                const alive = entry.pts.filter(point => now - point.at < LASER_TTL);
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
                    if (!Array.isArray(message.targets)) return;
                    for (const entry of message.targets as any[]) {
                        if (!entry || entry.target !== target) continue;
                        const inProgress = current;
                        strokes.length = 0;
                        lasers.clear();
                        if (typeof entry.allowed === "boolean") allowed = entry.allowed;
                        if (Array.isArray(entry.strokes)) for (const item of entry.strokes) {
                            const id = typeof item?.id === "string" ? item.id.slice(0, 40) : "";
                            const color = item?.color;
                            if (!id || typeof item.from !== "string" || !Number.isInteger(color) || color < 0 || color >= annotationColors.length) continue;
                            const points = Array.isArray(item.pts) ? item.pts.filter((value: unknown) => typeof value === "number" && Number.isFinite(value)) : [];
                            strokes.push({ id, from: item.from, color, pts: points.slice(0, MAX_POINTS) });
                        }
                        if (inProgress && !strokes.includes(inProgress)) strokes.push(inProgress);
                        while (strokes.length > MAX_STROKES) strokes.shift();
                    }
                    break;
                }
                case "begin": {
                    const id = typeof message.id === "string" ? message.id.slice(0, 40) : "";
                    const color = message.color;
                    if (!id || !Number.isInteger(color) || color < 0 || color >= annotationColors.length || strokeOf(id, from)) return;
                    strokes.push({ id, from, color, pts: [] });
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

// Pintura: traço suavizado como o espectro (curvas pelos pontos médios) e laser com rastro que some.
export function drawAnnotations(context: CanvasRenderingContext2D, snapshot: AnnotationSnapshot, now: number) {
    const { strokes, lasers } = snapshot;
    if (!strokes.length && !lasers.length) return false;
    const ratio = context.canvas.width / Math.max(1, context.canvas.clientWidth);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const width = context.canvas.clientWidth, height = context.canvas.clientHeight;
    // O canvas é neto do wrapper (.fockytv-annotations dentro de .fockytv-player); o vídeo é o irmão do pai.
    const video = context.canvas.closest(".fockytv-player")?.querySelector("video");
    const videoWidth = video?.videoWidth || 16, videoHeight = video?.videoHeight || 9;
    const scale = Math.min(width / videoWidth, height / videoHeight) || 1;
    const frame = { x: (width - videoWidth * scale) / 2, y: (height - videoHeight * scale) / 2, width: videoWidth * scale, height: videoHeight * scale };
    context.lineCap = context.lineJoin = "round";
    for (const stroke of strokes) {
        const color = annotationColors[stroke.color] ?? annotationColors[0];
        context.strokeStyle = context.fillStyle = color;
        context.lineWidth = 2.5;
        const px = (value: number) => frame.x + value * frame.width;
        const py = (value: number) => frame.y + value * frame.height;
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
    for (const laser of lasers) {
        for (const point of laser.pts) {
            const age = Math.min(1, Math.max(0, (now - point.at) / LASER_TTL));
            context.globalAlpha = 1 - age;
            context.fillStyle = LASER_COLOR;
            context.beginPath();
            context.arc(frame.x + point.x * frame.width, frame.y + point.y * frame.height, 3.5 - age * 1.5, 0, Math.PI * 2);
            context.fill();
        }
    }
    context.globalAlpha = 1;
    context.setTransform(1, 0, 0, 1, 0, 0);
    return true;
}
