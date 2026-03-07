// browser/src/app.js
// Main application logic

import { TranscribeClient } from './transcribe-client.js';
import { fromCognitoIdentityPool } from '@aws-sdk/credential-providers';

class InterviewApp {
  constructor() {
    this.transcribeClient = null;
    this.websocket = null;
    this.isInterviewActive = false;

    // Configuration - replace with your values
   this.config = {
    backendHttpUrl: 'http://63.179.199.108:8080/interview/process', 
  cognitoIdentityPoolId: 'eu-central-1:1f7604b2-8a28-44ad-b470-b4ae2b46d758',
  region: 'eu-central-1',
};

    this.initUI();
  }

  initUI() {
    // Create UI elements
    const container = document.getElementById('app');
    container.innerHTML = `
      <div class="interview-container">
        <h1>AI Recruiter Interview</h1>
        
        <div class="status" id="status">
          <span class="dot"></span>
          <span id="status-text">Ready to start</span>
        </div>

        <div class="controls">
          <button id="start-btn" class="btn-primary">Start Interview</button>
          <button id="stop-btn" class="btn-danger" disabled>Stop Interview</button>
        </div>

        <div class="transcript-section">
          <h3>Live Transcript</h3>
          <div id="partial-transcript" class="partial"></div>
          <div id="final-transcript" class="transcript"></div>
        </div>

        <div class="interviewer-section">
          <h3>Interviewer Says:</h3>
          <div id="interviewer-text" class="interviewer-text"></div>
        </div>

        <audio id="audio-output" autoplay></audio>
      </div>
    `;

    // Attach event listeners
    document.getElementById('start-btn').addEventListener('click', () => this.startInterview());
    document.getElementById('stop-btn').addEventListener('click', () => this.stopInterview());
  }

  updateStatus(text, className = '') {
    const statusText = document.getElementById('status-text');
    const statusDot = document.querySelector('.status .dot');
    statusText.textContent = text;
    statusDot.className = `dot ${className}`;
  }

 async startInterview() {
  try {
    this.updateStatus('Initializing...', 'connecting');
    document.getElementById('start-btn').disabled = true;

    const meetingId = 'test-' + Date.now();
    const attendeeId = 'user-' + Math.random().toString(36).substr(2, 9);

    console.log('Getting Cognito credentials...');
    const credentials = fromCognitoIdentityPool({
      identityPoolId: this.config.cognitoIdentityPoolId,
      clientConfig: { region: this.config.region },
    });

    console.log('Credentials obtained, starting Transcribe...');
    this.transcribeClient = new TranscribeClient(credentials, this.config.region);
    
    await this.transcribeClient.startTranscription(
      (finalText) => this.sendToLambda(meetingId, attendeeId, finalText),
      (partialText) => this.handlePartialTranscript(partialText)
    );

    this.isInterviewActive = true;
    this.updateStatus('Speaking... (Transcribe active)', 'active');
    document.getElementById('stop-btn').disabled = false;

    console.log('✅ Interview started successfully');
  } catch (error) {
    console.error('❌ Full error object:', error);
    console.error('Error stack:', error.stack);
    this.updateStatus('Error: ' + (error.message || 'Unknown error'), 'error');
    document.getElementById('start-btn').disabled = false;
  }
}

async sendToLambda(meetingId, attendeeId, text) {
  const finalDiv = document.getElementById('final-transcript');
  const p = document.createElement('p');
  p.textContent = `You: ${text}`;
  finalDiv.appendChild(p);
  finalDiv.scrollTop = finalDiv.scrollHeight;

  document.getElementById('partial-transcript').textContent = '';

  try {
    // Add withAudio parameter
    const response = await fetch(this.config.backendHttpUrl + '?withAudio=true', {  // ← Add this
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ 
        meetingId: meetingId,
        attendeeId: attendeeId,
        transcriptText: text,
        isInit: false
      }),
    });

    const data = await response.json();
    console.log('Fargate response:', data);

    document.getElementById('interviewer-text').textContent = data.spokenText;

    if (data.audioBase64) {
      console.log('Playing audio response...');
      this.playAudio(data.audioBase64);
    } else {
      console.warn('No audio in response');
    }

    if (data.done) {
      this.updateStatus('Interview completed!', '');
      setTimeout(() => this.stopInterview(), 3000);
    }
  } catch (error) {
    console.error('Fargate error:', error);
    document.getElementById('interviewer-text').textContent = 'Error connecting to interviewer';
  }
}

  async stopInterview() {
    this.isInterviewActive = false;

    if (this.transcribeClient) {
      this.transcribeClient.stopTranscription();
    }

    if (this.websocket) {
      this.websocket.close();
    }

    this.updateStatus('Interview ended', '');
    document.getElementById('start-btn').disabled = false;
    document.getElementById('stop-btn').disabled = true;

    console.log('Interview stopped');
  }

  async connectWebSocket(meetingId, attendeeId) {
    return new Promise((resolve, reject) => {
      this.websocket = new WebSocket(this.config.backendWsUrl);

      this.websocket.onopen = () => {
        console.log('WebSocket connected');
        this.sendMessage({ type: 'connect', meetingId, attendeeId });
        resolve();
      };

      this.websocket.onmessage = (event) => {
        this.handleWebSocketMessage(JSON.parse(event.data));
      };

      this.websocket.onerror = (error) => {
        console.error('WebSocket error:', error);
        reject(error);
      };

      this.websocket.onclose = () => {
        console.log('WebSocket closed');
      };
    });
  }

  sendMessage(message) {
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      this.websocket.send(JSON.stringify(message));
    }
  }

  handleFinalTranscript(text) {
    console.log('Final transcript:', text);

    // Display in UI
    const finalDiv = document.getElementById('final-transcript');
    const p = document.createElement('p');
    p.textContent = `You: ${text}`;
    finalDiv.appendChild(p);
    finalDiv.scrollTop = finalDiv.scrollHeight;

    // Clear partial
    document.getElementById('partial-transcript').textContent = '';

    // Send to backend
    if (this.isInterviewActive) {
      this.sendMessage({ type: 'transcript', text });
    }
  }

  handlePartialTranscript(text) {
    const partialDiv = document.getElementById('partial-transcript');
    partialDiv.textContent = text ? `You (speaking): ${text}...` : '';
  }

  handleWebSocketMessage(data) {
    console.log('WebSocket message:', data);

    if (data.type === 'response') {
      // Display interviewer text
      const interviewerDiv = document.getElementById('interviewer-text');
      interviewerDiv.textContent = data.spokenText;

      // Play audio
      if (data.audioBase64) {
        this.playAudio(data.audioBase64);
      }

      // Check if done
      if (data.done) {
        this.updateStatus('Interview completed!', '');
        setTimeout(() => this.stopInterview(), 3000);
      }
    } else if (data.type === 'error') {
      console.error('Backend error:', data.error);
      this.updateStatus('Error: ' + data.error, 'error');
    }
  }

 playAudio(base64Audio) {
    const audioBlob = this.base64ToBlob(base64Audio, 'audio/mp3');
    const audioUrl = URL.createObjectURL(audioBlob);
    const audio = new Audio(audioUrl);
    audio.play().catch(err => console.error('Audio playback error:', err));
  }

  base64ToBlob(base64, mimeType) {
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mimeType });
  }
}

// Initialize app when DOM is ready
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    window.app = new InterviewApp();
  });
}
