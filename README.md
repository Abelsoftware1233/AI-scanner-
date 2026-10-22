# AI Beveiligingsscanner

Een web-app waarmee je **je eigen code en serverconfiguraties** laat reviewen op
beveiligingsproblemen door een lokaal Ollama-model (standaard `dolphin-llama3`). Alles draait op
je eigen machine of VPS; je code gaat niet naar een externe AI-dienst.

## Functies

- **Code plakken** of een bestand laden en scannen (lange invoer wordt automatisch in delen gescand)
- **Map of zip scannen**: kies een map, losse bestanden of een zip. De scan draait op de
  achtergrond met voortgangsbalk; je kunt de pagina sluiten en later terugkomen via *Geschiedenis*
- Risicovolle bestanden (login, config, .env, database, enz.) worden eerst gescand, daarna volgt
  een **samenvatting met prioriteiten** over alle bestanden
- **Geschiedenis** van scans (SQLite), met openen, verwijderen en alles wissen
- Geen inlog nodig: de pagina is direct bereikbaar
- 5 scantypes: algemeen, SQL-injectie, XSS/input, geheimen/credentials, server- en deploy-config
- Modelkeuze uit je geinstalleerde Ollama-modellen, statuslampje, annuleren, kopieren

## Installatie (lokaal)

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt

python app.py
```

Open <http://127.0.0.1:8976>. Ollama moet draaien en het model moeten bevatten
(`ollama list`).

## Configuratie (omgevingsvariabelen)

| Variabele | Standaard | Betekenis |
|---|---|---|
| `DATA_DIR` | `./data` | Waar de database staat |
| `OLLAMA_URL` / `OLLAMA_MODEL` | `http://localhost:11434` / `dolphin-llama3` | Ollama-adres en standaardmodel |
| `OLLAMA_TIMEOUT` | `300` | Time-out per aanroep (seconden) |
| `OLLAMA_NUM_CTX` | `8192` | Contextvenster (meer = meer geheugen nodig) |
| `OLLAMA_CONCURRENCY` | `1` | Aantal gelijktijdige modelaanroepen |
| `MAX_CODE_CHARS` | `20000` | Maximale lengte geplakte code |
| `CHUNK_CHARS` | `8000` | Grootte van een deel bij lange bestanden |
| `MAX_UPLOAD_MB` | `10` | Maximale upload (map/zip) |
| `MAX_PROJECT_FILES` / `MAX_PROJECT_CHARS` / `MAX_FILE_CHARS` | `40` / `400000` / `60000` | Limieten per projectscan |
| `MAX_ACTIVE_SCANS` | `2` | Aantal projectscans tegelijk |
| `MAX_HISTORY` | `200` | Aantal bewaarde scans |
| `HOST` / `PORT` | `127.0.0.1` / `8976` | Waar de app luistert |
| `FLASK_DEBUG` | `0` | `1` alleen tijdens ontwikkeling |

## Productie: systemd + nginx (aiscanner.abelsoftware123.com)

De app luistert op `127.0.0.1:8976` onder gunicorn; nginx zet er TLS voor.

```bash
# 1. Code plaatsen en omgeving maken
sudo useradd --system --home /opt/ai-scanner --shell /usr/sbin/nologin aiscanner
sudo mkdir -p /opt/ai-scanner && sudo cp app.py index.html script.js style.css requirements.txt /opt/ai-scanner/
cd /opt/ai-scanner && sudo python3 -m venv .venv && sudo .venv/bin/pip install -r requirements.txt
sudo chown -R aiscanner:aiscanner /opt/ai-scanner

# 2. systemd
sudo cp ai-scanner.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ai-scanner
sudo systemctl status ai-scanner
curl http://127.0.0.1:8976/api/scan-types   # moet JSON teruggeven

# 3. nginx
sudo cp nginx-aiscanner.conf /etc/nginx/sites-available/aiscanner.abelsoftware123.com
sudo ln -s /etc/nginx/sites-available/aiscanner.abelsoftware123.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 4. HTTPS (DNS A/AAAA-record moet al naar je server wijzen)
sudo certbot --nginx -d aiscanner.abelsoftware123.com
```

Logs: `journalctl -u ai-scanner -f`. Poort 8976 hoeft niet open in je firewall; alleen 80 en 443.

## Let op

- **Er is geen inlog.** Iedereen die de URL kent kan scans starten op jouw server (en jouw Ollama
  belasten), en ziet en verwijdert de gedeelde geschiedenis. Nginx beperkt het aantal scans per IP
  (10 per minuut) en `MAX_ACTIVE_SCANS` begrenst gelijktijdige projectscans. Wil je het toch afschermen,
  haal dan in `nginx-aiscanner.conf` de `#` voor `auth_basic` weg.
- AI-uitvoer kan fouten bevatten of kwetsbaarheden missen. Controleer alles zelf.
- De geschiedenis bewaart het **resultaat**, niet de ingevoerde code. Resultaten kunnen wel
  fragmenten van je code bevatten. Gebruik *Alles wissen* of verwijder `DATA_DIR/scanner.db`.
- Scan alleen code en systemen waarvan jij de eigenaar bent of waarvoor je toestemming hebt.
- Debug-modus staat uit: die geeft anders code-uitvoering op afstand via de Werkzeug-debugger.
- Gunicorn draait bewust met 1 worker (en 8 threads), omdat projectscans als achtergrondthread in
  dat proces lopen.

## Structuur

```
app.py                  Backend (scans, geschiedenis, project/zip)
index.html              Pagina
script.js               Frontend-logica
style.css               Opmaak
requirements.txt
ai-scanner.service      systemd-unit
nginx-aiscanner.conf    nginx reverse proxy
data/                   (wordt aangemaakt) database met de geschiedenis
```
