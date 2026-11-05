#!/bin/bash
# Live end-to-end test of the eSSL link: a throw-away link key (made here, never printed), the real Windows sync
# script fed by a fake eSSL database, the real bio-sync endpoint. Everything it creates is deleted at the end.
set -u
H=(-H "apikey: $SERVICE" -H "Authorization: Bearer $SERVICE" -H "Content-Type: application/json")
key="stnbio_$(openssl rand -hex 32)"; echo "::add-mask::$key"
hash=$(printf '%s' "$key" | sha256sum | cut -d' ' -f1)
link=$(curl -s "${H[@]}" -H "Prefer: return=representation" "$SUPA_URL/rest/v1/bio_links" -d "{\"name\":\"CI test $(date +%s)\",\"key_hash\":\"$hash\"}" | jq -r '.[0].id')
echo "BIO link created: ${link:0:8}"
cleanup() { curl -s -o /dev/null -w "BIO cleanup HTTP %{http_code}\n" "${H[@]}" -X DELETE "$SUPA_URL/rest/v1/bio_links?id=eq.$link"; }
trap cleanup EXIT
echo "BIO bad key -> HTTP $(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'x-bio-key: stnbio_0000' "$SUPA_URL/functions/v1/bio-sync" -d '{}')"
echo "BIO no key  -> HTTP $(curl -s -o /dev/null -w '%{http_code}' -X POST "$SUPA_URL/functions/v1/bio-sync" -d '{}')"
root=$(mktemp -d); fake=$PWD/tools/essl-sync/test
n=$(date +%-m); y=$(date +%Y); pm=$(date -d "$(date +%Y-%m-15) -1 month" +%-m); py=$(date -d "$(date +%Y-%m-15) -1 month" +%Y)
echo 620 > $fake/DeviceLogs_${n}_${y}.count; echo 4 > $fake/DeviceLogs_${pm}_${py}.count
jq -n --arg u "$SUPA_URL/functions/v1/bio-sync" --arg k "$key" --arg f "$fake" '{url:$u,key:$k,sql_server:"x",database:"x",interval_sec:2,fake_dir:$f}' > $root/config.json
export STN_SYNC_ROOT=$root TZ=Asia/Kolkata
for i in 1 2 3; do t0=$(date +%s%N); pwsh -NoProfile -File tools/essl-sync/stn-essl-sync.ps1 -Once | sed 's/^/BIO run'$i': /'; echo "BIO run$i took $(( ($(date +%s%N)-t0)/1000000 )) ms"; done
echo "BIO status: $(jq -c '{last_ok,last_error,sent_total,cursors}' $root/status.json)"
rm $root/state.json; pwsh -NoProfile -File tools/essl-sync/stn-essl-sync.ps1 -Once | sed 's/^/BIO resend-all: /'
cnt=$(curl -s "${H[@]}" -H "Prefer: count=exact" -I "$SUPA_URL/rest/v1/bio_punches?link_id=eq.$link&select=id" | grep -i content-range | sed 's#.*/##' | tr -d '\r')
echo "BIO punches stored: $cnt (expected 624)"
echo "BIO devices: $(curl -s "${H[@]}" "$SUPA_URL/rest/v1/bio_devices?link_id=eq.$link&select=essl_id,name,kind,serial" | jq -c .)"
echo "BIO people: $(curl -s "${H[@]}" "$SUPA_URL/rest/v1/bio_people?link_id=eq.$link&select=device_code,essl_code,matched" | jq -c .)"
echo "BIO heartbeat: $(curl -s "${H[@]}" "$SUPA_URL/rest/v1/bio_status?link_id=eq.$link&select=last_seen" | jq -c .)"
