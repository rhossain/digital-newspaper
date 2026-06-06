/**
 * Resizes an image File to the given target width (maintaining aspect ratio)
 * using the Canvas API, then returns a new JPEG File at the specified quality.
 *
 * If the image's natural width is already ≤ targetWidth the original file is
 * returned unchanged (no upscaling, no re-encoding).
 *
 * @param file        Source image File (any browser-supported format).
 * @param targetWidth Maximum output width in pixels.
 * @param quality     JPEG quality, 0–1. Defaults to 0.92.
 */
export function resizeImageToWidth(
  file: File,
  targetWidth: number,
  quality = 0.92
): Promise<File> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);

      // No upscaling — return original when already within target size.
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

      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error('Canvas toBlob returned null'));
            return;
          }
          // Strip the original extension and always name the output .jpg
          const baseName = file.name.replace(/\.[^.]+$/, '');
          resolve(new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' }));
        },
        'image/jpeg',
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
