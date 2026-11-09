# Comparação dos transportes de tela

Resumo para decidir o que manter. Detalhes: [webrtc.md](webrtc.md), [nativa-whip.md](nativa-whip.md), [udp.md](udp.md); números e método: [benchmark.md](benchmark.md).

## Números (1080p30, 8 Mbps, Insider na LAN, mediana de 3 rodadas)

| Cenário | Métrica | WebRTC (simples) | Nativa WHIP (padrão) | UDP experimental |
|---|---|---|---|---|
| Rede limpa | glass-to-glass | 37 ms* / 67 ms em regime | **125 ms** | 473 ms |
| | FPS no espectador | 14,9* / 27,6 em regime | **29,4** | **3,4** (29,9 antes do `captureStream`) |
| | 1º quadro | 2,6 s | 2,2 s | 2,1 s |
| | bitrate real (pedido 8) | 0,9* / 8,0 em regime | 5,6 | 8,5 (com FEC) |
| 1% de perda | FPS / glass-to-glass | 14,1* / 48 ms | 19,0 / 113 ms | 18,7 / 1,1 s |
| Perda em rajada | FPS / glass-to-glass | 14,8* / 42 ms | **27,1** / 115 ms | 12,9 / 1,2 s, desistiu em 2 de 3 |
| Jitter 40±20 ms | FPS / glass-to-glass | 9,9* / 98 ms | **0,8** (travou em 4 de 6) | **30,0** / 519 ms |

\* WebRTC nos primeiros 30 s ainda está na rampa de banda (640×360, ~15 FPS); só chega a 8 Mbps em ~50 s.

Limites: sem GPU nem captura do Windows (libx264 em todos), espectador e publicador no mesmo PC em Wi‑Fi, perda só no sentido servidor → espectador, 3 rodadas por caso.

## Windows real (RTX 3060 Ti, gfxcapture + NVENC, sem wrapper)

| Cenário | WebRTC (canvas) | Nativa WHIP | UDP |
|---|---|---|---|
| Limpo 30 FPS 8 Mbps | 65 ms, 29,7 FPS (ainda na rampa, 640×270) | 194 ms, 26,8 FPS, 7,4 Mbps | 605 ms, **1,0 FPS** (25,7 antes do `captureStream`) |
| Limpo 60 FPS, padrão do plugin | — | **127 ms, 45,4 FPS, 10,1 de 12 Mbps** | **publicador morreu nas 2 rodadas** (20 Mbps, "fila UDP atrasou") |
| Jitter 40±20 ms | — | 1 rodada normal, 1 travou (muxer WHIP a 0,06x) | receptor morreu / 1 FPS |
| Perda em rajada | — | ~23 FPS | publicador ou receptor morreram |

Também apareceu só com NVENC: o receptor UDP morre ao entrar no meio da live ("non-existing PPS 0 referenced") em 2 de 7 rodadas. A tela estava bloqueada, então a fonte foi a janela do Edge (2560×1080) e não o monitor; 2–3 rodadas por caso; `loss1` não rodou no Windows.

## Custo de manutenção

| | WebRTC | Nativa WHIP | UDP |
|---|---|---|---|
| Código só dele | ~534 linhas | ~82 linhas (+637 do motor nativo, compartilhado com UDP) | ~485 linhas no plugin + 373 no servidor (`udp.go`) |
| Plataformas | Windows, Linux, Vesktop | só Windows | publicar só Windows+Insider; assistir exige plugin novo (Linux precisa de `ffmpeg` no PATH); site não assiste |
| Infra | LiveKit (já existe) | LiveKit (já existe) | relay próprio, porta 7996/UDP encaminhada à mão, `UDP_PUBLIC_HOST` fixo (quebra quando o IP de casa muda) |

## Achados que viram tarefa

1. **UDP entrega ~3,5 FPS a quem entra com a live já rolando** (o caso normal). O remux deixa um salto de timestamp depois do 1º quadro e o `captureStream()` do Chromium cai para ~4 FPS. O transporte em si entrega 30. O smoke test não pega isso porque liga o espectador antes do publicador. Confirmado só no Chromium headless.
2. **Nativa trava com jitter**: o muxer WHIP do FFmpeg para de ler a entrada, o encoder bloqueia, e o detector de sobrecarga culpa a GPU ("caiu para 720p"). Causa raiz não isolada.
3. **Nativa com 1% de perda cai para ~19 FPS**: o NACK recupera, mas os quadros chegam em rajada e ~1/3 nem é exibido.
4. **WebRTC demora ~50 s para chegar à qualidade pedida**: o WHIP do servidor só negocia `goog-remb`, não `transport-cc`. **Resolvido**: o modo WebRTC agora publica direto no SFU com `livekit-client` (`LivePublisher`, `session.ts`), que negocia `transport-cc`; 8 Mbps em ~13–25 s, regime 960×540 a 30 FPS e 81 ms de glass-to-glass (fonte de ruído incompressível, `balanced` troca resolução por FPS). Perde o aviso de live do bot (não há sessão WHIP).
5. **Nativa usa ~5,6 dos 8 Mbps** com `bufsize 333k` (pode ser diferente com NVENC).
6. **IP dinâmico quebra todo o Insider fora de casa** (UDP e LiveKit): `INSIDER_PUBLIC_IP` não é atualizado pelo script de UPnP, que só cuida do main.

## Recomendação

- **Remover o UDP.** No Windows real ele não funciona no padrão do próprio plugin (60 FPS/20 Mbps) e o espectador vê ~1 FPS; no Linux só ganhou no cenário de jitter. Perde em latência (4× a nativa), tem o bug de 3,5 FPS e custa ~860 linhas, um relay próprio e redirecionamento de porta manual. O problema que motivou ele (travadas pela internet) aparece igual na nativa e se ataca lá (achados 2 e 3), sem protocolo novo.
- **Manter a nativa como padrão** e corrigir a trava com jitter (2) e a queda com perda (3). O primeiro passo é medir de novo com NVENC num Windows real.
- **Manter o WebRTC só como fallback** (Linux/Vesktop e falha da nativa) e habilitar `transport-cc` no WHIP do servidor (4).
- Remover junto o código morto achado na leitura: player WHEP/MediaMTX legado, `announce` do UDP, modos sem uso do `audio-helper.cpp` (`--mic`, `--foreground-window`, `--exclude-name`).
