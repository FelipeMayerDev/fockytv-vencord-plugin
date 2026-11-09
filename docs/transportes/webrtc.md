# Transporte WebRTC ("Modo simples")

Captura e codificação pelo Chromium do cliente. É o **único modo** de transmissão: os modos
Nativa (GPU) e UDP experimental foram removidos (motivo em [comparacao.md](comparacao.md)).
Hoje a tela publica direto no SFU com `livekit-client` (`LivePublisher`, `session.ts`),
`degradationPreference = "maintain-framerate"` e `contentHint = "motion"`; o pipeline WHIP abaixo
e os números do benchmark Linux são da versão anterior, mantidos como registro.

## Pipeline

```
┌─ Renderer do Discord (publicador) ─────────────────────────────────────────┐
│ openCapture (index.tsx:703)                                                 │
│   getUserMedia(chromeMediaSource=desktop)  ← fonte do seletor do Discord    │
│   getDisplayMedia                          ← Vesktop / web / painel         │
│   áudio Windows: MediaStreamTrackGenerator ← IPC readAudio (audio.ts)       │
│ Session (session.ts:19): RTCPeerConnection sendonly, H.264 + Opus           │
└──────┬ IPC request(): SDP offer/answer, DELETE ─────────┬ ICE/DTLS/SRTP (UDP)┘
       ▼                                                  │
┌─ Electron main (native.ts) ────────┐ ┌─ audio-helper.exe ─┐
│ request() fetch HTTPS (115-135)    │ │ WASAPI loopback,   │
│ startAudio/readAudio (native-audio)│◀┤ stdout FPCM f32    │
└──────┬─────────────────────────────┘ └────────────────────┘
       ▼ HTTPS POST /api/livekit/whip                     ▼
┌─ Servidor ─────────────────────────────────────────────────────────────────┐
│ live-api → CreateIngress(WHIP_INPUT, enable_transcoding=false) → proxy SDP │
│ livekit-ingress (termina WebRTC do publicador) → LiveKit SFU (sala = nick) │
└──────────────────────────────────────────────┬─────────────────────────────┘
                                               ▼ RTP, sem simulcast
┌─ Espectador ───────────────────────────────────────────────────────────────┐
│ Plugin: renderer livekit-client (viewer.ts:101) ; sinalização WebSocket    │
│   via IPC socketOpen/socketRead no main (native-socket.ts, viewer.ts:14)   │
│ Site FockyTV: livekit-client no navegador                                  │
└────────────────────────────────────────────────────────────────────────────┘
```

A sinalização HTTP e o WebSocket do LiveKit passam pelo processo main porque o CSP do
Discord bloqueia o servidor FockyTV (`native.ts:114`, `viewer.ts:2`). A mídia vai direto
do renderer (stack WebRTC do Chromium) ao ingress.

## Componentes e LOC

| Arquivo / trecho | LOC | Papel |
|---|---:|---|
| `session.ts:1-204` (`Session`, `musicOpus`) | 204 | PeerConnection, WHIP, troca de qualidade, `replace()` de faixas. Também usado pela câmera e pelo player WHEP do painel. |
| `index.tsx:703-729` `openCapture` | 27 | getUserMedia/getDisplayMedia + áudio |
| `index.tsx:731-738`, `807-846`, `849-862` | 62 | `watchEnded`, `publish`, `switchSource` |
| `audio.ts` | 72 | PCM do helper → `MediaStreamTrackGenerator` (só Windows) |
| `pcm.ts` | 28 | cabeçalho FPCM e buffer limitado |
| `native-audio.ts:32-102` | 71 | `startAudio/readAudio/stopAudio` (IPC) |
| `native.ts:165-207` `screenSource` | 43 | `screen-handle:<HMONITOR>` → id do Chromium (PowerShell) |
| `discord.ts:310-330` `captureConstraints` | 21 | constraints `chromeMediaSource` |
| `quality.ts:17-22` `qualityConstraints` | 6 | constraints de FPS/altura |
| **Exclusivo deste transporte** | **~534** | |

Compartilhado com o espectador e outros recursos (não somado aqui): `viewer.ts` (160),
`native-socket.ts` (64), `livekit-client.umd.js` (vendorizado, 594 KB minificado),
`native.ts:81-135` sinalização (55), `protocol.ts` (35), `quality.ts:1-15` (15),
`thumbnail.ts` (32), `audio-helper.cpp` (842). Contagem por `wc -l`;
trechos de arquivos mistos contados pelo intervalo de linhas da função.

## Codec e parâmetros

O encoder é o do Chromium (hardware ou software, decisão do navegador). O plugin só define:

- **Codec**: H.264 preferido via `setCodecPreferences`, mantendo RTX/RED/ULPFEC/FlexFEC para recuperação (`session.ts:40-48`).
- **Bitrate**: teto `maxBitrate = MAX_BITRATE` = 12 Mbps (`quality.ts:4`, `session.ts:38`). O controle de congestionamento do WebRTC decide o uso real (adaptativo).
- **Resolução/FPS**: do menu do Discord, teto 1080p ("Fonte" vira 1080p) (`quality.ts:4,8-14`). Aplicados como constraints de captura (`quality.ts:17-22`) e `encoding.maxFramerate` (`session.ts:128-131`).
- **Degradação**: `degradationPreference = "balanced"` — o Chromium reduz resolução e FPS sob carga (`session.ts:126-127`).
- **GOP/IDR**: não controlado; o Chromium responde aos PLI do LiveKit com keyframe.
- **Áudio**: Opus estéreo 128 kbps sem DTX, por reescrita do `a=fmtp` da answer (`session.ts:8-17,84`). Captura sem AGC/AEC/NS (`index.tsx:712-714`).
- **Simulcast**: não. Espectador com `adaptiveStream: false, dynacast: false` (`viewer.ts:111`). Justificativa em `quality.ts:2-3`: cada espectador custa o bitrate inteiro no upload do servidor.

Troca de qualidade: `applyConstraints` + `setParameters` na mesma sessão, com rollback
(`session.ts:113-161`); anuncia o selo via `POST <sessão>/quality`. Troca de fonte:
`replaceTrack` sem renegociar (`session.ts:169-185`, `index.tsx:849-862`).

## Plataformas

| Plataforma | Publicar | Áudio | Assistir |
|---|---|---|---|
| Windows (Discord) | sim | `audio-helper` WASAPI (`--hwnd` ou `--mix-except`), Win10 20348+ | sim |
| Linux (Discord) | sim, getUserMedia com fonte do seletor | sem áudio (`captureConstraints` usa `audio:false`; `audio.ts:13` só chama o helper no Windows) | sim |
| Vesktop | sim, getDisplayMedia (portal/PipeWire) | faixa do seletor (venmic) | sim |
| Site FockyTV | não | — | sim (livekit-client) |
| Vencord no navegador | não suportado (sinalização exige o main) | — | — |

## Dependências de servidor e portas

- HTTPS 443: `live-api` (`/api/livekit/whip`, `/api/livekit/whip/{id}/quality|announce`, `/api/livekit/join`, `/api/status`).
- livekit-ingress WHIP (UDP de mídia do publicador): main 7885/udp, insider 7995/udp (`docker-compose*.yml` do backend).
- LiveKit SFU (mídia dos espectadores): main 7891/tcp + 7892/udp (encaminhadas por `scripts/fockytv-upnp.sh:7`), insider 7991/tcp + 7992/udp (host network).
- `node_ip` do LiveKit/ingress precisa seguir o IP público dinâmico. `scripts/fockytv-upnp.sh:17-27` atualiza só `LIVEKIT_NODE_IP` (main); o insider usa `INSIDER_PUBLIC_IP`, que o script não toca.

## Falhas e fallbacks

- Sem candidatos ICE em 10 s: "Nenhum candidato ICE foi coletado..." (`session.ts:63-68`). Candidatos parciais são aceitos.
- Resposta WHIP ≠ 201: `FockyTV (<status>): ...` (`session.ts:77`). 409/400 "session already has a host" quando já há live com o nick.
- Conexão não fica `connected` em 20 s: "Tempo esgotado ao conectar..." (`session.ts:85-89`).
- Conexão `failed` durante a live: notificação "A conexão da transmissão falhou..." e fim, sem reconexão (`index.tsx:826-833`).
- Faixa de vídeo `ended` (janela fechada, portal parou): fecha a sessão (`session.ts:49`, `index.tsx:731-738`).
- Áudio: falha do helper notifica "transmissão sem áudio" ou "áudio interrompido" e mantém o vídeo (`index.tsx:719-726`).
- Ligar áudio depois de começar sem áudio exige reiniciar a live (`session.ts:168`, comentário `shortcut:`).

## Latência teórica

O plugin não fixa buffers neste caminho; tudo é o comportamento padrão do WebRTC.

| Etapa | Onde | Ordem de grandeza |
|---|---|---|
| Captura desktop do Chromium | renderer/GPU process | ≤ 1 quadro (16,7 ms a 60 FPS) |
| Encoder WebRTC (tempo real, sem B-frames) | Chromium | ~1 quadro |
| Pacer do WebRTC | Chromium | espalha keyframes; dezenas de ms em keyframe |
| Rede publicador → ingress | — | RTT/2 |
| ingress → SFU (sem transcode, mesmo host) | servidor | não medido aqui |
| SFU → espectador | — | RTT/2 + NACK/RTX em perda |
| Jitter buffer + decoder | Chromium do espectador | adaptativo, tipicamente 20–100 ms |
| Áudio Windows: buffer do gerador | `audio.ts:32` | começa com 250 ms acumulados, descarta acima de 600 ms; o áudio sai ~250 ms atrás do vídeo |

## Testes

- `self-check.ts:251-416` `checkSessions`: `musicOpus`, ciclo de vida da `Session`, cancelamento, ICE parcial, timeout, DELETE.
- `self-check.ts:418-473` `checkAudioTrack`: PCM → faixa de áudio e limpeza.
- `self-check.ts:475-510` `checkViewer`: proxy de WebSocket e carregamento do SDK LiveKit.
- `self-check.ts:512-544` `checkThumbnails`; `self-check.ts:163-167` `sessionUrl`.
- `quality.test.ts:10,24,51,141`: qualidade do Discord, preferência H.264 com RTX/FEC, troca de qualidade com rollback, captura web.
- `native-socket.test.ts`: allowlist do proxy de socket.

## Benchmark

Mediana de 3 rodadas, 1080p30 8 Mbps, libx264, LAN Wi‑Fi. Método e limites em [benchmark.md](benchmark.md); comparação em [comparacao.md](comparacao.md).

| Cenário | 1º quadro | glass-to-glass | FPS | travadas >100 ms |
|---|---|---|---|---|
| limpo (rampa, 30 s) | 2,6 s | 37 ms | 14,9 | 7 |
| limpo (em regime, após 60 s) | 2,6 s | 67 ms | 27,6 | 0 |
| 1% de perda | 2,8 s | 48 ms | 14,1 | 16 |
| perda em rajada | 2,6 s | 42 ms | 14,8 | 7 |
| jitter 40±20 ms | 3,5 s | 98 ms | 9,9 | 80 |

Só chega aos 8 Mbps em ~50 s: o WHIP do servidor negocia `goog-remb`, não `transport-cc`.
