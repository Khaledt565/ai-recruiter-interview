// browser/src/transcribe-client.js
// Simplified browser-based Amazon Transcribe client

import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
} from '@aws-sdk/client-transcribe-streaming';

export class TranscribeClient {
  constructor(credentials, region = 'eu-central-1') {
    this.client = new TranscribeStreamingClient({
      region,
      credentials,
    });
    this.isTranscribing = false;
    this.onTranscriptCallback = null;
    this.onPartialCallback = null;
    this.audioContext = null;
    this.processor = null;
    this.stream = null;
    this.sampleRate = 48000; // Default, will be set by browser
  }

  async startTranscription(onTranscript, onPartial = null) {
  if (this.isTranscribing) {
    console.warn('Already transcribing');
    return;
  }

  this.onTranscriptCallback = onTranscript;
  this.onPartialCallback = onPartial;

  try {
    // Get microphone without forcing sample rate
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });

    // Create audio context with default sample rate
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    this.sampleRate = this.audioContext.sampleRate;
    
    console.log('Using sample rate:', this.sampleRate);
    
    const source = this.audioContext.createMediaStreamSource(this.stream);
    
    // Create ScriptProcessor (older but more compatible)
    const bufferSize = 4096;
    this.processor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
    
    const self = this;
    const audioChunks = [];
    
    this.processor.onaudioprocess = (e) => {
      if (self.isTranscribing) {
        const inputData = e.inputBuffer.getChannelData(0);
        audioChunks.push(new Float32Array(inputData));
        console.log('Captured audio chunk, queue size:', audioChunks.length); // Debug
      }
    };
    
    source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);

    // IMPORTANT: Set transcribing BEFORE starting stream
    this.isTranscribing = true;

    const command = new StartStreamTranscriptionCommand({
      LanguageCode: 'en-US',
      MediaEncoding: 'pcm',
      MediaSampleRateHertz: this.sampleRate,
      AudioStream: this.createAudioStream(audioChunks),
    });

    console.log('Starting Transcribe...');
    const response = await this.client.send(command);

    this.handleTranscriptionStream(response.TranscriptResultStream);

    console.log('✅ Transcription started');
  } catch (error) {
    console.error('❌ Transcribe error:', error);
    this.isTranscribing = false;
    throw error;
  }
}

 async *createAudioStream(audioChunks) {
  while (this.isTranscribing) {
    if (audioChunks.length > 0) {
      const chunk = audioChunks.shift(); // Remove from queue
      
      if (chunk && chunk.length > 0) {
        const pcmData = this.encodePCM(chunk);
        console.log('Sending audio chunk:', pcmData.length, 'bytes'); // Debug
        yield { AudioEvent: { AudioChunk: pcmData } };
      }
    } else {
      // Wait for more data
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

  encodePCM(float32Array) {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);

    for (let i = 0; i < float32Array.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Array[i]));
      view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }

    return new Uint8Array(buffer);
  }

  async handleTranscriptionStream(stream) {
  try {
    console.log('Listening for transcripts...');
    for await (const event of stream) {
      console.log('Received event:', event); // Debug
      
      if (!event.TranscriptEvent) continue;

      const results = event.TranscriptEvent.Transcript.Results;
      console.log('Results:', results); // Debug

      for (const result of results) {
        if (!result.Alternatives || result.Alternatives.length === 0) continue;

        const transcript = result.Alternatives[0].Transcript;
        console.log('Transcript:', transcript, 'IsPartial:', result.IsPartial); // Debug

        if (!result.IsPartial && transcript.trim() !== '') {
          if (this.onTranscriptCallback) {
            this.onTranscriptCallback(transcript);
          }
        } else if (result.IsPartial && this.onPartialCallback) {
          this.onPartialCallback(transcript);
        }
      }
    }
  } catch (error) {
    console.error('Stream error:', error);
  }
}

  stopTranscription() {
    this.isTranscribing = false;
    
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    
    console.log('Transcription stopped');
  }
}