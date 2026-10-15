// SPDX-License-Identifier: GPL-3.0-or-later
export interface ShareQuality { fps: number; resolution: number; soundshareEnabled?: boolean; preset?: number; }

export function shareQuality(value: Partial<ShareQuality>, defaults: Partial<ShareQuality>): ShareQuality {
    const fps = value.fps ?? defaults.fps;
    const resolution = value.resolution ?? defaults.resolution;
    if (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0 || fps > 240 ||
        typeof resolution !== "number" || !Number.isFinite(resolution) || resolution < 0 || resolution > 4320)
        throw new Error("Qualidade de transmissão inválida no Discord.");
    return { fps, resolution, soundshareEnabled: value.soundshareEnabled ?? defaults.soundshareEnabled, preset: value.preset ?? defaults.preset };
}

export function qualityConstraints({ fps, resolution }: ShareQuality): MediaTrackConstraints {
    return {
        frameRate: { ideal: fps, max: fps },
        ...(resolution ? { height: { ideal: resolution, max: resolution } } : {})
    };
}
