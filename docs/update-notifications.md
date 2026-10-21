# Avisos de atualização por push

O fluxo é `push na main → webhook assinado → servidor FockyTV → WebSocket dos clientes → checagem no GitHub → notificação`. Clientes conectados recebem o aviso assim que o evento é entregue e a consulta ao GitHub termina. A entrega não tem garantia de latência instantânea.

O cliente usa `/api/fixed/ws/plugin-updates` no servidor configurado no FockyTV. Só aceita eventos `plugin-update` com SHA válido e usa o evento apenas como gatilho para `checkUpdate`: a revisão e o instalador continuam vindo do repositório fixo no GitHub. Nunca instala nada por receber uma mensagem. A consulta ao `main` pede uma resposta sem cache. Cada revisão é notificada uma vez por sessão; se a entrega da notificação falhar, uma nova checagem pode tentar novamente.

A checagem inicial acontece imediatamente. A reconexão tem espera progressiva de 1 a 30 segundos, heartbeat a cada 25 segundos e nova checagem ao conectar para recuperar pushes ocorridos offline. A consulta a cada 15 minutos continua como fallback para falhas de webhook, servidor ou conexão. Parar o plugin encerra a conexão e os timers.

## Preparação do servidor

O backend correspondente está no projeto `fockytv`, no módulo `server/fixed-live/plugin-updates.js`, integrado ao Express antes do parser JSON e ao roteador de upgrades WebSocket. O Dockerfile copia o módulo; o compose repassa `GITHUB_WEBHOOK_SECRET` ao serviço `fixed-live`. Não há nova dependência.

1. Defina um segredo aleatório forte em `server/.env` como `GITHUB_WEBHOOK_SECRET`. Não o adicione ao Git.
2. No servidor LAN (`192.168.1.129`), em `/opt/docker/fockytv/server`, use `docker compose -f docker-compose.yml -f docker-compose.livekit.yml build fixed-live` e `docker compose -f docker-compose.yml -f docker-compose.livekit.yml up -d --no-deps fixed-live`. Recrie apenas esse serviço, preservando os overrides e as configurações do ambiente.
3. No repositório `FelipeMayerDev/fockytv-vencord-plugin`, configure um webhook ativo com URL `https://fockytv.felipemayer.com.br/api/fixed/plugin-updates/webhook`, conteúdo `application/json`, o mesmo segredo e apenas o evento **push**. Mantenha a verificação TLS ligada.
4. Confira a entrega de **ping** do GitHub e, no próximo push real da `main`, a resposta **202** e os avisos dos clientes atualizados.

A ingestão fica desativada (HTTP 503) sem segredo. O servidor verifica a assinatura HMAC-SHA256 sobre o corpo original, o repositório, `refs/heads/main`, o SHA e a indicação de exclusão da branch. Eventos de outros branches/repositórios e entregas repetidas são ignorados. O limite de corpo é 25 MB; assinaturas inválidas recebem 401. O servidor não executa comandos nem instala atualizações pelo webhook.

O broadcast usa a instância atual de `fixed-live`, que hoje é única por ambiente. Em um ambiente com várias réplicas, é necessário compartilhar os eventos entre elas. Webhooks podem atrasar, falhar ou chegar fora de ordem; por isso o cliente sempre consulta o `main` atual no GitHub e mantém o fallback. Clientes antigos precisam atualizar uma vez para passar a escutar o canal de eventos. Clientes apontados para outro servidor precisam que aquele servidor ofereça o mesmo endpoint.

Referências: [boas práticas de webhooks](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks), [falhas de entrega](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries).

## Verificação

No checkout do Vencord, rode os testes `update-events.test.ts`, `native-socket.test.ts` e `player-updates.test.ts` com `tsx --test`, além do `self-check.ts`.

No backend: `cd server/fixed-live && npm test`. O teste `test/plugin-updates.mjs` usa um servidor local e dois clientes WebSocket para verificar assinatura, filtro de branch/repositório, entregas duplicadas, broadcast e heartbeat, sem acessar produção.
