#!/usr/bin/env bash
# deploy.sh - installeert of update de AI Beveiligingsscanner op een Debian/Ubuntu VPS.
#
# Gebruik, in de map met de bestanden:
#   sudo ./deploy.sh              eerste installatie (of alles opnieuw instellen)
#   sudo ./deploy.sh update       alleen de bestanden vervangen en de service herstarten
#
# Optioneel, voor het commando (bijv.: sudo EMAIL=jij@voorbeeld.nl ./deploy.sh):
#   DOMAIN=aiscanner.abelsoftware123.com   domeinnaam van de scanner
#   EMAIL=jij@voorbeeld.nl                 met een e-mailadres wordt meteen HTTPS (Let's Encrypt) aangezet
#   CORS_ORIGINS=https://naam.github.io    alleen nodig als de pagina op GitHub Pages staat
#   OLLAMA_MODEL=dolphin-llama3            ander standaardmodel
set -euo pipefail

DOMAIN="${DOMAIN:-aiscanner.abelsoftware123.com}"
EMAIL="${EMAIL:-}"
CORS_ORIGINS="${CORS_ORIGINS:-}"
MODEL_OVERRIDE="${OLLAMA_MODEL:-}"
APP_DIR="${APP_DIR:-/opt/ai-scanner}"
APP_USER="${APP_USER:-aiscanner}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
NGINX_AVAIL="${NGINX_AVAIL:-/etc/nginx/sites-available}"
NGINX_ENABLED="${NGINX_ENABLED:-/etc/nginx/sites-enabled}"
SERVICE="ai-scanner"
APP_PORT=8976
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-full}"

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mLET OP:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mFOUT:\033[0m %s\n' "$*" >&2; exit 1; }

# --- Controles ---------------------------------------------------------------------------
[[ "$(id -u)" -eq 0 ]] || die "Draai dit als root: sudo ./deploy.sh"
[[ "$MODE" == "full" || "$MODE" == "update" ]] || die "Gebruik: sudo ./deploy.sh [update]"
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "Ongeldige DOMAIN: $DOMAIN"
[[ -z "$EMAIL" || "$EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || die "Ongeldig EMAIL: $EMAIL"
[[ -z "$CORS_ORIGINS" || "$CORS_ORIGINS" =~ ^[A-Za-z0-9:/.,*-]+$ ]] || die "Ongeldige CORS_ORIGINS: $CORS_ORIGINS"
[[ -z "$MODEL_OVERRIDE" || "$MODEL_OVERRIDE" =~ ^[A-Za-z0-9._:/-]+$ ]] || die "Ongeldige OLLAMA_MODEL: $MODEL_OVERRIDE"

for f in app.py index.html script.js style.css requirements.txt ai-scanner.service nginx-aiscanner.conf; do
    [[ -f "$SRC_DIR/$f" ]] || die "Bestand ontbreekt naast deploy.sh: $f"
done

# --- 1. Pakketten (alleen bij eerste installatie) ----------------------------------------
if [[ "$MODE" == "full" ]]; then
    if command -v apt-get >/dev/null 2>&1; then
        log "Pakketten installeren (python3, nginx, curl)"
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq
        apt-get install -y -qq python3 python3-venv python3-pip nginx curl >/dev/null
        if [[ -n "$EMAIL" ]]; then
            apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
        fi
    else
        warn "apt-get niet gevonden: installeer zelf python3-venv, nginx, curl (en certbot)."
    fi

    # --- 2. Gebruiker ---
    if ! id "$APP_USER" >/dev/null 2>&1; then
        log "Gebruiker '$APP_USER' aanmaken"
        useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
    fi
fi

# --- 3. Bestanden plaatsen ---------------------------------------------------------------
log "Bestanden kopieren naar $APP_DIR"
install -d -m 755 "$APP_DIR"
for f in app.py index.html script.js style.css requirements.txt; do
    install -m 644 "$SRC_DIR/$f" "$APP_DIR/$f"
done

# --- 4. Python-omgeving ------------------------------------------------------------------
if [[ ! -x "$APP_DIR/.venv/bin/python" ]]; then
    log "Python-omgeving maken"
    python3 -m venv "$APP_DIR/.venv"
fi
log "Python-pakketten installeren"
"$APP_DIR/.venv/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"

# --- 5. systemd --------------------------------------------------------------------------
if [[ "$MODE" == "full" ]]; then
    log "systemd-service instellen"
    install -d -m 755 "$SYSTEMD_DIR"
    sed -e "s#/opt/ai-scanner#${APP_DIR}#g" \
        -e "s#^User=.*#User=${APP_USER}#" \
        -e "s#^Group=.*#Group=${APP_USER}#" \
        "$SRC_DIR/ai-scanner.service" > "$SYSTEMD_DIR/$SERVICE.service"
    chmod 644 "$SYSTEMD_DIR/$SERVICE.service"

    # Losse instellingen blijven bewaard bij opnieuw draaien; ze worden alleen herschreven als je ze meegeeft
    DROPIN="$SYSTEMD_DIR/$SERVICE.service.d"
    if [[ -n "$CORS_ORIGINS" ]]; then
        install -d -m 755 "$DROPIN"
        printf '[Service]\nEnvironment=CORS_ORIGINS=%s\n' "$CORS_ORIGINS" > "$DROPIN/cors.conf"
        log "CORS ingesteld voor: $CORS_ORIGINS"
    fi
    if [[ -n "$MODEL_OVERRIDE" ]]; then
        install -d -m 755 "$DROPIN"
        printf '[Service]\nEnvironment=OLLAMA_MODEL=%s\n' "$MODEL_OVERRIDE" > "$DROPIN/model.conf"
        log "Standaardmodel ingesteld: $MODEL_OVERRIDE"
    fi
    systemctl daemon-reload
    systemctl enable "$SERVICE" >/dev/null 2>&1 || true
fi

log "Service (her)starten"
systemctl restart "$SERVICE"

log "Wachten tot de scanner reageert op poort $APP_PORT"
ok=0
for _ in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:${APP_PORT}/api/scan-types" >/dev/null 2>&1; then ok=1; break; fi
    sleep 1
done
if [[ "$ok" -ne 1 ]]; then
    journalctl -u "$SERVICE" -n 30 --no-pager 2>/dev/null || true
    die "De scanner start niet. Bekijk de logs hierboven of: journalctl -u $SERVICE -f"
fi
log "Scanner draait"

# --- 6. nginx en HTTPS (alleen bij eerste installatie) -----------------------------------
if [[ "$MODE" == "full" ]]; then
    if command -v nginx >/dev/null 2>&1; then
        CONF="$NGINX_AVAIL/$DOMAIN"
        install -d -m 755 "$NGINX_AVAIL" "$NGINX_ENABLED"
        if [[ -f "$CONF" ]] && grep -q "managed by Certbot" "$CONF"; then
            log "nginx-config bevat al HTTPS (certbot): niet overschreven"
        else
            log "nginx instellen voor $DOMAIN"
            sed "s/aiscanner\.abelsoftware123\.com/${DOMAIN}/g" "$SRC_DIR/nginx-aiscanner.conf" > "$CONF"
        fi
        ln -sfn "$CONF" "$NGINX_ENABLED/$DOMAIN"
        nginx -t
        systemctl reload nginx

        if [[ -z "$(getent hosts "$DOMAIN" 2>/dev/null || true)" ]]; then
            warn "$DOMAIN verwijst nog nergens naartoe. Maak eerst een DNS A-record naar dit serveradres."
        fi

        if [[ -n "$EMAIL" ]]; then
            if grep -q "managed by Certbot" "$CONF"; then
                log "HTTPS staat al aan"
            else
                log "HTTPS aanvragen (Let's Encrypt)"
                certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect \
                    || warn "certbot is mislukt (meestal DNS). Probeer later: sudo certbot --nginx -d $DOMAIN"
            fi
        else
            log "Voor HTTPS: sudo EMAIL=jij@voorbeeld.nl ./deploy.sh   (of: sudo certbot --nginx -d $DOMAIN)"
        fi
    else
        warn "nginx niet gevonden: installeer nginx en kopieer nginx-aiscanner.conf zelf."
    fi
fi

# --- 7. Ollama controleren ---------------------------------------------------------------
MODEL="${MODEL_OVERRIDE:-dolphin-llama3}"
if tags="$(curl -fsS --max-time 5 http://127.0.0.1:11434/api/tags 2>/dev/null)"; then
    if grep -q "\"${MODEL}" <<<"$tags"; then
        log "Ollama bereikbaar en model '$MODEL' aanwezig"
    else
        warn "Ollama draait, maar model '$MODEL' staat er niet in. Installeer het met: ollama pull $MODEL"
    fi
else
    warn "Ollama niet bereikbaar op 127.0.0.1:11434. Start het met: sudo systemctl start ollama"
fi

# --- Klaar -------------------------------------------------------------------------------
echo
log "Klaar!"
if [[ "$MODE" == "full" ]]; then
    scheme="http"; grep -q "managed by Certbot" "$NGINX_AVAIL/$DOMAIN" 2>/dev/null && scheme="https"
    echo "    Adres:    ${scheme}://${DOMAIN}"
fi
echo "    Status:   sudo systemctl status $SERVICE"
echo "    Logs:     sudo journalctl -u $SERVICE -f"
echo "    Updaten:  sudo ./deploy.sh update   (na het vervangen van de bestanden)"
