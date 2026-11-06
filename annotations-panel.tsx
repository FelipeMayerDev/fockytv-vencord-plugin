// SPDX-License-Identifier: GPL-3.0-or-later
// Camada de anotação sobre o tile da live: canvas de desenho, rAF de pintura e a barra
// de ferramentas (caneta, laser, cores, desfazer, limpar). O apresentador vê a mesma
// camada no preview da própria transmissão e é o único que pode ligar/desligar as
// anotações dos outros (pelo menu de compartilhar).
import { React, useEffect, useRef, useState } from "@webpack/common";

import { annotationColors, AnnotationBoard, AnnotationTool, drawAnnotations, LASER_TTL } from "./annotations";

export function useAnnotations(board: AnnotationBoard) {
    const [, render] = useState(0);
    useEffect(() => board.subscribe(() => render(value => value + 1)), [board]);
    return board.snapshot();
}

const PencilIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 20 1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1Z" /><path d="m14 6 4 4" /></svg>;
const LaserIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 3v2m0 14v2M3 12h2m14 0h2" /></svg>;
const UndoIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10h9a5 5 0 0 1 0 10H9" /><path d="M8 6 4 10l4 4" /></svg>;
const TrashIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-9 0 1 13h10l1-13" /></svg>;
const CloseIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>;

// Área do vídeo dentro do canvas (o tile faz letterbox com object-fit: contain), em px CSS.
function videoFrame(canvas: HTMLCanvasElement) {
    const width = canvas.clientWidth, height = canvas.clientHeight;
    const video = canvas.closest(".fockytv-player")?.querySelector("video");
    const videoWidth = video?.videoWidth || 16, videoHeight = video?.videoHeight || 9;
    const scale = Math.min(width / videoWidth, height / videoHeight) || 1;
    return { x: (width - videoWidth * scale) / 2, y: (height - videoHeight * scale) / 2, width: videoWidth * scale, height: videoHeight * scale };
}

export function AnnotationLayer({ board }: { board: AnnotationBoard; }) {
    const snapshot = useAnnotations(board);
    const canvas = useRef<HTMLCanvasElement>(null);

    // Pinta só quando o board muda ou o tile redimensiona; o rAF continua apenas enquanto houver laser sumindo.
    const visible = snapshot.allowed || snapshot.isOwner;
    useEffect(() => {
        if (!visible) return;
        let frame = 0;
        const paint = () => {
            board.tick(); // pode notificar: frame ainda está marcado, então não agenda de novo
            frame = 0;
            const element = canvas.current;
            if (!element?.isConnected) return;
            const ratio = devicePixelRatio, width = Math.round(element.clientWidth * ratio), height = Math.round(element.clientHeight * ratio);
            if (element.width !== width || element.height !== height) Object.assign(element, { width, height });
            const context = element.getContext("2d")!;
            context.clearRect(0, 0, element.width, element.height);
            const current = board.snapshot();
            drawAnnotations(context, current, performance.now(), videoFrame(element), annotationColors, LASER_TTL);
            if (current.lasers.length) frame = requestAnimationFrame(paint);
        };
        const schedule = () => { frame ||= requestAnimationFrame(paint); };
        const unsubscribe = board.subscribe(schedule);
        const observer = new ResizeObserver(schedule);
        if (canvas.current) observer.observe(canvas.current);
        schedule();
        return () => { unsubscribe(); observer.disconnect(); cancelAnimationFrame(frame); };
    }, [board, visible]);

    // Só o dono vê as anotações com o toggle desligado (para poder religar); espectador não vê nada.
    if (!snapshot.allowed && !snapshot.isOwner) return null;
    const active = snapshot.annotating;
    const tool = snapshot.tool;

    if (!active) return <div className="fockytv-annotations">
        <canvas ref={canvas} aria-hidden="true" />
        <div className="fockytv-annotations-bar" onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}>
            <button type="button" className="fockytv-player-button" title="Anotar na tela" aria-label="Anotar na tela"
                onClick={() => board.setAnnotating(true)}><PencilIcon />Anotar</button>
        </div>
    </div>;

    const stop = (event: React.SyntheticEvent) => { event.stopPropagation(); event.preventDefault(); };
    const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
        const element = canvas.current!;
        const bounds = element.getBoundingClientRect();
        const frame = videoFrame(element);
        return [(event.clientX - bounds.left - frame.x) / frame.width, (event.clientY - bounds.top - frame.y) / frame.height];
    };
    const down = (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (event.button !== 0) return;
        stop(event);
        canvas.current?.setPointerCapture(event.pointerId);
        const [x, y] = point(event);
        tool === "laser" ? board.laser(x, y) : board.begin(x, y);
    };
    const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (!(event.buttons & 1)) return;
        stop(event);
        const [x, y] = point(event);
        tool === "laser" ? board.laser(x, y) : board.extend(x, y);
    };
    const up = () => { if (tool === "pen") board.finish(); };

    return <div className={`fockytv-annotations active is-${tool}`}>
        <canvas ref={canvas} aria-label="Camada de anotações da live"
            style={{ touchAction: "none" }}
            onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
        <div className="fockytv-annotations-bar" onClick={stop} onPointerDown={stop}>
            {(["pen", "laser"] as AnnotationTool[]).map(value =>
                <button key={value} type="button" className="fockytv-player-button" data-active={tool === value}
                    title={value === "pen" ? "Caneta" : "Ponteiro laser"} aria-label={value === "pen" ? "Caneta" : "Ponteiro laser"}
                    onClick={() => board.setTool(value)}>{value === "pen" ? <PencilIcon /> : <LaserIcon />}</button>)}
            <span className="fockytv-annotations-colors" role="group" aria-label="Cor da caneta">
                {annotationColors.map((value, index) =>
                    <button key={value} type="button" className="fockytv-annotations-color" data-active={snapshot.color === index}
                        style={{ background: value }} aria-label={`Cor ${index + 1}`} title={`Cor ${index + 1}`}
                        onClick={() => board.setColor(index)} />)}
            </span>
            <button type="button" className="fockytv-player-button" title="Desfazer meu último traço" aria-label="Desfazer"
                onClick={() => board.undo()}><UndoIcon /></button>
            <button type="button" className="fockytv-player-button" title={snapshot.isOwner ? "Apagar todas as anotações" : "Apagar minhas anotações"}
                aria-label="Limpar anotações" onClick={() => board.clear()}><TrashIcon /></button>
            <button type="button" className="fockytv-player-button" title="Sair das anotações" aria-label="Sair das anotações"
                onClick={() => board.setAnnotating(false)}><CloseIcon /></button>
        </div>
    </div>;
}
