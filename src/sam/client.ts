// The app's way to SAM answers already paid for: GET /api/cache/<sha256>/<file>
// on the proxy. A clip can be known by two hashes, the converted clip's and
// the phone file it came from, so each is tried. Live SAM runs (upload once,
// reuse the file id) come through the same proxy once Qai says go.
export async function cachedAnswer(hashes: readonly string[], file: string): Promise<unknown | null> {
  for (const sha of hashes) {
    try {
      const response = await fetch(`/api/cache/${sha}/${file}`);
      if (response.ok) return (await response.json()) as unknown;
    } catch {
      // offline or no proxy: try the next hash, then give up
    }
  }
  return null;
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
