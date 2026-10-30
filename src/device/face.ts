// On-device face guide and liveness prompt (PRD FM-03, FM-04) using MediaPipe Face Landmarker.
// Runs in the browser now; the same logic moves to ML Kit / Vision in the native build.
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

let landmarker: Promise<FaceLandmarker> | null = null;

export function loadFaceModel(): Promise<FaceLandmarker> {
  if (!landmarker) {
    landmarker = (async () => {
      const files = await FilesetResolver.forVisionTasks(WASM);
      return FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO', numFaces: 2, outputFaceBlendshapes: true
      });
    })();
    landmarker.catch(() => { landmarker = null; });
  }
  return landmarker;
}

export interface FaceFrame {
  faces: number;
  centred: boolean;     // one face, centred, big enough
  blink: number;        // 0..1, both eyes
  yaw: number;          // nose offset from face centre, -0.5..0.5 (sign depends on camera)
}

export function readFrame(lm: FaceLandmarker, video: HTMLVideoElement): FaceFrame {
  const r = lm.detectForVideo(video, performance.now());
  const faces = r.faceLandmarks.length;
  if (faces !== 1) return { faces, centred: false, blink: 0, yaw: 0 };
  const pts = r.faceLandmarks[0];
  let minX = 1, maxX = 0, minY = 1, maxY = 0;
  for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const w = maxX - minX, cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const centred = w > 0.28 && cx > 0.3 && cx < 0.7 && cy > 0.25 && cy < 0.65;
  const cats = r.faceBlendshapes[0]?.categories ?? [];
  const score = (n: string) => cats.find((c) => c.categoryName === n)?.score ?? 0;
  const blink = Math.min(score('eyeBlinkLeft'), score('eyeBlinkRight'));
  const yaw = (pts[1].x - cx) / w; // landmark 1 = nose tip
  return { faces, centred, blink, yaw };
}

export type Challenge = 'blink' | 'turn';
export const pickChallenge = (): Challenge => (Math.random() < 0.5 ? 'blink' : 'turn');

/** Tracks one challenge across frames: blink = eyes closed then open; turn = head turns then returns. */
export class ChallengeTracker {
  private stage = 0;
  constructor(public readonly challenge: Challenge) {}
  feed(f: FaceFrame): boolean {
    if (f.faces !== 1) return false;
    if (this.challenge === 'blink') {
      if (this.stage === 0 && f.blink < 0.2) this.stage = 1;          // eyes open first
      else if (this.stage === 1 && f.blink > 0.55) this.stage = 2;    // closed
      else if (this.stage === 2 && f.blink < 0.25) return true;       // open again
    } else {
      if (this.stage === 0 && Math.abs(f.yaw) < 0.06) this.stage = 1; // facing camera
      else if (this.stage === 1 && Math.abs(f.yaw) > 0.14) this.stage = 2; // turned
      else if (this.stage === 2 && Math.abs(f.yaw) < 0.07) return true;    // back
    }
    return false;
  }
}
