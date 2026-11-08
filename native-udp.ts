// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createSocket } from "node:dgram";
import { createHmac } from "node:crypto";
import { isIPv4 } from "node:net";
import { networkInterfaces } from "node:os";
import { Writable } from "node:stream";

import type { CaptureSink } from "./native-capture";
import { controlPacket, packetDecoder, packetEncoder, validAck } from "./udp-protocol";

export const UDP_SERVER = "https://fockytv-insider.felipemayer.com.br";
interface Ticket { id: string; clientId: string; token: string; auth: string; host: string; lanHost?: string; port: number; }

export async function udpRequest(path: string, auth: string, body?: unknown, method = "POST") {
    const response = await fetch(`${UDP_SERVER}/api/udp/${path}`, {
        method, headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        redirect: "error", signal: AbortSignal.timeout(10_000)
    });
    return { status: response.status, body: await response.text(), location: null };
}

export async function openUdp(role: "publish" | "watch", key: string, body: unknown) {
    const response = await udpRequest(role, key, body);
    if (response.status !== 201) throw new Error(`UDP Insider (${response.status}): ${response.body.slice(0, 200)}`);
    const ticket = JSON.parse(response.body) as Ticket;
    if (!/^[a-f0-9]{32}$/.test(ticket.id) || !/^[a-f0-9]{32}$/.test(ticket.clientId) ||
        !/^[a-f0-9]{64}$/.test(ticket.token) || !/^[a-f0-9]{64}$/.test(ticket.auth) ||
        !isIPv4(ticket.host) || (ticket.lanHost !== undefined && !isIPv4(ticket.lanHost)) ||
        !Number.isInteger(ticket.port) || ticket.port < 1 || ticket.port > 65535 || (role === "publish" && ticket.id !== ticket.clientId))
        throw new Error("Sessão UDP inválida.");
    const socket = createSocket("udp4");
    const ip = (value: string) => value.split(".").reduce((n, part) => (n << 8) | Number(part), 0);
    const lan = ticket.lanHost;
    const nearby = lan && Object.values(networkInterfaces()).flat().some(address => address?.family === "IPv4" && !address.internal &&
        ((ip(address.address) ^ ip(lan)) & ip(address.netmask)) === 0);
    let closed = false, timestamp = 0, lastAck = 0;
    let onPacket = (_packet: Buffer) => {};
    let onError = (_error: Error) => {};
    let beat: ReturnType<typeof setInterval> | undefined;
    const close = () => {
        if (closed) return;
        closed = true; clearInterval(beat);
        try { socket.close(); } catch { /* Socket já encerrado por erro de rede. */ }
        void udpRequest(`session/${ticket.clientId}`, ticket.auth, undefined, "DELETE").catch(() => {});
    };
    try {
        await new Promise<void>((resolve, reject) => {
            socket.once("error", reject);
            socket.connect(ticket.port, nearby ? lan! : ticket.host, () => { socket.removeListener("error", reject); resolve(); });
        });
        socket.setRecvBufferSize(4 << 20);
        socket.setSendBufferSize(1 << 20);
        socket.on("error", error => onError(error));
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("UDP bloqueado ou servidor indisponível. A transmissão atual continua disponível.")), 5000);
            onError = error => { clearTimeout(timeout); reject(error); };
            socket.on("message", packet => {
                if (validAck(packet, ticket.clientId, ticket.auth, timestamp)) {
                    lastAck = performance.now(); clearTimeout(timeout); resolve();
                } else if (role === "watch") onPacket(packet);
            });
            const hello = () => {
                if (lastAck && performance.now() - lastAck > 10_000) return onError(new Error("A conexão UDP foi interrompida."));
                timestamp = Math.max(Date.now(), timestamp + 1);
                socket.send(controlPacket("FTVH", ticket.clientId, ticket.auth, timestamp), error => { if (error) onError(error); });
            };
            beat = setInterval(hello, 1000); hello();
        });
    } catch (error) { close(); throw error; }
    return {
        ticket, close,
        receive(callback: typeof onPacket) { onPacket = callback; },
        errors(callback: typeof onError) { onError = callback; },
        send(packet: Buffer) {
            if (closed) return;
            if (socket.getSendQueueSize() > 1 << 20) return onError(new Error("A fila UDP excedeu o limite de latência."));
            const signed = role === "publish" ? Buffer.concat([packet, createHmac("sha256", Buffer.from(ticket.auth, "hex")).update(packet).digest().subarray(0, 16)]) : packet;
            socket.send(signed, error => { if (error) onError(error); });
        }
    };
}

export async function udpSink(key: string, quality: { resolution: number; fps: number; style?: string; }, bitrate: number): Promise<CaptureSink> {
    const connection = await openUdp("publish", key, quality);
    // Espalha keyframes pela rede: despejar um pipe inteiro de uma vez estoura buffers UDP.
    let packets: Buffer[] = [], queued = 0, credit = 12000, clock = performance.now();
    let pacing: ReturnType<typeof setTimeout> | undefined;
    const pace = () => {
        pacing = undefined;
        const now = performance.now(); credit = Math.min(12000, credit + (now - clock) * bitrate * 125 * 1.5); clock = now;
        while (packets.length && credit >= packets[0].length) {
            const packet = packets.shift()!; queued -= packet.length; credit -= packet.length; connection.send(packet);
        }
        if (packets.length) pacing = setTimeout(pace, 1);
    };
    const encode = packetEncoder(connection.ticket.id, connection.ticket.token, packet => {
        queued += packet.length;
        if (queued > Math.max(256 << 10, bitrate * 125000 * 0.75)) throw new Error("A fila UDP atrasou além do limite. Reduza o bitrate.");
        packets.push(packet);
        if (!pacing) pacing = setTimeout(pace, 1);
    });
    let parts: Buffer[] = [], rest = Buffer.alloc(0), timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
        clearTimeout(timer); timer = undefined;
        if (rest.length) { parts.push(rest); rest = Buffer.alloc(0); }
        if (parts.length) { encode(parts); parts = []; }
    };
    const input = new Writable({
        write(chunk: Buffer, _encoding, done) {
            try {
                const data = rest.length ? Buffer.concat([rest, chunk]) : chunk;
                let offset = 0;
                for (; offset + 1128 <= data.length; offset += 1128) {
                    parts.push(data.subarray(offset, offset + 1128));
                    if (parts.length === 8) { encode(parts); parts = []; }
                }
                rest = data.subarray(offset);
                if (!timer) timer = setTimeout(() => { try { flush(); } catch (error) { input.destroy(error as Error); } }, 8);
                done();
            } catch (error) { done(error as Error); }
        },
        final(done) { try { flush(); done(); } catch (error) { done(error as Error); } }
    });
    input.on("error", () => {});
    connection.errors(error => input.destroy(error));
    const path = `session/${connection.ticket.clientId}`;
    return {
        input,
        stop() { clearTimeout(timer); clearTimeout(pacing); parts = []; rest = Buffer.alloc(0); packets = []; connection.close(); },
        quality: value => udpRequest(`${path}/quality`, connection.ticket.auth, value),
        notify: body => udpRequest(`${path}/announce`, connection.ticket.auth, body)
    };
}

// Só remultiplexa: a decodificação H.264/Opus permanece no Chromium, sem copiar quadros crus por IPC.
export function receiverArgs() {
    return ["-hide_banner", "-loglevel", "error", "-probesize", "8000000", "-analyzeduration", "1000000", "-fflags", "+discardcorrupt",
        "-f", "mpegts", "-i", "pipe:0", "-map", "0:v:0", "-map", "0:a:0", "-c", "copy",
        "-max_interleave_delta", "100000", "-movflags", "+empty_moov+default_base_moof", "-frag_duration", "50000", "-flush_packets", "1", "-f", "mp4", "pipe:1"];
}

export async function udpReceiver(ffmpeg: string, key: string, viewer: string) {
    const connection = await openUdp("watch", key, { viewer });
    let queue: Buffer[] = [], bytes = 0, error = "", closed = false, generation = 0, lost = 0, detail = "";
    let child: ChildProcessWithoutNullStreams | undefined;
    let resetAt = 0, resets = 0;
    const retire = (process: NonNullable<typeof child>) => {
        process.stdin.destroy(); process.stdout.destroy(); process.kill();
        const reap = setTimeout(() => { if (process.exitCode === null) process.kill("SIGKILL"); }, 2000); reap.unref();
    };
    const close = () => { if (closed) return; closed = true; clearInterval(timer); connection.close(); if (child) retire(child); queue = []; bytes = 0; };
    const fail = (message: string) => { error = message; close(); };
    function remux(): ChildProcessWithoutNullStreams {
        const process = spawn(ffmpeg, receiverArgs(), { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        let stderr = "";
        process.stdin.on("error", error => { if (!closed && child === process) fail(`${error.message}: ${stderr}`); });
        process.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-1000); if (child === process) detail = stderr; });
        process.on("error", error => { if (child === process) fail(error.message); });
        process.on("exit", () => { if (!closed && child === process) fail(`Receptor UDP encerrou: ${stderr}`); });
        process.stdout.on("data", (chunk: Buffer) => {
            if (closed || child !== process) return;
            bytes += chunk.length;
            if (bytes > 4 << 20) return fail("A reprodução UDP atrasou além do limite.");
            queue.push(chunk);
        });
        return process;
    }
    child = remux();
    const decoder = packetDecoder(connection.ticket.id, connection.ticket.token, chunk => {
        if (closed) return;
        if (decoder.stats.lostGroups !== lost) {
            // Não entrega um sample H.264 incompleto ao MSE: novo MP4 começa no próximo keyframe.
            const now = performance.now();
            if (now - resetAt > 5000) { resetAt = now; resets = 0; }
            if (++resets > 5) return fail("Perda UDP persistente. Reduza o bitrate e reinicie a transmissão.");
            lost = decoder.stats.lostGroups;
            const previous = child!; child = undefined; retire(previous);
            queue = []; bytes = 0; generation++; child = remux();
        }
        if (child!.stdin.writableLength > 1 << 20) return fail("O receptor UDP não acompanha a transmissão.");
        if (!child!.stdin.destroyed) child!.stdin.write(chunk);
    });
    const timer = setInterval(() => decoder.tick(performance.now()), 10);
    connection.receive(packet => decoder.push(packet)); connection.errors(error => fail(error.message));
    return { close, read() {
        if (error) throw new Error(error);
        if (closed) throw new Error("Receptor UDP encerrado.");
        const data = Buffer.concat(queue, bytes); queue = []; bytes = 0;
        return { data: new Uint8Array(data), generation, detail, stats: { ...decoder.stats } };
    } };
}
