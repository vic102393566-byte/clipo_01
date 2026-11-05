/** Envia um arquivo inteiro para uma URL assinada do S3 (PUT), avisando o andamento de 0 a 1. */
export function putFile(url: string, file: File, contentType: string, onProgress?: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Falha no envio (${xhr.status}).`)));
    xhr.onerror = () => reject(new Error("A conexão caiu durante o envio."));
    xhr.send(file);
  });
}

/** Tipo do arquivo que o navegador às vezes não informa (ex.: .mov e .cube). */
export function contentTypeOf(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  const known: Record<string, string> = {
    mov: "video/quicktime",
    mp4: "video/mp4",
    webm: "video/webm",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
    flac: "audio/flac",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    json: "application/json",
    cube: "text/plain",
  };
  return known[ext ?? ""] ?? "application/octet-stream";
}
