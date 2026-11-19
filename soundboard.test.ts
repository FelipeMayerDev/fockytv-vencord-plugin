// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

import { discordPatches } from "./discord";
import { soundboardClip } from "./soundboard";

const source = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
const gate = source.slice(source.indexOf("function soundboardEnabled()"), source.indexOf("function playSoundboardClip("));

test("reprodução fica na chamada atual e respeita silêncio, volume, cooldown e plugin desligado", () => {
    const events: any[] = [];
    let channelId: string | undefined = "123456", deaf = false, muted = false, peerChannel = channelId, now = 1000;
    let branch = "main";
    const media = { isSelfDeaf: () => deaf, isLocalMute: () => muted, getLocalVolume: () => 50 };
    const code = source.slice(source.indexOf("const soundCooldowns ="), source.indexOf("let watchModal:"));
    const api = new Function("SelectedChannelStore", "MediaEngineStore", "VoiceStateStore", "FluxDispatcher", "performance", "UserStore", "ChannelStore", "channel",
        `let routingEnabled = true; ${stripTypeScriptTypes(code)}; return { playSoundboardClip, stop() { routingEnabled = false; } };`)(
        { getVoiceChannelId: () => channelId }, media, { getVoiceStateForUser: () => ({ channelId: peerChannel }) },
        { dispatch: (event: any) => events.push(event) }, { now: () => now }, { getCurrentUser: () => ({ id: "111111" }) }, { getChannel: () => ({ guild_id: "555555" }) }, () => branch);
    const clip = { soundId: "999999", volume: 0.8 };
    api.playSoundboardClip(clip, "222222");
    assert.equal(events.length, 0, "main ignora sons recebidos pelo plugin");
    branch = "insider";
    api.playSoundboardClip(clip, "222222");
    assert.equal(events[0].type, "VOICE_CHANNEL_EFFECT_SEND");
    assert.equal(events[0].userId, "222222", "mutar soundboard usa o autor real no player nativo");
    assert.equal(events[0].soundVolume, 0.4);
    api.playSoundboardClip(clip, "222222");
    assert.equal(events.length, 1);
    now += 1000;
    deaf = true; api.playSoundboardClip(clip, "222222"); deaf = false;
    muted = true; api.playSoundboardClip(clip, "222222"); muted = false;
    peerChannel = "654321"; api.playSoundboardClip(clip, "222222"); peerChannel = channelId;
    channelId = undefined; api.playSoundboardClip(clip, "222222"); channelId = peerChannel;
    assert.equal(events.length, 1);
    api.playSoundboardClip(clip, "111111");
    assert.equal(events[1].type, "GUILD_SOUNDBOARD_SOUND_PLAY_LOCALLY");
    assert.equal(events[1].sound.volume, 0.4);
    api.stop();
    now += 1000;
    api.playSoundboardClip(clip, "222222");
    assert.equal(events.length, 2);
});

test("envio interceptado respeita permissões do servidor e só toca após conectar", () => {
    let now = 1000, connected = false, deaf = false;
    let denied = "", channelId = "123456", guildId = "555555", branch = "main";
    const sent: any[] = [], played: any[] = [], notices: any[] = [];
    const code = source.slice(source.indexOf("    playSoundboard(value:"), source.indexOf("    settingsAboutComponent:"));
    const api = new Function("SelectedChannelStore", "MediaEngineStore", "UserStore", "ChannelStore", "PermissionStore", "PermissionsBits", "watch", "soundboardClip", "playSoundboardClip", "FluxDispatcher", "performance", "showNotification", "channel",
        `let lastSoundSent = -Infinity, routingEnabled = true;
        ${gate}
        ${stripTypeScriptTypes(`const plugin = { ${code} };`)}
        return { ...plugin, enabled(value) { routingEnabled = value; } };`)(
        { getVoiceChannelId: () => channelId }, { isSelfDeaf: () => deaf }, { getCurrentUser: () => ({ id: "111111" }) },
        { getChannel: () => ({ guild_id: guildId }) }, { can: (permission: string) => permission !== denied },
        { SPEAK: "speak", USE_SOUNDBOARD: "soundboard", USE_EXTERNAL_SOUNDS: "external" },
        { sendSound: (clip: unknown) => { if (connected) sent.push(clip); return connected; } }, soundboardClip,
        (clip: unknown) => played.push(clip), { dispatch() {} }, { now: () => now }, (notice: unknown) => notices.push(notice), () => branch);
    const clip = { soundId: "999999", volume: 1, guildId: "777777" };
    assert.equal(api.playSoundboard(clip, channelId), false, "main mantém envio nativo");
    assert.equal(sent.length, 0);
    assert.equal(notices.length, 0);
    branch = "insider";
    assert.equal(api.playSoundboard(clip, "654321"), false);
    api.enabled(false); assert.equal(api.playSoundboard(clip, channelId), false); api.enabled(true);
    api.playSoundboard(clip, channelId);
    assert.equal(notices.length, 1);
    assert.equal(played.length, 0);
    connected = true;
    for (denied of ["speak", "soundboard"]) api.playSoundboard(clip, channelId);
    denied = "";
    deaf = true; api.playSoundboard(clip, channelId); deaf = false;
    assert.equal(sent.length, 0);
    api.playSoundboard(clip, channelId);
    api.playSoundboard(clip, channelId);
    assert.equal(sent.length, 1);
    assert.equal(played.length, 1);
    now += 1000;
    denied = "external";
    api.playSoundboard(clip, channelId);
    assert.equal(sent.length, 2, "relay do plugin não exige permissão de sons externos do Discord");
});

test("Insider libera as três checagens de sons externos; main conserva as permissões", () => {
    const patch = discordPatches.find(patch => patch.all)!;
    const replacement = patch.replacement as { match: RegExp; replace: string; };
    const pattern = new RegExp(replacement.match.source.replaceAll("\\i", "[A-Za-z_$][\\w$]*"), replacement.match.flags);
    // Formas atuais do cadeado, filtro de servidores e validação do clique do Discord.
    const checks = [
        'function check(e){let d=p.Ay.canUseSoundboardEverywhere(e);return r.A.can(l.xB.USE_EXTERNAL_SOUNDS,e)&&d}',
        'function check(e){let allowed=r.A.can(l.xB.USE_EXTERNAL_SOUNDS,e);return p.Ay.canUseSoundboardEverywhere(e)&&allowed}',
        'function check(e){return r.A.can(l.xB.USE_EXTERNAL_SOUNDS,e)&&p.Ay.canUseSoundboardEverywhere(e)}'
    ];
    for (const original of checks) {
        assert.equal((patch.find as RegExp).test(original), true);
        const patched = original.replace(pattern, replacement.replace);
        assert.notEqual(patched, original);
        for (const insider of [false, true]) for (const permitted of [false, true]) {
            const check = new Function("$self", "p", "r", "l", `${patched};return check;`)(
                { soundboardEnabled: () => insider }, { Ay: { canUseSoundboardEverywhere: () => true } },
                { A: { can: () => permitted } }, { xB: { USE_EXTERNAL_SOUNDS: 1n } });
            assert.equal(check({}), insider || permitted);
        }
    }
});

test("soundboard aceita somente IDs do Discord e volume finito, sem repassar URLs", () => {
    assert.deepEqual(soundboardClip({ soundId: "123456789012345678", volume: 0.5, url: "https://evil.test" }), { soundId: "123456789012345678", volume: 0.5 });
    assert.deepEqual(soundboardClip({ soundId: "1", volume: 0 }), { soundId: "1", volume: 0 });
    for (const value of [null, [], {}, { soundId: "../x", volume: 1 }, { soundId: "1?x", volume: 1 },
        { soundId: "1".repeat(26), volume: 1 }, { soundId: 1, volume: 1 },
        ...[NaN, Infinity, -1, 1.01, "1", undefined].map(volume => ({ soundId: "1", volume }))])
        assert.equal(soundboardClip(value), null);
});

test("patches liberam Nitro no cliente e interceptam o envio sem duplicar a chamada nativa", () => {
    const apply = (find: string, source: string) => {
        const patch = discordPatches.find(patch => patch.find === find)!;
        const replacement = patch.replacement as { match: RegExp; replace: string; };
        const pattern = new RegExp(replacement.match.source.replaceAll("\\i", "[A-Za-z_$][\\w$]*"), replacement.match.flags);
        const result = source.replace(pattern, replacement.replace);
        assert.notEqual(result, source);
        return result;
    };
    const available = apply('type:"GUILD_SOUNDBOARD_SOUND_CREATE"', '({type:"GUILD_SOUNDBOARD_SOUND_CREATE",available:e.available})');
    for (const insider of [false, true]) {
        const self = { soundboardEnabled: () => insider };
        assert.equal(new Function("$self", "e", `return ${available};`)(self, { available: false }).available, insider);
    }
    assert.match(apply(".SEND_SOUNDBOARD_SOUND(", "function a(e,t,n,r){(0,o.x)(t,e);return api.SEND_SOUNDBOARD_SOUND(t)}"), /if\(\$self.playSoundboard\(e,t\)\)return;\(0,o.x\)/);
});

test("patch da checagem premium cobre o canUseSoundboardEverywhere atual e libera sons de outros servidores no insider", () => {
    const patch = discordPatches.find(patch => patch.find === "SOUNDBOARD_EVERYWHERE,e")!;
    const replacement = patch.replacement as { match: RegExp; replace: string; };
    const pattern = new RegExp(replacement.match.source.replaceAll("\\i", "[A-Za-z_$][\\w$]*"), replacement.match.flags);
    const original = "function T(e){return f(r.bb.SOUNDBOARD_EVERYWHERE,e)}";
    assert.equal(patch.find === "SOUNDBOARD_EVERYWHERE,e" && original.includes(patch.find), true, "a âncora deve achar o módulo do gate premium");
    const patched = original.replace(pattern, replacement.replace);
    assert.notEqual(patched, original, "a forma atual do gate precisa casar com o match");
    for (const insider of [false, true]) {
        const canUseSoundboardEverywhere = new Function("$self", "f", "r", `${patched};return T;`)(
            { soundboardEnabled: () => insider }, () => false, { bb: { SOUNDBOARD_EVERYWHERE: 4n } });
        assert.equal(canUseSoundboardEverywhere({ premiumType: 0 }), insider, "sem Nitro: insider libera, main conserva o bloqueio");
    }
});
