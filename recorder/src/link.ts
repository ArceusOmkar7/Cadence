// Connection to the local relay (server/relay.mjs): glove control + record packets + HTTP proxy to the glove.

export interface RelayStatus {
  t: 'relay';
  glove: 'idle' | 'connecting' | 'open' | 'closed';
  host: string;
  udpPort: number;
  streaming: boolean;
  datagrams: number;
}
/** Text frames forwarded from the glove: pose (t 'p'), status (t 's'), record replies (t 'rec'). */
export type GloveText = { t: string; [k: string]: unknown };

export class GloveLink {
  onPacket: (buf: ArrayBuffer, rxMs: number) => void = () => {};
  onText: (m: GloveText) => void = () => {};
  onRelay: (s: RelayStatus | null) => void = () => {};
  relay: RelayStatus | null = null;
  private ws: WebSocket | null = null;
  private wantHost = '';

  constructor(private readonly base = location.host) {
    this.open();
  }

  private open(): void {
    const ws = new WebSocket(`ws://${this.base}/relay`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => { if (this.wantHost) this.send({ cmd: 'connect', host: this.wantHost }); };
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) { this.onPacket(e.data, Date.now()); return; }
      let m: GloveText; try { m = JSON.parse(e.data as string); } catch { return; }
      if (m.t === 'relay') { this.relay = m as unknown as RelayStatus; this.onRelay(this.relay); } else this.onText(m);
    };
    ws.onclose = () => { this.relay = null; this.onRelay(null); setTimeout(() => this.open(), 1000); };
  }

  private send(o: object): void { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o)); }
  connect(host: string): void { this.wantHost = host; this.send({ cmd: 'connect', host }); }
  startStream(): void { this.send({ cmd: 'start' }); }
  stopStream(): void { this.send({ cmd: 'stop' }); }
  get ready(): boolean { return this.relay?.glove === 'open'; }

  /** Glove HTTP API through the relay's whitelist, e.g. http('/api/calibration'). */
  async http(path: string, method: 'GET' | 'POST' = 'GET'): Promise<{ ok: boolean; status: number; body: any }> {
    try {
      const r = await fetch('/glove' + path, { method });
      const text = await r.text();
      let body: any = text; try { body = JSON.parse(text); } catch { /* plain text reply */ }
      return { ok: r.ok, status: r.status, body };
    } catch (e) {
      return { ok: false, status: 0, body: String(e) };
    }
  }
}
