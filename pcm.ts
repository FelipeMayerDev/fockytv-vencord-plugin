// SPDX-License-Identifier: GPL-3.0-or-later
export function pcmHeader(bytes: Uint8Array) {
    if (bytes.length < 16 || String.fromCharCode(...bytes.subarray(0, 4)) !== "FPCM")
        throw new Error("Cabeçalho PCM inválido.");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const rate = view.getUint32(4, true), channels = view.getUint32(8, true);
    if (rate < 8000 || rate > 192000 || ![1, 2].includes(channels))
        throw new Error("Formato PCM incompatível.");
    return { rate, channels };
}

// Conserva frames incompletos; limita a fila para uma pausa do renderer não acumular atraso.
export class PcmBuffer {
    private bytes = new Uint8Array(0);
    constructor(private frameBytes: number, private maxBytes: number) { }
    push(chunk: Uint8Array) {
        const next = new Uint8Array(this.bytes.length + chunk.length);
        next.set(this.bytes); next.set(chunk, this.bytes.length);
        const excess = Math.max(0, Math.ceil((next.length - this.maxBytes) / this.frameBytes) * this.frameBytes);
        this.bytes = next.subarray(excess);
    }
    drain() {
        const end = this.bytes.length - this.bytes.length % this.frameBytes;
        const result = this.bytes.slice(0, end);
        this.bytes = this.bytes.slice(end);
        return result;
    }
}
