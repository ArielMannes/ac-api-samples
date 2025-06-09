import http from 'http';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import WebSocket, { WebSocketServer } from 'ws';
import { verifyClientFunc } from './mock-ac-bot.js';
import { Activities, BotActivity, BotActivityEventName, BotActivityType, BotToVaicMessageName, ProtocolMessage, VaicToBotMessageName } from './types.js';
import { Readable } from 'stream';

const welcomeMessageMediaFormat = 'raw/lpcm16';
const accessToken = process.env.ACCESS_TOKEN
const listenHost = process.env.LISTEN_HOST || 'localhost';
const voiceBotWs = parseInt(process.env.VOICE_BOT_WS_PORT || '8050', 10);


class VoiceBotSession {
  private ended: boolean;
  private webSocket: WebSocket | undefined;
  private convId = '';
  private mediaFormat: string;
  private caller: string;
  private recordingSeq = 0;
  private incomingAudioBuffer: Buffer | undefined;
  private sendBackIncomingVoice: NodeJS.Timeout | undefined;
  private directTTS: any;

  constructor(webSocket: WebSocket, private options: { echoTime: number; token: string }) {
    this.webSocket = webSocket;
    webSocket.on('message', async (message, isBinary) => {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const msgStr = message.toString();
      if (isBinary) {
        console.info('bot received: ---binary data--- length:', msgStr.length);
        this.onBinary(message as ArrayBuffer);
        return;
      }
      if (msgStr.startsWith('{'))
        try {
          await this.onJson(JSON.parse(msgStr));
        } catch (err) {
          console.error('Error parsing JSON message:', msgStr, err);
        }
    });
    webSocket.on('close', () => {
      console.debug('connection closed');
      this.end();
    });
    webSocket.on('error', (err) => {
      console.error('connection error:', err);
      this.end();
    });
  }
  end() {
    if (this.ended)
      return
    this.webSocket?.close();
    this.ended = true;
    if (this.sendBackIncomingVoice) {
      clearTimeout(this.sendBackIncomingVoice);
      delete this.sendBackIncomingVoice;
    }
    delete this.webSocket;
  }
  private onBinary(message: ArrayBuffer) {
    const currentBuffer = this.incomingAudioBuffer;
    this.incomingAudioBuffer = Buffer.concat([currentBuffer || Buffer.alloc(0), Buffer.from(message)]);
  }
  private async onJson(msgJson: ProtocolMessage) {
    if (msgJson.type !== VaicToBotMessageName.userStreamChunk)
      console.debug('received message:', msgJson.type);
    switch (msgJson.type) {
      case VaicToBotMessageName.sessionInitiate: {
        this.convId = msgJson.conversationId;
        this.directTTS = msgJson.expectAudioMessages;
        const { supportedMediaFormats } = msgJson;
        if (supportedMediaFormats) {
          this.mediaFormat = supportedMediaFormats.shift() || welcomeMessageMediaFormat;
        } else {
          throw new Error('No supported audio coder or media format');
        }
        this.caller = msgJson.caller!;
        await this.send(BotToVaicMessageName.sessionAccepted, {
          mediaFormat: this.mediaFormat,
          success: this.options.token === accessToken
        });
        break;
      }
      case VaicToBotMessageName.sessionResume:
        if (msgJson.conversationId === this.convId)
          await this.send(BotToVaicMessageName.sessionAccepted);
        else
          await this.send(BotToVaicMessageName.sessionError, { conversationId: msgJson.conversationId, reason: 'conversation not found' });
        break;
      case VaicToBotMessageName.userStreamStart:
        await this.send(BotToVaicMessageName.userStreamStarted);
        break;
      case VaicToBotMessageName.userStreamStop:
        await this.finalizeEcho();
        await this.send(BotToVaicMessageName.userStreamStopped);
        break;
      case VaicToBotMessageName.activities:
        for (const activity of msgJson.activities!)
          await this.handleActivity(activity);
        break;
      case VaicToBotMessageName.userStreamChunk:
        this.onBinary(Buffer.from(msgJson.audioChunk!, 'base64'));
        break;
      case VaicToBotMessageName.sessionEnd:
        this.end();
        break;
      default:
        console.info('handling unknown message:', msgJson.type);
        break;
    }
  }
  handleActivity(activity: any) {
    if (activity.type === 'event') {
      const valStr = activity.value ? `. Value: ${JSON.stringify(activity.value)}` : '';
      console.debug(`got event - ${activity.name}${valStr}`);
      if (activity.name === BotActivityEventName.start){
        const audioBuffer =  Buffer.from(fs.readFileSync(path.resolve(import.meta.dirname, 'static/welcome-prompt-16k.raw')));
        const recognitionString = 'Hi, I am AudioCodes direct voice sample bot. You can talk and I will echo it back.';
        return this.sendAudioStreamInChunks(audioBuffer, recognitionString, welcomeMessageMediaFormat).then(() => {
          this.sendBackIncomingVoice = setInterval(() => {
          console.info('Sending back incoming voice');
          if (this.incomingAudioBuffer) {
            const audioBuffer = Buffer.from(this.incomingAudioBuffer);
            this.incomingAudioBuffer = Buffer.alloc(0);
            this.sendAudioStreamInChunks(audioBuffer, 'Echoing back incoming voice');
          } else {
            console.warn('No incoming audio buffer to send back');
          }
        }, this.options.echoTime);
        });
      }
      return Promise.resolve();
    }
    if (activity.type === 'message' && activity.text) {
      console.info('handling activity:', activity.type, 'text:', activity.text);
      const request: string | undefined = (activity.text as string).toLowerCase().replace(/\.$/u, '');
      if (request === 'transfer') {
        return this.sendActivity([{
          type: BotActivityType.event,
          name: BotActivityEventName.transfer,
          activityParams: {
            handoverReason: 'My handover reason',
            transferTarget: '123456789',
            transferReferredByURL: 'sip:456@ac.com',
            transferSipHeaders: [{
              name: 'UUID',
              value: '123456789'
            },
            {
              name: 'Second-Header',
              value: 'Second-Header-Value'
            }]
          }
        }]);
      }
      return this.sendMessage(activity.text);
    }
    return Promise.resolve();
  }
  send(type: string, message?: any) {
    console.info(`sending ${type}: ${JSON.stringify(message)?.slice(0, 150)}`);
    if (this.ended)
      return Promise.reject(new Error('Connection closed'));
    if (this.webSocket!.readyState !== WebSocket.OPEN)
      return Promise.resolve();
    return new Promise<void>((resolve, reject) => this.webSocket!.send(JSON.stringify({
      type,
      ...message
    }), {}, (err) => {
      if (err)
        reject(err);
      else
        resolve();
    }));
  }
  private async sendAudioStreamInChunks(audioMessage: Buffer, recognitionString: string, mediaFormat?: string) {
    await this.sendRecognition(recognitionString, 0.8);
    const currentId = `test-${this.recordingSeq++}`;
    await this.send(BotToVaicMessageName.playStreamStart, { mediaFormat: mediaFormat || this.mediaFormat, streamId: currentId });
    const audioStream = Readable.from(audioMessage);
    audioStream.on('data', (chunk) => {
      if (this.ended) {
        audioStream.removeAllListeners('data');
        audioStream.destroy();
        return;
      }
      this.send(BotToVaicMessageName.playStreamChunk, {
        audioChunk: chunk.toString('base64'),
        streamId: currentId
      }).catch((error) => {
        console.error('Error sending audio chunk:', error);
        audioStream.removeAllListeners('data');
        audioStream.resume();
      });
    });
    audioStream.on('end', () => {
      this.send(BotToVaicMessageName.playStreamStop, { streamId: currentId }).catch((error) => {
        console.error('Error sending audio stream stop:', error);
      });
    });
    audioStream.on('error', (error) => {
      console.error('Error sending audio stream:', error);
      audioStream.removeAllListeners('data');
      this.end();
    });
  }
  async finalizeEcho() {
    delete this.incomingAudioBuffer;
    this.incomingAudioBuffer = undefined;
  }
  sendHypothesis(text: string) {
    return this.send(BotToVaicMessageName.userStreamSpeechHypothesis, {
      alternatives: [{
        text: text.toLowerCase()
      }]
    });
  }

  sendRecognition(text: string, confidence: number) {
    return this.send(BotToVaicMessageName.userStreamSpeechRecognition, {
      alternatives: [{
        text: text.toLowerCase(),
        confidence
      }]
    });
  }
  async sendMessage(text: string, params?: Record<string, unknown>, audioMessage?: Buffer) {
    let mediaFormat = this.mediaFormat;
    if (!this.directTTS) {
      return this.sendActivity({
        type: BotActivityType.message,
        text,
        activityParams: params
      });
    }
    if (!audioMessage) {
      // eslint-disable-next-line no-param-reassign
      audioMessage = Buffer.from(await fsp.readFile(path.resolve(import.meta.dirname, 'static/ac-voice-silence.pcm')));
      mediaFormat = welcomeMessageMediaFormat;
    }
    return this.sendActivity({
      type: BotActivityType.event,
      name: BotActivityEventName.playUrl,
      activityParams: {
        playUrlAltText: `${this.caller}: ${text}`,
        playUrlUrl: `data:application/octet-stream;base64,${audioMessage.toString('base64')}`,
        playUrlMediaFormat: mediaFormat,
        ...params
      }
    });
  }
  sendActivity(activity: BotActivity | BotActivity[]) {
    const activities: Activities = {
      activities: Array.isArray(activity) ? activity : [activity]
    };
    return this.send('activities', activities);
  }
  getBps() {
    const conversion = {
      'lpcm16': 32000,
      'lpcm16_8': 16000,
      'lpcm16_24': 48000,
      'mulaw': 8000,
      'alaw': 8000
    };
    const [_format, encoding] = this.mediaFormat.split('/') as [string, keyof typeof conversion];
    if (encoding in conversion) {
      return conversion[encoding];
    }
    return 32000;
  }

}


function initVoiceBot(server: http.Server) {
  const webSockServer = new WebSocketServer({
    perMessageDeflate: false,
    server,
    verifyClient: verifyClientFunc
  });
  webSockServer.on('connection', (webs: WebSocket, request: http.IncomingMessage) => {
    const token = extractToken(request.headers.authorization);
    if (token !== accessToken) {
      console.error('Invalid token');
      webs.close(401, 'Invalid token');
      return;
    }
    const searchParams = new URLSearchParams(request.url?.split('?')[1]);
    const echoTime = Number(searchParams.get('echoTime')) || 5000;
    new VoiceBotSession(webs, { echoTime, token });
  });
}
function extractToken(authHeader: string | undefined): string {
  if (!authHeader)
    return '';
  const [scheme, token] = authHeader.split(' ');
  if (scheme.toLowerCase() !== 'bearer')
    return '';

  return token || '';
}

const voiceBotWsServer = http.createServer();

voiceBotWsServer.keepAliveTimeout = 30000;
initVoiceBot(voiceBotWsServer);
voiceBotWsServer.listen(
  voiceBotWs, listenHost,
  () => console.info(`AC-Voice-Bot Server (Plain) listening on ${voiceBotWs}.`)
);
