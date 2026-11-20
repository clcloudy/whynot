import {
  initializeImageMagick, MagickFormat, MagickImage, MagickReadSettings, ResourceLimits,
} from '@imagemagick/magick-wasm';

const MAX_SIDE = 4096;
const formats = {
  'image/png': MagickFormat.Png,
  'image/jpeg': MagickFormat.Jpeg,
  'image/webp': MagickFormat.WebP,
};
export function createImageValidator(loadWasm) {
  let ready;
  async function initializeDecoder() {
    await initializeImageMagick(await loadWasm());
    ResourceLimits.width = BigInt(MAX_SIDE);
    ResourceLimits.height = BigInt(MAX_SIDE);
    ResourceLimits.listLength = 2n;
    ResourceLimits.memory = 128n * 1024n * 1024n;
    ResourceLimits.maxMemoryRequest = ResourceLimits.memory;
    ResourceLimits.maxProfileSize = 8n * 1024n * 1024n;
    ResourceLimits.disk = 0n;
  }

  return async function validateImage(bytes, mime) {
    await (ready ??= initializeDecoder().catch(error => {
      ready = undefined;
      throw error;
    }));
    const image = MagickImage.create();
    try {
      let warning = false;
      image.onWarning = () => { warning = true; };
      image.read(bytes, new MagickReadSettings({ format: formats[mime] }));
      return !warning && image.width > 0 && image.height > 0
        && image.width <= MAX_SIDE && image.height <= MAX_SIDE;
    } catch {
      return false;
    } finally {
      image.dispose();
    }
  };
}
