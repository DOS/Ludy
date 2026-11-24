// SPDX-License-Identifier: AGPL-3.0-only
// AudioWorkletProcessor feeding 48 kHz interleaved Int16 WASAPI process-loopback PCM frames into WebAudio AudioContext.
// Wrapped in a registration function so importing PCM_WORKLET_NAME in Node/Electron main or tests never touches AudioWorkletProcessor.

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, processorCtor: new () => AudioWorkletProcessor): void;

export const PCM_WORKLET_NAME = 'pcm-loopback-processor';

export function registerPcmWorklet(): void {
  class PcmLoopbackProcessor extends AudioWorkletProcessor {
    private readonly queue: Float32Array[] = [];
    private offset = 0;

    constructor() {
      super();
      this.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        const view = new Int16Array(event.data);
        const floats = new Float32Array(view.length);
        for (let i = 0; i < view.length; i++) {
          floats[i] = (view[i] ?? 0) / 32768;
        }
        // Bound queued PCM buffer (~2 seconds) so stalled backpressure never leaks memory.
        if (this.queue.length > 100) {
          this.queue.shift();
          this.offset = 0;
        }
        this.queue.push(floats);
      };
    }

    process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
      const output = outputs[0];
      if (!output) return true;
      const left = output[0];
      const right = output[1];
      if (!left) return true;
      const frames = left.length;
      for (let i = 0; i < frames; i++) {
        let l = 0;
        let r = 0;
        while (this.queue.length > 0) {
          const head = this.queue[0]!;
          if (this.offset + 1 < head.length) {
            l = head[this.offset] ?? 0;
            r = head[this.offset + 1] ?? l;
            this.offset += 2;
            break;
          }
          this.queue.shift();
          this.offset = 0;
        }
        left[i] = l;
        if (right) right[i] = r;
      }
      return true;
    }
  }

  registerProcessor(PCM_WORKLET_NAME, PcmLoopbackProcessor);
}

if (typeof registerProcessor === 'function') {
  registerPcmWorklet();
}
