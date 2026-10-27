# Avisos de atualização, PR e CI

O fluxo é `push na main → webhook assinado → servidor FockyTV → WebSocket dos clientes → checagem no GitHub → notificação`. Clientes conectados recebem o aviso assim que o evento é entregue e a consulta ao GitHub termina. A entrega não tem garantia de latência instantânea.

O cliente usa `/api/fixed/ws/plugin-updates` no servidor configurado no FockyTV. Para atualizações, só aceita eventos `plugin-update` com SHA válido e usa o evento apenas como gatilho para `checkUpdate`: a revisão e o instalador continuam vindo do repositório fixo no GitHub. Nunca instala nada por receber uma mensagem. A consulta ao `main` pede uma resposta sem cache e varia a URL por checagem, pois a API do GitHub pode servir uma revisão antiga durante 60 segundos mesmo com `no-store`. Cada revisão é notificada uma vez por sessão; se a entrega da notificação falhar, uma nova checagem pode tentar novamente.

A checagem inicial acontece imediatamente. A reconexão tem espera progressiva de 1 a 30 segundos, heartbeat a cada 25 segundos e nova checagem ao conectar para recuperar pushes ocorridos offline. A consulta a cada 15 minutos continua como fallback para falhas de webhook, servidor ou conexão. Parar o plugin encerra a conexão e os timers.

## Preparação do servidor

O backend correspondente está no projeto `fockytv`, no módulo `server/fixed-live/plugin-updates.js`, integrado ao Express antes do parser JSON e ao roteador de upgrades WebSocket. O Dockerfile copia o módulo; o compose repassa `GITHUB_WEBHOOK_SECRET` ao serviço `fixed-live`. Não há nova dependência.

1. Defina um segredo aleatório forte em `server/.env` como `GITHUB_WEBHOOK_SECRET`. Não o adicione ao Git.
2. No servidor LAN (`192.168.1.129`), em `/opt/docker/fockytv/server`, use `docker compose -f docker-compose.yml -f docker-compose.livekit.yml build fixed-live` e `docker compose -f docker-compose.yml -f docker-compose.livekit.yml up -d --no-deps fixed-live`. Recrie apenas esse serviço, preservando os overrides e as configurações do ambiente.
3. No repositório `FelipeMayerDev/fockytv-vencord-plugin`, configure um webhook ativo com URL `https://fockytv.felipemayer.com.br/api/fixed/plugin-updates/webhook`, conteúdo `application/json`, o mesmo segredo e os eventos **push**, **pull_request** e **workflow_run**. O webhook existente é `701469983`; alterar suas assinaturas requer confirmação do responsável. Mantenha a verificação TLS ligada.
4. Confira a entrega de **ping** do GitHub e, no próximo push real da `main`, a resposta **202** e os avisos dos clientes atualizados.

A ingestão fica desativada (HTTP 503) sem segredo. O servidor verifica a assinatura HMAC-SHA256 sobre o corpo original e o repositório; para pushes, também verifica `refs/heads/main`, o SHA e a indicação de exclusão da branch. Pushes de outros branches, eventos de outros repositórios e entregas repetidas são ignorados. O limite de corpo é 25 MB; assinaturas inválidas recebem 401. O servidor não executa comandos nem instala atualizações pelo webhook.

## Alertas de PR e CI do repositório selecionado

Os avisos de PR mergeado e de CI falhada não vêm mais do webhook: cada cliente com token GitHub configurado consulta o GraphQL do GitHub (pelo processo nativo, por causa do CSP do Discord) no repositório selecionado no painel e avisa por transição, a cada 30 segundos com backoff progressivo até 5 minutos em erros:

- **PR mergeado**: busca `is:pr is:merged author:@me` no repositório desde a última consulta bem-sucedida; cada número é avisado uma vez por sessão.
- **Actions falhou no PR**: o `statusCheckRollup` de um PR aberto meu entra em falha; o aviso re-arma quando o PR sai da falha.

A primeira consulta de cada repositório é baseline e não avisa por merges ou falhas que já existiam. O escopo é só dos PRs do próprio token (`author:@me`) e do repositório selecionado (`githubRepository`, salvo pelo painel); sem token ou sem projeto escolhido, o cliente não consulta nada — verificado a cada ciclo, então remover o token ou a seleção interrompe os avisos no próximo tick. O poll continua com a aba oculta, pois avisar em segundo plano é o propósito. A URL do aviso é construída localmente a partir do repositório validado; clicar abre o PR no GitHub. Trocar o repositório selecionado reseta o baseline. Parar o plugin encerra o loop e descarta resultados tardios.

O cliente ignora mensagens `github-event` do WebSocket de updates: o canal de PR/CI por webhook foi aposentado no cliente (`update-events.ts` só trata `plugin-update`). O servidor pode continuar broadcastando `github-event`; as assinaturas `pull_request` e `workflow_run` do webhook do plugin ficaram sem efeito no cliente e podem ser removidas sem quebra. PRs e falhas do novo mecanismo não têm histórico nem recuperação de eventos offline: o que aconteceu enquanto o cliente estava fechado não é avisado. O fallback de consulta de 15 minutos continua exclusivo das atualizações do plugin.

Referências: [boas práticas de webhooks](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks), [falhas de entrega](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries).

## Verificação

No checkout do Vencord, rode os testes `update-events.test.ts`, `github-alerts.test.ts`, `native-socket.test.ts` e `player-updates.test.ts` com `tsx --test`, além do `self-check.ts`. `github-alerts.test.ts` cobre os avisos de PR/CI (transições, baseline, deduplicação e backoff) e `update-events.test.ts` verifica que `github-event` aposentado é ignorado.

No backend: `cd server/fixed-live && npm test`. O teste `test/plugin-updates.mjs` usa um servidor local e dois clientes WebSocket para verificar assinatura, filtro de branch/repositório, entregas duplicadas, broadcast de push/PR/CI, exclusão de forks e heartbeat, sem acessar produção.
