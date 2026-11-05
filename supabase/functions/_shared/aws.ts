// Minimal AWS for edge functions: S3 (save, view link, delete) and Rekognition CompareFaces, signed with aws4fetch.
// The full AWS SDK ran out of compute in Supabase edge workers (WORKER_RESOURCE_LIMIT, 5 Nov); this does the same calls
// with a few KB of code. Keys come from function secrets only and never leave the server.
import { AwsClient } from 'npm:aws4fetch@1.0.20';

export interface AwsCfg { accessKeyId: string; secretAccessKey: string; region: string; bucket: string }

export function makeAws(c: AwsCfg) {
  const s3c = new AwsClient({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region: c.region, service: 's3' });
  const rekc = new AwsClient({ accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, region: c.region, service: 'rekognition' });
  const url = (key: string) => `https://${c.bucket}.s3.${c.region}.amazonaws.com/${key.split('/').map(encodeURIComponent).join('/')}`;
  const fail = async (r: Response, what: string) => { const t = await r.text().catch(() => ''); const code = t.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? `HTTP ${r.status}`; throw Object.assign(new Error(`${what}: ${code}`), { name: code }); };
  return {
    async put(key: string, body: Uint8Array | string, contentType: string) {
      const r = await s3c.fetch(url(key), { method: 'PUT', body, headers: { 'Content-Type': contentType } });
      if (!r.ok) await fail(r, 'put');
    },
    async del(key: string) {
      const r = await s3c.fetch(url(key), { method: 'DELETE' });
      if (!r.ok && r.status !== 404) await fail(r, 'delete');
    },
    /** delete many, 10 at a time; returns how many went */
    async delMany(keys: string[]) {
      let n = 0;
      for (let i = 0; i < keys.length; i += 10) {
        const rs = await Promise.allSettled(keys.slice(i, i + 10).map((k) => this.del(k)));
        n += rs.filter((x) => x.status === 'fulfilled').length;
      }
      return n;
    },
    /** short-lived private link (GET to view, PUT for the phone's direct upload) */
    async presign(key: string, method: 'GET' | 'PUT', seconds: number) {
      const u = new URL(url(key)); u.searchParams.set('X-Amz-Expires', String(seconds));
      const signed = await s3c.sign(new Request(u.toString(), { method }), { aws: { signQuery: true } });
      return signed.url;
    },
    /** face similarity 0–100 of the best match, comparing two photos already in the bucket */
    async compareFaces(sourceKey: string, targetKey: string): Promise<number> {
      const r = await rekc.fetch(`https://rekognition.${c.region}.amazonaws.com/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-amz-json-1.1', 'X-Amz-Target': 'RekognitionService.CompareFaces' },
        body: JSON.stringify({ SourceImage: { S3Object: { Bucket: c.bucket, Name: sourceKey } }, TargetImage: { S3Object: { Bucket: c.bucket, Name: targetKey } }, SimilarityThreshold: 0 })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(`compare: ${j.__type ?? r.status}`), { name: String(j.__type ?? r.status) });
      return Math.max(0, ...((j.FaceMatches ?? []) as { Similarity?: number }[]).map((m) => m.Similarity ?? 0));
    }
  };
}
