// SPDX-License-Identifier: GPL-3.0-or-later
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { showNotification } from "@api/Notifications";
import { definePluginSettings } from "@api/Settings";
import { copyToClipboard } from "@utils/clipboard";
import { IS_WINDOWS } from "@utils/constants";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Participant, RenderModalProps, Stream, UserParticipant } from "@vencord/discord-types";
import { findComponentByCodeLazy, findStoreLazy } from "@webpack";
import { ApplicationStreamingStore, ApplicationStreamPreviewStore, Button, ChannelRTCStore, ChannelStore, FluxDispatcher, MediaEngineStore, Menu, Modal, openModal, React, SelectedChannelStore, UserStore, VoiceStateStore, Tooltip, useEffect, useRef, useState, useStateFromStores } from "@webpack/common";

import { fockyActivity } from "./activity";
import { screenAudio } from "./audio";
import { captureNativeCamera, syncCameraFilter } from "./camera";
import { videoStats } from "./diagnostics";
import { captureConstraints, DiscordSource, discordPatches, matchCamera, nativeSource } from "./discord";
import { GithubFetch, githubError, repositoryName } from "./github";
import { GithubQueueRequest, markGithubQueueSeen, mergeQueueState } from "./github-queue";
import { ActionIcon, GithubPanel, useGithubQueue } from "./github-panel";
import { jiraError, jiraSite } from "./jira";
import { bragaAbsence, jettaEntrance, showJetta } from "./jetta";
import { JiraFetch, JiraPanel } from "./jira-panel";
import { musicPlayer, spectrumPoints } from "./music";
import { lipSync } from "./lip-sync";
import { lyricsCanvas } from "./music-lyrics";
import { MusicPanel, useMusic } from "./music-panel";
import { streamAudio } from "./playback";
import { cameraKey, liveStyle, liveStyles, serverUrl, streamKey } from "./protocol";
import { detectProfile } from "./profile";
import { qualityConstraints, shareQuality, ShareQuality } from "./quality";
import { replayBuffer } from "./replay";
import { NativeShare, Request, Session } from "./session";
import { thumbnail } from "./thumbnail";
import { watchPluginUpdates } from "./update-events";
import { loadLivekit, proxySocket, receivedQuality, Viewing, watchLive } from "./viewer";
import { watchParty } from "./watch-party";
import { useWatch, WatchControls, WatchPartyPanel } from "./watch-party-panel";
import livekitSource from "file://./livekit-client.umd.js";
import managedStyle from "./style.css?managed";

const settings = definePluginSettings({
    hideLyrics: { type: OptionType.BOOLEAN, description: "Ocultar o tile com a letra da música na call.", default: false, onChange: () => routingEnabled && syncLyrics() },
    showActivity: { type: OptionType.BOOLEAN, description: "Mostrar no Discord a música ou live que você acompanha no FockyTV (a live tem prioridade).", default: true, onChange: () => syncActivity() },
    url: { type: OptionType.STRING, description: "Servidor FockyTV", default: "https://fockytv.felipemayer.com.br", isValid: value => { try { if (typeof value !== "string") return false; serverUrl(value); return true; } catch { return false; } } },
    nativeCapture: { type: OptionType.BOOLEAN, description: "Windows: capturar e codificar na GPU (WGC + NVENC/AMF/QSV para NVIDIA, AMD e Intel), sem passar pelo Chromium. Se falhar, usa a captura do Discord.", default: true },
    linuxSharePicker: { type: OptionType.COMPONENT, component: () => <LinuxSharePicker /> },
    nativeBitrate: { type: OptionType.SELECT, description: "Bitrate da captura nativa (vale na próxima live). Cada espectador recebe esse valor; abaixe se a imagem travar para quem assiste.", options: [4, 6, 8, 12].map(value => ({ label: `${value} Mbps`, value, default: value === 8 })) },
    liveStyle: { type: OptionType.COMPONENT, default: "rainbow", component: ({ setValue }) => <LiveStylePicker setValue={setValue} /> },
    liveTitle: { type: OptionType.STRING, description: "Título da live no aviso do canal (vazio: \"Live de <seu nome>\"). O jogo ou a janela transmitida aparece junto.", default: "" },
    replayBuffer: { type: OptionType.BOOLEAN, description: "Replay das lives assistidas: grava em segundo plano e o botão na live (ou Alt+Shift+R) salva os últimos 30 a 60 s em Vídeos/FockyTV. Usa um pouco de CPU enquanto você assiste (vale na próxima live assistida).", default: false },
    jiraSite: { type: OptionType.STRING, description: "Jira Cloud: endereço do site (https://empresa.atlassian.net).", default: "", isValid: value => { try { if (value) jiraSite(String(value)); return true; } catch { return false; } } },
    jiraEmail: { type: OptionType.STRING, description: "Jira Cloud: e-mail da sua conta Atlassian.", default: "" },
    jiraToken: { type: OptionType.COMPONENT, default: "", component: ({ setValue }) => <JiraTokenInput setValue={setValue} /> },
    githubToken: { type: OptionType.COMPONENT, default: "", component: ({ setValue }) => <GithubTokenInput setValue={setValue} /> },
    githubRepository: { type: OptionType.STRING, description: "GitHub: projeto pré-selecionado (dono/repositório). A escolha no painel fica salva aqui.", default: "", isValid: value => { try { if (value) repositoryName(String(value)); return true; } catch { return false; } } },
    jiraBoard: { type: OptionType.NUMBER, description: "Último board aberto no Jira.", default: 0, hidden: true },
    bragaLastArrival: { type: OptionType.NUMBER, description: "Última chegada observada do Braga.", default: 0, hidden: true },
    // Ausência inicial de 2 dias informada em 22/10/2026; a data fixa mantém o contador entre reinícios.
    bragaLastDeparture: { type: OptionType.NUMBER, description: "Última saída observada do Braga.", default: Date.parse("2026-10-20T16:14:40Z"), hidden: true },
    watchVolume: { type: OptionType.NUMBER, description: "Volume da watch party (0–1).", default: 0.5, hidden: true },
    musicVolume: { type: OptionType.NUMBER, description: "Volume do player de música da call (0–1).", default: 0.5, hidden: true }
});

// Token como senha: não fica à mostra na tela de configurações.
function JiraTokenInput({ setValue }: { setValue(value: unknown): void; }) {
    const [token, setToken] = useState(settings.store.jiraToken);
    return <section className="fockytv-setting">
        <h3>Jira Cloud: API token</h3>
        <p>Crie em id.atlassian.com → Segurança → Criar e gerenciar tokens de API. Com o site, o e-mail e o token preenchidos, o botão do Jira aparece ao lado do microfone.</p>
        <input className="fockytv-jira-input" type="password" autoComplete="off" aria-label="API token do Jira" value={token} onChange={event => { setToken(event.currentTarget.value); setValue(event.currentTarget.value.trim()); }} />
    </section>;
}
function GithubTokenInput({ setValue }: { setValue(value: unknown): void; }) {
    const [token, setToken] = useState(settings.store.githubToken);
    return <section className="fockytv-setting">
        <h3>GitHub: personal access token</h3>
        <p>Com o token preenchido, o botão do GitHub aparece ao lado do microfone. Crie um token com leitura de Metadata, Pull requests, Issues e Actions nos repositórios desejados. O token é salvo nas configurações locais do Vencord, como o do Jira.</p>
        <input className="fockytv-jira-input" type="password" autoComplete="off" spellCheck={false} aria-label="Personal access token do GitHub" value={token} onChange={event => { setToken(event.currentTarget.value); setValue(event.currentTarget.value.trim()); }} />
        <button type="button" className="fockytv-jira-button-secondary" onClick={() => void VencordNative.native.openExternal("https://github.com/settings/personal-access-tokens/new")}>Criar token no GitHub ↗</button>
    </section>;
}
// Botão do painel da conta (microfone, fone), o mesmo que o GameActivityToggle usa.
const PanelButton = findComponentByCodeLazy(".GREEN,positionKeyStemOverride:");
const RunningGameStore = findStoreLazy("RunningGameStore") as { getRunningGames(): { name?: string; windowHandle?: string | number; pid?: number; }[]; getVisibleGame(): { name?: string; windowHandle?: string | number; } | null; };

// Seu avatar com o anel e o selo "AO VIVO" do estilo, como os outros vão ver na lista de voz.
function LiveStylePreview({ style }: { style: string; }) {
    const user = UserStore.getCurrentUser();
    const live = style ? `fockytv-style-${style}` : "";
    return <div className="fockytv-preview">
        <div className={`fockytv-preview-avatar ${style ? `fockytv-avatar ${live}` : ""}`} style={user ? { backgroundImage: `url(${user.getAvatarURL(undefined, 48)})` } : undefined} />
        {user?.globalName ?? user?.username}
        <span className={`fockytv-preview-badge ${style ? `fockytv-badge ${live}` : ""}`}>AO VIVO</span>
    </div>;
}

function LiveStylePicker({ setValue }: { setValue(value: string): void; }) {
    const [current, setCurrent] = useState(() => liveStyle(settings.store.liveStyle));
    return <section className="fockytv-setting">
        <h3>Estilo da sua live</h3>
        <p>Anel no seu avatar e selo "AO VIVO" que quem tem o plugin vê enquanto você transmite (vale na próxima live). Passe o mouse para ver o preview.</p>
        <div className="fockytv-style-picker" role="group" aria-label="Estilo da sua live">
            {Object.entries(liveStyles).map(([value, label]) =>
                <Tooltip key={value} text={<LiveStylePreview style={value} />}>
                    {tooltip => <button {...tooltip} type="button" aria-pressed={current === value} className={`fockytv-style-option ${value ? `fockytv-style-${value}` : ""}`} onClick={() => { setCurrent(value); setValue(value); }}>
                        <span className="fockytv-style-swatch" />{label}
                    </button>}
                </Tooltip>)}
        </div>
    </section>;
}
const Native = VencordNative.pluginHelpers.FockyTV as PluginNative<typeof import("./native")>;
function LinuxSharePicker() {
    const [current, setCurrent] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    useEffect(() => {
        let mounted = true;
        void Native.getLinuxSharePicker().then(result => { if (mounted) setCurrent(result?.picker ?? null); })
            .catch(error => { if (mounted) setError(String(error)); });
        return () => { mounted = false; };
    }, []);
    if (current === null && !error) return null;
    const apply = async (picker: "hyprland-share-picker" | "hyprland-preview-share-picker") => {
        setBusy(true); setError("");
        try { setCurrent((await Native.setLinuxSharePicker(picker)).picker); }
        catch (error) {
            setError(String(error));
            const actual = await Native.getLinuxSharePicker().catch(() => null);
            if (actual) setCurrent(actual.picker);
        }
        finally { setBusy(false); }
    };
    return <section className="fockytv-setting">
        <h3>Linux / Hyprland: seletor de compartilhamento</h3>
        <p>Vale para todos os aplicativos. O padrão evita falhas de janelas ausentes no seletor com miniaturas. Aplicar reinicia o portal e interrompe capturas em andamento. A configuração anterior fica em xdph.conf.fockytv.bak.</p>
        <Button disabled={busy || current === "hyprland-share-picker"} onClick={() => void apply("hyprland-share-picker")}>Usar padrão (sem miniaturas)</Button>
        <Button disabled={busy || current === "hyprland-preview-share-picker"} onClick={() => void apply("hyprland-preview-share-picker")}>Usar miniaturas</Button>
        <p role="status">{busy ? "Aplicando…" : current ? `Atual: ${current === "hyprland-share-picker" ? "Padrão (sem miniaturas)" : current === "hyprland-preview-share-picker" ? "Com miniaturas" : "Personalizado"}` : ""}</p>
        {error && <p role="alert">{error}</p>}
    </section>;
}
const request: Request = (url, method, key, body) => Native.request(url, method, key, body);
const StreamingSettings = findStoreLazy("ApplicationStreamingSettingsStore") as { getState(): ShareQuality; };
const previewStreamId = "fockytv-preview";
const cameraStreamId = "fockytv-camera";
const lyricsStreamId = "fockytv-lyrics";
const partyStreamId = "fockytv-watch-party";
// Tiles extras só na grade local (letra e watch party).
const localTiles = new Map<string, { media: MediaStream; channel: string; participant: UserParticipant; }>();
let stopLyrics: (() => void) | undefined;
let stopPartyTile: (() => void) | undefined;
let partyVideo: HTMLVideoElement | undefined;
const watchStreamPrefix = "fockytv-watch:";
const watchCameraPrefix = "fockytv-camera:";
let OriginalVideo: React.ComponentType<VideoProps>;
interface VideoProps { streamId?: string; className?: string; onReady?: (() => void) | null; onResize?: (size: { width: number; height: number; }) => void; paused?: boolean; }
function PreviewVideo(props: VideoProps) {
    const video = useRef<HTMLVideoElement>(null);
    const camera = props.streamId === cameraStreamId;
    const remoteCamera = props.streamId?.startsWith(watchCameraPrefix) ? cameraViewers.get(props.streamId.slice(watchCameraPrefix.length))?.viewing?.media : undefined;
    const watched = props.streamId?.startsWith(watchStreamPrefix) ? watching.get(props.streamId.slice(watchStreamPrefix.length))?.viewing?.media : undefined;
    const local = props.streamId ? localTiles.get(props.streamId)?.media : undefined;
    const capture = local ?? (props.streamId?.startsWith(watchCameraPrefix) ? remoteCamera : watched ?? publishers.get(camera ? "camera" : "screen")?.capture);
    useEffect(() => {
        const element = video.current;
        if (!element) return;
        element.srcObject = capture ?? null;
        return () => { element.srcObject = null; };
    }, [capture]);
    useEffect(() => {
        if (props.paused) video.current?.pause();
        else void video.current?.play().catch(() => {});
    }, [capture, props.paused]);
    const resize = () => {
        if (video.current) props.onResize?.({ width: video.current.videoWidth, height: video.current.videoHeight });
    };
    const element = <video ref={video} className={props.className} autoPlay muted playsInline onResize={resize} onLoadedData={() => { resize(); props.onReady?.(); }} aria-label={props.streamId === lyricsStreamId ? "Letra da música (só você)" : props.streamId === partyStreamId ? "Watch party do YouTube" : remoteCamera ? "Câmera FockyTV" : watched ? "Live FockyTV" : "Preview da sua transmissão FockyTV"} style={{ width: "100%", height: "100%", objectFit: camera || remoteCamera ? "cover" : "contain", transform: local ? "none" : undefined }} />;
    if (props.streamId === partyStreamId) return <div className="fockytv-player">{element}<WatchControls player={watch} setVolume={setWatchVolume} /></div>;
    const pip = remoteCamera ?? watched;
    if (!pip) return element;
    // Webcam e live assistida têm PiP; o replay pertence só à live de tela.
    const key = watched ? props.streamId!.slice(watchStreamPrefix.length) : undefined;
    const stop = (event: React.SyntheticEvent) => event.stopPropagation();
    return <div className="fockytv-player">
        {element}
        <div className="fockytv-player-controls" onClick={stop} onDoubleClick={stop}>
            {key && watching.get(key)?.replay && <button type="button" className="fockytv-player-button" title="Salvar os últimos 30 a 60 s (Alt+Shift+R)" onClick={() => void saveReplay(key)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>Replay
            </button>}
            <button type="button" className="fockytv-player-button" title="Picture-in-picture" aria-label="Picture-in-picture" onClick={() => void togglePictureInPicture(pip)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor" /></svg>
            </button>
        </div>
    </div>;
}

// Picture-in-picture num <video> próprio: continua aberto quando o tile do Discord desmonta ao trocar de canal.
let pipVideo: HTMLVideoElement | undefined;
async function togglePictureInPicture(media: MediaStream) {
    try {
        if (document.pictureInPictureElement && pipVideo?.srcObject === media) return await document.exitPictureInPicture();
        if (!pipVideo) {
            pipVideo = Object.assign(document.createElement("video"), { muted: true, playsInline: true });
            pipVideo.addEventListener("leavepictureinpicture", () => { pipVideo!.srcObject = null; });
        }
        pipVideo.srcObject = media;
        await pipVideo.play();
        await pipVideo.requestPictureInPicture();
    } catch (error) {
        console.warn("FockyTV: picture-in-picture", error);
        void showNotification({ title: "FockyTV: picture-in-picture indisponível", body: String(error) });
    }
}

function closePictureInPicture(media?: MediaStream) {
    if (pipVideo && document.pictureInPictureElement === pipVideo && (!media || pipVideo.srcObject === media)) void document.exitPictureInPicture().catch(() => {});
}

async function saveReplay(key: string) {
    const replay = watching.get(key)?.replay;
    if (!replay) return;
    try {
        const blob = await replay.save();
        const file = await Native.saveReplay(liveOwners.get(ownerOf(key)) ?? "live", replay.extension, new Uint8Array(await blob.arrayBuffer()));
        void showNotification({ title: "FockyTV: replay salvo", body: `${file}\nClique para abrir a pasta.`, onClick: () => void Native.showReplay(file) });
    } catch (error) {
        console.error("FockyTV: replay", error);
        void showNotification({ title: "FockyTV: não foi possível salvar o replay", body: String(error) });
    }
}

function replayShortcut(event: KeyboardEvent) {
    if (!event.altKey || !event.shiftKey || event.ctrlKey || event.code !== "KeyR") return;
    const keys = [...watching].filter(([, entry]) => entry.replay).map(([key]) => key);
    if (!keys.length) return;
    event.preventDefault();
    keys.forEach(key => void saveReplay(key));
}
function VideoComponent(props: VideoProps) {
    return localTiles.has(props.streamId!) || props.streamId === previewStreamId || props.streamId === cameraStreamId || (props.streamId?.startsWith(watchStreamPrefix) || props.streamId?.startsWith(watchCameraPrefix)) ? <PreviewVideo {...props} /> : <OriginalVideo {...props} />;
}
function updatePreview(share: Stream, streamId: string | null) {
    // Só atualiza os stores locais de vídeo; não abre uma sessão Go Live no gateway.
    FluxDispatcher.dispatch({ type: "RTC_CONNECTION_VIDEO", guildId: share.guildId, channelId: share.channelId, userId: share.ownerId, streamId, rtcServerId: null, context: "stream" });
}
// Sempre o username do Discord: é por ele que o plugin dos outros reconhece a live na call.
const nickname = () => streamKey(UserStore.getCurrentUser()?.username || "");
// Toda mudança na câmera reflete no Discord (botão, quadro e preview), venha de onde vier.
const publishers = new class extends Map<"screen" | "camera", Session | NativeShare> {
    set(kind: "screen" | "camera", session: Session | NativeShare) { super.set(kind, session); setTimeout(syncCamera, 0); return this; }
    delete(kind: "screen" | "camera") { const deleted = super.delete(kind); setTimeout(syncCamera, 0); return deleted; }
    clear() { super.clear(); setTimeout(syncCamera, 0); }
}();
let cameraShown = false;
function syncCamera() {
    const active = publishers.has("camera");
    if (active === cameraShown) return;
    cameraShown = active;
    MediaEngineStore.emitChange();
    const userId = UserStore.getCurrentUser()?.id;
    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (!userId || !channelId) return;
    const guildId = ChannelStore.getChannel(channelId)?.guild_id ?? null;
    // Só nos stores locais: o gateway continua com selfVideo falso, ninguém vê câmera vazia.
    FluxDispatcher.dispatch({ type: "RTC_CONNECTION_VIDEO", guildId, channelId, userId, streamId: active ? cameraStreamId : null, rtcServerId: null, context: "default" });
    const state = VoiceStateStore.getVoiceStateForUser(userId);
    if (state) FluxDispatcher.dispatch({ type: "VOICE_STATE_UPDATES", voiceStates: [{ ...state, guildId, selfVideo: false }] });
}
const pending = new Set<"screen" | "camera">();
let generation = 0;
let routingEnabled = false;
let discordQuality: ShareQuality | null = null;
let shareChanges: Promise<void> = Promise.resolve();
let discordShare: (Stream & { state: "CONNECTING" | "ACTIVE"; }) | null = null;

function clearDiscordShare() {
    if (!discordShare) return;
    const share = discordShare;
    discordShare = null;
    discordQuality = null;
    ApplicationStreamingStore.emitChange();
    setTimeout(() => updatePreview(share, null), 0);
}
// Lives FockyTV de quem está na sua call, casadas pelo username do Discord (a stream key do plugin).
const liveOwners = new Map<string, string>(); // id do Discord → stream key FockyTV (sala LiveKit)
// Stream key do Discord ("guild:g:c:dono" / "call:c:dono") → live assistida.
const watching = new Map<string, { viewing?: Viewing; audio?: ReturnType<typeof streamAudio>; replay?: ReturnType<typeof replayBuffer>; unsync?: () => void; }>();
// Sem aceleração de hardware o Discord decodifica e compõe o vídeo no processador (ANGLE WARP):
// a imagem atrasa ~1 s e congela enquanto o som segue normal. Avisa uma vez por sessão.
let warnedSoftware = false;
function warnSoftwareVideo() {
    if (warnedSoftware || (window as any).DiscordNative?.gpuSettings?.getEnableHardwareAcceleration?.() !== false) return;
    warnedSoftware = true;
    void showNotification({ title: "FockyTV: aceleração de hardware desligada", body: "Sem ela o vídeo das lives atrasa e congela no Discord. Ative em Configurações → Avançado → Aceleração de hardware." });
}
// Toda stream FockyTV já assistida: fechar uma live que já acabou também não pode chegar ao gateway.
const fockyStreams = new Set<string>();
const cameraViewers = new Map<string, { room: string; channelId: string; viewing?: Viewing; }>();
function cameraVideo(userId: string, channelId: string, streamId: string | null) {
    FluxDispatcher.dispatch({ type: "RTC_CONNECTION_VIDEO", guildId: ChannelStore.getChannel(channelId)?.guild_id ?? null, channelId, userId, streamId, rtcServerId: null, context: "default" });
    const state = VoiceStateStore.getVoiceStateForUser(userId);
    if (state?.channelId === channelId) FluxDispatcher.dispatch({ type: "VOICE_STATE_UPDATES", voiceStates: [{ ...state, guildId: ChannelStore.getChannel(channelId)?.guild_id ?? null, selfVideo: false }] });
}
function endCamera(userId: string) {
    const entry = cameraViewers.get(userId);
    if (!entry) return;
    cameraViewers.delete(userId);
    if (entry.viewing) closePictureInPicture(entry.viewing.media);
    entry.viewing?.close();
    cameraVideo(userId, entry.channelId, null);
}
async function watchCamera(userId: string, room: string, channelId: string) {
    const entry: { room: string; channelId: string; viewing?: Viewing; } = { room, channelId };
    cameraViewers.set(userId, entry);
    try {
        livekit ??= loadLivekit(livekitSource, proxySocket(Native));
        const viewing = await watchLive(livekit, request, serverUrl(settings.store.url), room, nickname(), () => {
            if (cameraViewers.get(userId) === entry) endCamera(userId);
        });
        if (cameraViewers.get(userId) !== entry) { viewing.close(); return; }
        entry.viewing = viewing;
        cameraVideo(userId, channelId, watchCameraPrefix + userId);
    } catch (error) {
        if (cameraViewers.get(userId) === entry) endCamera(userId);
        console.warn("FockyTV: assistir câmera", error);
    }
}
// Toda renegociação da call manda o vídeo nativo (desligado) como null, apagando o quadro FockyTV do store:
// sem reaplicar, o tile fica sem stream e o Discord mostra "Erro ao iniciar a câmera" (2014) após 20 s.
function restoreCamera(userId: string, channelId: string) {
    if (channelId !== SelectedChannelStore.getVoiceChannelId()) return;
    if (userId === UserStore.getCurrentUser()?.id) { if (publishers.has("camera")) cameraVideo(userId, channelId, cameraStreamId); }
    else if (cameraViewers.get(userId)?.viewing) cameraVideo(userId, channelId, watchCameraPrefix + userId);
}
let livePoll: ReturnType<typeof setInterval> | undefined;
let updatePoll: ReturnType<typeof setInterval> | undefined;
let updateCheck: ReturnType<typeof setTimeout> | undefined;
let notifiedRevision = "";
let updateChecking = false, updateQueued = false;
let stopUpdateEvents: (() => void) | undefined;
let livekit: any;
const ownerOf = (key: string) => key.split(":").pop()!;
const keyOf = ({ guildId, channelId, ownerId }: { guildId?: string | null; channelId: string; ownerId: string; }) =>
    guildId ? `guild:${guildId}:${channelId}:${ownerId}` : `call:${channelId}:${ownerId}`;
type LiveQuality = { resolution: number; fps: number; style?: string; };
// Quem assiste cada live (stream key do Discord → ids): o Discord toca entrada/saída e mostra os avatares a partir disso.
const liveViewers = new Map<string, string[]>();
const webViewers = new Map<string, number>(); // stream key → quem assiste pelo site FockyTV (sessões sem membro da call)
const announcedQuality = new Map<string, string>(); // dono da live → qualidade já enviada ao selo do Discord
const ownerStyles = new Map<string, string>(); // dono da live → estilo do anel e do selo "AO VIVO"

// Só o dono da live vê quem está assistindo a ela.
const watchingMyLive = (userId: string) => !!discordShare && discordShare.ownerId !== userId && !!liveViewers.get(keyOf(discordShare))?.includes(userId);
// Componente, não constante: JSX no topo do módulo roda antes do React do Discord existir e derruba o Vencord inteiro.
const EyeIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>;
const UsersIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 19c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" /><path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4" /><path d="M18 13.4c2.2.8 3.5 2.9 3.5 5.6" /></svg>;

function liveSelfStream(state: { userId?: string; channelId?: string | null; selfStream?: boolean; }) {
    return !!state.selfStream || (!!state.userId && liveOwners.has(state.userId) && state.channelId != null && state.channelId === SelectedChannelStore.getVoiceChannelId());
}

async function refreshLives() {
    const channelId = SelectedChannelStore.getVoiceChannelId();
    const keys = new Map<string, string>(); // minúsculo → stream key exata
    const lives = new Map<string, { viewers: string[]; sessions: number; quality?: LiveQuality; }>(); // minúsculo → espectadores e qualidade
    if (channelId && routingEnabled) {
        try {
            const response = await request(`${serverUrl(settings.store.url)}/api/status`, "GET");
            if (response.status !== 200) return;
            for (const live of JSON.parse(response.body) as { streamKey: string; engine?: string; videoTracks?: unknown[]; sessions?: { viewer?: string; }[]; quality?: LiveQuality; }[])
                if (live.engine === "livekit" && live.videoTracks?.length) {
                    keys.set(live.streamKey.toLowerCase(), live.streamKey);
                    lives.set(live.streamKey.toLowerCase(), { viewers: (live.sessions ?? []).flatMap(session => session.viewer ? [session.viewer.toLowerCase()] : []), sessions: live.sessions?.length ?? 0, quality: live.quality });
                }
        } catch (error) { console.warn("FockyTV: lives", error); return; }
    }
    // Ignora respostas de uma chamada anterior ou de um plugin já desativado.
    if (channelId !== SelectedChannelStore.getVoiceChannelId()) return;
    if (!routingEnabled) keys.clear();
    const me = UserStore.getCurrentUser()?.id;
    const cameraRooms = new Map<string, string>();
    for (const id of Object.keys(channelId ? VoiceStateStore.getVoiceStatesForChannel(channelId) : {})) {
        if (id === me) continue;
        const username = UserStore.getUser(id)?.username;
        if (!username) continue;
        try {
            const room = keys.get(cameraKey(username).toLowerCase());
            if (room) cameraRooms.set(id, room);
        } catch { /* Username incompatível com as chaves FockyTV. */ }
    }
    for (const [id, entry] of cameraViewers)
        if (entry.channelId !== channelId || cameraRooms.get(id) !== entry.room) endCamera(id);
    if (channelId) for (const [id, room] of cameraRooms)
        if (!cameraViewers.has(id)) void watchCamera(id, room, channelId);
    const owners = new Map(Object.keys(channelId ? VoiceStateStore.getVoiceStatesForChannel(channelId) : {})
        .filter(id => id !== me).map(id => [id, keys.get(UserStore.getUser(id)?.username?.toLowerCase() ?? "")] as const)
        .filter((owner): owner is [string, string] => !!owner[1]));
    const styles = new Map([...owners].map(([id, key]) => [id, liveStyle(lives.get(key.toLowerCase())?.quality?.style)]));
    // O estilo chega com o anúncio de qualidade, às vezes depois da live: também reaplica a linha de quem mudou de estilo.
    const changed = [...new Set([...owners.keys(), ...liveOwners.keys()])].filter(id => owners.has(id) !== liveOwners.has(id) || styles.get(id) !== ownerStyles.get(id));
    liveOwners.clear();
    owners.forEach((key, id) => liveOwners.set(id, key));
    ownerStyles.clear();
    styles.forEach((style, id) => ownerStyles.set(id, style));
    for (const key of [...watching.keys()]) if (!liveOwners.has(ownerOf(key))) endWatch(key);
    const guildId = channelId ? ChannelStore.getChannel(channelId)?.guild_id ?? null : null;
    if (changed.length && channelId) {
        // Reaplica o estado de voz atual: os patches marcam selfStream e o Discord mostra "AO VIVO" e o botão Assistir.
        // ponytail: um Go Live nativo simultâneo some até a próxima atualização de voz real desse usuário
        const voiceStates = changed.map(id => VoiceStateStore.getVoiceStateForUser(id)).filter(Boolean).map(state => ({ ...state, guildId, selfStream: false }));
        if (voiceStates.length) FluxDispatcher.dispatch({ type: "VOICE_STATE_UPDATES", voiceStates });
    }
    // Selo de qualidade das lives dos outros: o mesmo evento que a conexão de stream nativa emite.
    for (const id of announcedQuality.keys()) if (!liveOwners.has(id)) announcedQuality.delete(id);
    if (channelId) for (const [id, room] of liveOwners) {
        let quality = lives.get(room.toLowerCase())?.quality;
        // Live sem anúncio (versão antiga do plugin ou anúncio perdido): quem já assiste usa o que está recebendo.
        if (!quality?.resolution) quality = await receivedQuality(watching.get(keyOf({ guildId, channelId, ownerId: id }))?.viewing, quality?.fps) ?? quality;
        const signature = quality ? `${quality.resolution}:${quality.fps}` : "";
        if (!quality || announcedQuality.get(id) === signature) continue;
        announcedQuality.set(id, signature);
        FluxDispatcher.dispatch({
            type: "MEDIA_ENGINE_VIDEO_SOURCE_QUALITY_CHANGED", guildId, channelId, senderUserId: id, context: "stream", maxFrameRate: quality.fps,
            maxResolution: { type: quality.resolution ? "fixed" : "source", width: 0, height: quality.resolution }
        });
    }
    // Espectadores casados pelo username com quem está na call (quem assiste pelo site não tem conta para mostrar).
    const members = new Map(Object.keys(channelId ? VoiceStateStore.getVoiceStatesForChannel(channelId) : {})
        .map(id => [UserStore.getUser(id)?.username?.toLowerCase() ?? "", id] as const));
    const viewers = new Map<string, string[]>();
    const web = new Map<string, number>();
    const share = discordShare;
    const rooms: [string, string][] = [...liveOwners].map(([id, room]) => [channelId ? keyOf({ guildId, channelId, ownerId: id }) : "", room]);
    if (share && share.channelId === channelId && me) try { rooms.push([keyOf(share), nickname()]); } catch { /* Nick incompatível. */ }
    for (const [key, room] of rooms) {
        const live = lives.get(room.toLowerCase());
        if (!key || !live) continue;
        const ids = live.viewers.flatMap(name => members.get(name) ?? []);
        viewers.set(key, ids);
        // ponytail: quem não casa com um membro da call conta como site; sessões duplicadas de uma reconexão do Discord inflam esse número até sumirem.
        web.set(key, Math.max(0, live.sessions - ids.length));
    }
    if (JSON.stringify([...viewers, ...web]) === JSON.stringify([...liveViewers, ...webViewers])) return;
    liveViewers.clear();
    viewers.forEach((ids, key) => liveViewers.set(key, ids));
    webViewers.clear();
    web.forEach((count, key) => webViewers.set(key, count));
    ApplicationStreamingStore.emitChange();
}

function syncAudio() {
    const deaf = MediaEngineStore.isSelfDeaf();
    const output = MediaEngineStore.getOutputVolume();
    music.setVolume(settings.store.musicVolume, deaf ? 0 : output / 100);
    watch.setVolume(settings.store.watchVolume, deaf ? 0 : output / 100);
    watching.forEach((entry, key) => {
        const owner = ownerOf(key);
        entry.audio?.update(MediaEngineStore.getLocalVolume(owner, "stream"), output,
            deaf || MediaEngineStore.isLocalMute(owner, "stream"));
    });
}

function watchVideo(key: string, streamId: string | null) {
    const parts = key.split(":");
    const [guildId, channelId] = parts[0] === "guild" ? [parts[1], parts[2]] : [null, parts[1]];
    FluxDispatcher.dispatch({ type: "RTC_CONNECTION_VIDEO", guildId, channelId, userId: ownerOf(key), streamId, rtcServerId: null, context: "stream" });
}

async function startWatch(key: string) {
    const entry: NonNullable<ReturnType<typeof watching.get>> = {};
    watching.set(key, entry);
    try {
        const room = liveOwners.get(ownerOf(key));
        if (!room) throw new Error("A live terminou.");
        livekit ??= loadLivekit(livekitSource, proxySocket(Native));
        let viewer = "";
        try { viewer = nickname(); } catch { }
        const viewing = await watchLive(livekit, request, serverUrl(settings.store.url), room, viewer, () => endWatch(key));
        if (watching.get(key) !== entry) { viewing.close(); return; }
        entry.viewing = viewing;
        syncActivity();
        // Um único elemento toca o áudio; os tiles de vídeo (podem ser vários) ficam mudos.
        entry.audio = streamAudio(viewing.media);
        entry.unsync = lipSync(viewing.receivers, () => entry.audio?.latencyMs() ?? 0);
        syncAudio();
        warnSoftwareVideo();
        if (settings.store.replayBuffer) {
            try { entry.replay = replayBuffer(viewing.media); } catch (error) { console.warn("FockyTV: replay", error); }
        }
        // STREAM_UPDATE marca a stream ativa e cancela o timeout do Discord sem exigir conexão RTC dele
        // (o handler de STREAM_CREATE do StreamRTCConnectionStore quebra sem rtcServerId).
        FluxDispatcher.dispatch({ type: "STREAM_UPDATE", streamKey: key, region: null, viewerIds: [UserStore.getCurrentUser()?.id], paused: false });
        watchVideo(key, watchStreamPrefix + key);
    } catch (error) {
        console.error("FockyTV: assistir", error);
        if (watching.get(key) === entry) {
            endWatch(key);
            void showNotification({ title: "FockyTV: não foi possível assistir", body: String(error) });
        }
    }
}

function closeViewing(key: string) {
    const entry = watching.get(key);
    if (!entry) return false;
    watching.delete(key);
    syncActivity();
    entry.replay?.stop();
    entry.unsync?.();
    closePictureInPicture(entry.viewing?.media);
    entry.viewing?.close();
    entry.audio?.close();
    return true;
}

function endWatch(key: string) {
    if (!closeViewing(key)) return;
    // Pode ser chamado dentro de um dispatch (STREAM_WATCH/STREAM_CLOSE), e o Flux não aceita dispatch aninhado.
    setTimeout(() => {
        watchVideo(key, null);
        // Como o servidor do Discord faria; sem efeito se a stream já foi fechada.
        FluxDispatcher.dispatch({ type: "STREAM_DELETE", streamKey: key, unavailable: false, reason: "stream_ended" });
    }, 0);
}

// Quem está com o plugin ligado agora (presença no servidor), para a etiqueta [FTV] na lista de voz.
const ftvUsers = new Set<string>();
const ftvListeners = new Set<() => void>();
let presencePoll: ReturnType<typeof setInterval> | undefined;

async function refreshPresence() {
    try {
        const me = UserStore.getCurrentUser()?.username;
        const query = routingEnabled && me ? `?user=${encodeURIComponent(me.toLowerCase())}` : "";
        const response = await request(`${serverUrl(settings.store.url)}/api/presence${query}`, "GET");
        if (response.status !== 200) return; // servidor sem o endpoint: sem etiquetas
        const users = JSON.parse(response.body) as string[];
        if (users.length === ftvUsers.size && users.every(user => ftvUsers.has(user))) return;
        ftvUsers.clear();
        users.forEach(user => ftvUsers.add(user));
        ftvListeners.forEach(listener => listener());
    } catch (error) { console.warn("FockyTV: presença", error); }
}

function FtvTag({ user }: { user?: { id?: string; username?: string; }; }) {
    const [, update] = useState(0);
    useEffect(() => {
        const listener = () => update(n => n + 1);
        ftvListeners.add(listener);
        return () => { ftvListeners.delete(listener); };
    }, []);
    if (!user?.username || !ftvUsers.has(user.username.toLowerCase())) return null;
    return <span title="Usando o plugin FockyTV" style={{ marginLeft: 4, fontSize: 10, fontWeight: 700, color: "var(--text-brand, #5865f2)" }}>[FTV]</span>;
}

function WatchTag({ user }: { user: { id: string; }; }) {
    const { viewers, watching } = useWatch(watch);
    const viewing = user.id === UserStore.getCurrentUser()?.id ? watching : viewers.includes(user.id);
    return <>
        {viewing && <span className="fockytv-watch-indicator" title="Assistindo à watch party" aria-label="Assistindo à watch party">
            {!watching ? <button type="button" className="fockytv-watch-pill fockytv-watch-join" aria-label="Juntar-se à watch party"
                onClick={event => { event.stopPropagation(); watch.listen(true); }}>
                <EyeIcon /><span className="fockytv-watch-label">WATCH</span><span className="fockytv-watch-join-label">Juntar-se</span>
            </button> : <span className="fockytv-watch-pill"><EyeIcon />WATCH</span>}
        </span>}
    </>;
}

function MusicTag({ user }: { user: { id: string; }; }) {
    const { state, listening } = useMusic(music);
    const listener = user.id === UserStore.getCurrentUser()?.id ? listening : state?.listeners.includes(user.id);
    if (!listener) return null;
    return <span className="fockytv-watch-indicator fockytv-music-indicator" title="Ouvindo música na call" aria-label="Ouvindo música na call">
        {!listening ? <button type="button" className="fockytv-watch-pill fockytv-watch-join" aria-label="Juntar-se à música"
            onClick={event => { event.stopPropagation(); music.listen(true); }}>
            <MusicIcon /><span className="fockytv-watch-label">MUSIC</span><span className="fockytv-watch-join-label">Juntar-se</span>
        </button> : <span className="fockytv-watch-pill"><MusicIcon />MUSIC</span>}
    </span>;
}

let modalKey: string | undefined;
let closePanel: (() => void) | undefined;

async function stopPublishing() {
    generation++;
    clearDiscordShare();
    const sessions = [...publishers.values()];
    publishers.clear();
    await Promise.all(sessions.map(session => session.close()));
}

async function cameraDevice() {
    const device = MediaEngineStore.getVideoDevices()[MediaEngineStore.getVideoDeviceId()];
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(input => input.kind === "videoinput");
    const deviceId = matchCamera(device, inputs);
    if (!deviceId) throw new Error(`Câmera do Discord "${device?.name ?? "nenhuma"}" não encontrada (${inputs.map(input => input.label).join(", ")}).`);
    return { exact: deviceId };
}

async function openCapture(kind: "screen" | "camera", source?: DiscordSource, quality?: Partial<ShareQuality>) {
    const selected = shareQuality(quality ?? {}, StreamingSettings.getState());
    if (kind === "camera" && typeof (window as any).createDiscordStream === "function")
        return { ...await captureNativeCamera(MediaEngineStore.getVideoDeviceId()), releaseAudio: undefined, quality: selected };
    const sound = kind === "screen" && (selected.soundshareEnabled ?? false);
    const capture = source
        ? await navigator.mediaDevices.getUserMedia(captureConstraints(source, selected.fps, selected.resolution) as unknown as MediaStreamConstraints)
        : kind === "camera"
            ? await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: { ideal: 30, max: 30 }, deviceId: await cameraDevice() }, audio: false })
            : await navigator.mediaDevices.getDisplayMedia({ video: qualityConstraints(selected), audio: sound });
    let releaseAudio: (() => void) | undefined;
    if (kind === "screen") {
        try {
            const sourceId = source ? captureConstraints(source, selected.fps, selected.resolution).video.mandatory.chromeMediaSourceId : "screen:-1:0";
            releaseAudio = await screenAudio(Native, capture, sourceId, sound, IS_WINDOWS, error => {
                console.error("FockyTV: áudio", error);
                void showNotification({ title: "FockyTV: áudio interrompido", body: String(error) });
            });
        } catch (error) {
            console.warn("FockyTV: áudio indisponível", error);
            void showNotification({ title: "FockyTV: transmissão sem áudio", body: String(error) });
        }
    }
    return { capture, releaseAudio, releaseVideo: undefined, quality: selected };
}

function watchEnded(kind: "screen" | "camera", session: Session, track: MediaStreamTrack) {
    track.addEventListener("ended", () => {
        if (publishers.get(kind) === session) {
            publishers.delete(kind);
            if (kind === "screen") clearDiscordShare();
        }
    }, { once: true });
}

// O tile local do Discord espera quadros; a captura nativa não passa pelo renderer, então mostra a imagem
// que o encoder salva a cada segundo (e um aviso até a primeira). A miniatura da live sai deste mesmo canvas.
function nativePreview(id: string) {
    const canvas = Object.assign(document.createElement("canvas"), { width: 1280, height: 720 });
    const context = canvas.getContext("2d")!;
    const stream = canvas.captureStream(1);
    let shown = false;
    const draw = async () => {
        if (stream.getVideoTracks()[0]?.readyState !== "live") return clearInterval(timer);
        const url = await Native.nativeShareThumbnail(id).catch(() => null);
        if (url) {
            const image = new Image();
            image.src = url;
            try {
                await image.decode();
                // Trocar de tela pode mudar a proporção.
                if (canvas.width !== image.width || canvas.height !== image.height) { canvas.width = image.width; canvas.height = image.height; }
                shown = true;
                context.drawImage(image, 0, 0, canvas.width, canvas.height);
                return;
            } catch { }
        }
        if (shown) return;
        context.fillStyle = "#111";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#fff";
        context.font = "bold 44px sans-serif";
        context.textAlign = "center";
        context.fillText("Transmitindo pela captura nativa (GPU)", canvas.width / 2, canvas.height / 2);
    };
    // Redesenha para o tile receber quadro mesmo quando abre depois.
    const timer = setInterval(() => void draw(), 1000);
    void draw();
    return stream;
}

async function publishNative(source: string, quality: ShareQuality) {
    const nick = nickname();
    const version = generation;
    if (!await Native.nativeEncoderReady())
        void showNotification({ title: "FockyTV", body: "Baixando o encoder nativo (~110 MB, só na primeira vez)..." });
    const id = await Native.startNativeShare({ source, fps: quality.fps, resolution: quality.resolution, bitrate: settings.store.nativeBitrate, audio: quality.soundshareEnabled ?? false, key: nick, endpoint: `${serverUrl(settings.store.url)}/api/livekit/whip`, style: liveStyle(settings.store.liveStyle) });
    const share: NativeShare = new NativeShare(Native, id, nativePreview(id), quality.fps, quality.resolution, error => {
        if (publishers.get("screen") !== share) return;
        publishers.delete("screen");
        clearDiscordShare();
        void showNotification({ title: "FockyTV", body: error ? `A captura nativa parou: ${error}` : "A captura nativa terminou." });
    });
    if (version !== generation || !discordShare) { await share.close(); return; }
    publishers.set("screen", share);
    updatePreview(discordShare, previewStreamId);
}

// true se a captura nativa assumiu (ou o usuário cancelou); false volta para a captura do Chromium.
async function tryNative(source: DiscordSource | undefined, quality: ShareQuality) {
    const native = IS_WINDOWS && settings.store.nativeCapture && source ? nativeSource(source) : undefined;
    if (!native || publishers.has("screen") || pending.has("screen")) return false;
    pending.add("screen");
    try { await publishNative(native, quality); return true; }
    catch (error) {
        console.warn("FockyTV: captura nativa", error);
        void showNotification({ title: "FockyTV: usando a captura do Discord", body: `Captura nativa indisponível: ${error}` });
        return !discordShare;
    } finally { pending.delete("screen"); }
}

async function publish(kind: "screen" | "camera", source?: DiscordSource, quality?: Partial<ShareQuality>) {
    const existing = publishers.get(kind);
    if (existing) { publishers.delete(kind); if (kind === "screen") clearDiscordShare(); await existing.close(); return; }
    if (pending.has(kind)) return;
    const base = serverUrl(settings.store.url);
    const nick = nickname();
    const version = generation;
    pending.add(kind);
    let capture: MediaStream | undefined;
    let session: Session | undefined;
    let selected: ShareQuality;
    let releaseAudio: (() => void) | undefined;
    let releaseVideo: (() => void) | undefined;
    try {
        ({ capture, releaseAudio, releaseVideo, quality: selected } = await openCapture(kind, source, quality));
        if (version !== generation || (source && !discordShare)) { releaseAudio?.(); releaseVideo?.(); capture.getTracks().forEach(track => track.stop()); return; }
        session = new Session(request, kind === "camera" ? cameraKey(nick) : nick, capture, releaseAudio, releaseVideo);
        session.style = liveStyle(settings.store.liveStyle);
        publishers.set(kind, session);
        session.pc.addEventListener("connectionstatechange", () => {
            if (["failed", "closed"].includes(session!.pc.connectionState) && publishers.get(kind) === session) {
                publishers.delete(kind);
                if (kind === "screen") clearDiscordShare();
                if (session!.pc.connectionState === "failed")
                    void showNotification({ title: "FockyTV", body: "A conexão da transmissão falhou. Abra o painel FockyTV para tentar novamente." });
            }
        });
        watchEnded(kind, session, capture.getVideoTracks()[0]);
        if (kind === "screen" && discordShare) updatePreview(discordShare, previewStreamId);
        await session.connect(`${base}/api/livekit/whip`);
        if (kind === "screen") await session.setQuality(selected);
    } catch (error) {
        if (publishers.get(kind) === session) publishers.delete(kind);
        releaseAudio?.();
        if (!session) releaseVideo?.();
        capture?.getTracks().forEach(track => track.stop());
        await session?.close();
        throw error;
    } finally { pending.delete(kind); }
}

// "Trocar de tela" do Discord: troca as faixas na mesma sessão, sem derrubar a live.
async function switchSource(source?: DiscordSource, quality?: Partial<ShareQuality>) {
    const session = publishers.get("screen");
    if (!session || pending.has("screen")) throw new Error("already sharing");
    if (session instanceof NativeShare) throw new Error("A captura nativa troca a fonte pelo encoder.");
    pending.add("screen");
    // O nativo só mantém uma captura de áudio por janela; a nova encerraria a antiga com erro.
    session.stopAudio();
    try {
        const { capture, releaseAudio } = await openCapture("screen", source, quality);
        if (publishers.get("screen") !== session) { releaseAudio?.(); capture.getTracks().forEach(track => track.stop()); throw new Error("cancelled"); }
        await session.replace(capture, releaseAudio);
        watchEnded("screen", session, capture.getVideoTracks()[0]);
    } finally { pending.delete("screen"); }
}

// O que está sendo transmitido (jogo, vídeo ou tela), para o aviso da live.
let liveActivity: ReturnType<typeof detectProfile> | undefined;
function noteActivity(source?: DiscordSource) {
    let games: ReturnType<typeof RunningGameStore.getRunningGames> = [], visible: ReturnType<typeof RunningGameStore.getVisibleGame> = null;
    try { games = RunningGameStore.getRunningGames() ?? []; visible = RunningGameStore.getVisibleGame(); } catch { /* Store ausente nesta versão do Discord. */ }
    liveActivity = detectProfile(source, games, visible);
}

// O bot do servidor avisa no chat do canal de voz da live: título, jogo ou janela e miniatura (chamadas privadas não têm aviso).
async function announceLive(share: NonNullable<typeof discordShare>) {
    if (!share.guildId) return;
    await new Promise(resolve => setTimeout(resolve, 4000)); // a captura nativa leva alguns segundos para a primeira imagem
    const session = publishers.get("screen");
    if (!session?.capture || discordShare !== share) return;
    const user = UserStore.getCurrentUser();
    const activity = liveActivity;
    const clip = (text: string) => Array.from(text.trim()).slice(0, 100).join("");
    const image = await thumbnail(session.capture, 640).catch(() => "");
    const status = await session.announce(JSON.stringify({
        channel: share.channelId,
        title: clip(settings.store.liveTitle || `Live de ${user?.globalName ?? user?.username ?? nickname()}`),
        detail: activity?.name ? clip(`${{ game: "🎮", video: "🎬", screen: "🖥️" }[activity.kind]} ${activity.name}`) : "",
        thumbnail: image.replace(/^data:image\/jpeg;base64,/, "")
    }));
    if (status >= 300) console.warn("FockyTV: aviso da live", status);
}

function commitDiscordQuality(quality: ShareQuality) {
    discordQuality = quality;
    FluxDispatcher.dispatch({ type: "STREAM_UPDATE_SETTINGS", preset: quality.preset, resolution: quality.resolution, frameRate: quality.fps, soundshareEnabled: quality.soundshareEnabled });
}

function updateDiscordQuality(options: { resolution?: number; frameRate?: number; preset?: number; soundshareEnabled?: boolean; }) {
    const session = publishers.get("screen");
    const share = discordShare;
    if (!routingEnabled || !share || !session || !discordQuality) return false;
    // O menu pode emitir várias escolhas antes de o encoder terminar a anterior.
    shareChanges = shareChanges.catch(() => {}).then(async () => {
        if (discordShare !== share || publishers.get("screen") !== session) return;
        const previous = discordQuality!;
        try {
            const selected = shareQuality({ ...options, fps: options.frameRate }, previous);
            if (selected.fps !== previous.fps || selected.resolution !== previous.resolution)
                await session.setQuality(selected);
            if (discordShare === share && publishers.get("screen") === session) commitDiscordQuality(selected);
        } catch (error) {
            if (discordShare === share && publishers.get("screen") === session) {
                commitDiscordQuality(previous);
                void showNotification({ title: "FockyTV: não foi possível alterar a qualidade", body: String(error) });
            }
        }
    });
    return true;
}

interface Live { streamKey: string; engine?: string; }
type UpdateInfo = Awaited<ReturnType<typeof Native.checkUpdate>>;
const versionLabel = (version?: number) => version ? `v${version}` : "";

// Versão atual → nova e o que muda (mais recente primeiro).
function UpdateDetails({ update }: { update: UpdateInfo; }) {
    const changes = update.changes ?? [];
    return <div className="fockytv-update">
        {update.version && <div className="fockytv-update-version">
            {update.current && <span>{versionLabel(update.current)}</span>}
            {update.current && <span aria-hidden="true">→</span>}
            <span className="fockytv-update-new">{versionLabel(update.version)}</span>
        </div>}
        {changes.length > 0 && <ul className="fockytv-update-changes">
            {changes.slice(0, 5).map((change, index) => <li key={index}>{change}</li>)}
            {changes.length > 5 && <li className="fockytv-update-more">e mais {changes.length - 5} {changes.length - 5 === 1 ? "mudança" : "mudanças"}</li>}
        </ul>}
    </div>;
}

// O Vencord já renderiza a notificação dentro de um <button>; um span com role evita botão aninhado.
function UpdateNotice({ update }: { update: UpdateInfo; }) {
    const [state, setState] = useState<"idle" | "busy" | "started" | "current">("idle");
    const [error, setError] = useState("");
    const install = async (event: React.SyntheticEvent) => {
        event.stopPropagation();
        event.preventDefault();
        if (state !== "idle") return;
        setState("busy"); setError("");
        try { setState((await Native.installUpdate()).started ? "started" : "current"); }
        catch (error) { setError(String(error)); setState("idle"); }
    };
    return <div>
        <UpdateDetails update={update} />
        {state === "started" ? <p role="status" className="fockytv-update-note">Instalando… o Discord fecha e reabre automaticamente ao terminar.</p>
            : state === "current" ? <p role="status" className="fockytv-update-note">O FockyTV já está atualizado.</p>
                : <>
                    <span role="button" tabIndex={0} aria-disabled={state === "busy"} className="fockytv-update-button" onClick={install} onKeyDown={event => (event.key === "Enter" || event.key === " ") && void install(event)}>
                        {state === "busy" ? "Preparando…" : "Atualizar agora"}
                    </span>
                    <p className="fockytv-update-note">O Discord fecha durante a instalação e reabre automaticamente ao terminar. Clique fora do botão para abrir o painel.</p>
                </>}
        {error && <p role="alert" className="fockytv-update-error">{error}</p>}
    </div>;
}

function UpdateControls() {
    const [available, setAvailable] = useState(false);
    const [update, setUpdate] = useState<UpdateInfo | null>(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");
    const mounted = useRef(true);
    const check = async () => {
        setBusy(true); setError("");
        try {
            const result = await Native.checkUpdate();
            if (mounted.current) {
                setAvailable(result.available);
                setUpdate(result.available ? result : null);
                setMessage(result.available ? "Nova versão do FockyTV disponível." : `FockyTV está atualizado${result.version ? ` (${versionLabel(result.version)})` : ""}.`);
            }
        } catch (error) { if (mounted.current) setError(String(error)); }
        finally { if (mounted.current) setBusy(false); }
    };
    useEffect(() => { mounted.current = true; void check(); return () => { mounted.current = false; }; }, []);
    const install = async () => {
        setBusy(true); setError("");
        try {
            const result = await Native.installUpdate();
            if (mounted.current) {
                setAvailable(false);
                setUpdate(null);
                setMessage(result.started ? "Instalando. O cliente será fechado e reaberto automaticamente ao terminar." : "FockyTV está atualizado.");
            }
        } catch (error) { if (mounted.current) setError(String(error)); }
        finally { if (mounted.current) setBusy(false); }
    };
    return <div>
        <p role="status">{message}</p>
        {update && <UpdateDetails update={update} />}
        {error && <p role="alert">{error}</p>}
        <Button disabled={busy} onClick={available ? install : check}>{available ? "Instalar atualização e reiniciar o cliente" : "Verificar atualização"}</Button>
    </div>;
}

async function notifyUpdate() {
    if (!routingEnabled) return;
    if (updateChecking) { updateQueued = true; return; }
    updateChecking = true;
    try {
        const result = await Native.checkUpdate();
        if (!routingEnabled || !result.available || result.revision === notifiedRevision) return;
        const versions = result.version ? `${result.current ? `${versionLabel(result.current)} → ` : ""}${versionLabel(result.version)}` : "";
        // O body é o que aparece se o Vencord usar notificações nativas do sistema (sem botão nem lista).
        await showNotification({
            title: "FockyTV: atualização disponível",
            body: [versions, result.changes?.slice(0, 3).join(" · "), "Clique para abrir o painel e instalar."].filter(Boolean).join("\n"),
            richBody: <UpdateNotice update={result} />,
            color: "#5865f2",
            onClick: openPanel
        });
        notifiedRevision = result.revision;
    } catch (error) { console.warn("FockyTV: verificar atualização", error); }
    finally {
        updateChecking = false;
        if (updateQueued) { updateQueued = false; if (routingEnabled) void notifyUpdate(); }
    }
}

function StreamDiagnostics({ player }: { player: Session | null; }) {
    type Source = { label: string; getStats(): Promise<RTCStatsReport>; };
    type Sample = { at: string; streams: { label: string; metrics: ReturnType<typeof videoStats>; error?: string; }[]; };
    const [sources, setSources] = useState<Source[] | null>(null);
    const [samples, setSamples] = useState<Sample[]>([]);
    const screen = publishers.get("screen");
    const available: Source[] = screen instanceof Session ? [{ label: "Envio da tela", getStats: () => screen.pc.getStats() }] : [];
    for (const { viewing } of watching.values())
        if (viewing) available.push({ label: `Recepção da live ${available.length + 1}`, getStats: () => viewing.getStats() });
    if (player) available.push({ label: "Recepção do player", getStats: () => player.pc.getStats() });

    useEffect(() => {
        if (!sources) return;
        let active = true, polling = false;
        const previous: (RTCStatsReport | undefined)[] = [];
        const sample = async () => {
            if (polling) return;
            polling = true;
            try {
                const at = new Date().toISOString();
                const streams = await Promise.all(sources.map(async (source, index) => {
                    try {
                        const report = await source.getStats();
                        const metrics = videoStats(report, previous[index]);
                        previous[index] = report;
                        return { label: source.label, metrics };
                    } catch {
                        return { label: source.label, metrics: [], error: "Não foi possível ler esta conexão." };
                    }
                }));
                if (!active) return;
                setSamples(values => [...values, { at, streams }]);
            } finally { polling = false; }
        };
        const timer = setInterval(() => void sample(), 1000);
        const stop = setTimeout(() => setSources(null), 30_000);
        void sample();
        return () => { active = false; clearInterval(timer); clearTimeout(stop); };
    }, [sources]);

    const report = JSON.stringify({ samples }, null, 2);
    return <div>
        <Button disabled={!sources && !available.length} onClick={() => {
            if (sources) setSources(null);
            else { setSamples([]); setSources(available); }
        }}>{sources ? "Parar diagnóstico" : "Diagnosticar transmissão (30 s)"}</Button>
        <p role="status">{sources ? `Coletando por 30 s: ${samples.length} amostras. Mantenha o jogo em movimento.` : samples.length ? "Diagnóstico concluído. Copie o relatório para análise." : "Mede envio e lives abertas neste cliente. Para medir recepção, assista à live durante a coleta."}</p>
        {samples.length > 0 && <>
            <Button onClick={() => void copyToClipboard(report).catch(() => {
                void showNotification({ title: "FockyTV", body: "Não foi possível copiar o diagnóstico. Abra Ver medições para copiar o texto." });
            })}>Copiar diagnóstico</Button>
            <details><summary>Ver medições</summary><pre style={{ maxHeight: 240, overflow: "auto" }}>{report}</pre></details>
        </>}
    </div>;
}

function Panel(props: RenderModalProps) {
    const [lives, setLives] = useState<Live[]>([]);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const [, redraw] = useState(0);
    const [watching, setWatching] = useState("");
    const video = useRef<HTMLVideoElement>(null);
    const viewer = useRef<Session | null>(null);
    const mounted = useRef(true);

    useEffect(() => {
        mounted.current = true;
        let polling = false;
        const refresh = async () => {
            if (polling) return;
            polling = true;
            try {
                const response = await request(`${serverUrl(settings.store.url)}/api/status`, "GET");
                if (response.status !== 200) throw new Error(`Status do servidor: ${response.status}`);
                const data: unknown = JSON.parse(response.body);
                if (!Array.isArray(data) || !data.every(item => item && typeof item.streamKey === "string"))
                    throw new Error("Lista de lives inválida.");
                if (mounted.current) setLives(data);
            } catch (error) { if (mounted.current) setError(String(error)); }
            finally { polling = false; }
        };
        void refresh();
        const timer = setInterval(() => { void refresh(); redraw(n => n + 1); }, 5000);
        closePanel = props.onClose;
        return () => {
            mounted.current = false;
            modalKey = undefined;
            closePanel = undefined;
            clearInterval(timer);
            void viewer.current?.close();
            panelWatching = "";
            syncActivity();
        };
    }, []);

    async function run(action: () => Promise<void>) {
        setBusy(true); setError("");
        try { await action(); }
        catch (error) { if (mounted.current) setError(String(error)); }
        finally { if (mounted.current) { setBusy(false); redraw(n => n + 1); } }
    }

    async function watch(live: Live) {
        if (live.engine === "livekit") throw new Error("Esta live usa LiveKit. Abra o site FockyTV para assisti-la.");
        await viewer.current?.close();
        setWatching("");
        panelWatching = "";
        syncActivity();
        const session = new Session(request, streamKey(live.streamKey));
        viewer.current = session;
        session.pc.addEventListener("connectionstatechange", () => {
            if (viewer.current === session && ["failed", "closed"].includes(session.pc.connectionState)) {
                panelWatching = "";
                if (mounted.current) setWatching("");
                syncActivity();
            }
        });
        if (video.current) video.current.srcObject = session.media;
        await session.connect(`${serverUrl(settings.store.url)}/api/whep?viewer=${encodeURIComponent(nickname())}`);
        if (mounted.current && viewer.current === session) {
            setWatching(live.streamKey);
            panelWatching = live.streamKey;
            syncActivity();
        }
    }

    return <Modal {...props} title="FockyTV" size="lg">
        <div style={{ padding: 16, display: "grid", gap: 12 }}>
            <div style={{ display: "flex", gap: 8 }}>
                <Button disabled={busy} onClick={() => run(() => publish("screen"))}>{publishers.has("screen") ? "Parar tela" : "Compartilhar tela"}</Button>
                <Button disabled={busy} onClick={() => run(() => publish("camera"))}>{publishers.has("camera") ? "Parar câmera" : "Ligar câmera"}</Button>
                <Button onClick={() => run(stopPublishing)}>Parar tudo</Button>
            </div>
            <p>Fechar este painel para o player; tela e câmera continuam até você parar ou sair da chamada.</p>
            <a href={serverUrl(settings.store.url)} target="_blank" rel="noreferrer">Abrir site FockyTV (inclui lives LiveKit)</a>
            <UpdateControls />
            <StreamDiagnostics player={viewer.current} />
            {error && <p role="alert">{error}</p>}
            <video ref={video} autoPlay controls playsInline aria-label={`Live FockyTV ${watching}`} style={{ width: "100%", maxHeight: 400, background: "black" }} />
            {watching && <Button onClick={() => run(async () => {
                await viewer.current?.close(); viewer.current = null;
                if (video.current) video.current.srcObject = null;
                setWatching("");
                panelWatching = "";
                syncActivity();
            })}>Parar de assistir</Button>}
            {lives.length === 0 && <p>Nenhuma live encontrada.</p>}
            {lives.map(live => <Button key={live.streamKey} disabled={busy} onClick={() => run(() => watch(live))}>
                Assistir {live.streamKey}{live.engine === "livekit" ? " (LiveKit — site)" : ""}
            </Button>)}
        </div>
    </Modal>;
}

const githubRequest: GithubFetch = async path => {
    const response = await Native.githubRequest(settings.store.githubToken, path);
    if (response.status >= 400) throw new Error(githubError(response));
    return JSON.parse(response.body);
};
const githubQueueRequest: GithubQueueRequest = (repository, cursor) => Native.githubMergeQueue(settings.store.githubToken, repository, cursor);
function openGithub() {
    if (!settings.store.githubToken.trim()) return;
    markGithubQueueSeen();
    openModal(props => <GithubPanel {...props} context={{
        request: githubRequest, queueRequest: githubQueueRequest, repository: settings.store.githubRepository, authenticated: !!settings.store.githubToken,
        setRepository: value => { settings.store.githubRepository = value; }
    }} />);
}
const GithubIcon = ({ className }: { className?: string; }) => <svg className={className} width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M12 .8a11.2 11.2 0 0 0-3.54 21.83c.56.1.76-.24.76-.54v-2.1c-3.12.68-3.78-1.33-3.78-1.33-.51-1.3-1.25-1.64-1.25-1.64-1.02-.7.08-.69.08-.69 1.13.08 1.72 1.16 1.72 1.16 1 1.72 2.63 1.22 3.27.93.1-.72.39-1.22.71-1.5-2.49-.29-5.11-1.25-5.11-5.54 0-1.23.44-2.23 1.16-3.01-.12-.28-.5-1.43.11-2.98 0 0 .94-.3 3.08 1.15a10.7 10.7 0 0 1 5.6 0c2.14-1.45 3.08-1.15 3.08-1.15.61 1.55.23 2.7.11 2.98.72.78 1.16 1.78 1.16 3.01 0 4.3-2.63 5.25-5.13 5.53.4.35.76 1.03.76 2.08v3.1c0 .3.2.65.77.54A11.2 11.2 0 0 0 12 .8Z" /></svg>;
function GithubButton(props: { nameplate?: unknown; }) {
    const { githubToken, githubRepository } = settings.use(["githubToken", "githubRepository"]);
    const queue = useGithubQueue(githubQueueRequest, githubRepository, !!githubToken.trim());
    if (!githubToken.trim()) return null;
    const tooltip = <div className="fockytv-gh-tooltip"><strong>GitHub · {githubRepository || "Escolha um projeto"}</strong>
        {[...queue.items.map(item => [item.number, item.mergeQueueEntry!.state === "UNMERGEABLE" ? "failure" : "running", mergeQueueState(item)]), ...queue.merged.map(pr => [pr.number, "merged", "Mesclado"])]
            .map(([number, state, label]) => <div key={number} className="fockytv-gh-ci" data-state={state}><ActionIcon state={state as string} /><span>#{number} · {label}</span></div>)}
        {queue.error ? <div>{queue.error} · Dados desatualizados</div> : queue.updated && !queue.items.length && !queue.merged.length && <div>Nenhum PR na Merge Queue</div>}
    </div>;
    const icon = (iconProps: { className?: string; }) => <span className="fockytv-gh-button-icon"><GithubIcon {...iconProps} />
        {(queue.items.length > 0 || queue.error) && <span className="fockytv-gh-queue-badge" aria-label={queue.error ? "Merge Queue desatualizada" : `${queue.items.length} PRs na Merge Queue`}>{queue.error ? "!" : queue.items.length}</span>}
    </span>;
    return <PanelButton tooltipText={tooltip} icon={icon} plated={props?.nameplate != null} onClick={openGithub} />;
}

const jiraRequest: JiraFetch = async (path, method = "GET", body) => {
    const { jiraSite: site, jiraEmail: email, jiraToken: token } = settings.store;
    const response = await Native.jiraRequest(site, email, token, path, method, body === undefined ? undefined : JSON.stringify(body));
    if (response.status >= 400) throw new Error(jiraError(response.status, response.body));
    return response.body ? JSON.parse(response.body) : null;
};

function openJira() {
    openModal(props => <JiraPanel {...props} context={{ site: settings.store.jiraSite, request: jiraRequest, board: settings.store.jiraBoard || undefined, setBoard: id => { settings.store.jiraBoard = id; } }} />);
}

const JiraIcon = ({ className }: { className?: string; }) => <svg className={className} width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
    <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53Z" />
    <path d="M6.77 6.8a4.36 4.36 0 0 0 4.34 4.34h1.8v1.72a4.36 4.36 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.83-.83H6.77Z" />
    <path d="M2 11.6c0 2.4 1.95 4.34 4.35 4.34h1.78v1.72c0 2.4 1.95 4.34 4.35 4.34v-9.57a.84.84 0 0 0-.84-.84H2Z" />
</svg>;

// Botão do Jira ao lado do microfone no painel da conta; só aparece com site, e-mail e token configurados.
function JiraButton(props: { nameplate?: unknown; }) {
    const { jiraSite: site, jiraEmail: email, jiraToken: token } = settings.use(["jiraSite", "jiraEmail", "jiraToken"]);
    if (!site || !email || !token) return null;
    return <PanelButton tooltipText="Jira" icon={JiraIcon} plated={props?.nameplate != null} onClick={openJira} />;
}

// Player de música da call: uma sala por canal de voz no servidor FockyTV.
const music = musicPlayer({ base: () => serverUrl(settings.store.url), fetch: url => Native.musicFetch(url), Socket: proxySocket(Native) });
let panelWatching = "";
let stopActivity: (() => void) | undefined;
let activityTimer: ReturnType<typeof setTimeout> | undefined;
let lastActivity = "";

function syncActivity() {
    clearTimeout(activityTimer);
    // Música e lives também mudam durante eventos Flux; o dispatch precisa esperar o evento terminar.
    activityTimer = setTimeout(() => {
        const key = [...watching].find(([, entry]) => entry.viewing)?.[0];
        const owner = key && ownerOf(key);
        const user = owner ? UserStore.getUser(owner) : undefined;
        const live = panelWatching || (owner ? user?.globalName ?? user?.username ?? liveOwners.get(owner) : undefined);
        const activity = fockyActivity(routingEnabled && settings.store.showActivity, music.snapshot(), live);
        const serialized = JSON.stringify(activity);
        if (serialized === lastActivity) return;
        FluxDispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", socketId: "FockyTV", activity });
        lastActivity = serialized;
    }, 0);
}

const watch = watchParty({ base: () => serverUrl(settings.store.url), fetch: url => Native.musicFetch(url), Socket: proxySocket(Native) });
let watchModal: string | undefined;

function setWatchVolume(value: number) { settings.store.watchVolume = value; syncAudio(); }

function openWatch() {
    watch.listen(true);
    if (watchModal) return;
    watchModal = openModal(props => <WatchPartyPanel {...props} player={watch} music={music} />, { onCloseCallback: () => { watchModal = undefined; } });
}

// Participante adicional só na grade local; não altera a câmera, o Go Live ou o estado de voz.
function showTile(id: string, nick: string, media: MediaStream | null, channel?: string) {
    const user = UserStore.getCurrentUser();
    const voiceState = user && VoiceStateStore.getVoiceStateForUser(user.id);
    if (media && channel && user) localTiles.set(id, { media, channel, participant: {
        id, type: 2, user, userNick: nick, userAvatarDecoration: null,
        voiceState: voiceState?.merge({ selfVideo: true, selfStream: false }) ?? null,
        voicePlatform: null, speaking: false, voiceDb: 0, latched: false, lastSpoke: 0,
        soundsharing: false, ringing: false, localVideoDisabled: false, userVideo: true, streamId: id
    } });
    else if (!localTiles.delete(id)) return;
    ChannelRTCStore.emitChange();
}
const showLyrics = (media: MediaStream | null, channel?: string) => showTile(lyricsStreamId, "Letra · só você", media, channel);

// O <video> da watch party fica fora do DOM (toca o áudio); o tile mostra uma cópia via captureStream.
function syncPartyTile() {
    const { state, channel, watching } = watch.snapshot();
    const shown = localTiles.get(partyStreamId);
    if (!watching || !state || !channel || !partyVideo) showTile(partyStreamId, "", null);
    else if (shown?.channel !== channel) showTile(partyStreamId, "Watch party · YouTube", shown?.media ?? (partyVideo as HTMLVideoElement & { captureStream(): MediaStream; }).captureStream(), channel);
}

function syncLyrics() {
    if (settings.store.hideLyrics) {
        stopLyrics?.();
        stopLyrics = undefined;
        return;
    }
    stopLyrics ??= lyricsCanvas(music, async id => {
        const response = await Native.musicFetch(`${serverUrl(settings.store.url)}/api/fixed/jam/yt/lyrics?${new URLSearchParams({ id })}`);
        if (response.status !== 200) throw new Error(`Letra: HTTP ${response.status}`);
        return JSON.parse(new TextDecoder().decode(response.body));
    }, showLyrics);
}

// Menu "⋯" da call, ao lado de "Exibição em grade".
const callMenu: NavContextMenuPatchCallback = children => {
    const item = <Menu.MenuCheckboxItem id="fockytv-hide-lyrics" label="Ocultar letra de música" checked={settings.store.hideLyrics}
        action={() => { settings.store.hideLyrics = !settings.store.hideLyrics; }} />;
    (findGroupChildrenByChildId("call-grid-view", children) ?? children).push(item);
};

function syncMusic() {
    const channelId = SelectedChannelStore.getVoiceChannelId() ?? undefined;
    const user = UserStore.getCurrentUser();
    music.connect(channelId, user && { id: user.id, name: user.globalName ?? user.username });
    watch.connect(channelId, user && { id: user.id, name: user.globalName ?? user.username });
}

function openMusic() {
    music.listen(true);
    openModal(props => <MusicPanel {...props} context={{
        player: music, me: UserStore.getCurrentUser()?.id ?? "", volume: settings.store.musicVolume,
        setVolume: value => { settings.store.musicVolume = value; syncAudio(); }
    }} />);
}

const MusicIcon = ({ className }: { className?: string; }) => <svg className={className} width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
    <path d="M20 3.2a1 1 0 0 0-1.2-1l-10 2A1 1 0 0 0 8 5.2v10.3A3.5 3.5 0 1 0 10 18.6V9.8l8-1.6v5.3a3.5 3.5 0 1 0 2 3.1V3.2Z" />
</svg>;

// Linha espelhada do espectro a partir do meio do painel: arco-íris correndo pela linha, e espessura e brilho
// pulsando com o grave.
function drawSpectrum(canvas: HTMLCanvasElement, values: number[]) {
    const ratio = devicePixelRatio, width = canvas.clientWidth * ratio, height = canvas.clientHeight * ratio;
    if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
    const context = canvas.getContext("2d")!;
    context.clearRect(0, 0, width, height);
    const hue = performance.now() / 20 % 360, bass = (values[0] + values[1] + values[2] + values[3]) / 4;
    const gradient = context.createLinearGradient(0, 0, width, 0);
    for (let i = 0; i <= 6; i++) gradient.addColorStop(i / 6, `hsl(${hue + i * 60} 90% 65%)`);
    context.strokeStyle = gradient;
    context.lineWidth = (1.5 + bass * 2.5) * ratio;
    context.shadowColor = `hsl(${hue} 90% 65% / 80%)`;
    context.shadowBlur = (6 + bass * 18) * ratio;
    const step = width / (values.length - 1), last = values.length - 1;
    context.beginPath();
    for (const side of [-1, 1]) {
        const y = (i: number) => height / 2 + side * values[i] * height * 0.4;
        context.moveTo(0, y(0));
        for (let i = 1; i < last; i++) context.quadraticCurveTo(i * step, y(i), (i + 0.5) * step, (y(i) + y(i + 1)) / 2);
        context.lineTo(width, y(last));
    }
    context.stroke();
    // Fundos translúcidos deixam o espectro atravessar os controles mesmo com z-index menor.
    const bounds = canvas.getBoundingClientRect();
    for (const button of canvas.parentElement!.querySelectorAll('button, [role="button"]')) {
        const rect = button.getBoundingClientRect();
        context.clearRect((rect.left - bounds.left) * ratio, (rect.top - bounds.top) * ratio, rect.width * ratio, rect.height * ratio);
    }
}

// Botão de música ao lado do de câmera no painel de voz; verde pulsando enquanto toca na call.
// Enquanto você ouve, desenha o espectro da música atrás do painel da conta.
function MusicButton() {
    const { state, current, listening } = useMusic(music);
    const playing = !!current && !!state?.playing;
    const button = useRef<HTMLButtonElement>(null);
    const active = playing && listening;
    useEffect(() => {
        const panel = button.current?.closest<HTMLElement>('[class*="panels_"]');
        if (!active || !panel || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        const canvas = panel.appendChild(Object.assign(document.createElement("canvas"), { className: "fockytv-spectrum" }));
        let frame = requestAnimationFrame(function draw() {
            const bins = music.spectrum();
            if (bins) drawSpectrum(canvas, spectrumPoints(bins, 48));
            frame = requestAnimationFrame(draw);
        });
        return () => { cancelAnimationFrame(frame); canvas.remove(); };
    }, [active]);
    return <Tooltip text={playing ? `Tocando: ${current!.title}` : "Música"}>
        {tooltip => <button type="button" ref={button} {...tooltip} aria-label="Música" className={`fockytv-music-button${playing ? " is-playing" : ""}`} onClick={openMusic}>
            <MusicIcon />
        </button>}
    </Tooltip>;
}

function WatchButton() {
    const { watching } = useWatch(watch);
    return <Tooltip text="Watch party do YouTube">{tooltip => <button type="button" {...tooltip} aria-label="Watch party do YouTube" aria-pressed={watching}
        className={`fockytv-music-button${watching ? " is-playing" : ""}`} onClick={openWatch}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="3" /><path d="m10 8 6 4-6 4Z" /></svg>
    </button>}</Tooltip>;
}

function openPanel() {
    if (modalKey) return;
    modalKey = openModal(props => <Panel {...props} />);
}

function openBragaWelcome(away: number | null, arrived: number) {
    openModal(props => <Modal {...props} title="🛍️ O Braga voltou!" size="sm">
        <div className="fockytv-braga-welcome">
            <div className="fockytv-braga-bags" aria-hidden="true">🛍️ 🛒 🛍️</div>
            <h2>Huestavo, a saudade não cabia nas sacolas! 💜</h2>
            <p>{away === null ? "O Braga está com a gente! O contador de saudade começa agora." : <>Ficamos <strong>{bragaAbsence(away)}</strong> sem ter o Braga com a gente!</>}</p>
            <p>Obrigado por voltar pra gente! A call fica melhor com você. 🥹🎉</p>
            <p className="fockytv-braga-date">Voltou em {new Date(arrived).toLocaleString("pt-BR")}</p>
            <Button onClick={props.onClose}>Bem-vindo de volta, Braga! 🛍️</Button>
        </div>
    </Modal>);
}

let stopJetta: (() => void) | undefined;
let bragaAway: number | null = null;
function trackBraga(event: "arrival" | "departure", time: number) {
    if (event === "departure") {
        settings.store.bragaLastDeparture = time;
        return;
    }
    // shortcut: histórico local de saídas observadas; sincronizar no servidor para cobrir clientes fechados.
    const departure = settings.store.bragaLastDeparture;
    bragaAway = departure > 0 && departure <= time ? time - departure : null;
    settings.store.bragaLastArrival = time;
    settings.store.bragaLastDeparture = 0;
}
function triggerJetta(away: number | null = null, arrived = Date.now()) {
    stopJetta?.();
    stopJetta = showJetta(() => openBragaWelcome(away, arrived));
}
function createJettaEntrance() {
    return jettaEntrance(() => triggerJetta(bragaAway, settings.store.bragaLastArrival), Date.now, trackBraga);
}
let jettaJoined = createJettaEntrance();
function syncJetta() {
    const channel = SelectedChannelStore.getVoiceChannelId();
    const users = channel ? Object.values(VoiceStateStore.getVoiceStatesForChannel(channel))
        .filter(state => UserStore.getUser(state.userId)?.username === "huestavo")
        .map(state => state.userId) : [];
    jettaJoined(channel, users, UserStore.getCurrentUser()?.id);
}

export default definePlugin({
    name: "FockyTV",
    description: "Compartilhe tela/câmera e assista lives FockyTV via WHIP/WHEP.",
    authors: [{ name: "Focky", id: 0n }],
    settings,
    settingsAboutComponent: () => {
        const { githubToken } = settings.use(["githubToken"]);
        return <><Button onClick={openPanel}>Abrir FockyTV</Button>{githubToken.trim() && <Button onClick={openGithub}>Abrir GitHub</Button>}<Button onClick={() => triggerJetta()}>braguilha</Button><UpdateControls /></>;
    },
    flux: {
        USER_SETTINGS_PROTO_UPDATE() {
            setTimeout(() => void syncCameraFilter().catch(error => {
                console.error("FockyTV: filtro da câmera", error);
                void showNotification({ title: "FockyTV: falha no filtro da câmera", body: String(error) });
            }), 0);
        },
        VOICE_STATE_UPDATES() {
            setTimeout(() => {
                const channel = SelectedChannelStore.getVoiceChannelId();
                for (const [id, entry] of cameraViewers)
                    if (entry.channelId !== channel || VoiceStateStore.getVoiceStateForUser(id)?.channelId !== channel) endCamera(id);
                syncMusic();
            }, 0);
            const channelId = SelectedChannelStore.getVoiceChannelId();
            if (!channelId || (discordShare && channelId !== discordShare.channelId)) { void stopPublishing(); closePanel?.(); }
        },
        RTC_CONNECTION_VIDEO({ userId, channelId, streamId, context }: { userId: string; channelId: string; streamId: string | null; context: string; }) {
            if (streamId == null && context === "default") setTimeout(() => restoreCamera(userId, channelId), 0);
        },
        LOGOUT() { music.connect(); watch.connect(); setTimeout(() => { for (const id of cameraViewers.keys()) endCamera(id); }, 0); void stopPublishing(); closePanel?.(); }
    },
    patches: discordPatches,
    contextMenus: { "more-settings-context": callMenu },
    managedStyle,
    // Anel no avatar e selo "AO VIVO" com o estilo do dono da live FockyTV (o seu vem da sua configuração);
    // sem live, quem assiste a sua ganha ondas e o olho no avatar.
    liveClass(userId: string, part: "avatar" | "badge") {
        const style = userId === UserStore.getCurrentUser()?.id ? discordShare && liveStyle(settings.store.liveStyle) : ownerStyles.get(userId);
        if (style) return `fockytv-${part} fockytv-style-${style}`;
        if (part === "avatar" && watchingMyLive(userId)) return "fockytv-viewer";
    },
    githubButton: (props: { nameplate?: unknown; }) => <GithubButton {...props} />,
    openGithub,
    jiraButton: (props: { nameplate?: unknown; }) => <JiraButton {...props} />,
    musicButton: () => <><MusicButton /><WatchButton /></>,
    openJira,
    watchPill: (userId: string) => watchingMyLive(userId) ? <span key="watch" className="fockytv-watch-pill"><EyeIcon />ASSISTINDO</span> : null,
    useLiveViewers(stream: string) {
        const discord = useStateFromStores([ApplicationStreamingStore], () => liveViewers.get(stream)?.length, [stream]);
        const web = useStateFromStores([ApplicationStreamingStore], () => webViewers.get(stream) ?? 0, [stream]);
        return discord == null ? null : { discord, web };
    },
    viewerCount({ discord, web }: { discord: number; web: number; }) {
        const total = discord + web;
        if (!total) return null;
        return <div className="fockytv-viewer-count">
            <UsersIcon />{total} {total === 1 ? "usuário assistindo" : "usuários assistindo"}
            {!!discord && <span className="fockytv-viewer-source">{discord} pelo Discord</span>}
            {!!web && <span className="fockytv-viewer-source">{web} pelo FockyTV</span>}
        </div>;
    },
    localTile: (channel: string, id?: string | null) =>
        [...localTiles.values()].find(tile => tile.channel === channel && (id === undefined || id === tile.participant.id))?.participant,
    includeLocalTiles(participants: Participant[], channel: string) {
        const extra = [...localTiles.values()].filter(tile => tile.channel === channel).map(tile => tile.participant);
        return extra.length ? [...participants, ...extra] : participants;
    },
    localTilesVersion: (channel: string, version: number) =>
        version + [...localTiles].reduce((sum, [id, tile]) => sum + (tile.channel !== channel ? 0 : id === lyricsStreamId ? 0.25 : 0.5), 0),
    routeEnabled: () => routingEnabled,
    discordStream: () => discordShare,
    discordStreamForUser: (userId: string, guildId?: string | null) => discordShare?.ownerId === userId && discordShare.guildId === (guildId ?? null) ? discordShare : null,
    useWatchingMyLive: (userId: string) => useStateFromStores([ApplicationStreamingStore], () => watchingMyLive(userId), [userId]),
    viewerIds: (stream: string | { guildId?: string | null; channelId: string; ownerId: string; }) =>
        liveViewers.get(typeof stream === "string" ? stream : keyOf(stream)),
    discordStreamForKey(key: string) {
        const share = discordShare;
        if (!share) return null;
        const expected = share.guildId ? `guild:${share.guildId}:${share.channelId}:${share.ownerId}` : `call:${share.channelId}:${share.ownerId}`;
        return key === expected ? share : null;
    },
    includeDiscordShare(streams: Stream[], channelId?: string) {
        return discordShare && (!channelId || discordShare.channelId === channelId) && !streams.some(stream => stream.ownerId === discordShare!.ownerId)
            ? [...streams, discordShare] : streams;
    },
    updateDiscordQuality,
    videoComponent(original: React.ComponentType<VideoProps>) { OriginalVideo = original; return VideoComponent; },
    async startDiscordShare(source?: DiscordSource, quality?: Partial<ShareQuality>) {
        const channelId = SelectedChannelStore.getVoiceChannelId();
        const user = UserStore.getCurrentUser();
        if (!channelId || !user) return [false, "no user or channel"];
        if (pending.has("screen")) return [false, "already sharing"];
        if (publishers.has("screen") && discordShare) {
            try {
                const session = publishers.get("screen");
                const native = session instanceof NativeShare && source ? nativeSource(source) : undefined;
                if (session instanceof NativeShare && !native) throw new Error("Fonte incompatível com a captura nativa.");
                const handle = source?.id?.match(/^screen-handle:(\d+)$/)?.[1];
                if (handle && !native) source = { ...source, id: await Native.screenSource(handle, source!.name) };
                const share = discordShare;
                const next = shareChanges.catch(() => {}).then(async () => {
                    if (discordShare !== share || publishers.get("screen") !== session) throw new Error("Transmissão encerrada.");
                    const previous = discordQuality!;
                    const selected = shareQuality(quality ?? {}, previous);
                    noteActivity(source);
                    if (session instanceof NativeShare) await session.restart(native, selected);
                    else {
                        await switchSource(source, selected);
                        try { await session!.setQuality(selected); }
                        catch (error) { await session!.setQuality(previous); throw error; }
                    }
                    if (discordShare === share) commitDiscordQuality(selected);
                });
                shareChanges = next;
                await next;
                return [true, undefined];
            } catch (error) {
                console.error("FockyTV: trocar fonte", error);
                void showNotification({ title: "FockyTV: falha ao trocar de tela", body: String(error) });
                return [false, String(error)];
            }
        }
        if (publishers.has("screen")) return [false, "already sharing"];
        let selected: ShareQuality;
        try { selected = shareQuality(quality ?? {}, StreamingSettings.getState()); }
        catch (error) { return [false, String(error)]; }
        noteActivity(source);
        const guildId = ChannelStore.getChannel(channelId)?.guild_id ?? null;
        const share: NonNullable<typeof discordShare> = { channelId, guildId, ownerId: user.id, streamType: guildId ? "guild" : "call", state: "CONNECTING" };
        discordShare = share;
        discordQuality = selected;
        ApplicationStreamingStore.emitChange();
        try {
            if (!await tryNative(source, selected)) {
                const handle = source?.id?.match(/^screen-handle:(\d+)$/)?.[1];
                if (handle) source = { ...source, id: await Native.screenSource(handle, source!.name) };
                await publish("screen", source, selected);
            }
            if (discordShare !== share || !publishers.has("screen")) return [false, "cancelled"];
            share.state = "ACTIVE";
            commitDiscordQuality(selected);
            ApplicationStreamingStore.emitChange();
            void showNotification({ title: "FockyTV", body: `Transmitindo como ${nickname()} no FockyTV.` });
            void announceLive(share).catch(error => console.warn("FockyTV: aviso da live", error));
            return [true, undefined];
        } catch (error) {
            if (discordShare === share) clearDiscordShare();
            console.error("FockyTV: iniciar pelo Discord", error);
            void showNotification({ title: "FockyTV: falha ao transmitir", body: String(error) });
            return [false, String(error)];
        }
    },
    // Discord web/Vesktop: o botão vai direto ao getDisplayMedia (seletor do Vesktop), sem startStreamWithSource.
    startWebShare() {
        if (!routingEnabled) return false;
        void this.startDiscordShare();
        return true;
    },
    watchTag: (user: { id: string; }) => <><WatchTag user={user} /><MusicTag user={user} /></>,
    ftvTag: (user: { username?: string; }) => <FtvTag user={user} />,
    fetchFtvPreview(guildId: string | null, channelId: string, ownerId: string) {
        if (!routingEnabled) return false;
        const own = ownerId === UserStore.getCurrentUser()?.id ? publishers.get("screen") : undefined;
        const room = own ? nickname() : liveOwners.get(ownerId);
        if (!room) return false;
        if (!ApplicationStreamPreviewStore.shouldFetchPreview(guildId, channelId, ownerId)) return true;
        const streamKey = guildId ? `guild:${guildId}:${channelId}:${ownerId}` : `call:${channelId}:${ownerId}`;
        const version = generation;
        FluxDispatcher.dispatch({ type: "STREAM_PREVIEW_FETCH_START", streamKey });
        void (async () => {
            let temporary: Viewing | undefined;
            try {
                let media = own?.capture ?? watching.get(streamKey)?.viewing?.media;
                if (!media) {
                    livekit ??= loadLivekit(livekitSource, proxySocket(Native));
                    temporary = await watchLive(livekit, request, serverUrl(settings.store.url), room, nickname(), () => {});
                    media = temporary.media;
                }
                const previewURL = await thumbnail(media);
                if (!routingEnabled || version !== generation || (own ? publishers.get("screen") !== own : liveOwners.get(ownerId) !== room))
                    throw new Error("A live terminou.");
                FluxDispatcher.dispatch({ type: "STREAM_PREVIEW_FETCH_SUCCESS", streamKey, previewURL });
            } catch (error) {
                console.warn("FockyTV: miniatura", error);
                FluxDispatcher.dispatch({ type: "STREAM_PREVIEW_FETCH_FAIL", streamKey, retryAfter: 30_000 });
            } finally { temporary?.close(); }
        })();
        return true;
    },
    cameraActive: () => publishers.has("camera"),
    selfVideo(state: { userId?: string; channelId?: string | null; selfVideo?: boolean; }) {
        return !!state.selfVideo || (!!state.userId && !!cameraViewers.get(state.userId)?.viewing && state.channelId === SelectedChannelStore.getVoiceChannelId()) || (publishers.has("camera") && state.userId === UserStore.getCurrentUser()?.id && state.channelId === SelectedChannelStore.getVoiceChannelId());
    },
    discordCamera(enabled: boolean) {
        const active = publishers.has("camera");
        if (!enabled && !active) return false;
        if (enabled === active || pending.has("camera")) return true;
        publish("camera").then(() => {
            const track = publishers.get("camera")?.capture?.getVideoTracks()[0];
            if (track) {
                const { width, height } = track.getSettings();
                void showNotification({ title: "FockyTV", body: `Câmera no FockyTV como ${cameraKey(nickname())}: ${track.label} (${width}x${height}).` });
            }
        }, error => {
            console.error("FockyTV: câmera", error);
            void showNotification({ title: "FockyTV: falha na câmera", body: String(error) });
        });
        return true;
    },
    stopDiscordStream(key: string) {
        const share = discordShare;
        if (!share) return false;
        const expected = share.guildId ? `guild:${share.guildId}:${share.channelId}:${share.ownerId}` : `call:${share.channelId}:${share.ownerId}`;
        if (key !== expected) return false;
        clearDiscordShare();
        const session = publishers.get("screen");
        publishers.delete("screen");
        void session?.close();
        return true;
    },
    liveSelfStream,
    watchFockyStream(key: string) {
        if (!routingEnabled || !liveOwners.has(ownerOf(key))) return false;
        fockyStreams.add(key);
        // Assistir de novo (ex.: "tentar novamente" após falha) sempre reconecta.
        closeViewing(key);
        void startWatch(key);
        return true;
    },
    unwatchFockyStream(key: string) {
        if (!fockyStreams.has(key)) return false;
        endWatch(key);
        return true;
    },
    start() {
        routingEnabled = true;
        stopActivity = music.subscribe(syncActivity);
        syncActivity();
        jettaJoined = createJettaEntrance();
        syncJetta();
        VoiceStateStore.addChangeListener(syncJetta);
        SelectedChannelStore.addChangeListener(syncJetta);
        notifiedRevision = "";
        livePoll = setInterval(() => void refreshLives(), 5000);
        MediaEngineStore.addChangeListener(syncAudio);
        void refreshPresence();
        presencePoll = setInterval(() => void refreshPresence(), 30_000);
        updateCheck = setTimeout(() => void notifyUpdate(), 0);
        stopUpdateEvents = watchPluginUpdates(proxySocket(Native), settings.store.url, () => void notifyUpdate(), notification => {
            if (!settings.store.githubToken.trim()) return;
            void showNotification({ title: notification.title, body: notification.body, onClick: () => void VencordNative.native.openExternal(notification.url) });
        });
        updatePoll = setInterval(() => void notifyUpdate(), 15 * 60 * 1000); // Recupera eventos perdidos se o webhook ou o WebSocket estiver indisponível.
        document.addEventListener("keydown", replayShortcut);
        syncMusic();
        syncLyrics();
        partyVideo = document.createElement("video");
        watch.attach(partyVideo);
        stopPartyTile = watch.subscribe(syncPartyTile);
        syncPartyTile();
        syncAudio();
    },
    stop() {
        routingEnabled = false;
        stopActivity?.();
        stopActivity = undefined;
        syncActivity();
        VoiceStateStore.removeChangeListener(syncJetta);
        SelectedChannelStore.removeChangeListener(syncJetta);
        stopJetta?.();
        stopJetta = undefined;
        for (const id of cameraViewers.keys()) endCamera(id);
        clearInterval(livePoll);
        MediaEngineStore.removeChangeListener(syncAudio);
        clearInterval(presencePoll);
        clearTimeout(updateCheck);
        clearInterval(updatePoll);
        stopUpdateEvents?.();
        stopUpdateEvents = undefined;
        updateQueued = false;
        document.removeEventListener("keydown", replayShortcut);
        stopLyrics?.();
        stopLyrics = undefined;
        stopPartyTile?.();
        stopPartyTile = undefined;
        watch.attach();
        partyVideo = undefined;
        showTile(partyStreamId, "", null);
        music.connect(); watch.connect();
        closePictureInPicture();
        ftvUsers.clear();
        ftvListeners.forEach(listener => listener());
        void refreshLives(); // sem routing: encerra as lives assistidas e tira o "AO VIVO"
        closePanel?.();
        void stopPublishing();
    }
});
