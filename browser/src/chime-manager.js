// browser/src/chime-manager.js
// Manages Chime SDK meeting and audio

import {
  ConsoleLogger,
  DefaultDeviceController,
  DefaultMeetingSession,
  LogLevel,
  MeetingSessionConfiguration,
} from 'amazon-chime-sdk-js';

export class ChimeManager {
  constructor() {
    this.meetingSession = null;
    this.audioElement = null;
    this.meetingId = null;
    this.attendeeId = null;
  }

  /**
   * Join a Chime meeting
   * @param {string} meetingId - The meeting ID
   * @param {string} attendeeId - The attendee ID
   * @param {object} meetingData - Meeting and attendee data from backend
   */
  async joinMeeting(meetingId, attendeeId, meetingData) {
    this.meetingId = meetingId;
    this.attendeeId = attendeeId;

    const logger = new ConsoleLogger('ChimeSDK', LogLevel.WARN);
    const deviceController = new DefaultDeviceController(logger);

    const configuration = new MeetingSessionConfiguration(
      meetingData.Meeting,
      meetingData.Attendee
    );

    this.meetingSession = new DefaultMeetingSession(
      configuration,
      logger,
      deviceController
    );

    // Setup audio element for output
    this.audioElement = document.getElementById('audio-output');
    if (!this.audioElement) {
      this.audioElement = document.createElement('audio');
      this.audioElement.id = 'audio-output';
      this.audioElement.autoplay = true;
      document.body.appendChild(this.audioElement);
    }

    const audioOutputElement = this.audioElement;
    await this.meetingSession.audioVideo.bindAudioElement(audioOutputElement);

    // Get microphone permission and select device
    const audioInputDevices = await this.meetingSession.audioVideo.listAudioInputDevices();
    if (audioInputDevices.length > 0) {
      await this.meetingSession.audioVideo.startAudioInput(audioInputDevices[0].deviceId);
    }

    // Start the session
    this.meetingSession.audioVideo.start();

    console.log('✅ Joined Chime meeting:', meetingId);
  }

  /**
   * Leave the meeting
   */
  async leaveMeeting() {
    if (this.meetingSession) {
      this.meetingSession.audioVideo.stop();
      this.meetingSession = null;
    }
    console.log('Left meeting');
  }

  /**
   * Mute/unmute microphone
   */
  setMuted(muted) {
    if (this.meetingSession) {
      if (muted) {
        this.meetingSession.audioVideo.realtimeMuteLocalAudio();
      } else {
        this.meetingSession.audioVideo.realtimeUnmuteLocalAudio();
      }
    }
  }

  /**
   * Check if connected
   */
  isConnected() {
    return this.meetingSession !== null;
  }

  /**
   * Get meeting info
   */
  getMeetingInfo() {
    return {
      meetingId: this.meetingId,
      attendeeId: this.attendeeId,
    };
  }
}
