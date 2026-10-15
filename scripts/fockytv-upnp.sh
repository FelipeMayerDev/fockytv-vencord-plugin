#!/usr/bin/env bash
set -u

status=0
for rule in '7885 UDP' '7892 UDP' '7891 TCP'; do
    read -r port protocol <<< "$rule"
    if ! output=$(timeout 20s upnpc -e FockyTV -a 192.168.1.129 "$port" "$port" "$protocol" 2>&1); then
        printf 'FockyTV: falha ao encaminhar %s/%s\n%s\n' "$port" "$protocol" "$output" >&2
        status=1
    fi
done

if (( status == 0 )); then
    printf 'FockyTV: encaminhamentos UPnP atualizados.\n'
fi
exit "$status"
