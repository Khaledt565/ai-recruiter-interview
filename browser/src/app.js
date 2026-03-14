// browser/src/app.js
// Main application logic with Interview Link Support

import { TranscribeClient } from './transcribe-client.js';
import { fromCognitoIdentityPool } from '@aws-sdk/credential-providers';

class InterviewApp {
  constructor() {
    this.transcribeClient = null;
    this.websocket = null;
    this.isInterviewActive = false;
    this.meetingId = null;
    this.attendeeId = null;
    this.interviewId = null;
    this.linkToken = null;

    // Configuration - Dynamic Backend URL
    // Production: Use API Gateway HTTPS endpoint that proxies to backend
    // Local: Use localhost HTTP
    const backendHost = window.location.hostname === 'localhost'
      ? 'localhost:8080'
      : 'l05uyc9rza.execute-api.eu-central-1.amazonaws.com/prod';

    const backendProtocol = window.location.hostname === 'localhost' ? 'http' : 'https';

    this.config = {
      backendHttpUrl: `${backendProtocol}://${backendHost}/interview/process`,  // ✅ CORRECT!
      backendBaseUrl: `${backendProtocol}://${backendHost}`,
      cognitoIdentityPoolId: 'eu-central-1:1f7604b2-8a28-44ad-b470-b4ae2b46d758',
      region: 'eu-central-1',
    };

    this.initUI();
    this.checkInterviewLink();
    window.addEventListener('offline', () => this._handleOffline());
    window.addEventListener('online', () => this._handleOnline());
  }

  initUI() {
    const container = document.getElementById('app');
    container.innerHTML = `
      <div class="interview-container">
        <div id="offline-banner" style="display:none;background:#fef3c7;border:1.5px solid #fde68a;border-radius:10px;padding:12px 16px;margin-bottom:16px;font-size:13.5px;color:#92400e;font-weight:500;">⚠️ You're offline — your last answer has been saved. We'll continue when you reconnect.</div>
        <h1>AI Recruiter Interview</h1>

        <div class="status" id="status">
          <span class="dot"></span>
          <span id="status-text">Validating interview link...</span>
        </div>

        <div class="controls">
          <button id="start-btn" class="btn-primary" disabled>Start Interview</button>
          <button id="stop-btn" class="btn-danger" disabled>Stop Interview</button>
        </div>

        <div class="interviewer-section">
          <h3>Interviewer Says:</h3>
          <div id="interviewer-text" class="interviewer-text">Waiting to start...</div>
        </div>

        <audio id="audio-output" autoplay></audio>
      </div>
    `;

    document.getElementById('start-btn').addEventListener('click', () => this.startInterview());
    document.getElementById('stop-btn').addEventListener('click', () => this.stopInterview());
  }

  // Check and validate interview link from URL
  async checkInterviewLink() {
    const urlParams = new URLSearchParams(window.location.search);
    const interviewId = urlParams.get('id');
    const token = urlParams.get('token');

    if (!interviewId || !token) {
      this.updateStatus('❌ Invalid interview link. Please use the link sent to your email.', 'error');
      document.getElementById('start-btn').disabled = true;
      return;
    }

    this.interviewId = interviewId;
    this.meetingId = interviewId;
    this.linkToken = token;

    try {
      this.updateStatus('Validating your interview link...', 'connecting');

      const response = await fetch(
        `${this.config.backendBaseUrl}/interview/validate/${interviewId}?token=${encodeURIComponent(token)}`
      );

      if (!response.ok) {
        const error = await response.json();
        this.updateStatus(`❌ ${error.error || 'Invalid interview link'}`, 'error');
        document.getElementById('start-btn').disabled = true;
        return;
      }

      const data = await response.json();
      this.attendeeId = data.attendeeId;

      this.updateStatus(`Welcome ${data.candidateName}! Ready to start your interview.`, '');
      document.getElementById('interviewer-text').textContent =
        `Hello ${data.candidateName}! Click "Start Interview" when you're ready.`;
      document.getElementById('start-btn').disabled = false;

      console.log('✅ Interview link validated successfully');
    } catch (error) {
      console.error('Validation error:', error);
      this.updateStatus('❌ Could not validate interview link. Please try again.', 'error');
      document.getElementById('start-btn').disabled = true;
    }
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

      // Initialize the interview session — this loads candidate metadata,
      // custom questions and JD from the server before any transcript arrives
      const initResp = await fetch(this.config.backendHttpUrl + '?withAudio=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meetingId: this.meetingId,
          attendeeId: this.attendeeId,
          transcriptText: '',
          isInit: true,
          token: this.linkToken,
        }),
      });
      const initData = await initResp.json();
      console.log('Init response:', initData);
      document.getElementById('interviewer-text').textContent = initData.spokenText || '';
      if (initData.audioBase64) this.playAudio(initData.audioBase64);

      console.log('Getting Cognito credentials...');
      const credentials = fromCognitoIdentityPool({
        identityPoolId: this.config.cognitoIdentityPoolId,
        clientConfig: { region: this.config.region },
      });

      console.log('Credentials obtained, starting Transcribe...');
      this.transcribeClient = new TranscribeClient(credentials, this.config.region);

      await this.transcribeClient.startTranscription(
        (finalText) => this.handleFinalTranscript(finalText),
        (partialText) => this.handlePartialTranscript(partialText)
      );

      this.isInterviewActive = true;
      this.updateStatus('Speaking... (Interview in progress)', 'active');
      document.getElementById('stop-btn').disabled = false;

      console.log('✅ Interview started successfully');
    } catch (error) {
      console.error('❌ Full error object:', error);
      console.error('Error stack:', error.stack);

      let userMessage = 'Something went wrong. Please try again.';

      if (error.message.includes('NetworkError') || error.message.includes('fetch')) {
        userMessage = '❌ Connection lost. Check your internet connection.';
      } else if (error.message.includes('NotAllowedError')) {
        userMessage = '🎤 Please allow microphone access to continue.';
      } else if (error.message.includes('Transcribe')) {
        userMessage = '🎙️ Microphone error. Please refresh and try again.';
      }

      this.updateStatus(userMessage, 'error');
      document.getElementById('start-btn').disabled = false;
    }
  }

  async stopInterview() {
    this.isInterviewActive = false;

    if (this.transcribeClient) {
      this.transcribeClient.stopTranscription();
    }

    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      // Tell server the candidate ended the interview intentionally
      this.websocket.send(JSON.stringify({ type: 'end' }));
      setTimeout(() => this.websocket.close(), 500);
    } else if (this.websocket) {
      this.websocket.close();
    }

    this.updateStatus('Interview ended', '');
    document.getElementById('start-btn').disabled = false;
    document.getElementById('stop-btn').disabled = true;

    console.log('Interview stopped');
  }

  handleFinalTranscript(text) {
    console.log('Final transcript:', text);

    if (this.isInterviewActive) {
      this.sendToBackend(this.meetingId, this.attendeeId, text);
    }
  }

  handlePartialTranscript(text) {
    if (text) {
      console.log('Partial transcript:', text);
    }
  }

  async sendToBackend(meetingId, attendeeId, text) {
    // Save answer to localStorage before attempting the request
    if (text) {
      try {
        localStorage.setItem('interview_pending_answer', JSON.stringify({
          interviewId: this.interviewId,
          text,
          meetingId,
          attendeeId,
        }));
      } catch (_) {}
    }

    if (!navigator.onLine) {
      this._handleOffline();
      return;
    }

    try {
      const response = await fetch(this.config.backendHttpUrl + '?withAudio=true', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          meetingId: meetingId,
          attendeeId: attendeeId,
          transcriptText: text,
          isInit: false,
          token: this.linkToken,
        }),
      });

      const data = await response.json();
      console.log('Backend response:', data);

      // Clear pending answer on successful response
      try { localStorage.removeItem('interview_pending_answer'); } catch (_) {}

      document.getElementById('interviewer-text').textContent = data.spokenText;

      if (data.audioBase64) {
        console.log('Playing audio response...');
        this.playAudio(data.audioBase64);
      } else {
        console.warn('No audio in response');
      }

      if (data.done) {
        this.updateStatus('✅ Interview completed! Thank you.', '');
        setTimeout(() => {
          window.location.href = 'result.html?id=' + this.interviewId;
        }, 2000);
      }
    } catch (error) {
      console.error('Backend error:', error);

      let userMessage = 'Something went wrong. Please try again.';

      if (error.message.includes('NetworkError') || error.message.includes('fetch')) {
        userMessage = '❌ Connection lost. Check your internet connection.';
      }

      this.updateStatus(userMessage, 'error');
      document.getElementById('interviewer-text').textContent = userMessage;
    }
  }

  playAudio(base64Audio) {
    const audioBlob = this.base64ToBlob(base64Audio, 'audio/mp3');
    const audioUrl = URL.createObjectURL(audioBlob);
    const audio = new Audio(audioUrl);
    audio.play().catch((err) => console.error('Audio playback error:', err));
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

  _handleOffline() {
    const banner = document.getElementById('offline-banner');
    if (banner) banner.style.display = '';
    // Pause transcription while offline
    if (this.transcribeClient && this.isInterviewActive) {
      this.transcribeClient.stopTranscription();
    }
  }

  async _handleOnline() {
    const banner = document.getElementById('offline-banner');
    if (banner) banner.style.display = 'none';

    // Re-submit any saved answer
    try {
      const pendingStr = localStorage.getItem('interview_pending_answer');
      if (!pendingStr) return;
      const pending = JSON.parse(pendingStr);
      if (pending.interviewId !== this.interviewId) return;

      this.isInterviewActive = true;
      await this.sendToBackend(pending.meetingId, pending.attendeeId, pending.text);

      // Restart transcription
      if (this.transcribeClient) {
        await this.transcribeClient.startTranscription(
          (finalText) => this.handleFinalTranscript(finalText),
          (partialText) => this.handlePartialTranscript(partialText)
        );
        this.updateStatus('Speaking... (Interview in progress)', 'active');
      }
    } catch (e) {
      console.error('Error resuming after reconnect:', e);
    }
  }
}

// Initialize app when DOM is ready
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    window.app = new InterviewApp();
  });
}
