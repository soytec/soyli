import { sha256 } from '../../protocol/src';

/** An explicit reuse decision applies only to the reviewed build and clip bytes. */
export async function videoMatchesBuild(
  video: { artifactHash: string; reviewedFor?: { artifactHash: string; videoHash: string } },
  artifactHash: string,
  bytes?: Uint8Array,
) {
  return (
    video.artifactHash === artifactHash ||
    (!!bytes &&
      video.reviewedFor?.artifactHash === artifactHash &&
      video.reviewedFor.videoHash === (await sha256(bytes)))
  );
}
