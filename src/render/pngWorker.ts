// Encodes paint textures to PNG off the main thread (so lifting the finger never stutters).
import { encodePng } from '../core/io/png';

self.onmessage = (e: MessageEvent<{ id: number; rgba: Uint8Array; width: number; height: number }>) => {
  const { id, rgba, width, height } = e.data;
  const png = encodePng(rgba, width, height);
  (self as unknown as Worker).postMessage({ id, png }, [png.buffer]);
};
