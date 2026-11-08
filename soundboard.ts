// SPDX-License-Identifier: GPL-3.0-or-later
export interface SoundboardClip { soundId: string; volume: number; }

// Só IDs do CDN do Discord; mensagens da sala nunca escolhem uma URL de áudio.
export function soundboardClip(value: unknown): SoundboardClip | null {
    const clip = value as Partial<SoundboardClip> | null;
    if (!clip || typeof clip.soundId !== "string" || !/^\d{1,25}$/.test(clip.soundId) ||
        typeof clip.volume !== "number" || !Number.isFinite(clip.volume) || clip.volume < 0 || clip.volume > 1) return null;
    return { soundId: clip.soundId, volume: clip.volume };
}
