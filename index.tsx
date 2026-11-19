// SPDX-License-Identifier: GPL-3.0-or-later
import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { showNotification } from "@api/Notifications";
import { definePluginSettings, Settings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { copyToClipboard } from "@utils/clipboard";
import { IS_WINDOWS } from "@utils/constants";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Participant, RenderModalProps, Stream, UserParticipant } from "@vencord/discord-types";
import { findComponentByCodeLazy, findByPropsLazy, findStoreLazy } from "@webpack";
import { ApplicationStreamingStore, ApplicationStreamPreviewStore, ChannelRTCStore, ChannelStore, FluxDispatcher, GuildStore, MediaEngineStore, Menu, Modal, openModal, PermissionsBits, PermissionStore, React, SelectedChannelStore, UserStore, VoiceStateStore, Tooltip, useEffect, useRef, useState, useStateFromStores } from "@webpack/common";

import { fockyActivity } from "./activity";
import { annotationBoard, AnnotationBoard } from "./annotations";
import { AnnotationLayer } from "./annotations-panel";
import { screenAudio } from "./audio";
import { cameraFilterActive, captureNativeCamera, syncCameraFilter } from "./camera";
import { logVideoEvent, videoElementsSnapshot, videoEvents, videoStats } from "./diagnostics";
import { captureConstraints, DiscordSource, discordPatches, matchCamera } from "./discord";
import { GithubAlertsRequest, watchGithubAlerts } from "./github-alerts";
import { GithubFetch, githubError, repositoryName } from "./github";
import { GithubQueueRequest, markGithubQueueSeen, mergeQueueState } from "./github-queue";
import { ActionIcon, GithubPanel, useGithubQueue } from "./github-panel";
import { jiraError, jiraSite } from "./jira";
import { JiraFetch, JiraPanel } from "./jira-panel";
import { musicPlayer, spectrumPoints } from "./music";
import { lyricsCanvas } from "./music-lyrics";
import { MusicPanel, useMusic } from "./music-panel";
import { streamAudio } from "./playback";
import { cameraKey, liveStyle, liveStyles, streamKey } from "./protocol";
import { detectProfile } from "./profile";
import { qualityConstraints, shareQuality, ShareQuality } from "./quality";
import { replayBuffer } from "./replay";
import { LivePublisher, Request, Session } from "./session";
import { soundboardClip, SoundboardClip } from "./soundboard";
import { thumbnail } from "./thumbnail";
import { watchPluginUpdates } from "./update-events";
import { loadLivekit, proxySocket, receivedQuality, Viewing, watchLive } from "./viewer";
import { watchParty } from "./watch-party";
import { useWatch, WatchControls, WatchPartyPanel } from "./watch-party-panel";
import livekitSource from "file://./livekit-client.umd.js";
import managedStyle from "./style.css?managed";

// Aviso do guarda de boot: o native desativou o plugin porque o Discord não abriu direito com ele
// duas vezes seguidas. Renderiza mesmo com o plugin desativado, com o botão de reativação.
function CrashGuardNotice() {
    const [dismissed, setDismissed] = useState(false);
    if (!settings.store.crashDisabled || dismissed) return null;
    return <>
        <SettingsSection title="FockyTV ficou inativo para não derrubar o Discord" description="O Discord não terminou de abrir com o plugin ativo duas vezes seguidas (queda na inicialização, fechamento forçado ou queda de energia). Ele foi desativado automaticamente para você não perder o Discord — pode ter sido uma atualização do próprio Discord. Reative e reinicie o Discord para tentar de novo; se o problema voltar, ele dorme outra vez." />
        <Button variant="secondary" onClick={() => {
            settings.store.crashDisabled = false;
            Settings.plugins.FockyTV.enabled = true;
            setDismissed(true);
        }}>Reativar o FockyTV</Button>
    </>;
}

let bootHealthy: ReturnType<typeof setTimeout> | undefined;
const settings = definePluginSettings({
    crashGuard: { type: OptionType.COMPONENT, component: () => <CrashGuardNotice /> },
    crashDisabled: { type: OptionType.BOOLEAN, description: "Marca da guarda de boot: o Discord não abriu direito com o plugin ativo.", default: false, hidden: true },
    sharingSection: { type: OptionType.COMPONENT, component: () => <SettingsSection title="Compartilhamento" description="FPS e resolução são escolhidos no menu de compartilhar tela do Discord." /> },
    liveTitle: { type: OptionType.STRING, description: "Título da live no aviso do canal (vazio: \"Live de <seu nome>\"). O jogo ou a janela transmitida aparece junto.", default: "" },
    experienceSection: { type: OptionType.COMPONENT, component: () => <SettingsSection title="Visual e reprodução" description="Personalize sua live e escolha o que aparece durante a chamada." /> },
    liveStyle: { type: OptionType.COMPONENT, default: "rainbow", component: ({ setValue }) => <LiveStylePicker setValue={setValue} /> },
    replayBuffer: { type: OptionType.BOOLEAN, description: "Replay das lives assistidas. Alt+Shift+R salva os últimos 30–60 s em Vídeos/FockyTV. Grava em segundo plano enquanto você assiste e usa um pouco de CPU. Vale na próxima live assistida.", default: false },
    showActivity: { type: OptionType.BOOLEAN, description: "Mostrar no perfil do Discord a música ou live que você acompanha. A live tem prioridade.", default: true, onChange: () => syncActivity() },
    hideLyrics: { type: OptionType.BOOLEAN, description: "Ocultar o tile com a letra da música na chamada.", default: false, onChange: () => routingEnabled && syncLyrics() },
    annotations: { type: OptionType.BOOLEAN, description: "Anotações no preview da sua transmissão e no seu monitor ao transmitir a tela inteira — no Windows pela captura excluída, no Hyprland pelo overlay fixado fora da transmissão. Quem assiste tem a caneta na live por padrão, controlada pelo toggle Permitir anotações.", default: false, onChange: () => syncAnnotationOverlay(overlaySource) },
    integrationsSection: { type: OptionType.COMPONENT, component: () => <SettingsSection title="Integrações" description="Conecte suas contas para acompanhar projetos sem sair da chamada. Os tokens ficam salvos neste cliente." /> },
    githubToken: { type: OptionType.COMPONENT, default: "", component: ({ setValue }) => <GithubTokenInput setValue={setValue} /> },
    githubRepository: { type: OptionType.STRING, description: "GitHub: projeto pré-selecionado (dono/repositório). A escolha no painel fica salva aqui.", default: "", isValid: value => { try { if (value) repositoryName(String(value)); return true; } catch { return false; } } },
    jiraSite: { type: OptionType.STRING, description: "Jira Cloud: endereço do site (https://empresa.atlassian.net).", default: "", isValid: value => { try { if (value) jiraSite(String(value)); return true; } catch { return false; } } },
    jiraEmail: { type: OptionType.STRING, description: "Jira Cloud: e-mail da sua conta Atlassian.", default: "" },
    jiraToken: { type: OptionType.COMPONENT, default: "", component: ({ setValue }) => <JiraTokenInput setValue={setValue} /> },
    advancedSection: { type: OptionType.COMPONENT, component: () => <SettingsSection title="Avançado" description="Canal de atualização (que também define o servidor) e seletor de captura no Linux." /> },
    updateBranch: { type: OptionType.SELECT, description: "Canal do plugin e do servidor: main usa fockytv.felipemayer.com.br e insider usa fockytv-insider.felipemayer.com.br. Trocar exige instalar a versão do canal e reiniciar.", options: [{ label: "main · estável", value: "main", default: true }, { label: "insider · experimental", value: "insider" }], onChange: () => { notifiedRevision = ""; void notifyUpdate(); void ensureStreamMediaCsp(); } },
    linuxSharePicker: { type: OptionType.COMPONENT, component: () => <LinuxSharePicker /> },
    jiraBoard: { type: OptionType.NUMBER, description: "Último board aberto no Jira.", default: 0, hidden: true },
    watchVolume: { type: OptionType.NUMBER, description: "Volume da watch party (0–1).", default: 0.5, hidden: true },
    musicVolume: { type: OptionType.NUMBER, description: "Volume do player de música da call (0–1).", default: 0.5, hidden: true }
});

function SettingsSection({ title, description }: { title: string; description: string; }) {
    return <header className="fockytv-settings-section"><h3>{title}</h3><p>{description}</p></header>;
}

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
        <p>O anel do avatar e o selo aparecem para quem tem o plugin atualizado. Vale na próxima transmissão.</p>
        <div className="fockytv-style-selected">
            <LiveStylePreview style={current} />
            <span>Selecionado: <strong>{liveStyles[current as keyof typeof liveStyles]}</strong></span>
        </div>
        <div className="fockytv-style-picker" role="group" aria-label="Estilo da sua live">
            {Object.entries(liveStyles).map(([value, label]) =>
                <Tooltip key={value} text={<LiveStylePreview style={value} />}>
                    {tooltip => <button {...tooltip} type="button" aria-pressed={current === value} className={`fockytv-style-option ${value ? `fockytv-style-${value}` : ""}`} onClick={() => { setCurrent(value); setValue(value); }}>
                        <span className="fockytv-style-option-label">{label}</span>
                        <span aria-hidden="true" className={`fockytv-preview-badge${value ? ` fockytv-badge fockytv-style-${value}` : ""}`}>AO VIVO</span>
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
    // Preview do apresentador ganha o mesmo wrapper para receber as anotações de quem assiste.
    const annotations = settings.store.annotations;
    const presenting = annotations && props.streamId === previewStreamId && !!discordShare;
    if (!pip && !presenting) return element;
    // Webcam e live assistida têm PiP; o replay pertence só à live de tela.
    // A live assistida sempre tem a camada de anotações (a caneta do espectador não depende
    // da configuração local; o dono controla pelo "Permitir anotações").
    const key = watched ? props.streamId!.slice(watchStreamPrefix.length) : undefined;
    const stop = (event: React.SyntheticEvent) => event.stopPropagation();
    return <div className="fockytv-player">
        {element}
        {presenting && <AnnotationLayer board={annotationBoardFor(UserStore.getCurrentUser()?.id ?? "")} />}
        {key && watched && <AnnotationLayer board={annotationBoardFor(ownerOf(key))} />}
        {pip && <div className="fockytv-player-controls" onClick={stop} onDoubleClick={stop}>
            {key && watching.get(key)?.replay && <button type="button" className="fockytv-player-button" title="Salvar os últimos 30 a 60 s (Alt+Shift+R)" onClick={() => void saveReplay(key)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>Replay
            </button>}
            <button type="button" className="fockytv-player-button" title="Picture-in-picture" aria-label="Picture-in-picture" onClick={() => void togglePictureInPicture(pip)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor" /></svg>
            </button>
        </div>}
    </div>;
}

// Picture-in-picture num popout próprio: continua aberto quando o tile do Discord desmonta ao trocar de canal.
const pipWindows = new Map<MediaStream, { window?: Window; video?: HTMLVideoElement; }>();
async function togglePictureInPicture(media: MediaStream) {
    if (pipWindows.has(media)) return closePictureInPicture(media);
    const entry: { window?: Window; video?: HTMLVideoElement; } = {};
    pipWindows.set(media, entry);
    try {
        // O PiP nativo do Chromium substitui a janela anterior; popouts permitem uma por mídia.
        await Native.preparePictureInPicture();
        if (pipWindows.get(media) !== entry) return;
        const popup = window.open("about:blank", `fockytv-pip-${crypto.randomUUID()}`, "popup,width=480,height=270");
        if (!popup) throw new Error("Não foi possível abrir a janela de picture-in-picture.");
        entry.window = popup;
        popup.document.title = "FockyTV — Picture-in-picture";
        Object.assign(popup.document.body.style, { margin: "0", background: "#000", overflow: "hidden" });
        const video: HTMLVideoElement = entry.video = Object.assign(popup.document.createElement("video"), { muted: true, playsInline: true, autoplay: true, srcObject: media });
        Object.assign(video.style, { width: "100vw", height: "100vh", objectFit: "contain" });
        popup.document.body.append(video);
        popup.addEventListener("pagehide", () => {
            video.srcObject = null;
            if (pipWindows.get(media) === entry) pipWindows.delete(media);
        }, { once: true });
        await video.play();
    } catch (error) {
        if (pipWindows.get(media) !== entry) return;
        closePictureInPicture(media);
        console.warn("FockyTV: picture-in-picture", error);
        void showNotification({ title: "FockyTV: picture-in-picture indisponível", body: String(error) });
    }
}

function closePictureInPicture(media?: MediaStream) {
    for (const [stream, entry] of pipWindows) {
        if (media && stream !== media) continue;
        pipWindows.delete(stream);
        if (entry.video) entry.video.srcObject = null;
        entry.window?.close();
    }
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
let cameraSync: ReturnType<typeof setTimeout> | undefined;
const scheduleCamera = () => { clearTimeout(cameraSync); cameraSync = setTimeout(syncCamera, 0); };
const publishers = new class extends Map<"screen" | "camera", LivePublisher> {
    set(kind: "screen" | "camera", session: LivePublisher) { super.set(kind, session); scheduleCamera(); return this; }
    delete(kind: "screen" | "camera") { const deleted = super.delete(kind); scheduleCamera(); return deleted; }
    clear() { super.clear(); scheduleCamera(); }
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
    syncAnnotationOverlay(undefined);
    discordQuality = null;
    ApplicationStreamingStore.emitChange();
    setTimeout(() => updatePreview(share, null), 0);
}
// Lives FockyTV de quem está na sua call, casadas pelo username do Discord (a stream key do plugin).
const liveOwners = new Map<string, string>(); // id do Discord → stream key FockyTV (sala LiveKit)
// Stream key do Discord ("guild:g:c:dono" / "call:c:dono") → live assistida.
const watching = new Map<string, { controller: AbortController; viewing?: Viewing; audio?: ReturnType<typeof streamAudio>; replay?: ReturnType<typeof replayBuffer>; }>();
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
const liveCameras = new Map<string, { room: string; channelId: string; }>();
const cameraViewers = new Map<string, { room: string; channelId: string; controller: AbortController; viewing?: Viewing; }>();
// "Parar de assistir" manual: vale enquanto a webcam existir no seu canal; a webcam acabar ou
// você trocar de canal esquece, e ela volta a abrir sozinha na próxima vez.
const cameraStopped = new Set<string>();
// Lives e câmeras em canais que você não está (descoberta guild-wide fora da chamada): id do Discord → canal.
// O selfStream/selfVideo cozido desses usuários faz a barra lateral mostrar o anel "AO VIVO", o botão
// Assistir e a webcam sem entrar na sala; a chamada atual continua valendo-se de liveOwners/cameraViewers.
const guildLives = new Map<string, string>();
const guildCameras = new Map<string, string>();
function cameraVideo(userId: string, channelId: string, streamId: string | null) {
    FluxDispatcher.dispatch({ type: "RTC_CONNECTION_VIDEO", guildId: ChannelStore.getChannel(channelId)?.guild_id ?? null, channelId, userId, streamId, rtcServerId: null, context: "default" });
    const state = VoiceStateStore.getVoiceStateForUser(userId);
    if (state?.channelId === channelId) FluxDispatcher.dispatch({ type: "VOICE_STATE_UPDATES", voiceStates: [{ ...state, guildId: ChannelStore.getChannel(channelId)?.guild_id ?? null, selfVideo: false }] });
}
function endCamera(userId: string) {
    const entry = cameraViewers.get(userId);
    if (!entry) return;
    cameraViewers.delete(userId);
    logVideoEvent("camera-close", entry);
    entry.controller.abort();
    if (entry.viewing) closePictureInPicture(entry.viewing.media);
    entry.viewing?.close();
    cameraVideo(userId, entry.channelId, null);
}
async function watchCamera(userId: string, room: string, channelId: string) {
    if (cameraViewers.has(userId)) return;
    const entry: { room: string; channelId: string; controller: AbortController; viewing?: Viewing; } = { room, channelId, controller: new AbortController() };
    cameraViewers.set(userId, entry);
    logVideoEvent("camera-open", entry);
    try {
        livekit ??= loadLivekit(livekitSource, proxySocket(Native));
        const viewing = await watchLive(livekit, request, serverBase(), room, nickname(), () => {
            if (cameraViewers.get(userId) === entry) endCamera(userId);
        }, entry.controller.signal);
        if (cameraViewers.get(userId) !== entry) { viewing.close(); return; }
        entry.viewing = viewing;
        logVideoEvent("camera-ready", entry);
        cameraVideo(userId, channelId, watchCameraPrefix + userId);
    } catch (error) {
        if (entry.controller.signal.aborted) return;
        logVideoEvent("camera-error", entry);
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
// Atualização do canal escolhido para o botão da barra de título (ao lado da ajuda).
let headerUpdate: UpdateInfo | null = null;
const headerListeners = new Set<() => void>();
function setHeaderUpdate(update: UpdateInfo | null) { headerUpdate = update; headerListeners.forEach(listener => listener()); }
let updateChecking = false, updateQueued = false;
let stopUpdateEvents: (() => void) | undefined;
let stopGithubAlerts: (() => void) | undefined;
let stopDrawEvents: (() => void) | undefined;
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
// Atributos no próprio SVG: na HUD do overlay em jogo o CSS do plugin não chega e, sem eles,
// o ícone vira uma bola preta no tamanho padrão. No cliente normal o CSS do pill sobrescreve tudo.
const EyeIcon = () => <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>;
const UsersIcon = () => <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5" /><path d="M2.5 19c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" /><path d="M15.5 4.8a3.5 3.5 0 0 1 0 6.4" /><path d="M18 13.4c2.2.8 3.5 2.9 3.5 5.6" /></svg>;

function liveSelfStream(state: { userId?: string; channelId?: string | null; selfStream?: boolean; }) {
    // Na sua chamada vale liveOwners (cobre chamadas privadas, sem guilda); fora dela, a descoberta guild-wide.
    return !!state.selfStream
        || (!!state.userId && liveOwners.has(state.userId) && state.channelId != null && state.channelId === SelectedChannelStore.getVoiceChannelId())
        || (!!state.userId && guildLives.get(state.userId) === state.channelId);
}

// O gateway não emite STREAM_CREATE para lives FockyTV, então o Discord nunca toca o aviso delas:
// toca o som nativo ("a live começou") quando o poll vê uma live nova na chamada.
function playStreamStartSound() {
    try {
        const SoundUtils = findByPropsLazy("createSound");
        const sound = SoundUtils.Sounds?.STREAM_STARTED ?? "stream_started";
        if (typeof SoundUtils.playSound === "function") SoundUtils.playSound(sound);
        else SoundUtils.createSound(sound)?.play?.();
    } catch (error) { console.warn("FockyTV: som de início de live", error); }
}

// A própria live caiu (conexão perdida ou captura morta): notificação desktop some atrás do jogo,
// o som nativo do fim de stream é o que faz o dono perceber sem olhar.
function playStreamEndSound() {
    try {
        const SoundUtils = findByPropsLazy("createSound");
        const sound = SoundUtils.Sounds?.STREAM_ENDED ?? "stream_ended";
        if (typeof SoundUtils.playSound === "function") SoundUtils.playSound(sound);
        else SoundUtils.createSound(sound)?.play?.();
    } catch (error) { console.warn("FockyTV: som de fim de live", error); }
}

// Primeira observação de cada canal é base de referência: quem já estava ao vivo não toca o aviso.
let soundChannel: string | null | undefined;

async function refreshLives() {
    const channelId = SelectedChannelStore.getVoiceChannelId();
    const keys = new Map<string, string>(); // minúsculo → stream key exata
    const lives = new Map<string, { viewers: string[]; sessions: number; quality?: LiveQuality; }>(); // minúsculo → espectadores e qualidade
    let stamp: string | undefined;
    if (routingEnabled) {
        try {
            const response = await request(`${serverBase()}/api/status`, "GET");
            if (response.status !== 200) return;
            // Corpo bruto + canal + quem está na call: igual ao último poll, nada mudou — pula parse, varredura e diff.
            stamp = `${channelId}:${Object.keys(channelId ? VoiceStateStore.getVoiceStatesForChannel(channelId) : {}).join()}:${response.body}`;
            if (stamp === lastLivesBody) return;
            for (const live of JSON.parse(response.body) as { streamKey: string; engine?: string; videoTracks?: unknown[]; sessions?: { viewer?: string; }[]; quality?: LiveQuality; }[])
                if (live.engine === "livekit" && live.videoTracks?.length) {
                    keys.set(live.streamKey.toLowerCase(), live.streamKey);
                    lives.set(live.streamKey.toLowerCase(), { viewers: (live.sessions ?? []).flatMap(session => session.viewer ? [session.viewer.toLowerCase()] : []), sessions: live.sessions?.length ?? 0, quality: live.quality });
                }
        } catch (error) { console.warn("FockyTV: lives", error); return; }
    }
    // Ignora respostas de uma chamada anterior ou de um plugin já desativado.
    if (channelId !== SelectedChannelStore.getVoiceChannelId()) return;
    if (stamp !== undefined) lastLivesBody = stamp; // só vale como "já visto" se este poll passou pela guarda do canal
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
    liveCameras.clear();
    if (channelId) cameraRooms.forEach((room, id) => liveCameras.set(id, { room, channelId }));
    // A webcam da sua chamada abre sozinha, como a nativa do Discord; "Parar de assistir"
    // segura até a webcam acabar ou você sair do canal.
    if (channelId) for (const [id, room] of cameraRooms)
        if (!cameraViewers.has(id) && !cameraStopped.has(id)) void watchCamera(id, room, channelId);
    for (const id of [...cameraStopped]) if (!cameraRooms.has(id)) cameraStopped.delete(id);
    const owners = new Map(Object.keys(channelId ? VoiceStateStore.getVoiceStatesForChannel(channelId) : {})
        .filter(id => id !== me).map(id => [id, keys.get(UserStore.getUser(id)?.username?.toLowerCase() ?? "")] as const)
        .filter((owner): owner is [string, string] => !!owner[1]));
    const styles = new Map([...owners].map(([id, key]) => {
        const quality = lives.get(key.toLowerCase())?.quality;
        // Um anúncio de qualidade ausente não deve apagar o visual já conhecido da live.
        return [id, quality ? liveStyle(quality.style) : ownerStyles.get(id) ?? ""] as const;
    }));
    // O estilo chega com o anúncio de qualidade, às vezes depois da live: também reaplica a linha de quem mudou de estilo.
    const changed = [...new Set([...owners.keys(), ...liveOwners.keys()])].filter(id => owners.has(id) !== liveOwners.has(id) || styles.get(id) !== ownerStyles.get(id));
    const started = soundChannel === channelId ? [...owners.keys()].filter(id => !liveOwners.has(id)) : [];
    soundChannel = channelId;
    liveOwners.clear();
    owners.forEach((key, id) => liveOwners.set(id, key));
    ownerStyles.clear();
    styles.forEach((style, id) => ownerStyles.set(id, style));
    // Boards de anotação: vivem enquanto a live do dono existir (ou eu estiver transmitindo).
    const annotationTargets = new Set(liveOwners.keys());
    if (discordShare) annotationTargets.add(me ?? "");
    for (const owner of annotationBoards.keys()) if (!annotationTargets.has(owner)) annotationBoards.delete(owner);
    for (const key of [...watching.keys()]) if (!liveOwners.has(ownerOf(key))) endWatch(key);
    // Fora da sua chamada: casa as lives e câmeras do servidor com o estado de voz de todos os canais
    // dos seus servidores, para os selos aparecerem na barra lateral sem entrar na sala. Tem de rodar
    // ANTES dos reapliques de voz: o patch cozinha o selfStream de cada um deles com estes mapas, e um
    // reaplique com a descoberta velha recria o selo da live que acabou de terminar na sua chamada
    // (o segundo reaplique pula quem mudou de liveOwners, então o selo ficava preso até a próxima
    // atualização de voz real do dono).
    const nextLives = new Map<string, string>();
    const nextCameras = new Map<string, string>();
    for (const guild of Object.values(GuildStore.getGuilds() ?? {})) {
        for (const [id, state] of Object.entries(VoiceStateStore.getVoiceStates(guild.id) ?? {})) {
            if (id === me || state.channelId == null) continue;
            const username = UserStore.getUser(id)?.username;
            if (!username) continue;
            try {
                if (keys.get(cameraKey(username).toLowerCase())) { nextCameras.set(id, state.channelId); continue; }
                const room = keys.get(username.toLowerCase());
                if (room) nextLives.set(id, state.channelId);
            } catch { /* Username incompatível com as chaves FockyTV. */ }
        }
    }
    const remoteChanged = new Set<string>();
    for (const [id, room] of nextLives) if (guildLives.get(id) !== room) remoteChanged.add(id);
    for (const [id, room] of nextCameras) if (guildCameras.get(id) !== room) remoteChanged.add(id);
    for (const id of guildLives.keys()) if (!nextLives.has(id)) remoteChanged.add(id);
    for (const id of guildCameras.keys()) if (!nextCameras.has(id) && !nextLives.has(id)) remoteChanged.add(id);
    guildLives.clear();
    nextLives.forEach((room, id) => guildLives.set(id, room));
    guildCameras.clear();
    nextCameras.forEach((room, id) => guildCameras.set(id, room));
    const guildId = channelId ? ChannelStore.getChannel(channelId)?.guild_id ?? null : null;
    if (changed.length && channelId) {
        // Reaplica o estado de voz atual: os patches marcam selfStream e o Discord mostra "AO VIVO" e o botão Assistir.
        // ponytail: um Go Live nativo simultâneo some até a próxima atualização de voz real desse usuário
        const voiceStates = changed.map(id => VoiceStateStore.getVoiceStateForUser(id)).filter(Boolean).map(state => ({ ...state, guildId, selfStream: false }));
        if (voiceStates.length) FluxDispatcher.dispatch({ type: "VOICE_STATE_UPDATES", voiceStates });
    }
    // Quem está na sua chamada já foi reaplicado acima com o canal e a guilda certos.
    const remote = [...remoteChanged].filter(id => !changed.includes(id));
    if (remote.length) {
        const voiceStates = remote.map(id => VoiceStateStore.getVoiceStateForUser(id)).filter(Boolean)
            .map(state => ({ ...state, guildId: state.channelId != null ? ChannelStore.getChannel(state.channelId)?.guild_id ?? null : null, selfStream: false }));
        if (voiceStates.length) FluxDispatcher.dispatch({ type: "VOICE_STATE_UPDATES", voiceStates });
    }
    // Surdo não ouve aviso nenhum; uma chamada só, mesmo que duas lives comecem no mesmo poll.
    if (started.length && !MediaEngineStore.isSelfDeaf()) playStreamStartSound();
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
    // Um serialize só: compara com o último aplicado em vez de re-serializar os maps atuais.
    const applied = JSON.stringify([...viewers, ...web]);
    if (applied === lastViewers) return;
    lastViewers = applied;
    liveViewers.clear();
    viewers.forEach((ids, key) => liveViewers.set(key, ids));
    webViewers.clear();
    web.forEach((count, key) => webViewers.set(key, count));
    ApplicationStreamingStore.emitChange();
}

// Corpo bruto (com canal e quem está na call) do último /api/status processado: igual ⇒ nada mudou.
let lastLivesBody = "";
// Espectadores já aplicados, serializados: um JSON.stringify a menos e emitChange só de verdade.
let lastViewers = "[]";
// Poll pausa com a janela escondida; ao voltar, atualiza na hora.
function refreshOnVisible() { if (!document.hidden) void refreshLives(); }

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
    if (watching.has(key)) return;
    const entry: NonNullable<ReturnType<typeof watching.get>> = { controller: new AbortController() };
    watching.set(key, entry);
    logVideoEvent("screen-open", entry);
    try {
        const room = liveOwners.get(ownerOf(key));
        if (!room) throw new Error("A live terminou.");
        livekit ??= loadLivekit(livekitSource, proxySocket(Native));
        let viewer = "";
        try { viewer = nickname(); } catch { }
        const ended = () => { if (watching.get(key) === entry) endWatch(key); };
        const viewing = await watchLive(livekit, request, serverBase(), room, viewer, ended, entry.controller.signal);
        if (watching.get(key) !== entry) { viewing.close(); return; }
        entry.viewing = viewing;
        logVideoEvent("screen-ready", entry);
        syncActivity();
        // Um único elemento toca o áudio; os tiles de vídeo (podem ser vários) ficam mudos.
        entry.audio = streamAudio(viewing.media);
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
        if (entry.controller.signal.aborted) return;
        logVideoEvent("screen-error", entry);
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
    logVideoEvent("screen-close", entry);
    entry.controller.abort();
    syncActivity();
    entry.replay?.stop();
    if (entry.viewing) closePictureInPicture(entry.viewing.media);
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

// Quem está com o plugin ligado agora (presença nos servidores dos dois canais), para a etiqueta [FTV] na
// lista de voz: cada cliente se registra só no servidor do seu canal; quem está na insider fica roxo.
const ftvUsers = new Map<string, Channel>();
const ftvListeners = new Set<() => void>();
let presencePoll: ReturnType<typeof setInterval> | undefined;

async function refreshPresence() {
    const me = UserStore.getCurrentUser()?.username;
    const lists = await Promise.all(CHANNELS.map(async ch => {
        try {
            const query = ch === channel() && routingEnabled && me ? `?user=${encodeURIComponent(me.toLowerCase())}` : "";
            const response = await request(`${SERVERS[ch]}/api/presence${query}`, "GET");
            return response.status === 200 ? JSON.parse(response.body) as string[] : []; // servidor sem o endpoint: sem etiquetas
        } catch (error) { console.warn(`FockyTV: presença (${ch})`, error); return []; }
    }));
    const next = new Map<string, Channel>();
    CHANNELS.forEach((ch, i) => lists[i].forEach(user => next.set(user, ch)));
    if (next.size === ftvUsers.size && [...next].every(([user, ch]) => ftvUsers.get(user) === ch)) return;
    ftvUsers.clear();
    next.forEach((ch, user) => ftvUsers.set(user, ch));
    ftvListeners.forEach(listener => listener());
}

function FtvTag({ user }: { user?: { id?: string; username?: string; }; }) {
    const [, update] = useState(0);
    useEffect(() => {
        const listener = () => update(n => n + 1);
        ftvListeners.add(listener);
        return () => { ftvListeners.delete(listener); };
    }, []);
    const ch = user?.username && ftvUsers.get(user.username.toLowerCase());
    if (!ch) return null;
    return <span title={ch === "insider" ? "Usando o plugin FockyTV (insider)" : "Usando o plugin FockyTV"}
        style={{ marginLeft: 4, fontSize: 10, fontWeight: 700, color: ch === "insider" ? "#a855f7" : "var(--text-brand, #5865f2)" }}>[FTV]</span>;
}

function LiveAnnouncementButton({ room, channelId }: { room: string; channelId: string; }) {
    const [busy, setBusy] = useState(false);
    const { key, viewing } = useStateFromStores([ApplicationStreamingStore, SelectedChannelStore, ChannelRTCStore], () => {
        const ownerId = [...liveOwners].find(([, live]) => live.toLowerCase() === room.toLowerCase())?.[0];
        const key = ownerId && SelectedChannelStore.getVoiceChannelId() === channelId
            ? keyOf({ ownerId, channelId, guildId: ChannelStore.getChannel(channelId)?.guild_id }) : undefined;
        return { key, viewing: !!key && watching.has(key) };
    }, [room, channelId]);
    const disabled = busy || viewing || !key;
    return <Button disabled={disabled} variant={disabled ? "secondary" : "primary"}
        title={!key ? "Entre no canal de voz da live para assistir." : undefined}
        onClick={async () => {
            if (!key || watching.has(key) || busy) return;
            setBusy(true);
            fockyStreams.add(key);
            try { await startWatch(key); } finally { setBusy(false); }
        }}>{viewing ? "Assistindo" : busy ? "Conectando…" : "Assistir transmissão"}</Button>;
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

// Sem fundo do Discord a câmera abre direto no Chromium, que pega os 60 FPS da webcam (o motor nativo trava em 30).
const CAMERA_FPS = 60;
async function openCapture(kind: "screen" | "camera", source?: DiscordSource, quality?: Partial<ShareQuality>) {
    const selected = shareQuality(quality ?? {}, StreamingSettings.getState());
    if (kind === "camera" && typeof (window as any).createDiscordStream === "function" && cameraFilterActive())
        return { ...await captureNativeCamera(MediaEngineStore.getVideoDeviceId()), releaseAudio: undefined, quality: selected };
    const sound = kind === "screen" && (selected.soundshareEnabled ?? false);
    const capture = source
        ? await navigator.mediaDevices.getUserMedia(captureConstraints(source, selected.fps, selected.resolution) as unknown as MediaStreamConstraints)
        : kind === "camera"
            ? await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: { ideal: CAMERA_FPS }, deviceId: await cameraDevice() }, audio: false })
            // Som da tela não é voz: com o processamento padrão o Chromium aplica ganho automático, eco e ruído
            // (volume oscilando, música distorcida) e entrega mono. Só vale no pedido; applyConstraints depois é recusado.
            : await navigator.mediaDevices.getDisplayMedia({ video: qualityConstraints(selected), audio: sound && { autoGainControl: false, echoCancellation: false, noiseSuppression: false, channelCount: 2 } });
    let releaseAudio: (() => void) | undefined;
    if (kind === "screen") {
        try {
            const sourceId = source ? captureConstraints(source, selected.fps, selected.resolution).video.mandatory.chromeMediaSourceId : "screen:-1:0";
            if (!IS_WINDOWS && sound && capture.getAudioTracks().length)
                void Native.unmuteShareAudio().then(count => { if (count) console.warn("FockyTV: sink de áudio do Vesktop estava mutado; desmutado."); }).catch(error => console.warn("FockyTV: verificar áudio do Vesktop", error));
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

function watchEnded(kind: "screen" | "camera", session: LivePublisher, track: MediaStreamTrack) {
    track.addEventListener("ended", () => {
        if (publishers.get(kind) === session) {
            publishers.delete(kind);
            if (kind === "screen") clearDiscordShare();
        }
    }, { once: true });
}

async function publish(kind: "screen" | "camera", source?: DiscordSource, quality?: Partial<ShareQuality>) {
    const existing = publishers.get(kind);
    if (existing) { publishers.delete(kind); if (kind === "screen") clearDiscordShare(); await existing.close(); return; }
    if (pending.has(kind)) return;
    const base = serverBase();
    const nick = nickname();
    const version = generation;
    pending.add(kind);
    let capture: MediaStream | undefined;
    let session: LivePublisher | undefined;
    let selected: ShareQuality;
    let releaseAudio: (() => void) | undefined;
    let releaseVideo: (() => void) | undefined;
    try {
        ({ capture, releaseAudio, releaseVideo, quality: selected } = await openCapture(kind, source, quality));
        if (version !== generation || (source && !discordShare)) { releaseAudio?.(); releaseVideo?.(); capture.getTracks().forEach(track => track.stop()); return; }
        livekit ??= loadLivekit(livekitSource, proxySocket(Native));
        session = new LivePublisher(livekit, request, kind === "camera" ? cameraKey(nick) : nick, kind === "camera", capture, releaseAudio, releaseVideo, () => {
            if (publishers.get(kind) !== session) return;
            publishers.delete(kind);
            if (kind === "screen") clearDiscordShare();
            playStreamEndSound();
            void showNotification({ title: "FockyTV", body: "A live caiu. Abra o painel FockyTV para tentar novamente." });
        });
        session.style = liveStyle(settings.store.liveStyle);
        publishers.set(kind, session);
        watchEnded(kind, session, capture.getVideoTracks()[0]);
        if (kind === "screen" && discordShare) updatePreview(discordShare, previewStreamId);
        await session.connect(base, kind === "camera" ? CAMERA_FPS : selected.fps);
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

function streamSettings(children: React.ReactNode) {
    if (!routingEnabled) return children;
    const items: React.ReactNode[] = [];
    // Só aparece transmitindo: liga/desliga as anotações dos espectadores em tempo real.
    const me = UserStore.getCurrentUser()?.id;
    if (settings.store.annotations && discordShare && publishers.has("screen") && me) {
        const board = annotationBoardFor(me);
        const allowed = board.snapshot().allowed;
        items.push(<Menu.MenuCheckboxItem key="fockytv-annotations" id="fockytv-annotations" label="Permitir anotações na tela"
            subtext="Quem assiste com o plugin pode desenhar sobre a transmissão em tempo real."
            checked={allowed} action={() => board.allow(!allowed)} />);
    }
    return [children, ...items];
}

// O bot avisa no chat do canal de voz da live; chamadas privadas não têm aviso.
async function announceLive(share: NonNullable<typeof discordShare>) {
    if (!share.guildId) return;
    for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise(resolve => setTimeout(resolve, attempt ? 2000 : 4000));
        const session = publishers.get("screen");
        if (!session?.capture || discordShare !== share) return;
        try {
            const image = await thumbnail(session.capture, 640);
            if (discordShare !== share || publishers.get("screen") !== session) return;
            if (!image) throw new Error("A miniatura da live ainda não está pronta.");
            const user = UserStore.getCurrentUser();
            const activity = liveActivity;
            const clip = (text: string) => Array.from(text.trim()).slice(0, 100).join("");
            const status = await session.announce(JSON.stringify({
                channel: share.channelId,
                title: clip(settings.store.liveTitle || `Live de ${user?.globalName ?? user?.username ?? nickname()}`),
                detail: activity?.name ? clip(`${{ game: "🎮", video: "🎬", screen: "🖥️" }[activity.kind]} ${activity.name}`) : "",
                thumbnail: image.replace(/^data:image\/jpeg;base64,/, "")
            }));
            if (status < 300) return;
            throw new Error(`Aviso da live: HTTP ${status}`);
        } catch (error) {
            if (attempt === 2) throw error;
        }
    }
}

function commitDiscordQuality(quality: ShareQuality) {
    discordQuality = quality;
    FluxDispatcher.dispatch({ type: "STREAM_UPDATE_SETTINGS", preset: quality.preset, resolution: quality.resolution, frameRate: quality.fps, soundshareEnabled: quality.soundshareEnabled });
}

function updateDiscordQuality(options: { resolution?: number; frameRate?: number; preset?: number; soundshareEnabled?: boolean; }) {
    const session = publishers.get("screen");
    const share = discordShare;
    if (!routingEnabled || !share || !session || !discordQuality) return false;
    // O menu pode emitir várias escolhas antes de a anterior ser aplicada.
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
        {update.branch && <p>Canal: {update.branch}</p>}
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
        if (update.branch && update.branch !== settings.store.updateBranch) { setError("O canal mudou. Verifique as atualizações novamente."); return; }
        setState("busy"); setError("");
        try { setState((await Native.installUpdate(settings.store.updateBranch)).started ? "started" : "current"); }
        catch (error) { setError(String(error)); setState("idle"); }
    };
    return <div>
        <UpdateDetails update={update} />
        {state === "started" ? <p role="status" className="fockytv-update-note">Instalando… o Discord fecha e reabre automaticamente ao terminar.</p>
            : state === "current" ? <p role="status" className="fockytv-update-note">O FockyTV já está atualizado.</p>
                : <>
                    <span role="button" tabIndex={0} aria-disabled={state === "busy"} className="fockytv-update-button" onClick={install} onKeyDown={event => (event.key === "Enter" || event.key === " ") && void install(event)}>
                        {state === "busy" ? <><UpdateSpinner />Preparando…</> : "Atualizar agora"}
                    </span>
                    <p className="fockytv-update-note">O Discord fecha durante a instalação e reabre automaticamente ao terminar. Clique fora do botão para abrir o painel.</p>
                </>}
        {error && <p role="alert" className="fockytv-update-error">{error}</p>}
    </div>;
}

// Arco que gira enquanto o plugin verifica ou instala a atualização.
const UpdateSpinner = () => <svg className="fockytv-update-spinner" viewBox="0 0 24 24" width={14} height={14} aria-hidden="true">
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray="42" strokeDashoffset="14" />
</svg>;

function UpdateControls() {
    const { updateBranch } = settings.use(["updateBranch"]);
    const [available, setAvailable] = useState(false);
    const [update, setUpdate] = useState<UpdateInfo | null>(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");
    const mounted = useRef(true);
    const check = async () => {
        setBusy(true); setError("");
        try {
            const result = await Native.checkUpdate(updateBranch);
            if (mounted.current && settings.store.updateBranch === updateBranch) {
                setAvailable(result.available);
                setUpdate(result.available ? result : null);
                setMessage(result.available ? "Nova versão do FockyTV disponível." : `FockyTV está atualizado${result.version ? ` (${versionLabel(result.version)})` : ""}.`);
            }
        } catch (error) { if (mounted.current && settings.store.updateBranch === updateBranch) setError(String(error)); }
        finally { if (mounted.current && settings.store.updateBranch === updateBranch) setBusy(false); }
    };
    useEffect(() => { mounted.current = true; setAvailable(false); setUpdate(null); setMessage(""); void check(); return () => { mounted.current = false; }; }, [updateBranch]);
    const install = async () => {
        setBusy(true); setError("");
        try {
            const result = await Native.installUpdate(updateBranch);
            if (mounted.current && settings.store.updateBranch === updateBranch) {
                setAvailable(false);
                setUpdate(null);
                setMessage(result.started ? "Instalando. O cliente será fechado e reaberto automaticamente ao terminar." : "FockyTV está atualizado.");
            }
        } catch (error) { if (mounted.current && settings.store.updateBranch === updateBranch) setError(String(error)); }
        finally { if (mounted.current && settings.store.updateBranch === updateBranch) setBusy(false); }
    };
    return <div>
        <p role="status">{message}</p>
        {update && <UpdateDetails update={update} />}
        {error && <p role="alert">{error}</p>}
        <Button disabled={busy} onClick={available ? install : check}>
            <span className="fockytv-update-button-label">
                {busy && <UpdateSpinner />}
                {busy ? (available ? "Instalando…" : "Verificando…") : available ? "Instalar atualização e reiniciar o cliente" : "Verificar atualização"}
            </span>
        </Button>
    </div>;
}

const HeaderBarIcon = findComponentByCodeLazy(".HEADER_BAR_BADGE_BOTTOM,", 'position:"bottom"');
const UpdateIcon = ({ className }: { className?: string; }) => <svg className={className} viewBox="0 0 24 24" width={20} height={20} aria-hidden="true">
    <path fill="var(--status-positive, #23a55a)" d="M12 2a1 1 0 0 1 1 1v10.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V3a1 1 0 0 1 1-1ZM4 19a1 1 0 0 1 1 1h14a1 1 0 1 1 0 2H5a2 2 0 0 1-2-2 1 1 0 0 1 1-1Z" />
</svg>;
// HeaderBarIcon do Discord descarta className; a classe de giro precisa morar no próprio svg do ícone.
const UpdateBusyIcon = () => <UpdateIcon className="fockytv-header-update-busy" />;

// Clicar instala na hora: o Discord fecha e reabre sozinho.
function UpdateHeaderButton() {
    const update = React.useSyncExternalStore(listener => { headerListeners.add(listener); return () => { headerListeners.delete(listener); }; }, () => headerUpdate);
    const [busy, setBusy] = useState(false);
    if (!update || !routingEnabled) return null;
    const versions = update.version ? ` ${update.current ? `${versionLabel(update.current)} → ` : ""}${versionLabel(update.version)}` : "";
    const install = async () => {
        if (busy) return;
        setBusy(true);
        try {
            if ((await Native.installUpdate(settings.store.updateBranch)).started) return;
            setHeaderUpdate(null);
        } catch (error) {
            void showNotification({ title: "FockyTV: atualização falhou", body: String(error) });
        }
        setBusy(false);
    };
    return <HeaderBarIcon onClick={install} icon={busy ? UpdateBusyIcon : UpdateIcon}
        tooltip={busy ? "Instalando… o Discord fecha e reabre sozinho" : `Atualizar FockyTV (${settings.store.updateBranch})${versions}`} />;
}

async function notifyUpdate() {
    if (!routingEnabled) return;
    if (updateChecking) { updateQueued = true; return; }
    updateChecking = true;
    const branch = settings.store.updateBranch;
    try {
        const result = await Native.checkUpdate(branch);
        if (settings.store.updateBranch === branch) setHeaderUpdate(result.available ? result : null);
        const notice = `${branch}:${result.revision}`;
        if (!routingEnabled || settings.store.updateBranch !== branch || !result.available || notice === notifiedRevision) return;
        const versions = result.version ? `${result.current ? `${versionLabel(result.current)} → ` : ""}${versionLabel(result.version)}` : "";
        // O body é o que aparece se o Vencord usar notificações nativas do sistema (sem botão nem lista).
        await showNotification({
            title: `FockyTV: atualização disponível (${branch})`,
            body: [versions, result.changes?.slice(0, 3).join(" · "), "Clique para abrir o painel e instalar."].filter(Boolean).join("\n"),
            richBody: <UpdateNotice update={result} />,
            color: "#5865f2",
            onClick: openPanel
        });
        notifiedRevision = notice;
    } catch (error) { console.warn("FockyTV: verificar atualização", error); }
    finally {
        updateChecking = false;
        if (updateQueued) { updateQueued = false; if (routingEnabled) void notifyUpdate(); }
    }
}

// Texto do relatório de diagnóstico: serializa de novo só quando mudam as amostras ou o último
// evento de vídeo (push/shift sempre troca o último). Era re-serializado a cada render do painel.
let reportCache = { sample: null as unknown, last: null as unknown, text: "" };
function reportText(value: { samples: unknown; events: unknown[]; }, _replacer: unknown, space?: number) {
    const last = value.events.at(-1);
    if (reportCache.sample !== value.samples || reportCache.last !== last) {
        reportCache.sample = value.samples;
        reportCache.last = last;
        reportCache.text = JSON.stringify({ samples: value.samples, events: value.events }, null, space ?? 2);
    }
    return reportCache.text;
}

function StreamDiagnostics({ player }: { player: Session | null; }) {
    type Source = { label: string; getStats(): Promise<RTCStatsReport>; };
    type Sample = {
        at: string; streams: { label: string; metrics: ReturnType<typeof videoStats>; error?: string; }[];
        state: { inVoiceChannel: boolean; screenConnections: number; cameraConnections: number; publishing: string[]; watchParty: boolean; liveStyle: string; };
        videos: ReturnType<typeof videoElementsSnapshot>;
        runtime: Awaited<ReturnType<typeof Native.runtimeDiagnostics>> | { error: string; };
        badges: { animation: string; animationState: string; blur: string; }[];
    };
    const [sources, setSources] = useState<Source[] | null>(null);
    const [samples, setSamples] = useState<Sample[]>([]);
    const screen = publishers.get("screen");
    const available: Source[] = screen instanceof LivePublisher ? [{ label: "Envio da tela", getStats: () => screen.getStats() }] : [];
    for (const { viewing } of watching.values())
        if (viewing) available.push({ label: `Recepção da live ${available.length + 1}`, getStats: () => viewing.getStats() });
    for (const { viewing } of cameraViewers.values())
        if (viewing) available.push({ label: `Recepção da câmera ${available.length + 1}`, getStats: () => viewing.getStats() });
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
                const runtime = Native.runtimeDiagnostics().catch(() => ({ error: "Não foi possível ler os processos do cliente." }));
                const state = {
                    inVoiceChannel: !!SelectedChannelStore.getVoiceChannelId(), screenConnections: watching.size, cameraConnections: cameraViewers.size,
                    publishing: [...publishers.keys()], watchParty: watch.snapshot().watching, liveStyle: liveStyle(settings.store.liveStyle)
                };
                const videos = videoElementsSnapshot(new Set([...document.querySelectorAll("video"), ...(partyVideo ? [partyVideo] : [])]));
                const badges = [...document.querySelectorAll(".fockytv-badge")].map(badge => {
                    const style = getComputedStyle(badge);
                    return { animation: style.animationName, animationState: style.animationPlayState, blur: style.backdropFilter };
                });
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
                const processes = await runtime;
                if (!active) return;
                setSamples(values => [...values, { at, streams, state, videos, badges, runtime: processes }]);
            } finally { polling = false; }
        };
        const timer = setInterval(() => void sample(), 1000);
        const stop = setTimeout(() => setSources(null), 30_000);
        void sample();
        return () => { active = false; clearInterval(timer); clearTimeout(stop); };
    }, [sources]);

    // JSON local roteia o stringify para o cache acima (só serializa quando amostras/eventos mudam).
    // A seta é de propósito: o teste de diagnóstico roda esta função cortada na linha de baixo.
    const JSON = { stringify: (value: { samples: Sample[]; events: unknown[]; }, replacer: unknown, space?: number) => reportText(value, replacer, space) };
    const report = JSON.stringify({ samples, events: videoEvents }, null, 2);
    return <div>
        <Button onClick={() => {
            if (sources) setSources(null);
            else { setSamples([]); setSources(available); }
        }}>{sources ? "Parar diagnóstico" : "Diagnosticar vídeo/GPU (30 s)"}</Button>
        <p role="status">{sources ? `Coletando por 30 s: ${samples.length} amostras.` : samples.length ? "Diagnóstico concluído. Copie o relatório para análise." : "Pode coletar só na sala, sem assistir. Registra conexões, quadros, efeitos e CPU dos processos; não mede a porcentagem de uso da GPU."}</p>
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
        let seen = ""; // última lista de lives serializada
        // O que o redraw extra precisa buscar: botões de publicação e servidor mudam por fora do painel.
        let buttons = `${publishers.has("screen")}${publishers.has("camera")}${channel()}`;
        const refresh = async () => {
            if (polling) return;
            polling = true;
            try {
                const response = await request(`${serverBase()}/api/status`, "GET");
                if (response.status !== 200) throw new Error(`Status do servidor: ${response.status}`);
                const data: unknown = JSON.parse(response.body);
                if (!Array.isArray(data) || !data.every(item => item && typeof item.streamKey === "string"))
                    throw new Error("Lista de lives inválida.");
                // setLives só quando a lista muda: array novo a cada poll re-renderizava o modal à toa.
                const snapshot = JSON.stringify(data);
                if (mounted.current && snapshot !== seen) { seen = snapshot; setLives(data); }
            } catch (error) { if (mounted.current) setError(String(error)); }
            finally { polling = false; }
        };
        void refresh();
        const timer = setInterval(() => {
            void refresh();
            const snapshot = `${publishers.has("screen")}${publishers.has("camera")}${channel()}`;
            if (snapshot !== buttons) { buttons = snapshot; redraw(n => n + 1); }
        }, 5000);
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
        await session.connect(`${serverBase()}/api/whep?viewer=${encodeURIComponent(nickname())}`);
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
            <a href={serverBase()} target="_blank" rel="noreferrer">Abrir site FockyTV (inclui lives LiveKit)</a>
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
const githubAlertsRequest: GithubAlertsRequest = (repository, since) => Native.githubAlerts(settings.store.githubToken, repository, since);
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
const music = musicPlayer({ base: () => serverBase(), fetch: url => Native.musicFetch(url), Socket: proxySocket(Native) });
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

const watch = watchParty({ base: () => serverBase(), fetch: url => Native.musicFetch(url), Socket: proxySocket(Native) });
let stopSoundEvents: (() => void) | undefined;
const soundCooldowns = new Map<string, number>();
let lastSoundSent = -Infinity;
function soundboardEnabled() { return routingEnabled && channel() === "insider"; }
function playSoundboardClip(clip: SoundboardClip, from: string) {
    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (!soundboardEnabled() || !channelId || MediaEngineStore.isSelfDeaf() || MediaEngineStore.isLocalMute(from) ||
        VoiceStateStore.getVoiceStateForUser(from)?.channelId !== channelId) return;
    const now = performance.now();
    if (now - (soundCooldowns.get(from) ?? -Infinity) < 1000) return;
    soundCooldowns.set(from, now);
    // Reprodução nativa: mantém volume e dispositivo de saída do soundboard.
    const volume = clip.volume * Math.min(1, MediaEngineStore.getLocalVolume(from) / 100);
    if (from === UserStore.getCurrentUser()?.id) {
        FluxDispatcher.dispatch({ type: "GUILD_SOUNDBOARD_SOUND_PLAY_LOCALLY", channelId, sound: { ...clip, volume } });
    } else {
        FluxDispatcher.dispatch({ type: "VOICE_CHANNEL_EFFECT_SEND", channelId, userId: from,
            guildId: ChannelStore.getChannel(channelId)?.guild_id, soundId: clip.soundId, soundVolume: volume });
    }
}
let watchModal: string | undefined;

// Anotações da live: um board por dono (target). O GC no refreshLives acompanha as
// lives do canal — o tile pode remontar sem perder o que já foi desenhado.
const annotationBoards = new Map<string, AnnotationBoard>();
function annotationBoardFor(target: string) {
    let board = annotationBoards.get(target);
    if (!board) {
        board = annotationBoard(target, UserStore.getCurrentUser()?.id ?? "", message => watch.sendDraw(message));
        annotationBoards.set(target, board);
        board.resync();
    }
    return board;
}

// Quem transmite a tela inteira vê as anotações no próprio monitor num overlay fora da captura
// (Windows: setContentProtection; Hyprland: regra noscreenshare). Envio por setTimeout: com o
// Discord em segundo plano (jogando) o rAF dele para.
let overlaySource: string | undefined, stopOverlay: (() => void) | undefined;
function syncAnnotationOverlay(source: string | undefined) {
    overlaySource = source;
    stopOverlay?.();
    stopOverlay = undefined;
    const me = UserStore.getCurrentUser()?.id;
    if (!settings.store.annotations || !discordShare || !me) { void Native.annotationOverlay(null); return; }
    const board = annotationBoardFor(me);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = () => {
        board.tick(); // sem o preview aberto, só aqui traço e laser envelhecem; com o timer marcado, o notify não reagenda
        timer = undefined;
        const { strokes, lasers } = board.snapshot(), now = performance.now();
        void Native.annotationDraw({
            strokes: strokes.map(({ color, pts, at }) => ({ color, pts, age: now - at })),
            lasers: lasers.map(laser => ({ pts: laser.pts.map(({ x, y, at }) => ({ x, y, age: now - at })) }))
        });
    };
    // No Windows a fonte escolhida aponta o monitor. No Vesktop a captura vem do portal sem id:
    // o frame físico compartilhado casa com o monitor (proporção e pixels, no native).
    const track = !IS_WINDOWS ? publishers.get("screen")?.capture?.getVideoTracks()[0] : undefined;
    const frame = track?.getSettings();
    const request = IS_WINDOWS && source ? source : frame?.width && frame?.height ? { width: frame.width, height: frame.height } : undefined;
    if (!request) {
        // O frame pode nascer sem resolução: o primeiro resize da captura refaz o sync.
        track?.addEventListener("resize", () => syncAnnotationOverlay(overlaySource), { once: true });
        void Native.annotationOverlay(null);
        return;
    }
    const unsubscribe = board.subscribe(() => { timer ??= setTimeout(send, 16); });
    void Native.annotationOverlay(request).then(send);
    stopOverlay = () => { unsubscribe(); clearTimeout(timer); };
}

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

function captureParty(video: HTMLVideoElement & { captureStream(): MediaStream; }) {
    const media = video.captureStream();
    // Cada src novo adiciona uma track ao mesmo stream, e o tile continuaria preso na antiga.
    media.addEventListener("addtrack", ({ track }) => media.getTracks().forEach(old => {
        if (old !== track && old.kind === track.kind) { media.removeTrack(old); old.stop(); }
    }));
    return media;
}

// O <video> da watch party fica fora do DOM (toca o áudio); o tile mostra uma cópia via captureStream.
function syncPartyTile() {
    const { state, channel, watching } = watch.snapshot();
    const shown = localTiles.get(partyStreamId);
    if (!watching || !state || !channel || !partyVideo) showTile(partyStreamId, "", null);
    else if (shown?.channel !== channel) showTile(partyStreamId, "Watch party · YouTube", shown?.media ?? captureParty(partyVideo as HTMLVideoElement & { captureStream(): MediaStream; }), channel);
}

function syncLyrics() {
    if (settings.store.hideLyrics) {
        stopLyrics?.();
        stopLyrics = undefined;
        return;
    }
    stopLyrics ??= lyricsCanvas(music, async id => {
        const response = await Native.musicFetch(`${serverBase()}/api/fixed/jam/yt/lyrics?${new URLSearchParams({ id })}`);
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

const cameraMenu: NavContextMenuPatchCallback = (children, { user }) => {
    const camera = user && liveCameras.get(user.id);
    if (!camera || !routingEnabled || camera.channelId !== SelectedChannelStore.getVoiceChannelId()) return;
    children.push(<Menu.MenuItem id="fockytv-watch-camera" label={cameraViewers.has(user.id) ? "Parar de assistir câmera FockyTV" : "Assistir câmera FockyTV"}
        action={() => {
            if (!routingEnabled || SelectedChannelStore.getVoiceChannelId() !== camera.channelId || liveCameras.get(user.id)?.room !== camera.room) return;
            if (cameraViewers.has(user.id)) { endCamera(user.id); cameraStopped.add(user.id); }
            else { cameraStopped.delete(user.id); void watchCamera(user.id, camera.room, camera.channelId); }
        }} />);
};

function syncMusic() {
    const channelId = SelectedChannelStore.getVoiceChannelId() ?? undefined;
    const user = UserStore.getCurrentUser();
    if (watch.snapshot().channel !== channelId) { soundCooldowns.clear(); lastSoundSent = -Infinity; }
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

// Gradiente do arco-íris: recriado só quando o passo de cor (25° a cada 500ms) ou a largura mudam.
let spectrumKey = "";
let spectrumGradient: CanvasGradient | undefined;

// Linha espelhada do espectro a partir do meio do painel: arco-íris correndo pela linha e espessura
// pulsando com o grave. Buracos dos botões (holes) já medidos, em pixels do canvas.
function drawSpectrum(canvas: HTMLCanvasElement, values: number[], holes: { x: number; y: number; w: number; h: number; }[]) {
    const ratio = devicePixelRatio, width = canvas.clientWidth * ratio, height = canvas.clientHeight * ratio;
    if (canvas.width !== width || canvas.height !== height) Object.assign(canvas, { width, height });
    const context = canvas.getContext("2d")!;
    context.clearRect(0, 0, width, height);
    const hue = Math.floor(performance.now() / 500) * 25 % 360, bass = (values[0] + values[1] + values[2] + values[3]) / 4;
    const key = `${hue}:${width}`;
    if (key !== spectrumKey) {
        spectrumKey = key;
        const gradient = context.createLinearGradient(0, 0, width, 0);
        for (let i = 0; i <= 6; i++) gradient.addColorStop(i / 6, `hsl(${hue + i * 60} 90% 65%)`);
        spectrumGradient = gradient;
    }
    context.strokeStyle = spectrumGradient!;
    context.lineWidth = (1.5 + bass * 2.5) * ratio;
    // Brilho fixo: o shadowBlur variável com o grave era a operação 2D mais cara do quadro.
    context.shadowColor = `hsl(${hue} 90% 65% / 80%)`;
    context.shadowBlur = 6 * ratio;
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
    for (const hole of holes) context.clearRect(hole.x, hole.y, hole.w, hole.h);
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
        // Buracos dos botões medidos só quando o painel muda de tamanho (era querySelectorAll + layout a cada quadro).
        let holes: { x: number; y: number; w: number; h: number; }[] = [];
        const measure = () => {
            const bounds = canvas.getBoundingClientRect(), ratio = devicePixelRatio;
            holes = [...panel.querySelectorAll<HTMLElement>('button, [role="button"]')].map(button => {
                const rect = button.getBoundingClientRect();
                return { x: (rect.left - bounds.left) * ratio, y: (rect.top - bounds.top) * ratio, w: rect.width * ratio, h: rect.height * ratio };
            });
        };
        measure();
        const resize = new ResizeObserver(measure);
        resize.observe(panel);
        let painted = -1e9;
        let frame = requestAnimationFrame(function draw(now: number) {
            // ~30fps e nada com a janela escondida; o loop fica vivo só de rAF.
            if (now - painted >= 32 && !document.hidden) {
                painted = now;
                const bins = music.spectrum();
                if (bins) drawSpectrum(canvas, spectrumPoints(bins, 48), holes);
            }
            frame = requestAnimationFrame(draw);
        });
        return () => { cancelAnimationFrame(frame); resize.disconnect(); canvas.remove(); };
    }, [active]);
    return <Tooltip text={playing ? `Tocando: ${current!.title}` : "Música"}>
        {tooltip => <button type="button" ref={button} {...tooltip} aria-label="Música" className={`fockytv-music-button${playing ? " is-playing" : ""}`} onClick={openMusic}>
            <MusicIcon />
        </button>}
    </Tooltip>;
}

function WatchButton() {
    const { watching } = useWatch(watch);
    return <><Tooltip text="Watch party do YouTube">{tooltip => <button type="button" {...tooltip} aria-label="Watch party do YouTube" aria-pressed={watching}
        className={`fockytv-music-button${watching ? " is-playing" : ""}`} onClick={openWatch}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="3" /><path d="m10 8 6 4-6 4Z" /></svg>
    </button>}</Tooltip>
        {watching && <button type="button" className="fockytv-music-button" aria-label="Sair da watch party" title="Sair da watch party" onClick={() => watch.listen(false)}>Sair</button>}
    </>;
}

// O servidor acompanha o canal do plugin, sem endereço configurável no cliente.
// Avisos de atualização vêm sempre da main: só ela recebe o webhook do GitHub.
const SERVERS = { main: "https://fockytv.felipemayer.com.br", insider: "https://fockytv-insider.felipemayer.com.br" };
type Channel = keyof typeof SERVERS;
const CHANNELS: Channel[] = ["main", "insider"];
const channel = (): Channel => settings.store.updateBranch === "insider" ? "insider" : "main";
const serverBase = () => SERVERS[channel()];
function openPanel() {
    if (modalKey) return;
    modalKey = openModal(props => <Panel {...props} />);
}

// O <video> da watch party toca a stream do servidor direto (Range nativo, nada
// é baixado no cliente nem no servidor). O CSP do Discord precisa liberar o host
// em media-src: regra guardada pelo Vesktop, válida depois de reiniciá-lo.
async function ensureStreamMediaCsp() {
    const csp = (window as any).VencordNative?.csp;
    if (!csp) return;
    const url = serverBase();
    try {
        if (await csp.isDomainAllowed(url, ["media-src"])) return;
        if (await csp.requestAddOverride(url, ["media-src"], "FockyTV") === "ok")
            void showNotification({ title: "FockyTV: reinicie o Vesktop", body: "O servidor foi liberado para o vídeo da watch party. A permissão passa a valer após reiniciar." });
    } catch { }
}

export default definePlugin({
    name: "FockyTV",
    description: "Compartilhe tela/câmera e assista lives FockyTV via LiveKit.",
    authors: [{ name: "Focky", id: 0n }],
    settings,
    soundboardEnabled,
    playSoundboard(value: unknown, channelId: string) {
        if (!soundboardEnabled() || channelId !== SelectedChannelStore.getVoiceChannelId()) return false;
        const clip = soundboardClip(value);
        const me = UserStore.getCurrentUser()?.id;
        if (!clip || !me || MediaEngineStore.isSelfDeaf()) return true;
        const channel = ChannelStore.getChannel(channelId);
        if (!channel || channel.guild_id && (!PermissionStore.can(PermissionsBits.SPEAK, channel) ||
            !PermissionStore.can(PermissionsBits.USE_SOUNDBOARD, channel))) return true;
        if (performance.now() - lastSoundSent < 1000) return true;
        if (!watch.sendSound(clip)) {
            void showNotification({ title: "FockyTV", body: "O soundboard ainda está conectando. Tente novamente em instantes." });
            return true;
        }
        lastSoundSent = performance.now();
        playSoundboardClip(clip, me);
        FluxDispatcher.dispatch({ type: "SOUNDBOARD_TRACK_USAGE", soundId: clip.soundId });
        return true;
    },
    settingsAboutComponent: () => {
        const { githubToken } = settings.use(["githubToken"]);
        return <div className="fockytv-settings-home">
            <p>Abra o painel para assistir, compartilhar ou coletar um diagnóstico de vídeo/GPU.</p>
            <div className="fockytv-settings-actions">
                <Button onClick={openPanel}>Abrir FockyTV</Button>
                {githubToken.trim() && <Button variant="secondary" onClick={openGithub}>Abrir GitHub</Button>}
            </div>
            <details className="fockytv-settings-updates"><summary>Atualizações e versão</summary><UpdateControls /></details>
        </div>;
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
                for (const [id, camera] of liveCameras)
                    if (camera.channelId !== channel || VoiceStateStore.getVoiceStateForUser(id)?.channelId !== channel) liveCameras.delete(id);
                for (const key of watching.keys())
                    if (!channel || key.split(":").at(-2) !== channel || VoiceStateStore.getVoiceStateForUser(ownerOf(key))?.channelId !== channel) endWatch(key);
                syncMusic();
            }, 0);
            const channelId = SelectedChannelStore.getVoiceChannelId();
            if (!channelId || (discordShare && channelId !== discordShare.channelId)) { void stopPublishing(); closePanel?.(); }
        },
        RTC_CONNECTION_VIDEO({ userId, channelId, streamId, context }: { userId: string; channelId: string; streamId: string | null; context: string; }) {
            if (streamId == null && context === "default") setTimeout(() => restoreCamera(userId, channelId), 0);
        },
        LOGOUT() {
            music.connect(); watch.connect();
            setTimeout(() => {
                for (const id of cameraViewers.keys()) endCamera(id);
                for (const key of watching.keys()) endWatch(key);
                liveCameras.clear();
            }, 0);
            void stopPublishing(); closePanel?.();
        }
    },
    patches: discordPatches,
    renderUpdateButton: () => <ErrorBoundary noop><UpdateHeaderButton /></ErrorBoundary>,
    contextMenus: {
        "more-settings-context": callMenu,
        "user-context": cameraMenu,
        "stream-options": children => { if (routingEnabled) children.push(<Menu.MenuGroup>{streamSettings(null)}</Menu.MenuGroup>); }
    },
    managedStyle,
    renderMessageAccessory({ message }) {
        if (!routingEnabled || !message.author?.bot) return null;
        for (const embed of message.embeds ?? []) {
            const room = /^([\w.-]{1,32}) está ao vivo no FockyTV$/.exec(embed.author?.name ?? "")?.[1];
            if (room) return <LiveAnnouncementButton room={room} channelId={message.channel_id} />;
        }
        return null;
    },
    streamSettings,
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
    // Estilo mínimo inline: na HUD do overlay o CSS do plugin não chega; sem ele o texto cola no olho e herda o tamanho da linha.
    watchPill: (userId: string) => watchingMyLive(userId)
        ? <span key="watch" className="fockytv-watch-pill" style={{ display: "inline-flex", alignItems: "center", gap: "4px", color: "#8fe6ff", fontSize: "10px" }}><EyeIcon />ASSISTINDO</span>
        : null,
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
                const handle = source?.id?.match(/^screen-handle:(\d+)$/)?.[1];
                if (handle) source = { ...source, id: await Native.screenSource(handle, source!.name) };
                const share = discordShare;
                const next = shareChanges.catch(() => {}).then(async () => {
                    if (discordShare !== share || publishers.get("screen") !== session) throw new Error("Transmissão encerrada.");
                    const previous = discordQuality!;
                    const selected = shareQuality(quality ?? {}, previous);
                    noteActivity(source);
                    await switchSource(source, selected);
                    try { await session!.setQuality(selected); }
                    catch (error) { await session!.setQuality(previous); throw error; }
                    if (discordShare === share) { commitDiscordQuality(selected); syncAnnotationOverlay(source?.id); }
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
            const handle = source?.id?.match(/^screen-handle:(\d+)$/)?.[1];
            if (handle) source = { ...source, id: await Native.screenSource(handle, source!.name) };
            await publish("screen", source, selected);
            if (discordShare !== share || !publishers.has("screen")) return [false, "cancelled"];
            share.state = "ACTIVE";
            commitDiscordQuality(selected);
            syncAnnotationOverlay(source?.id);
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
        const media = own?.capture ?? watching.get(streamKey)?.viewing?.media;
        if (!media) { logVideoEvent("preview-skipped"); return true; }
        logVideoEvent("preview-reused");
        const version = generation;
        FluxDispatcher.dispatch({ type: "STREAM_PREVIEW_FETCH_START", streamKey });
        void (async () => {
            try {
                const previewURL = await thumbnail(media);
                if (!routingEnabled || version !== generation || (own ? publishers.get("screen") !== own : liveOwners.get(ownerId) !== room))
                    throw new Error("A live terminou.");
                FluxDispatcher.dispatch({ type: "STREAM_PREVIEW_FETCH_SUCCESS", streamKey, previewURL });
            } catch (error) {
                console.warn("FockyTV: miniatura", error);
                FluxDispatcher.dispatch({ type: "STREAM_PREVIEW_FETCH_FAIL", streamKey, retryAfter: 30_000 });
            }
        })();
        return true;
    },
    cameraActive: () => publishers.has("camera"),
    selfVideo(state: { userId?: string; channelId?: string | null; selfVideo?: boolean; }) {
        // Câmeras em outros canais: só o selo na barra lateral. Na sua chamada o tile exige a
        // visualização aberta (cameraViewers), sem ela o Discord renderiza quadro vazio e reclama (2014).
        return !!state.selfVideo
            || (!!state.userId && !!cameraViewers.get(state.userId)?.viewing && state.channelId === SelectedChannelStore.getVoiceChannelId())
            || (publishers.has("camera") && state.userId === UserStore.getCurrentUser()?.id && state.channelId === SelectedChannelStore.getVoiceChannelId())
            || (!!state.userId && state.channelId !== SelectedChannelStore.getVoiceChannelId() && guildCameras.get(state.userId) === state.channelId);
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
        void ensureStreamMediaCsp();
        // A guarda de boot zera a conta de quedas 45 s depois de o plugin iniciar de verdade.
        bootHealthy = setTimeout(() => void Native.bootGuardHealthy(), 45_000);
        stopActivity = music.subscribe(syncActivity);
        syncActivity();
        notifiedRevision = "";
        // Poll pausa com a janela escondida; o visibilitychange recupera ao voltar.
        lastLivesBody = ""; // o stop derrubou o estado: o primeiro poll reconstrói tudo, mesmo com o corpo igual
        livePoll = setInterval(() => { if (!document.hidden) void refreshLives(); }, 5000);
        document.addEventListener("visibilitychange", refreshOnVisible);
        MediaEngineStore.addChangeListener(syncAudio);
        void refreshPresence();
        presencePoll = setInterval(() => void refreshPresence(), 30_000);
        updateCheck = setTimeout(() => void notifyUpdate(), 0);
        stopUpdateEvents = watchPluginUpdates(proxySocket(Native), SERVERS.main, () => void notifyUpdate(), () => settings.store.updateBranch);
        stopGithubAlerts = watchGithubAlerts(githubAlertsRequest, () => (settings.store.githubToken.trim() ? settings.store.githubRepository : ""), alert => {
            if (!settings.store.githubToken.trim()) return;
            void showNotification({ title: alert.title, body: alert.body, onClick: () => void VencordNative.native.openExternal(alert.url) });
        });
        updatePoll = setInterval(() => void notifyUpdate(), 15 * 60 * 1000); // Recupera eventos perdidos se o webhook ou o WebSocket estiver indisponível.
        document.addEventListener("keydown", replayShortcut);
        syncMusic();
        syncLyrics();
        partyVideo = document.createElement("video");
        // Sem CORS o Chromium encerra as tracks do captureStream quando o src é de outra origem.
        partyVideo.crossOrigin = "anonymous";
        watch.attach(partyVideo);
        stopPartyTile = watch.subscribe(syncPartyTile);
        syncPartyTile();
        stopDrawEvents = watch.onDraw(message => annotationBoards.get(String((message as { target?: unknown; })?.target ?? ""))?.apply(message));
        stopSoundEvents = watch.onSound(playSoundboardClip);
        syncAudio();
    },
    stop() {
        routingEnabled = false;
        clearTimeout(bootHealthy);
        bootHealthy = undefined;
        clearTimeout(cameraSync);
        cameraSync = undefined;
        stopSoundEvents?.();
        stopSoundEvents = undefined;
        soundCooldowns.clear();
        lastSoundSent = -Infinity;
        stopDrawEvents?.();
        stopDrawEvents = undefined;
        syncAnnotationOverlay(undefined);
        for (const board of annotationBoards.values()) board.setAnnotating(false);
        annotationBoards.clear();
        stopActivity?.();
        stopActivity = undefined;
        syncActivity();
        for (const id of cameraViewers.keys()) endCamera(id);
        liveCameras.clear();
        clearInterval(livePoll);
        document.removeEventListener("visibilitychange", refreshOnVisible);
        MediaEngineStore.removeChangeListener(syncAudio);
        clearInterval(presencePoll);
        clearTimeout(updateCheck);
        clearInterval(updatePoll);
        stopUpdateEvents?.();
        stopUpdateEvents = undefined;
        stopGithubAlerts?.();
        stopGithubAlerts = undefined;
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
