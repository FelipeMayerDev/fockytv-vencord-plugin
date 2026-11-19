// SPDX-License-Identifier: GPL-3.0-or-later
// Amostras do código real do Discord na ordem de discordPatches: uma por patch, para o
// self-check do instalador e os testes confirmarem que o match continua casando.
export const discordFixtures = [
    'function T(e){return f(r.bb.SOUNDBOARD_EVERYWHERE,e)}',
    'case"GUILD_SOUNDBOARD_SOUND_CREATE":return{type:"GUILD_SOUNDBOARD_SOUND_CREATE",sound:{soundId:e.sound_id,available:e.available}}',
    'let u=null!=t&&(s.Ay.can(c.Pl.USE_EXTERNAL_SOUNDS,t)||n),d=canUseSoundboardEverywhere(e)',
    'let L=(0,l.I5)(e,c.PremiumTypes.TIER_2),x=r.default.isPremium(e,c.PremiumTypes.TIER_2);return{isNitroLocked:!L}',
    'function h(e,t,n,r){(0,o.a)(t,e),i.SEND_SOUNDBOARD_SOUND(e)}',
    'if(null==(b="number"==typeof e?s.Ay.getGameForPID(e):e))return[!1,"no source"];',
    'setVideoEnabled(e){e&&(0,u.PX)(),a.h.dispatch({type:"MEDIA_ENGINE_SET_VIDEO_ENABLED",enabled:e})}',
    'isVideoEnabled(){return tm&&tL}isVideoAvailable(){return Object.values(tA).some(e=>!e.disabled)}',
    'getInitialState(){return{selfVideo:I.Ay.isVideoEnabled(),flags:0}}getNextState(e){return{selfVideo:I.Ay.isVideoEnabled()}}',
    'let n={channelId:t.channelId,selfStream:t.selfStream,selfVideo:t.selfVideo,sessionId:t.sessionId,suppress:t.suppress}',
    'streamWatch(e){this.send(e2.STREAM_WATCH,{stream_key:e})}streamDelete(e){this.send(e2.STREAM_DELETE,{stream_key:e})}',
    'getCurrentUserActiveStream(){return null}',
    'l.h.dispatch({type:"STREAM_STOP",streamKey:e,appContext:"APP"})',
    'getStreamForUser(u,g){return null}getActiveStreamForStreamKey(k){return null}getViewerIds(e){return []}getAllActiveStreams(){return []}getAllActiveStreamsForChannel(c){return []}' +
        'VOICE_STATE_UPDATES:function(e){return e.voiceStates.reduce((e,t)=>{let{userId:i,guildId:a,channelId:s,sessionId:o,selfStream:d,discoverable:c}=t;if(d&&null!=s)return!0},!1)}',
    'getVideoComponent(){return engine.Video}',
    'function E(e,t,E){if(u.isPlatformEmbedded)(0,r.mM)(async()=>{return t=>(0,i.jsx)(e,{...t,analyticsLocations:E})});else{let n=l.A.getChannel(t);d.Ay.getMediaEngine().getDesktopSource(i,!0).then(n=>{(0,a.XI)(e,t,{pid:null,sourceId:n,sourceName:null,analyticsLocations:E})})}}',
    'children:[w??Q.Ay.getName($),z?(0,i.jsxs)("span",{className:en.IW,children:["\\xa0",et.intl.string(et.t["pFO/Ph"])]}):""]' +
        ',l={primaryGuild:$.primaryGuild,userId:$.id},(0,i.jsx)(GuildTag,{...l,children:n}),(0,i.jsx)(VoiceIcons,{disabled:x,...g,isHovered:ec})',
    'b&&ei.push((0,i.jsx)(m.m,{text:et.intl.string(et.t["JH1SJ+"]),children:(0,i.jsx)(E.EyeIcon,{size:"xs",color:"currentColor",className:a()(en.Kk,y)})},"watch"));let er=1,ea=(0,i.jsx)(ec,{userId:H.id})},`${H.id}-game`):null;return(X&&null!=ea&&ei.push(ea),_&&!Y&&ei.push((0,i.jsx)(D.Ay,{size:D.Ay.Sizes.SMALL},"stream")));(s=a()(en.my,{[en.Jb]:d===Y.OSZ.LARGE,[en.dT]:d===Y.OSZ.SMALL,[en.DF]:X}),t={backgroundImage:`url(${$.getAvatarURL(U,38)})`})',
    'createExperiment({name:"2026-08-video-guard",kind:"user",defaultConfig:{videoEnabled:!0},variations:{1:{videoEnabled:!1},2:{videoEnabled:!1}}})',
    'async function w(g,c,u){if(!s.A.shouldFetchPreview(g,c,u))return;d.h.dispatch({type:"STREAM_PREVIEW_FETCH_START",streamKey:"key"})}',
    'P=r.useCallback((e,r,a,s)=>{if(e){if(null!=_){}}},[]);let J=h.isPlatformEmbedded?(0,i.jsx)(s.Dr,{id:"stream-settings",children:j}):null;',
    'function x(e){!0!==e.noTrack&&(0,S.K2)(e.preset,e.resolution,e.frameRate,e.soundshareEnabled),l.h.dispatch({type:"STREAM_UPDATE_SETTINGS",...e})}',
    '[B,K]=(0,r.yK)([_.A],()=>[_.A.getStreamForUser(f,s.getGuildId()),_.A.getActiveStreamForUser(f,s.getGuildId())],[s,f]),Y=1;return(0,n.jsx)(V.Ay,{...e,isStreaming:null!=B&&B.channelId===s.id,isWatching:null!=K&&K.state!==P.XYD.ENDED})',
    'if(0===w.length)return null;if(_)return(0,i.jsx)(P,{maxVisibleUsers:A,users:w,guildId:a,channelId:t,className:u,participantType:l.type});let F=o()(w).take(A)',
    'return(0,M.jsxs)("div",{className:DQ.uu,children:[(0,M.jsx)(vP,{channel:t,enableActivities:c,disabled:!r&&i}),(0,M.jsx)(vw,{channel:t,canGoLive:n,enableActivities:c,disabled:!1})]})',
    'children:[(0,s.jsx)(V,{accountContainerRef:B,nameplate:k}),(0,s.jsx)(M,{})]',
    'getParticipants(e){return $(e).toArray()??P}getFilteredParticipants(e){let t=$(e);return H[e]?t.toArray(1):t.toArray(2)}getVideoParticipants(e){return $(e).toArray(3)??P}' +
        'getParticipant(e,t){return $(e).getParticipant(t)}getSelectedParticipant(e){let t=this.getSelectedParticipantId(e);return null==t?null:$(e).getParticipant(t)}getParticipantsVersion(e){return $(e).version}getMode(e){return "voice"}' +
        'function r(e){let n=$(e),[s]=q(e);if(s!==A&&s!==N){let e=n.getParticipant(s);(null==e||e.type===S&&null==g(e.id))&&(s=N)}}',
    // Barra de título (2026-11), já com o Fragment trocado pelo VencordToolbox.
    'trailing:(0,b.jsxs)(Vencord.Plugins.plugins["VencordToolbox"].TrailingWrapper,{children:[l&&(0,b.jsx)(si,{}),n?(0,b.jsx)(af,{focusSectionProps:"HELP"===A?e:void 0}):(0,b.jsx)(al,{focusSectionProps:"HELP"===A?e:void 0}),i&&(0,b.jsx)(sr,{})]})'
];
