// SPDX-License-Identifier: GPL-3.0-or-later
import { constants } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";

export const sharePickers = ["hyprland-share-picker", "hyprland-preview-share-picker"] as const;
export type SharePicker = typeof sharePickers[number];

function pickerEntry(config: string) {
    const blocks = [...config.matchAll(/^\s*screencopy\s*\{[^{}]*\}/gm)];
    if (blocks.length !== 1) throw new Error("Configuração screencopy ausente ou ambígua em xdph.conf.");
    const block = blocks[0];
    const entries = [...block[0].matchAll(/^([^\S\r\n]*custom_picker_binary[^\S\r\n]*=[^\S\r\n]*)([^\s#]+)[^\S\r\n]*(?:#[^\r\n]*)?\r?$/gm)];
    if (entries.length !== 1) throw new Error("custom_picker_binary ausente ou ambíguo em xdph.conf.");
    const entry = entries[0];
    return { picker: entry[2], start: block.index! + entry.index! + entry[1].length };
}

export async function readSharePicker(path: string) {
    const { picker } = pickerEntry(await readFile(path, "utf8"));
    return picker;
}

export async function writeSharePicker(path: string, picker: SharePicker) {
    if (!sharePickers.includes(picker)) throw new Error("Seletor de compartilhamento inválido.");
    const config = await readFile(path, "utf8");
    const entry = pickerEntry(config);
    if (entry.picker === picker) return false;
    // Guarda a configuração anterior à primeira troca pelo plugin.
    try { await copyFile(path, `${path}.fockytv.bak`, constants.COPYFILE_EXCL); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await writeFile(path, config.slice(0, entry.start) + picker + config.slice(entry.start + entry.picker.length));
    return true;
}

// Sink virtual do venmic (áudio de tela do Vesktop): com o monitor ou o sink mutado a live sai em silêncio
// absoluto. Algo no PipeWire/WirePlumber volta a mutar (visto em 2026-11-07 e 11-09) sem estado salvo.
export function mutedShareSinks(dump: { id: number; info?: { props?: Record<string, unknown>; params?: { Props?: Record<string, unknown>[]; }; }; }[]) {
    return dump.filter(node => node.info?.props?.["node.name"] === "vencord-sink" &&
        node.info.params?.Props?.some(props => props.monitorMute === true || props.mute === true)).map(node => node.id);
}
