from flask import Flask, request, jsonify, render_template
from flask_cors import CORS
import requests

app = Flask(__name__)
CORS(app)

# Configuratie voor jouw lokale Ollama instantie met dolphin-llama3
OLLAMA_URL = "http://localhost:11434/api/chat"
MODEL_NAME = "dolphin-llama3"  # Pas dit aan als jouw modelnaam in Ollama anders heet (bijv. dolphin-llama3.1)

@app.route('/')
def home():
    return render_template('index.html')

@app.route('/api/scan', methods=['POST'])
def scan_code():
    data = request.json
    code_snippet = data.get('code', '')
    scan_type = data.get('scan_type', 'general')

    if not code_snippet.strip():
        return jsonify({'error': 'Geen code of configuratie opgegeven.'}), 400

    # Stel de system prompt in op basis van het type scan
    if scan_type == 'sql_injection':
        system_prompt = (
            "Je bent een expert Ethical Hacker en specialist in websurveillances en SQL-injecties. "
            "Analyseer de opgegeven code heel kritisch op SQL-injectie kwetsbaarheden. "
            "Leg uit waar de kwetsbaarheid zit, waarom dit gevaarlijk is, en geef direct de veilige code-oplossing."
        )
    else:
        system_prompt = (
            "Je bent een expert Ethical Hacker en Cybersecurity Auditor. "
            "Analyseer de onderstaande code of serverconfiguratie op beveiligingsrisico's (zoals OWASP Top 10, misconfiguraties, "
            "hardcoded geheimen of logische fouten). Geef duidelijke verbeterpunten en patches."
        )

    payload = {
        "model": MODEL_NAME,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": code_snippet}
        ],
        "stream": False
    }

    try:
        response = requests.post(OLLAMA_URL, json=payload, timeout=60)
        if response.status_code == 200:
            result = response.json()['message']['content']
            return jsonify({'result': result})
        else:
            return jsonify({'error': f'Ollama gaf een foutcode terug: {response.text}'}), 500
    except Exception as e:
        return jsonify({'error': f'Kan geen verbinding maken met Ollama. Draait Ollama lokaal? Details: {str(e)}'}), 500

if __name__ == '__main__':
    app.run(debug=True, port=5000)
  
