export const EXTENSION_AI_FOLLOW_FINAL_IMAGE_LIMIT = 30;
export const EXTENSION_AI_FOLLOW_GENERATED_IMAGE_COUNT = 4;
export const EXTENSION_AI_FOLLOW_SOURCE_IMAGE_LIMIT =
  EXTENSION_AI_FOLLOW_FINAL_IMAGE_LIMIT -
  EXTENSION_AI_FOLLOW_GENERATED_IMAGE_COUNT +
  1;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedImageUrl(value: unknown) {
  const raw = text(value);
  if (!raw) return "";
  const normalized = raw.startsWith("//") ? `https:${raw}` : raw;
  return /^(?:https?:\/\/|data:image\/)/i.test(normalized) ? normalized : "";
}

function appendImageCandidates(value: unknown, output: string[]) {
  const direct = normalizedImageUrl(value);
  if (direct) {
    output.push(direct);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => appendImageCandidates(entry, output));
    return;
  }
  const record = asRecord(value);
  if (!Object.keys(record).length) return;
  for (const key of ["src", "url", "imageUrl", "coverImage", "original"]) {
    const candidate = normalizedImageUrl(record[key]);
    if (candidate) {
      output.push(candidate);
      return;
    }
  }
}

export function extensionAiFollowSourceImages(
  scrapedJson: Record<string, unknown>,
) {
  const gallery = asRecord(scrapedJson.gallery);
  const description = asRecord(scrapedJson.description);
  const candidates: string[] = [];

  // Keep the Ozon gallery order authoritative: cover first, then every
  // original auxiliary image. Description images are appended only after the
  // gallery so they never displace a product photo from the first positions.
  appendImageCandidates(
    scrapedJson.imageUrl ?? scrapedJson.mainImage ?? gallery.coverImage,
    candidates,
  );
  appendImageCandidates(gallery.coverImage, candidates);
  appendImageCandidates(gallery.images, candidates);
  appendImageCandidates(scrapedJson.images, candidates);
  appendImageCandidates(scrapedJson.imageUrls, candidates);
  appendImageCandidates(description.images, candidates);
  appendImageCandidates(description.imageUrls, candidates);

  return [...new Set(candidates)].slice(
    0,
    EXTENSION_AI_FOLLOW_SOURCE_IMAGE_LIMIT,
  );
}

export function mergeGeneratedWithOriginalAuxiliary<T>(
  generatedImages: T[],
  originalImages: T[],
  limit = EXTENSION_AI_FOLLOW_FINAL_IMAGE_LIMIT,
) {
  return [...generatedImages, ...originalImages.slice(1)].slice(0, limit);
}
