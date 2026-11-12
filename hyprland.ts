// SPDX-License-Identifier: GPL-3.0-or-later
// Overlay de anotações no Hyprland: no Wayland o Electron não fixa, não posiciona nem exclui
// janelas da captura por si. No Hyprland com config Lua (0.53+) a regra nomeada via hyprctl
// eval resolve: flutuante, fixada em todas as workspaces, sem roubar foco e fora da transmissão
// (no_screen_share, o novo nome do no_screencopy); no_blur e no_shadow evitam o blur do
// compositor sobre a tela toda (janela transparente em tela cheia desfocaria tudo atrás).
// Os dispatchers de janela alinham a geometria (o setBounds do Electron não posiciona no
// Wayland). Versões antigas recebem windowrulev2.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export const OVERLAY_TITLE = "FockyTV Ink";

export function isHyprland(env: NodeJS.ProcessEnv = process.env) {
    return env.HYPRLAND_INSTANCE_SIGNATURE !== undefined;
}

// Regra NOMEADA: re-registrar atualiza a mesma regra no Hyprland novo (idempotente).
export async function applyOverlayRules(exec: typeof run = run) {
    const title = JSON.stringify(OVERLAY_TITLE);
    try {
        return await hyprctl(["eval", `hl.window_rule({ name = 'fockytv-ink', match = { title = ${title} }, float = true, pin = true, no_focus = true, no_screen_share = true, no_blur = true, no_shadow = true })`], exec);
    } catch {
        // Hyprland pré-Lua: keyword com a sintaxe clássica e o nome antigo da regra de captura.
        for (const rule of [`float, title:${title}`, `pin, title:${title}`, `nofocus, title:${title}`, `noblur, title:${title}`, `noshadow, title:${title}`, `noborder, title:${title}`])
            await hyprctl(["keyword", "windowrulev2", rule], exec);
        try {
            await hyprctl(["keyword", "windowrulev2", `noscreenshare, title:${title}`], exec);
        } catch {
            await hyprctl(["keyword", "windowrulev2", `no_screencopy, title:${title}`], exec);
        }
        return "";
    }
}

export type HyprlandClient = { address: string; title: string; floating: boolean; };

// Alinha o overlay ao monitor compartilhado; a regra acima já o deixa flutuante e fixado.
export async function placeOverlay(bounds: { x: number; y: number; width: number; height: number; }, exec: typeof run = run) {
    const clients = JSON.parse(await hyprctl(["-j", "clients"], exec)) as HyprlandClient[];
    const client = clients.find(entry => entry.title === OVERLAY_TITLE);
    if (!client) return false;
    const target = `address:${client.address}`;
    try {
        await hyprctl(["eval", `hl.dsp.window.resize({ x = ${bounds.width}, y = ${bounds.height}, window = '${target}' })`], exec);
        await hyprctl(["eval", `hl.dsp.window.move({ x = ${bounds.x}, y = ${bounds.y}, window = '${target}' })`], exec);
    } catch {
        await hyprctl(["dispatch", "resizewindowpixel", `exact ${bounds.width} ${bounds.height},${target}`], exec);
        await hyprctl(["dispatch", "movewindowpixel", `exact ${bounds.x} ${bounds.y},${target}`], exec);
    }
    return true;
}

export async function hyprctl(args: string[], exec: typeof run = run) {
    return (await exec("hyprctl", args, { timeout: 5_000 })).stdout;
}
