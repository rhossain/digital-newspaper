/**
 * Resizes an image File to the given target width (maintaining aspect ratio)
 * using the Canvas API, then returns a new File at the specified quality and
 * output MIME type.
 *
 * If the image's natural width is already ≤ targetWidth the original file is
 * returned unchanged (no upscaling, no re-encoding).  The caller is responsible
 * for any format conversion needed in that case.
 *
 * @param file        Source image File (any browser-supported format).
 * @param targetWidth Maximum output width in pixels.
 * @param quality     Encoding quality, 0–1. Defaults to 0.92.
 * @param outputMime  Output MIME type. Defaults to 'image/webp'.
 *                    Pass 'image/jpeg' to retain legacy JPEG behaviour.
 */
export function resizeImageToWidth(
  file: File,
  targetWidth: number,
  quality = 0.92,
  outputMime: 'image/webp' | 'image/jpeg' = 'image/webp'
): Promise<File> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);

      // No upscaling — return original when already within target size.
      // The caller handles format conversion separately if required.
      if (img.naturalWidth <= targetWidth) {
        resolve(file);
        return;
      }

      const scale = targetWidth / img.naturalWidth;
      const targetHeight = Math.round(img.naturalHeight * scale);

      const canvas = document.createElement('canvas');
      canvas.width = targetWidth;
      canvas.height = targetHeight;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to get 2D canvas context'));
        return;
      }

      ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

      const ext = outputMime === 'image/webp' ? 'webp' : 'jpg';
      const baseName = file.name.replace(/\.[^.]+$/, '');

      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('Canvas toBlob returned null'));
            return;
          }
          resolve(new File([blob], `${baseName}.${ext}`, { type: outputMime }));
        },
        outputMime,
        quality
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Failed to load image for resizing'));
    };

    img.src = objectUrl;
  });
}
