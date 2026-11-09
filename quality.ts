// SPDX-License-Identifier: GPL-3.0-or-later
// Teto das lives: sem simulcast cada espectador custa o bitrate inteiro no upload do servidor (~150 Mbps),
// e 4K a 20 Mbps já chegava com perda da internet de quem transmite. "Fonte" (0) vira 1080p.
export const MAX_RESOLUTION = 1080, MAX_BITRATE = 12;

export interface ShareQuality { fps: number; resolution: number; soundshareEnabled?: boolean; preset?: number; }

export function shareQuality(value: Partial<ShareQuality>, defaults: Partial<ShareQuality>): ShareQuality {
    const fps = value.fps ?? defaults.fps;
    const resolution = value.resolution ?? defaults.resolution;
    if (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0 || fps > 240 ||
        typeof resolution !== "number" || !Number.isFinite(resolution) || resolution < 0 || resolution > 4320)
        throw new Error("Qualidade de transmissão inválida no Discord.");
    return { fps, resolution: Math.min(resolution || MAX_RESOLUTION, MAX_RESOLUTION), soundshareEnabled: value.soundshareEnabled ?? defaults.soundshareEnabled, preset: value.preset ?? defaults.preset };
}

export function qualityConstraints({ fps, resolution }: ShareQuality): MediaTrackConstraints {
    return {
        frameRate: { ideal: fps, max: fps },
        ...(resolution ? { height: { ideal: resolution, max: resolution } } : {})
    };
}
