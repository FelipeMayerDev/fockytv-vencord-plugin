# Transporte UDP experimental (Insider)

Mesma captura e encoder da captura nativa (`nativa-whip.md`), mas o MPEG-TS do encoder vai
para um `CaptureSink` UDP próprio em vez do muxer WHIP. Protocolo próprio: AES-256-GCM,
paridade XOR 8+1, interleaving, relay no `live-api` do Insider. Não usa LiveKit.

Ativo quando (`index.tsx:1540`): Windows, canal `insider`, `nativeCapture` e
`experimentalUdp` ligados (settings `index.tsx:50-51`, menu `index.tsx:877-879`; ligar o
UDP religa `nativeCapture`). Vale na próxima live.

## Pipeline

```
┌─ Publicador: Electron main ────────────────────────────────────────────────┐
│ startNativeShare (native.ts:336) → udpSink (native-udp.ts:85)              │
│   openUdp("publish"): HTTPS POST /api/udp/publish → ticket {id, token,     │
│     auth, host, lanHost, port}; socket udp4 connect; FTVH→FTVA em ≤ 5 s    │
│ [ffmpeg encoder] (igual ao nativo, VBV 125 ms, IDR 1 s) → MPEG-TS stdout   │
│ startCapture(sink) → sink.input (Writable)                                 │
│   fatias de 1128 B, grupo de 8 ou flush de 8 ms (native-udp.ts:115-130)    │
│   packetEncoder: shard 2+1128 B, paridade XOR, AES-GCM, header 26 B AAD    │
│   interleaver: coluna i de até 8 grupos, retenção ≤ 40 ms                  │
│   pacing: token bucket 1,5 × bitrate, rajada 12 KB                         │
│   + HMAC-SHA256/16 com o segredo do publicador → datagrama 1188 B          │
└──────┬ UDP ────────────────────────────────────────────────────────────────┘
       ▼
┌─ Servidor Insider: live-api :7996/udp (live-api/udp.go) ───────────────────┐
│ valida HMAC do publicador, remove os 16 B, fan-out unicast de 1172 B para  │
│ cada espectador (endereço aprendido pelo FTVH, TTL 15 s). Sem buffer.      │
└──────┬ UDP ────────────────────────────────────────────────────────────────┘
       ▼
┌─ Espectador: Electron main ────────────────────────────────────────────────┐
│ startUdpWatch (native.ts:373) → udpReceiver (native-udp.ts:149)            │
│   openUdp("watch") → packetDecoder: reordem ≤ 100 ms, recupera 1 por grupo │
│   [ffmpeg remux] mpegts → fMP4 (-c copy, frag 50 ms) → fila ≤ 4 MB         │
└──────┬ IPC readUdpWatch (poll 10 ms) ──────────────────────────────────────┘
       ▼
┌─ Espectador: renderer (udp-viewer.ts) ─────────────────────────────────────┐
│ MediaSource + SourceBuffer "avc1.<avcC>,opus" → <video> oculto              │
│ → captureStream() → tile do Discord + streamAudio                          │
└────────────────────────────────────────────────────────────────────────────┘
```

Chaves e socket ficam no main; o renderer recebe só fMP4 comprimido (`native.ts:371`).
O remux não decodifica: H.264/Opus são decodificados pelo Chromium (`native-udp.ts:142`).

## Componentes e LOC

| Arquivo / trecho | LOC | Papel |
|---|---:|---|
| `native-udp.ts` | 198 | ticket/handshake, `udpSink` (fatiamento, pacing), `udpReceiver` (remux) |
| `udp-protocol.ts` | 117 | pacotes de controle, encoder/decoder FEC+GCM, interleaver |
| `udp-viewer.ts` | 107 | MSE, controle de atraso, `captureStream` |
| `native.ts:371-398` | 28 | IPC `startUdpWatch/readUdpWatch/stopUdpWatch` |
| `index.tsx` (50-51, 877-879, 1540-1545, 332, 422-438, 551-553) | ~20 | settings, menu, teto 2160p, descoberta, escolha do viewer |
| ramos `udp` em `native-capture.ts` (153-154, 184, 244-253, 272-274, 310, 351, 493) e `native.ts:341-352` | ~15 | args do encoder, sink no lugar do muxer |
| **Exclusivo do plugin** | **~485** | |
| `live-api/udp.go` (backend, outro repo) | 373 | relay, tickets, status |

Reaproveita sem mudanças o motor nativo (~637 LOC, ver `nativa-whip.md`): encoders e
fallback, `adapt()`, áudio, stills/preview, `NativeShare`, `publishNative`, `tryNative`.
Não usa `viewer.ts`, `native-socket.ts` nem `livekit-client`.

## Codec e parâmetros

- Bitrate próprio `udpBitrate` 8/12/**20**/35/50 Mbps (`index.tsx:51`), limite 50 (`native.ts:343`).
- Resolução teto **2160p** em vez de 1080p (`index.tsx:1541-1545`).
- Encoder: mesmos codecs e ordem de fallback do nativo, com **VBV = 125 ms** (`bitrate × 125k`) e **IDR a cada 1 s**, GOP = FPS (`native-capture.ts:150-154,184`). Motivo: o receptor é próprio e não depende de PLI; com 333k o keyframe saía borrado e a imagem "perdia e ganhava foco" (`native-capture.ts:150-151`).
- Áudio: igual ao nativo (Opus 128 kbps lowdelay).
- Pacote: header 26 B (`FTVD`, id do publicador, grupo u32, índice, contagem) como AAD; shard 1130 B cifrado; tag GCM 16 B; HMAC 16 B só no trecho publicador→relay (`udp-protocol.ts:3,215-238`, `native-udp.ts:79`). 1188 B na ida, 1172 B na volta, abaixo do limite de 1200 B do relay.
- Nonce GCM: 6 B do id + grupo + índice (`udp-protocol.ts:232`); sequência esgota em 2³² grupos (`udp-protocol.ts:220`).
- Overhead: paridade 1/8 (12,5% em grupos cheios; grupos parciais pelo flush de 8 ms custam mais) + ~60 B/pacote de cabeçalhos + IP/UDP.
- Sem adaptação de bitrate ao congestionamento; a redução por sobrecarga do PC (`adapt()`) continua.

## Plataformas

| | Suporte |
|---|---|
| Publicar | só Windows, canal Insider |
| Assistir no Windows | plugin Insider; usa o FFmpeg já baixado (`native.ts:377`) |
| Assistir no Linux/Vesktop | plugin Insider; precisa de `ffmpeg` no PATH (dentro do sandbox, se houver) |
| Site FockyTV / plugin main / versões antigas | não reproduzem; lives `engine: "udp"` só aparecem no Insider (`index.tsx:430`) |
| Chromium | exige `captureStream` e MSE com `avc1...,opus` em MP4 (`udp-viewer.ts:328,390`) |

## Servidor e operação

- HTTPS: `POST /api/udp/publish`, `POST /api/udp/watch`, `DELETE /api/udp/session/{id}`, `POST /api/udp/session/{id}/quality` (`live-api/main.go:488-491`). Não há rota `announce`: o aviso de live no canal não funciona para UDP.
- UDP **7996** no `live-api` do Insider (`docker-compose.insider.yml`: `UDP_STREAM_ADDR=:7996`). Precisa de encaminhamento manual no roteador; `scripts/fockytv-upnp.sh:7` não inclui 7996.
- `UDP_PUBLIC_HOST=${INSIDER_PUBLIC_IP}` e `UDP_LAN_HOST` são lidos uma vez na partida (`udp.go:358-366`). O IP público é dinâmico e o script UPnP só atualiza `LIVEKIT_NODE_IP` do main: depois de uma troca de IP, o ticket aponta o IP antigo até alguém editar o `.env` e recriar o container.
- Cliente na mesma sub-rede de `lanHost` usa o IP LAN (`native-udp.ts:35-37,51`). O caminho LAN foi validado; o WAN não (README).
- Limites: 16 lives UDP e 64 espectadores por live (`udp.go:229,268`); 8 receptores por renderer (`native.ts:376`). Live com o mesmo nick em LiveKit e UDP é recusada nos dois sentidos (409).
- Sessão expira 15 s sem heartbeat (`udp.go:17`); heartbeat a cada 1 s também mantém o NAT aberto (`native-udp.ts:64-69`). `/api/status` só lista lives com mídia nos últimos 10 s (`udp.go:344`).
- Upload do servidor: espectadores × bitrate × ~1,2 (FEC + cabeçalhos), unicast.

## Falhas e fallbacks

Ao iniciar, `udpSink` conecta antes do encoder (`native.ts:349`). Qualquer erro cai em
`tryNative` → notificação "usando a captura do Discord" → **WebRTC pelo Chromium**, não o
WHIP nativo (`index.tsx:799-803`).

Publicador:

- "UDP bloqueado ou servidor indisponível. A transmissão atual continua disponível." — sem ACK em 5 s (`native-udp.ts:57`).
- `UDP Insider (<status>)` — 409 host ativo, 429 limite, 503 relay desligado (`native-udp.ts:26`). "Sessão UDP inválida." para ticket malformado (`native-udp.ts:28-32`).
- Durante a live (encerra, sem fallback): "A conexão UDP foi interrompida." (10 s sem ACK, `native-udp.ts:65`); "A fila UDP excedeu o limite de latência." (fila do socket > 1 MB, `native-udp.ts:78`); "A fila UDP atrasou além do limite. Reduza o bitrate." (fila do pacing > max(256 KB, 0,75 s de bitrate), `native-udp.ts:100`).

Espectador:

- Perda de grupo não recuperável: descarta o MP4 em andamento e reinicia o remux (nova `generation`), que retoma no próximo keyframe (≤ 1 s); o MSE continua com `timestampOffset` (`native-udp.ts:178-186`, `udp-viewer.ts:368-374`). Mais de 5 reinícios em 5 s: "Perda UDP persistente. Reduza o bitrate e reinicie a transmissão." (`native-udp.ts:182`).
- "A reprodução UDP atrasou além do limite." (fila do remux > 4 MB), "O receptor UDP não acompanha a transmissão." (stdin do FFmpeg > 1 MB), "Receptor UDP encerrou: ..." (`native-udp.ts:166-187`).
- "A transmissão UDP não enviou vídeo decodificável em 15 s.", "Este Chromium não suporta H.264/Opus em MP4...", "O decoder rejeitou a transmissão UDP.", `Falha ao reproduzir UDP (<código>)` (`udp-viewer.ts:344,356,390,412`).
- Sem fallback TCP nem para LiveKit. `getStats()` devolve vazio: diagnóstico e selo por estatística não funcionam (`udp-viewer.ts:420`).

## Latência teórica

| Etapa | Onde | Buffer |
|---|---|---|
| VBV do encoder | `native-capture.ts:153` | 125 ms (~3× os 42 ms do nativo a 8 Mbps) |
| Fatiamento | `native-udp.ts:125` | grupo de 8 × 1128 B ou flush em 8 ms |
| Interleaver | `native-udp.ts:104-107`, `udp-protocol.ts:244` | até 8 grupos ou 40 ms (8 grupos ≈ 75 KB ≈ 30 ms a 20 Mbps) |
| Pacing | `native-udp.ts:88-97` | 1,5 × bitrate: keyframe de 125 ms de VBV drena em ~83 ms |
| Relay | `udp.go:150-173` | nenhum |
| Reordenação/FEC | `udp-protocol.ts:202,273,282` | 0 sem perda; até 100 ms esperando shard ou grupo |
| Tick do decoder | `native-udp.ts:190` | 10 ms |
| Remux FFmpeg | `native-udp.ts:143-147` | probe inicial até 1 s/8 MB (também a cada reinício por perda); fragmento 50 ms; `max_interleave_delta` 100 ms |
| IPC | `udp-viewer.ts:413` | poll 10 ms |
| Buffer MSE | `udp-viewer.ts:397-405` | alvo 0,3–0,6 s: acelera a 1,1× acima de 0,6 s, volta a 1× abaixo de 0,3 s; pula acima de 2 s |
| `captureStream` → tile Discord | renderer | 1 quadro |

O buffer MSE domina: em regime, ~0,3–0,6 s de atraso de reprodução, acima dos transportes WebRTC.

## Testes

- `udp-protocol.test.ts` (6 testes, `tsx --test`): ACK forjado/antigo (9), recuperação de qualquer shard (18), adulteração/duplicata/chave errada (29), lacuna maior que a janela (44), pausa sem falso positivo (53), rajada de 6 pacotes com interleaving (63).
- `native-capture.test.mjs:276`: sink reaproveita a captura, ignora muxer/WHIP, reinicia só o encoder e encerra em falha de transporte.
- `self-check.ts:114-115`: VBV 125 ms e IDR 1 s no modo UDP.
- `quality.test.ts:217`: teto de 2160p só no UDP.
- `scripts/udp-smoke.ts` (manual, Insider real + Chromium): ponta a ponta com FFmpeg sintético; `--loss` derruba 2 pacotes de um grupo, `--hd` 1080p60 a 12 Mbps.
- Backend: `live-api/udp_test.go` (`TestUDPRelay`, `TestUDPExpiryAndDisabled`, `TestUDPBurst`).

## Benchmark

Mediana de 3 rodadas, 1080p30 8 Mbps, libx264, LAN Wi‑Fi. Método e limites em [benchmark.md](benchmark.md); comparação em [comparacao.md](comparacao.md).

| Cenário | 1º quadro | glass-to-glass | FPS (`captureStream` / MSE) | travadas >100 / >500 ms (MSE) |
|---|---|---|---|---|
| limpo | 2,1 s | 473 ms | 3,4 / 29,9 | 0 / 0 |
| 1% de perda | 1,9 s | 1,1 s | — / 18,7 | 5 / 2 |
| perda em rajada | 1,8 s | 1,2 s | — / 12,9 (desistiu em 2 de 3) | 7 / 5 |
| jitter 40±20 ms | 1,9 s | 519 ms | — / 30,0 | 0 / 0 |

Quem entra com a live rolando recebe ~3,5 FPS: o remux deixa um salto de timestamp depois do 1º quadro e o `captureStream()` cai. A 8 Mbps só ~4 grupos cabem nos 40 ms de entrelaçamento.
