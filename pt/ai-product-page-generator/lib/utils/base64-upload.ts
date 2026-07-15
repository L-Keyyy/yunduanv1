export interface Base64UploadPayload {
  fileName: string;
  mimeType: string;
  base64Data: string;
}

export function stripDataUrlPrefix(value: string) {
  const commaIndex = value.indexOf(",");
  const header = commaIndex >= 0 ? value.slice(0, commaIndex) : "";
  return header.startsWith("data:") && header.endsWith(";base64")
    ? value.slice(commaIndex + 1)
    : value;
}

export async function fileToBase64Payload(file: File): Promise<Base64UploadPayload> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file."));
    reader.readAsDataURL(file);
  });

  return {
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    base64Data: stripDataUrlPrefix(dataUrl),
  };
}
