// SPDX-License-Identifier: GPL-3.0-or-later
// Guarda de boot: uma atualização do Discord ou um patch nosso pode derrubar o renderer e
// prender o usuário num Discord que não abre. O native (processo main, carregado antes do
// renderer) conta as quedas: boot sem chegar ao "healthy" soma uma strike; na segunda
// seguida o plugin sai das configurações do Vencord antes de o renderer ler o arquivo,
// e o Discord abre com ele inativo e com o aviso de reativação no painel.

export type BootGuard = { strikes?: number; };
export const BOOT_GUARD_STRIKES = 2;

// Arquivo ausente = boot novo sendo acompanhado (sem strike). Arquivo presente = a
// inicialização anterior não terminou limpa (sem healthy, sem will-quit): soma strike.
export function bootGuardVerdict(guard: BootGuard | null) {
    if (!guard) return { strikes: 0, disable: false };
    const strikes = (guard.strikes ?? 0) + 1;
    return { strikes, disable: strikes >= BOOT_GUARD_STRIKES };
}

// Desativa o plugin nas configurações do Vencord e marca o motivo, preservando o resto
// do arquivo (inclusive configurações de outros plugins e as nossas próprias opções).
export function disablePluginSettings(data: unknown): Record<string, unknown> {
    const settings = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
    const plugins = settings.plugins && typeof settings.plugins === "object" && !Array.isArray(settings.plugins)
        ? settings.plugins as Record<string, unknown>
        : settings.plugins = {};
    const fockytv = plugins.FockyTV && typeof plugins.FockyTV === "object" && !Array.isArray(plugins.FockyTV)
        ? plugins.FockyTV as Record<string, unknown>
        : plugins.FockyTV = {};
    fockytv.enabled = false;
    fockytv.crashDisabled = true;
    return settings;
}
