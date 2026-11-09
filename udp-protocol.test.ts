// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { controlPacket, interleaver, packetDecoder, packetEncoder, validAck } from "./udp-protocol";

const id = "ab".repeat(16), key = "cd".repeat(32);
test("UDP authenticates control packets and rejects stale or forged ACKs", () => {
    const ack = controlPacket("FTVA", id, key, 123);
    assert.ok(validAck(ack, id, key, 123));
    assert.ok(!validAck(ack, id, key, 124));
    ack[30] ^= 1;
    assert.ok(!validAck(ack, id, key, 123));
    assert.ok(!validAck(Buffer.alloc(0), id, key, 123));
});

test("UDP decrypts ordered groups and recovers any one lost shard, including parity", () => {
    const input = Array.from({ length: 8 }, (_, i) => randomBytes(100 + i * 100));
    const packets: Buffer[] = []; packetEncoder(id, key, p => packets.push(p))(input);
    for (let lost = 0; lost <= 8; lost++) {
        const output: Buffer[] = [], decoder = packetDecoder(id, key, b => output.push(b));
        packets.filter((_, i) => i !== lost).reverse().forEach(p => decoder.push(p, 0));
        assert.deepEqual(output, input);
        assert.equal(decoder.stats.recovered, lost < 8 ? 1 : 0);
    }
});

test("UDP rejects tampering, duplicates, wrong keys and keeps reordering bounded", () => {
    const packets: Buffer[] = [], input = [randomBytes(500), randomBytes(700)];
    const encode = packetEncoder(id, key, p => packets.push(p)); encode(input); encode(input); encode(input);
    const output: Buffer[] = [], decoder = packetDecoder(id, key, b => output.push(b));
    const bad = Buffer.from(packets[0]); bad[30] ^= 1; decoder.push(bad, 0);
    const wrong = packetDecoder(id, "ff".repeat(32), () => assert.fail()); wrong.push(packets[0]);
    assert.equal(wrong.stats.rejected, 1);
    decoder.push(packets[0], 0); decoder.push(packets[0], 1);
    // Two losses cannot be recovered; next groups wait until the 100ms deadline.
    decoder.push(packets[3], 2); decoder.push(packets[4], 2);
    assert.equal(output.length, 0); decoder.tick(101);
    assert.deepEqual(output, input); assert.equal(decoder.stats.lostGroups, 1); assert.equal(decoder.stats.rejected, 1);
    decoder.push(packets[1], 102); assert.deepEqual(output, input);
});

test("UDP resumes after an authenticated gap larger than its reorder window", () => {
    const packets: Buffer[] = [], encode = packetEncoder(id, key, packet => packets.push(packet));
    for (let i = 0; i <= 130; i++) encode([Buffer.from([i])]);
    const output: Buffer[] = [], decoder = packetDecoder(id, key, chunk => output.push(chunk));
    decoder.push(packets[0], 0); decoder.push(packets[260], 1000);
    assert.deepEqual(output, [Buffer.from([0]), Buffer.from([130])]);
    assert.equal(decoder.stats.lostGroups, 129);
});

test("UDP does not mistake a sender pause in the current group for packet loss", () => {
    const packets: Buffer[] = [], input = [randomBytes(500), randomBytes(700)];
    packetEncoder(id, key, packet => packets.push(packet))(input);
    const output: Buffer[] = [], decoder = packetDecoder(id, key, chunk => output.push(chunk));
    decoder.push(packets[0], 0); decoder.tick(1000);
    assert.equal(decoder.stats.lostGroups, 0); assert.equal(output.length, 0);
    decoder.push(packets[1], 1001);
    assert.deepEqual(output, input); assert.equal(decoder.stats.lostGroups, 0);
});

test("UDP interleaving turns a 6-packet burst loss into recoverable single losses", () => {
    const input = Array.from({ length: 64 }, (_, i) => randomBytes(200 + i));
    const sent: Buffer[] = [], mixer = interleaver(packet => sent.push(packet));
    const encode = packetEncoder(id, key, packet => mixer.push(packet));
    for (let i = 0; i < 64; i += 8) encode(input.slice(i, i + 8));
    assert.equal(sent.length, 72);
    const output: Buffer[] = [], decoder = packetDecoder(id, key, chunk => output.push(chunk));
    sent.filter((_, i) => i < 30 || i >= 36).forEach(packet => decoder.push(packet, 0));
    assert.deepEqual(output, input); assert.equal(decoder.stats.recovered, 6); assert.equal(decoder.stats.lostGroups, 0);
});
