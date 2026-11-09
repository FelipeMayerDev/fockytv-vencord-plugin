// SPDX-License-Identifier: GPL-3.0-or-later
import { createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from "node:crypto";

const PAYLOAD = 1128, SHARD = PAYLOAD + 2, HEADER = 26, REORDER_MS = 100;

export function controlPacket(magic: "FTVH" | "FTVA", id: string, auth: string, timestamp: number) {
    const head = Buffer.alloc(28);
    head.write(magic); Buffer.from(id, "hex").copy(head, 4); head.writeBigUInt64BE(BigInt(timestamp), 20);
    return Buffer.concat([head, createHmac("sha256", Buffer.from(auth, "hex")).update(head).digest()]);
}

export function validAck(packet: Buffer, id: string, auth: string, timestamp: number) {
    return packet.length === 60 && timingSafeEqual(packet, controlPacket("FTVA", id, auth, timestamp));
}

// shortcut: XOR recupera uma perda por grupo; usar Reed-Solomon se a medição mostrar perdas em rajada.
export function packetEncoder(id: string, token: string, send: (packet: Buffer) => void) {
    let group = 0;
    const publisher = Buffer.from(id, "hex"), key = Buffer.from(token, "hex");
    return (chunks: Buffer[]) => {
        for (let start = 0; start < chunks.length; start += 8) {
            if (group === 0xffffffff) throw new Error("Reinicie a transmissão UDP: sequência esgotada.");
            const parts = chunks.slice(start, start + 8), parity = Buffer.alloc(SHARD);
            const shards = parts.map(chunk => {
                if (!chunk.length || chunk.length > PAYLOAD) throw new Error("Quadro UDP inválido.");
                const shard = Buffer.alloc(SHARD); shard.writeUInt16BE(chunk.length); chunk.copy(shard, 2);
                for (let i = 0; i < SHARD; i++) parity[i] ^= shard[i];
                return shard;
            });
            shards.push(parity);
            shards.forEach((shard, index) => {
                const head = Buffer.alloc(HEADER);
                head.write("FTVD"); publisher.copy(head, 4); head.writeUInt32BE(group, 20); head[24] = index; head[25] = parts.length;
                const nonce = Buffer.alloc(12); publisher.copy(nonce, 0, 0, 6); nonce.writeUInt32BE(group, 6); nonce[10] = index;
                const cipher = createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(head);
                send(Buffer.concat([head, cipher.update(shard), cipher.final(), cipher.getAuthTag()]));
            });
            group++;
        }
    };
}

// Rajadas de perda (4-6 pacotes seguidos na internet) derrubam vários shards do mesmo grupo e o XOR só recupera um.
// Envia a coluna i de até `depth` grupos antes da coluna i+1: a rajada vira uma perda por grupo. O decoder já espera
// grupos fora de ordem por REORDER_MS, então receptores antigos continuam compatíveis.
export function interleaver(send: (packet: Buffer) => void, depth = 8) {
    let block: Buffer[][] = [], current: Buffer[] = [];
    const flush = () => {
        const groups = block; block = [];
        for (let i = 0; i <= 8; i++) for (const group of groups) if (group[i]) send(group[i]);
    };
    return {
        flush,
        // true quando há grupos segurados esperando completar o bloco.
        push(packet: Buffer) {
            current.push(packet);
            if (packet[24] !== packet[25]) return block.length > 0;
            block.push(current); current = [];
            if (block.length >= depth) flush();
            return block.length > 0;
        }
    };
}

export function packetDecoder(id: string, token: string, write: (chunk: Buffer) => void) {
    const publisher = Buffer.from(id, "hex"), key = Buffer.from(token, "hex");
    const groups = new Map<number, { at: number; count: number; shards: Map<number, Buffer>; }>();
    let expected: number | undefined;
    const stats = { received: 0, recovered: 0, lostGroups: 0, rejected: 0, lastLoss: "" };
    const drain = (now: number) => {
        while (groups.size && expected !== undefined) {
            const item = groups.get(expected);
            if (!item) {
                const first = Math.min(...groups.keys());
                if (now - groups.get(first)!.at < REORDER_MS) break;
                stats.lostGroups += first - expected; expected = first; continue;
            }
            const missing = Array.from({ length: item.count }, (_, i) => i).filter(i => !item.shards.has(i));
            if (missing.length === 1 && item.shards.has(item.count)) {
                const recovered = Buffer.from(item.shards.get(item.count)!);
                for (const [index, shard] of item.shards) if (index !== item.count)
                    for (let i = 0; i < SHARD; i++) recovered[i] ^= shard[i];
                item.shards.set(missing[0], recovered); stats.recovered++;
            } else if (missing.length && (now - item.at < REORDER_MS || ![...groups.keys()].some(group => group > expected!))) break;
            const complete = Array.from({ length: item.count }, (_, i) => item.shards.get(i));
            if (complete.some(shard => !shard || !shard.readUInt16BE(0) || shard.readUInt16BE(0) > PAYLOAD)) {
                stats.lostGroups++;
                stats.lastLoss = `group=${expected} count=${item.count} received=${[...item.shards.keys()]} age=${Math.round(now - item.at)}ms`;
            }
            else complete.forEach(shard => write(shard!.subarray(2, 2 + shard!.readUInt16BE(0))));
            groups.delete(expected); expected++;
        }
    };
    return {
        stats, tick: drain,
        push(packet: Buffer, now = performance.now()) {
            if (packet.length !== HEADER + SHARD + 16 || packet.toString("ascii", 0, 4) !== "FTVD" || !packet.subarray(4, 20).equals(publisher)) { stats.rejected++; return; }
            const group = packet.readUInt32BE(20), index = packet[24], count = packet[25];
            if (!count || count > 8 || index > count || (expected !== undefined && group < expected)) return;
            let shard: Buffer;
            try {
                const nonce = Buffer.alloc(12); publisher.copy(nonce, 0, 0, 6); nonce.writeUInt32BE(group, 6); nonce[10] = index;
                const cipher = createDecipheriv("aes-256-gcm", key, nonce); cipher.setAAD(packet.subarray(0, HEADER)); cipher.setAuthTag(packet.subarray(-16));
                shard = Buffer.concat([cipher.update(packet.subarray(HEADER, -16)), cipher.final()]);
            } catch { stats.rejected++; return; }
            if (expected !== undefined && group > expected + 128) {
                stats.lostGroups += group - expected; groups.clear(); expected = group;
            }
            expected ??= group;
            let item = groups.get(group);
            if (!item) { item = { at: now, count, shards: new Map() }; groups.set(group, item); }
            if (item.count !== count || item.shards.has(index)) return;
            item.shards.set(index, shard); stats.received++;
            drain(now);
        }
    };
}
