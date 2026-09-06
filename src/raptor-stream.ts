import WebSocket from 'ws';
import { CONFIG } from './config.js';
import { log } from './logger.js';
import { acceptRaptorStreamQuote, raptorStats } from './raptor.js';
import type { Quote } from './aggregators/types.js';

export interface RaptorStreamSubscription {
  inputMint: string;
  outputMint: string;
  amountAtomic: string;
  slippageBps: number;
}

export interface MarketQuoteEvent {
  source: 'raptor_stream';
  quote: Quote;
  receivedAt: number;
}

interface StreamMessage {
  type?: string;
  id?: string;
  data?: unknown;
  message?: string;
}

/**
 * Quote-only Raptor WebSocket client. It connects only to `/stream` and never
 * `/stream/swap`, because the latter includes transaction-building data.
 */
export class RaptorQuoteStream {
  private socket: WebSocket | null = null;
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    private readonly subscriptions: RaptorStreamSubscription[],
    private readonly onQuote: (event: MarketQuoteEvent) => void,
  ) {}

  start(): void {
    if (this.stopped || this.socket) return;
    const streamUrl = new URL(CONFIG.raptorBaseUrl);
    streamUrl.protocol = streamUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    streamUrl.pathname = streamUrl.pathname.replace(/\/$/, '') + '/stream';
    this.socket = new WebSocket(streamUrl.toString());

    this.socket.on('open', () => {
      this.reconnectAttempt = 0;
      log.info('[Raptor stream] quote-only connection established', {
        subscriptions: this.subscriptions.length,
      });
      for (const subscription of this.subscriptions) {
        this.socket?.send(JSON.stringify({
          type: 'subscribe',
          inputMint: subscription.inputMint,
          outputMint: subscription.outputMint,
          amount: subscription.amountAtomic,
          slippageBps: String(subscription.slippageBps),
          maxHops: CONFIG.raptorMaxHops,
        }));
      }
      this.heartbeat = setInterval(() => {
        if (this.socket?.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ type: 'ping' }));
        }
      }, 20_000);
      this.heartbeat.unref();
    });

    this.socket.on('message', (buffer) => {
      try {
        const message = JSON.parse(buffer.toString()) as StreamMessage;
        if (message.type !== 'quote' || !message.data) return;
        const receivedAt = Date.now();
        const quote = acceptRaptorStreamQuote(message.data, receivedAt);
        this.onQuote({ source: 'raptor_stream', quote, receivedAt });
      } catch (error) {
        log.warn('[Raptor stream] invalid quote update ignored', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    });

    this.socket.on('error', (error) => {
      log.warn('[Raptor stream] connection error; HTTP scanning remains active', {
        reason: error.message,
      });
    });
    this.socket.on('close', () => {
      this.socket = null;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      this.scheduleReconnect();
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close();
    this.socket = null;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delayMs = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt)
      + Math.floor(Math.random() * 250);
    this.reconnectAttempt++;
    raptorStats.streamReconnects++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, delayMs);
    this.reconnectTimer.unref();
  }
}
