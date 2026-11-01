import { test, expect } from 'bun:test';
import { videoMatchesBuild } from './media-review';
import { sha256 } from '../../protocol/src';
import { projectSchema } from './config';

test('media reuse approval is tied to both the exact updated build and unchanged clip', async () => {
  const clip = new TextEncoder().encode('existing clip');
  const oldHash = 'a'.repeat(64),
    newHash = 'b'.repeat(64);
  const video = {
    file: 'clip.webm',
    artifactHash: oldHash,
    reviewedFor: { artifactHash: newHash, videoHash: await sha256(clip) },
  };
  expect(await videoMatchesBuild(video, newHash, clip)).toBe(true);
  expect(await videoMatchesBuild(video, oldHash, clip)).toBe(true);
  expect(await videoMatchesBuild(video, 'c'.repeat(64), clip)).toBe(false);
  expect(await videoMatchesBuild(video, newHash, new TextEncoder().encode('changed clip'))).toBe(
    false,
  );
  expect(await videoMatchesBuild(video, newHash)).toBe(false);
  expect(await videoMatchesBuild({ artifactHash: oldHash }, newHash, clip)).toBe(false);
  expect(projectSchema.shape.preview.unwrap().parse({ video }).video).toEqual(video);
});
