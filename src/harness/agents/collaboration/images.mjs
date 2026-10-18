import { readFile } from 'node:fs/promises';
import { MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_BYTES, detectImageMime } from '../../intools/shared/image-info.mjs';

const failure = (code, message) => Object.assign(new Error(message), { code });

function imageLabel(image, index) {
  const name = typeof image?.name === 'string' && image.name.trim() ? image.name.trim() : `图片 ${index + 1}`;
  return name.slice(0, 120);
}

/**
 * Turn host-owned image descriptors into Pi image parts.
 *
 * `strict` is for the current prompt: an unsupported model, oversized image or
 * unreadable file rejects before a model call. Historical messages use the
 * non-strict path so switching a conversation to a text-only model still
 * replays its text; the image is replaced by a visible placeholder instead of
 * silently disappearing.
 */
export async function loadImageParts(images, { model, signal, strict = true, read = readFile } = {}) {
  if (!Array.isArray(images) || !images.length) return [];
  const supported = Array.isArray(model?.input) && model.input.includes('image');
  if (!supported) {
    if (strict) throw failure('MODEL_IMAGE_UNSUPPORTED', '当前模型不支持图片输入，请切换支持视觉的模型后再附加图片。');
    return images.map((image, index) => ({ type: 'text', text: `[图片未发送：${imageLabel(image, index)}，当前模型不支持图片输入。]` }));
  }
  if (images.length > MAX_IMAGES_PER_MESSAGE) {
    if (strict) throw failure('TOO_MANY_IMAGES', `一条消息最多附加 ${MAX_IMAGES_PER_MESSAGE} 张图片。`);
    images = images.slice(0, MAX_IMAGES_PER_MESSAGE);
  }
  const parts = [];
  for (const [index, image] of images.entries()) {
    signal?.throwIfAborted();
    try {
      if (!image || typeof image.path !== 'string' || !image.path || image.path.includes('\0')) throw new Error('图片路径无效。');
      const buffer = await read(image.path);
      signal?.throwIfAborted();
      if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`图片不能超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MiB。`);
      const mimeType = detectImageMime(buffer);
      if (!mimeType) throw new Error('仅支持 PNG、JPEG、WebP 或 GIF 图片。');
      parts.push({ type: 'image', data: buffer.toString('base64'), mimeType });
    } catch (error) {
      if (strict) throw failure('IMAGE_READ_FAILED', `无法读取图片「${imageLabel(image, index)}」：${error?.message ?? error}`);
      parts.push({ type: 'text', text: `[图片未发送：${imageLabel(image, index)}，${error?.message ?? '读取失败'}。]` });
    }
  }
  return parts;
}
