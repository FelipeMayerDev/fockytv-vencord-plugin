#!/usr/bin/env bash
set -u

server_dir=${FOCKYTV_SERVER_DIR:-/opt/docker/fockytv/server}

status=0
for rule in '7885 UDP' '7892 UDP' '7891 TCP'; do
    read -r port protocol <<< "$rule"
    if ! output=$(timeout 20s upnpc -e FockyTV -a 192.168.1.129 "$port" "$port" "$protocol" 2>&1); then
        printf 'FockyTV: falha ao encaminhar %s/%s\n%s\n' "$port" "$protocol" "$output" >&2
        status=1
    fi
done

# O IP público é dinâmico; o LiveKit anuncia node_ip no ICE e, com o IP antigo,
# ninguém fora da LAN conecta (publicar ou assistir).
ip=$(timeout 20s upnpc -s 2>/dev/null | sed -n 's/^ExternalIPAddress = //p')
current=$(sed -n 's/^LIVEKIT_NODE_IP=//p' "$server_dir/.env")
if [[ $ip =~ ^[0-9]+(\.[0-9]+){3}$ && $ip != 0.0.0.0 && $ip != "$current" ]]; then
    sed -i "s/^LIVEKIT_NODE_IP=.*/LIVEKIT_NODE_IP=$ip/" "$server_dir/.env"
    if (cd "$server_dir" && docker compose -f docker-compose.yml -f docker-compose.livekit.yml up -d livekit livekit-ingress); then
        printf 'FockyTV: IP público mudou de %s para %s; LiveKit recriado.\n' "$current" "$ip"
    else
        printf 'FockyTV: falha ao recriar o LiveKit com o IP %s\n' "$ip" >&2
        status=1
    fi
fi

if (( status == 0 )); then
    printf 'FockyTV: encaminhamentos UPnP atualizados.\n'
fi
exit "$status"
