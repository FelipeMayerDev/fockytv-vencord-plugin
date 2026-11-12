// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, IpcMainInvokeEvent } from "electron";

import { pcmHeader, PcmBuffer } from "./pcm";

interface AudioCapture {
    id: string;
    queue?: PcmBuffer;
    error?: string;
    dispose: () => void;
}
const captures = new Map<number, AudioCapture>();

// Mesma origem/revisão que o updater usa: último commit do canal main no GitHub.
const repository = "FelipeMayerDev/fockytv-vencord-plugin";
// O binário não vem embutido no bundle; este é o SHA-256 esperado do audio-helper.exe publicado no repositório.
const helperHash = "b82c2a236e3dcbae4d55c5f0e7ead6d371d1ca979fc0ebbd1b5f70c0d10d7c59";

async function helperRevision() {
    const response = await fetch(`https://api.github.com/repos/${repository}/commits/main?t=${Date.now()}`, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Não foi possível obter a versão do capturador de áudio (HTTP ${response.status}).`);
    const { sha } = await response.json();
    if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha)) throw new Error("Versão do capturador de áudio inválida.");
    return sha;
}

async function helperPath() {
    const directory = join(app.getPath("userData"), "FockyTV");
    const path = join(directory, `audio-helper-${helperHash.slice(0, 16)}.exe`);
    if (existsSync(path) && createHash("sha256").update(readFileSync(path)).digest("hex") === helperHash) return path;
    const revision = await helperRevision();
    const response = await fetch(`https://raw.githubusercontent.com/${repository}/${revision}/audio-helper.exe`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Download do capturador de áudio falhou (HTTP ${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== helperHash) throw new Error("Download do capturador de áudio corrompido (hash SHA-256 não corresponde).");
    mkdirSync(directory, { recursive: true });
    writeFileSync(`${path}.tmp`, bytes);
    renameSync(`${path}.tmp`, path);
    return path;
}

export function stopAudio(event: IpcMainInvokeEvent, id: string) {
    const capture = captures.get(event.sender.id);
    if (!capture || capture.id !== id) return;
    captures.delete(event.sender.id);
    capture.dispose();
}

export async function startAudio(event: IpcMainInvokeEvent, sourceId: string) {
    if (process.platform !== "win32") throw new Error("Captura de áudio FockyTV por aplicativo disponível apenas no Windows.");
    if (!/^(screen|window):-?\d+:\d+$/.test(sourceId)) throw new Error("Fonte de áudio inválida.");
    const previous = captures.get(event.sender.id);
    if (previous) stopAudio(event, previous.id);
    const args = sourceId.startsWith("window:")
        ? ["--hwnd", sourceId.split(":")[1]]
        : ["--mix-except", "Discord,DiscordCanary,DiscordPTB,Vesktop,Vencord,Equibop,FockyTV"];
    const child = spawn(await helperPath(), args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const id = randomUUID();
    const destroyed = () => stopAudio(event, id);
    const navigating = (details: { isMainFrame: boolean; isSameDocument: boolean; }) => {
        if (details.isMainFrame && !details.isSameDocument) destroyed();
    };
    const capture: AudioCapture = {
        id,
        dispose() {
            child.kill();
            event.sender.removeListener("destroyed", destroyed);
            event.sender.removeListener("render-process-gone", destroyed);
            event.sender.removeListener("did-start-navigation", navigating);
        }
    };
    captures.set(event.sender.id, capture);
    event.sender.once("destroyed", destroyed);
    event.sender.once("render-process-gone", destroyed);
    event.sender.on("did-start-navigation", navigating);
    let header = Buffer.alloc(0), stderr = "";
    child.stderr?.on("data", chunk => stderr = (stderr + chunk.toString()).slice(-1000));
    try {
        return await new Promise<{ id: string; rate: number; channels: number; }>((resolve, reject) => {
            let settled = false;
            const timer = setTimeout(() => fail("Capturador de áudio não respondeu."), 10_000);
            const fail = (message: string) => {
                capture.error = message;
                clearTimeout(timer);
                if (!settled) { settled = true; reject(new Error(message)); }
            };
            child.on("error", error => fail(error.message));
            child.on("exit", code => fail(`Capturador de áudio encerrou (${code}): ${stderr}`));
            child.stdout?.on("data", chunk => {
                if (capture.queue) { capture.queue.push(chunk); return; }
                header = Buffer.concat([header, chunk]);
                if (header.length < 16) return;
                try {
                    const { rate, channels } = pcmHeader(header);
                    capture.queue = new PcmBuffer(channels * 4, rate * channels * 4);
                    capture.queue.push(header.subarray(16));
                    header = Buffer.alloc(0);
                    clearTimeout(timer);
                    settled = true;
                    resolve({ id, rate, channels });
                } catch (error) { fail(String(error)); child.kill(); }
            });
        });
    } catch (error) { stopAudio(event, id); throw error; }
}

export function readAudio(event: IpcMainInvokeEvent, id: string) {
    const capture = captures.get(event.sender.id);
    if (!capture || capture.id !== id) throw new Error("Captura de áudio encerrada.");
    if (capture.error) throw new Error(capture.error);
    return capture.queue?.drain() ?? new Uint8Array(0);
}
